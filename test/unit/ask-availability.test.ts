/**
 * The ONE rule every ask surface routes on.
 *
 * `lazy ask`, the `lazy_ask` MCP tool, the web ask box and the daemon's own
 * dispatch all call `resolveAskAvailability`. These tests pin what it decides,
 * because the failure this rule replaced was invisible from any single surface:
 * the page promised an answer the daemon then refused, in wording a finished
 * task could never act on.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveAskAvailability,
  askUnavailableReason,
  LIVE_ASK_STATUSES,
  type AskContext,
} from '../../src/server/review-actions';

function ctx(over: Partial<AskContext> = {}): AskContext {
  return {
    status: 'blocked',
    liveSession: true,
    resumableAgentSession: true,
    worktreeExists: true,
    hasRecord: true,
    ...over,
  };
}

describe('resolveAskAvailability', () => {
  test('a blocked task with a resumable session asks the live agent', () => {
    const a = resolveAskAvailability(ctx());
    expect(a.route).toBe('live');
    expect(a.unavailable).toBeNull();
    // No provenance line on the live route: the agent IS the source.
    expect(a.provenance).toBeNull();
  });

  test('conflict is askable live too — it is a blocked variant', () => {
    expect(resolveAskAvailability(ctx({ status: 'conflict' })).route).toBe('live');
    expect(LIVE_ASK_STATUSES.has('conflict')).toBe(true);
  });

  // INVARIANT (the bug this rule replaced): a finished task is ANSWERED, not
  // refused. The old gate told a complete task to "re-send it once the task is
  // blocked" — advice it can never satisfy, because it will never be blocked
  // again.
  test('a complete task is answered from its stored record, not refused', () => {
    const a = resolveAskAvailability(ctx({ status: 'complete', liveSession: false }));
    expect(a.route).toBe('record');
    expect(a.unavailable).toBeNull();
    expect(a.provenance).toContain('stored record');
    expect(a.provenance).not.toContain('re-send');
  });

  test.each([
    ['an ended session', ctx({ liveSession: false })],
    ['no agent session to resume', ctx({ resumableAgentSession: false })],
    ['a removed worktree', ctx({ worktreeExists: false })],
    ['a working task', ctx({ status: 'working' })],
  ])('%s routes to the record', (_label, context) => {
    const a = resolveAskAvailability(context);
    expect(a.route).toBe('record');
    expect(a.unavailable).toBeNull();
  });

  // The one genuinely unanswerable case: nothing was ever recorded, so an
  // answer could only be invented.
  test('a task that never ran has nothing to answer from', () => {
    const a = resolveAskAvailability(ctx({ status: 'backlog', liveSession: false, hasRecord: false }));
    expect(a.route).toBeNull();
    expect(a.unavailable).toContain('nothing recorded');
    expect(a.unavailable).toContain('Your question is saved');
    expect(askUnavailableReason(ctx({ status: 'backlog', liveSession: false, hasRecord: false })))
      .toBe(a.unavailable);
  });

  test('askUnavailableReason is null whenever an answer is possible', () => {
    expect(askUnavailableReason(ctx())).toBeNull();
    expect(askUnavailableReason(ctx({ status: 'complete', liveSession: false }))).toBeNull();
  });

  // The provenance sentence is shown to the reviewer and stored with the
  // answer, so it must say why the live agent was not used.
  test('the provenance names why the live session was not resumed', () => {
    expect(resolveAskAvailability(ctx({ liveSession: false })).provenance)
      .toContain('session has ended');
    expect(resolveAskAvailability(ctx({ worktreeExists: false })).provenance)
      .toContain('worktree has been removed');
    expect(resolveAskAvailability(ctx({ status: 'accepted' })).provenance)
      .toContain('the task is accepted');
  });
});
