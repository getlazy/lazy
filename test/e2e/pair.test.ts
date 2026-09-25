import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, dirname, resolve } from 'path';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, readTaskJson, readTaskStatus, readTurns, setTaskMetadata, setTaskStatus, storageDirFor, taskFilePath, worktreePathFor, writeTaskJson } from '../helpers/storage';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { SANDBOX_DIR } from '../../src/utils/sandbox';

/** The lock path lazy actually uses — see getPairingLockPath in src/utils/pairing-lock.ts. */
function pairingLockPath(root: string, shortId: string): string {
  return join(worktreePathFor(root, shortId), '.lazy-task-sandbox', 'pairing-lock');
}

/**
 * Helper: place a pairing lock on a task's worktree that appears alive.
 *
 * The lock MUST land in `.lazy-task-sandbox/`, not `.lazy/`: that directory is
 * excluded from every dirty-worktree check (`git status --porcelain --
 * ':!.lazy-task-sandbox'`), so a lock does not make the worktree dirty. Writing
 * it to `.lazy/` instead both hid the lock from `checkPairingLock` and tripped
 * accept/reject's dirty gate before their pairing gate could fire.
 */
function placePairingLock(root: string, shortId: string): void {
  const lockPath = pairingLockPath(root, shortId);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, // Test runner PID — alive while subprocess runs
    started_at: new Date().toISOString(),
    user: 'test',
  }, null, 2));
}

interface ManualSessionOptions {
  /**
   * Check `lazy/<shortId>` out in the MAIN repo and leave the worktree on a
   * detached HEAD instead of on the branch.
   *
   * Only branch-detection tests need this. Git refuses to check out a branch
   * that is already checked out in a worktree ("fatal: 'lazy/x' is already
   * checked out at ..."), so with the default (attached) layout a
   * `ctx.git('checkout', branch)` silently fails and the main repo stays on
   * `main` — which is why those tests were exercising branchless pairing while
   * claiming to exercise branch detection.
   */
  checkoutBranchInMainRepo?: boolean;
}

/**
 * Helper: create a session.json manually for a task (no Docker needed).
 * Also creates the worktree directory and git branch.
 */
