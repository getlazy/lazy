/**
 * Watchdog timer for agent processes.
 *
 * Two independent guards, and the distinction between them is the whole point
 * of this module:
 *
 *  1. **No-progress guard** (runs while the agent is working). Kills the
 *     process only when it has stopped *advancing*. A working agent is never
 *     killed for taking a long time — there is no deadline measured from
 *     launch, from a commit, or from any other event.
 *
 *  2. **Wind-down guard** (runs only after the agent's final result is in
 *     hand). Once the summary has been captured, a CLI that will not exit is
 *     costing us a stuck task and nothing else, so a short bounded kill is
 *     safe. Killing here loses zero work.
 *
 * Guard 2 CANNOT be armed before the result is observed. That ordering is the
 * fix for the failure this module used to cause: turn-end was previously
 * inferred from a marker file written by `lazy_commit`, on the false premise
 * that committing means the turn is over. Agents commit mid-turn, and the
 * summary is produced after every tool call, so the fuse routinely killed
 * healthy turns and threw away the summary they were in the middle of writing.
 *
 * How "progress" is observed depends on the agent (see `Agent.activityStream()`):
 *
 *  - With an activity stream (Claude Code): stdout is parsed line by line and
 *    only *forward progress* events reset the timer. Periodic keep-alives do
 *    not — a wedged MCP tool call emits a heartbeat every 30s forever, so
 *    counting heartbeats as progress would make it immortal.
 *  - Without one (Cursor, qa-agent): any byte on stdout or stderr is treated
 *    as liveness, exactly as before. Cursor's `--print` hang bug is still
 *    caught by its 5-minute agent default.
 */

import { log } from './log';
import { spawn } from '../utils/spawn';
import { formatWatchdogMs } from '../utils/watchdog-turn';
import type { AgentActivityEvent, AgentActivityStream } from '../agent/activity-stream';
import type { AgentTokenUsage } from '../types';

/** Grace period between SIGTERM and SIGKILL (ms). */
const KILL_GRACE_MS = 5000;

/**
 * How much raw stdout to retain when an activity stream is parsing it.
 *
 * With `--output-format stream-json` stdout carries every tool result in full,
 * so buffering the whole turn can reach hundreds of MB. The result line is
 * retained separately and in full (that is the part we must never lose); this
 * bounded tail exists only for diagnostics on the failure paths.
 */
const STDOUT_TAIL_LIMIT_BYTES = 256 * 1024;

/**
 * Hard cap on a single unterminated line. Beyond this we cannot buffer it
 * safely; the partial is dropped (loudly) and counted as progress, since bytes
 * that large are unambiguously a tool result being delivered.
 */
const MAX_PENDING_LINE_BYTES = 64 * 1024 * 1024;

/**
 * How long to keep draining stdout/stderr after the agent process has exited.
 *
 * The agent's own children inherit its stdout, so a killed agent can leave a
 * grandchild (a tool call's subprocess) holding the pipe open indefinitely.
 * Waiting for EOF unconditionally would hang the supervisor forever on exactly
 * the wedged processes the guards exist to kill — the kill would land and
 * change nothing. On a healthy exit EOF arrives immediately, so this window is
 * never reached in practice.
 */
const STREAM_DRAIN_GRACE_MS = 2000;

export class WatchdogTimeoutError extends Error {
  durationMs: number;
  timeoutMs: number;
  /**
   * True when the agent's final result was already on the wire when the kill
   * landed. Part of the "did this turn capture anything?" question the retry
   * decision turns on (the other half is new commits — see
   * `decideWatchdogRetry` in retry-policy.ts).
   */
  capturedResult: boolean;
  /**
   * The full verdict: a result was on the wire, OR the turn added commits. Set by
   * runWork (which owns the turn's start SHA) before the error escapes; it is
   * what decided that this kill was not retried.
   */
  capturedWork: boolean;
  /** Relaunch attempts made within this turn before the error escaped. */
  attempts: number;
  /**
   * Tokens the agent reported before the kill, when any could be salvaged.
   * Set by the thrower (executeAgent/runWork) via `attachUsage`; the supervisor
   * puts it on the wire so the killed turn's cost lands on a turn record.
   */
  usage?: AgentTokenUsage;

