/**
 * The DERIVED answers a `show` carries, and the section vocabulary that names
 * them.
 *
 * `show` used to send raw records and leave the rules over them to whoever
 * rendered them, so every client that grew a task-record surface re-derived
 * three rules that CLAUDE.md says must live in exactly one place: which
 * comments the agent has not seen (`resolveNotesCutoff`), how turns group into
 * review chunks (`groupTurnsIntoChunks`), and what a review CONCLUDED
 * (`resolveReviewVerdict` — the closed set the accept gate reads). A Lazy Teams
 * port ended up carrying two of them in Ruby and refusing the third, which is
 * why its Reviews list disagreed with the daemon's own tab.
 *
 * The third rule USED to be "which agent reviews count"
 * (`isSuccessfulReviewReport`), and a review with no parseable sweeps and no
 * raises was omitted as if it had never happened. That inverted: a FAILED
 * review is listed, flagged `unparsed`, and gates accept exactly like
 * `needs_work` — hiding it was how a task whose only review was broken looked
 * un-reviewed on every surface while the gate said otherwise. What the wire now
 * has to carry is therefore the VERDICT the daemon resolved (`verdict_kind`),
 * not merely membership of a filtered list.
 *
 * Nothing here decides anything. Each function is a WIRE PROJECTION of the one
 * function that owns the rule: this module exists so the answer travels, not so
 * a second copy of the rule does. Never inline a cutoff comparison, a boundary
 * test or a success test here — call the owning function.
 *
 * Chunks and reviews are projected onto TURN SEQUENCES rather than whole turns:
 * a payload already carrying `turns` must not carry every turn twice, and a
 * sequence is the stable key every surface already links by.
 */

import type { Comment, Session, Turn } from '../types';
import { resolveNotesCutoff } from './turn-context';
import { resolveFinalState, finalHeadMovedLabel, type FinalState } from './final-state';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import {
  successfulReviewTurnsOf,
  raisedItemIdsOf,
  GATING_REVIEW_CONTEXT,
  type ReviewGateContext,
  type ReviewTurnLike,
} from '../review/success';
import { reviewGateApplies, reviewDispatchOf } from '../review/mode';
import { reviewReportIsUnparsed } from '../review/parse-report';
import { resolveReviewVerdict } from '../review/verdict';
import type { ResolvedReviewVerdict, ReviewFinding } from '../types/review-report';

/**
 * Every section `show` can be asked for by name.
 *
 * The first eight are the task's own records; `notes` and `reviews` are derived
 * answers with no raw record behind them. The list is exported because both the
 * RPC and the MCP tool validate against it — a section one surface honours and
 * the other rejects is the drift this whole module exists to end.
 */
export const SHOW_SECTION_NAMES = [
  'turns',
  'chunks',
  'commits',
  'comments',
  'journal',
  'children',
  'status-history',
  'tag-history',
  'notes',
  'reviews',
] as const;

export type ShowSection = (typeof SHOW_SECTION_NAMES)[number];

/**
 * Validate a caller's `sections` argument.
 *
 * `sections: null` means the caller did not ask — every section is served, which
 * is what `lazy show` and every pre-existing RPC caller rely on. An EMPTY array
 * is not the same thing: it asks for the summary and no sections at all, and is
 * honoured as such.
 *
 * Unknown names are returned rather than ignored so the caller gets a 400
 * naming them. Silently dropping one is exactly the failure that made a client
 * unable to tell a section that is empty from one that was never implemented.
 */
export function parseShowSections(value: unknown): {
  sections: ShowSection[] | null;
  invalid: string[];
} {
  if (value === undefined || value === null) return { sections: null, invalid: [] };
  if (!Array.isArray(value)) return { sections: null, invalid: ['(not an array)'] };
  const valid = new Set<string>(SHOW_SECTION_NAMES);
  const sections: ShowSection[] = [];
  const invalid: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !valid.has(entry)) {
      invalid.push(typeof entry === 'string' ? entry : String(entry));
      continue;
    }
    if (!sections.includes(entry as ShowSection)) sections.push(entry as ShowSection);
  }
  return { sections, invalid };
}

/** Does this request want `section` served in full? */
export function wantsSection(sections: ShowSection[] | null, section: ShowSection): boolean {
  return sections === null || sections.includes(section);
}

// --- Notes delivery -------------------------------------------------------

/** What the agent has and has not been shown, resolved once, in the daemon. */
export interface ShowNotesState {
  /**
   * The resolved cutoff from {@link resolveNotesCutoff} — the last DELIVERY,
   * not the last agent turn. Null when the agent has answered nothing yet, in
   * which case every comment is queued.
   */
  cutoff: number | null;
  /** Comment ids the next prompt will carry, oldest first. */
  queued_ids: string[];
  delivered_count: number;
  queued_count: number;
}

/**
 * Has the agent been shown this comment?
 *
 * The comparison lives here, once, so that a client never has to make it: a
 * remote surface holding a cutoff timestamp and a list of comments is one
 * `>=`-instead-of-`>` away from telling a human their feedback was delivered
 * when the next prompt is about to carry it again.
 */
export function commentIsDelivered(comment: Comment, cutoff: number | null): boolean {
  if (cutoff === null) return false;
  return comment.created_at <= cutoff;
}

export function buildNotesState(
  session: Pick<Session, 'notes_delivered_through'> | null | undefined,
  turns: Turn[],
  comments: Comment[],
): ShowNotesState {
  const cutoff = resolveNotesCutoff(session, turns);
  const queued = comments
    .filter((c) => !commentIsDelivered(c, cutoff))
    .sort((a, b) => (a.created_at !== b.created_at
      ? a.created_at - b.created_at
      : a.id.localeCompare(b.id)));
  return {
    cutoff,
    queued_ids: queued.map((c) => c.id),
    delivered_count: comments.length - queued.length,
    queued_count: queued.length,
  };
}

