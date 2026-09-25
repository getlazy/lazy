/**
 * When a stored review turn "counts" — Reviews tab, accept gates, "last review".
 *
 * FINDINGS ARE THE ISSUE STORE. A review that finds something records it in
 * `report.findings` and the daemon delivers those findings to the implementer
 * as its next turn's feedback (src/review/auto-fix-message.ts). No Raise is
 * created, so nothing about a defect that was already fixed survives for a
 * human to triage afterwards. Raises stay for the one decision a person must
 * make — `needs_human` — and legacy reports carry their findings as
 * `raised_item_ids`, which is why both are read here.
 *
 * WHAT GATES ACCEPT: the latest review turn is not clean. "Clean" is
 * `reviewIsClean` (verdict `clean`, zero findings, zero raises, and no sweep
 * naming an issue no finding covers); everything else — `needs_work`,
 * `needs_human`, and a FAILED review whose verdict or sweeps would not parse —
 * holds accept until an agent work turn runs or a human overrides with
 * `lazy accept --allow-review-issues`. A failed review gating like `needs_work` is the point:
 * the first loop under this flow stored one `unparsed` review and accepted the
 * child anyway.
 *
 * ONE PREDICATE, READ EVERYWHERE, and it is load-bearing rather than tidy. The
 * daemon's §8.1 round accounting (`settleAutoReviewRound`) asks the SAME
 * question to decide whether a cycle finished cleanly, because a report this
 * gate holds and the accounting calls a clean pass is a dead end: the cycle is
 * over so nothing resets it, there are no findings for a fix turn to act on,
 * and no hand-back is journalled — a loop's child is refused at accept with
 * nothing saying why. Any new caller asking "was this review clean" calls
 * `reviewIsClean`; none re-spells it.
 */

import { reviewReportIsUnparsed } from './parse-report';
import {
  reviewIsClean,
  reviewSweepsClaimUncoveredIssue,
  resolveReviewVerdict,
} from './verdict';
import type { ReviewReport } from '../types/review-report';
import {
  reviewDispatchOf,
  reviewGateApplies,
  type ReviewGate,
  type ReviewMode,
} from './mode';

export interface ReviewTurnLike {
  sequence: number;
  role: string;
  turn_type?: string;
  review?: ReviewReport;
  created_at?: number;
  /**
   * How this review came to exist — 'auto' (the daemon dispatched a reviewer),
   * 'self' (the writer reviewed itself in session) or 'manual' (somebody asked
   * for it). Absent on turns recorded before the field existed, which
   * `reviewDispatchOf` reads as 'manual': the gating direction, and the one
   * those turns already had.
   */
  review_dispatch?: string;
  /**
   * Its findings were already applied by the same exchange — the `low_high`
   * revise pass. A review marked this way has nothing outstanding, whatever the
   * gate says.
   */
  review_addressed?: boolean;
}

/**
 * Whether a task's review settings let its latest review hold a merge.
 *
 * Bundled rather than passed as two loose arguments because every caller needs
 * both and neither means anything alone: the gate answers "does a review of
 * this kind count", and the mode is half of that answer.
 */
export interface ReviewGateContext {
  mode: ReviewMode;
  gate: ReviewGate;
}

/**
 * The gate context a caller that has not been taught about review settings
 * gets: the one that GATES. A gate may only fail in the restrictive direction,
 * so the fallback must be the strict pair, never the permissive one.
 */
export const GATING_REVIEW_CONTEXT: ReviewGateContext = { mode: 'separate', gate: 'auto' };

/**
 * Ordered raise ids a review produced. Prefers the stored list; empty when
 * absent (clean reviews, and every non-`needs_human` review under the current
 * contract).
 */
