/**
 * The prompt block that carries queued web review comments into an unblock
 * work turn.
 *
 * Lives here — not in src/daemon/review-service.ts, where it started — because
 * EVERY unblock path must build the identical block: the web unblock goes
 * through the review service, but `lazy unblock` (CLI) and `lazy_unblock`
 * (MCP) go straight to `launchUnblockTask` in src/daemon/task-lifecycle.ts,
 * and the review service already imports task-lifecycle, so task-lifecycle
 * cannot import it back. One shared module breaks the cycle and keeps the
 * invariant that a reviewer's queued comments ride whichever unblock comes
 * next, whatever surface it comes from.
 */

import type { ReviewComment } from '../types';
import unblockPromptTemplate from '../prompts/review-comments-unblock.md' with { type: 'text' };
import { isProseReviewAnchor, proseAnchorAgentWhere } from './prose-anchor';
import { isTaskLevelReviewAnchor } from './task-level-anchor';

/** A prose block quoted for a prompt, `> `-prefixed line by line. */
export function quotedProse(snippet: string | null | undefined): string {
  const text = (snippet ?? '').trim();
  if (!text) return '> (the quoted text is no longer available)';
  return `> ${text.replace(/\n/g, '\n> ')}`;
}

/**
 * Render undelivered comments as one block for the unblock work turn. Each
 * comment carries its anchor so the agent can go straight to the line, plus any
 * ask conversation that already happened on that thread — the reviewer may well
 * be saying "do what we just agreed", and without the thread that reads as a
 * non-sequitur.
 *
 * A reply on the task-level conversation has no line to point at, so it renders
 * as a reply on that thread instead — never as a bogus `(task)` line 0 header.
 */
export function buildUnblockPrompt(
  pending: ReviewComment[],
  all: ReviewComment[],
  message: string,
): string {
  const blocks = pending.map((c, i) => {
    const anchor = c.anchor_snippet ? `\n\n\`\`\`\n${c.anchor_snippet}\n\`\`\`` : '';
    // Everything on this thread that came before the comment — the reviewer's
    // earlier questions and the answers you gave.
    const priorThread = all.filter(
      (o) => o.thread_id === c.thread_id && o.id !== c.id && o.created_at <= c.created_at,
    );
    const context = priorThread.length
      ? `\n\nEarlier on this thread:\n${priorThread
          .map((o) => `> **${o.role === 'agent' ? 'You' : 'Reviewer'}:** ${o.content.replace(/\n/g, '\n> ')}`)
          .join('\n>\n')}`
      : '';
    // A prose anchor points at the agent's own words: quote them, never the
    // pseudo-file or the content-hash line — those would read as a fake
    // file/line and send the agent hunting for code that does not exist.
    if (isProseReviewAnchor(c.file)) {
      const snippet =
        c.anchor_snippet ??
        all.find((o) => o.thread_id === c.thread_id && o.anchor_snippet)?.anchor_snippet;
      return `### ${i + 1}. On ${proseAnchorAgentWhere(c.file)}, the line:\n\n${quotedProse(snippet)}\n\n${c.content}${context}`;
    }
    // A task-level comment is a reply on the conversation about the work as a
    // whole; it has no file or line, and rendering the sentinel as one would
    // send the agent hunting for `(task)` line 0. The thread quoted below is
    // the whole anchor it has, and the whole anchor it needs.
    if (isTaskLevelReviewAnchor(c.file, c.line)) {
      return `### ${i + 1}. Reply on the task-level conversation\n\n${c.content}${context}`;
    }
    const side = c.side === 'old' ? 'removed/original' : 'added/new';
    return `### ${i + 1}. \`${c.file}\` line ${c.line} (${side} side)${anchor}\n\n${c.content}${context}`;
  });

  return unblockPromptTemplate
    .replace('{{count}}', String(pending.length))
    .replace('{{comments}}', blocks.join('\n\n'))
    .replace('{{message}}', message);
}
