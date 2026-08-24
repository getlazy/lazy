/**
 * Unit tests for the per-task turn budget (src/daemon/turn-budget.ts).
 *
 * INVARIANT: Only builder/agent-initiated turns consume the budget; a human
 * unblock/resume resets the counter to 0. This is enforced at the call sites
 * in task-lifecycle.ts/task-launcher.ts (actor === 'human' gates the reset),
 * not inside this module — but the module's own contract (increment vs
 * reset are separate, explicit calls) is what makes that gating possible.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getNonHumanTurnCount,
  incrementNonHumanTurnCount,
  resetNonHumanTurnCount,
  checkTurnBudget,
} from '../../src/daemon/turn-budget';
import type { Storage } from '../../src/storage/interface';

/**
 * Minimal in-memory storage mock — only getTaskMetadata/updateTaskMetadata
 * are used by turn-budget.ts. Mirrors test/unit/auto-turn-budget.test.ts.
 */
function createMockStorage(): Storage & { metadata: Map<string, Map<string, string>> } {
  const metadata = new Map<string, Map<string, string>>();

  return {
    metadata,
    async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
      return metadata.get(taskId)?.get(key) ?? null;
    },
    async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
      if (!metadata.has(taskId)) {
        metadata.set(taskId, new Map());
      }
      metadata.get(taskId)!.set(key, value);
    },
  } as any;
}

describe('turn budget', () => {
  let storage: ReturnType<typeof createMockStorage>;

  const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TASK_A = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TASK_B = 'aaaa2222-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    storage = createMockStorage();
  });

  // INVARIANT: New tasks start with an empty budget.
  test('counter starts at 0', async () => {
    expect(await getNonHumanTurnCount(storage, TASK_ID)).toBe(0);
  });

  // INVARIANT: Each builder/agent-initiated turn increments the counter.
  test('incrementNonHumanTurnCount increases and returns the new count', async () => {
    expect(await incrementNonHumanTurnCount(storage, TASK_ID)).toBe(1);
    expect(await incrementNonHumanTurnCount(storage, TASK_ID)).toBe(2);
    expect(await incrementNonHumanTurnCount(storage, TASK_ID)).toBe(3);
    expect(await getNonHumanTurnCount(storage, TASK_ID)).toBe(3);
  });

  // INVARIANT: A human turn resets the counter to 0.
  test('resetNonHumanTurnCount resets to 0', async () => {
    await incrementNonHumanTurnCount(storage, TASK_ID);
    await incrementNonHumanTurnCount(storage, TASK_ID);
    expect(await getNonHumanTurnCount(storage, TASK_ID)).toBe(2);

    await resetNonHumanTurnCount(storage, TASK_ID);
    expect(await getNonHumanTurnCount(storage, TASK_ID)).toBe(0);
  });

  // INVARIANT: The counter is per-task — exhausting one task's budget must
  // not affect another task's.
  test('counter is per-task (isolated)', async () => {
    await incrementNonHumanTurnCount(storage, TASK_A);
    await incrementNonHumanTurnCount(storage, TASK_A);
    await incrementNonHumanTurnCount(storage, TASK_A);
    expect(await getNonHumanTurnCount(storage, TASK_A)).toBe(3);
    expect(await getNonHumanTurnCount(storage, TASK_B)).toBe(0);
  });

  describe('checkTurnBudget', () => {
    // INVARIANT: 0 means unlimited — never blocks, regardless of count.
    test('max_turns_without_human = 0 means unlimited', () => {
      expect(checkTurnBudget(0, 0).allowed).toBe(true);
      expect(checkTurnBudget(1_000_000, 0).allowed).toBe(true);
    });

    // INVARIANT: Allowed strictly under the limit.
    test('allows turns under the limit', () => {
      const result = checkTurnBudget(2, 10);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.count).toBe(2);
    });

    // INVARIANT: Blocked once the count reaches the limit — the cap is
    // inclusive, so the (max+1)th turn is refused, not the (max+2)th.
    test('blocks when count reaches the limit', () => {
      const result = checkTurnBudget(10, 10);
      expect(result.allowed).toBe(false);
      expect(result.count).toBe(10);
      expect(result.reason).toContain('10/10 consecutive turns');
      expect(result.reason).toContain('limits.max_turns_without_human');
      expect(result.reason).toContain('lazy unblock');
      expect(result.reason).toContain('lazy resume');
    });

    // INVARIANT: Blocked when count exceeds the limit too (defensive — should
    // never happen since the check runs before each increment, but the
    // decision must stay refused rather than flip back to allowed).
    test('stays blocked when count exceeds the limit', () => {
      const result = checkTurnBudget(11, 10);
      expect(result.allowed).toBe(false);
    });

    // INVARIANT: Configurable per project via limits.max_turns_without_human.
    test('respects a configurable limit', () => {
      expect(checkTurnBudget(1, 1).allowed).toBe(false);
      expect(checkTurnBudget(1, 5).allowed).toBe(true);
    });
  });

  // INVARIANT: increment + checkTurnBudget compose to the same behavior the
  // daemon relies on — the count returned by increment is what gets checked
  // on the NEXT builder/agent-initiated turn attempt.
  test('increment then checkTurnBudget blocks once the cap is hit', async () => {
    const max = 3;
    for (let i = 0; i < max; i++) {
      const count = await getNonHumanTurnCount(storage, TASK_ID);
      expect(checkTurnBudget(count, max).allowed).toBe(true);
      await incrementNonHumanTurnCount(storage, TASK_ID);
    }

    const countAtCap = await getNonHumanTurnCount(storage, TASK_ID);
    expect(countAtCap).toBe(max);
    expect(checkTurnBudget(countAtCap, max).allowed).toBe(false);

    // A human resets it, and the budget opens back up.
    await resetNonHumanTurnCount(storage, TASK_ID);
    const countAfterReset = await getNonHumanTurnCount(storage, TASK_ID);
    expect(checkTurnBudget(countAfterReset, max).allowed).toBe(true);
  });
});
