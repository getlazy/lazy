/**
 * ONE resolver decides what a review concluded.
 *
 * `ReviewReport.verdict` is stored as the reviewer wrote it — legacy reports
 * hold free prose there, and the raw text is what the turn page shows. The
 * DECISION the daemon acts on (auto-fix, park, count a round, gate accept) is
 * derived from it here and nowhere else, against the closed set in
 * `src/types/review-report.ts`.
 *
 * Why a closed set at all: the first driver to run under the final-turn flow
 * produced six spellings of three ideas across nine reviews, twice put prose in
 * the verdict field, and once stored `unparsed` — which the driver then accepted
 * anyway. Every one of those is the same failure, a decision surface that
 * accepted whatever it was handed.
 *
 * WHAT IS AND IS NOT NORMALISED. Punctuation, case, and the space/hyphen/
 * underscore spellings of a single word are normalised, because they are the
 * same token typed differently. SYNONYMS ARE NOT: "approve", "pass", "LGTM"
 * and "request changes" are deliberately unparsed, so the prompts and the
 * parser cannot drift apart silently — a reviewer that does not say one of the
 * three words gets re-asked once (the supervisor's `review_reask`), and if it
 * still will not, the review FAILED and gates accept. A synonym table would
 * make that drift invisible, which is the bug this exists to close.
 */

import {
  REVIEW_VERDICTS,
  REVIEW_VERDICT_UNPARSED,
  type ResolvedReviewVerdict,
  type ReviewReport,
  type ReviewVerdict,
} from '../types/review-report';

const VERDICT_SET = new Set<string>(REVIEW_VERDICTS);

/**
 * Normalise one word's spelling — case, surrounding punctuation, and the
 * space/hyphen/underscore variants of the same token. Nothing else.
 */
function normalizeVerdictToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/g, '')
    .replace(/[\s-]+/g, '_');
}

/**
 * The verdict a raw string states, or `unparsed`.
 *
 * Exported separately from {@link resolveReviewVerdict} because the SUPERVISOR
 * decides whether to re-ask from the agent's raw final message, before any
 * report exists.
 */
export function parseVerdictText(raw: string | undefined | null): ResolvedReviewVerdict {
  if (raw == null) return REVIEW_VERDICT_UNPARSED;
  const token = normalizeVerdictToken(raw);
  return VERDICT_SET.has(token) ? (token as ReviewVerdict) : REVIEW_VERDICT_UNPARSED;
}

/**
 * What this report concluded.
 *
 * A report whose required sweeps did not parse is `unparsed` whatever its
 * verdict says: the two statements are part of the contract, and a report that
 * skipped them has not been read the way the prompt asked for. That keeps
 * "silence is not a pass" (parse-report.ts) true for the verdict too.
 */
export function resolveReviewVerdict(
  report: ReviewReport | undefined | null,
): ResolvedReviewVerdict {
  if (!report) return REVIEW_VERDICT_UNPARSED;
  if (
    report.security === REVIEW_VERDICT_UNPARSED
    || report.data_integrity === REVIEW_VERDICT_UNPARSED
  ) {
    return REVIEW_VERDICT_UNPARSED;
  }
  return parseVerdictText(report.verdict);
}

/**
 * Ways a reviewer says "this sweep found nothing" as the OPENING of a longer
 * statement — "none found — the diff adds no new untrusted-input boundary".
 *
 * A well-written sweep explains WHY nothing was found, and that is the normal
 * output of a good reviewer rather than an edge case. Matching the opener lets
 * the explanation follow.
 */
const CLEAN_SWEEP_OPENERS = [
  'none found',
  'no issues found',
  'nothing found',
  'none identified',
];

/**
 * Ways a reviewer says it as the WHOLE statement, matched exactly rather than
 * as a prefix.
 *
 * The split is deliberate and each entry earned its side. `none` as a prefix
 * would read "none of the writes are atomic — the migration can half-apply" as
 * clean; `no issues` as a prefix would read "no issues in the new code, but the
 * existing retry swallows a failed write" as clean. Both are real sentences a
 * reviewer writes, and reading either as clean is the one direction this
 * predicate must not fail in. The longer forms (`none found`, `no issues
 * found`) are unambiguous enough to carry an explanation after them.
 */
const CLEAN_SWEEP_EXACT = ['none', 'nothing', 'no issues', 'n/a', 'na'];

