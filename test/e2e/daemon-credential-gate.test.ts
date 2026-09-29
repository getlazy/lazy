import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readSessionJson, readTaskJson, readTurns, writeTaskJson } from '../helpers/storage';
import { resultEvent, sessionStartEvent } from '../helpers/fake-claude';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';

/**
 * INVARIANT: a model credential is needed to run a TURN, and for nothing else.
 *
 * The daemon used to refuse to start without one, on every start path. That
 * made everything the daemon does besides running turns — registering and
 * cloning a project, `lazy init`, reads, the dashboard — depend on a credential
 * none of it uses, and on an Anthropic one even for a project whose tasks run
 * codex or cursor. Lazy Teams could not clone a repository until somebody had
 * connected a Claude account.
 *
 * Now every start path brings a daemon up with no credential, `lazy daemon
 * health` says which profiles cannot run turns yet (WARN), and a turn on such a
 * profile is refused at launch in plain words naming the profile and what it
 * lacks — never "Claude" for a profile that does not run on Anthropic.
 *
 * These run the real CLI as a subprocess with LAZY_TEST='' (so the production
 * daemon start path actually executes) and HOME pinned to a temp dir (so the
 * developer's real daemon directory is untouched). Every test that starts a
 * daemon stops it in `finally`.
 */
describe('daemon without a model credential', () => {
  let ctx: TestContext;
  let tmpHome: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-credgate-'));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
  });

  /** Environment with the daemon start path live and no usable credential. */
  const noCredential = (extra: Record<string, string> = {}) => ({
    HOME: tmpHome,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENAI_API_KEY: '',
    ...extra,
  });

  // INVARIANT: AUTO-START brings a daemon up for an ordinary command with no
  // credential, and the command runs.
  test('auto-start from an ordinary command succeeds with no credential', async () => {
    try {
      const result = await ctx.lazy(['list'], { env: noCredential() });
      expect(result.stderr).not.toContain('Daemon refuses to start');
      expect(result.exitCode).toBe(0);

      const status = await ctx.lazy(['daemon', 'status'], { env: noCredential() });
      expect(status.stdout).toContain('running');
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: noCredential() });
    }
  });

  // INVARIANT: restart needs no credential either — it used to pre-flight the
  // start gate and refuse, which is gone with the gate.
  test('daemon restart succeeds with no credential', async () => {
    try {
      expect((await ctx.lazy(['daemon', 'start'], { env: noCredential() })).exitCode).toBe(0);
      const restart = await ctx.lazy(['daemon', 'restart', '--yes'], { env: noCredential() });
      expect(restart.stderr).not.toContain('Daemon refuses to start');
      expect(restart.exitCode).toBe(0);
      // ONE line saying which profiles the new daemon will refuse turns on.
      expect(restart.stderr).toContain('Note: the new daemon will have no credential for profile claude-code (Anthropic)');
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: noCredential() });
    }
  });

  // INVARIANT: the gap is visible BEFORE anyone launches a turn into it — a
  // WARN row naming the profile, not a FAIL.
  test('daemon health reports each profile that cannot run turns as a WARN', async () => {
    try {
      expect((await ctx.lazy(['daemon', 'start'], { env: noCredential() })).exitCode).toBe(0);
      const health = await ctx.lazy(['daemon', 'health'], { env: noCredential() });
      expect(health.stdout).toContain('Model credentials');
      expect(health.stdout).toContain('no credential for profile claude-code; turns on it will be refused');
      expect(health.stdout).not.toContain('Daemon refuses to start');
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: noCredential() });
    }
  });
});

/**
 * The turn gate, end to end through a real daemon and a real supervisor
 * launch (the fake-binary seam: nothing in src/ is mocked, so the refusal is
 * the daemon's own `startTask` answer).
 */
