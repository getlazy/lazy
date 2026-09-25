/**
 * Unit tests for when a formal review "counts" and when accept must wait.
 *
 * THE CONTRACT THESE PIN CHANGED. Findings are the issue store now: a review
 * that finds something records it in `report.findings`, the daemon hands those
 * findings to the implementer as its next turn's brief, and no Raise is
 * created. Raises are reserved for the one decision a person must make
 * (`needs_human`), and legacy reports carry their findings as
 * `raised_item_ids`, which is why both are still read.
 *
 * The gate is now "the latest review is not clean" — including a FAILED review,
 * which used to be invisible to every gate. That widening is the point: the
 * first loop to run under this flow stored one unparsed review and accepted the
 * child anyway.
 *
 * TWO LATER NARROWINGS, both from the 2026-09-21 fast-first decision, are
 * pinned at the bottom of this file: only `separate` mode gates at all, and
 * only findings ABOVE MEDIUM hold the merge. Everything above still holds
 * inside `separate` mode, which is why `finding()` below is `high` — the
 * gating case those tests are about.
 */

import { describe, test, expect } from 'bun:test';
import {
  hasWorkAgentTurnAfter,
  isSuccessfulReviewReport,
  latestSuccessfulReview,
  reviewFailed,
  reviewIssueCount,
  reviewDisregardedByGate,
  reviewIssuesAwaitingWork,
  reviewReportHasGatingIssue,
  successfulReviewTurnsOf,
  type ReviewGateContext,
} from '../../src/review/success';
import type { ReviewFinding, ReviewReport } from '../../src/types/review-report';

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    verdict: 'clean',
    security: 'none found',
    data_integrity: 'none found',
    findings: [],
    ...overrides,
  };
}

/** A finding that HOLDS the merge — critical/high are the gating severities. */
function finding(summary: string): ReviewFinding {
  return { severity: 'high', category: 'correctness', summary };
}

/** The gate context for a task in this mode under the default `auto` gate. */
function ctx(mode: 'off' | 'low_high' | 'separate'): ReviewGateContext {
  return { mode, gate: 'auto' };
}

/** A finding that does NOT hold the merge — medium and below ride along. */
function minorFinding(summary: string, severity: 'medium' | 'low' = 'medium'): ReviewFinding {
  return { severity, category: 'style', summary };
}

describe('isSuccessfulReviewReport', () => {
  // INVARIANT: a review that was RECORDED counts, including a failed one. The
  // raise-era rule ("unparsed with zero raises never happened") made a broken
  // review invisible to every gate AND to the dispatch dedup, so the task
  // parked looking un-reviewed and accepted clean. A failure that nobody can
  // see is worse than one that gates.
  test('any recorded report counts, failed ones included', () => {
    expect(isSuccessfulReviewReport(report())).toBe(true);
    expect(isSuccessfulReviewReport(report({ security: 'unparsed', data_integrity: 'unparsed' }))).toBe(true);
    expect(isSuccessfulReviewReport(undefined)).toBe(false);
  });

  test('reviewFailed marks an unparsed verdict or an unparsed sweep', () => {
    expect(reviewFailed(report())).toBe(false);
    expect(reviewFailed(report({ verdict: 'approve' }))).toBe(true);
    expect(reviewFailed(report({ security: 'unparsed' }))).toBe(true);
    expect(reviewFailed(undefined)).toBe(false);
  });

  test('reviewIssueCount counts findings and legacy raises together', () => {
    expect(reviewIssueCount(report())).toBe(0);
    expect(reviewIssueCount(report({ findings: [finding('a'), finding('b')] }))).toBe(2);
    expect(reviewIssueCount(report({ raised_item_ids: ['aaaaaaaa'] }))).toBe(1);
    expect(reviewIssueCount(report({
      findings: [finding('a')],
      raised_item_ids: ['aaaaaaaa'],
    }))).toBe(2);
  });
});

