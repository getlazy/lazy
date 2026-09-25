/**
 * EXPERIMENTAL "low-high loop" — two-phase work turns.
 *
 * After the work phase runs at LOW effort (the draft), the supervisor resumes
 * the same agent session twice:
 *
 *   1. Self-review at HIGH effort, in read-only (plan) mode. The reviewer's
 *      only output is either the approval token or a numbered list of revision
 *      instructions — maximum thinking, minimum output, warm cache.
 *   2. Unless the review approved, ONE revise invocation back at the draft
 *      effort applies those instructions (they are already in the session).
 *
 * Exactly one review→revise cycle, by design. The economics that motivate the
 * loop (docs/spikes/token-index.md §3.3 on spike-token-index) say conversation
 * LENGTH dominates cost while thinking is cheap — so iterating the loop grows
 * the dominant cost axis for diminishing returns. One cycle mirrors the human
 * review round it is trying to pre-empt; if the revise output still has
 * problems, the human review catches them exactly as it would have anyway.
 *
 * Both phases are supervised follow-up invocations (same machinery as
 * push-back/maintain): each becomes a full CompletedResponse with its own
 * effort, usage, and SHA window, so `lazy show` displays the phase boundary,
 * the review's instructions, and what the revision changed.
 *
 * Failure posture mirrors push-back: a failed phase is non-fatal — the turn
 * proceeds with the draft's work and the failure is recorded on the phase's
 * turn, never thrown.
 */

import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';
import lowHighReviewTemplate from '../prompts/low-high-loop-review.md' with { type: 'text' };
import lowHighReviseTemplate from '../prompts/low-high-loop-revise.md' with { type: 'text' };

/** Approval token the review replies with when the draft needs no revision. */
export const LOW_HIGH_LOOP_APPROVED = 'LOW_HIGH_LOOP_APPROVED';

/** Zero-usage fallback for a failed invocation (no agent tokens were spent). */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/** Preserve the harness's own actionable failure instead of a generic exit message. */
export function lowHighFailureDetail(
  agent: Agent,
  stdout: string,
  stderr: string,
  worktreePath: string,
): string {
  if (stdout.trim()) {
    try {
      agent.parseResponse(stdout, { workingDir: worktreePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.trim()) return message.trim();
    }
  }
  return stderr.trim() || 'agent exited with an error';
}

export interface LowHighPhaseResult {
  /** The prompt the supervisor sent to the agent. */
  prompt: string;
  /** The agent's text response (review instructions, or the revise summary). */
  response: string;
  /** Agent session id this invocation reported (each resume can rotate it). */
  session_id: string;
  /** Full token usage of this invocation (incl. cache tokens). */
  usage: AgentResponse['usage'];
  /** Concrete model id the agent reported for THIS invocation, when any. */
  model_id?: string;
  /** False when the invocation crashed or its response was unparseable. */
  ok: boolean;
}

/**
 * Whether a review response approved the draft (no revise phase needed).
 * The prompt asks for the token alone on the first line; accept a first line
 * that starts with it so a trailing remark doesn't force a pointless revision.
 */
export function reviewApproved(response: string): boolean {
  const firstLine = response.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.startsWith(LOW_HIGH_LOOP_APPROVED);
}

interface LowHighInvocationOptions {
  modelId?: string;
  effort: string;
  /**
   * No-progress guard for the invocation, same value as the work phase. The
   * review can legitimately think for a long time at high effort, and the
   * revise phase does real work — both need the hang backstop, not a 0.
   */
  watchdogTimeoutMs: number;
  extraArgs?: string[];
}

async function runLowHighInvocation(
  phase: 'review' | 'revise',
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  prompt: string,
  opts: LowHighInvocationOptions,
  permissionMode?: 'plan',
): Promise<LowHighPhaseResult> {
  log(`[low-high-loop] Resuming session ${sessionId.substring(0, 8)}... for ${phase} (effort=${opts.effort})`);

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId: opts.modelId,
    effort: opts.effort,
    permissionMode,
    extraArgs: opts.extraArgs,
  });

  const activityStream = agent.activityStream();
  const { stdout, stderr, exitCode, resultLine, sessionStartEvent } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    timeoutMs: opts.watchdogTimeoutMs,
    activityStream,
  });

  if (exitCode !== 0) {
    const detail = lowHighFailureDetail(agent, stdout, stderr, worktreePath);
    logError(`[low-high-loop] ${phase} agent exited with code ${exitCode}`);
    logError(`[low-high-loop] stderr: ${stderr.slice(-500)}`);
    // Non-fatal — the draft's work stands; record the failure on the phase turn.
    return {
      prompt,
      response: `FAILED: Low-high ${phase} did not complete — ${detail.slice(-2_000)}`,
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      ok: false,
    };
  }

  try {
    const parsed = agent.parseResponse(resultLine ?? stdout, { workingDir: worktreePath });
    log(`[low-high-loop] ${phase} responded (${parsed.result.length} chars)`);
    return {
      prompt,
      response: parsed.result,
      session_id: parsed.session_id,
      usage: parsed.usage,
      // The isolated result line is all `parseResponse` sees here, and Cursor's
      // carries no model — the init line is its only report, exactly as on the
      // work turn (attachReportedModel in work.ts).
      model_id: parsed.model_id ?? sessionStartEvent?.model,
      ok: true,
    };
  } catch (err) {
    logError(`[low-high-loop] Failed to parse ${phase} response: ${err instanceof Error ? err.message : err}`);
    return {
      prompt,
      response: `Low-high loop  failed: could not parse agent response.`,
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      ok: false,
    };
  }
}

/**
 * Run the self-review phase: resume the draft's session at review effort, in
 * read-only (plan) mode so the reviewer can only produce instructions.
 */
export async function runLowHighReview(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  opts: LowHighInvocationOptions,
): Promise<LowHighPhaseResult> {
  return runLowHighInvocation('review', agent, worktreePath, sessionId, lowHighReviewTemplate, opts, 'plan');
}

/**
 * Run the revise phase: resume the review's session back at the draft effort
 * and apply the instructions (already in the session's context).
 */
export async function runLowHighRevise(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  opts: LowHighInvocationOptions,
): Promise<LowHighPhaseResult> {
  return runLowHighInvocation('revise', agent, worktreePath, sessionId, lowHighReviseTemplate, opts);
}
