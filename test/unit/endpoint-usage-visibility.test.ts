import { expect, test } from 'bun:test';
import { memberEndpointUsageKey, type UsageLimitReading } from '../../src/proxy/usage-limits';
import { memberUsageLimitsView, projectUsageLimits, scopeUsageLimitsView } from '../../src/usage-pause/limits-view';

// INVARIANT: endpoint usage keys remain member-private in every part of a usage view. A new key prefix cannot turn another member's readings into project-wide data.
test('task and builder views include their granted endpoints and exclude other members', () => {
  const first = memberEndpointUsageKey('alice', 'first');
  const second = memberEndpointUsageKey('alice', 'second');
  const bob = memberEndpointUsageKey('bob', 'first');
  const keys = [first, second, bob];
  const readings: UsageLimitReading[] = keys.map(credential => ({
    credential, ts: 1, upstream: 'https://provider.example', backend: 'proxy', status: 200,
    taskId: null, model: null, headers: {}, windows: [],
  }));
  const verdict = (credential: string) => ({ credential, window: 'unified-5h', usedPercent: 97, threshold: 95, status: null, resetsAt: null, readingAt: 1 });
  const view = projectUsageLimits(readings, {
    configured: { threshold_percent: 95, credentials: Object.fromEntries(keys.map(key => [key, 95])) },
    override: null, paused: keys.map(verdict), held: keys.map((key, index) => ({
      taskId: `task-${index}`, task: `task-${index}`, hold: { ...verdict(key), held: 'auto-resume' as const, since: 1 },
    })), coverage: [],
  });
  const builder = memberUsageLimitsView(view, first, 'user:__service__', [first, second]);
  expect(builder.readings.map(r => r.credential)).toEqual([first, second]);
  expect(Object.keys(builder.pause.configured.credentials)).toEqual([first, second]);
  expect(builder.pause.paused.map(r => r.credential)).toEqual([first, second]);
  expect(builder.pause.held.map(r => r.hold.credential)).toEqual([first, second]);
  const task = scopeUsageLimitsView(view, second, 'task-0', [first, second]);
  expect(task.readings.map(r => r.credential)).toEqual([first, second]);
  expect(task.pause.held.map(r => r.taskId)).toEqual(['task-0']);
  const unbound = memberUsageLimitsView(view, null, 'user:__service__');
  expect(unbound.readings).toEqual([]);
  expect(unbound.pause.held).toEqual([]);
});
