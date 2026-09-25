/**
 * The usage-pause POLICY (src/usage-pause/policy.ts): given a credential's
 * latest reading, may a new turn on it start?
 *
 * Readings are built through the real `usageWindows()` from raw headers, so the
 * header → window mapping and the pause rule are exercised together, exactly
 * as the launch gate sees them.
 */
import { describe, test, expect } from 'bun:test';
import { usageWindows, type UsageLimitReading } from '../../src/proxy/usage-limits';
import {
  anySourcePauseWindows,
  describeUsagePause,
  evaluateUsagePause,
  readingCoverage,
  STALE_UNTIMED_READING_MS,
  thresholdFor,
  usageSourceFor,
  windowLabel,
} from '../../src/usage-pause/policy';
import { parseUsagePauseOverride } from '../../src/daemon/usage-pause';
import { parseUsagePauseHold, usagePauseHoldOf, USAGE_PAUSE_HELD_KEY } from '../../src/usage-pause/hold';

const NOW = 1_800_000_000_000;
const claude = usageSourceFor('claude-code')!;

function reading(headers: Record<string, string>, ts = NOW - 1000): UsageLimitReading {
  return {
    credential: 'credential:CLAUDE_CODE_OAUTH_TOKEN',
    ts,
    upstream: 'https://api.anthropic.com',
    backend: 'proxy',
    status: 200,
    taskId: null,
    model: null,
    headers,
    windows: usageWindows(headers, ts),
  };
}

const inSeconds = (s: number) => String(Math.floor((NOW + s * 1000) / 1000));

