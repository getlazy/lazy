/**
 * Structured record of an agent review (`lazy review` / `lazy_review`).
 *
 * Kept small on purpose: a fat report type is a migration the first time
 * anyone wants a new field. Per-finding location is optional — a finding that
 * is about the change as a whole has no file or line.
 *
 * The report lives on the task and nowhere else. Lazy does not write it to a
 * PR/MR (engineer decision, 2026-09-21) — see `RepositoryDriver.approveForMerge`.
 *
 * Distinct from {@link Review} (a human verdict on one commit). This is the
 * output of a review *turn*.
 */

export const REVIEW_FINDING_CATEGORIES = [
  'security',
  'data-integrity',
  'correctness',
  'tests',
  'incomplete',
  'style',
] as const;

export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

export const REVIEW_FINDING_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

/** One issue the reviewer found. */
export interface ReviewFinding {
  /** Repo-relative path. Absent when the finding is about the change as a whole. */
  file?: string;
  /** 1-based line in that file, when the finding pins to one. */
  line?: number;
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  /** One-line description of what is wrong and why it matters. */
  summary: string;
}

/**
 * The three things a review may conclude. A FIXED vocabulary, not free text.
 *
 * The first driver to run under the final-turn flow produced six spellings of
 * three ideas across nine reviews (approve / clean / pass / needs_work /
 * request_changes / needs_decision), twice put prose in the verdict field, and
 * once stored `unparsed` — which the driver then accepted anyway. A verdict is a
 * decision the daemon acts on (auto-fix, park, count a round), so it is a
 * closed set and anything outside it is a FAILED review, never a guess.
 *
 * - `clean` — nothing to fix. Clears the accept gate.
 * - `needs_work` — findings the fixer can address. They come back as feedback
 *   on the next work turn, not as Raises a human has to triage.
 * - `needs_human` — the task cannot be completed without compromising security
 *   or data integrity, or its goal is self-contradictory. The ONLY case where
 *   the reviewer also files a blocking Raise, because it is the only case a
 *   person must decide.
 */
export const REVIEW_VERDICTS = ['clean', 'needs_work', 'needs_human'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** A verdict outside the closed set: the review FAILED, and gates like `needs_work`. */
export const REVIEW_VERDICT_UNPARSED = 'unparsed';

/** What {@link ReviewReport.verdict} resolves to — the closed set, or a failure. */
export type ResolvedReviewVerdict = ReviewVerdict | typeof REVIEW_VERDICT_UNPARSED;

/**
 * The reviewer's report as stored on the review agent turn.
 *
 * `security` and `data_integrity` are required strings. The prompt demands an
 * explicit "none found" when the sweep is clean — silence is not a clean bill
 * of health. A parser that cannot find those statements stores `"unparsed"`
 * rather than inventing a pass.
 *
 * `findings` IS the issue store. A finding is fix FEEDBACK: it reaches the
 * implementer as the prompt of its next turn, exactly as a reviewing human's
 * unblock would, and no Raise is created for it. Raises are reserved for the
 * one decision a person must make (`needs_human`), and `raised_item_ids` is
 * the provenance list for those — plus, on legacy reports, for the findings
 * that used to be filed that way.
 */
export interface ReviewReport {
  /**
   * The reviewer's own verdict text. Resolve it to a decision with
   * `resolveReviewVerdict` (src/review/verdict.ts) — never compare it by hand:
   * the raw string is kept verbatim (legacy reports hold free prose here) and
   * the closed set lives in ONE resolver.
   */
  verdict: string;
  /** Explicit security statement. `"none found"` when the sweep was clean. */
  security: string;
  /** Explicit data-integrity statement. `"none found"` when the sweep was clean. */
  data_integrity: string;
  /** The issues to fix. Empty on a `clean` review. */
  findings: ReviewFinding[];
  /**
   * Ordered ids of the BLOCKING Raises this review filed — what it left for
   * somebody to act on. Under the current contract that is the `needs_human`
   * decision and nothing else; on legacy reports it is every finding, which is
   * why the gate and the round accounting still read it alongside `findings`.
   *
   * A reviewer's NON-blocking FYI is deliberately absent: it is orthogonal by
   * definition, so it must not make a clean review gate or spend a fix round.
   * It is still a Raise on the task, with its own provenance back to this turn
   * (src/review/recover-findings.ts).
   */
  raised_item_ids?: string[];
}
