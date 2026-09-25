/**
 * Acceptance gate — the mechanical check that runs at accept.
 *
 * `runAcceptanceGate` runs SUPERVISOR-side, in the gate's own ephemeral
 * container. It runs the configured gate commands in the task's worktree
 * as the AUTHORITATIVE merge gate: the agent may have fixed and committed,
 * but the agent cannot self-certify — this independent run decides
 * pass/fail, so a failing suite can never merge. No agent runs here and no
 * turn is recorded; the outcome rides the response's `accept_gate` field
 * straight to the daemon's accept path.
 */

import { runTurnHookCommand, formatHookOutput } from './post-turn-check';
import { truncateLog } from '../utils/log-truncate';
import { log, logWarn } from './log';

/** Default per-command timeout for the gate (seconds). */
export const DEFAULT_PRE_ACCEPT_TIMEOUT_SECS = 600;

export interface PreAcceptGateResult {
  passed: boolean;
  /** The first command that exited non-zero (undefined when passed). */
  failedCommand?: string;
  /** Exit code of the failed command (-1 exec error, -2 timeout). */
  exitCode?: number;
  /** Captured output of the failed command (truncated). */
  output?: string;
}

/**
 * Run the gate commands in order, stopping at the first non-zero exit. This is
 * the authoritative pass/fail decision for the merge — run mechanically in the
 * gate's own ephemeral container, with no agent turn before it to fix anything.
 *
 * An empty command list passes trivially (the daemon skips launching a
 * container for it entirely; this is the belt behind that decision).
 */
export async function runAcceptanceGate(
  commands: string[],
  worktreePath: string,
  timeoutSecs: number = DEFAULT_PRE_ACCEPT_TIMEOUT_SECS,
): Promise<PreAcceptGateResult> {
  if (commands.length === 0) {
    log('[accept-gate] No gate commands configured — gate passes trivially');
    return { passed: true };
  }

  for (const command of commands) {
    log(`[accept-gate] Running gate command: "${command}" (timeout: ${timeoutSecs}s)`);
    try {
      const result = await runTurnHookCommand(
        command,
        worktreePath,
        timeoutSecs * 1000,
        'Acceptance gate',
      );
      if (result.timedOut) {
        const output = `Command timed out after ${timeoutSecs}s (killed with ${result.killSignal ?? 'SIGTERM'} after ${result.elapsedMs}ms)\n\n${truncateLog(formatHookOutput(result))}`;
        logWarn(`[accept-gate] Gate command timed out: "${command}"`);
        return { passed: false, failedCommand: command, exitCode: -2, output };
      }
      if (result.exitCode !== 0) {
        logWarn(`[accept-gate] Gate command failed (exit ${result.exitCode}): "${command}"`);
        return {
          passed: false,
          failedCommand: command,
          exitCode: result.exitCode,
          output: truncateLog(formatHookOutput(result)),
        };
      }
      log(`[accept-gate] Gate command passed: "${command}" (${result.elapsedMs}ms)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[accept-gate] Gate command failed to execute: "${command}": ${message}`);
      return { passed: false, failedCommand: command, exitCode: -1, output: message };
    }
  }

  return { passed: true };
}