describe('successfulReviewTurnsOf / reviewIssuesAwaitingWork', () => {
  test('a raise-less needs_human report is a gating issue', () => {
    const needsHuman = report({ verdict: 'needs_human', raised_item_ids: [] });
    expect(reviewReportHasGatingIssue(needsHuman)).toBe(true);

    const tracked = report({ verdict: 'needs_human', raised_item_ids: ['raise-1'] });
    expect(reviewReportHasGatingIssue(tracked, { awaitingRaiseCount: 0 })).toBe(false);
  });

  // INVARIANT: a FAILED review is listed and it GATES. Nobody knows what it
  // concluded, and "nobody knows" may not read as clean — the gate's one safe
  // direction. Its findings list may be exactly what did not parse, so it holds
  // accept even with nothing outstanding to count.
  test('a failed review is listed and gates like needs_work', () => {
    const turns = [
      { sequence: 1, role: 'human', turn_type: 'review' },
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ security: 'unparsed', data_integrity: 'unparsed' }),
      },
    ];
    expect(successfulReviewTurnsOf(turns)).toHaveLength(1);
    expect(latestSuccessfulReview(turns)?.sequence).toBe(2);
    expect(reviewIssuesAwaitingWork(turns)).toMatchObject({
      sequence: 2, raiseCount: 0, verdict: 'unparsed',
    });
  });

  test('a verdict outside the closed set gates too', () => {
    const turns = [
      { sequence: 2, role: 'agent', turn_type: 'review', review: report({ verdict: 'approve' }) },
    ];
    expect(reviewIssuesAwaitingWork(turns)?.verdict).toBe('unparsed');
  });

  // INVARIANT: findings, not Raises, are what a `needs_work` review leaves
  // behind, and they gate until a work turn runs.
  test('a needs_work review with findings blocks until a later work turn', () => {
    const turns = [
      { sequence: 1, role: 'agent', turn_type: 'work' },
      {
        sequence: 4,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_work', findings: [finding('a'), finding('b')] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns)).toMatchObject({
      sequence: 4, raiseCount: 2, verdict: 'needs_work',
    });
    expect(hasWorkAgentTurnAfter(turns, 4)).toBe(false);

    const afterWork = [
      ...turns,
      { sequence: 5, role: 'human', turn_type: 'work' },
      { sequence: 6, role: 'agent', turn_type: 'work' },
    ];
    expect(reviewIssuesAwaitingWork(afterWork)).toBeNull();
  });

  test('a needs_human review gates on its blocking raise', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaaaaaa'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns)).toMatchObject({
      sequence: 2, raiseCount: 1, verdict: 'needs_human',
    });
  });

  test('a clean review does not block accept', () => {
    const turns = [
      { sequence: 2, role: 'agent', turn_type: 'review', review: report() },
    ];
    expect(reviewIssuesAwaitingWork(turns)).toBeNull();
  });

  // INVARIANT: findings win over a contradicting verdict. `clean` with findings
  // listed is a self-contradiction, and a gate may only ever fail closed.
  test('clean plus findings still gates', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'clean', findings: [finding('nit')] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns)?.raiseCount).toBe(1);
  });

  // INVARIANT: a raise the human has DECIDED is addressed — the gate exists to
  // stop an unaddressed review from being accepted, not to demand a turn for
  // work that is now tracked elsewhere. Promoting a raise to a subtask and
  // accepting that subtask used to leave accept refusing until the human
  // unblocked the agent for nothing.
  test('a promoted raise no longer gates accept', () => {
    const turns = [
      { sequence: 1, role: 'agent', turn_type: 'work' },
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaaaaaa'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns)?.raiseCount).toBe(1);
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaaaaaa', status: 'promoted_subtask' },
    ])).toBeNull();
  });

  // INVARIANT: ONLY promotion clears a raise from this gate. Dismiss,
  // acknowledge and respond keep gating — "the agent must have had a turn to
  // address them" is this gate's recorded design, and only the count of
  // still-unpromoted raises changes.
  test('only promoted raises drop out; dismiss and respond still gate', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaaaaaa', status: 'promoted_subtask' },
      { id: 'bbbbbbbb', status: 'dismissed' },
      { id: 'cccccccc', status: 'responded' },
    ])?.raiseCount).toBe(2);

    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaaaaaa', status: 'promoted_subtask' },
      { id: 'bbbbbbbb', status: 'promoted_peer' },
      { id: 'cccccccc', status: 'promoted_subtask' },
    ])).toBeNull();
  });

  // INVARIANT: promoting away every raise does NOT clear findings. They are the
  // fixer's work, not a triage queue, and nobody can promote them elsewhere.
  test('findings survive every raise being promoted', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({
          verdict: 'needs_work',
          findings: [finding('still broken')],
          raised_item_ids: ['aaaaaaaa'],
        }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaaaaaa', status: 'promoted_subtask' },
    ])).toMatchObject({ sequence: 2, raiseCount: 1, verdict: 'needs_work' });
  });

  // INVARIANT: the gate never opens on a raise it cannot see. An id with no
  // record (a report naming an item that was never stored) counts as awaiting.
  test('an unknown raise id still gates', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaaaaaa'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'bbbbbbbb', status: 'dismissed' },
    ])?.raiseCount).toBe(1);
  });

  // INVARIANT: an AMBIGUOUS id prefix matches no raised item, exactly as an
  // absent one does. A review records the ids it filed and those may be short,
  // so a prefix lookup is needed — but taking the first of several candidates
  // would read some OTHER item's status and could report a live issue as
  // addressed, opening the gate. A gate may only ever fail closed.
  test('a prefix matching two raised items gates rather than picking one', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaa'] }),
      },
    ];
    // 'aaaa' prefixes both. The promoted one must NOT be the one that answers.
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaa1111', status: 'promoted_subtask' },
      { id: 'aaaa2222', status: 'open' },
    ])?.raiseCount).toBe(1);

    // Order must not decide it either — the same set, promoted item last.
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaa2222', status: 'open' },
      { id: 'aaaa1111', status: 'promoted_subtask' },
    ])?.raiseCount).toBe(1);

    // One candidate is unambiguous, so a prefix still resolves normally.
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaa1111', status: 'promoted_subtask' },
      { id: 'bbbb2222', status: 'open' },
    ])).toBeNull();
  });

  // An EXACT id is unambiguous by construction, even where it happens to
  // prefix another item's id — it must never be lost to the ambiguity rule.
  test('an exact id wins over an item it merely prefixes', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaa'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns, [
      { id: 'aaaa', status: 'promoted_subtask' },
      { id: 'aaaa9999', status: 'open' },
    ])).toBeNull();
  });

  test('ask after a review with findings does not clear the gate', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_work', findings: [finding('a')] }),
      },
      { sequence: 4, role: 'agent', turn_type: 'ask' },
    ];
    expect(reviewIssuesAwaitingWork(turns)?.raiseCount).toBe(1);
  });
});

