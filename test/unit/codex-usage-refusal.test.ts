/**
 * Codex usage pausing against the 2026-09-25 refusal: at 01:04 Codex refused
 * ("You've hit your usage limit … try again at 5:52 AM") while lazy's saved
 * codex readings sat far under a 95% threshold, so no pause engaged.
 *
 * The raw headers of that night rotated out of the proxy audit log before
 * they could be read, so the header sets here are built from the SHAPE
 * codex-cli 0.152.1's own parser reads (`x-<limit>-{primary,secondary}-
 * {used-percent,window-minutes,reset-at}`) and the figures lazy reported
 * (primary 100% at the refusal, 18% / 61% on the readings before it).
 * Readings go through the real tracker, so the HTTP status reaches the
 * header → window mapping exactly as it does in the daemon.
 */
import { describe, test, expect } from 'bun:test';
import { codexRefusalHeaders, usageWindows, UsageLimitTracker } from '../../src/proxy/usage-limits';
import { evaluateUsagePause, STALE_UNTIMED_READING_MS, usageSourceFor } from '../../src/usage-pause/policy';

const NOW = 1_800_000_000_000;
const codex = usageSourceFor('codex')!;
const epochS = (msFromNow: number) => String(Math.floor((NOW + msFromNow) / 1000));
const PRIMARY_RESET_MS = 108 * 60_000; // 01:04 → 02:52
const SECONDARY_RESET_MS = 32 * 3600_000;

function latest(status: number, headers: Record<string, string>) {
  const t = new UsageLimitTracker();
  t.observeReading({
    credential: 'credential:chatgpt', ts: NOW, upstream: 'https://chatgpt.com',
    backend: 'proxy', status, taskId: null, model: null, headers,
  });
  return t.readings()[0]!;
}

const family = (prefix: string, primary: number, secondary: number) => ({
  [`${prefix}-primary-used-percent`]: String(primary),
  [`${prefix}-primary-window-minutes`]: '300',
  [`${prefix}-primary-reset-at`]: epochS(PRIMARY_RESET_MS),
  [`${prefix}-secondary-used-percent`]: String(secondary),
  [`${prefix}-secondary-window-minutes`]: '10080',
  [`${prefix}-secondary-reset-at`]: epochS(SECONDARY_RESET_MS),
});

describe('Codex refusal pauses the credential', () => {
  // INVARIANT: the refusal's own reading (primary 100%) pauses at 95% on the
  // 5-hour primary window, until that window resets — not the weekly one.
  test('the reading taken at the 429 trips at 95% on codex-primary', () => {
    const r = latest(429, { ...family('x-codex', 100, 61), 'x-codex-active-limit': 'codex' });
    const v = evaluateUsagePause(r, codex.pauseWindows, 95, NOW);
    expect(v).not.toBeNull();
    expect(v!.window).toBe('codex-primary');
    expect(v!.resetsAt).toBe(Math.floor((NOW + PRIMARY_RESET_MS) / 1000) * 1000);
  });

  // INVARIANT: a usage-limit refusal pauses whatever the percentages beside
  // it say, until the reset Codex STATED in its body — on 2026-09-25 Codex
  // refused while the readings lazy held were far under the threshold, and
  // its stated reset matched neither window lazy had read.
  test('a refusal body pauses until its stated reset, even under the threshold', () => {
    const statedMs = 7 * 3600_000;
    const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.floor((NOW + statedMs) / 1000) } });
    const r = latest(429, { ...family('x-codex', 18, 61), ...codexRefusalHeaders(body, NOW)! });
    const v = evaluateUsagePause(r, codex.pauseWindows, 95, NOW);
    expect(v?.window).toBe('codex-refused');
    expect(v?.status).toBe('rejected');
    expect(v?.resetsAt).toBe(Math.floor((NOW + statedMs) / 1000) * 1000);
    expect(evaluateUsagePause(r, codex.pauseWindows, 95, NOW + statedMs + 1)).toBeNull();
  });

  test('resets_in_seconds is anchored at the reading time', () => {
    const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 600 } });
    const r = latest(429, { ...family('x-codex', 18, 61), ...codexRefusalHeaders(body, NOW)! });
    expect(evaluateUsagePause(r, codex.pauseWindows, 95, NOW)?.resetsAt).toBe(NOW + 600_000);
  });

  // INVARIANT: a 429 that is NOT a usage-limit refusal (a plain rate limit,
  // every window under 100%) does not pause — it would otherwise stop every
  // Codex launch for half an hour on a transient limit.
  test('a plain 429 under the threshold does not pause', () => {
    expect(codexRefusalHeaders(JSON.stringify({ error: { type: 'rate_limit_exceeded' } }), NOW)).toBeNull();
    expect(evaluateUsagePause(latest(429, family('x-codex', 18, 61)), codex.pauseWindows, 95, NOW)).toBeNull();
  });

  test('a 429 naming the limit reached pauses untimed when no body reset is known', () => {
    const r = latest(429, { ...family('x-codex', 18, 61), 'x-codex-rate-limit-reached-type': 'primary' });
    const v = evaluateUsagePause(r, codex.pauseWindows, 95, NOW);
    expect(v?.window).toBe('codex-refused');
    expect(v?.resetsAt).toBeNull();
    expect(evaluateUsagePause(r, codex.pauseWindows, 95, NOW + STALE_UNTIMED_READING_MS + 1)).toBeNull();
  });

  // INVARIANT: a 200 at the same figures does not pause — only the refusal is a refusal.
  test('a 200 under the threshold does not pause', () => {
    expect(evaluateUsagePause(latest(200, family('x-codex', 18, 61)), codex.pauseWindows, 95, NOW)).toBeNull();
  });

  // INVARIANT: every metered limit family is read, not only the default
  // `x-codex-*` one — the limit that refuses can be a per-model one.
  test('a per-model limit family trips the pause on its own', () => {
    const r = latest(200, { ...family('x-codex', 18, 61), ...family('x-codex-bengalfox', 97, 40) });
    const v = evaluateUsagePause(r, codex.pauseWindows, 95, NOW);
    expect(v?.window).toBe('codex-bengalfox-primary');
  });
});

describe('Codex reset headers', () => {
  // INVARIANT: codex-cli 0.152.1 reads `reset-at`; when both spellings are
  // present the absolute one wins over the older countdown.
  test('reset-at wins over reset-after-seconds', () => {
    const w = usageWindows({
      'x-codex-primary-used-percent': '50',
      'x-codex-primary-reset-at': epochS(3600_000),
      'x-codex-primary-reset-after-seconds': '60',
    }, NOW);
    expect(w.find((x) => x.name === 'codex-primary')?.resetsAt).toBe(Math.floor((NOW + 3600_000) / 1000) * 1000);
  });
});