function createSessionManually(ctx: TestContext, shortId: string, options: ManualSessionOptions = {}): void {
  const fullTaskId = findFullTaskId(ctx.root, shortId);

  const branchName = `lazy/${shortId}`;
  const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();

  // Create the git worktree and branch
  const worktreePath = worktreePathFor(ctx.root, shortId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (options.checkoutBranchInMainRepo) {
    ctx.git('worktree', 'add', '--detach', worktreePath, 'HEAD');
    const checkout = ctx.git('checkout', '-b', branchName);
    if (checkout.exitCode !== 0) {
      throw new Error(`failed to check out ${branchName} in the main repo: ${checkout.stderr}`);
    }
  } else {
    ctx.git('worktree', 'add', worktreePath, '-b', branchName);
  }

  // Write session.json
  const session = {
    id: randomUUID(),
    task_id: fullTaskId,
    agent_id: 'claude-code',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    git_branch: branchName,
    git_start_sha: startSha,
    agent_session_id: null,
    last_interaction_at: Date.now(),
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    container_agent_id: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
  };
  writeFileSync(taskFilePath(ctx.root, shortId, 'session.json'), JSON.stringify(session, null, 2));
}

describe('lazy pair', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (pair-in-container): branchless pairing is HOST execution — there
  // is no task, no worktree and therefore no container. Host execution is never
  // implicit, so bare `lazy pair` on a non-task branch refuses and names the
  // opt-in rather than quietly launching an agent on the human's machine.
  test('refuses branchless pairing without --host', async () => {
    const result = await ctx.lazy(['pair']);
    expectFailure(result);
    expectError(result, 'no task container to pair in');
    expectError(result, 'lazy pair --host');
    expectOutputExcludes(result, 'Launching Claude Code');
  });

  // INVARIANT: With --host on a non-task branch, pair launches branchless mode —
  // Claude Code in the current directory with conversation capture.
  test('launches branchless pairing on non-task branch with --host', async () => {
    // On main branch (default in test repos), `lazy pair --host` should attempt
    // to launch Claude Code without task context. It will fail because
    // the `claude` binary doesn't exist, but should NOT show usage.
    const result = await ctx.lazy(['pair', '--host']);
    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'Launching Claude Code');
    expectOutput(result, 'no task context');
  });

  // INVARIANT: When on a lazy/* branch with no argument, pair detects the task.
  test('detects task from lazy/* branch', async () => {
    const taskId = await createTask(ctx, 'Branch detection task', 'Some work');
    // Puts the main repo on lazy/<taskId> — the state branch detection reads.
    createSessionManually(ctx, taskId, { checkoutBranchInMainRepo: true });
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Running `lazy pair` without arguments should detect the task from the
    // branch. With a credential present (the default fake key, so the daemon
    // gate passes), pair resolves the task and proceeds to the launch step,
    // printing the resume message — proving it detected the task from the
    // lazy/* branch. (It ultimately fails later because the `claude` binary
    // isn't installed in the test env.)
    const result = await ctx.lazy(['pair']);

    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'No existing claude-code session to resume');
  });

  test('--unlock fails without task on non-task branch', async () => {
    const result = await ctx.lazy(['pair', '--unlock']);
    expectFailure(result);
    expectError(result, '--unlock requires a task argument');
  });

  // SECURITY INVARIANT (fix-cursor-security-musts → pair-in-container): Cursor
  // pairing was refused because a HOST session could only see container-written
  // chat if lazy copied it onto the host. Pairing now runs inside the task's
  // container, over that same sandbox home, so the refusal is lifted — and the
  // session must be reported as running in the CONTAINER, never on the host.
  test('pairs on a Cursor task, in the container', async () => {
    const taskId = await createTask(ctx, 'Cursor task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const task = readTaskJson(ctx.root, taskId);
    task.agent_id = 'cursor';
    writeTaskJson(ctx.root, taskId, task);

    const result = await ctx.lazy(['pair', taskId]);

    expectOutputExcludes(result, 'does not support pairing');
    expectOutput(result, 'No existing cursor session to resume');
    expectOutput(result, 'container');
    // Never on the host — that is the whole point of lifting the refusal.
    expectOutputExcludes(result, '⚠ --host');
  });

  // INVARIANT (pair-in-container): --host launches CLAUDE CODE, always. The host
  // launcher builds its argv with interactiveClaudeArgs, which is hardcoded to
  // `claude` and takes no agent — so --host on a cursor task would print
  // "Agent: cursor" and then run a different agent entirely. Refuse instead:
  // launching the wrong agent against a task's work is precisely the silent
  // wrongness pairing must not have. Host pairing is claude-code-only.
  test('refuses --host on a non-claude-code task rather than launching Claude', async () => {
    const taskId = await createTask(ctx, 'Cursor task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const task = readTaskJson(ctx.root, taskId);
    task.agent_id = 'cursor';
    writeTaskJson(ctx.root, taskId, task);

    const result = await ctx.lazy(['pair', taskId, '--host']);

    expectFailure(result);
    expectError(result, 'Host pairing supports claude-code only');
    expectError(result, 'cursor');
    // It must not have started anything, nor claimed it was about to.
    expectOutputExcludes(result, 'Launching');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // Legacy tasks may still carry a stored host-process runner_type from before
  // the runner was removed — pairing must fail loud, not silently opt into host.
  test('refuses a task whose stored runner is the removed host-process runner', async () => {
    const taskId = await createTask(ctx, 'Legacy host runner task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const task = readTaskJson(ctx.root, taskId);
    task.runner_type = 'dangerously-host-process-without-any-isolation';
    writeTaskJson(ctx.root, taskId, task);

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'Host-process runner is no longer supported');
    expectError(result, '--runner docker');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  test('fails when task has no session', async () => {
    const taskId = await createTask(ctx, 'Not started task', 'Some work');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('fails when task is working', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'currently working');
  });

  test('--unlock removes pairing lock', async () => {
    const taskId = await createTask(ctx, 'Task with lock', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Place a pairing lock that appears alive
    placePairingLock(ctx.root, taskId);

    const lockPath = pairingLockPath(ctx.root, taskId);

    // Verify lock file exists
    expect(existsSync(lockPath)).toBe(true);

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'Pairing lock removed');

    // Lock file should be gone
    expect(existsSync(lockPath)).toBe(false);
  });

  test('--unlock reports when no lock exists', async () => {
    const taskId = await createTask(ctx, 'Task without lock', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'No pairing lock found');
  });

  test('--unlock restores pairing state to blocked', async () => {
    const taskId = await createTask(ctx, 'Task stuck in pairing', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'pairing');
    setTaskMetadata(ctx.root, taskId, 'pairing_pid', String(process.pid));
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'Pairing lock removed');
    expectOutput(result, 'status restored to blocked');

    // Verify task is now blocked
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
  });

  test('fails when another pairing session is active', async () => {
    const taskId = await createTask(ctx, 'Already paired task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Place a pairing lock that appears alive
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'already being paired on');
  });

  // INVARIANT: pair does NOT enforce auth itself — the daemon credential gate
  // is the single enforcement point. `lazy pair` auto-starts the daemon, which
  // refuses to start without a credential. So a missing credential surfaces as
  // the daemon's actionable error (clients pass through, they don't re-enforce).
  // This is the behavior that makes dropping the old client-side check safe.
  //
  // `LAZY_TEST: ''` is load-bearing: a daemonless suite runs the CLI with
  // LAZY_TEST=1, under which ensureDaemon() returns early and no daemon is ever
  // started — so the gate could never fire and the test would sail past into
  // the launch step. Clearing it restores the real auto-start path (same
  // technique as daemon.test.ts's credential-gate block). No daemon leaks: the
  // gate is exactly what stops it from coming up.
  test('missing credential surfaces the daemon gate error, not a client check', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId], {
      env: {
        LAZY_TEST: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    expectFailure(result);
    // The daemon gate fired — not the old client-side "No API token found".
    expectError(result, 'Daemon refuses to start');
    expectError(result, 'ANTHROPIC_API_KEY');
    expectOutputExcludes(result, 'No API token found');
  });

  // INVARIANT: the daemon gate is not bypassable by client flags. --no-summary
  // used to skip pair's local auth check; now there is no client check, and the
  // daemon still requires a credential regardless of the flag.
  test('--no-summary does not bypass the daemon credential gate', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--no-summary'], {
      env: {
        LAZY_TEST: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    expectFailure(result);
    expectError(result, 'Daemon refuses to start');
  });

  test('proceeds past the gate when a credential is available', async () => {
    const taskId = await createTask(ctx, 'Auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Credential present (default fake key) → daemon gate passes, pair resolves
    // the task and reaches the launch step. It fails later because the `claude`
    // binary doesn't exist, but it must NOT fail with the credential gate error.
    const result = await ctx.lazy(['pair', taskId]);

    expectOutputExcludes(result, 'Daemon refuses to start');
    expectOutput(result, 'No existing claude-code session to resume');
  });

  // INVARIANT (fix-pair-container-resume): container pairing seeds onboarding
  // state into the sandbox before docker exec, so Claude Code does not replay
  // the first-run wizard on every pair.
  test('container pairing seeds sandbox claude config before launch', async () => {
    const taskId = await createTask(ctx, 'Pair seed task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId]);
    expectOutputExcludes(result, 'Daemon refuses to start');

    const configPath = join(worktreePathFor(ctx.root, taskId), SANDBOX_DIR, '.claude.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.hasCompletedOnboarding).toBe(true);
  });

  // INVARIANT: when a session id exists and its JSONL is in the sandbox, pair
  // reaches launch with that id (printed in the session line).
  test('container pairing resumes when sandbox session jsonl exists', async () => {
    const taskId = await createTask(ctx, 'Resume pair task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const sessionId = 'pair-resume-session-1';
    const worktree = worktreePathFor(ctx.root, taskId);
    const projectDir = join(
      worktree,
      SANDBOX_DIR,
      '.claude',
      'projects',
      encodeProjectPath(worktree),
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"user","message":{"content":"hi"}}\n');

    const sessionPath = taskFilePath(ctx.root, taskId, 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.agent_session_id = sessionId;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    const result = await ctx.lazy(['pair', taskId]);
    expectOutputExcludes(result, 'No existing claude-code session to resume');
    expectOutput(result, sessionId.substring(0, 16));
  });

  // INVARIANT: --resume is only valid in branchless mode.
  // Task-based pairing resumes sessions automatically via agent_session_id.
  test('--resume works in branchless mode', async () => {
    // On main branch (no task context), `lazy pair --host --resume` should
    // attempt to launch Claude Code with the --resume flag. It will fail because
    // the `claude` binary doesn't exist, but should show branchless launch message.
    const result = await ctx.lazy(['pair', '--host', '--resume', 'abc123session']);
    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'Launching Claude Code');
    expectOutput(result, 'no task context');
  });

  test('--resume fails when task ID is explicitly provided', async () => {
    const taskId = await createTask(ctx, 'Explicit task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--resume', 'abc123session']);

    expectFailure(result);
    expectError(result, '--resume is only valid in branchless mode');
    expectError(result, 'Task-based pairing resumes sessions automatically');
  });

  test('--resume fails when on task branch (detected task)', async () => {
    const taskId = await createTask(ctx, 'Branch-detected task', 'Some work');
    // Puts the main repo on lazy/<taskId> — the state branch detection reads.
    createSessionManually(ctx, taskId, { checkoutBranchInMainRepo: true });
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Running `lazy pair --resume` should detect the task and reject the flag
    const result = await ctx.lazy(['pair', '--resume', 'abc123session']);

    expectFailure(result);
    expectError(result, '--resume is only valid in branchless mode');
    expectError(result, 'Task-based pairing resumes sessions automatically');
  });
});

/**
 * A pairing session that actually ENDS, so the post-pairing capture runs.
 *
 * Every other suite here stops at the launch step, because the container CLI
 * is missing. These put a fake `docker` on PATH (test/helpers/fake-docker.ts):
 * its `run` stands in for the task container and answers the summary
 * one-shot, and its scripted `exec` hook stands in for the in-container
 * session — writing into the task sandbox exactly what the real agent would
 * have left there — so `lazy pair` runs its whole post-pairing path against
 * unmocked `src/`: conversation capture, transcript, summary, turn.
 */
describe('lazy pair captures the ended session', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let scratch: string;

  const PI_FIXTURE = resolve(__dirname, '../fixtures/pi/sessions/two-turn-resumed.jsonl');
  const PI_FIXTURE_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001';

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'lazy-pair-capture-'));
    docker = await installFakeDocker(scratch);
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function pairEnv(): Record<string, string> {
    return { PATH: `${docker.binDir}:${process.env.PATH ?? ''}` };
  }

  /** A blocked task with a worktree and session, on the given agent profile. */
  function pairableTask(taskId: string, agentId: string): void {
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const task = readTaskJson(ctx.root, taskId);
    task.agent_id = agentId;
    writeTaskJson(ctx.root, taskId, task);
  }

  /**
   * Script the in-container "session" to leave a pi session file in the task
   * sandbox, where pi writes them (`~/.pi/agent/sessions/--<cwd>--/`, HOME
   * being the sandbox mount). The content is the REAL fixture the pinned pi
   * binary wrote — only the entry timestamps are moved past the pairing start,
   * because the transcript keeps entries from this session onward and the
   * fixture predates it.
   */
  async function piSessionLeftBehind(worktree: string): Promise<void> {
    const future = new Date(Date.now() + 60_000).toISOString();
    const shifted = readFileSync(PI_FIXTURE, 'utf-8')
      .replace(/"timestamp":"2026-[^"]+"/g, `"timestamp":"${future}"`);
    const staged = join(scratch, 'pi-session.jsonl');
    writeFileSync(staged, shifted);
    const sessionsDir = join(
      worktree, SANDBOX_DIR, '.pi', 'agent', 'sessions',
      `--${worktree.replace(/^\//, '').replace(/\//g, '-')}--`,
    );
    await docker.onExec(`#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${sessionsDir}"
cp "${staged}" "${sessionsDir}/2026-09-05T12-00-00-000Z_${PI_FIXTURE_SESSION_ID}.jsonl"
`);
  }

  // INVARIANT (pi-conversation-capture): a pi pairing persists the session
  // into lazy's conversation store and builds the end-of-session summary from
  // that transcript — the same as Claude Code, and said so in
  // public-docs/pairing.md. The task is on a NAMED profile on purpose: after
  // agent-profiles `task.agent_id` is a profile name, and capture keyed on
  // the profile name instead of the harness (`taskHarness === 'pi'`) would
  // silently never run for exactly this task. This test fails if it stops.
  test('a pi pairing on a named profile stores the conversation and summarizes it', async () => {
    // A pi profile inherits pi's default upstream — a LOCAL Ollama — when it
    // names no endpoint, and a local upstream is preflighted before any launch.
    // The loopback stub is what an Ollama would be here; the pairing itself
    // never sends a model request (the container's pi is faked).
    const ollamaStub = Bun.serve({ port: 0, fetch: () => new Response('Ollama is running') });
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(tomlPath, 'utf-8');
    writeFileSync(
      tomlPath,
      `${before}\n[agents.local-pi]\nharness = "pi"\nmodel = "qwen3.8:latest"\n` +
      `endpoint = "http://127.0.0.1:${ollamaStub.port}"\n`,
    );

    const taskId = await createTask(ctx, 'Pi capture task', 'Some work');
    pairableTask(taskId, 'local-pi');
    await piSessionLeftBehind(worktreePathFor(ctx.root, taskId));
    await docker.setOneshotResponse('PI-PAIR-SUMMARY: greeted twice.');

    const result = await ctx.lazy(['pair', taskId], { env: pairEnv() });
    expectSuccess(result);
    expectOutput(result, 'Agent:     local-pi (pi)');
    expectOutput(result, 'Pairing session ended');
    // Never the degraded-capture note: pi IS capturable.
    expectOutputExcludes(result, 'transcript capture is not available');
    expectOutputExcludes(result, 'Failed to save');

    // The session went to the container's pi, as pi.
    const execs = await docker.execs();
    expect(execs.length).toBe(1);
    expect(execs[0]).toContain('lazy-agent pair');
    expect(execs[0]).toContain('--agent pi');
    ollamaStub.stop(true);

    // Stored: the conversation is in the store under its pi session id, with
    // the fixture's four text messages and the session's token usage.
    const stored = JSON.parse(readFileSync(
      join(storageDirFor(ctx.root), 'conversations', `${PI_FIXTURE_SESSION_ID}.json`), 'utf-8',
    ));
    expect(stored.messages.map((m: { role: string; text: string }) => `${m.role}: ${m.text}`)).toEqual([
      'user: say hi',
      'assistant: FAKE_OK reply number 1',
      'user: second turn please',
      'assistant: FAKE_OK reply number 2',
    ]);
    expect(stored.totalUsage.outputTokens).toBeGreaterThan(0);

    // Searchable, as public-docs/pairing.md promises.
    expectOutput(await ctx.lazy(['search', 'FAKE_OK reply number 2']), 'conversation');

    // Summarized FROM that transcript: the summary one-shot's prompt carried
    // the captured lines, and its answer landed on the task as the turn.
    const summaryRun = (await docker.invocations()).join('\n');
    expect(summaryRun).toContain('Human: say hi');
    expect(summaryRun).toContain('Assistant: FAKE_OK reply number 2');
    const turns = readTurns(ctx.root, taskId);
    expect(turns.length).toBe(1);
    expect(turns[0].content).toContain('PI-PAIR-SUMMARY: greeted twice.');
  });

  // INVARIANT: a Claude pairing that starts a FRESH session — no stored id,
  // the ordinary state of a task whose stale id lazy dropped — has nothing to
  // read yet, which is not the same as "lazy cannot read this agent's session
  // files". That note is for cursor/codex; printing it here is false, and it
  // regressed once when the pi branch turned `else if (!claudeSessions)` into
  // a bare `else`.
  test('a Claude pairing with no session to resume does not claim capture is unavailable', async () => {
    const taskId = await createTask(ctx, 'Fresh claude pair task', 'Some work');
    pairableTask(taskId, 'claude-code');
    await docker.setOneshotResponse('CLAUDE-PAIR-SUMMARY.');

    const result = await ctx.lazy(['pair', taskId], { env: pairEnv() });
    expectSuccess(result);
    expectOutput(result, 'No existing claude-code session to resume');
    expectOutput(result, 'Pairing session ended');
    expectOutputExcludes(result, 'transcript capture is not available');
    expectOutputExcludes(result, 'lazy cannot read its');
  });

  // The note IS right for an agent whose session files lazy cannot read — the
  // control for the test above, so the two assertions cannot both pass by the
  // note simply never printing.
  test('a cursor pairing says its transcript is not captured', async () => {
    // A cursor container needs what a Claude one does not: its own cursor
    // credential (a container cannot use a host login session) and the LIVE
    // proxy, which cursor traffic is refused without — and only a daemon has a
    // proxy. This test used to pass daemonless and keyless only because the
    // container was launched on the default claude-code profile, the bug where
    // a cursor task's container never got cursor's environment. So this one
    // test swaps the suite's daemonless context for a daemon that sees the fake
    // docker and holds a cursor key of its own (never the host's).
    await ctx.cleanup();
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { PATH: pairEnv().PATH!, CURSOR_API_KEY: 'cursor-test-fake-key' },
    });

    const taskId = await createTask(ctx, 'Cursor pair task', 'Some work');
    pairableTask(taskId, 'cursor');

    const result = await ctx.lazy(['pair', taskId], { env: pairEnv() });
    expectSuccess(result);
    expectOutput(result, 'transcript capture is not available for cursor');
    expectOutput(result, 'Pairing session ended');
  });
});

describe('pairing state blocks operations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: create a task with a session and worktree, set to pairing state
   * with a live PID in metadata (prevents stale pairing sweep from clearing it).
   */
  async function createPairingTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Pairing task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'pairing');
    // Set pairing_pid to a PID that's alive (test runner process)
    // This prevents the reconciler's stale pairing sweep from transitioning back to blocked
    setTaskMetadata(ctx.root, taskId, 'pairing_pid', String(process.pid));
    setTaskMetadata(ctx.root, taskId, 'pairing_started_at', new Date().toISOString());
    return taskId;
  }

  // INVARIANT: pair accepts blocked | conflict | interrupted and nothing else
  // (public-docs/state-machine.md: "lazy pair <task> — blocked|conflict|interrupted →
  // pairing"). This test used to assert that `interrupted` was REJECTED, which
  // has been wrong since v0.9 made interrupted pairable — it only ever passed
  // because pair failed later for an unrelated reason.
  test('pair refuses a task in a non-pairable state', async () => {
    const taskId = await createTask(ctx, 'Backlog task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'backlog');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, "is in state 'backlog'");
    expectError(result, 'Can only pair with blocked, conflict, or interrupted tasks');
  });

  test('pair accepts an interrupted task', async () => {
    const taskId = await createTask(ctx, 'Interrupted task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['pair', taskId]);

    // Reached the launch step — the state gate let `interrupted` through.
    expectOutput(result, 'No existing claude-code session to resume');
  });

  test('pair rejects task already in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'already in a pairing session');
  });

  test('accept refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('reject refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('unblock refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['unblock', taskId, '--message', 'test feedback']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('close refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['close', taskId, '--reason', 'done']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('show displays pairing status', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['show', taskId]);

    expectSuccess(result);
    expectOutput(result, 'pairing');
  });
});