/*
 * The two 2026-09-21 narrowings, from the "fast first" decision:
 *
 *   "The performance per token is just down the drain. […] Low-high should be
 *    the default option if reviewing is enabled: less token usage and less
 *    re-reading of what is already in context. Fast first, ponderously slow as
 *    an optimization on quality."
 *
 * Both RELAX the gate, which is the direction it is allowed to move only
 * because the §8.1 round accounting (`reviewIsClean`) stays strict. The
 * forbidden shape is the reverse — the gate holding what the accounting calls
 * a clean pass — which strands a task with nothing to clear it.
 */
describe('reviewIssuesAwaitingWork — the review mode', () => {
  /** A dispatched review — the daemon's own, which follows the mode rule. */
  const needsWork = [
    {
      sequence: 2,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'auto',
      review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
    },
  ];

  // INVARIANT: only `separate` mode gates on a DISPATCHED review. In `low_high`
  // the review ran inside the writer's own session and is its account of its own
  // work, not a second reader's verdict the task owes an answer to; in `off`
  // nobody reviewed anything on purpose. A review turn left over from a spell in
  // `separate` mode must not hold a merge on a contract the task is no longer
  // under, since the only override is CLI-only.
  test('a dispatched review gates in separate mode and in no other', () => {
    expect(reviewIssuesAwaitingWork(needsWork, [], ctx('separate'))).toMatchObject({ raiseCount: 1 });
    expect(reviewIssuesAwaitingWork(needsWork, [], ctx('low_high'))).toBeNull();
    expect(reviewIssuesAwaitingWork(needsWork, [], ctx('off'))).toBeNull();
  });

  // INVARIANT: the default is the GATING direction. A caller that has not been
  // taught about review settings yet must fail closed, never open — a gate may
  // only ever fail restrictively.
  test('defaults to gating when the caller says nothing', () => {
    expect(reviewIssuesAwaitingWork(needsWork)).toMatchObject({ raiseCount: 1 });
  });

  // INVARIANT: not even an unparsed DISPATCHED review gates outside `separate`.
  // A failed review is "nobody knows what it concluded" — but in low_high mode
  // nobody was ever owed a conclusion, so there is nothing outstanding to hold.
  test('a failed dispatched review outside separate mode does not gate either', () => {
    const failed = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'auto',
        review: report({ verdict: 'approve' }),
      },
    ];
    expect(reviewIssuesAwaitingWork(failed, [], ctx('separate'))?.verdict).toBe('unparsed');
    expect(reviewIssuesAwaitingWork(failed, [], ctx('low_high'))).toBeNull();
  });
});

