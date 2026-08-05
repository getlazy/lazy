/**
 * Unit tests for activity-based hang detection and the wind-down guard.
 *
 * This file replaces the old `graceful-exit-timeout.test.ts`, which tested a
 * marker file written by `lazy_commit`. That protocol is gone: committing is
 * not end-of-turn, and inferring it from a commit killed healthy turns
 * mid-summary. See src/supervisor/watchdog.ts.
 *
 * INVARIANTS this file encodes:
 *
 *   1. A working agent is NEVER killed for taking a long time. Only absence of
 *      *forward progress* kills it — there is no deadline from launch, from a
 *      commit, or from any other event.
 *
 *   2. Heartbeats are liveness, not progress. A wedged MCP tool call emits
 *      `tool_progress` with `heartbeat: true` every 30s forever (verified
 *      empirically against Claude Code 2.1.220). If heartbeats reset the timer
 *      a stuck tool call would be immortal — strictly worse than no guard.
 *
 *   3. The wind-down guard cannot be armed before the final result is observed.
 *      Once it is, the summary is in hand and a bounded kill loses nothing.
 *
 *   4. GracefulExitTimeoutError must carry session_id whenever it is
 *      recoverable, so the human can `lazy unblock` after a kill instead of
 *      orphaning the conversation.
 *
 *   5. Agents without an activity stream (Cursor, qa) keep byte-level liveness
 *      semantics exactly as before — any output on stdout or stderr counts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execWithWatchdog, GracefulExitTimeoutError } from '../../src/supervisor/watchdog';
import { ClaudeCodeActivityStream } from '../../src/agent/activity-stream';
import { recoverSessionIdForGracefulExit } from '../../src/supervisor/work';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { createRunnerFromType } from '../../src/runner';

// These tests plant JSONL in the sandbox layout
// (<worktree>/.lazy-task-sandbox/.claude/...), so recovery must resolve via a
// sandbox runner — the runner is authoritative for that location.
const sandboxRunner = createRunnerFromType('docker');

const BASE_ENV = { PATH: process.env.PATH ?? '' };

/** One `--output-format stream-json` line, as Claude Code emits them. */
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const TOOL_START = line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
});
const TOOL_END = line({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
});
const HEARTBEAT = line({
  type: 'tool_progress',
  heartbeat: true,
  parent_tool_use_id: 'toolu_1',
  tool_name: 'mcp__lazy__lazy_commit',
  elapsed_time_seconds: 30,
});
const TEXT = line({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'thinking out loud' }] },
});
const RESULT = line({
  type: 'result',
  subtype: 'success',
  result: 'the summary the human must never lose',
  session_id: 'sess-abc-123',
  is_error: false,
});

/**
 * Build a `bun -e` script that writes the given stdout lines with the given
 * delays. `tail` is appended verbatim (e.g. a hang or an exit).
 */
function emitScript(steps: Array<{ delayMs: number; text: string }>, tail: string): string {
  const body = steps
    .map(s => `await Bun.sleep(${s.delayMs}); console.log(${JSON.stringify(s.text)});`)
    .join('\n');
  return `${body}\n${tail}\n`;
}

const HANG_FOREVER = 'await Bun.sleep(600000);';
const EXIT_OK = 'process.exit(0);';

