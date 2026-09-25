/**
 * `lazy system repair-commits --apply` applies the plan the human confirmed.
 *
 * The apply is handed that plan (so it re-plans only those tasks instead of
 * sweeping the whole store again) and re-derives every one of them from
 * scratch. What it writes is the INTERSECTION of the two answers. This file
 * pins that rule and the parsing of the wire field that carries it — deleting a
 * commit record is the one irreversible thing the command does, and without
 * these an apply that simply trusted the list it was handed would pass every
 * other test in the suite.
 */

import { describe, test, expect } from 'bun:test';
import { retainApproved } from '../../src/daemon/repair-commits';

const removal = (sha: string) => ({ sha, message: `commit ${sha}` });

describe('retainApproved', () => {
  test('keeps a removal that is in both the fresh plan and the confirmation', () => {
    const kept = retainApproved([removal('aaa'), removal('bbb')], new Set(['aaa', 'bbb']));
    expect(kept.map(r => r.sha)).toEqual(['aaa', 'bbb']);
  });

  test('drops a removal the human never approved', () => {
    // INVARIANT: the applied set is an intersection, never a union. The fresh
    // re-plan can newly want to remove a record — a turn landed a merge, a ref
    // moved — and that record was not on screen when the human said yes. It
    // does not get deleted on this run; the next report will offer it.
    const kept = retainApproved([removal('aaa'), removal('new')], new Set(['aaa']));
    expect(kept.map(r => r.sha)).toEqual(['aaa']);
  });

  test('a confirmed removal the fresh plan no longer derives is simply absent', () => {
    // INVARIANT: the other half of the same rule. Approval is not an
    // instruction to delete a SHA — the apply deletes what IT derived, so a
    // record that became unprovable (its branch moved, its object went
    // missing) is gone from the fresh plan and cannot be resurrected by the
    // confirmation naming it.
    const kept = retainApproved([removal('aaa')], new Set(['aaa', 'vanished']));
    expect(kept.map(r => r.sha)).toEqual(['aaa']);
  });

  test('an empty confirmation removes nothing', () => {
    expect(retainApproved([removal('aaa')], new Set())).toEqual([]);
  });
});
