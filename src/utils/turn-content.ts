/**
 * Guards for turn/record text that the type system says is a required string
 * but that real stored data does not always have.
 *
 * Background (2026-08-03): two crashes — `lazy accept` (fidelity's
 * `turn.content.trim()`) and `lazy search` (the evaluator's
 * `haystack.toLowerCase()`) — both came from a persisted turn whose `content`
 * key was absent. `Turn.content` is declared `string`, so TypeScript never
 * flagged the read; the value was `undefined` at runtime.
 *
 * Two halves, both required:
 *  - `normalizeTurnContent` closes the WRITE path so no new content-less turn
 *    can be persisted, and warns loudly enough to identify the caller.
 *  - `turnText` hardens READ paths. Defective records already exist in users'
 *    stores and must stay readable forever — the same rule storage backfills
 *    follow. A missing content degrades to '' (or a caller-supplied
 *    placeholder), never a crash.
 */

import { logger } from './logger';

/** Placeholder shown where a turn's text is missing, for human-facing renders. */
export const MISSING_TURN_CONTENT = '(no content recorded)';

/**
 * Read a record's text safely. Returns `fallback` (default '') when the value
 * is absent or not a string — i.e. for turns written before the write-path
 * guard existed, or by any future writer that slips past it.
 */
export function turnText(
  record: { content?: unknown } | null | undefined,
  fallback = '',
): string {
  const value = record?.content;
  return typeof value === 'string' ? value : fallback;
}

/**
 * Coerce a turn's content at the storage boundary.
 *
 * The Turn type declares `content: string`, so a non-string arriving here is a
 * bug in the caller — but dropping the turn would lose the record of a turn
 * that really happened (usually a crash or recovery turn, exactly the history a
 * reviewer needs). So we keep the turn, store '' and warn with a stack, which
 * names the offending write path in the daemon log.
 *
 * `context` identifies the storage backend for the log line.
 */
export function normalizeTurnContent(content: unknown, context: string): string {
  if (typeof content === 'string') return content;

  logger.warn(
    `[${context}] createTurn called with non-string content (${content === null ? 'null' : typeof content}); ` +
    `storing an empty string. Turn.content is a required string — this is a bug in the calling write path. ` +
    `Stack: ${new Error().stack?.split('\n').slice(2, 8).join(' | ') ?? 'unavailable'}`,
  );
  return '';
}
