import { describe, test, expect } from 'bun:test';
import {
  parseTokenCap, formatTokenCount, runningStopLine, isSpendStopResponse,
  USAGE_PAUSE_STOPPED_KEY, TOKEN_CAP_STOPPED_KEY,
} from '../../src/usage-pause/running-stop';

const usage = JSON.stringify({
  credential: 'c', window: 'unified-7d', usedPercent: 95, status: null, threshold: 95,
  resetsAt: Date.UTC(2026, 9, 27, 9, 0), readingAt: 0, stoppedAt: 0, commandId: 'cmd-1',
});
const cap = JSON.stringify({ cap: 50_000_000, spent: 50_000_000, stoppedAt: 0, commandId: 'cmd-2' });

describe('running-turn stop records', () => {
  test('token caps parse as people write them; none clears', () => {
    expect(parseTokenCap('50M')).toBe(50_000_000);
    expect(parseTokenCap('1.5m')).toBe(1_500_000);
    expect(parseTokenCap('200k')).toBe(200_000);
    expect(parseTokenCap('50_000_000')).toBe(50_000_000);
    expect(parseTokenCap('none')).toBeNull();
    expect(parseTokenCap(0)).toBeNull();
    expect(() => parseTokenCap('lots')).toThrow(/Invalid token cap/);
    expect(formatTokenCount(50_000_000)).toBe('50M');
    expect(formatTokenCount(12_400_000)).toBe('12.4M');
  });

  // INVARIANT: a stop line is shown only while the task rests where the stop
  // left it — `interrupted` for usage, `blocked`/`conflict` for the cap. A
  // stale record must never label a later state (a crash, a new turn).
  test('the stop line follows the status the stop left', () => {
    const md = { [USAGE_PAUSE_STOPPED_KEY]: usage, [TOKEN_CAP_STOPPED_KEY]: cap };
    expect(runningStopLine({ status: 'interrupted', metadata: md })).toBe('Paused for usage: 7-day window at 95%, resumes Tue 09:00 UTC');
    expect(runningStopLine({ status: 'blocked', metadata: md })).toBe('Stopped at its token cap (50M of 50M)');
    expect(runningStopLine({ status: 'working', metadata: md })).toBeNull();
  });

  // INVARIANT: the reconciler drops only THIS stop's own error response — a
  // response from another turn (another command id) is still handled as a crash.
  test('only the stopped turn\'s error response is recognised', () => {
    const task = { status: 'interrupted', metadata: { [USAGE_PAUSE_STOPPED_KEY]: usage } };
    expect(isSpendStopResponse(task, { status: 'error' }, 'cmd-1')).toBe(true);
    expect(isSpendStopResponse(task, { status: 'error' }, 'cmd-9')).toBe(false);
    expect(isSpendStopResponse(task, { status: 'completed' }, 'cmd-1')).toBe(false);
    expect(isSpendStopResponse({ status: 'interrupted', metadata: {} }, { status: 'error' }, 'cmd-1')).toBe(false);
  });
});
