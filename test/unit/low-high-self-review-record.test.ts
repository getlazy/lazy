/**
 * The low-high self-review is also a RECORDED review.
 *
 * Engineer requirement, 2026-09-21: `[review] gate = "always"` must be able to
 * gate the low-high self-review, as the documentation promises. That is only
 * possible if the self-review produces a review turn every gate surface already
 * understands — a parsed `ReviewReport` on a `turn_type: 'review'` turn with
 * `review_dispatch: 'auto'` — alongside the supervised nudge pair that carries
 * the reviewer's raw text.
 *
 * These pin the recorder's two branches and the reason for the second one.
 */

import { describe, test, expect } from 'bun:test';
import { recordSupervisedTurns } from '../../src/utils/reconcile';
import { successfulReviewTurnsOf, reviewIssuesAwaitingWork, reviewFailed } from '../../src/review/success';
import type { CompletedResponse } from '../../src/protocol';
import { CodexAgent } from '../../src/agent/codex';
import { lowHighFailureDetail } from '../../src/supervisor/low-high-loop';

/** A storage double that keeps the turns it was asked to create, in order. */
function storage() {
  const turns: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    turns,
    getNextTurnSequence: async () => ++seq,
    createTurn: async (params: Record<string, unknown>) => {
      const turn = { ...params, turn_type: params.turnType, review_dispatch: params.reviewDispatch };
      turns.push(turn);
      return turn;
    },
  } as never;
}

/** The self-review phase's response, with whatever reply text it produced. */
function selfReview(result: string): CompletedResponse {
  return {
    status: 'completed',
    result,
    session_id: 'sess',
    usage: { input_tokens: 0, output_tokens: 0 },
    supervised: { kind: 'low_high_review', prompt: 'review yourself' },
  } as unknown as CompletedResponse;
}

const REPORT_JSON = `
1. Fix the retry path in src/foo.ts — it swallows malformed rows.

\`\`\`json
{
  "verdict": "needs_work",
  "security": "none found",
  "data_integrity": "none found",
  "findings": [
    { "severity": "high", "category": "correctness", "file": "src/foo.ts", "summary": "Swallows malformed rows." }
  ]
}
\`\`\`
`;

describe('recordSupervisedTurns — the low-high self-review', () => {
  test('a failed Codex launch records the harness error as a failed review', async () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"review-thread"}',
      '{"type":"turn.failed","error":{"message":"resume sandbox option was rejected"}}',
    ].join('\n');
    const detail = lowHighFailureDetail(new CodexAgent(), stdout, '', '/tmp/wt');
    const s = storage();
    await recordSupervisedTurns(
      s,
      'sess',
      [selfReview(`FAILED: Low-high review did not complete — ${detail}`)],
      '/tmp/wt',
      null,
    );

    const turns = (s as unknown as { turns: Array<Record<string, unknown>> }).turns;
    const review = turns.find((turn) => turn.turnType === 'review');
    expect(review).toBeDefined();
    expect(String(review!.content)).toContain('resume sandbox option was rejected');
    expect((review!.review as { verdict: string }).verdict).toStartWith('FAILED:');
    expect(successfulReviewTurnsOf(turns as never)).toHaveLength(1);
    expect(reviewFailed(review!.review as never)).toBe(true);
  });

  // INVARIANT: the report is recorded as its OWN review turn, on top of the
  // nudge pair. The nudge pair is the transcript (what was said, what the
  // revise pass then acted on); this is the same reply read as a REPORT, in the
  // one shape the Reviews tab, `lazy show` and the accept gate understand.
  test('a parsed report becomes a review turn with dispatch `self`', async () => {
    const s = storage();
    await recordSupervisedTurns(s, 'sess', [selfReview(REPORT_JSON)], '/tmp/wt', null);

    const t = (s as unknown as { turns: Array<Record<string, unknown>> }).turns;
    // human nudge + agent nudge + the review turn.
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ role: 'human', turnType: 'nudge' });
    expect(t[1]).toMatchObject({ role: 'agent', turnType: 'nudge' });

    const review = t[2];
    // `self`, not `auto`: nobody asked for it AND it ran inside the writer's
    // own session — which is what lets the dispatch dedup tell it apart from a
    // reviewer a driver escalates to.
    expect(review).toMatchObject({ role: 'agent', turnType: 'review', reviewDispatch: 'self' });
    expect((review.review as { verdict: string }).verdict).toBe('needs_work');

    // And every gate surface sees it.
    expect(successfulReviewTurnsOf(t as never)).toHaveLength(1);
    expect(reviewIssuesAwaitingWork(t as never, [], { mode: 'low_high', gate: 'always' }))
      .toMatchObject({ raiseCount: 1 });
  });

  /*
   * INVARIANT: an UNPARSEABLE self-review records no review turn at all.
   *
   * The low-high loop is documented non-fatal at every phase — a crashed or
   * unreadable review leaves the draft's work standing and the turn completes.
   * Recording a FAILED review turn here would wedge every task on a project
   * running `gate = "always"` the first time an agent worded its reply
   * differently, for a phase whose whole contract is that it may fail
   * harmlessly. Nothing is lost: the nudge pair still carries the full text.
   */
  test('an unparseable reply records the nudge pair and no review turn', async () => {
    const s = storage();
    await recordSupervisedTurns(s, 'sess', [selfReview('LOW_HIGH_LOOP_APPROVED')], '/tmp/wt', null);

    const t = (s as unknown as { turns: Array<Record<string, unknown>> }).turns;
    expect(t).toHaveLength(2);
    expect(t.some((x) => x.turnType === 'review')).toBe(false);
    expect(successfulReviewTurnsOf(t as never)).toHaveLength(0);
  });

  // A clean self-review IS recorded — it is what a reader sees when they ask
  // "was this looked at", and a gate reads it as the pass it is.
  test('a clean report is recorded and gates nothing', async () => {
    const s = storage();
    const clean = '```json\n{"verdict":"clean","security":"none found","data_integrity":"none found","findings":[]}\n```';
    await recordSupervisedTurns(s, 'sess', [selfReview(`LOW_HIGH_LOOP_APPROVED\n\n${clean}`)], '/tmp/wt', null);

    const t = (s as unknown as { turns: Array<Record<string, unknown>> }).turns;
    expect(t).toHaveLength(3);
    expect(reviewIssuesAwaitingWork(t as never, [], { mode: 'low_high', gate: 'always' })).toBeNull();
  });

  // Every other supervised kind is unaffected: only the self-review is a review.
  test('other supervised kinds record only their nudge pair', async () => {
    const s = storage();
    const revise = {
      ...selfReview(REPORT_JSON),
      supervised: { kind: 'low_high_revise', prompt: 'apply it' },
    } as unknown as CompletedResponse;
    await recordSupervisedTurns(s, 'sess', [revise], '/tmp/wt', null);

    const t = (s as unknown as { turns: Array<Record<string, unknown>> }).turns;
    expect(t).toHaveLength(2);
    expect(t.some((x) => x.turnType === 'review')).toBe(false);
  });
});

