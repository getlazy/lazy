/**
 * Terminal formatting for stored builder conversation lists.
 *
 * Used by `lazy conversations list` and `lazy builder list` so the two surfaces
 * stay aligned on columns and timestamp formatting.
 */

import type { BuilderSummary, ConversationSummary } from '../storage/types';
import { theme } from '../render/theme';

/** ISO timestamp → "YYYY-MM-DD HH:MM" for table columns. */
export function formatConversationTimestamp(iso: string | null): string {
  return iso ? iso.replace('T', ' ').substring(0, 16) : '-';
}

/** First line of the first user message, elided for a table cell. */
export function conversationFirstPrompt(
  conv: ConversationSummary & { messages?: Array<{ role: string; text: string }> },
  maxLen = 60,
): string {
  const firstUserMsg = conv.messages?.find(m => m.role === 'user');
  if (firstUserMsg) {
    const firstLine = firstUserMsg.text.split('\n')[0];
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.substring(0, maxLen) + '...';
  }
  // Listing via the metadata projection has no messages. Capture stores
  // `summary` as the first user line (extractSummary), so it is the same cell.
  if (!conv.messages) return elideConversationSummary(conv.summary || '(no prompt)', maxLen);
  return '(no prompt)';
}

/** First line of the stored summary, elided for a table cell. */
export function elideConversationSummary(summary: string, maxLen = 60): string {
  const line = summary.split('\n')[0];
  if (line.length <= maxLen) return line;
  return line.substring(0, maxLen) + '...';
}

/** The run badge a Builder row carries: the live run's state, nothing else. */
export function builderRunBadge(builder: BuilderSummary): string {
  return builder.run?.live ? `[${builder.run.state}]` : '';
}

/**
 * Print a Builder table to stdout — `lazy conversations list` and `lazy builder
 * list`. One row per Builder (a conversation from a start or `/clear` to the
 * next `/clear`), however many session files compaction and resume rolled it
 * through; the live run's state is a badge on the row it is in.
 */
export function printBuilderList(
  builders: BuilderSummary[],
  options: { offset?: number; limit?: number; titleWidth?: number } = {},
): { shown: number; total: number; hasMore: boolean } {
  const offset = options.offset ?? 0;
  const total = builders.length;
  const limit = options.limit;
  const sliced = limit !== undefined ? builders.slice(offset, offset + limit) : builders.slice(offset);
  const hasMore = limit !== undefined && offset + sliced.length < total;
  const titleWidth = options.titleWidth ?? 60;

  console.log(`${total} Builder(s):\n`);
  console.log(
    `${theme.header('BUILDER'.padEnd(10))} ` +
    `${theme.header('STARTED'.padEnd(18))} ` +
    `${theme.header('ENDED'.padEnd(18))} ` +
    `${theme.header('TURNS'.padEnd(12))} ` +
    theme.header('TITLE'),
  );
  for (const b of sliced) {
    const badge = builderRunBadge(b);
    const turns = `${b.stats.userMessageCount}h/${b.stats.assistantMessageCount}a`;
    console.log(
      `${theme.taskId(b.id.substring(0, 8)).padEnd(19)} ` +
      `${formatConversationTimestamp(b.startedAt).padEnd(18)} ` +
      `${formatConversationTimestamp(b.endedAt).padEnd(18)} ` +
      `${turns.padEnd(12)} ` +
      (badge ? `${theme.success(badge)} ` : '') +
      elideConversationSummary(b.title, titleWidth),
    );
  }
  return { shown: sliced.length, total, hasMore };
}
