/**
 * ONE re-ask for a review whose verdict could not be read.
 *
 * A review verdict is a closed set — `clean` / `needs_work` / `needs_human` —
 * because the daemon acts on it mechanically: auto-fix, park, count a round,
 * gate accept. The first loop to run under the final-turn flow produced six
 * spellings of those three ideas across nine reviews, twice put prose in the
 * verdict field, and once stored `unparsed`, which the loop then accepted
 * anyway. A verdict nobody can act on is a failed review, and a failed review
 * costs the whole round.
 *
 * So the supervisor resumes the reviewer's own session once and asks for the
 * JSON block alone. SINGLE-SHOT by construction, exactly like the permission
 * push-back and the maintain follow-up: detect → one follow-up →
 * carry it home. No loop, no re-detect. An agent that will not produce three
 * words twice will not produce them on the third ask either, and the review is
 * then recorded as FAILED — which gates accept like `needs_work` rather than
 * disappearing.
 *
 * The re-asked text is carried on `CompletedResponse.review_reask`, NOT
 * substituted into `result`: the first reply may hold the reviewer's only
 * written reasoning, and it stays the turn's content.
 */

import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';
import reaskTemplate from '../prompts/review-verdict-reask.md' with { type: 'text' };


export interface ReviewReaskResult {
  /** The re-ask prompt the supervisor sent. */
  prompt: string;
  /** The agent's text response — the caller parses it for a verdict. */
  response: string;
  /** Agent session id the invocation reported. */
  session_id: string;
  /** Full token usage of the invocation (incl. cache tokens). */
  usage: AgentResponse['usage'];
  /** Concrete model id the agent reported for THIS invocation, when it reports one. */
  model_id?: string;
  /** True when the invocation itself failed — the caller records nothing usable. */
  failed: boolean;
}

/** Zero-usage fallback for a failed re-ask (no agent tokens were spent). */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/**
 * Budget for the re-ask.
 *
 * Deliberately short: the answer is a JSON object the reviewer already has in
 * its head, and an agent that starts fresh analysis here has misread the
 * prompt. The watchdog capping it is the right outcome.
 */
const REVIEW_REASK_TIMEOUT_MS = 180_000;

/**
 * Resume the reviewer's session once, asking for the verdict block alone.
 *
 * Never throws: this runs on the way out of a review turn, and a failed re-ask
 * must leave the review exactly as it would have been without one.
 */
export async function runReviewVerdictReask(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  modelId?: string,
  effort?: string,
  /** Host OS-sandbox `--settings` (and any other argv) — same path the review itself uses. */
  extraArgs?: string[],
): Promise<ReviewReaskResult> {
  const prompt = reaskTemplate;

  log(
    `[review-reask] Resuming review session ${sessionId.substring(0, 8)}... — ` +
    `the verdict was not one of clean / needs_work / needs_human`,
  );

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
    effort,
    extraArgs,
    // INVARIANT: the re-ask is READ-ONLY, exactly like the review invocation it
    // resumes (`runWork(..., 'plan', ...)` in handleReviewCommand). A reviewer
    // that can write the branch it is reviewing breaks the separation the
    // review turn exists to enforce: it could silently "fix" what it was about
    // to report, or commit into the implementer's worktree with no work turn
    // behind it and the change attributed to the implementer's task.
    //
    // This path is taken on exactly the reviews that already went wrong — an
    // unusable verdict, a missing sweep — so it is reached under confusion
    // rather than rarely. Asserted on the argv in
    // test/unit/review-reask-argv.test.ts so a future edit cannot drop it.
    permissionMode: 'plan',
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number | null;
  try {
    ({ stdout, stderr, exitCode } = await execWithWatchdog(claudeArgs, {
      cwd: worktreePath,
      env: process.env as Record<string, string>,
      timeoutMs: REVIEW_REASK_TIMEOUT_MS,
    }));
  } catch (err) {
    // `spawn` THROWS rather than returning a non-zero exit when the binary
    // itself cannot be launched (ENOENT, a bad worktree path). Without this the
    // "never throws" contract above was false: the throw propagated into
    // handleReviewCommand's catch and turned a review that had ALREADY
    // produced a reply into a crashed-review error turn, losing the reply.
    // A failed re-ask must cost the re-ask and nothing else.
    logError(
      `[review-reask] Could not launch the re-ask: ${err instanceof Error ? err.message : err}`,
    );
    return {
      prompt,
      response: '',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }

  if (exitCode !== 0) {
    logError(`[review-reask] Agent exited with code ${exitCode}`);
    logError(`[review-reask] stderr: ${stderr.slice(-500)}`);
    return {
      prompt,
      response: '',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }

  try {
    const parsed = agent.parseResponse(stdout, { workingDir: worktreePath });
    log(`[review-reask] Agent responded (${parsed.result.length} chars)`);
    return {
      prompt,
      response: parsed.result,
      session_id: parsed.session_id,
      usage: parsed.usage,
      ...(parsed.model_id ? { model_id: parsed.model_id } : {}),
      failed: false,
    };
  } catch (err) {
    logError(`[review-reask] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    return {
      prompt,
      response: '',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }
}
