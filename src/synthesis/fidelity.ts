/**
 * Commit/PR fidelity — synthesize a faithful summary of what a task's work
 * actually became, from durable storage (turns incl. human feedback, comments,
 * child contributions, commit subjects), and apply it to a lazy-owned section
 * of a PR/MR body.
 *
 * Why this lives outside the drivers and outside the Summarizer:
 *  - The Summarizer is a thin model adapter (interface; src/synthesis/summarizer.ts).
 *  - The drivers only know how to WRITE the body section (updateRemoteBody) —
 *    they never touch Claude or storage-for-synthesis.
 *  - This module is the seam that reads storage and produces the text. All
 *    source material is already durably in storage, so a faithful body can be
 *    re-derived on demand — there is no need to persist special artifacts.
 */

import type { Storage } from '../storage';
import type { Task, Turn } from '../types';
import type { RepositoryDriver } from '../remote/driver';
import type { Summarizer, SummarizerInput } from './summarizer';
import { getSummarizer } from './summarizer';
import { logger } from '../utils/logger';
import { turnText, MISSING_TURN_CONTENT } from '../utils/turn-content';
import { formatTurnTypeSuffix } from '../utils/turn-labels';
import { formatUnparsedReviewSuffix } from '../review/parse-report';

/**
 * Delimiters for the lazy-owned section of a PR/MR description. HTML comments
 * so they render invisibly. updateRemoteBody replaces ONLY the content between
 * these markers, never the human-authored text around them.
 */
export const FIDELITY_BEGIN = '<!-- lazy:fidelity:begin -->';
export const FIDELITY_END = '<!-- lazy:fidelity:end -->';

export interface FidelityResult {
  /**
   * Markdown summary suitable for the lazy-owned body section. Always present:
   * the synthesized text when synthesis succeeded, or a deterministic
   * commit-subjects fallback when it did not.
   */
  summary: string;
  /** True when the Summarizer produced this; false when we fell back. */
  synthesized: boolean;
}