  constructor(
    timeoutMs: number,
    durationMs: number,
    opts?: { progressBased?: boolean; capturedResult?: boolean; attempts?: number; usage?: AgentTokenUsage },
  ) {
    const window = formatWatchdogMs(timeoutMs);
    super(
      opts?.progressBased
        ? `Agent process killed by watchdog: no forward progress for ${window} ` +
          `([agent] watchdog_output_timeout_ms = ${timeoutMs})`
        : `Agent process killed by watchdog: no output for ${window} ` +
          `([agent] watchdog_output_timeout_ms = ${timeoutMs})`
    );
    this.name = 'WatchdogTimeoutError';
    this.timeoutMs = timeoutMs;
    this.durationMs = durationMs;
    this.capturedResult = opts?.capturedResult ?? false;
    this.capturedWork = opts?.capturedResult ?? false;
    this.attempts = opts?.attempts ?? 1;
    this.usage = opts?.usage;
  }
}

/**
 * Thrown when the agent process was killed during wind-down — it emitted its
 * final result but did not exit within `wind_down_timeout_ms` — AND the
 * captured result could not be parsed into a response.
 *
 * The parseable case is deliberately NOT an error: the supervisor returns the
 * captured summary as a successful turn, because a kill after the result costs
 * nothing but the CLI's exit. This error is the residual case where the result
 * we captured is unusable.
 *
 * Non-retriable, same as WatchdogTimeoutError: the agent's work is already on
 * disk, so retrying would either repeat work or wedge again the same way.
 */
export class GracefulExitTimeoutError extends Error {
  durationMs: number;
  timeoutMs: number;
  /** ms between the final result being observed and the kill. */
  elapsedSinceSignalMs: number;
  /**
   * Agent session id, when recoverable — from `--resume` (the supervisor
   * already knew it), from the stream's session_start event, or by discovering
   * the JSONL file the agent writes (same path `lazy watch` uses).
   *
   * INVARIANT: GracefulExitTimeoutError must carry session_id whenever it is
   * recoverable, so the human can `lazy unblock` after the kill instead of
   * orphaning the conversation.
   */
  sessionId?: string;
  /**
   * Tokens the agent reported in the result it emitted before the kill. This
   * error means that result was UNPARSEABLE as a response — but an unparseable
   * response can still carry a readable `usage` object, and those tokens were
   * really spent. See src/supervisor/usage.ts.
   */
  usage?: AgentTokenUsage;

  constructor(opts: {
    timeoutMs: number;
    durationMs: number;
    elapsedSinceSignalMs: number;
    sessionId?: string;
    usage?: AgentTokenUsage;
  }) {
    super(
      `Killed ${Math.round(opts.elapsedSinceSignalMs / 1000)}s after the agent emitted its final ` +
      `result — the process did not exit within the ${Math.round(opts.timeoutMs / 1000)}s wind-down ` +
      `window, and the captured result could not be parsed`,
    );
    this.name = 'GracefulExitTimeoutError';
    this.timeoutMs = opts.timeoutMs;
    this.durationMs = opts.durationMs;
    this.elapsedSinceSignalMs = opts.elapsedSinceSignalMs;
    this.sessionId = opts.sessionId;
    this.usage = opts.usage;
  }
}

