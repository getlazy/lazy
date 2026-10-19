import { test, expect } from 'bun:test';
import { evaluateManagedConfig } from '../../src/config/managed';

// INVARIANT: only trusted control-plane configuration may declare destinations/auth in managed mode; task branches cannot.
test('named endpoint control-plane authority matches inline profile authority', () => {
  const raw = { endpoints: { work: { url: 'https://api.anthropic.com', credential: 'work-anthropic' } } };
  const env = { LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: '/tmp/not-used-managed-store' };
  expect(evaluateManagedConfig(raw, env, 'control-plane').refusals).toEqual([]);
  expect(evaluateManagedConfig(raw, env, 'repository').refusals.map(r => r.key)).toEqual(['endpoints.*.url', 'endpoints.*.credential']);
});