/*
 * A review somebody ASKED for, and the `gate` override — engineer, 2026-09-21:
 * "a manually requested review gates regardless of mode", and
 * `[review] gate = auto | always | never` is the switch over the mode rule.
 */
describe('reviewIssuesAwaitingWork — manual reviews and the gate setting', () => {
  /** A DISPATCHED review with findings — the daemon's own. */
  const dispatchedNeedsWork = [
    {
      sequence: 2,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'auto',
      review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
    },
  ];

  const manualNeedsWork = [
    {
      sequence: 2,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'manual',
      review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
    },
  ];

  // INVARIANT: a review a human (`lazy review`) or a driver (`lazy_review`)
  // deliberately asked for gates in EVERY mode. Nobody spends a review turn
  // they did not want, and silently ignoring what one found because the task is
  // in the fast mode would make the command a no-op at exactly the moment it
  // was reached for.
  test('a manual review gates in every mode', () => {
    for (const mode of ['separate', 'low_high', 'off'] as const) {
      expect(reviewIssuesAwaitingWork(manualNeedsWork, [], ctx(mode)))
        .toMatchObject({ raiseCount: 1 });
    }
  });

/*
   * A MANUAL REVIEW GATES REGARDLESS OF MODE (engineer, 2026-09-21): "a review
   * a human (`lazy review`) or a driver (`lazy_review`) deliberately asked for
   * must gate accept on its findings above medium […] whatever the task's mode;
   * only the daemon's own dispatched review follows the mode rule."
   *
   * This is the unit-level statement of it; the gate predicate itself is pinned
   * in review-success.test.ts, and what makes a stored turn 'manual' is the
   * `reviewDispatch` stamp the three recorder sites write.
   */
  test('a manual review under low_high still holds the accept', () => {
    const highFinding = [
      {
        sequence: 3,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'manual',
        review: {
          verdict: 'needs_work',
          security: 'none found',
          data_integrity: 'none found',
          findings: [{ severity: 'high' as const, category: 'correctness' as const, summary: 'Race in the retry path.' }],
        },
      },
    ];
    // The task is in the FAST mode, where the daemon's own review would not
    // gate — and this one gates anyway, because somebody asked for it.
    expect(reviewIssuesAwaitingWork(highFinding, [], { mode: 'low_high', gate: 'auto' }))
      .toMatchObject({ raiseCount: 1, verdict: 'needs_work' });

    // The same review from the DAEMON does not, in that mode.
    const dispatched = [{ ...highFinding[0], review_dispatch: 'auto' }];
    expect(reviewIssuesAwaitingWork(dispatched, [], { mode: 'low_high', gate: 'auto' })).toBeNull();
  });

  // INVARIANT: an ABSENT `review_dispatch` reads as manual — the gating
  // direction. Turns recorded before the field existed have none, and every one
  // of them belongs to a task that was effectively in `separate` mode, so
  // reading them as gating is both the safe answer and what they already did.
  test('a review turn with no recorded dispatch gates like a manual one', () => {
    const legacy = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(legacy, [], ctx('low_high'))).toMatchObject({ raiseCount: 1 });
  });

  // INVARIANT: `always` makes the recorded self-review outcome gate even in
  // `low_high` — the project that wants the fast shape AND wants a bad
  // self-review to stop a merge.
  test('gate `always` gates a dispatched review in any mode', () => {
    const dispatched = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'auto',
        review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(dispatched, [], { mode: 'low_high', gate: 'always' }))
      .toMatchObject({ raiseCount: 1 });
    expect(reviewIssuesAwaitingWork(dispatched, [], { mode: 'off', gate: 'always' }))
      .toMatchObject({ raiseCount: 1 });
  });

  // INVARIANT: `never` switches off even a MANUAL review's gate. It is the one
  // setting that does, and deliberately: a human who writes `never` has said
  // exactly that, and the alternative — a setting called "never" that still
  // gates something — is the kind of lie a config key may not tell.
  test('gate `never` gates nothing, manual reviews included', () => {
    expect(reviewIssuesAwaitingWork(manualNeedsWork, [], { mode: 'separate', gate: 'never' })).toBeNull();
    expect(reviewIssuesAwaitingWork(manualNeedsWork, [], { mode: 'low_high', gate: 'never' })).toBeNull();
  });

  /*
   * ACCEPT NEVER SILENTLY DISREGARDS A REVIEW. When the settings let a merge
   * through over a review that found something, the accept output says so.
   */
  test('a disregarded review is reported, and a gating or clean one is not', () => {
    // Disregarded: a dispatched review with findings, in a mode that ignores
    // it. `off` rather than `low_high` — see the suppression test below for why
    // the fast mode's own self-review is not "disregarded".
    const ignored = reviewDisregardedByGate(dispatchedNeedsWork, ctx('off'));
    expect(ignored).toMatchObject({ sequence: 2 });
    expect(ignored?.reason).toContain('off');

    // Gating: accept REFUSES, and the refusal is its own notice.
    expect(reviewDisregardedByGate(dispatchedNeedsWork, ctx('separate'))).toBeNull();

    // Clean: "I ignored a review that found nothing" is noise, not information.
    const clean = [
      { sequence: 2, role: 'agent', turn_type: 'review', review_dispatch: 'auto', review: report() },
    ];
    expect(reviewDisregardedByGate(clean, ctx('low_high'))).toBeNull();

    // `never` names itself rather than the mode — the mode is not why.
    const off = reviewDisregardedByGate(dispatchedNeedsWork, { mode: 'separate', gate: 'never' });
    expect(off?.reason).toContain('never');
  });

  // INVARIANT: the low-high SELF-REVIEW under the default gate is not
  // "disregarded" — its findings were already acted on, in session, by the
  // revise pass that ran straight after it. That is what the mode IS. Warning
  // anyway would put a line on every accept of every task running the default,
  // and a notice that fires on the expected path is one people learn to scroll
  // past, which costs the cases that do mean something.
  test('the low-high self-review under gate auto is not reported as disregarded', () => {
    // Dispatch `self`, which is what the recorder stamps.
    const selfNeedsWork = [{ ...dispatchedNeedsWork[0], review_dispatch: 'self' }];
    expect(reviewDisregardedByGate(selfNeedsWork, ctx('low_high'))).toBeNull();

    // Narrow on purpose: switch the gate OFF deliberately and the notice
    // returns, because there a human chose to stop gating and is owed the
    // reminder that something was found.
    expect(reviewDisregardedByGate(selfNeedsWork, { mode: 'low_high', gate: 'never' }))
      .toMatchObject({ sequence: 2 });
  });
});

