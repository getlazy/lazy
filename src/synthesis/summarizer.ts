/**
 * Summarizer — an abstracted capability that synthesizes a faithful summary of
 * what a task's work actually became, from the events that matter (turns,
 * human feedback, child contributions, commits).
 *
 * The driver/lifecycle code depends on this INTERFACE, never on Claude Code
 * directly. This keeps synthesis swappable and — crucially — mockable, so the
 * commit/PR-fidelity behavior is e2e-testable without a live model.
 *
 * Synthesis is an ENHANCEMENT, not a gate: a Summarizer is allowed to throw
 * (no auth, offline, timeout). Callers MUST catch and fall back to a
 * deterministic body/message — they must NEVER fail an accept or push because
 * synthesis was unavailable. This is distinct from remote *write* failures,
 * which fail hard. See src/synthesis/fidelity.ts for the fallback policy.
 */

import { appendFileSync } from 'fs';
import { logger } from '../utils/logger';
import fidelitySummaryPrompt from '../prompts/fidelity-summary.md' with { type: 'text' };

export interface SummarizerInput {
  /** The task's original goal (where the work STARTED). */
  goal: string;
  /** The task's original prompt, if any. */
  prompt?: string;
  /**
   * A pre-formatted bundle of the events that matter: agent turns, human
   * feedback turns, child/subtask contributions, and commit subjects. The
   * caller (fidelity.ts) owns the formatting so the Summarizer stays a thin
   * model adapter.
   */
  bundle: string;
}

export interface Summarizer {
  /**
   * Produce a faithful Markdown summary (no surrounding delimiters or headings).
   * Throws if synthesis is unavailable — callers must catch and fall back.
   */
  summarize(input: SummarizerInput): Promise<string>;
}

/**
 * How long a fidelity summary may take before it is abandoned.
 *
 * Synthesis is an enhancement, and this one runs INSIDE an accept, between the
 * gates and the merge — so an unbounded call is a task wedged in `merging` until
 * someone kills the daemon. Ten minutes is far beyond any real synthesis (one
 * prompt, no tools) and only ever fires on a genuinely stuck call; when it does,
 * the throw lands on the same path as "no auth" and the accept proceeds with the
 * deterministic commit list.
 *
 * Every one-shot is bounded now (DEFAULT_ONESHOT_TIMEOUT_MS in
 * src/oneshot/args.ts, same value for the same reason), so this no longer has
 * to exist for the run to be safe. It stays explicit because a bound taken
 * mid-accept is worth stating where the accept can see it — and because a future
 * change to the shared default should not silently change what an accept waits
 * for.
 */
export const SUMMARIZER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Effort a fidelity summary runs at.
 *
 * `low`, and fixed here rather than inherited: summarizing a bundle the caller
 * has already assembled is reading and condensing, not reasoning, and this runs
 * on every accept. A human driving their builder at `xhigh` must not thereby
 * make every summary cost as much as the work it describes. See
 * OneshotRequest.effort.
 */
const SUMMARIZER_EFFORT = 'low' as const;

/**
 * Model-backed Summarizer. Runs as a machine one-shot through the Runner, and
 * therefore on the BUILDER role target's agent and model — never the summarized
 * task's. A one-shot attaches to no session at all (src/oneshot/args.ts strips
 * every session flag), so the task's model would buy this call no cache and no
 * continuation, and need not even be a valid id on the harness the one-shot
 * actually runs. Attribution still lands on the task: see `taskId` below.
 *
 * The flag names are deliberately not spelled here — the invariant test in
 * test/unit/oneshot-session-attribution.test.ts reads this file and treats any
 * mention of them as the summarizer reaching for somebody's session.
 */
export class ClaudeSummarizer implements Summarizer {
  /**
   * @param projectRoot Project this summary belongs to — selects the Runner and
   *   its configuration. Optional so a caller with no root still works.
   * @param taskId Short ref of the task being accepted, where there is one.
   *   Threaded onto the proxied call as `x-lazy-task-id` so an accept-time
   *   summary is attributed to the task it summarizes.
   */
  constructor(private projectRoot?: string, private taskId?: string) {}

  async summarize(input: SummarizerInput): Promise<string> {
    const prompt = fidelitySummaryPrompt
      .replace('{{goal}}', input.goal)
      .replace('{{prompt}}', input.prompt?.trim() || '_(no prompt provided)_')
      .replace('{{bundle}}', input.bundle);

    // Dynamic import: the one-shot dispatcher reaches the runner graph, which
    // pulls in the heavy Docker/agent modules. Loading it lazily (only when
    // actually synthesizing via Claude) keeps that out of the driver/lifecycle
    // import graph and avoids a cycle.
    const { runOneshot } = await import('../oneshot');
    // INVARIANT: this run happens mid-accept, and its caller (the daemon) is
    // sitting in the project root on the TARGET branch. Everything the summary
    // needs is in the prompt, so it asks for NO repository access at all — the
    // container gets no repo mount, the host runner stands outside every git
    // tree, and write tools are disallowed either way. Running it in the project
    // root let a file-writing agent commit onto the target branch and
    // manufacture a conflict with the branch being merged.
    const response = await runOneshot({
      prompt,
      effort: SUMMARIZER_EFFORT,
      repoAccess: 'none',
      timeoutMs: SUMMARIZER_TIMEOUT_MS,
      taskId: this.taskId,
    }, this.projectRoot);
    const result = response.result?.trim();
    if (!result) {
      throw new Error('Summarizer returned empty result');
    }
    return result;
  }
}

/**
 * Test-only Summarizer that returns a deterministic, recognizable summary
 * without invoking a model. Activated by LAZY_SUMMARIZER_STUB so e2e tests can
 * exercise the fidelity behavior offline.
 *
 * Behaviors controlled by env (test-only seams, never set in production):
 *  - LAZY_SUMMARIZER_FAIL=1     — throw, to exercise the deterministic fallback.
 *  - LAZY_SUMMARIZER_STUB_LOG   — append one line per invocation to this file,
 *                                 so tests can assert WHEN synthesis fired
 *                                 (e.g. on accept but NOT on sync).
 */
export class StubSummarizer implements Summarizer {
  async summarize(input: SummarizerInput): Promise<string> {
    const logPath = process.env.LAZY_SUMMARIZER_STUB_LOG;
    if (logPath) {
      // Sync append is acceptable: this path runs only under the test stub.
      appendFileSync(logPath, `summarize:${input.goal}\n`);
    }
    if (process.env.LAZY_SUMMARIZER_FAIL === '1') {
      throw new Error('StubSummarizer: forced failure (LAZY_SUMMARIZER_FAIL)');
    }
    // Echo enough of the input that tests can assert the section was
    // regenerated from the real events, not the frozen goal/prompt.
    return [
      'SYNTHESIZED-FIDELITY',
      '',
      `Faithful summary of: ${input.goal}`,
      '',
      input.bundle.trim(),
    ].join('\n');
  }
}

/**
 * Resolve the Summarizer to use. Returns the stub under LAZY_SUMMARIZER_STUB
 * (test-only), otherwise the Claude-backed implementation.
 */
export function getSummarizer(projectRoot?: string, taskId?: string): Summarizer {
  if (process.env.LAZY_SUMMARIZER_STUB === '1') {
    logger.debug('Using StubSummarizer (LAZY_SUMMARIZER_STUB)');
    return new StubSummarizer();
  }
  return new ClaudeSummarizer(projectRoot, taskId);
}