export function raisedItemIdsOf(report: ReviewReport | undefined | null): string[] {
  if (!report) return [];
  const ids = report.raised_item_ids;
  if (!ids || ids.length === 0) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Everything this review wants acted on: its findings, plus any Raises it
 * filed (the `needs_human` decision, or a legacy report's findings).
 */
export function reviewIssueCount(report: ReviewReport | undefined | null): number {
  if (!report) return 0;
  return report.findings.length + raisedItemIdsOf(report).length;
}

/**
 * The severities that HOLD ACCEPT on their own. Above medium, and no further.
 *
 * A finding is a reviewer's opinion about work a human is about to read
 * anyway; it is not a defect report that has been triaged. Holding the merge on
 * every `medium`/`low` one cost a full agent turn or a human per finding, and
 * the only override (`--allow-review-issues`) is CLI/TTY-only by design — so a
 * cluster's driver, told to "accept liberally", could not accept a child whose
 * review left nothing but style nits. That is the whole of the
 * `driver-accept-over-minor-findings` problem, and this is where it is solved:
 * the driver needs no override, because there is nothing to override.
 *
 * INVARIANT: this RELAXES the gate and never the accounting. `reviewIsClean` —
 * which `settleAutoReviewRound` reads to decide a cycle finished — still counts
 * every finding, so a medium finding is still `needs_work` there. The forbidden
 * shape is the reverse (the gate holding what the accounting calls clean),
 * which is a dead end with nothing to clear it; gate-permissive plus
 * accounting-strict merely means the findings ride along on a merge a person
 * decided to make, which is what a low-severity finding is for.
 *
 * Nothing here weakens the three things that still gate whatever their
 * severity: a FAILED (unparsed) review, an awaiting Raise, and a report whose
 * own security / data-integrity sweep names an issue no finding covers.
 */
export const REVIEW_GATING_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high']);

/** The findings from this report that hold accept — critical and high only. */
export function gatingFindingsOf(report: ReviewReport | undefined | null): ReviewReport['findings'] {
  if (!report) return [];
  return report.findings.filter((f) => REVIEW_GATING_SEVERITIES.has(f.severity));
}

/**
 * Whether a report still contains something that holds accept once its review
 * is in a gating arm. This is the single accounting rule shared by accept,
 * cluster hand-back, and the disregarded-review notice.
 */
export function reviewReportHasGatingIssue(
  report: ReviewReport,
  options: { addressedFindings?: boolean; awaitingRaiseCount?: number } = {},
): boolean {
  const ids = raisedItemIdsOf(report);
  const verdict = resolveReviewVerdict(report);
  return verdict === 'unparsed'
    || reviewSweepsClaimUncoveredIssue(report)
    || (!options.addressedFindings && gatingFindingsOf(report).length > 0)
    || (options.awaitingRaiseCount ?? ids.length) > 0
    || (verdict === 'needs_human' && ids.length === 0);
}

/**
 * True when this report counts as a formal review for Reviews / gates.
 *
 * A review COUNTS when it was recorded at all — including a FAILED one. That
 * is a deliberate widening from the raise-era rule ("unparsed with zero raises
 * never happened"): under that rule an unparsed review was invisible to every
 * gate, the dispatch dedup never re-reviewed the same final, and the task
 * simply parked looking un-reviewed. The failure is now visible and it gates
 * (see {@link reviewIssuesAwaitingWork}), which is what the run this contract
 * came from needed and did not have.
 */
export function isSuccessfulReviewReport(report: ReviewReport | undefined | null): boolean {
  return report != null;
}

/** True when the review FAILED: its verdict or its required sweeps did not parse. */
export function reviewFailed(report: ReviewReport | undefined | null): boolean {
  if (!report) return false;
  return reviewReportIsUnparsed(report);
}

/** A recorded review, with how it was started — the shape gates read. */
export interface RecordedReview {
  sequence: number;
  review: ReviewReport;
  created_at?: number;
  /** 'auto', 'self' or 'manual'; carried so a gate never re-finds the turn. */
  review_dispatch?: string;
  /** Already acted on by the exchange that produced it (the revise pass). */
  review_addressed?: boolean;
}

/** Agent review turns that count as reviews, newest first. */
export function successfulReviewTurnsOf(turns: ReviewTurnLike[]): RecordedReview[] {
  const found: RecordedReview[] = [];
  for (const turn of turns) {
    if (turn.role !== 'agent' || turn.turn_type !== 'review') continue;
    if (!isSuccessfulReviewReport(turn.review)) continue;
    found.push({
      sequence: turn.sequence,
      review: turn.review!,
      created_at: turn.created_at,
      ...(turn.review_dispatch !== undefined ? { review_dispatch: turn.review_dispatch } : {}),
      ...(turn.review_addressed ? { review_addressed: true } : {}),
    });
  }
  found.reverse();
  return found;
}

/** Most recent successful review, or null. */
export function latestSuccessfulReview(turns: ReviewTurnLike[]): RecordedReview | null {
  const list = successfulReviewTurnsOf(turns);
  return list[0] ?? null;
}

/**
 * A recorded review this task's settings are IGNORING, or null.
 *
 * ACCEPT MUST NEVER SILENTLY DISREGARD A REVIEW (engineer, 2026-09-21). A
 * review turn exists, somebody or something spent an agent turn producing it,
 * and the settings say it does not hold the merge — that is a legitimate
 * outcome and an invisible one, so accept says it in one line rather than
 * letting a human discover later that a report they never read had findings in
 * it.
 *
 * Null when there is no review, when the review DOES gate (accept refuses and
 * says so, which is its own notice), or when the review was clean — a clean
 * review being ignored is not information anyone needs.
 */
export function reviewDisregardedByGate(
  turns: ReviewTurnLike[],
  context: ReviewGateContext = GATING_REVIEW_CONTEXT,
): { sequence: number; review: ReviewReport; reason: string } | null {
  const latest = latestSuccessfulReview(turns);
  if (!latest) return null;
  if (reviewIsClean(latest.review)) return null;
  // Nothing outstanding to disregard: the revise pass applied it, or a work
  // turn has run since. The same two early returns the gate above takes — a
  // notice that fires on a review somebody already dealt with is one people
  // learn to scroll past, which costs the cases that DO mean something.
  if (latest.review_addressed) return null;
  if (hasWorkAgentTurnAfter(turns, latest.sequence)) return null;
  const dispatch = reviewDispatchOf(latest);
  if (reviewGateApplies(context.gate, context.mode, dispatch)) {
    // The gate APPLIED. Usually that means accept refuses and says so itself,
    // which is its own notice — but not always, and the exception is the case
    // the severity floor created: a `separate`-mode review that came back
    // `needs_work` with every finding at medium or below gates nothing, counts
    // zero outstanding, and merges in total silence. That is precisely a review
    // whose content a human never sees being disregarded, so it gets the line.
    //
    // Anything the gate will actually hold on returns null here, because accept
    // is about to refuse and name it. Raised items are excluded too: their state
    // decides, this function is not given it, and guessing would fire the notice
    // on a task accept is about to refuse anyway.
    if (reviewReportHasGatingIssue(latest.review)) {
      return null;
    }
    return {
      sequence: latest.sequence,
      review: latest.review,
      reason: 'its findings are all below the severity that holds a merge',
    };
  }

  // THE LOW-HIGH SELF-REVIEW UNDER THE DEFAULT GATE IS NOT "DISREGARDED"
  // either, even when its revise pass did not run (an approved review has
  // nothing to apply, and a failed one leaves the draft standing). It is the
  // expected shape of the default mode, not a review being ignored, and a line
  // on every accept of every default-mode task is exactly the noise above.
  //
  // Narrow on purpose: only a SELF-review, only under the default gate. Set
  // `never` and the notice returns, because there the human switched the gate
  // off deliberately and is owed the reminder.
  if (context.gate === 'auto' && dispatch === 'self') return null;

  const reason = context.gate === 'never'
    ? 'the review gate is set to `never`'
    : 'this task is in `' + context.mode + '` review mode';
  return { sequence: latest.sequence, review: latest.review, reason };
}

/**
 * The raised-item state the gate reads: enough to tell "nobody has acted on
 * this" from "the human already decided it".
 *
 * Structural, not a `RaisedItem` import, so this module stays free of the
 * storage types — the web page, the daemon and the CLI all call it.
 */
export interface RaisedItemStateLike {
  id: string;
  status: string;
  comment_delivered_at?: number | null;
}

/**
 * Does this review raise still need an agent turn?
 *
 * Only PROMOTION answers yes-to-no here, and it does so structurally: the item
 * became a task of its own, so the work is dispatched and tracked there and no
 * turn on THIS task is owed for it. A human who promoted a raise — and then
 * accepted the promoted subtask — was still being told to unblock the agent to
 * clear the gate, which is the bug this reads state to fix.
 *
 * Dismiss / acknowledge / respond deliberately keep gating: the rule that "the
 * agent must have had a turn to address them" is the recorded design of this
 * gate (see `test/unit/current-review.test.ts`, "checklist still names the
 * review-with-issues gate after every Raise is dismissed"), and narrowing it
 * further is the human's call, not this function's.
 *
 * An id with no matching record is treated as still awaiting: the gate never
 * opens on a raise it cannot see.
 */
export function raiseAwaitsAgentWork(item: RaisedItemStateLike | undefined): boolean {
  if (!item) return true;
  return item.status !== 'promoted_subtask' && item.status !== 'promoted_peer';
}

/**
 * Find the ONE raised item an id-or-prefix names, or undefined.
 *
 * A review records the ids it filed, and those may be short prefixes, so an
 * exact lookup alone would miss. But a prefix that matches SEVERAL items names
 * none of them: taking the first hit would read some other item's status and
 * could report "addressed" for an item nobody touched, opening an accept gate
 * on a live review issue. That is the permissive direction, which is the one
 * direction a gate may never fail in.
 *
 * So ambiguity is treated exactly like absence — undefined, which
 * {@link raiseAwaitsAgentWork} reads as "still awaiting" — and that is the
 * posture that function already documents for an id it cannot see. An EXACT id
 * always wins over any prefix candidates: a full id is unambiguous by
 * construction, even where it happens to prefix another.
 */
export function resolveRaisedItemByIdOrPrefix<T extends RaisedItemStateLike>(
  items: readonly T[],
  id: string,
): T | undefined {
  const exact = items.find((i) => i.id === id);
  if (exact) return exact;
  const candidates = items.filter((i) => i.id.startsWith(id) || id.startsWith(i.id));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * True when some agent *work* turn happened after `afterSequence`
 * (exclusive). Ask / sync / nudge / review do not count — only work
 * addresses review findings.
 */
export function hasWorkAgentTurnAfter(turns: ReviewTurnLike[], afterSequence: number): boolean {
  for (const turn of turns) {
    if (turn.role !== 'agent') continue;
    if (turn.sequence <= afterSequence) continue;
    const kind = turn.turn_type ?? 'work';
    if (kind === 'work') return true;
  }
  return false;
}

/**
 * The latest review is not clean and no work turn has run since. Accept must
 * refuse — same posture as unseen comments / open blocking raises.
 *
 * Four ways a review holds the gate, and they are one rule, not four:
 *   - it filed FINDINGS (`needs_work`) — the fixer owes a turn;
 *   - it filed a RAISE (`needs_human`, or a legacy report's findings) that is
 *     still awaiting work — `raisedItems` is how "awaiting" is decided, so
 *     pass them or every raise counts as outstanding;
 *   - it FAILED (unparsed verdict or unparsed sweeps) — nobody knows what it
 *     concluded, and "nobody knows" may not read as clean;
 *   - its own SWEEP names an issue no finding covers
 *     (`reviewSweepsClaimUncoveredIssue`) — a report that says it found a SQL
 *     injection may not read as clean because the findings array was empty.
 *
 * `hasWorkAgentTurnAfter` is what clears it without a fresh review: a work
 * turn un-finals the task (design §2.3), so the next final dispatches a new
 * review and THAT review's verdict is what gates from then on.
 */
export function reviewIssuesAwaitingWork(
  turns: ReviewTurnLike[],
  raisedItems: RaisedItemStateLike[] = [],
  /**
   * The task's review settings. Whether the latest review counts at all is
   * `reviewGateApplies`: under the default `auto` gate only a `separate` task's
   * DISPATCHED review does, plus any review somebody ASKED for, in any mode.
   *
   * Defaults to {@link GATING_REVIEW_CONTEXT} so a caller that has not been
   * taught about review settings fails closed rather than open.
   */
  context: ReviewGateContext = GATING_REVIEW_CONTEXT,
): {
  sequence: number;
  /** How many findings + still-awaiting raises the review left outstanding. */
  raiseCount: number;
  /** What the review concluded — `unparsed` when it failed. */
  verdict: ReturnType<typeof resolveReviewVerdict>;
  /**
   * The report itself, so a refusal can say WHICH failure this was rather than
   * listing every failure it might have been. A pre-contract verdict, an
   * unreadable sweep and a crashed reviewer all resolve `unparsed` and need
   * different sentences (`describeReviewFailureShort`).
   */
  review: ReviewReport;
} | null {
  const latest = latestSuccessfulReview(turns);
  if (!latest) return null;
  if (!reviewGateApplies(context.gate, context.mode, reviewDispatchOf(latest))) return null;
  if (reviewIsClean(latest.review)) return null;
  if (hasWorkAgentTurnAfter(turns, latest.sequence)) return null;

  const ids = raisedItemIdsOf(latest.review);
  const awaitingRaises = ids.filter((id) => raiseAwaitsAgentWork(
    resolveRaisedItemByIdOrPrefix(raisedItems, id),
  ));
  const verdict = resolveReviewVerdict(latest.review);
  // INVARIANT: `review_addressed` suppresses only the FINDINGS, never a verdict
  // or a sweep statement. It marks a review ALREADY ACTED ON by the exchange
  // that produced it — the `low_high` revise pass, which applies the
  // self-review's instructions seconds after they are written. The stored
  // report is the PRE-fix state and the revise phase is a supervised `nudge`
  // turn, so `hasWorkAgentTurnAfter` above cannot see it: without this a
  // project on `gate = "always"` could never land a task whose self-review
  // worked, which is the opposite of what that setting is for.
  //
  // But it was a blanket early return, which let the revise pass vouch for two
  // things it cannot have fixed. A `needs_human` verdict means a PERSON must
  // decide — by construction the one conclusion an in-session pass cannot
  // resolve — and a sweep naming an issue no finding covers is a claim about
  // the work, not a task list. Both must survive; only the findings the revise
  // pass could plausibly have applied are zeroed.
  const addressedFindings = latest.review_addressed === true;
  // Only findings ABOVE MEDIUM hold the merge — see REVIEW_GATING_SEVERITIES
  // for why, and for what the relaxation deliberately does not touch.
  const outstanding =
    (addressedFindings ? 0 : gatingFindingsOf(latest.review).length) + awaitingRaises.length;

  // A failed review holds the gate even with nothing outstanding to count:
  // its findings list is exactly what may not have parsed. So does a review
  // whose own sweep names an issue no finding covers — `reviewIsClean` already
  // refuses to call that clean, and this early return would otherwise let it
  // through the gate anyway, which is the same contradiction one layer down.
  // INVARIANT: a `needs_human` verdict that filed NO raise still holds the gate.
  // Normally the raise IS the tracking — a separate reviewer files one, and
  // resolving it is what lets the task land, which is why a resolved raise must
  // keep clearing here. But an in-session `low_high` self-review emits a report
  // and cannot file a raise at all, so a self-review concluding "a person must
  // decide" counted zero outstanding and merged in silence. Scoped to the
  // no-raise case precisely so resolving a reviewer's raise still works.
  if (!reviewReportHasGatingIssue(latest.review, {
    addressedFindings,
    awaitingRaiseCount: awaitingRaises.length,
  })) {
    return null;
  }

  return { sequence: latest.sequence, raiseCount: outstanding, verdict, review: latest.review };
}