/** Trim, lowercase, collapse whitespace, drop trailing punctuation. */
function normalizeSweep(statement: string): string {
  return statement
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/, '');
}

/**
 * `normalized` starts with `opener` AND ends there or continues with a
 * separator — so "none found" and "none found — why" are clean while
 * "none foundry issues" is not.
 */
function opensWith(normalized: string, opener: string): boolean {
  if (!normalized.startsWith(opener)) return false;
  const rest = normalized.slice(opener.length);
  return rest === '' || /^[\s.,;:!?—–-]/.test(rest);
}

/**
 * True when a required sweep string claims a real issue (not clean, not the
 * `unparsed` sentinel).
 *
 * Lives here, with the other rules about what a report CONCLUDED, because two
 * things read it: `ensureSweepsAreCovered` (which turns such a statement into a
 * finding when the reviewer filed none) and {@link reviewIsClean} (which must
 * not read a report that names a security issue as a clean bill of health,
 * whether or not the synthesis ran over it).
 *
 * MATCHED ON A NORMALISED PREFIX, not by exact equality, and the difference is
 * a real defect rather than tidiness. Exact equality against `'none found'`
 * meant a single trailing period — which models add constantly — read as a
 * claim, and `ensureSweepsAreCovered` then synthesised a `critical` / `security`
 * finding whose entire content was the words "None found.". On a `clean`
 * verdict that gated accept, spent an auto-fix round, and on a cluster's child
 * spent one of its `max_child_fix_rounds` too: a cap reachable on nothing.
 *
 * The review that caught this demonstrated it. Its own sweep read
 * `"none found — the diff adds no new untrusted-input boundary; …"`, which under
 * the old comparison claims an issue — so a clean review of this very branch
 * would have manufactured a critical security finding and refused its own
 * accept.
 *
 * WHICH DIRECTION IT FAILS IN. A false positive costs a bogus critical finding,
 * a wasted round and a gate, and needs NO reviewer mistake. A false negative —
 * a sweep that opens "none found" and then describes a real issue — needs the
 * reviewer to contradict itself AND to have filed no finding of that category,
 * since coverage is category-level. Two mistakes at once versus none; the
 * prefix match is the safe side.
 */
export function reviewSweepClaimsIssue(statement: string | undefined | null): boolean {
  if (statement == null) return false;
  const normalized = normalizeSweep(statement);
  if (!normalized) return false;
  if (normalized === REVIEW_VERDICT_UNPARSED) return false;
  if (CLEAN_SWEEP_EXACT.includes(normalized)) return false;
  return !CLEAN_SWEEP_OPENERS.some((opener) => opensWith(normalized, opener));
}

/**
 * True when a required sweep NAMES an issue that no finding covers.
 *
 * The coverage rule is `ensureSweepsAreCovered`'s, deliberately: category-level,
 * so a reviewer that filed any `security` finding has covered its security
 * statement and nothing is double-counted.
 *
 * Read as a SECOND line of defence rather than as the primary path. Normally
 * the synthesis runs at the moment the review turn is recorded and the
 * statement becomes a finding, which makes the report unclean by the ordinary
 * rule. But the synthesis runs on ONE code path while the cleanliness question
 * is asked from elsewhere — the accept gate (`reviewIssuesAwaitingWork`) and
 * the §8.1 round accounting (`settleAutoReviewRound`), both through
 * `reviewIsClean`. A report that reached storage another way — recorded before
 * the synthesis existed, or by a path that never called it — said "I found a
 * SQL injection", listed no finding, and read as a CLEAN bill of health to
 * both. A report that names an issue is not clean, however it got here.
 */
export function reviewSweepsClaimUncoveredIssue(
  report: ReviewReport | undefined | null,
): boolean {
  if (!report) return false;
  const uncovered = (
    field: 'security' | 'data_integrity',
    category: string,
  ): boolean =>
    reviewSweepClaimsIssue(report[field])
    && !report.findings.some((f) => f.category === category);
  return uncovered('security', 'security') || uncovered('data_integrity', 'data-integrity');
}

