/**
 * Make sure a review turn's findings survive, whatever the reviewer managed to
 * emit.
 *
 * FINDINGS ARE FIX FEEDBACK, NOT RAISES. A review that finds something records
 * it in `report.findings`; the daemon hands those findings to the implementer
 * as its next turn's prompt, exactly as a reviewing human's unblock would. No
 * Raise is filed, so nothing survives afterwards for a person to triage about a
 * defect that was fixed two turns later. That is the whole change from the
 * previous contract, and it is why this module no longer creates Raises from a
 * verdict: the raise-per-finding flow cost two dead turns per review round (the
 * fixer's next `lazy_final` was refused by the reviewer's own blocking raise,
 * and the parent had to resolve each one by hand).
 *
 * The ONE exception is preserved: a reviewer may file a blocking Raise when the
 * task cannot be completed without compromising security or data integrity, or
 * its goal is self-contradictory — the `needs_human` verdict. That is a
 * decision, and only a person makes it. Security and data-integrity defects
 * that CAN be fixed are findings, never decisions.
 *
 * What this module still does, in order, when a review turn is recorded:
 *   1. Persist `agent_handoff` entries (turn-handoff.jsonl) attributed to this
 *      review turn — journal entries, and the `needs_human` raise when MCP was
 *      down. Findings never travel this way: they are in the verdict JSON, and
 *      the agent's final message always reaches the supervisor.
 *   2. Synthesize a FINDING for any required sweep that names an issue no
 *      finding covers, so "I found a SQL injection" in the security statement
 *      cannot evaporate because the reviewer forgot the findings array.
 *   3. Attach the ids of Raises attributed to this turn as `raised_item_ids`.
 */

import type { Storage } from '../storage/interface';
import type { AgentHandoffEntry } from '../protocol/types';
import type { ReviewFinding, ReviewReport } from '../types/review-report';
import { reviewSweepClaimsIssue } from './verdict';
import { logger } from '../utils/logger';

/**
 * The sweep predicate lives in `./verdict` — `reviewIsClean` reads it too, so a
 * report naming a security issue cannot read as a clean bill of health on the
 * paths this synthesis never ran over. Re-exported here because this module is
 * where it was born and where its callers look for it.
 */
export { reviewSweepClaimsIssue } from './verdict';

export interface RecoverReviewFindingsOpts {
  storage: Storage;
  taskId: string;
  sessionId: string;
  turnSequence: number;
  report: ReviewReport;
  /** Handoff entries collected by the supervisor when MCP was unreachable. */
  agentHandoff?: AgentHandoffEntry[];
}

/**
 * Persist handoff entries, cover the sweeps, and attach ordered
 * `raised_item_ids`. Mutates and returns `report`.
 *
 * `raised_item_ids` carries the raises this review left for someone to ACT on,
 * which under this contract means the BLOCKING ones — the `needs_human`
 * decision. See {@link raisedIdsForReviewTurn} for why the filter lives here.
 */
export async function recoverAndAttachReviewFindings(
  opts: RecoverReviewFindingsOpts,
): Promise<ReviewReport> {
  const { storage, taskId, sessionId, turnSequence, report, agentHandoff } = opts;

  const dedupedBlockingIds = await persistReviewHandoffEntries({
    storage,
    taskId,
    sessionId,
    turnSequence,
    agentHandoff,
  });

  ensureSweepsAreCovered(report, taskId);

  const ownIds = await raisedIdsForReviewTurn(storage, taskId, sessionId, turnSequence);
  // A blocking handoff raise that DEDUPED to an identical row from an earlier
  // turn created no new row, so the turn-scoped lookup above cannot see it —
  // and the review would carry no raised item at all, having just filed a
  // `needs_human` decision. Attribution is per REVIEW, not per row: this review
  // said it, so this review names it. (The dedupe itself stays: two identical
  // open rows are two things for a human to resolve, saying one thing.)
  const raisedIds = [...new Set([...ownIds, ...dedupedBlockingIds])];
  if (raisedIds.length > 0) {
    report.raised_item_ids = raisedIds;
  }

  return report;
}

/**
 * A sweep that names an issue must appear in `findings`, or the fixer never
 * hears about it.
 *
 * The reviewer is asked for both, and normally gives both. When it gives only
 * the statement, the statement BECOMES a finding rather than being ingested as
 * a blocking Raise the way it used to be: a fixable security defect is a
 * finding under this contract ("we never let those through, so there is nothing
 * to decide"), and parking the task on it would be the round-burning behaviour
 * this pass exists to remove.
 *
 * Coverage is deliberately category-level, not text-matching: if the reviewer
 * filed ANY security finding, its security statement is considered covered.
 * Matching prose against prose would produce duplicates on every review that
 * summarised its own findings in the statement.
 */
export function ensureSweepsAreCovered(report: ReviewReport, taskId?: string): void {
  const added: string[] = [];
  const cover = (
    field: 'security' | 'data_integrity',
    category: ReviewFinding['category'],
    label: string,
  ): void => {
    const statement = report[field];
    if (!reviewSweepClaimsIssue(statement)) return;
    if (report.findings.some((f) => f.category === category)) return;
    report.findings.push({
      severity: 'critical',
      category,
      summary: `${label}: ${statement.trim()}`,
    });
    added.push(field);
  };

  cover('security', 'security', 'Security sweep');
  cover('data_integrity', 'data-integrity', 'Data-integrity sweep');

  if (added.length > 0) {
    logger.info(
      `Task ${(taskId ?? '').substring(0, 8)}: review named ${added.join(' and ')} ` +
      `issue(s) with no matching finding — recorded the sweep statement(s) as findings ` +
      `so the fix turn receives them.`,
    );
  }
}