/** First line of a (possibly multi-line) commit message. */
function commitSubject(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

/** Describe a turn for the event bundle, distinguishing human feedback. */
function formatTurn(turn: Turn): string {
  const who = turn.role === 'human' ? (turn.actor ?? 'human') : 'agent';
  const kind = `${formatTurnTypeSuffix(turn)}${formatUnparsedReviewSuffix(turn)}`;
  const auto = turn.auto_triggered ? ' (auto)' : '';
  // Crashed/recovered turns from older writes can lack `content` entirely.
  // Render a placeholder — the turn's existence is itself signal — and never
  // crash: this runs inline on the accept path, before the merge.
  const content = turnText(turn, MISSING_TURN_CONTENT).trim() || MISSING_TURN_CONTENT;
  return `- [${who}]${kind}${auto}: ${content}`;
}

/**
 * Gather the events that matter from storage and format them into a bundle for
 * the Summarizer. Returns the bundle plus the deterministic commit-subject list
 * (reused for the fallback).
 */
async function gatherEvents(
  storage: Storage,
  task: Task,
): Promise<{ bundle: string; commitSubjects: string[] }> {
  const session = await storage.getSessionByTaskId(task.id);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const commits = session ? await storage.getSessionCommits(session.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const children = await storage.getChildTasks(task.id);

  const commitSubjects = commits.map(c => commitSubject(c.message)).filter(Boolean);

  const sections: string[] = [];

  if (turns.length > 0) {
    sections.push(`### Turns (${turns.length})\n${turns.map(formatTurn).join('\n')}`);
  }

  if (comments.length > 0) {
    const lines = comments.map(c => `- [${c.actor ?? 'human'}]: ${turnText(c, MISSING_TURN_CONTENT).trim()}`);
    sections.push(`### Comments (${comments.length})\n${lines.join('\n')}`);
  }

  // Child/subtask contributions that have landed in this task. Their work was
  // squash-merged into this branch, so it must be reflected here too.
  const mergedChildren = children.filter(c => c.status === 'complete');
  if (mergedChildren.length > 0) {
    const lines = mergedChildren.map(c => `- ${c.goal}`);
    sections.push(`### Child contributions merged in (${mergedChildren.length})\n${lines.join('\n')}`);
  }

  if (commitSubjects.length > 0) {
    const lines = commitSubjects.map(s => `- ${s}`);
    sections.push(`### Commit subjects (${commitSubjects.length})\n${lines.join('\n')}`);
  }

  const bundle = sections.length > 0 ? sections.join('\n\n') : '_No recorded events._';
  return { bundle, commitSubjects };
}

/**
 * Best-effort commit subjects for the fallback path, used when gathering the
 * full event bundle threw. Returns [] rather than propagating — this is the
 * last line of defence before an accept aborts.
 */
async function commitSubjectsOnly(storage: Storage, task: Task): Promise<string[]> {
  try {
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) return [];
    const commits = await storage.getSessionCommits(session.id);
    return commits.map(c => commitSubject(c.message)).filter(Boolean);
  } catch {
    // Storage is unreadable for this task; the deterministic fallback degrades
    // to "no commits recorded" rather than blocking the caller's accept.
    return [];
  }
}

/** Deterministic fallback summary when synthesis is unavailable. */
function deterministicSummary(commitSubjects: string[]): string {
  if (commitSubjects.length === 0) {
    return '_No commits recorded for this task._';
  }
  return ['Commits in this task:', '', ...commitSubjects.map(s => `- ${s}`)].join('\n');
}

/**
 * Synthesize a faithful summary of the task's work from storage.
 *
 * Synthesis is an enhancement, not a gate: if the Summarizer throws (no auth,
 * offline, timeout), we log and return the deterministic commit-subject
 * fallback with `synthesized: false`. This NEVER throws — callers can rely on
 * always getting a usable summary so accept/push are never blocked by synthesis.
 */
export async function synthesizeFidelityBody(
  storage: Storage,
  task: Task,
  summarizer: Summarizer,
): Promise<FidelityResult> {
  // Gathering reads storage and formats records written by other code paths.
  // A malformed record (e.g. a crash turn persisted without content) must not
  // abort the caller — accept regenerates fidelity inline, before the merge, so
  // a throw here would make the task un-acceptable. Degrade like a Summarizer
  // failure does.
  let bundle: string;
  let commitSubjects: string[];
  try {
    ({ bundle, commitSubjects } = await gatherEvents(storage, task));
  } catch (err) {
    logger.warn(
      `Fidelity event gathering failed for task ${task.id.slice(0, 8)} ` +
      `(${err instanceof Error ? err.message : err}); falling back to deterministic commit list.`,
    );
    return { summary: deterministicSummary(await commitSubjectsOnly(storage, task)), synthesized: false };
  }

  const input: SummarizerInput = {
    goal: task.goal,
    prompt: task.prompt ?? undefined,
    bundle,
  };

  try {
    const summary = await summarizer.summarize(input);
    synthesisSuccesses++;
    return { summary, synthesized: true };
  } catch (err) {
    logger.warn(
      `Fidelity synthesis unavailable for task ${task.id.slice(0, 8)} ` +
      `(${err instanceof Error ? err.message : err}); falling back to deterministic commit list.`,
    );
    return { summary: deterministicSummary(commitSubjects), synthesized: false };
  }
}

/**
 * How many times synthesis has SUCCEEDED in this process.
 *
 * Summarizer availability is process-wide, not per task: every synthesis runs
 * on the same builder role target with the same credential, so one success
 * anywhere — a sync refresh, an accept, a child-accept — proves the capability
 * is back for everyone. A caller that has stopped attempting synthesis for a
 * task can watch this count instead of spending probe calls of its own to find
 * out; while it has not moved, nothing has demonstrated that a retry would do
 * anything but fail again.
 *
 * Monotonic and never reset: callers compare against a value they captured, so
 * only movement is meaningful and wrap-around is not a concern at one
 * increment per model call.
 */
let synthesisSuccesses = 0;

export function synthesisSuccessCount(): number {
  return synthesisSuccesses;
}

/** Wrap a summary in the lazy-owned delimiters. */
export function wrapFidelitySection(summary: string): string {
  return `${FIDELITY_BEGIN}\n${summary.trim()}\n${FIDELITY_END}`;
}

/**
 * Replace the lazy-owned section of an existing body with a fresh summary,
 * preserving all human-authored text outside the delimiters.
 *
 * If the delimiters are absent (older PR, or a human deleted them), append a
 * fresh delimited section at the end rather than rewriting — we must never
 * clobber human edits to the description.
 */
export function applyFidelitySection(existingBody: string, summary: string): string {
  const wrapped = wrapFidelitySection(summary);
  const startIdx = existingBody.indexOf(FIDELITY_BEGIN);
  const endIdx = existingBody.indexOf(FIDELITY_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingBody.slice(0, startIdx);
    const after = existingBody.slice(endIdx + FIDELITY_END.length);
    return `${before}${wrapped}${after}`;
  }

  const base = existingBody.trimEnd();
  return base.length > 0 ? `${base}\n\n${wrapped}` : wrapped;
}

/**
 * What happened to the REMOTE description on a regeneration. A caller that
 * tracks "which turns are reflected in the PR/MR" must branch on this and not
 * on `warning`: two of the four outcomes leave the description untouched and
 * only ONE of them carries a warning.
 *
 *  - `written`            — updateRemoteBody succeeded; the description now
 *                           reflects this summary.
 *  - `not-attempted`      — the driver has no remote body to write (local
 *                           driver, or no PR/MR yet). Nothing is pending.
 *  - `synthesis-fallback` — synthesis fell back to the deterministic commit
 *                           list, so the write was deliberately SKIPPED rather
 *                           than downgrade a good description to a worse one.
 *                           The description is unchanged and still stale.
 *  - `write-failed`       — updateRemoteBody threw; `warning` says why. The
 *                           description is unchanged and still stale.
 */
export type FidelityRemoteOutcome = 'written' | 'not-attempted' | 'synthesis-fallback' | 'write-failed';

export interface RegenerateResult {
  /**
   * Synthesized body to feed into the local squash commit
   * (MergeOptions.fidelityBody). Undefined when synthesis failed — callers
   * should then let the deterministic default message/body stand.
   */
  fidelityBody?: string;
  /** Non-fatal warning when the remote body write failed (never blocks the caller). */
  warning?: string;
  /**
   * What happened to the remote description. Required, so every return path
   * has to say — the absence of a warning used to be read as "the write
   * landed", which is false on the `synthesis-fallback` path.
   */
  outcome: FidelityRemoteOutcome;
}

export interface WriteFidelityResult {
  outcome: Extract<FidelityRemoteOutcome, 'written' | 'not-attempted' | 'write-failed'>;
  /** Non-fatal warning when the write failed (never thrown). */
  warning?: string;
}

/**
 * Write an already-synthesized summary into the lazy-owned section of a PR/MR
 * description. Never throws: a hard failure inside `updateRemoteBody` comes
 * back as `write-failed` plus a warning, because every caller is on a
 * non-critical path (an accept, a push, a sync tick) that must proceed.
 *
 * Separate from `regenerateFidelity` so a caller holding a summary whose write
 * failed can RETRY THE WRITE without paying for synthesis again — a summarizer
 * run is a model one-shot, and re-deriving the same text from unchanged
 * storage would spend one to produce what the caller already has.
 */
export async function writeFidelityBody(
  task: Task,
  driver: RepositoryDriver,
  summary: string,
  opts: {
    /**
     * Log a failure at warn level (default true). A caller that RETRIES on a
     * timer sets this false and decides for itself when a repeat is worth
     * saying again — otherwise a write that can never succeed warns on every
     * tick forever. The warning is still returned either way.
     */
    logWarning?: boolean;
  } = {},
): Promise<WriteFidelityResult> {
  if (!driver.needsSync || !driver.hasRemoteRef(task)) return { outcome: 'not-attempted' };

  try {
    await driver.updateRemoteBody(task, summary);
    return { outcome: 'written' };
  } catch (err) {
    const warning = `Could not update remote body for task ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`;
    if (opts.logWarning ?? true) logger.warn(warning);
    return { outcome: 'write-failed', warning };
  }
}

/**
 * Regenerate the fidelity record for a task: synthesize from storage and, for
 * hosted drivers with an existing PR/MR, update the lazy-owned body section.
 *
 * This is the single entry point for all regeneration triggers (accept,
 * child-accept, new-turns-pushed). It NEVER throws:
 *  - Synthesis failure → deterministic fallback (no remote write, no fidelityBody).
 *  - Remote write failure → returned as a warning; the merge/push proceeds.
 *
 * These two failure modes are deliberately distinct: synthesis is an
 * enhancement, while remote writes fail hard *inside* updateRemoteBody — but
 * here we are on a non-critical path, so we catch the hard failure and surface
 * it as a warning rather than aborting the user's accept/push.
 *
 * `outcome` reports which of the two (if either) happened, and is the field to
 * branch on when you care whether the DESCRIPTION changed. `warning` alone
 * cannot answer that: a synthesis fallback writes nothing and warns nothing.
 * To retry a failed write later, keep `fidelityBody` and call
 * `writeFidelityBody` — do not call this again, which re-runs the summarizer.
 */
export async function regenerateFidelity(
  storage: Storage,
  task: Task,
  driver: RepositoryDriver,
  summarizer: Summarizer = getSummarizer(),
): Promise<RegenerateResult> {
  const result = await synthesizeFidelityBody(storage, task, summarizer);
  if (!result.synthesized) {
    // Deterministic fallback everywhere — leave existing body/squash behavior.
    // Note for callers tracking staleness: NOTHING was written remotely here,
    // so the description still shows whatever it showed before. That is
    // deliberate (never downgrade a synthesized description to a commit list),
    // but it is not success — hence the distinct outcome.
    return { outcome: 'synthesis-fallback' };
  }

  const write = await writeFidelityBody(task, driver, result.summary);
  return { fidelityBody: result.summary, warning: write.warning, outcome: write.outcome };
}

/**
 * Compose an initial PR/MR body that includes the lazy-owned section so later
 * regeneration lands in place. Used by drivers' body builders at creation time,
 * when no work has happened yet (the section starts as a placeholder).
 */
export function composeInitialBody(opts: { goal: string; prompt?: string; footer: string }): string {
  const sections: string[] = [`## Goal\n\n${opts.goal}`];
  if (opts.prompt) {
    sections.push(`## Prompt\n\n${opts.prompt}`);
  }
  sections.push(
    `## Summary\n\n${wrapFidelitySection('_Pending — updated automatically as work lands._')}`,
  );
  sections.push(opts.footer);
  return sections.join('\n\n');
}
