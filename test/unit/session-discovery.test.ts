/**
 * Unit tests for runner-driven agent session-log discovery.
 *
 * INVARIANT (encoded by this block): each runner is the single source of truth
 * for where ITS agent writes Claude Code session JSONL, and the shared
 * `findLatestSessionFile` helper scans whatever directory the runner names.
 * A regression where discovery hard-codes the sandbox location makes
 * `lazy watch` (and the activity monitor) show NO agent output for host-runner
 * tasks — the bug this suite guards against.
 *
 *   - sandbox runners (docker/podman): <worktree>/.lazy-task-sandbox/.claude/projects/<encoded>
 *   - host-process runner:             <host-home>/.claude/projects/<encoded>
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findLatestSessionFile, findLatestPiSessionFile, rediscoverSessionIdForHarness } from '../../src/agent/session-discovery';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { ONESHOT_MARKER, markMachineOneshotPrompt } from '../../src/import/machine-oneshot';
import { createRunnerFromType } from '../../src/runner';

/**
 * A machine one-shot stub shaped like the ones witnessed on disk: the first
 * line is a `queue-operation` entry whose `content` STARTS with the marker,
 * written by `runClaudeOneshot` before Claude even answers (these particular
 * stubs came from runs that died with "Not logged in").
 */
function oneshotStub(prompt = 'write the branch description'): string {
  const first = JSON.stringify({
    type: 'queue-operation',
    timestamp: '2026-08-14T10:00:00.000Z',
    content: markMachineOneshotPrompt(prompt),
  });
  const second = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
  });
  return `${first}\n${second}\n`;
}

/** A real agent session line — no marker anywhere. */
function agentSessionLine(text = 'working on the task'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  }) + '\n';
}

// ── Runners own their session-log location ────────────────────────────────

describe('Runner.agentSessionProjectDir', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-disc-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-disc-home-'));
    // HostProcessRunner resolves HOME via getHome() → process.env.HOME first.
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test('docker (sandbox) runner resolves to the in-worktree sandbox dir', () => {
    const runner = createRunnerFromType('docker');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded),
    );
  });

  test('podman runner inherits the sandbox location', () => {
    const runner = createRunnerFromType('podman');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded),
    );
  });

  test('host-process runner resolves to the real host home', () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(fakeHome, '.claude', 'projects', encoded),
    );
  });
});

// ── Discovery scans the runner-named directory ────────────────────────────

