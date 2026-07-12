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
  const kind = turn.turn_type === 'ask' ? ' (ask)' : turn.turn_type === 'nudge' ? ' (nudge)' : turn.turn_type === 'sync' ? ' (sync)' : '';
  const auto = turn.auto_triggered ? ' (auto)' : '';
  const content = turn.content.trim();
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
    const lines = comments.map(c => `- [${c.actor ?? 'human'}]: ${c.content.trim()}`);
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
  const { bundle, commitSubjects } = await gatherEvents(storage, task);

  const input: SummarizerInput = {
    goal: task.goal,
    prompt: task.prompt ?? undefined,
    bundle,
  };

  try {
    const summary = await summarizer.summarize(input);
    return { summary, synthesized: true };
  } catch (err) {
    logger.warn(
      `Fidelity synthesis unavailable for task ${task.id.slice(0, 8)} ` +
      `(${err instanceof Error ? err.message : err}); falling back to deterministic commit list.`,
    );
    return { summary: deterministicSummary(commitSubjects), synthesized: false };
  }
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

export interface RegenerateResult {
  /**
   * Synthesized body to feed into the local squash commit
   * (MergeOptions.fidelityBody). Undefined when synthesis failed — callers
   * should then let the deterministic default message/body stand.
   */
  fidelityBody?: string;
  /** Non-fatal warning when the remote body write failed (never blocks the caller). */
  warning?: string;
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
    return {};
  }

  let warning: string | undefined;
  if (driver.needsSync && driver.hasRemoteRef(task)) {
    try {
      await driver.updateRemoteBody(task, result.summary);
    } catch (err) {
      warning = `Could not update remote body for task ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`;
      logger.warn(warning);
    }
  }

  return { fidelityBody: result.summary, warning };
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
