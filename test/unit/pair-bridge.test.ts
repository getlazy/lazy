import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bridgeSessionFiles, summarizeSandboxSessions } from '../../src/cli/commands/pair-bridge';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

/**
 * These tests cover `bridgeSessionFiles` for the Docker runner path, where
 * Claude Code inside the container writes session JSONLs into
 * `<worktree>/.lazy-task-sandbox/.claude/projects/<encoded>/` (via bind mount)
 * and the host needs those files visible at `~/.claude/projects/<encoded>/`
 * so that `claude --resume` can find them.
 */
describe('bridgeSessionFiles (Docker runner)', () => {
  let tempDir: string;
  let fakeHome: string;
  let worktreePath: string;
  let encodedPath: string;
  let sandboxProjectDir: string;
  let hostProjectDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-pair-bridge-test-'));
    fakeHome = join(tempDir, 'home');
    worktreePath = join(tempDir, 'worktree');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    encodedPath = encodeProjectPath(worktreePath);
    sandboxProjectDir = join(worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encodedPath);
    hostProjectDir = join(fakeHome, '.claude', 'projects', encodedPath);

    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('bridges a session from the sandbox into the host projects dir', () => {
    // Simulate Claude Code inside the Docker container having written a
    // session JSONL into the sandbox.
    mkdirSync(sandboxProjectDir, { recursive: true });
    const sessionId = 'c3f1b583-f99d-4d00-0000-000000000001';
    writeFileSync(join(sandboxProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

    const result = bridgeSessionFiles(worktreePath, sessionId);

    expect(result.accessible).toBe(true);
    expect(existsSync(join(hostProjectDir, `${sessionId}.jsonl`))).toBe(true);

    result.cleanup();
    // After cleanup, the symlink should be gone.
    expect(existsSync(hostProjectDir)).toBe(false);
  });

  test('reports actionable diagnostics when session id is missing from sandbox', () => {
    // INVARIANT: Per CLAUDE.md "Errors are actionable" — when bridging fails
    // because the stored session ID doesn't match any JSONL in the sandbox,
    // the result must list the paths checked AND the other sessions that ARE
    // in the sandbox, so the user can see what went wrong.
    mkdirSync(sandboxProjectDir, { recursive: true });
    const otherSessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    writeFileSync(join(sandboxProjectDir, `${otherSessionId}.jsonl`), '{"type":"user"}\n');

    const staleSessionId = 'c3f1b583-f99d-4d00-0000-000000000002';
    const result = bridgeSessionFiles(worktreePath, staleSessionId);

    expect(result.accessible).toBe(false);
    expect(result.availableSandboxSessions).toEqual([otherSessionId]);
    expect(result.diagnostics.some(d => d.includes(sandboxProjectDir))).toBe(true);
    expect(result.diagnostics.some(d => d.includes(staleSessionId))).toBe(true);
  });

  test('reports diagnostics when neither sandbox nor host has the session', () => {
    // Host-process runner case with missing host session file.
    const sessionId = 'c3f1b583-f99d-4d00-0000-000000000003';

    const result = bridgeSessionFiles(worktreePath, sessionId);

    expect(result.accessible).toBe(false);
    expect(result.diagnostics.some(d => d.includes('does not exist'))).toBe(true);
    expect(result.diagnostics.some(d => d.includes(`${sessionId}.jsonl`))).toBe(true);
  });

  test('returns all available sandbox sessions when stored ID is stale and multiple exist', () => {
    // INVARIANT: When the stored session ID is stale (not in sandbox) and
    // multiple other sessions exist, callers must NOT auto-pick. The bridge
    // returns the full list so the caller can refuse and surface candidates.
    mkdirSync(sandboxProjectDir, { recursive: true });
    const sessionA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    writeFileSync(join(sandboxProjectDir, `${sessionA}.jsonl`), '{"type":"user"}\n');
    writeFileSync(join(sandboxProjectDir, `${sessionB}.jsonl`), '{"type":"user"}\n');

    const stale = 'c3f1b583-f99d-4d00-0000-000000000099';
    const result = bridgeSessionFiles(worktreePath, stale);

    expect(result.accessible).toBe(false);
    expect(result.availableSandboxSessions.sort()).toEqual([sessionA, sessionB].sort());
  });

  test('re-bridging with a recovered session ID after stale fallback succeeds', () => {
    // INVARIANT: The stale-session fallback in pair.ts re-invokes
    // bridgeSessionFiles with the recovered ID. That second call must succeed
    // and make the recovered JSONL accessible to `claude --resume`.
    mkdirSync(sandboxProjectDir, { recursive: true });
    const recoveredId = 'e2dcdc34-95ed-4a3d-99ae-8428214e8a41';
    writeFileSync(join(sandboxProjectDir, `${recoveredId}.jsonl`), '{"type":"user"}\n');

    // First call with stale ID — fails as expected.
    const stale = 'c3f1b583-f99d-4d00-0000-000000000088';
    const first = bridgeSessionFiles(worktreePath, stale);
    expect(first.accessible).toBe(false);
    expect(first.availableSandboxSessions).toEqual([recoveredId]);
    first.cleanup();

    // Second call with the recovered ID — succeeds.
    const second = bridgeSessionFiles(worktreePath, recoveredId);
    expect(second.accessible).toBe(true);
    expect(existsSync(join(hostProjectDir, `${recoveredId}.jsonl`))).toBe(true);
    second.cleanup();
  });

  test('heals a dangling host symlink left by a prior pair run', () => {
    // A previous `lazy pair` crashed before cleanup and left a symlink
    // pointing to a sandbox that no longer exists. When the new sandbox has
    // the session, bridging must recover by replacing the dead symlink.
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true });
    const deadTarget = join(tempDir, 'does-not-exist');
    symlinkSync(deadTarget, hostProjectDir);

    // Now set up a fresh sandbox with the session.
    mkdirSync(sandboxProjectDir, { recursive: true });
    const sessionId = 'c3f1b583-f99d-4d00-0000-000000000004';
    writeFileSync(join(sandboxProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

    const result = bridgeSessionFiles(worktreePath, sessionId);

    expect(result.accessible).toBe(true);
    // The host project dir should now resolve to the live sandbox dir.
    expect(readlinkSync(hostProjectDir)).toBe(sandboxProjectDir);

    result.cleanup();
  });
});

/**
 * `summarizeSandboxSessions` extracts the recognition cues a human needs to
 * pick the right JSONL out of multiple stale-recovery candidates. These tests
 * pin the non-trivial behavior of that walk: sort order, tool_result skipping,
 * string-vs-array content shapes, missing files, and malformed lines.
 */
describe('summarizeSandboxSessions', () => {
  let tempDir: string;
  let worktreePath: string;
  let sandboxProjectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-pair-summarize-test-'));
    worktreePath = join(tempDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    sandboxProjectDir = join(
      worktreePath,
      '.lazy-task-sandbox',
      '.claude',
      'projects',
      encodeProjectPath(worktreePath),
    );
    mkdirSync(sandboxProjectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('sorts results newest-first by mtime', () => {
    // INVARIANT: The picker shows [1] first; the user expects [1] to be the
    // most recently touched session (the one they were most likely just
    // working in). Reordering this would silently confuse recovery UX.
    const old = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const mid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const newest = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    for (const id of [old, mid, newest]) {
      writeFileSync(
        join(sandboxProjectDir, `${id}.jsonl`),
        JSON.stringify({ type: 'user', message: { content: id } }) + '\n',
      );
    }
    const now = Date.now() / 1000;
    utimesSync(join(sandboxProjectDir, `${old}.jsonl`), now - 7200, now - 7200);
    utimesSync(join(sandboxProjectDir, `${mid}.jsonl`), now - 3600, now - 3600);
    utimesSync(join(sandboxProjectDir, `${newest}.jsonl`), now - 60, now - 60);

    return summarizeSandboxSessions(worktreePath, [old, mid, newest]).then(summaries => {
      expect(summaries.map(s => s.id)).toEqual([newest, mid, old]);
    });
  });

  test('skips tool_result user entries and surfaces the most recent real human text', async () => {
    // INVARIANT: Claude Code emits type:'user' entries for tool_result
    // payloads. Those are not human input — surfacing them as "last human"
    // would be misleading recognition cues. Walk back to the previous entry
    // that has actual text content.
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'real human message' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'agent reply' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] },
      }),
    ];
    writeFileSync(join(sandboxProjectDir, `${id}.jsonl`), lines.join('\n') + '\n');

    const summaries = await summarizeSandboxSessions(worktreePath, [id]);
    expect(summaries[0].lastHumanText).toBe('real human message');
  });

  test('handles string-shaped user content (not just array-shaped)', async () => {
    // Claude Code's JSONL has historically used both `content: 'hello'` and
    // `content: [{type:'text', text:'hello'}]` shapes. Both must be surfaced
    // — collapsing only one would silently hide whole conversations.
    const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    writeFileSync(
      join(sandboxProjectDir, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
    );

    const summaries = await summarizeSandboxSessions(worktreePath, [id]);
    expect(summaries[0].lastHumanText).toBe('hello');
  });

  test('returns null fields without throwing when JSONL is missing', async () => {
    // INVARIANT: A missing file is a normal recovery condition (sandbox was
    // partially cleaned, file vanished between listing and reading). The
    // summarizer must not throw — the picker still has to render the entry.
    const summaries = await summarizeSandboxSessions(worktreePath, [
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].ageMs).toBeNull();
    expect(summaries[0].lastHumanText).toBeNull();
  });

  test('skips a malformed JSONL line and surfaces an earlier valid human message', async () => {
    // INVARIANT: A truncated/corrupt last line (e.g. partial write during a
    // crash) must not poison the whole walk. The summarizer should keep
    // walking backwards and find earlier valid content.
    const id = '99999999-9999-9999-9999-999999999999';
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'earlier valid message' }] },
      }),
      '{not valid json at all',
    ];
    writeFileSync(join(sandboxProjectDir, `${id}.jsonl`), lines.join('\n') + '\n');

    const summaries = await summarizeSandboxSessions(worktreePath, [id]);
    expect(summaries[0].lastHumanText).toBe('earlier valid message');
  });
});