/**
 * True when this report is a clean bill of health: it said `clean`, filed
 * nothing, and its own sweeps named nothing.
 *
 * Every half is load-bearing, and the conjunction is deliberate rather than
 * defensive: a reviewer that writes `clean` and then lists three findings — or
 * writes `clean` and then describes a SQL injection in its security statement —
 * has contradicted itself, and the direction a gate may never fail in is the
 * permissive one. The issue wins. (Legacy reports carry their issues as
 * `raised_item_ids`, so those count as issues too.)
 */
export function reviewIsClean(report: ReviewReport | undefined | null): boolean {
  if (!report) return false;
  if (resolveReviewVerdict(report) !== 'clean') return false;
  if (report.findings.length > 0) return false;
  if (reviewSweepsClaimUncoveredIssue(report)) return false;
  return (report.raised_item_ids ?? []).length === 0;
}

/** Human-readable label for a resolved verdict, for turn pages and CLI output. */
export function reviewVerdictLabel(verdict: ResolvedReviewVerdict): string {
  switch (verdict) {
    case 'clean': return 'clean';
    case 'needs_work': return 'needs work';
    case 'needs_human': return 'needs a human decision';
    default: return 'FAILED REVIEW (unparsed verdict)';
  }
}

/**
 * Heading marking the ONE re-ask in a review turn's content.
 *
 * Lives here, with the verdict rules, because three places write or look for
 * it — the supervisor that performs the re-ask, the daemon that appends it to
 * the turn, and the reconciler's supervised-heading map.
 */
export const REVIEW_REASK_HEADING = '## Re-asked for the verdict block';

/**
 * Which report a review turn records, given the first reply and the ONE re-ask.
 *
 * The re-ask exists because a verdict outside the closed set makes the whole
 * review unusable — the daemon cannot auto-fix, park or gate on it. But the
 * re-ask is a narrow question ("send the JSON block alone"), so its answer
 * REPLACES the first one only when it actually resolves to a verdict. A re-ask
 * that came back as prose too, or crashed, leaves the first report standing and
 * the review is recorded as FAILED — which is the honest outcome and the one
 * that gates accept.
 *
 * THE FINDINGS FOLLOW THE `findings` KEY, not the verdict. Absent, the primary's
 * findings carry over ("nothing to add"); present — including `[]` — the re-ask's
 * list replaces them, which is the only way a reviewer withdraws what it filed.
 * `src/prompts/review-verdict-reask.md` states the same rule to the reviewer,
 * and `test/unit/review-report.test.ts` pins prompt and parser together.
 *
 * Pure and exported so the rule is pinned directly rather than through a turn
 * fixture: the daemon calls it while recording the review turn, and the first
 * reply stays the turn's CONTENT either way (it may hold the reviewer's only
 * written reasoning).
 */
export function chooseReviewReport<T extends ReviewReport>(
  primary: T,
  reasked: T | undefined,
  /**
   * Whether the re-ask's JSON carried a `findings` ARRAY of its own
   * (`parseReviewReply(...).statesFindings`). Defaults to false — silence —
   * which is the direction that keeps findings rather than drops them.
   */
  reaskStatesFindings = false,
): { report: T; usedReask: boolean } {
  if (resolveReviewVerdict(primary) !== REVIEW_VERDICT_UNPARSED) {
    return { report: primary, usedReask: false };
  }
  if (reasked && resolveReviewVerdict(reasked) !== REVIEW_VERDICT_UNPARSED) {
    // THE FINDINGS ARE NOT COLLATERAL. The re-ask asks for one narrow thing —
    // a verdict word the daemon can act on — and the commonest reason it fires
    // is a first reply that was complete and well-formed EXCEPT for that word
    // (six of the nine spellings in the run this contract came from). A
    // reviewer that reads "the JSON object and nothing else" as "just correct
    // the word" replies with an empty findings array, and taking the re-asked
    // report wholesale then threw away findings the first reply had already
    // parsed: the task parked on "needs_work but recorded no findings", the
    // fix turn got an empty brief, and a cluster parent was handed a decision
    // with no evidence.
    //
    // So the primary's findings carry across when the re-ask is SILENT about
    // them — no `findings` key at all. They are not in doubt: they parsed.
    //
    // WHAT DECIDES IS THE KEY, NOT THE LENGTH. A re-ask that STATES a list
    // replaces the primary's, and `"findings": []` is such a statement — it is
    // how a reviewer withdraws. That route has to exist: the re-ask is the
    // reviewer re-reading its own reply, the prompt invites it to say none of
    // its findings stand, and until this distinction existed that instruction
    // named an action with no effect. The cost of not having it is concrete —
    // the implementer's next turn is briefed on a finding the reviewer
    // retracted, one of two auto-fix rounds is spent on it, and accept is
    // gated until somebody notices.
    //
    // Conflating the two is what made an empty array unreadable; the parse is
    // where they are still distinguishable, which is why the fact is passed in
    // (`parseReviewReply`) instead of being guessed from the array.
    if (!reaskStatesFindings && reasked.findings.length === 0 && primary.findings.length > 0) {
      return { report: { ...reasked, findings: primary.findings }, usedReask: true };
    }
    return { report: reasked, usedReask: true };
  }
  return { report: primary, usedReask: false };
}