describe('reviewIssuesAwaitingWork — the severity floor', () => {
  // INVARIANT: only findings ABOVE MEDIUM hold the merge. A finding is a
  // reviewer's opinion about work a human is about to read anyway; holding
  // every merge on a style nit cost a full agent turn or a person per finding,
  // and left a cluster driver — told to accept liberally — unable to accept a
  // child at all, because `--allow-review-issues` is CLI-only.
  test('medium and low findings do not gate', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({
          verdict: 'needs_work',
          findings: [minorFinding('a nit'), minorFinding('another', 'low')],
        }),
      },
    ];
    expect(reviewIssuesAwaitingWork(turns, [], ctx('separate'))).toBeNull();
  });

  test('critical and high findings gate, and are the only findings counted', () => {
    const turns = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({
          verdict: 'needs_work',
          findings: [
            minorFinding('a nit'),
            finding('a real bug'),
            { severity: 'critical', category: 'security', summary: 'auth bypass' },
          ],
        }),
      },
    ];
    // Two of the three, not three: `raiseCount` is what the refusal message
    // says is outstanding, so counting a finding that does not gate would name
    // an obstacle the human cannot find.
    expect(reviewIssuesAwaitingWork(turns, [], ctx('separate'))).toMatchObject({ raiseCount: 2 });
  });

  // INVARIANT: the floor applies to FINDINGS only. Three things still gate at
  // any severity, and each one is a case where "medium" says nothing about how
  // much is outstanding.
  test('the floor does not reach a failed review, a raise, or an uncovered sweep', () => {
    const failed = [
      { sequence: 2, role: 'agent', turn_type: 'review', review: report({ verdict: 'approve' }) },
    ];
    expect(reviewIssuesAwaitingWork(failed, [], ctx('separate'))).not.toBeNull();

    const raised = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({ verdict: 'needs_human', raised_item_ids: ['aaaa'] }),
      },
    ];
    expect(reviewIssuesAwaitingWork(raised, [{ id: 'aaaa', status: 'open' }], ctx('separate')))
      .toMatchObject({ raiseCount: 1 });

    const sweep = [
      {
        sequence: 2,
        role: 'agent',
        turn_type: 'review',
        review: report({
          verdict: 'clean',
          security: 'the token is logged in plaintext on every request',
          findings: [minorFinding('a nit')],
        }),
      },
    ];
    expect(reviewIssuesAwaitingWork(sweep, [], ctx('separate'))).not.toBeNull();
  });
});