describe('findLatestSessionFile', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-disc2-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-disc2-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  // Docker/sandbox runner: JSONL lives under the worktree's sandbox HOME.
  test('discovers the session via a docker runner dir', async () => {
    const runner = createRunnerFromType('docker');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'docker-session.jsonl'), '{"type":"system"}\n', 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('docker-session');
    expect(info?.path).toBe(join(projDir, 'docker-session.jsonl'));
  });

  // Host-process runner: JSONL lives under the real host HOME, NOT the sandbox.
  // This is the case the original bug missed entirely.
  test('discovers the session via a host-process runner dir', async () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'host-session.jsonl'), '{"type":"system"}\n', 'utf-8');

    // Sanity: this is the host home, not the sandbox.
    expect(projDir.startsWith(fakeHome)).toBe(true);

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('host-session');
    expect(info?.path).toBe(join(projDir, 'host-session.jsonl'));
  });

  test('returns the most recently modified file in the dir', async () => {
    const projDir = join(worktree, 'proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'older.jsonl'), '{}\n', 'utf-8');
    await Bun.sleep(20);
    await writeFile(join(projDir, 'newer.jsonl'), '{}\n', 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('newer');
  });

  test('returns null when the directory does not exist', async () => {
    const info = await findLatestSessionFile(join(worktree, 'nope'));
    expect(info).toBeNull();
  });

  test('returns null when the directory holds no JSONL', async () => {
    const projDir = join(worktree, 'empty');
    await mkdir(projDir, { recursive: true });
    const info = await findLatestSessionFile(projDir);
    expect(info).toBeNull();
  });

  test('honors the minMtimeMs cutoff', async () => {
    const projDir = join(worktree, 'proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'stale.jsonl'), '{}\n', 'utf-8');

    // Cutoff in the future — the only file on disk is older, so nothing matches.
    const info = await findLatestSessionFile(projDir, Date.now() + 60_000);
    expect(info).toBeNull();
  });
});

// ── One-shots never win session ownership ─────────────────────────────────

/**
 * INVARIANT: this helper is a session-OWNERSHIP path (its only callers are
 * `lazy watch`, the activity monitor, and the supervisor's graceful-exit
 * session recovery), so it must never return lazy's own machine one-shot.
 *
 * The witnessed bug: lazy's housekeeping one-shots write their JSONL into the
 * same projects dir as the task's agent. Each new stub is the mtime-newest file
 * there, so `lazy watch` hopped onto it and rendered the housekeeping prompt and
 * its "Not logged in" failure INSIDE the task's timeline, then hopped back when
 * the real session grew again. The same pick also let graceful-exit recovery
 * record a housekeeping session id as the agent's resume target.
 *
 * INVARIANT (safe direction, inherited from `excludeMachineOneshots`): only the
 * head-anchored marker disqualifies a file. Unmarked and unreadable files are
 * KEPT — a file that merely MENTIONS the marker in prose is a real session.
 */
describe('findLatestSessionFile — machine one-shot exclusion', () => {
  let projDir: string;

  beforeEach(async () => {
    projDir = await mkdtemp(join(tmpdir(), 'lazy-disc3-proj-'));
  });

  afterEach(async () => {
    await rm(projDir, { recursive: true, force: true });
  });

  test('skips a NEWER one-shot stub and returns the agent session', async () => {
    await writeFile(join(projDir, 'agent-session.jsonl'), agentSessionLine(), 'utf-8');
    await Bun.sleep(20);
    await writeFile(join(projDir, 'oneshot-stub.jsonl'), oneshotStub(), 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('agent-session');
  });

  test('skips several one-shot stubs to reach the agent session', async () => {
    await writeFile(join(projDir, 'agent-session.jsonl'), agentSessionLine(), 'utf-8');
    for (const name of ['os1', 'os2', 'os3']) {
      await Bun.sleep(10);
      await writeFile(join(projDir, `${name}.jsonl`), oneshotStub(), 'utf-8');
    }

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('agent-session');
  });

  test('returns null when every file in the dir is a one-shot', async () => {
    await writeFile(join(projDir, 'os1.jsonl'), oneshotStub(), 'utf-8');
    await writeFile(join(projDir, 'os2.jsonl'), oneshotStub(), 'utf-8');

    expect(await findLatestSessionFile(projDir)).toBeNull();
  });

  test('keeps a session that merely MENTIONS the marker in its content', async () => {
    // A task prompt or transcript quoting the marker mid-message is a REAL
    // session — the predicate is head-anchored, not a substring search.
    const mention = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `the marker looks like ${ONESHOT_MARKER} and lives at the head` },
    }) + '\n';
    await writeFile(join(projDir, 'agent-session.jsonl'), mention, 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('agent-session');
  });

  test('a growing agent session stays the pick across repeated polls', async () => {
    // Watch polls at 500ms and this helper caches marker verdicts by path; a
    // cached verdict must not go stale as the real session appends, nor as a
    // one-shot stub is re-picked as newest.
    const agent = join(projDir, 'agent-session.jsonl');
    await writeFile(agent, agentSessionLine(), 'utf-8');
    await Bun.sleep(20);
    await writeFile(join(projDir, 'oneshot-stub.jsonl'), oneshotStub(), 'utf-8');

    expect((await findLatestSessionFile(projDir))?.sessionId).toBe('agent-session');

    await Bun.sleep(20);
    await writeFile(agent, agentSessionLine() + agentSessionLine('more work'), 'utf-8');
    expect((await findLatestSessionFile(projDir))?.sessionId).toBe('agent-session');

    // And once the file is a one-shot it stays excluded even after it grows.
    await Bun.sleep(20);
    await writeFile(join(projDir, 'oneshot-stub.jsonl'), oneshotStub() + agentSessionLine(), 'utf-8');
    expect((await findLatestSessionFile(projDir))?.sessionId).toBe('agent-session');
  });

  test('an empty file that later becomes a one-shot is re-judged, not cached as real', async () => {
    // The verdict for a partial head is provisional: an empty JSONL carries no
    // marker YET. Caching that as "real session" would let the stub win once
    // the one-shot's prompt lands.
    const stub = join(projDir, 'late-oneshot.jsonl');
    await writeFile(join(projDir, 'agent-session.jsonl'), agentSessionLine(), 'utf-8');
    await Bun.sleep(20);
    await writeFile(stub, '', 'utf-8');

    // Empty file is unmarked, so it is treated as real and wins on mtime.
    expect((await findLatestSessionFile(projDir))?.sessionId).toBe('late-oneshot');

    await Bun.sleep(20);
    await writeFile(stub, oneshotStub(), 'utf-8');
    expect((await findLatestSessionFile(projDir))?.sessionId).toBe('agent-session');
  });

  test('minMtimeMs and one-shot exclusion compose', async () => {
    // Graceful-exit recovery passes launchTime: of the files written since
    // launch, the one-shot must not be the recovered session id.
    await writeFile(join(projDir, 'stale-agent.jsonl'), agentSessionLine(), 'utf-8');
    await Bun.sleep(20);
    const cutoff = Date.now();
    await Bun.sleep(20);
    await writeFile(join(projDir, 'turn-oneshot.jsonl'), oneshotStub(), 'utf-8');

    // The only post-cutoff file is a one-shot — recovery gets nothing rather
    // than a housekeeping session id.
    expect(await findLatestSessionFile(projDir, cutoff)).toBeNull();

    await Bun.sleep(20);
    await writeFile(join(projDir, 'turn-agent.jsonl'), agentSessionLine(), 'utf-8');
    expect((await findLatestSessionFile(projDir, cutoff))?.sessionId).toBe('turn-agent');
  });
});

