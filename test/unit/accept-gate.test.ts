/**
 * The "Before you can accept" rows — one builder behind the daemon's Current
 * review tab and the `show` RPC's `acceptGate`.
 */
import { describe, test, expect } from 'bun:test';
import { acceptGateTurns, buildAcceptGate } from '../../src/review/accept-gate';
import type { Turn } from '../../src/types';

function reviewTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: 't2',
    session_id: 's',
    sequence: 2,
    role: 'agent',
    content: 'review',
    timestamp: 2,
    turn_type: 'review',
    review: {
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [{ severity: 'high', category: 'correctness', summary: 'off by one' }],
    },
    ...over,
  } as Turn;
}

const work = { id: 't1', session_id: 's', sequence: 1, role: 'agent', content: 'work', timestamp: 1 } as Turn;

function rowsFor(turns: Turn[]) {
  return buildAcceptGate({
    turns: acceptGateTurns(turns),
    raisedItems: [],
    fileViolations: [],
    taskMetadata: null,
  }).rows;
}

describe('accept gate rows', () => {
  test('an unaddressed review with findings holds accept', () => {
    const rows = rowsFor([work, reviewTurn()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'review', sequence: 2, unblockable: true });
  });

  // INVARIANT: the stored turn's `review_addressed` reaches the gate, as it does
  // for accept, which reads raw stored turns. The daemon's own tab used to map
  // turns through a helper that dropped it, so the checklist named a review as
  // blocking while accept went through — a disclosure wrong in the direction
  // that sends a reviewer to chase an obstacle that does not exist.
  test('a review whose findings were already applied does not', () => {
    expect(rowsFor([work, reviewTurn({ review_addressed: true })])).toEqual([]);
  });

  test('open blocking raises and undecided protected files are rows; approved files are not', () => {
    const rows = buildAcceptGate({
      turns: [],
      raisedItems: [
        { id: 'r1', status: 'open', blocking: true, title: 'Ship it?', content: 'Ship it?' },
        { id: 'r2', status: 'open', blocking: false, content: 'FYI' },
      ] as never,
      fileViolations: [
        { file: 'lazy.toml', base_sha: 'a', status: 'pending' },
        { file: 'ok.toml', base_sha: 'a', status: 'approved' },
      ],
      taskMetadata: null,
    }).rows;
    expect(rows).toEqual([
      { kind: 'raised', raisedId: 'r1', label: 'Ship it?' },
      { kind: 'file', file: 'lazy.toml', label: 'lazy.toml has no decision' },
    ]);
  });
});

describe('buildAcceptGate: queued comments', () => {
  test('queued comments are a row; none is no row', () => {
    const base = { turns: [], raisedItems: [], fileViolations: [], taskMetadata: null };
    expect(buildAcceptGate({ ...base, queuedComments: 2 }).rows).toEqual([
      { kind: 'comments', count: 2, label: '2 queued comments have not reached the agent — Unblock to deliver them' },
    ]);
    expect(buildAcceptGate({ ...base, queuedComments: 0 }).rows).toEqual([]);
  });
});