/*
 * `gate = "always"` MUST be able to gate the low-high self-review — the
 * engineer's explicit requirement, and what seven surfaces of documentation
 * promise. It is only true because the self-review now produces a RECORDED
 * review turn (`recordLowHighSelfReview`, src/utils/reconcile.ts) carrying a
 * parsed report with `review_dispatch: 'self'`; without that turn the setting
 * was documented and inert.
 */
describe('gate `always` and the low-high self-review', () => {
  /** What the self-review records: a parsed report, dispatch `self`. */
  const selfReview = (findings: ReviewFinding[], overrides: Partial<ReviewReport> = {}) => [
    { sequence: 1, role: 'agent', turn_type: 'work' },
    {
      sequence: 3,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'self',
      review: report({ verdict: findings.length ? 'needs_work' : 'clean', findings, ...overrides }),
    },
  ];

  // The requirement, stated as the test: mode low_high + gate always + a high
  // finding refuses accept.
  test('a high finding in the self-review refuses accept under gate always', () => {
    expect(reviewIssuesAwaitingWork(selfReview([finding('a real bug')]), [], {
      mode: 'low_high', gate: 'always',
    })).toMatchObject({ raiseCount: 1, verdict: 'needs_work' });
  });

  // The same self-review under the DEFAULT gate accepts, and silently: the
  // mode rule leaves it alone, and the disregarded-review notice does not fire
  // for it either, because its findings were already acted on in session.
  test('the same self-review accepts silently under gate auto', () => {
    const turns = selfReview([finding('a real bug')]);
    expect(reviewIssuesAwaitingWork(turns, [], { mode: 'low_high', gate: 'auto' })).toBeNull();
    expect(reviewDisregardedByGate(turns, { mode: 'low_high', gate: 'auto' })).toBeNull();
  });

  // The severity floor applies to it like any other review: `always` means
  // "this review counts", not "every remark holds the merge".
  test('medium findings in the self-review still do not gate, even under always', () => {
    expect(reviewIssuesAwaitingWork(selfReview([minorFinding('a nit')]), [], {
      mode: 'low_high', gate: 'always',
    })).toBeNull();
  });

  // The other half of what `always` promises: a SWEEP that found something
  // holds the accept even with no finding above medium recorded for it.
  test('a sweep that found something gates under always', () => {
    const turns = selfReview([], { security: 'the token is logged in plaintext on every request' });
    expect(reviewIssuesAwaitingWork(turns, [], { mode: 'low_high', gate: 'always' })).not.toBeNull();
  });

  // A clean self-review is the ordinary case and must not hold anything.
  test('a clean self-review gates nothing under either gate', () => {
    for (const gate of ['auto', 'always'] as const) {
      expect(reviewIssuesAwaitingWork(selfReview([]), [], { mode: 'low_high', gate })).toBeNull();
    }
  });
});