// --- Chunks ---------------------------------------------------------------

/** One review chunk, as sequences into the payload's `turns`. */
export interface ShowChunk {
  index: number;
  /**
   * Sequence of the human/builder turn that opens the chunk, or null for a
   * leading run of automation turns that precedes any intervention.
   */
  boundary_sequence: number | null;
  /** Every turn in the chunk, in sequence order, boundary included. */
  turn_sequences: number[];
}

export function buildShowChunks(turns: Turn[]): ShowChunk[] {
  return groupTurnsIntoChunks(turns).map((chunk) => ({
    index: chunk.index,
    boundary_sequence: chunk.boundary ? chunk.boundary.sequence : null,
    turn_sequences: chunk.turns.map((t) => t.sequence),
  }));
}

// --- Reviews --------------------------------------------------------------

/**
 * A formal agent review that COUNTS — the same set the Reviews tab lists and
 * the accept gate reads, newest first.
 *
 * A FAILED review (unparsed verdict or unparsed sweeps) is listed too, flagged
 * `unparsed`, because it gates accept exactly like `needs_work`: hiding it was
 * how a task with one broken review looked un-reviewed and got accepted. The
 * same predicate gates accept, so a client re-implementing it would be holding
 * a second copy of a merge gate in another language.
 */
export interface ShowReview {
  /** Sequence of the review turn, for linking to it. */
  sequence: number;
  created_at: number | null;
  /** The reviewer's own verdict text, verbatim. */
  verdict: string;
  /** What that text RESOLVES to: `clean` / `needs_work` / `needs_human` / `unparsed`. */
  verdict_kind: ResolvedReviewVerdict;
  /** The required security sweep statement (`"unparsed"` when unreadable). */
  security: string;
  /** The required data-integrity sweep statement. */
  data_integrity: string;
  /** The issues this review wants fixed — the fix turn's feedback. */
  findings: ReviewFinding[];
  /**
   * Ids of the Raises this review filed, in order. Under the current contract
   * that is the `needs_human` decision only; legacy reports list every finding.
   */
  raised_item_ids: string[];
  /**
   * True when the verdict or a required statement was unreadable — a FAILED
   * review. It still counts and still gates; the banner says why.
   */
  unparsed: boolean;
  /** How this review was started; one of `auto`, `self`, or `manual`. */
  dispatch: string;
  /** Whether the exchange that produced it already acted on its findings. */
  addressed: boolean;
  /** The daemon's answer to whether this review's kind holds the merge. */
  gates: boolean;
}

/**
 * A stored `Turn` spells its clock `timestamp`; `ReviewTurnLike` spells it
 * `created_at`, and the field is optional — so handing raw turns to this
 * function type-checked and served `created_at: null` on every review, on both
 * the RPC and the MCP tool. The rename belongs here, in the projection, rather
 * than in each caller: the daemon's own Reviews tab did it inline and the two
 * remote surfaces did not, which is the drift this module exists to end.
 */
export function buildShowReviews(
  turns: Array<ReviewTurnLike & { timestamp?: number }>,
  context: ReviewGateContext = GATING_REVIEW_CONTEXT,
): ShowReview[] {
  const dated = turns.map((turn) => (
    turn.created_at === undefined && typeof turn.timestamp === 'number'
      ? { ...turn, created_at: turn.timestamp }
      : turn
  ));
  return successfulReviewTurnsOf(dated).map((record) => ({
    sequence: record.sequence,
    created_at: record.created_at ?? null,
    dispatch: reviewDispatchOf(record),
    addressed: record.review_addressed === true,
    gates: reviewGateApplies(context.gate, context.mode, reviewDispatchOf(record)),
    verdict: record.review.verdict,
    verdict_kind: resolveReviewVerdict(record.review),
    security: record.review.security,
    data_integrity: record.review.data_integrity,
    findings: record.review.findings,
    raised_item_ids: raisedItemIdsOf(record.review),
    unparsed: reviewReportIsUnparsed(record.review),
  }));
}

// --- Final (pencils down) ------------------------------------------------

/**
 * Whether the task has been declared done, and everything a surface must say
 * about it — including the "head has since moved" line, composed HERE so the
 * CLI, the web page and a remote client cannot word it three ways.
 *
 * Null means NOBODY HAS DECLARED THIS WORK DONE, which is itself an answer a
 * surface shows. It does not mean "not asked for": the field is never
 * section-gated, for the same reason `raisedItems` is not — a client that has
 * to ask for an answer by name is a client that renders the page without it.
 */
export interface ShowFinal extends FinalState {
  /** The ready-to-print label, or null when the claim is still at the head. */
  head_moved_label: string | null;
}

export function buildShowFinal(turns: Turn[]): ShowFinal | null {
  const state = resolveFinalState(turns);
  if (!state) return null;
  return { ...state, head_moved_label: finalHeadMovedLabel(state) };
}

/**
 * The code of the task each promoted raise BECAME, filled in on read.
 *
 * A promotion made at unblock or accept used to record only the new task's
 * id, so those records carry no code and every task page read "→ task". New
 * promotions record the code; this fills it in for records that lack one. The
 * project-wide raised listing resolves it from the live task; the task's own
 * raised items must carry the same answer, so no client has to look it up.
 */
export async function withPromotedTaskCodes<T extends { promoted_task_id?: string | null; promoted_task_code?: string | null }>(
  items: T[],
  getTask: (id: string) => Promise<{ code?: string | null } | null>,
): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    if (!item.promoted_task_id || item.promoted_task_code) return item;
    const code = (await getTask(item.promoted_task_id))?.code;
    return code ? { ...item, promoted_task_code: code } : item;
  }));
}
