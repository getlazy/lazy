/**
 * Cleaning Claude Code local-command scaffolding out of ALREADY-STORED
 * conversations.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/import/local-command-messages.ts` stops NEW scaffolding — the
 * `<local-command-caveat>` block, a built-in slash command's invocation, its
 * stdout/stderr — from ever becoming a stored message. It changes nothing about
 * what is already in the store: re-import skips sessions already stored, and the
 * capture sweep only re-saves a session whose file changed. Measured on this
 * project's store on 2026-09-13, that left 87 of 753 conversations listing the
 * caveat as their summary (docs/local-command-conversations.md).
 *
 * So this module is the one-time, opt-in cleanup behind
 * `lazy doctor --clean-local-command-conversations`. It never runs on its own.
 *
 * WHAT "RE-PARSE" MEANS HERE
 * --------------------------
 * The filter lives in `parseLogEntry`, and it is a predicate over MESSAGE TEXT
 * for USER entries only. A stored conversation already holds that text, message
 * by message, so applying the same predicate to the stored transcript produces
 * exactly what re-reading the raw JSONL through today's parser would produce —
 * without depending on the raw JSONL still being on disk, which Claude Code
 * prunes over time. That is the whole reason this works off the store rather
 * than re-reading files: the rows that need cleaning are the OLDEST ones, and
 * those are precisely the ones whose logs are most likely gone.
 *
 * Everything derived from the kept messages is recomputed the way
 * `parseConversation` computes it — summary (`extractSummary`), message counts,
 * and the started/ended timestamps — so a later sweep that DOES re-read the raw
 * file writes the same thing back and the two cannot disagree. Token usage is
 * deliberately untouched: it is aggregated from the raw JSONL entries, not from
 * the kept messages, so dropping scaffolding never changed it at ingest either.
 *
 * THE CONTENT-FREE ROWS
 * ---------------------
 * A row whose every message is scaffolding — caveat plus one `/clear`, ~14 of
 * them in the measurement above — would be left with an empty transcript. It is
 * never REWRITTEN: an empty transcript is a listing entry with nothing behind
 * it, which is the same problem wearing a different summary.
 *
 * Deleting one is now allowed, and only behind its own opt-in flag
 * (`--delete-empty-local-command-conversations`). The engineer's earlier answer
 * to raised item 77664078 was "re-parse in place, nothing more"; they took the
 * deletion decision themselves on 2026-09-13 (raised item 648db124 on
 * ui-feedback-2026-09-12). Deletion stays separate from the rewrite in every
 * respect — its own flag, its own confirmation — because the two differ in
 * kind: a rewrite drops noise from a row a human can still read, a delete
 * removes the row.
 */

import { extractSummary } from './claude-code-logs';
import { isHousekeepingCommandName, isLocalCommandScaffolding } from './local-command-messages';
import type { Storage } from '../storage/interface';
import type { StoredConversation } from '../storage/types';

/** One stored conversation this cleanup has something to say about. */
export interface LocalCommandCleanupItem {
  sessionId: string;
  /** The summary the listing shows today. */
  storedSummary: string;
  startedAt: string | null;
  /** Scaffolding messages that would be dropped. */
  removed: number;
  /**
   * The row as it would be written, or null when nothing but scaffolding was
   * stored — those are never rewritten, and are deleted only behind their own
   * opt-in flag.
   */
  cleaned: StoredConversation | null;
}

/** What the cleanup would do across a whole store. */
export interface LocalCommandCleanupPlan {
  /** Conversations examined. */
  scanned: number;
  /** Rows that keep real content once the scaffolding is dropped. */
  rewrites: LocalCommandCleanupItem[];
  /** Rows that are nothing BUT scaffolding. Never rewritten; deletable on request. */
  emptied: LocalCommandCleanupItem[];
}

/** Outcome of applying a plan. `errors` is per-row; one failure never stops the batch. */
export interface LocalCommandCleanupResult {
  rewritten: number;
  errors: { sessionId: string; error: Error }[];
}

/**
 * Plan the cleanup of ONE stored conversation, or null when it holds no
 * scaffolding at all.
 *
 * Only user messages are considered, exactly as `parseLogEntry` does: the
 * wrappers are something the harness writes into the user turn, so an assistant
 * message reproducing one is the agent talking.
 */
export function planConversationCleanup(stored: StoredConversation): LocalCommandCleanupItem | null {
  const kept = stored.messages.filter(
    m => !(m.role === 'user' && isLocalCommandScaffolding(m.text)),
  );
  const removed = stored.messages.length - kept.length;
  if (removed === 0) return null;

  const base: Omit<LocalCommandCleanupItem, 'cleaned'> = {
    sessionId: stored.sessionId,
    storedSummary: stored.summary,
    startedAt: stored.startedAt,
    removed,
  };

  // Nothing anyone said is left. Reported, never written, never deleted.
  if (kept.length === 0) return { ...base, cleaned: null };

  // Same derivation parseConversation uses, so a later re-read of the raw JSONL
  // writes back an identical row instead of flipping these fields.
  const timestamps = kept.map(m => m.timestamp).filter(t => t).sort();

  const cleaned: StoredConversation = {
    ...stored,
    messages: kept,
    summary: extractSummary({ messages: kept }),
    startedAt: timestamps[0] ?? null,
    endedAt: timestamps[timestamps.length - 1] ?? null,
    stats: {
      ...stored.stats,
      messageCount: kept.length,
      userMessageCount: kept.filter(m => m.role === 'user').length,
      assistantMessageCount: kept.filter(m => m.role === 'assistant').length,
      // subagentCount and totalTokens are untouched: no subagent transcript is
      // filtered, and usage comes from the raw JSONL rather than from the
      // messages that survived.
    },
  };

  return { ...base, cleaned };
}