describe('evaluateUsagePause', () => {
  // INVARIANT: pausing is opt-in. With no threshold nothing pauses, whatever
  // the reading says — the feature exists for accounts with paid overage, and
  // without overage the provider stops at 100% by itself.
  test('a threshold of 0 never pauses', () => {
    const r = reading({ 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-5h-reset': inSeconds(600) });
    expect(evaluateUsagePause(r, claude.pauseWindows, 0, NOW)).toBeNull();
  });

  test('below the threshold: not paused', () => {
    const r = reading({ 'anthropic-ratelimit-unified-5h-utilization': '0.80', 'anthropic-ratelimit-unified-5h-reset': inSeconds(600) });
    expect(evaluateUsagePause(r, claude.pauseWindows, 95, NOW)).toBeNull();
  });

  test('at or past the threshold: paused, naming the window, reading and reset', () => {
    const r = reading({
      'anthropic-ratelimit-unified-5h-utilization': '0.95',
      'anthropic-ratelimit-unified-5h-reset': inSeconds(600),
      'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
    });
    const v = evaluateUsagePause(r, claude.pauseWindows, 95, NOW);
    expect(v).not.toBeNull();
    expect(v!.window).toBe('unified-5h');
    expect(v!.usedPercent).toBe(95);
    expect(v!.threshold).toBe(95);
    expect(v!.resetsAt).toBe(Number(inSeconds(600)) * 1000);
    const text = describeUsagePause(v!, NOW);
    expect(text).toContain('credential:CLAUDE_CODE_OAUTH_TOKEN');
    expect(text).toContain('5-hour window');
    expect(text).toContain('95%');
    expect(text).toContain('resets at');
  });

  // INVARIANT: a pause lifts by itself at the window's reset. No turn can
  // start while paused, so nothing will bring a fresher reading — a reading
  // taken before the reset must stop counting once the reset time has passed.
  test('a window whose reset has passed no longer pauses', () => {
    const r = reading(
      { 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-5h-reset': inSeconds(-1) },
      NOW - 60_000,
    );
    expect(evaluateUsagePause(r, claude.pauseWindows, 95, NOW)).toBeNull();
  });

  test('the pause lasts until the LATEST reset among tripped windows', () => {
    const r = reading({
      'anthropic-ratelimit-unified-5h-utilization': '0.97',
      'anthropic-ratelimit-unified-5h-reset': inSeconds(600),
      'anthropic-ratelimit-unified-7d-utilization': '0.96',
      'anthropic-ratelimit-unified-7d-reset': inSeconds(86_400),
    });
    const v = evaluateUsagePause(r, claude.pauseWindows, 95, NOW)!;
    expect(v.window).toBe('unified-7d');
  });

  test('a rejected window pauses even below the threshold', () => {
    const r = reading({
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': inSeconds(3600),
    });
    expect(evaluateUsagePause(r, claude.pauseWindows, 95, NOW)?.window).toBe('unified-7d');
  });

  // INVARIANT: an untimed pause cannot be permanent. A tripped window with no
  // reset time pauses only while its reading is fresh; after that the next turn
  // is let through, which is also what refreshes the reading.
  test('a tripped window with no reset time expires with its reading', () => {
    const headers = { 'anthropic-ratelimit-unified-5h-utilization': '0.99' };
    expect(evaluateUsagePause(reading(headers, NOW - 1000), claude.pauseWindows, 95, NOW)).not.toBeNull();
    expect(
      evaluateUsagePause(reading(headers, NOW - STALE_UNTIMED_READING_MS - 1), claude.pauseWindows, 95, NOW),
    ).toBeNull();
  });

  // INVARIANT: per-minute API-key limits are never a reason to pause — they
  // refill within a minute and have nothing to do with paid overage.
  test('API-key per-minute windows never pause', () => {
    const r = reading({
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-reset': new Date(NOW + 30_000).toISOString(),
    });
    expect(evaluateUsagePause(r, claude.pauseWindows, 50, NOW)).toBeNull();
    expect(evaluateUsagePause(r, anySourcePauseWindows, 50, NOW)).toBeNull();
  });

  // INVARIANT: a status-only `rejected` pauses — per window or the overall
  // `unified-status` — even with no `-utilization` header beside it. The
  // provider is already refusing the credential; that no percentage came with
  // it must not read as "not paused". A `rejected` OVERAGE status never pauses.
  test('a status-only rejected pauses; an overage rejected does not', () => {
    const overall = reading({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': inSeconds(900),
    });
    const v = evaluateUsagePause(overall, claude.pauseWindows, 95, NOW)!;
    expect(v.window).toBe('unified');
    expect(v.resetsAt).toBe(NOW + 900_000);
    expect(describeUsagePause(v, NOW)).toContain('overall subscription limit is rejected');
    const perWindow = reading({ 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': inSeconds(60) });
    expect(evaluateUsagePause(perWindow, claude.pauseWindows, 95, NOW)?.window).toBe('unified-5h');
    const overage = reading({ 'anthropic-ratelimit-unified-overage-status': 'rejected', 'anthropic-ratelimit-unified-status': 'allowed' });
    expect(evaluateUsagePause(overage, claude.pauseWindows, 95, NOW)).toBeNull();
  });

  test('no reading, no pause', () => {
    expect(evaluateUsagePause(null, claude.pauseWindows, 95, NOW)).toBeNull();
  });
});

describe('harness sources', () => {
  // INVARIANT: the pause is abstracted per harness. A harness with no known
  // usage signal has no source and is never paused, rather than being read as
  // 0% or judged by another harness's headers.
  test('claude-code and codex have sources; cursor and pi do not', () => {
    expect(usageSourceFor('claude-code')).not.toBeNull();
    expect(usageSourceFor('codex')).not.toBeNull();
    expect(usageSourceFor('cursor')).toBeNull();
    expect(usageSourceFor('pi')).toBeNull();
  });

  test('codex reads its own subscription windows, not Claude\'s', () => {
    const codex = usageSourceFor('codex')!;
    const r = reading({ 'x-codex-primary-used-percent': '97', 'x-codex-primary-reset-after-seconds': '600' });
    expect(evaluateUsagePause(r, codex.pauseWindows, 95, NOW)?.window).toBe('codex-primary');
    expect(evaluateUsagePause(r, claude.pauseWindows, 95, NOW)).toBeNull();
  });
});

describe('thresholdFor', () => {
  test('a per-credential entry wins, including 0 = never pause', () => {
    const cfg = { threshold_percent: 95, credentials: { 'user:a@x': 80, 'user:b@x': 0 } };
    expect(thresholdFor(cfg, 'user:a@x')).toBe(80);
    expect(thresholdFor(cfg, 'user:b@x')).toBe(0);
    expect(thresholdFor(cfg, 'user:c@x')).toBe(95);
  });
});

describe('the one-shot override value', () => {
  test('accepts a percent or off', () => {
    expect(parseUsagePauseOverride('100')).toBe(100);
    expect(parseUsagePauseOverride(97.5)).toBe(97.5);
    expect(parseUsagePauseOverride('off')).toBe(0);
  });

  test('refuses anything else, loudly', () => {
    for (const bad of ['', 'lots', '101', '-1', undefined]) {
      expect(() => parseUsagePauseOverride(bad)).toThrow(/usage_pause_threshold/);
    }
  });
});

describe('hold markers', () => {
  test('round-trip through task metadata', () => {
    const hold = {
      credential: 'credential:X', window: 'unified-5h', usedPercent: 97, status: null,
      threshold: 95, resetsAt: NOW + 1000, readingAt: NOW, held: 'auto-resume', since: NOW,
    };
    expect(usagePauseHoldOf({ metadata: { [USAGE_PAUSE_HELD_KEY]: JSON.stringify(hold) } })).toEqual(hold);
    expect(usagePauseHoldOf({ metadata: { [USAGE_PAUSE_HELD_KEY]: '' } })).toBeNull();
    expect(parseUsagePauseHold('{not json')).toBeNull();
  });
});

test('windowLabel reads like prose', () => {
  expect(windowLabel('unified-5h')).toBe('5-hour window');
  expect(windowLabel('unified-7d')).toBe('7-day window');
  expect(windowLabel('codex-primary')).toBe('codex-primary window');
});

describe('what an override value lets through', () => {
  // INVARIANT: every surface recommends `usage_pause_threshold off`, never 100.
  // An override is a threshold for one turn and the comparison is `>=`, so 100
  // still pauses at a full window and at a window the provider already refuses —
  // exactly the readings someone reaches for the override at. `off` (0) always
  // lets the turn through.
  const full = reading({
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-5h-reset': inSeconds(600),
  });
  const refused = reading({
    'anthropic-ratelimit-unified-5h-utilization': '0.9',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': inSeconds(600),
  });

  test('100 does not cover a full window or a rejected one', () => {
    expect(evaluateUsagePause(full, claude.pauseWindows, 100, NOW)).not.toBeNull();
    expect(evaluateUsagePause(refused, claude.pauseWindows, 100, NOW)).not.toBeNull();
  });

  test('off covers both', () => {
    const off = parseUsagePauseOverride('off');
    expect(evaluateUsagePause(full, claude.pauseWindows, off, NOW)).toBeNull();
    expect(evaluateUsagePause(refused, claude.pauseWindows, off, NOW)).toBeNull();
  });
});

describe('readingCoverage', () => {
  // INVARIANT: "armed, NO READING" is decided by whether a reading carries a
  // subscription window WITH A PERCENTAGE — the only thing a threshold can act
  // on. No reading, an API key's per-minute limits, or a bare status are all
  // `none`: the pause cannot engage before the account is already refused, and
  // every surface must say so instead of reporting "nothing is paused".
  test('none without a subscription percentage', () => {
    expect(readingCoverage(null, claude.pauseWindows, NOW)).toBe('none');
    expect(readingCoverage(reading({
      'anthropic-ratelimit-tokens-limit': '1000', 'anthropic-ratelimit-tokens-remaining': '10',
    }), claude.pauseWindows, NOW)).toBe('none');
    expect(readingCoverage(reading({ 'anthropic-ratelimit-unified-status': 'allowed' }), claude.pauseWindows, NOW))
      .toBe('none');
  });

  // INVARIANT: a reading whose every window has reset since it was taken is
  // STALE — today's usage is unknown — and is never reported as a current one.
  test('stale once every window has reset; a reading otherwise', () => {
    const current = reading({ 'anthropic-ratelimit-unified-5h-utilization': '0.4', 'anthropic-ratelimit-unified-5h-reset': inSeconds(60) });
    expect(readingCoverage(current, claude.pauseWindows, NOW)).toBe('reading');
    const reset = reading({ 'anthropic-ratelimit-unified-5h-utilization': '0.97', 'anthropic-ratelimit-unified-5h-reset': inSeconds(-60) });
    expect(readingCoverage(reset, claude.pauseWindows, NOW)).toBe('stale');
    const untimedOld = reading({ 'anthropic-ratelimit-unified-5h-utilization': '0.97' }, NOW - STALE_UNTIMED_READING_MS - 1);
    expect(readingCoverage(untimedOld, claude.pauseWindows, NOW)).toBe('stale');
  });
});
