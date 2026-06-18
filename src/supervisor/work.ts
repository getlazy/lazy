/**
 * Work phase.
 *
 * Wraps the agent launch/capture logic. Runs the agent with the task
 * prompt and captures the JSON response.
 *
 * This is the supervisor's private implementation detail for running the
 * coding agent. The agent abstraction (src/agent/) handles CLI arg building,
 * response parsing, and error detection. Swapping agents requires only
 * changing the agent_id in config.
 */

import type { RetryError } from '../protocol/types';
import { hasCommand } from '../protocol/io';
import { log, logError } from './log';
import type { Agent } from '../agent/interface';
import type { Runner } from '../runner/types';
import { execWithWatchdog, WatchdogTimeoutError, GracefulExitTimeoutError } from './watchdog';
import { clearTurnEndSignal, turnEndSignalPath } from '../protocol/turn-end-signal';
import { findLatestSessionFile } from '../agent/session-discovery';

export { WatchdogTimeoutError, GracefulExitTimeoutError };

export interface WorkResult {
  result: string;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Structured error from a Claude Code crash (exit code != 0) */
export class CrashError extends Error {
  exitCode: number;
  stderr: string;
  stdoutError: string | undefined;
  durationMs: number;

  constructor(opts: { message: string; exitCode: number; stderr: string; stdoutError?: string; durationMs: number }) {
    super(opts.message);
    this.name = 'CrashError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdoutError = opts.stdoutError;
    this.durationMs = opts.durationMs;
  }
}

export interface RetryState {
  count: number;
  errors: RetryError[];
  consecutiveFastFails: number;
  lastLaunchTime?: number;
}

/** Check whether an error message indicates the prompt/session is too large. */
function isPromptTooLongError(agent: Agent, errorMessage: string): boolean {
  return agent.isPromptTooLongError(errorMessage);
}

/**
 * Check whether an error message indicates the session ID is not found.
 * This happens when resuming a session that doesn't exist in the local agent
 * config — e.g. when switching from Docker mode (sandboxed config) to
 * host-process mode (real config), or after a clean install.
 * Retrying with the same session ID will always fail; we must start fresh.
 */
function isSessionNotFoundError(agent: Agent, errorMessage: string): boolean {
  return agent.isSessionNotFoundError(errorMessage);
}

/**
 * Execute the agent once and return the result or throw on error.
 * When watchdogTimeoutMs > 0, monitors output and kills hung processes.
 */
async function executeAgent(
  agent: Agent,
  runner: Runner,
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
  watchdogTimeoutMs?: number,
  effort?: string,
  permissionMode?: 'plan' | 'default',
  protocolDir?: string,
  gracefulExitTimeoutMs?: number,
): Promise<WorkResult> {
  const claudeArgs = agent.buildExecArgs({
    prompt,
    systemPrompt,
    modelId,
    sessionId: claudeSessionId,
    dangerouslySkipPermissions: true,
    effort,
    permissionMode,
  });

  const launchTime = Date.now();
  const effectiveTimeout = watchdogTimeoutMs ?? 0;
  const effectiveGracefulMs = gracefulExitTimeoutMs ?? 0;
  const markerPath = protocolDir ? turnEndSignalPath(protocolDir) : undefined;

  // Clear any stale end-of-turn marker from a previous turn so the
  // graceful-exit watcher doesn't fire on startup.
  if (protocolDir) {
    await clearTurnEndSignal(protocolDir);
  }

  const { stdout: output, stderr, exitCode, killedByWatchdog, killedByGracefulExit, gracefulExitElapsedMs } = await execWithWatchdog(
    claudeArgs,
    {
      cwd: worktreePath,
      env: process.env as Record<string, string>,
      timeoutMs: effectiveTimeout,
      gracefulExitMarkerPath: markerPath,
      gracefulExitTimeoutMs: effectiveGracefulMs,
    },
  );

  const runtime = Date.now() - launchTime;

  // Watchdog kill is a specific non-retriable error
  if (killedByWatchdog) {
    throw new WatchdogTimeoutError(effectiveTimeout, runtime);
  }

  if (killedByGracefulExit) {
    const recoveredSessionId = await recoverSessionIdForGracefulExit(
      runner,
      worktreePath,
      claudeSessionId,
      launchTime,
    );
    throw new GracefulExitTimeoutError({
      timeoutMs: effectiveGracefulMs,
      durationMs: runtime,
      elapsedSinceSignalMs: gracefulExitElapsedMs ?? effectiveGracefulMs,
      markerPath: markerPath ?? '',
      sessionId: recoveredSessionId,
    });
  }

  if (exitCode !== 0) {
    // Try to extract error from stdout JSON (Claude Code puts errors in stdout sometimes)
    let stdoutError: string | undefined;
    if (output.trim()) {
      try {
        const parsed = JSON.parse(output);
        // Claude Code may return { error: { message: "..." } } or { error: "..." }
        if (parsed.error) {
          stdoutError = typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error.message ?? JSON.stringify(parsed.error);
        } else if (parsed.result) {
          stdoutError = typeof parsed.result === 'string' ? parsed.result : undefined;
        }
      } catch {
        // stdout isn't JSON — capture last few lines as-is
        const trimmed = output.trim();
        if (trimmed.length > 0) {
          stdoutError = trimmed.split('\n').slice(-5).join('\n').substring(0, 500);
        }
      }
    }

    const stderrTail = stderr ? stderr.trim().split('\n').slice(-10).join('\n').substring(0, 500) : '';
    const errorMsg = stdoutError ?? stderrTail ?? `exit code ${exitCode}`;

    throw new CrashError({
      message: errorMsg,
      exitCode,
      stderr: stderrTail,
      stdoutError,
      durationMs: runtime,
    });
  }

  // Delegate parsing and validation to the agent.
  // Wrap in try-catch so parse/validation errors become CrashErrors with
  // proper metadata. Without this, a throw from parseResponse would propagate
  // as a plain Error and the retry loop in runWork would retry it with backoff
  // — but parse failures (exitCode 0, garbled output) are not transient and
  // retrying won't help.
  try {
    return agent.parseResponse(output, { workingDir: worktreePath }) as WorkResult;
  } catch (parseErr) {
    throw new CrashError({
      message: parseErr instanceof Error ? parseErr.message : String(parseErr),
      exitCode: 0,
      stderr: '',
      stdoutError: output.substring(0, 500),
      durationMs: Date.now() - launchTime,
    });
  }
}

/**
 * Recover the Claude session id after a graceful-exit kill, so the human can
 * `lazy unblock` to resume the conversation instead of orphaning it.
 *
 * INVARIANT: GracefulExitTimeoutError must carry session_id whenever it is
 * recoverable. Two paths:
 *
 *   1. Resumed turn — the daemon already passed `agent_session_id` to the
 *      supervisor, which forwarded it as `--resume`. We have it locally.
 *   2. Fresh first turn — Claude writes `<session-id>.jsonl` into the runner's
 *      agent session project dir (`runner.agentSessionProjectDir`) from the
 *      moment it starts (same path `lazy watch` discovers). Pick the file
 *      modified after `launchTime` so we ignore stale sessions from previous
 *      turns.
 *
 * Returns undefined only when neither path yields anything (e.g. claude died
 * before writing any jsonl). The caller logs that case so it is debuggable.
 */
export async function recoverSessionIdForGracefulExit(
  runner: Runner,
  worktreePath: string,
  claudeSessionId: string | undefined,
  launchTime: number,
): Promise<string | undefined> {
  if (claudeSessionId) return claudeSessionId;
  try {
    const info = await findLatestSessionFile(runner.agentSessionProjectDir(worktreePath), launchTime);
    if (info) {
      log(`[work] Recovered session id ${info.sessionId.substring(0, 8)} from ${info.path} after graceful-exit kill.`);
      return info.sessionId;
    }
    log('[work] No JSONL session file found in worktree after graceful-exit kill — response will omit session_id (agent likely died before writing).');
    return undefined;
  } catch (err) {
    log(`[work] Failed to discover session id after graceful-exit kill: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Add or update an error in the deduplicated error log.
 */
function recordError(errors: RetryError[], errorMessage: string): RetryError[] {
  const now = new Date().toISOString();
  const existing = errors.find(e => e.message === errorMessage);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    return errors;
  }

  const newError: RetryError = {
    message: errorMessage,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  };

  const updated = [...errors, newError];

  // Keep only last 10 errors (FIFO eviction)
  if (updated.length > 10) {
    return updated.slice(updated.length - 10);
  }

  return updated;
}

/**
 * Calculate backoff delay: 30s, 60s, 120s, 240s, then cap at 300s.
 */
function getBackoffDelay(retryCount: number): number {
  const delays = [30000, 60000, 120000, 240000];
  if (retryCount < delays.length) {
    return delays[retryCount];
  }
  return 300000; // 5 minutes max
}

/**
 * Sleep with periodic checks for new commands (every 2 seconds).
 * Returns true if a new command arrived, false if timeout completed.
 */
async function sleepWithCommandCheck(protocolDir: string, delayMs: number): Promise<boolean> {
  const checkIntervalMs = 2000;
  const endTime = Date.now() + delayMs;

  while (Date.now() < endTime) {
    if (hasCommand(protocolDir)) {
      log('[work] New command detected during retry backoff. Canceling retry.');
      return true;
    }
    await Bun.sleep(Math.min(checkIntervalMs, endTime - Date.now()));
  }

  return false;
}

/**
 * Run the work phase: execute Claude Code with the given prompt.
 * Automatically retries on failure with exponential backoff.
 *
 * @param agent The agent to use for execution
 * @param runner The runner — authoritative for where the agent's session log lives
 * @param worktreePath Working directory
 * @param prompt Full prompt to send to the agent
 * @param systemPrompt Optional static system prompt
 * @param modelId Optional model override
 * @param claudeSessionId Optional session ID to resume
 * @param protocolDir Protocol directory for checking new commands
 * @param onRetryStateChange Callback when retry state changes
 * @param _executeOverride Optional override for executeAgent (for testing)
 * @param watchdogTimeoutMs Output watchdog timeout in ms (0 = disabled)
 * @returns Parsed agent JSON response
 */
export async function runWork(
  agent: Agent,
  runner: Runner,
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
  protocolDir?: string,
  onRetryStateChange?: (state: RetryState | null) => void,
  _executeOverride?: (worktreePath: string, prompt: string, systemPrompt?: string, modelId?: string, claudeSessionId?: string, effort?: string, permissionMode?: 'plan' | 'default') => Promise<WorkResult>,
  watchdogTimeoutMs?: number,
  effort?: string,
  permissionMode?: 'plan' | 'default',
  gracefulExitTimeoutMs?: number,
): Promise<WorkResult> {
  const execute = _executeOverride
    ? _executeOverride
    : (wt: string, p: string, sp?: string, mid?: string, sid?: string, eff?: string, pm?: 'plan' | 'default') =>
        executeAgent(agent, runner, wt, p, sp, mid, sid, watchdogTimeoutMs, eff, pm, protocolDir, gracefulExitTimeoutMs);
  let currentSessionId = claudeSessionId;

  let retryState: RetryState = {
    count: 0,
    errors: [],
    consecutiveFastFails: 0,
  };

  while (true) {
    const isRetry = retryState.count > 0;
    log(`[work] ${isRetry ? `Retry ${retryState.count}: ` : ''}Running ${agent.id}${currentSessionId ? ' (resume)' : ''}...`);

    const launchTime = Date.now();

    try {
      const result = await execute(worktreePath, prompt, systemPrompt, modelId, currentSessionId, effort, permissionMode);

      // Success! Reset retry state
      if (retryState.count > 0) {
        log(`[work] Success after ${retryState.count} retries.`);
        if (onRetryStateChange) {
          onRetryStateChange(null);
        }
      } else {
        log(`[work] ${agent.id} completed. Parsing response...`);
      }

      log(`[work] Response captured. Session: ${result.session_id.substring(0, 8)}...`);
      return result;

    } catch (err) {
      const runtime = Date.now() - launchTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      logError(`[work] ${agent.id} failed after ${runtime}ms: ${errorMessage}`);

      // INVARIANT: Watchdog kills are never retried. The agent process was
      // hung (no output for the configured timeout). Retrying would likely
      // just hang again. Surface the error so the turn is marked as failed.
      if (err instanceof WatchdogTimeoutError) {
        throw err;
      }

      // INVARIANT: Graceful-exit kills are never retried. The agent had
      // signalled end-of-turn (lazy_commit) — its work is already on disk.
      // Re-running the agent would either redo committed work or hang on the
      // same stuck tool call that caused the kill in the first place.
      if (err instanceof GracefulExitTimeoutError) {
        throw err;
      }

      // Handle 'Prompt is too long' as a non-retriable session error.
      // Clear the session so the next attempt starts fresh (turn history
      // injection provides sufficient context for sessionless starts).
      if (isPromptTooLongError(agent, errorMessage)) {
        if (currentSessionId) {
          // Was resuming a session — clear it and retry fresh immediately
          log('[work] Session too large, starting fresh session with turn history.');
          currentSessionId = undefined;

          // Record the error but don't count toward crash-loop — this is expected
          retryState.errors = recordError(retryState.errors, errorMessage);
          retryState.count++;
          retryState.lastLaunchTime = launchTime;
          // Reset fast-fail counter since this isn't a transient crash
          retryState.consecutiveFastFails = 0;

          if (onRetryStateChange) {
            onRetryStateChange(retryState);
          }

          // Retry immediately — no backoff needed for session reset
          continue;
        }

        // Already running without a session — prompt/turn-history itself is too large.
        // Retrying won't help since the prompt won't get shorter.
        logError('[work] Prompt too long even without session resume. Cannot recover.');
        throw new Error('Prompt is too long even without session resume. The prompt or turn history may need to be truncated.');
      }

      // Handle 'No conversation found with session ID' — the session doesn't exist
      // in the local Claude config. This is unrecoverable with the same session ID;
      // drop it and start fresh with the turn history prompt instead.
      if (isSessionNotFoundError(agent, errorMessage) && currentSessionId) {
        log('[work] Session not found, starting fresh session with turn history.');
        currentSessionId = undefined;

        retryState.errors = recordError(retryState.errors, errorMessage);
        retryState.count++;
        retryState.lastLaunchTime = launchTime;
        retryState.consecutiveFastFails = 0;

        if (onRetryStateChange) {
          onRetryStateChange(retryState);
        }

        // Retry immediately — no backoff needed for session reset
        continue;
      }

      // Track fast failures for crash loop detection
      if (runtime < 10000) {
        retryState.consecutiveFastFails++;
      } else {
        retryState.consecutiveFastFails = 0;
      }

      // Fast-fail detection: 3 consecutive crashes under 10s = crash loop
      if (retryState.consecutiveFastFails >= 3) {
        logError('[work] Detected crash loop (3 fast failures). Stopping retries.');
        throw new Error(`Crash loop detected: ${errorMessage}`);
      }

      // Record the error
      retryState.errors = recordError(retryState.errors, errorMessage);
      retryState.count++;
      retryState.lastLaunchTime = launchTime;

      // Notify caller of retry state change
      if (onRetryStateChange) {
        onRetryStateChange(retryState);
      }

      // Calculate backoff delay
      const delay = getBackoffDelay(retryState.count - 1);
      log(`[work] Retrying in ${delay / 1000}s (retry ${retryState.count})...`);

      // Sleep with periodic checks for new commands
      if (protocolDir) {
        const newCommandArrived = await sleepWithCommandCheck(protocolDir, delay);
        if (newCommandArrived) {
          throw new Error('Retry canceled: new command arrived');
        }
      } else {
        await Bun.sleep(delay);
      }
    }
  }
}
