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
 * turn, never thrown. The ONE exception is a self-review that wrote to the
 * worktree (`readOnlyViolation`): the supervisor ends the turn fatally on it,
 * exactly as it does an ask or a review that wrote, so no later writable step
 * (the revise, the commit nudge, or a final's `commit_leftovers`) can commit the reviewer's
 * edits.
 */

import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';
import {
  assertWorktreeUnchanged,
  countingActivityStream,
  reportsCouldNotInspect,
  snapshotWorktree,
  type WorktreeSnapshot,
} from './read-only-guard';
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
  /**
   * Set when the read-only self-review CHANGED the worktree: the write check's
   * message. Unlike every other failure here this one is not non-fatal — the
   * caller must end the whole turn (no revise, no wrap-up), because a later
   * writable step would commit the reviewer's edits.
   */
  readOnlyViolation?: string;
  /** Background work this invocation left behind (see WatchdogResult). */
  backgroundLeftBehind?: string[];
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
  /** The supervisor's runner isolates the agent (a task container) — see Agent.buildExecArgs. */
  externallySandboxed?: boolean;
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
    externallySandboxed: opts.externallySandboxed,
    extraArgs: opts.extraArgs,
  });

  // The review phase is read-only: lazy checks that itself, before and after
  // (read-only-guard.ts), because inside a container the harness's own sandbox
  // is bypassed. A snapshot that cannot be taken fails the review rather than
  // running it unchecked.
  let before: WorktreeSnapshot | undefined;
  if (permissionMode === 'plan') {
    try {
      before = await snapshotWorktree(worktreePath);
    } catch (err) {
      return failedPhase(phase, prompt, sessionId, err instanceof Error ? err.message : String(err));
    }
  }

  const rawStream = agent.activityStream();
  const activityStream = rawStream ? countingActivityStream(rawStream) : null;
  const { stdout, stderr, exitCode, resultLine, sessionStartEvent, backgroundLeftBehind } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    timeoutMs: opts.watchdogTimeoutMs,
    activityStream,
  });

  if (before) {
    try {
      await assertWorktreeUnchanged(worktreePath, before, 'The low-high self-review');
    } catch (err) {
      const violation = err instanceof Error ? err.message : String(err);
      logError(`[low-high-loop] ${violation}`);
      const failed = { ...failedPhase(phase, prompt, sessionId, violation), readOnlyViolation: violation };
      // The reviewer ran in full: keep what it spent and the session it left,
      // so the turn records real tokens and the next phase resumes the right
      // conversation. An unparseable reply leaves the zero-usage fallback.
      try {
        const parsed = agent.parseResponse(resultLine ?? stdout, { workingDir: worktreePath });
        return { ...failed, session_id: parsed.session_id, usage: parsed.usage, model_id: parsed.model_id ?? sessionStartEvent?.model };
      } catch {
        // Deliberately ignored: the write-check failure is the error this phase
        // reports; a reply that also does not parse adds nothing to act on.
        return failed;
      }
    }
  }

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
    if (phase === 'review') {
      const uninspected = uninspectedReviewReason(parsed.result, activityStream?.toolCalls());
      if (uninspected) {
        logError(`[low-high-loop] ${uninspected}`);
        // The reviewer's own words ride along: they are usually the only
        // record of WHAT it could not reach.
        return {
          ...failedPhase(phase, prompt, parsed.session_id, `${uninspected}\n\nReviewer's reply:\n${parsed.result.slice(0, 4_000)}`),
          usage: parsed.usage,
          model_id: parsed.model_id ?? sessionStartEvent?.model,
        };
      }
    }
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
      ...(backgroundLeftBehind?.length ? { backgroundLeftBehind } : {}),
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

/** A failed phase: non-fatal, recorded as `FAILED:` (a failed review turn for the review phase). */
function failedPhase(phase: 'review' | 'revise', prompt: string, sessionId: string, detail: string): LowHighPhaseResult {
  return {
    prompt,
    response: `FAILED: Low-high ${phase} did not complete — ${detail.slice(-6_000)}`,
    session_id: sessionId,
    usage: { ...ZERO_USAGE },
    ok: false,
  };
}

/**
 * Why a self-review reply cannot count as a review, or null when it can.
 *
 * The rule, deliberately simple and conservative:
 *   1. a reply that declares it could not inspect the work (the marker the
 *      prompt asks for) is a failed review, whatever else it says;
 *   2. an APPROVAL from an invocation that made no tool call at all is a failed
 *      review — the prompt tells the reviewer to re-read the diff and commits,
 *      and approving from memory of its own draft is exactly the bare
 *      `LOW_HIGH_LOOP_APPROVED` that read nothing. A tool count lazy cannot
 *      observe (an agent with no activity stream) is unknown, not zero.
 * Revision instructions with no tool call are left alone: they ask for more
 * work, never wave the draft through.
 */
export function uninspectedReviewReason(reply: string, toolCalls: number | undefined): string | null {
  if (reportsCouldNotInspect(reply)) {
    return 'the self-review reported it could not inspect the work';
  }
  if (reviewApproved(reply) && toolCalls === 0) {
    return 'the self-review approved the draft without calling a single tool — nothing was inspected, so the approval is not recorded';
  }
  return null;
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
