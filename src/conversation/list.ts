/**
 * Terminal formatting for stored builder conversation lists.
 *
 * Used by `lazy conversations list` and `lazy builder list` so the two surfaces
 * stay aligned on columns and timestamp formatting.
 */

import type { ConversationSummary } from '../storage/types';
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

export interface PrintConversationListOptions {
  offset?: number;
  limit?: number;
  /** When true, the SUMMARY column uses conv.summary; otherwise FIRST PROMPT. */
  useSummaryColumn?: boolean;
  summaryWidth?: number;
}

/**
 * Print a conversation table to stdout. Returns counts so callers can print
 * paging hints without re-deriving slice math.
 */
export function printConversationList(
  conversations: Array<ConversationSummary & { messages?: Array<{ role: string; text: string }> }>,
  options: PrintConversationListOptions = {},
): { shown: number; total: number; hasMore: boolean } {
  const offset = options.offset ?? 0;
  const total = conversations.length;
  const limit = options.limit;
  const sliced = limit !== undefined
    ? conversations.slice(offset, offset + limit)
    : conversations.slice(offset);
  const hasMore = limit !== undefined && offset + sliced.length < total;
  const summaryWidth = options.summaryWidth ?? 60;
  const lastColumn = options.useSummaryColumn ? 'SUMMARY' : 'FIRST PROMPT';

  console.log(`${total} captured conversation(s):\n`);
  console.log(
    `${theme.header('SESSION'.padEnd(10))} ` +
    `${theme.header('STARTED'.padEnd(18))} ` +
    `${theme.header('ENDED'.padEnd(18))} ` +
    `${theme.header('TURNS'.padEnd(12))} ` +
    theme.header(lastColumn),
  );

  for (const conv of sliced) {
    const shortId = conv.sessionId.substring(0, 8);
    const started = formatConversationTimestamp(conv.startedAt);
    const ended = formatConversationTimestamp(conv.endedAt);
    const turns = `${conv.stats.userMessageCount}h/${conv.stats.assistantMessageCount}a`;
    const summaryCell = options.useSummaryColumn
      ? elideConversationSummary(conv.summary, summaryWidth)
      : conversationFirstPrompt(conv, summaryWidth);

    console.log(
      `${theme.taskId(shortId).padEnd(19)} ` +
      `${started.padEnd(18)} ` +
      `${ended.padEnd(18)} ` +
      `${turns.padEnd(12)} ` +
      summaryCell,
    );
  }

  return { shown: sliced.length, total, hasMore };
}
