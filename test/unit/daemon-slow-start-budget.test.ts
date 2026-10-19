import { describe, test, expect } from 'bun:test';
import { DAEMON_STORE_OPEN_DEADLINE_MS, SLOW_START_BUDGET_MS } from '../../src/daemon/auto-start';
import { STORE_OPEN_DEADLINE_MS } from '../../src/daemon/rpc-handlers';

// INVARIANT: a background daemon start waits for a live, unfailed child at least
// as long as the daemon itself waits for its store to open. The store opens
// before the daemon binds, so a shorter wait declares a slow but healthy start
// of a large store failed while the daemon comes up by itself moments later.
describe('background start budget', () => {
  test('covers the daemon store-open deadline', () => {
    expect(DAEMON_STORE_OPEN_DEADLINE_MS).toBe(STORE_OPEN_DEADLINE_MS);
    expect(SLOW_START_BUDGET_MS).toBeGreaterThan(STORE_OPEN_DEADLINE_MS);
  });
});
