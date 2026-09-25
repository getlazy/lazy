/**
 * Turn-hook command execution with hard timeout, SIGKILL escalation, and
 * concurrent stdio draining.
 *
 * One runner, three callers: the `[automation] pre_turn` setup hook, the
 * `[automation] post_turn` check, and the `[automation.pre_accept]` gate. It
 * grew out of the post-turn check (hence the filename and the history below),
 * but nothing in it is post-turn-specific.
 *
 * Background: a real production case left a `cargo build` post-turn check
 * stuck for ~30 minutes despite a 600s timeout being configured. Root causes:
 *
 *   1. stdout/stderr were piped but never drained while the child ran.
 *      Verbose commands (cargo build, npm install) fill the ~64KB OS pipe
 *      buffer and block on write — so the child cannot reach exit, and
 *      `proc.exited` cannot resolve naturally.
 *
 *   2. On timeout we sent plain SIGTERM with no SIGKILL escalation. Process
 *      trees that ignore SIGTERM (or whose children re-parent on parent death)
 *      survive.
 *
 *   3. After `proc.kill()` we did not await `proc.exited`, so we never knew
 *      whether the kill actually took effect.
 *
 *   4. There was no heartbeat output, so 10 minutes of silence looked
 *      identical to a hang from outside.
 *
 * This module fixes all four: drain pipes concurrently into capped buffers,
 * escalate SIGTERM → SIGKILL after a grace period, wait for the child to
 * actually be gone, and log a heartbeat every 60s so the supervisor's log
 * never goes quiet during a long check.
 */

import { spawn } from '../utils/spawn';
import { log, logWarn } from './log';

/** Grace period between SIGTERM and SIGKILL (ms). Matches the watchdog. */
const KILL_GRACE_MS = 5000;

/** How often to emit a "still running" heartbeat while the check executes. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Cap each captured stream to avoid unbounded memory growth on verbose checks. */
const MAX_STREAM_BYTES = 1 * 1024 * 1024; // 1 MiB

/** @deprecated Kept as the historical name; both streams share this cap. */
const MAX_STDERR_BYTES = MAX_STREAM_BYTES;

export interface TurnHookResult {
  /** Process exit code, or -2 when killed by timeout, or -1 on spawn failure. */
  exitCode: number;
  /** Captured stderr (truncated to MAX_STREAM_BYTES). */
  stderr: string;
  /**
   * Captured stdout (truncated to MAX_STREAM_BYTES).
   *
   * Captured because plenty of real scripts — service launchers especially —
   * report failure on stdout and say nothing on stderr. Draining stdout to a
   * null sink made those failures look like a bare non-zero exit code with no
   * explanation at all.
   */
  stdout: string;
  /** True if the check was killed because it exceeded the timeout. */
  timedOut: boolean;
  /** Signal that finally terminated the process when timedOut=true. */
  killSignal?: 'SIGTERM' | 'SIGKILL';
  /** Wall-clock duration of the check (ms). */
  elapsedMs: number;
}

/** Destination for a hook run's progress lines (heartbeat, SIGTERM/SIGKILL). */
export interface TurnHookLogSink {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const SUPERVISOR_LOG_SINK: TurnHookLogSink = {
  info: (message) => log(`[supervisor] ${message}`),
  warn: (message) => logWarn(`[supervisor] ${message}`),
};

interface Drain {
  done: Promise<void>;
  /** Cancel the underlying reader so the loop exits even if the pipe never closes. */
  cancel: () => void;
}

function startDrain(
  stream: ReadableStream<Uint8Array>,
  sink: { chunks: Buffer[]; bytes: number; truncated: boolean } | null,
): Drain {
  const reader = stream.getReader();
  let cancelled = false;
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!sink) continue;
        if (sink.bytes >= MAX_STDERR_BYTES) {
          sink.truncated = true;
          continue; // keep draining so the child doesn't block on write
        }
        const remaining = MAX_STDERR_BYTES - sink.bytes;
        if (value.byteLength <= remaining) {
          sink.chunks.push(Buffer.from(value));
          sink.bytes += value.byteLength;
        } else {
          sink.chunks.push(Buffer.from(value.subarray(0, remaining)));
          sink.bytes += remaining;
          sink.truncated = true;
        }
      }
    } catch {
      // Reader was cancelled while a read was in flight — that's expected
      // when an orphaned grandchild still holds the pipe write end open.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  })();
  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      reader.cancel().catch(() => {
        // The reader may already be closed; safe to ignore.
      });
    },
  };
}

/**
 * Run a turn-hook command with a hard timeout and signal escalation.
 *
 * The command is invoked via `sh -c` so users can pass shell pipelines. Both
 * stdout and stderr are drained concurrently — without this, verbose checks
 * (cargo build, npm install) block on a full pipe buffer and never exit even
 * after SIGTERM.
 *
 * On timeout: SIGTERM is sent first; if the process is still alive after
 * KILL_GRACE_MS we escalate to SIGKILL. We always await `proc.exited` after
 * signaling so the caller knows the child is actually gone.
 */
