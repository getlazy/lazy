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

/** Claude-backed Summarizer. Reuses the short-lived host one-shot machinery. */
export class ClaudeSummarizer implements Summarizer {
  constructor(private model?: string) {}

  async summarize(input: SummarizerInput): Promise<string> {
    const prompt = fidelitySummaryPrompt
      .replace('{{goal}}', input.goal)
      .replace('{{prompt}}', input.prompt?.trim() || '_(no prompt provided)_')
      .replace('{{bundle}}', input.bundle);

    // Dynamic import: capture/claude.ts pulls in the heavy Docker/agent module
    // graph. Loading it lazily (only when actually synthesizing via Claude)
    // keeps it out of the driver/lifecycle import graph and avoids a cycle.
    const { runClaudeOneshot } = await import('../capture/claude');
    const response = await runClaudeOneshot(prompt, this.model);
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
export function getSummarizer(model?: string): Summarizer {
  if (process.env.LAZY_SUMMARIZER_STUB === '1') {
    logger.debug('Using StubSummarizer (LAZY_SUMMARIZER_STUB)');
    return new StubSummarizer();
  }
  return new ClaudeSummarizer(model);
}