describe('pairing lock blocks other commands', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: create a task with a session and worktree, set to blocked status.
   */
  async function createPairedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Paired task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    return taskId;
  }

  test('unblock refuses when task is locked for pairing', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['unblock', taskId, '--message', 'test feedback']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('accept with dirty worktree refuses with uncommitted error (before pairing check)', async () => {
    const taskId = await createPairedTask();
    const worktreePath = worktreePathFor(ctx.root, taskId);

    // Create a REAL uncommitted change (not just the pairing lock file)
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted changes\n');

    // Place pairing lock — dirty check should catch the uncommitted change first
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    // Dirty worktree check comes FIRST, even though pairing lock is also present
    expectError(result, 'uncommitted changes');
  });

  test('accept refuses when task is locked for pairing (clean worktree)', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('reject with dirty worktree refuses with uncommitted error (before pairing check)', async () => {
    const taskId = await createPairedTask();
    const worktreePath = worktreePathFor(ctx.root, taskId);

    // Create a REAL uncommitted change (not just the pairing lock file)
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted changes\n');

    // Place pairing lock — dirty check should catch the uncommitted change first
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    // Dirty worktree check comes FIRST, even though pairing lock is also present
    expectError(result, 'uncommitted changes');
  });

  test('reject refuses when task is locked for pairing (clean worktree)', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('resume refuses when task is locked for pairing', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    // Set task to interrupted so resume can be attempted
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['resume', taskId]);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });
});