/** Plan the cleanup across a whole store's worth of conversations, in input order. */
export function planLocalCommandCleanup(
  conversations: StoredConversation[],
): LocalCommandCleanupPlan {
  const rewrites: LocalCommandCleanupItem[] = [];
  const emptied: LocalCommandCleanupItem[] = [];
  for (const conversation of conversations) {
    const item = planConversationCleanup(conversation);
    if (!item) continue;
    (item.cleaned ? rewrites : emptied).push(item);
  }
  return { scanned: conversations.length, rewrites, emptied };
}

/**
 * Write a plan's rewrites back to the store.
 *
 * Goes straight to `storage.saveConversation`, NOT through
 * `saveConversationWithoutRegression`: that guard exists to stop a stale
 * CAPTURE from replacing a stored conversation with a shorter snapshot of
 * itself, and shortening is precisely what a human has asked for here. The
 * distinction is the source — a capture writes what a file said, this writes
 * what the current parser makes of what is already stored.
 *
 * `emptied` rows are not passed to storage at all.
 */
export async function applyLocalCommandCleanup(
  storage: Storage,
  plan: LocalCommandCleanupPlan,
  onRewritten?: (item: LocalCommandCleanupItem) => void,
): Promise<LocalCommandCleanupResult> {
  let rewritten = 0;
  const errors: { sessionId: string; error: Error }[] = [];
  for (const item of plan.rewrites) {
    if (!item.cleaned) continue;
    try {
      await storage.saveConversation(item.cleaned);
      rewritten++;
      onRewritten?.(item);
    } catch (err) {
      errors.push({
        sessionId: item.sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return { rewritten, errors };
}

/** Outcome of deleting a plan's content-free rows. `errors` is per-row. */
export interface LocalCommandDeletionResult {
  deleted: number;
  /** Already absent — an idempotent re-run, or something else removed it. */
  alreadyGone: number;
  errors: { sessionId: string; error: Error }[];
}

/**
 * Delete the rows that hold NOTHING but scaffolding.
 *
 * Only `plan.emptied` is ever passed to `deleteConversation`, and that bucket is
 * built by `planConversationCleanup` from the same predicate the parser applies:
 * a row is in it only when every single stored message is Claude Code
 * scaffolding, so there is nothing anyone said to lose. A row with one real
 * message is a `rewrite`, and rewrites are never deleted.
 *
 * The caller owns consent. This function never prompts and is never reached by
 * the doctor sweep, the daemon remedy path or the Settings page — the opt-in
 * flag on `lazy doctor --clean-local-command-conversations` is the only route.
 *
 * One failure never stops the batch: a store that refuses one row must not
 * strand the other thirteen.
 */
export async function deleteEmptiedConversations(
  storage: Storage,
  plan: LocalCommandCleanupPlan,
  onDeleted?: (item: LocalCommandCleanupItem) => void,
): Promise<LocalCommandDeletionResult> {
  let deleted = 0;
  let alreadyGone = 0;
  const errors: { sessionId: string; error: Error }[] = [];
  for (const item of plan.emptied) {
    try {
      if (await storage.deleteConversation(item.sessionId)) {
        deleted++;
        onDeleted?.(item);
      } else {
        alreadyGone++;
      }
    } catch (err) {
      errors.push({
        sessionId: item.sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return { deleted, alreadyGone, errors };
}

/**
 * The wrapper openings a stored SUMMARY can start with when the first stored
 * message was scaffolding.
 *
 * Why a separate, weaker test: a summary is the first LINE of the first user
 * message, capped at 200 characters, so the full-message predicate cannot be
 * applied to it — a truncated caveat has no closing tag. This is the cheap
 * signal the doctor CHECK uses, over the conversation INDEX, so a routine sweep
 * never parses 753 transcripts to tell a human that something is worth
 * cleaning.
 *
 * It is deliberately anchored at byte 0 and is a strict SUBSET of what the
 * remedy acts on: every row it flags holds a scaffolding message, while rows
 * whose scaffolding sits further down are cleaned by the remedy without the
 * check having counted them. A check that reported something the flag would not
 * act on is the failure mode worth avoiding; under-reporting only costs a
 * mention.
 */
const SUMMARY_OPENINGS = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
];

/** One line of a summary, elided — what a preview shows per conversation. */
export function elideSummary(summary: string, max = 64): string {
  const line = (summary ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.substring(0, max - 3)}...` : line;
}

/** Does this stored listing summary start with local-command scaffolding? */
export function summaryLooksLikeScaffolding(summary: string): boolean {
  const head = summary.trimStart();
  if (!SUMMARY_OPENINGS.some(opening => head.startsWith(opening))) return false;
  // A summary that NAMES a command is only scaffolding when that command is one
  // of the built-in housekeeping ones — the same rule the remedy applies, or
  // this check would flag a custom command's row that the remedy keeps.
  const named = /^<command-(?:name|message)>\s*\/?([^<\s]*)/.exec(head);
  if (named) return isHousekeepingCommandName(named[1] ?? '');
  return true;
}