// ── pi sessions: runner-owned location + header-parsed id ─────────────────

/**
 * INVARIANT: pi's session rediscovery (the resume path in auto-resume and the
 * unblock launch) must find the SAME file pi itself would resume — the newest
 * JSONL in `<piAgentDir>/sessions/--<munged worktree>--`, id read from the
 * file's own header line. A wrong or missing id degrades to pi's
 * create-or-resume opening a fresh conversation — the exact 2026-09-16
 * incident outcome these tests pin down.
 */
describe('agentPiAgentDir', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-pi-disc-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-pi-disc-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test('docker (sandbox) runner resolves to the sandbox .pi/agent dir', () => {
    const runner = createRunnerFromType('docker');
    expect(runner.agentPiAgentDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.pi', 'agent'),
    );
  });

  test('podman runner inherits the sandbox location', () => {
    const runner = createRunnerFromType('podman');
    expect(runner.agentPiAgentDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.pi', 'agent'),
    );
  });

  test('host-process runner resolves to the real host home', () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    expect(runner.agentPiAgentDir(worktree)).toBe(join(fakeHome, '.pi', 'agent'));
  });
});

/** A pi session header line — always the file's first line. */
function piSessionHeader(sessionId: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: '2026-09-16T15:53:58.123Z',
    cwd: '/the/worktree',
  }) + '\n';
}