export interface WatchdogResult {
  /**
   * Agent stdout. Complete when no activity stream is parsing it; a bounded
   * tail (see STDOUT_TAIL_LIMIT_BYTES) when one is — use `resultLine` for the
   * response in that case.
   */
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the no-progress guard fired. */
  killedByWatchdog: boolean;
  /** True when the wind-down guard fired (only possible after a result). */
  killedDuringWindDown: boolean;
  /** ms between the result being observed and the wind-down kill. */
  windDownElapsedMs?: number;
  /**
   * The agent's final result event, verbatim — retained in full and
   * independently of the stdout tail, so the summary survives both truncation
   * and a wind-down kill. Only set when an activity stream saw one.
   */
  resultLine?: string;
  /** Session id observed in the stream, if the agent reports one. */
  sessionId?: string;
  /**
   * The agent's session-start event, verbatim as parsed. Carried out so the
   * caller can inspect what the agent reported about itself (which MCP servers
   * connected, which tools it loaded) without re-parsing the stream.
   */
  sessionStartEvent?: AgentActivityEvent;
  /**
   * Set when `abortOnSessionStart` asked for the run to be killed, and why.
   * Distinct from the two guards: the run was not slow, it was launched into a
   * state the caller declared unusable.
   */
  abortReason?: string;
}

/**
 * Resolve the effective no-progress timeout.
 * Config value of 0 means "use agent default". Agent default is also 0 for
 * claude-code, so users can disable the guard by setting no_progress_timeout_ms = 0.
 */
export function resolveWatchdogTimeout(configValue: number, agentDefault: number): number {
  return configValue !== 0 ? configValue : agentDefault;
}

/**
 * Spawn a subprocess under the two guards described at the top of this file.
 *
 * When timeoutMs is 0, the no-progress guard is disabled and the process may
 * run indefinitely. When `activityStream` is omitted, progress means "any byte
 * of output". When `windDownTimeoutMs` is 0 or omitted, no wind-down kill
 * happens and the process is simply awaited.
 */
