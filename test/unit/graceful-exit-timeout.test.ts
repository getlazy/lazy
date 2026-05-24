/**
 * Unit tests for the graceful-exit-timeout feature.
 *
 * Covers:
 *   - Marker file write helper (atomic, idempotent, structured content).
 *   - execWithWatchdog kills a hung process when the marker appears.
 *   - execWithWatchdog leaves a fast process alone (happy path).
 *   - gracefulExitTimeoutMs = 0 disables the feature (escape hatch).
 *   - INVARIANT: once the marker is observed, the timer runs to completion —
 *     re-writes or further tool calls do NOT reset it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execWithWatchdog, GracefulExitTimeoutError } from '../../src/supervisor/watchdog';
import {
  turnEndSignalPath,
  writeTurnEndSignal,
  readTurnEndSignal,
  clearTurnEndSignal,
} from '../../src/protocol/turn-end-signal';
import { recoverSessionIdForGracefulExit } from '../../src/supervisor/work';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

describe('turn-end-signal marker file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-tes-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writeTurnEndSignal writes an atomic, parseable JSON file', async () => {
    const signal = { commit_sha: 'abc123def', written_at: '2026-01-01T00:00:00.000Z' };
    await writeTurnEndSignal(dir, signal);

    const onDisk = await readFile(turnEndSignalPath(dir), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual(signal);
  });

  test('writeTurnEndSignal is idempotent — re-writing overwrites cleanly', async () => {
    await writeTurnEndSignal(dir, { commit_sha: 'first', written_at: '2026-01-01T00:00:00.000Z' });
    await writeTurnEndSignal(dir, { commit_sha: 'second', written_at: '2026-01-02T00:00:00.000Z' });

    const got = await readTurnEndSignal(dir);
    expect(got?.commit_sha).toBe('second');
  });

  test('readTurnEndSignal returns null when the marker is absent', async () => {
    expect(await readTurnEndSignal(dir)).toBeNull();
  });

  // CLAUDE.md "errors are for humans": distinguish "missing" (normal) from
  // "found but broken" (real error the user must see).
  test('readTurnEndSignal throws when the marker exists but is unparseable', async () => {
    await writeFile(turnEndSignalPath(dir), '{not json', 'utf-8');
    let caught: Error | null = null;
    try {
      await readTurnEndSignal(dir);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain('Failed to parse turn-end-signal');
  });

  test('clearTurnEndSignal is safe when the marker is absent', async () => {
    await clearTurnEndSignal(dir);
    expect(await readTurnEndSignal(dir)).toBeNull();
  });
});

describe('execWithWatchdog graceful-exit watcher', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-gex-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('kills process when marker appears and grace timer expires before exit', async () => {
    const markerPath = turnEndSignalPath(dir);

    // Subprocess: emit a line, then write the marker, then hang forever.
    // This simulates the production failure: agent commits (writes marker) but
    // then keeps spinning on a stuck tool call.
    const script = `
      console.log("started");
      await Bun.write(${JSON.stringify(markerPath)}, JSON.stringify({ commit_sha: "x", written_at: new Date().toISOString() }));
      await Bun.sleep(60000);
    `;

    const t0 = Date.now();
    const result = await execWithWatchdog(
      ['bun', '-e', script],
      {
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 0, // output watchdog disabled — we're testing graceful-exit alone
        gracefulExitMarkerPath: markerPath,
        gracefulExitTimeoutMs: 500,
      },
    );
    const elapsed = Date.now() - t0;

    expect(result.killedByGracefulExit).toBe(true);
    expect(result.killedByWatchdog).toBe(false);
    expect(result.stdout).toContain('started');
    // Should kill within (poll interval ≤500ms) + grace (500ms) + SIGKILL grace (5s) ≈ ≤7s.
    expect(elapsed).toBeLessThan(10000);
    expect(result.gracefulExitElapsedMs).toBeGreaterThanOrEqual(450);
  }, 15000);

  test('does NOT kill when the process exits before the grace timer expires (happy path)', async () => {
    const markerPath = turnEndSignalPath(dir);

    // Subprocess writes the marker, then exits quickly — well before the
    // (deliberately long) grace timer would fire.
    const script = `
      await Bun.write(${JSON.stringify(markerPath)}, JSON.stringify({ commit_sha: "ok", written_at: new Date().toISOString() }));
      console.log("done");
      process.exit(0);
    `;

    const result = await execWithWatchdog(
      ['bun', '-e', script],
      {
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 0,
        gracefulExitMarkerPath: markerPath,
        gracefulExitTimeoutMs: 30000,
      },
    );

    expect(result.killedByGracefulExit).toBe(false);
    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
  }, 10000);

  test('disabled when gracefulExitTimeoutMs = 0 — marker is ignored (escape hatch)', async () => {
    const markerPath = turnEndSignalPath(dir);
    // Pre-write the marker so it exists from t=0.
    await writeTurnEndSignal(dir, { commit_sha: 'pre', written_at: new Date().toISOString() });

    // Process emits output, then exits normally. With the feature disabled,
    // the pre-existing marker must NOT cause a kill.
    const script = `
      console.log("hi");
      await Bun.sleep(200);
      process.exit(0);
    `;

    const result = await execWithWatchdog(
      ['bun', '-e', script],
      {
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 0,
        gracefulExitMarkerPath: markerPath,
        gracefulExitTimeoutMs: 0,
      },
    );

    expect(result.killedByGracefulExit).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  // INVARIANT: Once end-of-turn signal fires, the timer runs to completion —
  // resetting on later tool calls reintroduces the indefinite-hang failure
  // mode this feature is designed to prevent.
  test('INVARIANT: timer does NOT reset when marker is re-written after first observation', async () => {
    const markerPath = turnEndSignalPath(dir);

    // Subprocess writes the marker, then keeps re-writing it every 100ms
    // (simulating an agent that keeps calling tools after lazy_commit).
    // Despite the constant re-writes, the grace timer must run to completion.
    const script = `
      const path = ${JSON.stringify(markerPath)};
      const sig = JSON.stringify({ commit_sha: "x", written_at: new Date().toISOString() });
      await Bun.write(path, sig);
      // Keep "calling tools" — re-write the marker repeatedly. The timer
      // started on first observation must NOT be reset by these updates.
      for (let i = 0; i < 200; i++) {
        await Bun.write(path, sig);
        await Bun.sleep(100);
      }
    `;

    const t0 = Date.now();
    const result = await execWithWatchdog(
      ['bun', '-e', script],
      {
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 0,
        gracefulExitMarkerPath: markerPath,
        gracefulExitTimeoutMs: 1000,
      },
    );
    const elapsed = Date.now() - t0;

    expect(result.killedByGracefulExit).toBe(true);
    // Marker appears at ~t=0, timer fires at ~t=1000ms, SIGTERM, then proc exits.
    // If the timer had been reset on every re-write (100ms), elapsed would be
    // 200 * 100ms = 20s before the process exits on its own. We must kill far
    // sooner than that.
    expect(elapsed).toBeLessThan(8000);
  }, 15000);
});

// INVARIANT (encoded by every test in this block):
// GracefulExitTimeoutError must carry session_id whenever it is recoverable,
// so the human can `lazy unblock` after the kill instead of orphaning the
// conversation.
describe('recoverSessionIdForGracefulExit', () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-recov-'));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  // Branch 1: resumed turn — daemon passed agent_session_id, supervisor
  // forwarded it as --resume. We must prefer it without touching disk.
  test('prefers the passed-in claudeSessionId (resume case)', async () => {
    // Plant a misleading JSONL on disk to prove we did NOT consult it.
    const encoded = encodeProjectPath(worktree);
    const projDir = join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'WRONG-SESSION-FROM-DISK.jsonl'), '{}\n', 'utf-8');

    const got = await recoverSessionIdForGracefulExit(worktree, 'resume-session-id', Date.now() - 1000);
    expect(got).toBe('resume-session-id');
  });

  // Branch 2: fresh first turn — no --resume, but Claude has been writing a
  // JSONL since process start. Discover it via the same path lazy watch uses.
  test('discovers session id from JSONL when no claudeSessionId is provided', async () => {
    const launchTime = Date.now();

    const encoded = encodeProjectPath(worktree);
    const projDir = join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded);
    await mkdir(projDir, { recursive: true });

    // Plant a stale session (modified BEFORE launchTime) — must be ignored.
    const stale = join(projDir, 'stale-old-session.jsonl');
    await writeFile(stale, '{}\n', 'utf-8');
    const longAgo = new Date(launchTime - 60_000);
    // Bun's fs/promises doesn't ship utimes here; rewrite is simpler: rely on
    // the file having a pre-launch mtime since we wrote it before launchTime.
    // We capture a fresh launchTime *after* writing the stale file, so it
    // is genuinely older than the cutoff.
    const cutoff = Date.now();
    // Small sleep so the live file's mtime is strictly greater than cutoff.
    await Bun.sleep(20);

    const live = join(projDir, 'live-session-uuid.jsonl');
    await writeFile(live, '{"type":"system"}\n', 'utf-8');

    const got = await recoverSessionIdForGracefulExit(worktree, undefined, cutoff);
    expect(got).toBe('live-session-uuid');
    // Silence the unused-var lint if any. The stale fixture is still on disk;
    // the discovery helper must have skipped it via the minMtime cutoff.
    expect(longAgo).toBeDefined();
  });

  // Branch 3: agent died before writing any JSONL. No --resume, no file.
  // Response must come back with session_id undefined and a clear log line
  // (we don't capture log output here; the helper logs internally — verified
  // by the supervisor-side log line in src/supervisor/index.ts).
  test('returns undefined when neither --resume nor a JSONL file is available', async () => {
    // No .lazy-task-sandbox directory at all — simulates agent dying before
    // claude wrote anything.
    const got = await recoverSessionIdForGracefulExit(worktree, undefined, Date.now());
    expect(got).toBeUndefined();
  });

  test('returns undefined when sandbox exists but holds only stale JSONL (pre-launch)', async () => {
    const encoded = encodeProjectPath(worktree);
    const projDir = join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'previous-turn-session.jsonl'), '{}\n', 'utf-8');

    // launchTime is in the FUTURE relative to the file's mtime.
    const futureLaunch = Date.now() + 60_000;
    const got = await recoverSessionIdForGracefulExit(worktree, undefined, futureLaunch);
    expect(got).toBeUndefined();
  });
});

describe('GracefulExitTimeoutError', () => {
  test('message names the cause and includes elapsed time + marker path', () => {
    const err = new GracefulExitTimeoutError({
      timeoutMs: 60000,
      durationMs: 90000,
      elapsedSinceSignalMs: 60000,
      markerPath: '/tmp/foo/turn-end-signal',
    });
    expect(err.message).toContain('after lazy_commit returned');
    expect(err.message).toContain('60s');
    expect(err.message).toContain('/tmp/foo/turn-end-signal');
    expect(err.name).toBe('GracefulExitTimeoutError');
    expect(err.sessionId).toBeUndefined();
  });

  test('carries sessionId when provided', () => {
    const err = new GracefulExitTimeoutError({
      timeoutMs: 60000,
      durationMs: 90000,
      elapsedSinceSignalMs: 60000,
      markerPath: '/tmp/foo/turn-end-signal',
      sessionId: 'abc-def-123',
    });
    expect(err.sessionId).toBe('abc-def-123');
  });
});
