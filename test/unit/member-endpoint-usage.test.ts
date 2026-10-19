import { expect, test } from 'bun:test';
import { memberEndpointUsageKey, UsageLimitTracker, usageLimitCredentialKey } from '../../src/proxy/usage-limits';
import { validateStoredUsageLimitReading } from '../../src/storage/usage-limit-readings';

// INVARIANT: usage belongs to the actual member and endpoint, independently of profile and origin. Delimited names must not merge accounts.
test('member endpoint keys are canonical, unambiguous and accepted by the durable store', () => {
  const key = memberEndpointUsageKey(' A@Example.com ', 'named');
  expect(key).toBe(memberEndpointUsageKey('a@example.com', 'named'));
  expect(key).not.toBe(memberEndpointUsageKey('a@example.com', 'other'));
  expect(memberEndpointUsageKey('a:b', 'c')).not.toBe(memberEndpointUsageKey('a', 'b:c'));
  expect(usageLimitCredentialKey({ userId: 'a@example.com', endpoint: 'named', upstream: 'https://host' })).toBe(key);
  expect(() => validateStoredUsageLimitReading({ credential: key, ts: Date.now(), upstream: 'https://host', backend: 'proxy', status: 200, taskId: null, model: null, headers: {} })).not.toThrow();
});

// INVARIANT: replacement forgets only the replaced connection's usage, making it unknown until a new response. It cannot carry the previous account's full window forward.
test('clearing a connection removes its reading and spend without affecting another endpoint', () => {
  const tracker = new UsageLimitTracker();
  const first = memberEndpointUsageKey('member', 'first');
  const other = memberEndpointUsageKey('member', 'other');
  for (const credential of [first, other]) tracker.observeReading({
    credential, ts: Date.now(), upstream: 'https://host', backend: 'proxy', status: 200, taskId: null, model: null,
    headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.97' },
  });
  tracker.clear(first);
  expect(tracker.reading(first)).toBeNull();
  expect(tracker.spentCredentials().has(first)).toBe(false);
  expect(tracker.spentUpstreams(first)).toEqual([]);
  expect(tracker.reading(other)?.windows[0]?.usedPercent).toBe(97);
});
