import { describe, test, expect } from 'bun:test';
import { isAcceptSpent, parseReopenedAfterAccept, reopenedAfterAcceptLine, REOPENED_AFTER_ACCEPT_KEY } from '../../src/task/reopen-after-accept';

describe('zombie sweep: is an accept tag spent by a reopen?', () => {
  const rec = { accept_commit: 'a'.repeat(40), reopened_at: '2026-09-26T12:31:55.000Z' };

  // INVARIANT: the tag a reopen superseded is never healed from; any OTHER
  // accept (a later one, which moves the tag) and a task with no reopen record
  // are healed exactly as before. The sweep exists for lost accept writes.
  test('spent only when the tag still names the superseded accept', () => {
    expect(isAcceptSpent('a'.repeat(40), rec)).toBe(true);
    expect(isAcceptSpent('b'.repeat(40), rec)).toBe(false);
    expect(isAcceptSpent('a'.repeat(40), null)).toBe(false);
  });

  test('an unreadable record is no record, never a spent accept', () => {
    expect(parseReopenedAfterAccept('not json')).toBeNull();
    expect(parseReopenedAfterAccept('')).toBeNull();
    expect(parseReopenedAfterAccept('{"accept_commit":""}')).toBeNull();
    expect(parseReopenedAfterAccept(JSON.stringify(rec))).toEqual(rec);
  });

  test('display line appears on the reopened task and disappears once accepted again', () => {
    const metadata = { [REOPENED_AFTER_ACCEPT_KEY]: JSON.stringify(rec) };
    expect(reopenedAfterAcceptLine({ status: 'blocked', metadata })).toContain('reopened after accept at aaaaaaaa');
    expect(reopenedAfterAcceptLine({ status: 'complete', metadata })).toBeNull();
  });
});