/**
 * Prefix `recordReviewErrorTurn` stamps on the verdict of a review whose
 * reviewer never finished — a crash, a watchdog kill, a provider that died
 * mid-turn. It is the one thing in the record that tells that failure apart
 * from a reviewer that replied but would not follow the output contract.
 */
export const REVIEW_CRASH_VERDICT_PREFIX = 'FAILED:';

/**
 * Prefix the auto-review catchup stamps on a review that never STARTED — the
 * dispatch failed (no runner, dead provider), or a gate stopped it being
 * attempted at all (auto-react paused, the daily budget spent, no credential to
 * bill a system turn to). Either way no reviewer process ever existed, which is
 * the fact every reader of this record needs; the verdict's own text names
 * which one it was.
 *
 * A third failure shape, and it needs its own word for two reasons. Saying "the
 * reviewer did not finish" about one that never began is a guessed cause in a
 * message whose only job is the cause (CLAUDE.md). And the catchup RETRIES a
 * dispatch every tick, so this record must be distinguishable from a real
 * review turn — {@link reviewWasNeverDispatched} is what lets the retry go on
 * while the failure is already on the record and already gating.
 */
export const REVIEW_UNDISPATCHED_VERDICT_PREFIX = 'FAILED TO START:';

/** True when this report records a review whose dispatch never got off the ground. */
export function reviewWasNeverDispatched(report: ReviewReport | undefined | null): boolean {
  return (report?.verdict ?? '').startsWith(REVIEW_UNDISPATCHED_VERDICT_PREFIX);
}

/**
 * The separator between the two halves of a never-started verdict.
 *
 * `FAILED TO START: <headline> — <detail>`. The HEADLINE names the KIND of
 * obstacle and holds no variable text ("auto-react is paused for this task");
 * the DETAIL is the specifics (an error message, a budget count, the pause
 * reason somebody typed).
 *
 * Two readers need the halves apart, which is why the shape is a contract
 * rather than prose. A refusal or a gate row has room for one clause and must
 * name the real obstacle, so it renders the headline
 * ({@link describeReviewFailureShort}). And the catchup dedupes its own records
 * by obstacle — one record per obstacle, superseded when a different one takes
 * over — which needs an identity that a changing budget count or a flapping
 * error string does not move ({@link reviewNotRunHeadline}).
 */
const NOT_RUN_VERDICT_SEPARATOR = ' — ';

/**
 * Compose the verdict for a review that never started, from its two halves.
 * The ONE place the format is written, so the readers below cannot drift from
 * the writer.
 */
export function undispatchedReviewVerdict(headline: string, detail: string): string {
  return `${REVIEW_UNDISPATCHED_VERDICT_PREFIX} ${headline}${NOT_RUN_VERDICT_SEPARATOR}${detail}`;
}

/**
 * The stable half of a never-started verdict — WHAT kind of obstacle stopped
 * it — or null when this report is not one of those records.
 *
 * A record written before this format existed (or by hand) has no separator;
 * everything after the prefix is then the headline, which is the safe reading:
 * it stays stable for an unchanging obstacle, which is all the dedupe needs.
 */