/*
 * THE REVISE PASS MARKS THE REVIEW ADDRESSED — the round-4 medium.
 *
 * `gate = "always"` must be able to land a task whose self-review found
 * something and fixed it. The recorded report is the pre-fix state, so the
 * recorder stamps `reviewAddressed` when the revise phase both RAN and moved
 * HEAD; the gate reads it and stops holding.
 */
describe('recordSupervisedTurns — the revise pass marks the review addressed', () => {
  /** A revise response that moved HEAD, i.e. actually applied something. */
  const revise = (from: string, to: string): CompletedResponse => ({
    status: 'completed',
    result: 'Applied instruction 1.',
    session_id: 'sess',
    usage: { input_tokens: 0, output_tokens: 0 },
    start_sha_work: from,
    end_sha_work: to,
    supervised: { kind: 'low_high_revise', prompt: 'apply it' },
  } as unknown as CompletedResponse);

  function reviewTurnOf(s: unknown): Record<string, unknown> | undefined {
    const turns = (s as { turns: Array<Record<string, unknown>> }).turns;
    return turns.find((t) => t.turnType === 'review');
  }

  test('a revise that moved HEAD marks it addressed', async () => {
    const s = storage();
    await recordSupervisedTurns(s, 'sess', [selfReview(REPORT_JSON), revise('aaa', 'bbb')], '/tmp/wt', null);
    expect(reviewTurnOf(s)).toMatchObject({ reviewAddressed: true });
  });

  // INVARIANT: a revise that changed NOTHING addressed nothing. The loop is
  // non-fatal at every phase — a crashed or refusing revise still records a
  // response while the draft's work stands unchanged — so "the phase ran" alone
  // would mark findings applied that nobody applied.
  test('a revise that changed nothing does not', async () => {
    const s = storage();
    await recordSupervisedTurns(s, 'sess', [selfReview(REPORT_JSON), revise('aaa', 'aaa')], '/tmp/wt', null);
    expect(reviewTurnOf(s)?.reviewAddressed).toBeUndefined();
  });

  // An APPROVED self-review runs no revise phase, and needs none: a clean
  // report has nothing to apply and gates nothing anyway.
  test('no revise phase at all leaves it unmarked', async () => {
    const s = storage();
    await recordSupervisedTurns(s, 'sess', [selfReview(REPORT_JSON)], '/tmp/wt', null);
    expect(reviewTurnOf(s)?.reviewAddressed).toBeUndefined();
  });
});