/**
 * Persist raised (and journal) handoff entries attributed to this review turn.
 * Best-effort: a handoff persist failure must not fail the review turn itself,
 * but it is warned — lost findings are what this path exists to prevent.
 *
 * Returns the ids of BLOCKING entries that deduped to a row this task already
 * had. Those rows belong to an earlier turn, so the turn-scoped stamp
 * ({@link raisedIdsForReviewTurn}) cannot see them — and a review that filed a
 * `needs_human` decision would carry no raised item at all, every time the
 * reviewer phrased the same decision the same way twice. Deduping the ROW and
 * losing the ATTRIBUTION are separate things; only the first is wanted.
 */
async function persistReviewHandoffEntries(opts: {
  storage: Storage;
  taskId: string;
  sessionId: string;
  turnSequence: number;
  agentHandoff?: AgentHandoffEntry[];
}): Promise<string[]> {
  const entries = opts.agentHandoff;
  if (!entries || entries.length === 0) return [];

  const taskShort = opts.taskId.substring(0, 8);
  let existingJournal: string[] = [];
  let existingRaised = new Map<string, string>();
  try {
    existingJournal = (await opts.storage.getTaskJournal(opts.taskId)).map((e) => e.content);
    // Content → id. First writer wins, so the OLDEST identical row is the one
    // attributed — the one a human may already be looking at.
    for (const item of await opts.storage.getTaskRaisedItems(opts.taskId)) {
      if (!existingRaised.has(item.content)) existingRaised.set(item.content, item.id);
    }
  } catch (err) {
    logger.debug(
      `Task ${taskShort}: could not read journal/raised for review handoff dedup — ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const dedupedBlockingIds: string[] = [];
  let recorded = 0;
  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) continue;
    const blocking = entry.kind === 'raised' && entry.blocking === true;
    try {
      if (entry.kind === 'journal') {
        if (existingJournal.includes(content)) continue;
        await opts.storage.appendJournalEntry(opts.taskId, content, 'agent');
        existingJournal.push(content);
        recorded++;
        continue;
      }
      // `followup` is the legacy non-blocking spelling.
      const existingId = existingRaised.get(content);
      if (existingId !== undefined) {
        // Same decision, already on the record: no second row, but THIS review
        // is what filed it now, so the id still rides on this report.
        if (blocking) dedupedBlockingIds.push(existingId);
        continue;
      }
      const created = await opts.storage.createRaisedItem(opts.taskId, {
        content,
        blocking,
        session_id: opts.sessionId,
        turn_sequence: opts.turnSequence,
      });
      existingRaised.set(content, created.id);
      recorded++;
    } catch (err) {
      logger.warn(
        `Task ${taskShort}: could not persist a review-turn handoff ${entry.kind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (recorded > 0) {
    logger.info(
      `Task ${taskShort}: recorded ${recorded} review-turn handoff entr` +
      `${recorded === 1 ? 'y' : 'ies'} (MCP was unreachable)`,
    );
  }
  return dedupedBlockingIds;
}

/**
 * The BLOCKING raises attributed to this review turn, oldest first.
 *
 * INVARIANT: only blocking raises are stamped onto the report. Every consumer
 * of `raised_item_ids` treats it as "what this review left for someone to act
 * on" — the accept gate, the round accounting, the auto-fix brief, the Reviews
 * tab — and under this contract that is the `needs_human` decision and nothing
 * else. A reviewer may still file a NON-blocking FYI about something orthogonal
 * it noticed (the tool instructions invite exactly that, and it is the normal
 * output of a good reviewer), and such an item must not make a `clean` review
 * read as unclean.
 *
 * Without this filter a reviewer that returned `clean` with zero findings and
 * one FYI produced: a fix turn whose brief said "found 0 issues, fix each one
 * below", a spent round from the loop's budget, and an accept refused for "1
 * unaddressed issue" on a review that had just said the work was clean.
 *
 * The filter is HERE, at the stamp, rather than at the readers, for two
 * reasons. One place instead of four. And legacy reports keep the lists they
 * were already written with: under the raise-era contract a medium-severity
 * finding became a non-blocking raise, so filtering at read time would have
 * quietly opened the gate on old reviews whose findings were never addressed.
 *
 * The FYI is not lost — it is a Raise on the task like any other, carrying its
 * own `session_id` / `turn_sequence` provenance back to this review turn.
 */
async function raisedIdsForReviewTurn(
  storage: Storage,
  taskId: string,
  sessionId: string,
  turnSequence: number,
): Promise<string[]> {
  try {
    const items = await storage.getTaskRaisedItems(taskId);
    return items
      .filter(
        (i) =>
          i.session_id === sessionId
          && i.turn_sequence === turnSequence
          && i.blocking === true,
      )
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map((i) => i.id);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not list Raises for review turn #${turnSequence} — ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