export function reviewNotRunHeadline(report: ReviewReport | undefined | null): string | null {
  if (!reviewWasNeverDispatched(report)) return null;
  const rest = (report?.verdict ?? '')
    .slice(REVIEW_UNDISPATCHED_VERDICT_PREFIX.length)
    .trim();
  const cut = rest.indexOf(NOT_RUN_VERDICT_SEPARATOR);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

/**
 * Why a FAILED review failed, in the terms whoever must decide needs.
 *
 * THREE FAILURES WEAR THE SAME VERDICT (`unparsed`), and they call for
 * different decisions. A reviewer that never STARTED and one that CRASHED never
 * read the work, so the answer is to retry — the child's diff is still
 * un-reviewed, and for the undispatched case the daemon is already retrying. A
 * reviewer that replied but would not produce a usable verdict HAS read the
 * work, so the answer is to decide on the child's own report and diff, because
 * re-running it will most likely produce the same unusable reply.
 *
 * A driver reads this sentence and picks between those under step 5 of its
 * contract, so telling it the wrong one costs a wrong decision — and asserting
 * a parse failure survived "the one re-ask" when no re-ask ever ran is a
 * guessed cause inside a message whose only job is the cause (CLAUDE.md,
 * "never present a guessed cause as the explanation").
 *
 * Derived from the stored verdict rather than from a flag, because the record
 * already distinguishes them and a second stored field could disagree with it.
 */
export function describeFailedReview(report: ReviewReport | undefined | null): string {
  const verdict = report?.verdict ?? '';
  if (verdict.startsWith(REVIEW_UNDISPATCHED_VERDICT_PREFIX)) {
    const detail = verdict.slice(REVIEW_UNDISPATCHED_VERDICT_PREFIX.length).trim();
    return `the review never STARTED — ${detail}. ` +
      'Nothing read this work: the daemon re-checks on every tick and dispatches as soon ' +
      'as whatever stopped it clears';
  }
  if (verdict.startsWith(REVIEW_CRASH_VERDICT_PREFIX)) {
    const detail = verdict.slice(REVIEW_CRASH_VERDICT_PREFIX.length).trim();
    return `the reviewer did not finish — ${detail}. ` +
      'No re-ask was possible: there was no reply to re-ask about';
  }
  return 'the review FAILED to parse (its verdict was not clean / needs_work / needs_human, ' +
    'or a required sweep statement was missing) even after the one re-ask';
}

/**
 * The short "what went wrong" clause for a FAILED review, for a refusal or a
 * gate row.
 *
 * Three failures reach this point and the blanket wording named none of them:
 * "FAILED to parse (its verdict was not clean / needs_work / needs_human, OR a
 * required sweep statement was missing)" made the reader guess which, and for a
 * review written under the PREVIOUS contract — verdict `approve`, both sweeps
 * present and readable — it was simply untrue. Nothing failed to parse there;
 * the vocabulary changed underneath it.
 *
 * Deliberately NOT a claim about WHEN the review was written. A pre-contract
 * `approve` and a reviewer that says `approve` today are the same shape, and
 * lazy cannot tell them apart without a timestamp rule that would rot. So this
 * says exactly what it knows — the verdict word is not one of the three — which
 * is true of both and actionable for both.
 */
export function describeReviewFailureShort(report: ReviewReport | undefined | null): string {
  const verdict = report?.verdict ?? '';
  if (verdict.startsWith(REVIEW_UNDISPATCHED_VERDICT_PREFIX)) {
    // NAMES THE OBSTACLE THE RECORD NAMES, never a guessed one. This used to
    // read "its reviewer could not be launched" for every never-started
    // record, which was true while a failed dispatch was the only way to get
    // one. It is now one of five: a pause (task or project), a spent daily
    // budget and a missing system credential attempt no launch at all, so that
    // sentence asserted a cause that had not happened — and the remedy a reader
    // reaches for differs per obstacle, which is the whole reason the gate says
    // anything at all. The true one is in the verdict, one split away.
    const headline = reviewNotRunHeadline(report);
    return headline ? `never started — ${headline}` : 'never started';
  }
  if (verdict.startsWith(REVIEW_CRASH_VERDICT_PREFIX)) {
    return 'did not complete — its reviewer never finished';
  }
  const sweepsUnreadable =
    report?.security === REVIEW_VERDICT_UNPARSED
    || report?.data_integrity === REVIEW_VERDICT_UNPARSED;
  if (sweepsUnreadable) {
    return 'produced no readable security / data-integrity statement';
  }
  const quoted = verdict.length > 60 ? `${verdict.slice(0, 57)}…` : verdict;
  return `ended with the verdict "${quoted}", which is not one of ` +
    'clean / needs_work / needs_human';
}