/*
 * `gate = "always"` MUST NOT HOLD A MERGE ON FINDINGS THE REVISE PASS APPLIED.
 *
 * The recorded report is the PRE-fix state — that is what the reviewer wrote —
 * and the revise phase is a supervised `nudge` turn, so `hasWorkAgentTurnAfter`
 * cannot see it. Without `review_addressed`, a project on `always` could never
 * land a task whose self-review worked, which is the opposite of what the
 * setting is for.
 */
describe('a self-review the revise pass already applied', () => {
  const selfReviewed = (addressed: boolean) => [
    { sequence: 1, role: 'agent', turn_type: 'work' },
    {
      sequence: 3,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'self',
      ...(addressed ? { review_addressed: true } : {}),
      review: report({ verdict: 'needs_work', findings: [finding('a real bug')] }),
    },
  ];

  test('an addressed self-review gates nothing, even under always', () => {
    expect(reviewIssuesAwaitingWork(selfReviewed(true), [], { mode: 'low_high', gate: 'always' }))
      .toBeNull();
  });

  // The other branch, so the marker is doing the work rather than the mode:
  // an unaddressed one (the revise phase crashed, or changed nothing) still
  // holds, because nobody applied what it found.
  test('an unaddressed self-review still gates under always', () => {
    expect(reviewIssuesAwaitingWork(selfReviewed(false), [], { mode: 'low_high', gate: 'always' }))
      .toMatchObject({ raiseCount: 1 });
  });

  // And the notice takes the same early return: a review somebody already
  // dealt with is not being "disregarded".
  test('an addressed review is never reported as disregarded', () => {
    expect(reviewDisregardedByGate(selfReviewed(true), { mode: 'low_high', gate: 'never' }))
      .toBeNull();
  });

  // LOW from the round-4 review: the notice gains the same work-turn early
  // return the gate has. A work turn since the review means somebody acted;
  // a notice that fires there is one people learn to scroll past.
  test('a work turn after the review clears the notice too', () => {
    const withWork = [
      ...selfReviewed(false),
      { sequence: 4, role: 'agent', turn_type: 'work' },
    ];
    expect(reviewDisregardedByGate(withWork, { mode: 'low_high', gate: 'never' })).toBeNull();
    // Without it, the same turns DO produce the notice.
    expect(reviewDisregardedByGate(selfReviewed(false), { mode: 'low_high', gate: 'never' }))
      .toMatchObject({ sequence: 3 });
  });
});

/*
 * INVARIANT: `review_addressed` suppresses only the FINDINGS, never a verdict
 * or a sweep statement.
 *
 * It was a blanket early return, which let the revise pass vouch for two things
 * it cannot have fixed. `needs_human` means a PERSON must decide — by
 * construction the one conclusion an in-session pass cannot resolve — and a
 * sweep naming an issue no finding covers is a claim about the work, not a task
 * list. Both reached accept silently under `gate = "always"`.
 */
