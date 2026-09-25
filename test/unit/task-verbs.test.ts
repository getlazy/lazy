import { describe, test, expect } from 'bun:test';
import {
  availableTaskVerbs,
  taskVerbUnavailableReason,
  restructureVerbUnavailableReason,
  reviewEndVerbUnavailableReason,
  agentReviewUnavailableReason,
} from '../../src/server/task-verbs';

/**
 * INVARIANT: the task page offers exactly the verbs the daemon's own gates
 * would accept (src/daemon/task-lifecycle.ts / task-launcher.ts). These cases
 * are the state table the engineer asked for: a backlog task is startable and
 * closable, a working task is stoppable, a blocked task is resumable and
 * endable, terminal tasks are reopenable — and nothing else appears.
 */
describe('task lifecycle verb availability', () => {
  test('backlog: start + close only', () => {
    expect(availableTaskVerbs('backlog', false)).toEqual(['start', 'close']);
  });

  test('working: stop + close (closing a working task stops the runner first); reject needs the open session', () => {
    expect(availableTaskVerbs('working', true)).toEqual(['stop', 'close', 'reject']);
    expect(availableTaskVerbs('working', false)).toEqual(['stop', 'close']);
  });

  test('blocked with an open session: resume + close + reject', () => {
    expect(availableTaskVerbs('blocked', true)).toEqual(['close', 'reject', 'resume']);
  });

  test('interrupted with an open session: resume + close + reject', () => {
    expect(availableTaskVerbs('interrupted', true)).toEqual(['close', 'reject', 'resume']);
  });

  // INVARIANT: resumeTask refuses conflict ("use lazy unblock") — the page
  // must not offer Resume there either.
  test('conflict: close + reject, never resume', () => {
    expect(availableTaskVerbs('conflict', true)).toEqual(['close', 'reject']);
  });

  test('terminal: reopen only', () => {
    expect(availableTaskVerbs('complete', false)).toEqual(['reopen']);
    expect(availableTaskVerbs('abandoned', false)).toEqual(['reopen']);
  });

  // INVARIANT: pairing locks the task — no lifecycle verb may be offered
  // (mirrors the explicit pairing refusals in every daemon gate).
  test('pairing: nothing', () => {
    expect(availableTaskVerbs('pairing', true)).toEqual([]);
  });

  // INVARIANT (fix-reviewer-crash-releases-in-flight): THE CLAIM OUTRANKS THE
  // STATUS for Stop, here exactly as in `stoppableClaimOf` for the daemon and
  // the CLI. A review still claimed on a PARKED task is a turn running — or one
  // that died and left its record behind — and the page must draw the button
  // that ends it. While this predicate read the status alone it hid a control
  // the action route would have accepted, which is the drift the module's
  // header warns about, and the web surface had no exit from the wedge at all.
  test('a parked task carrying a live ask/review claim is stoppable', () => {
    expect(availableTaskVerbs('blocked', true, true)).toEqual(['stop', 'close', 'reject', 'resume']);
    expect(availableTaskVerbs('conflict', true, true)).toEqual(['stop', 'close', 'reject']);
    expect(taskVerbUnavailableReason('stop', 'blocked', true, true)).toBeNull();
    expect(taskVerbUnavailableReason('stop', 'submitted', true, true)).toBeNull();
  });

  // INVARIANT: the flag is additive and nothing else reads it — a claim never
  // makes another verb available, and without one every answer is unchanged.
  test('the claim changes Stop and nothing else', () => {
    expect(availableTaskVerbs('blocked', true, false)).toEqual(['close', 'reject', 'resume']);
    expect(availableTaskVerbs('pairing', true, true)).toEqual([]);
    expect(availableTaskVerbs('complete', false, true)).toEqual(['reopen']);
  });

  test('unavailable reasons name the current status in product language', () => {
    expect(taskVerbUnavailableReason('stop', 'backlog', false)).toContain('backlog');
    expect(taskVerbUnavailableReason('start', 'working', true)).toContain('working');
    expect(taskVerbUnavailableReason('reopen', 'blocked', true)).toContain('reopened');
  });
});

describe('review-end and restructure verb availability', () => {
  test('sync is offered on blocked, conflict and interrupted', () => {
    expect(reviewEndVerbUnavailableReason('sync', 'blocked')).toBeNull();
    expect(reviewEndVerbUnavailableReason('sync', 'conflict')).toBeNull();
    expect(reviewEndVerbUnavailableReason('sync', 'interrupted')).toBeNull();
    expect(reviewEndVerbUnavailableReason('sync', 'working')).toContain('working');
  });

  test('submit needs blocked/conflict plus commits', () => {
    expect(reviewEndVerbUnavailableReason('submit', 'blocked')).toBeNull();
    expect(reviewEndVerbUnavailableReason('submit', 'blocked', { hasCommits: false })).toContain('no commits');
    expect(reviewEndVerbUnavailableReason('submit', 'working')).toContain('working');
  });

  test('agent review is offered on paused statuses only', () => {
    expect(agentReviewUnavailableReason('blocked')).toBeNull();
    expect(agentReviewUnavailableReason('conflict')).toBeNull();
    expect(agentReviewUnavailableReason('submitted')).toBeNull();
    expect(agentReviewUnavailableReason('interrupted')).toBeNull();
    expect(agentReviewUnavailableReason('working')).toContain('working');
    expect(agentReviewUnavailableReason('backlog')).toContain('backlog');
    expect(agentReviewUnavailableReason('complete')).toContain('complete');
  });

  test('restructure is disabled while working or pairing', () => {
    expect(restructureVerbUnavailableReason('clone', 'working')).toContain('working');
    expect(restructureVerbUnavailableReason('reparent', 'complete')).toContain('complete');
    expect(restructureVerbUnavailableReason('redo', 'complete')).toContain('complete');
    expect(restructureVerbUnavailableReason('clone', 'blocked')).toBeNull();
  });
});