describe('no-progress guard (activity stream)', () => {
  // INVARIANT 1: the exact production failure this task fixes. An agent that
  // commits and then keeps working for far longer than the old 60s fuse must
  // finish untouched.
  test('does NOT kill an agent that keeps making progress well past the wind-down window', async () => {
    // 15 progress events over ~1.5s, with a 300ms wind-down configured. No
    // result is emitted until the very end, so wind-down can never arm early.
    const steps = Array.from({ length: 15 }, () => ({ delayMs: 100, text: TEXT }));
    steps.push({ delayMs: 50, text: RESULT });

    const result = await execWithWatchdog(['bun', '-e', emitScript(steps, EXIT_OK)], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 700, // shorter than the total runtime — only silence may kill
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 300,
    });

    expect(result.killedByWatchdog).toBe(false);
    expect(result.killedDuringWindDown).toBe(false);
    expect(result.exitCode).toBe(0);
    // INVARIANT: the summary is always captured, verbatim.
    expect(result.resultLine).toBe(RESULT);
    expect(result.sessionId).toBe('sess-abc-123');
  }, 20000);

  test('kills a process that stops making forward progress', async () => {
    const script = emitScript([{ delayMs: 10, text: TOOL_START }], HANG_FOREVER);

    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 700,
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 60000,
    });

    expect(result.killedByWatchdog).toBe(true);
    expect(result.killedDuringWindDown).toBe(false);
    expect(result.resultLine).toBeUndefined();
  }, 20000);

  // INVARIANT 2: heartbeats prove the process is alive, not that the turn is
  // advancing. A wedged MCP call heartbeats forever; if that reset the timer
  // the agent would never be killed.
  test('INVARIANT: heartbeats do NOT count as forward progress', async () => {
    // A tool starts, then heartbeats every 100ms forever and never completes —
    // exactly what a wedged MCP tool call looks like on the wire.
    const script = `
      console.log(${JSON.stringify(TOOL_START)});
      for (let i = 0; i < 200; i++) {
        await Bun.sleep(100);
        console.log(${JSON.stringify(HEARTBEAT)});
      }
    `;

    const t0 = Date.now();
    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 800,
      activityStream: new ClaudeCodeActivityStream(),
    });
    const elapsed = Date.now() - t0;

    expect(result.killedByWatchdog).toBe(true);
    // If heartbeats reset the timer the script would run its full 20s.
    expect(elapsed).toBeLessThan(10000);
  }, 25000);

  // The companion to the invariant above: real tool traffic DOES reset it, so
  // a long turn made of many short steps is never killed.
  test('tool_use / tool_result traffic resets the no-progress timer', async () => {
    const steps: Array<{ delayMs: number; text: string }> = [];
    for (let i = 0; i < 6; i++) {
      steps.push({ delayMs: 150, text: TOOL_START });
      steps.push({ delayMs: 150, text: TOOL_END });
    }

    const result = await execWithWatchdog(['bun', '-e', emitScript(steps, EXIT_OK)], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 700, // < total runtime (~1.8s), > any single gap
      activityStream: new ClaudeCodeActivityStream(),
    });

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20000);
});

describe('wind-down guard', () => {
  // INVARIANT 3: a hang AFTER the result is killed — and the summary survives.
  test('kills a process that emits its result and then never exits', async () => {
    const script = emitScript([{ delayMs: 10, text: RESULT }], HANG_FOREVER);

    const t0 = Date.now();
    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 0, // no-progress guard off — the wind-down guard alone is under test
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 500,
    });
    const elapsed = Date.now() - t0;

    expect(result.killedDuringWindDown).toBe(true);
    expect(result.killedByWatchdog).toBe(false);
    // The whole point: the kill costs nothing because the summary is in hand.
    expect(result.resultLine).toBe(RESULT);
    expect(result.sessionId).toBe('sess-abc-123');
    expect(result.windDownElapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(10000);
  }, 20000);

  // A kill that doesn't return control is not a kill. The agent's children
  // inherit its stdout, so a wedged tool call's subprocess can outlive the
  // SIGKILL and hold the pipe open — waiting for EOF there would hang the
  // supervisor forever on precisely the processes the guards exist to catch.
  test('returns after the kill even when a surviving child holds stdout open', async () => {
    // Emit the result, spawn a detached child that inherits stdout and sleeps
    // well past the test timeout, then hang.
    const script =
      `console.log(${JSON.stringify(RESULT)});\n` +
      `Bun.spawn(['sleep', '120'], { stdout: 'inherit', stderr: 'inherit' });\n` +
      HANG_FOREVER;

    const t0 = Date.now();
    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 0,
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 300,
    });
    const elapsed = Date.now() - t0;

    expect(result.killedDuringWindDown).toBe(true);
    // The summary is still intact — it was buffered long before the kill.
    expect(result.resultLine).toBe(RESULT);
    // SIGTERM + 5s grace + SIGKILL + 2s drain window, and no longer.
    expect(elapsed).toBeLessThan(15000);
  }, 25000);

  test('does NOT kill when the process exits promptly after its result', async () => {
    const script = emitScript([{ delayMs: 10, text: RESULT }], EXIT_OK);

    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 0,
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 30000,
    });

    expect(result.killedDuringWindDown).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.resultLine).toBe(RESULT);
  }, 20000);

  test('windDownTimeoutMs = 0 disables the wind-down kill (escape hatch)', async () => {
    // Result, then a pause longer than any plausible wind-down, then exit.
    const script = emitScript(
      [{ delayMs: 10, text: RESULT }],
      'await Bun.sleep(1200); process.exit(0);',
    );

    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 0,
      activityStream: new ClaudeCodeActivityStream(),
      windDownTimeoutMs: 0,
    });

    expect(result.killedDuringWindDown).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20000);

  // INVARIANT 3, stated negatively: with no activity stream there is no way to
  // know a result landed, so no wind-down timer may ever be armed. This is what
  // stops the old "commit means done" fuse from creeping back in.
  test('wind-down is inert without an activity stream, even when configured', async () => {
    const script = emitScript([{ delayMs: 10, text: RESULT }], 'await Bun.sleep(1200); process.exit(0);');

    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 0,
      activityStream: null,
      windDownTimeoutMs: 200,
    });

    expect(result.killedDuringWindDown).toBe(false);
    expect(result.resultLine).toBeUndefined();
    expect(result.exitCode).toBe(0);
  }, 20000);
});

