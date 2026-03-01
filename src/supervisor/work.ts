/**
 * Work phase.
 *
 * Wraps the existing Claude Code launch/capture logic. Runs Claude Code
 * with the task prompt and captures the JSON response.
 *
 * This is the supervisor's private implementation detail for running the
 * coding agent. Swapping agents requires changes only here.
 */

import type { RetryError } from '../protocol/types';
import { hasCommand } from '../protocol/io';
import { log, logError } from './log';

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
export function isPromptTooLongError(errorMessage: string): boolean {
  return errorMessage.includes('Prompt is too long');
}

/**
 * Check whether an error message indicates the session ID is not found.
 * This happens when resuming a session that doesn't exist in the local Claude
 * config — e.g. when switching from Docker mode (sandboxed .claude/) to
 * host-process mode (real ~/.claude/), or after a clean install.
 * Retrying with the same session ID will always fail; we must start fresh.
 */
export function isSessionNotFoundError(errorMessage: string): boolean {
  return errorMessage.includes('No conversation found with session ID');
}

/**
 * Execute Claude Code once and return the result or throw on error.
 */
async function executeClaudeCode(
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
): Promise<WorkResult> {
  const claudeArgs = ['claude', '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];

  if (systemPrompt) {
    claudeArgs.push('--append-system-prompt', systemPrompt);
  }

  if (claudeSessionId) {
    claudeArgs.push('--resume', claudeSessionId);
  }

  if (modelId) {
    claudeArgs.push('--model', modelId);
  }

  const launchTime = Date.now();

  const proc = Bun.spawn(claudeArgs, {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env as Record<string, string>,
  });

  const outputPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const [output, stderr, exitCode] = await Promise.all([
    outputPromise,
    stderrPromise,
    proc.exited,
  ]);

  const runtime = Date.now() - launchTime;

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

  let parsed: WorkResult;
  try {
    parsed = JSON.parse(output) as WorkResult;
  } catch (err) {
    throw new Error(`Failed to parse Claude Code JSON output: ${err instanceof Error ? err.message : err}`);
  }

  if (!parsed.result || !parsed.session_id) {
    throw new Error('Claude Code response missing required fields (result, session_id)');
  }

  return parsed;
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
 * @param worktreePath Working directory
 * @param prompt Full prompt to send to Claude Code
 * @param systemPrompt Optional static system prompt (passed as --append-system-prompt)
 * @param modelId Optional model override
 * @param claudeSessionId Optional session ID to resume
 * @param protocolDir Protocol directory for checking new commands
 * @param onRetryStateChange Callback when retry state changes
 * @param _executeOverride Optional override for executeClaudeCode (for testing)
 * @returns Parsed Claude Code JSON response
 */
export async function runWork(
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
  protocolDir?: string,
  onRetryStateChange?: (state: RetryState | null) => void,
  _executeOverride?: (worktreePath: string, prompt: string, systemPrompt?: string, modelId?: string, claudeSessionId?: string) => Promise<WorkResult>,
): Promise<WorkResult> {
  const execute = _executeOverride ?? executeClaudeCode;
  let currentSessionId = claudeSessionId;

  let retryState: RetryState = {
    count: 0,
    errors: [],
    consecutiveFastFails: 0,
  };

  while (true) {
    const isRetry = retryState.count > 0;
    log(`[work] ${isRetry ? `Retry ${retryState.count}: ` : ''}Running Claude Code${currentSessionId ? ' (resume)' : ''}...`);

    const launchTime = Date.now();

    try {
      const result = await execute(worktreePath, prompt, systemPrompt, modelId, currentSessionId);

      // Success! Reset retry state
      if (retryState.count > 0) {
        log(`[work] Success after ${retryState.count} retries.`);
        if (onRetryStateChange) {
          onRetryStateChange(null);
        }
      } else {
        log('[work] Claude Code completed. Parsing response...');
      }

      log(`[work] Response captured. Session: ${result.session_id.substring(0, 8)}...`);
      return result;

    } catch (err) {
      const runtime = Date.now() - launchTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      logError(`[work] Claude Code failed after ${runtime}ms: ${errorMessage}`);

      // Handle 'Prompt is too long' as a non-retriable session error.
      // Clear the session so the next attempt starts fresh (turn history
      // injection provides sufficient context for sessionless starts).
      if (isPromptTooLongError(errorMessage)) {
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
      if (isSessionNotFoundError(errorMessage) && currentSessionId) {
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