export async function execWithWatchdog(
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /**
     * Parser for the agent's incremental stdout. When supplied, only forward
     * progress events reset the no-progress timer, and the agent's final
     * result is detected the moment it is emitted.
     */
    activityStream?: AgentActivityStream | null;
    /**
     * How long to wait for the process to exit AFTER its final result was
     * observed, before killing it (SIGTERM→SIGKILL). Requires an activity
     * stream — without one there is no way to know the result has landed, and
     * arming a timer earlier is precisely the bug this design removes.
     * 0 or omitted disables the wind-down guard.
     */
    windDownTimeoutMs?: number;
    /**
     * Inspect the agent's session-start event and, by returning a reason, kill
     * the run immediately.
     *
     * This is for launch-state problems the agent itself reveals on line 1 —
     * today: a turn that got none of its lazy MCP tools. Such a turn cannot
     * produce trustworthy work, so letting it run to completion only burns
     * tokens and produces a plausible-looking result nobody should trust. The
     * kill deliberately reuses the same SIGTERM→SIGKILL path as the guards
     * rather than inventing a second one.
     *
     * Kept as a callback so the watchdog stays agnostic about what "usable"
     * means; the lazy-specific judgement lives in `supervisor/mcp-verify.ts`.
     */
    abortOnSessionStart?: (event: AgentActivityEvent) => string | null;
  },
): Promise<WatchdogResult> {
  const { cwd, env, timeoutMs, activityStream, windDownTimeoutMs, abortOnSessionStart } = opts;
  const enabled = timeoutMs > 0;
  const windDownEnabled = !!activityStream && (windDownTimeoutMs ?? 0) > 0;

  if (enabled) {
    log(
      `[watchdog] Enabled: ${activityStream ? 'no-progress' : 'no-output'} timeout ${timeoutMs}ms`
    );
  }
  if (windDownEnabled) {
    log(`[watchdog] Wind-down guard armed on result: timeout ${windDownTimeoutMs}ms`);
  }

  const proc = spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    timeout: 0, // Long-running: this function has its own progress-based guards
  });

  const stderrChunks: Buffer[] = [];
  let killedByWatchdog = false;
  let killedDuringWindDown = false;
  let windDownElapsedMs: number | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let windDownTimer: ReturnType<typeof setTimeout> | null = null;
  let resultSeenAt: number | null = null;
  let resultLine: string | undefined;
  let sessionId: string | undefined;
  let sessionStartEvent: AgentActivityEvent | undefined;
  let abortReason: string | undefined;
  /** Tool calls emitted but not yet completed — diagnostics for a kill message. */
  const inFlightTools = new Map<string, string>();
  const launchTime = Date.now();

  // Bounded stdout retention. Without a parser we keep everything (the caller
  // has no other way to get the response); with one, only a tail.
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  function retainStdout(chunk: Buffer) {
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.length;
    if (!activityStream) return;
    while (stdoutChunks.length > 1 && stdoutBytes > STDOUT_TAIL_LIMIT_BYTES) {
      stdoutBytes -= stdoutChunks.shift()!.length;
    }
  }

  function clearTimers() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (windDownTimer) {
      clearTimeout(windDownTimer);
      windDownTimer = null;
    }
  }

  function scheduleSigkill(reason: string) {
    graceTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        log(`[watchdog] Process still alive after ${KILL_GRACE_MS}ms grace period (${reason}). Sending SIGKILL.`);
        proc.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  /** Kill because the caller declared the run's launch state unusable. */
  function killForAbort(reason: string) {
    if (abortReason) return;
    abortReason = reason;
    log(`[watchdog] Aborting the run at session start: ${reason}. Sending SIGTERM.`);
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    proc.kill('SIGTERM');
    scheduleSigkill('session-start abort');
  }

  function killForNoProgress() {
    if (killedDuringWindDown || abortReason) return;
    killedByWatchdog = true;
    const elapsed = Date.now() - launchTime;
    const stuck = inFlightTools.size > 0
      ? ` Tool call(s) still in flight: ${[...inFlightTools.values()].join(', ')}.`
      : '';
    log(
      `[watchdog] No ${activityStream ? 'forward progress' : 'output'} for ${timeoutMs}ms ` +
      `(elapsed: ${elapsed}ms).${stuck} Sending SIGTERM.`
    );
    proc.kill('SIGTERM');
    scheduleSigkill('no-progress guard');
  }

  function killForWindDown() {
    // If the no-progress guard already started killing, don't double-kill.
    if (killedByWatchdog || abortReason) return;
    killedDuringWindDown = true;
    windDownElapsedMs = resultSeenAt !== null ? Date.now() - resultSeenAt : (windDownTimeoutMs ?? 0);
    log(
      `[watchdog] Agent emitted its final result ${Math.round(windDownElapsedMs / 1000)}s ago but ` +
      `has not exited. Summary is captured; sending SIGTERM.`,
    );
    proc.kill('SIGTERM');
    scheduleSigkill('wind-down guard');
  }

  function resetWatchdog() {
    if (!enabled) return;
    if (killedByWatchdog || killedDuringWindDown || abortReason) return; // Don't reset after we've started killing
    // Once the result has landed, the wind-down guard owns the process. Leaving
    // the no-progress timer running would just race it to the same kill.
    if (resultSeenAt !== null) return;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(killForNoProgress, timeoutMs);
  }

  /**
   * Feed one parsed stream event to the guards.
   *
   * INVARIANT: `heartbeat` does NOT reset the no-progress timer. It proves the
   * process is alive, not that the turn is advancing — and a wedged MCP tool
   * call heartbeats forever (verified empirically against Claude Code 2.1.220).
   * Treating it as progress would remove the only backstop against a
   * permanently stuck tool call.
   */
  function onActivity(line: string) {
    const event = activityStream!.parseLine(line);
    if (!event) return;

    switch (event.kind) {
      case 'heartbeat':
        return; // liveness only — see the invariant above
      case 'session_start':
        if (event.sessionId) sessionId = event.sessionId;
        sessionStartEvent = event;
        if (abortOnSessionStart) {
          const reason = abortOnSessionStart(event);
          if (reason) {
            killForAbort(reason);
            return; // Killing, not advancing — do not reset the liveness timer.
          }
        }
        break;
      case 'tool_start':
        if (event.toolUseId) inFlightTools.set(event.toolUseId, event.toolName ?? event.toolUseId);
        break;
      case 'tool_end':
        if (event.toolUseId) inFlightTools.delete(event.toolUseId);
        break;
      case 'result':
        if (event.sessionId) sessionId = event.sessionId;
        if (event.raw) resultLine = event.raw;
        if (resultSeenAt === null) {
          resultSeenAt = Date.now();
          // From here the summary is safe. Stop the no-progress timer and, if
          // configured, start the bounded wind-down.
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
          if (windDownEnabled) {
            windDownTimer = setTimeout(killForWindDown, windDownTimeoutMs!);
          }
        }
        return;
      default:
        break;
    }
    resetWatchdog();
  }

  // Start the no-progress timer.
  resetWatchdog();

  // Readers are hoisted so the post-exit drain can cancel them (see
  // STREAM_DRAIN_GRACE_MS) instead of waiting on an EOF that may never come.
  let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // Stream stdout
  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    stdoutReader = reader;
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        retainStdout(Buffer.from(value));

        if (!activityStream) {
          resetWatchdog();
          continue;
        }

        pending += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          onActivity(line);
        }
        if (pending.length > MAX_PENDING_LINE_BYTES) {
          // Cannot buffer this line; drop it rather than exhaust memory. Bytes
          // this large are a tool result being delivered, so count it as
          // progress — but say so, since a dropped line is real data loss.
          log(
            `[watchdog] Dropping an unterminated stdout line over ${MAX_PENDING_LINE_BYTES} bytes ` +
            `— it cannot be parsed as an activity event.`
          );
          pending = '';
          resetWatchdog();
        }
      }
      // Trailing line without a newline (the process exited mid-line).
      if (activityStream && pending.trim()) onActivity(pending);
    } finally {
      reader.releaseLock();
    }
  })();

  // Stream stderr.
  //
  // With an activity stream, stderr is diagnostic chatter (CLI warnings), not
  // evidence the turn advanced, so it deliberately does not reset the
  // no-progress timer. Without one, any output is all the liveness we have.
  const stderrDone = (async () => {
    const reader = proc.stderr.getReader();
    stderrReader = reader;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(Buffer.from(value));
        if (!activityStream) resetWatchdog();
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Wait for the process, then drain its output on a bounded window.
  await proc.exited;

  const streamsDone = Promise.all([stdoutDone, stderrDone]);
  const drained = await Promise.race([
    streamsDone.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), STREAM_DRAIN_GRACE_MS)),
  ]);

  if (!drained) {
    // A surviving grandchild still holds the pipe. Everything the agent itself
    // wrote is already buffered — including the result line — so abandon the
    // readers rather than block the supervisor forever.
    log(
      `[watchdog] Agent exited but its output pipes are still held open ` +
      `(a child process outlived it). Abandoning the stream after ${STREAM_DRAIN_GRACE_MS}ms.`
    );
    // cancel() rejects only if the stream is already errored or closed, which
    // is the outcome we want anyway — log it rather than mask a real failure.
    const cancel = async (which: string, reader: typeof stdoutReader) => {
      try {
        await reader?.cancel();
      } catch (err) {
        log(`[watchdog] Cancelling ${which} reader: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await Promise.all([cancel('stdout', stdoutReader), cancel('stderr', stderrReader)]);
    await streamsDone.catch(err => {
      log(`[watchdog] Stream reader ended with: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  clearTimers();

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');
  const exitCode = proc.exitCode ?? 1;

  return {
    stdout,
    stderr,
    exitCode,
    killedByWatchdog,
    killedDuringWindDown,
    windDownElapsedMs,
    resultLine,
    sessionId,
    sessionStartEvent,
    abortReason,
  };
}