// INVARIANT 5: Cursor and the qa agent emit a single blob at exit, so their
// watchdog stays byte-level. This must not regress.
describe('no-stream agents keep byte-level liveness', () => {
  test('any stdout keeps a no-stream agent alive', async () => {
    const steps = Array.from({ length: 12 }, () => ({ delayMs: 120, text: 'still here' }));

    const result = await execWithWatchdog(['bun', '-e', emitScript(steps, EXIT_OK)], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 700, // < total runtime (~1.4s)
    });

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    // Without a parser, stdout is retained in full — the caller's only source.
    expect(result.stdout).toContain('still here');
  }, 20000);

  test('stderr also counts as liveness for a no-stream agent', async () => {
    const script = `
      for (let i = 0; i < 12; i++) { await Bun.sleep(120); console.error("warn"); }
      process.exit(0);
    `;

    const result = await execWithWatchdog(['bun', '-e', script], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 700,
    });

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20000);

  test('silence still kills a no-stream agent', async () => {
    const result = await execWithWatchdog(['bun', '-e', `console.log("hi");\n${HANG_FOREVER}`], {
      cwd: '/tmp',
      env: BASE_ENV,
      timeoutMs: 600,
    });

    expect(result.killedByWatchdog).toBe(true);
  }, 20000);
});

// INVARIANT 4 (encoded by every test in this block):
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

    const got = await recoverSessionIdForGracefulExit(sandboxRunner, worktree, 'resume-session-id', Date.now() - 1000);
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

    const got = await recoverSessionIdForGracefulExit(sandboxRunner, worktree, undefined, cutoff);
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
    const got = await recoverSessionIdForGracefulExit(sandboxRunner, worktree, undefined, Date.now());
    expect(got).toBeUndefined();
  });

  test('returns undefined when sandbox exists but holds only stale JSONL (pre-launch)', async () => {
    const encoded = encodeProjectPath(worktree);
    const projDir = join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'previous-turn-session.jsonl'), '{}\n', 'utf-8');

    // launchTime is in the FUTURE relative to the file's mtime.
    const futureLaunch = Date.now() + 60_000;
    const got = await recoverSessionIdForGracefulExit(sandboxRunner, worktree, undefined, futureLaunch);
    expect(got).toBeUndefined();
  });
});

describe('GracefulExitTimeoutError', () => {
  // The message must name the real cause. It used to say "after lazy_commit
  // returned", which was both wrong and the source of the bug — a commit is
  // not end-of-turn.
  test('message names the result as the trigger, not a commit', () => {
    const err = new GracefulExitTimeoutError({
      timeoutMs: 60000,
      durationMs: 90000,
      elapsedSinceSignalMs: 60000,
    });
    expect(err.message).toContain('after the agent emitted its final result');
    expect(err.message).not.toContain('lazy_commit');
    expect(err.message).toContain('60s');
    expect(err.name).toBe('GracefulExitTimeoutError');
    expect(err.sessionId).toBeUndefined();
  });

  test('carries sessionId when provided', () => {
    const err = new GracefulExitTimeoutError({
      timeoutMs: 60000,
      durationMs: 90000,
      elapsedSinceSignalMs: 60000,
      sessionId: 'abc-def-123',
    });
    expect(err.sessionId).toBe('abc-def-123');
  });
});