describe('a turn is where the credential is required', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    // The file backend, so a credential stored mid-test behaves the same on a
    // Mac with a Keychain and in a container with no secret service.
    const configPath = join(ctx.root, 'lazy.toml');
    await writeFile(configPath, `${await readFile(configPath, 'utf-8')}\n[credentials]\nbackend = "file"\n`);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function statusOf(code: string): Promise<string> {
    const show = await ctx.lazy(['show', code, '--json']);
    return JSON.parse(show.stdout).status;
  }

  // INVARIANT: starting a task on a profile with no credential is refused,
  // naming THAT profile and THAT credential — a codex task is never told to
  // connect a Claude account — and the task stays where it was, not `working`
  // with nothing running.
  test('a codex task with no OpenAI credential is refused by profile, never "Claude"', async () => {
    await ctx.restartDaemon({ OPENAI_API_KEY: '' });
    const created = await ctx.lazy(['create', '--goal', 'Codex work', '--prompt', 'Do it', '--agent', 'codex', '--code', 'codex-work']);
    expect(created.exitCode).toBe(0);

    const start = await ctx.lazy(['start', 'codex-work']);
    expect(start.exitCode).not.toBe(0);
    const output = start.stdout + start.stderr;
    expect(output).toContain('No credential for agent profile "codex": it needs an OpenAI credential');
    expect(output).not.toMatch(/claude|anthropic/i);
    expect(await statusOf('codex-work')).not.toBe('working');
  });

  // INVARIANT: the Anthropic credential is required by the turn too — and one
  // connected AFTER the daemon started is picked up by the next start, with no
  // daemon restart and no re-provisioning.
  test('a claude-code task is refused with no credential, then starts once one is connected', async () => {
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
    await ctx.lazy(['create', '--goal', 'Claude work', '--prompt', 'Do it', '--code', 'claude-work']);

    const refused = await ctx.lazy(['start', 'claude-work']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(
      'No credential for agent profile "claude-code": it needs an Anthropic credential',
    );
    expect(await statusOf('claude-work')).not.toBe('working');

    const set = await ctx.lazy(['auth', 'set', 'anthropic'], { input: 'sk-ant-connected-later\n' });
    expect(set.exitCode).toBe(0);

    const started = await ctx.lazy(['start', 'claude-work']);
    expect(started.stdout + started.stderr).not.toContain('No credential for agent profile');
    expect(started.exitCode).toBe(0);
  });

  /** A claude-code task that ran one turn on a credential and is now `blocked`. */
  async function blockedTask(code: string): Promise<void> {
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: 'sk-ant-fake-for-test' });
    expect((await ctx.lazy(['create', '--goal', 'Some work', '--prompt', 'Do it', '--code', code])).exitCode).toBe(0);
    expect((await ctx.lazy(['start', code])).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', code])).exitCode).toBe(0);
    expect(await statusOf(code)).toBe('blocked');
  }

  /** An `$EDITOR` that leaves a marker file behind if it is ever run. */
  async function markerEditor(): Promise<{ path: string; marker: string }> {
    const marker = join(ctx.root, 'editor-ran.marker');
    const path = join(ctx.root, 'marker-editor.sh');
    await writeFile(path, `#!/bin/sh\ntouch "${marker}"\necho "feedback" >> "$1"\n`);
    await chmod(path, 0o755);
    return { path, marker };
  }

  // INVARIANT (CLAUDE.md: never lose human feedback — pre-flight before the
  // editor): with no credential for the task's profile, `lazy unblock` refuses
  // BEFORE $EDITOR opens, naming the profile. The daemon may now run with no
  // credential at all, so this pre-flight is what keeps a human from typing
  // feedback into a turn that cannot start.
  test('unblock with no credential refuses before $EDITOR opens', async () => {
    await blockedTask('needs-feedback');
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
    const editor = await markerEditor();

    const refused = await ctx.lazy(['unblock', 'needs-feedback'], {
      env: { LAZY_FORCE_TTY: '1', EDITOR: editor.path, VISUAL: editor.path },
    });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('No credential for agent profile "claude-code"');
    expect(existsSync(editor.marker)).toBe(false);
    expect(await statusOf('needs-feedback')).toBe('blocked');
  }, 120_000);

  // INVARIANT: a launch refused for a missing credential WRITES NOTHING. The
  // daemon's unblock used to record the feedback turn and then refuse at the
  // credential plan, leaving a half-dispatched turn the redelivery path would
  // later hand the agent. Driven over the RPC directly, past the CLI pre-flight.
  test('an unblock refused for a missing credential records no turn', async () => {
    await blockedTask('no-half-turn');
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
    const taskId: string = JSON.parse((await ctx.lazy(['show', 'no-half-turn', '--json'])).stdout).id;
    const before = readTurns(ctx.root, taskId.slice(0, 8)).length;

    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    const err = await client.rpc('unblockTask', ctx.root, { taskId, message: 'try again' })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(RpcApplicationError);
    expect((err as RpcApplicationError).status).toBe(400);
    expect((err as Error).message).toContain('No credential for agent profile "claude-code"');
    expect(readTurns(ctx.root, taskId.slice(0, 8))).toHaveLength(before);
    expect(await statusOf('no-half-turn')).toBe('blocked');
  }, 120_000);

  // INVARIANT: a CLEAN merge needs no credential, but a sync that CONFLICTS
  // runs the task's agent to resolve it, which does. An automatic sync that
  // hits a conflict with no credential is HELD — no agent launched, the queued
  // sync (`pending_sync`) kept — and goes ahead by itself once a credential is
  // connected. A sync a person asks for is refused naming the profile, and does
  // not drop the queued one either.
  test('a conflict sync with no credential is held, not dropped, and runs once one is connected', async () => {
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: 'sk-ant-fake-for-test' });
    await ctx.lazy(['create', '--goal', 'Conflicting', '--prompt', 'Edit it', '--code', 'conflicting']);
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('sync-cred-1') },
        { kind: 'commit', message: 'task side', files: [{ path: 'shared.txt', content: 'task side\n' }] },
        { kind: 'emit', event: resultEvent({ result: 'Edited it.', sessionId: 'sync-cred-1' }) },
      ],
    });
    expect((await ctx.lazy(['start', 'conflicting'])).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', 'conflicting'])).exitCode).toBe(0);
    expect(await statusOf('conflicting')).toBe('blocked');
    const shortId: string = JSON.parse((await ctx.lazy(['show', 'conflicting', '--json'])).stdout).id.slice(0, 8);

    // Main edits the same file, so the parent merge conflicts.
    await writeFile(join(ctx.root, 'shared.txt'), 'main side\n');
    expect(ctx.git('-C', ctx.root, 'add', 'shared.txt').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'main side').exitCode).toBe(0);

    await ctx.restartDaemon({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('sync-cred-2') },
        { kind: 'emit', event: resultEvent({ result: 'Resolved.', sessionId: 'sync-cred-2' }) },
      ],
    });
    await ctx.clearClaudeInvocations();
    // Queue a sync the way an upstream change does; the daemon's retry loop runs it.
    writeTaskJson(ctx.root, shortId, { ...readTaskJson(ctx.root, shortId), pending_sync: 1 });

    // Several retry ticks (backoff starts at 1s) — every one held, none dropped.
    await new Promise((r) => setTimeout(r, 8_000));
    expect((await ctx.claudeInvocations()).length).toBe(0);
    expect(await statusOf('conflicting')).toBe('blocked');
    expect(readTaskJson(ctx.root, shortId).pending_sync).toBeGreaterThan(0);

    // A person's sync is refused naming the profile, and keeps the queued one.
    const refused = await ctx.lazy(['sync', 'conflicting']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('No credential for agent profile "claude-code"');
    expect(readTaskJson(ctx.root, shortId).pending_sync).toBeGreaterThan(0);
    expect((await ctx.claudeInvocations()).length).toBe(0);

    // Connect one: the retry loop's next offer launches the resolving agent.
    expect((await ctx.lazy(['auth', 'set', 'anthropic'], { input: 'sk-ant-connected-later\n' })).exitCode).toBe(0);
    const deadline = Date.now() + 90_000;
    while ((await ctx.claudeInvocations()).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect((await ctx.claudeInvocations()).length).toBeGreaterThan(0);
  }, 240_000);

  // INVARIANT: a refused `--agent` unblock changes NOTHING — the check runs on
  // the profile the unblock would switch to, before the switch is written. It
  // used to switch the stored agent (and reset its session) and only then
  // refuse, leaving the task on an agent nobody got to run.
  test('an --agent unblock refused for the new profile leaves the task on its old agent', async () => {
    await blockedTask('stay-put');
    await ctx.restartDaemon({ ANTHROPIC_API_KEY: 'sk-ant-fake-for-test', OPENAI_API_KEY: '' });
    const shortId: string = JSON.parse((await ctx.lazy(['show', 'stay-put', '--json'])).stdout).id.slice(0, 8);
    const before = readTaskJson(ctx.root, shortId);
    const sessionBefore = readSessionJson(ctx.root, shortId);

    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    const err = await client.rpc('unblockTask', ctx.root, {
      taskId: before.id, message: 'try codex', agentOverride: 'codex',
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(RpcApplicationError);
    expect((err as Error).message).toContain('No credential for agent profile "codex"');
    expect(readTaskJson(ctx.root, shortId).agent_id).toBe(before.agent_id);
    expect(readSessionJson(ctx.root, shortId)?.agent_session_id).toBe(sessionBefore?.agent_session_id);
    expect(readSessionJson(ctx.root, shortId)?.agent_id).toBe(sessionBefore?.agent_id);
    expect(await statusOf('stay-put')).toBe('blocked');
  }, 120_000);
});