describe('review_addressed suppresses findings, not verdicts or sweeps', () => {
  const addressedSelfReview = (review: ReviewReport) => [
    { sequence: 1, role: 'agent', turn_type: 'work' },
    {
      sequence: 3,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'self',
      review_addressed: true,
      review,
    },
  ];
  const always: ReviewGateContext = { mode: 'low_high', gate: 'always' };

  test('an addressed self-review with verdict needs_human still gates', () => {
    const turns = addressedSelfReview(report({ verdict: 'needs_human', findings: [] }));
    expect(reviewIssuesAwaitingWork(turns, [], always)).toMatchObject({ verdict: 'needs_human' });
  });

  test('an addressed self-review whose sweep names an uncovered issue still gates', () => {
    const turns = addressedSelfReview(report({
      verdict: 'needs_work',
      security: 'Found a SQL injection in the query builder.',
      findings: [],
    }));
    expect(reviewIssuesAwaitingWork(turns, [], always)).toMatchObject({ sequence: 3 });
  });

  // The half that must keep working: ordinary findings ARE what the revise pass
  // applies, so an addressed review carrying only findings still gates nothing.
  test('an addressed self-review carrying only findings still gates nothing', () => {
    const turns = addressedSelfReview(report({
      verdict: 'needs_work',
      findings: [finding('a real bug')],
    }));
    expect(reviewIssuesAwaitingWork(turns, [], always)).toBeNull();
  });

  // Scoped to the no-raise case so a separate reviewer's `needs_human` still
  // clears when the human resolves its raise — the raise is the tracking there.
  test('a needs_human that filed a raise is still cleared by resolving it', () => {
    const turns = [
      { sequence: 1, role: 'agent', turn_type: 'work' },
      {
        sequence: 3,
        role: 'agent',
        turn_type: 'review',
        review_dispatch: 'auto',
        review: report({ verdict: 'needs_human', findings: [], raised_item_ids: ['r1'] }),
      },
    ];
    // `raiseAwaitsAgentWork` reads promotion as the thing that stops a raise
    // awaiting — see its own doc for why an unknown id stays awaiting.
    const promoted = [{ id: 'r1', status: 'promoted_subtask' }];
    expect(reviewIssuesAwaitingWork(turns, promoted, { mode: 'separate', gate: 'auto' })).toBeNull();
  });
});

/*
 * ACCEPT NEVER SILENTLY DISREGARDS A REVIEW — including the case the severity
 * floor created. A `separate`-mode review that came back `needs_work` with
 * every finding at medium or below gates nothing, counts zero outstanding, and
 * used to merge in total silence: the gate APPLIED, so the notice returned null.
 */
describe('the notice covers a review the severity floor filtered out', () => {
  const minorSeparateReview = (findings: ReviewFinding[]) => [
    { sequence: 1, role: 'agent', turn_type: 'work' },
    {
      sequence: 3,
      role: 'agent',
      turn_type: 'review',
      review_dispatch: 'auto',
      review: report({ verdict: 'needs_work', findings }),
    },
  ];

  test('a needs_work review with only minor findings is reported as disregarded', () => {
    const turns = minorSeparateReview([minorFinding('a nit'), minorFinding('another', 'low')]);
    // It gates nothing...
    expect(reviewIssuesAwaitingWork(turns, [], ctx('separate'))).toBeNull();
    // ...so the human is told, rather than the review vanishing.
    expect(reviewDisregardedByGate(turns, ctx('separate'))).toMatchObject({ sequence: 3 });
  });

  test('a review that DOES gate is not also reported as disregarded', () => {
    const turns = minorSeparateReview([finding('a real bug')]);
    expect(reviewIssuesAwaitingWork(turns, [], ctx('separate'))).toMatchObject({ raiseCount: 1 });
    // Accept refuses and names it — a second line would be noise.
    expect(reviewDisregardedByGate(turns, ctx('separate'))).toBeNull();
  });
});
