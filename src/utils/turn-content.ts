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
 *
 * Background (2026-08-14): the SAME defect class hit the annotation records —
 * comments, journal entries and follow-ups, which all declare `content: string`
 * too. `lazy review release-v021` died with "undefined is not an object
 * (evaluating 'entry.content.split')" building the journal nav node, and the
 * remote-comment sync's dedup scan (`note.content.match(...)`) had the same
 * exposure. Those records were writable without content before the MCP/`/rpc`
 * boundaries were validated (fix-mcp-arg-validation, 2026-08-04): a call that
 * lost its argument envelope reached `appendJournalEntry(taskId, undefined)`,
 * and `JSON.stringify` drops an `undefined` value, so the key is simply absent
 * on disk. The boundary is closed now, but the records it produced are
 * permanent — hence `repairRecordContents`, applied where storage READS them
 * back, so every surface (review TUI, `lazy show`, web review, MCP, search)
 * sees a visible placeholder instead of `undefined`.
 */

import { logger } from './logger';

/** Placeholder shown where a turn's text is missing, for human-facing renders. */
export const MISSING_TURN_CONTENT = '(no content recorded)';

/**
 * Placeholder substituted for an annotation record (comment / journal entry /
 * follow-up) that was persisted without content. Same string as
 * `MISSING_TURN_CONTENT` — one defect, one wording, wherever it surfaces.
 */
export const MISSING_RECORD_CONTENT = MISSING_TURN_CONTENT;

/** Any stored record carrying a `content` field the type system calls required. */
export interface ContentRecord {
  content?: unknown;
}

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
  return normalizeRecordContent(content, context, 'createTurn', 'Turn.content');
}

/**
 * Coerce any record's content at the storage WRITE boundary.
 *
 * Same rule as turns and for the same reason: the record is kept (a comment is
 * human feedback, a journal entry is a rationale nobody will re-type), the
 * value is coerced to '', and the offending caller is named in the log with a
 * stack. Storing the placeholder text here instead would fabricate content into
 * the store — the placeholder belongs on the READ side, where it is presentation.
 *
 * `context` identifies the storage backend, `writer` the method that was called
 * (e.g. `appendJournalEntry`), `field` the declared type being violated.
 */
export function normalizeRecordContent(
  content: unknown,
  context: string,
  writer: string,
  field: string,
): string {
  if (typeof content === 'string') return content;

  logger.warn(
    `[${context}] ${writer} called with non-string content (${content === null ? 'null' : typeof content}); ` +
    `storing an empty string. ${field} is a required string — this is a bug in the calling write path. ` +
    `Stack: ${new Error().stack?.split('\n').slice(2, 8).join(' | ') ?? 'unavailable'}`,
  );
  return '';
}

/**
 * Harden a batch of records on the storage READ boundary.
 *
 * Returns copies — the stored records are never mutated and nothing is written
 * back, so a defective record stays exactly as it is on disk and this stays a
 * presentation decision rather than a silent data migration.
 *
 * Missing/non-string AND empty content both become the placeholder: after the
 * write guard above, '' means "this record was written without content", and a
 * blank line in a review pane reads as "nothing here" — the record would
 * effectively vanish. A defective record must degrade VISIBLY, never silently.
 *
 * Logged at debug, not warn: read paths run in a full-screen TUI (a console
 * write there corrupts the frame) and re-run on every refresh, and the
 * placeholder is itself the user-visible signal. The loud warning belongs on
 * the write path, which is where the bug is.
 */
export function repairRecordContents<T extends ContentRecord>(
  records: T[],
  kind: string,
  context: string,
): T[] {
  let repaired = 0;
  const out = records.map(record => {
    const value = record?.content;
    if (typeof value === 'string' && value !== '') return record;
    repaired++;
    return { ...record, content: MISSING_RECORD_CONTENT };
  });

  if (repaired > 0) {
    logger.debug(
      `[${context}] ${repaired} ${kind} record${repaired === 1 ? '' : 's'} stored without content; ` +
      `rendering '${MISSING_RECORD_CONTENT}' in their place.`,
    );
  }
  return out;
}