/** A pi message line, to make the file look lived-in. */
function piSessionLine(text: string): string {
  return JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

describe('findLatestPiSessionFile', () => {
  let worktree: string;
  let piAgentDir: string;

  /** pi's own munge of the cwd, as getDefaultSessionDirPath computes it. */
  const munge = (cwd: string) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-pi-wt-'));
    piAgentDir = join(worktree, '.lazy-task-sandbox', '.pi', 'agent');
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  function sessionDir(): string {
    return join(piAgentDir, 'sessions', munge(worktree));
  }

  test('finds the newest session and reads its id from the header', async () => {
    const dir = sessionDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-16T15-00-00-000Z_sess-old.jsonl'), piSessionHeader('sess-old') + piSessionLine('earlier'), 'utf-8');
    await Bun.sleep(20);
    await writeFile(join(dir, '2026-09-16T15-53-58-123Z_sess-new.jsonl'), piSessionHeader('sess-new') + piSessionLine('the live one'), 'utf-8');

    const info = await findLatestPiSessionFile(piAgentDir, worktree);
    expect(info?.sessionId).toBe('sess-new');
    expect(info?.path).toBe(join(dir, '2026-09-16T15-53-58-123Z_sess-new.jsonl'));
  });

  test('derives the id from the filename when the header is unreadable', async () => {
    const dir = sessionDir();
    await mkdir(dir, { recursive: true });
    // pi writes the header first, so a headerless file should be rare — but the
    // filename split must still answer with pi's own convention.
    await writeFile(join(dir, '2026-09-16T15-53-58-123Z_sess-crashed.jsonl'), '{ truncated', 'utf-8');

    const info = await findLatestPiSessionFile(piAgentDir, worktree);
    expect(info?.sessionId).toBe('sess-crashed');
  });

  test('a header id that differs from the filename wins', async () => {
    // The header is pi's own source of truth; a filename that disagrees (or an
    // id containing underscores, which the timestamp_id split cannot see
    // through) must not poison discovery.
    const dir = sessionDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-16T15-53-58-000Z_wrong-name.jsonl'), piSessionHeader('has_underscore'), 'utf-8');

    expect((await findLatestPiSessionFile(piAgentDir, worktree))?.sessionId).toBe('has_underscore');
  });

  test('returns null when pi has written no sessions for this worktree', async () => {
    await mkdir(piAgentDir, { recursive: true });
    expect(await findLatestPiSessionFile(piAgentDir, worktree)).toBeNull();
  });

  test('returns null when the munged project dir does not exist', async () => {
    expect(await findLatestPiSessionFile(piAgentDir, worktree)).toBeNull();
  });

  test('ignores sessions belonging to a DIFFERENT worktree', async () => {
    const dir = sessionDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-16T15-53-58-000Z_other.jsonl'), piSessionHeader('other-task'), 'utf-8');
    const otherWorktree = join(worktree, 'sibling');

    expect(await findLatestPiSessionFile(piAgentDir, otherWorktree)).toBeNull();
    expect((await findLatestPiSessionFile(piAgentDir, worktree))?.sessionId).toBe('other-task');
  });
});

// ── Harness dispatch: which layouts a resume may rediscover ───────────────

describe('rediscoverSessionIdForHarness', () => {
  let worktree: string;
  let sandboxRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-redis-wt-'));
    sandboxRoot = join(worktree, '.lazy-task-sandbox');
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-redis-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  const munge = (cwd: string) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

  // INVARIANT (fix-agent-switching-on-tasks): a harness with no resumable
  // layout gets null — inventing a resume token for it would skip the
  // distilled handoff a fresh session needs.
  test('cursor and unknown harnesses rediscover nothing', async () => {
    const runner = createRunnerFromType('docker');
    expect(await rediscoverSessionIdForHarness('cursor', runner, worktree)).toBeNull();
    expect(await rediscoverSessionIdForHarness('codex', runner, worktree)).toBeNull();
    expect(await rediscoverSessionIdForHarness('claude-code', runner, worktree)).toBeNull();
  });

  test('pi rediscovers the newest pi session via the runner', async () => {
    const runner = createRunnerFromType('docker');
    const dir = join(sandboxRoot, '.pi', 'agent', 'sessions', munge(worktree));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-16T15-53-58-123Z_sess-pi-1.jsonl'), piSessionHeader('sess-pi-1'), 'utf-8');

    expect(await rediscoverSessionIdForHarness('pi', runner, worktree)).toBe('sess-pi-1');
  });

  test('claude-code rediscovers via the runner\u2019s claude projects dir', async () => {
    const runner = createRunnerFromType('docker');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'claude-sess-9.jsonl'), '{"type":"system"}\n', 'utf-8');

    expect(await rediscoverSessionIdForHarness('claude-code', runner, worktree)).toBe('claude-sess-9');
  });

  test('pi discovery through a host-process runner lands under the host HOME', async () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const dir = join(fakeHome, '.pi', 'agent', 'sessions', munge(worktree));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-16T15-53-58-123Z_sess-host.jsonl'), piSessionHeader('sess-host'), 'utf-8');

    const id = await rediscoverSessionIdForHarness('pi', runner, worktree);
    expect(id).toBe('sess-host');
  });
});