export async function runTurnHookCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  /** Human label for the log lines ("Pre-turn hook", "Pre-accept gate", …). */
  label: string = 'Post-turn check',
  /**
   * Where the heartbeat and kill lines go. Defaults to the supervisor's own
   * logger, prefixed `[supervisor]`. The daemon passes its logger instead —
   * a daemon-side caller writing `[supervisor]` into the daemon log would
   * name a process that is not running.
   */
  logSink: TurnHookLogSink = SUPERVISOR_LOG_SINK,
): Promise<TurnHookResult> {
  const start = Date.now();
  const timeoutSecs = Math.round(timeoutMs / 1000);

  const proc = spawn(['sh', '-c', command], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // The configured timeout in lazy.toml controls our hard timeout below.
    // Disable the spawn wrapper's default 60s timeout for this long-running call.
    timeout: 0,
  });

  const stdoutSink = { chunks: [] as Buffer[], bytes: 0, truncated: false };
  const stderrSink = { chunks: [] as Buffer[], bytes: 0, truncated: false };
  const stdoutDrain = startDrain(proc.stdout, stdoutSink);
  const stderrDrain = startDrain(proc.stderr, stderrSink);

  let timedOut = false;
  let killSignal: 'SIGTERM' | 'SIGKILL' | undefined;

  const heartbeat = setInterval(() => {
    const elapsedSecs = Math.round((Date.now() - start) / 1000);
    logSink.info(
      `${label} still running (elapsed: ${elapsedSecs}s / timeout: ${timeoutSecs}s, pid: ${proc.pid})`,
    );
  }, HEARTBEAT_INTERVAL_MS);

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutTimer = setTimeout(() => {
    if (proc.exitCode !== null) return; // already exited in the same tick
    timedOut = true;
    killSignal = 'SIGTERM';
    logSink.warn(
      `${label} exceeded ${timeoutSecs}s; sending SIGTERM to pid ${proc.pid}`,
    );
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process may have just exited — fine, proc.exited will resolve.
    }
    killTimer = setTimeout(() => {
      if (proc.exitCode !== null) return;
      killSignal = 'SIGKILL';
      logSink.warn(
        `${label} did not exit ${KILL_GRACE_MS}ms after SIGTERM; sending SIGKILL to pid ${proc.pid}`,
      );
      try {
        proc.kill('SIGKILL');
      } catch {
        // Process is gone — proc.exited will resolve.
      }
    }, KILL_GRACE_MS);
  }, timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
  }

  // Give drains a brief window to flush whatever the pipe buffer still holds,
  // then cancel them. If the child spawned grandchildren that inherited the
  // pipe write end and outlived their parent (cargo → rustc is the canonical
  // case), the readers would otherwise block forever waiting for EOF.
  await Promise.race([
    Promise.all([stdoutDrain.done, stderrDrain.done]),
    new Promise(resolve => setTimeout(resolve, 500)),
  ]);
  stdoutDrain.cancel();
  stderrDrain.cancel();

  const elapsedMs = Date.now() - start;
  const stderr = collect(stderrSink, 'stderr');
  const stdout = collect(stdoutSink, 'stdout');

  if (timedOut) {
    return {
      exitCode: -2,
      stderr,
      stdout,
      timedOut: true,
      killSignal,
      elapsedMs,
    };
  }

  return {
    exitCode: proc.exitCode ?? -1,
    stderr,
    stdout,
    timedOut: false,
    elapsedMs,
  };
}

/** Decode one capped sink, prefixing a truncation notice when it overflowed. */
function collect(
  sink: { chunks: Buffer[]; bytes: number; truncated: boolean },
  label: 'stdout' | 'stderr',
): string {
  const text = Buffer.concat(sink.chunks).toString('utf-8');
  if (!sink.truncated) return text;
  return `[${label} truncated to ${MAX_STREAM_BYTES} bytes]\n${text}`;
}

/**
 * Render a hook/check's captured output for a human.
 *
 * stdout and stderr are kept as SEPARATE labelled blocks. They are two
 * independent streams read by two independent readers, so their relative
 * ordering is not recoverable — concatenating them would invent an interleave
 * that never happened, and a reader who trusted it would misread which message
 * caused which. Empty streams are omitted; if both are empty the caller gets a
 * short explicit "no output" marker rather than a blank block.
 */
export function formatHookOutput(result: Pick<TurnHookResult, 'stdout' | 'stderr'>): string {
  const blocks: string[] = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) blocks.push(`--- stdout ---\n${stdout}`);
  if (stderr) blocks.push(`--- stderr ---\n${stderr}`);
  if (blocks.length === 0) return '(no output on stdout or stderr)';
  return blocks.join('\n\n');
}
