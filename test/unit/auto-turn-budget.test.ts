/**
 * Unit tests for per-task consecutive auto-turn budget.
 *
 * INVARIANT: Tasks cannot burn unlimited consecutive auto-triggered turns.
 * After max_auto_turns consecutive auto-turns without human/builder intervention,
 * the task is paused and waits for human review.
 *
 * INVARIANT: Human or builder unblock resets the consecutive auto-turn counter.
 * This ensures the budget is per-burst, not per-task-lifetime.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getConsecutiveAutoTurns,
  incrementConsecutiveAutoTurns,
  resetConsecutiveAutoTurns,
  checkAutoTurnBudget,
  shouldAutoReact,
  recordAutoReact,
  resetAutoReactCounters,
  readDailyBudget,
  incrementDailyBudget,
  calculateBackoffDelay,
  isGlobalAutoReactPaused,
  setGlobalAutoReactPaused,
} from '../../src/daemon/auto-react-budget';
import type { ResolvedConfig } from '../../src/config/types';
import type { Storage } from '../../src/storage/interface';

/**
 * Minimal in-memory storage mock for testing auto-react budget functions.
 * Only implements getTaskMetadata and updateTaskMetadata which are
 * the only storage methods used by the budget functions.
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
    // Stub out other methods that aren't used
  } as any;
}

function testConfig(overrides?: Partial<ResolvedConfig['daemon']>): ResolvedConfig {
  return {
    daemon: {
      auto_react_ci: true,
      auto_react_comments: true,
      auto_react_max_retries: 3,
      auto_react_backoff: 'none',
      auto_react_daily_budget: 50,
      max_auto_turns: 3,
      ...overrides,
    },
  } as ResolvedConfig;
}

describe('auto-turn budget', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let dataDir: string;

  beforeEach(async () => {
    storage = createMockStorage();
    dataDir = await mkdtemp(join(tmpdir(), 'lazy-budget-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TASK_A = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TASK_B = 'aaaa2222-bbbb-cccc-dddd-eeeeeeeeeeee';

  // INVARIANT: Consecutive auto-turn counter starts at 0 for new tasks.
  test('counter starts at 0', async () => {
    const count = await getConsecutiveAutoTurns(storage, TASK_ID);
    expect(count).toBe(0);
  });

  // INVARIANT: Each auto-react increments the consecutive counter.
  test('incrementConsecutiveAutoTurns increases counter', async () => {
    expect(await incrementConsecutiveAutoTurns(storage, TASK_ID)).toBe(1);
    expect(await incrementConsecutiveAutoTurns(storage, TASK_ID)).toBe(2);
    expect(await incrementConsecutiveAutoTurns(storage, TASK_ID)).toBe(3);
  });

  // INVARIANT: Human unblock resets the consecutive counter to 0.
  test('resetConsecutiveAutoTurns resets to 0', async () => {
    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(2);

    await resetConsecutiveAutoTurns(storage, TASK_ID);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(0);
  });

  // INVARIANT: checkAutoTurnBudget allows turns under the limit.
  test('checkAutoTurnBudget allows when under limit', async () => {
    const result = await checkAutoTurnBudget(storage, TASK_ID, 3);
    expect(result.allowed).toBe(true);
  });

  // INVARIANT: checkAutoTurnBudget blocks when at or over the limit.
  test('checkAutoTurnBudget blocks when limit reached', async () => {
    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    await incrementConsecutiveAutoTurns(storage, TASK_ID);

    const result = await checkAutoTurnBudget(storage, TASK_ID, 3);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Auto-turn budget exhausted');
    expect(result.reason).toContain('3/3');
  });

  // INVARIANT: shouldAutoReact integrates the auto-turn budget check.
  // When consecutive auto-turns hit the limit, shouldAutoReact blocks further auto-reacts.
  test('shouldAutoReact blocks when auto-turn budget exhausted', async () => {
    const config = testConfig({ max_auto_turns: 2 });

    // Simulate 2 consecutive auto-turns
    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    await incrementConsecutiveAutoTurns(storage, TASK_ID);

    const decision = await shouldAutoReact(storage, TASK_ID, 'ci_failure', config, dataDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Auto-turn budget exhausted');
  });

  // INVARIANT: shouldAutoReact allows when under budget.
  test('shouldAutoReact allows when under auto-turn budget', async () => {
    const config = testConfig({ max_auto_turns: 3 });

    await incrementConsecutiveAutoTurns(storage, TASK_ID);

    const decision = await shouldAutoReact(storage, TASK_ID, 'ci_failure', config, dataDir);
    expect(decision.allowed).toBe(true);
  });

  // INVARIANT: recordAutoReact increments the consecutive auto-turn counter.
  test('recordAutoReact increments consecutive counter', async () => {
    await recordAutoReact(storage, TASK_ID, 'ci_failure', dataDir);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(1);

    await recordAutoReact(storage, TASK_ID, 'comment', dataDir);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(2);
  });

  // INVARIANT: resetAutoReactCounters also resets the consecutive auto-turn counter.
  test('resetAutoReactCounters resets consecutive counter', async () => {
    await recordAutoReact(storage, TASK_ID, 'ci_failure', dataDir);
    await recordAutoReact(storage, TASK_ID, 'ci_failure', dataDir);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(2);

    await resetAutoReactCounters(storage, TASK_ID);
    expect(await getConsecutiveAutoTurns(storage, TASK_ID)).toBe(0);
  });

  // INVARIANT: Per-task budget — one task hitting its limit does NOT affect other tasks.
  test('budget is per-task (isolated)', async () => {
    // Exhaust budget for task A
    await incrementConsecutiveAutoTurns(storage, TASK_A);
    await incrementConsecutiveAutoTurns(storage, TASK_A);
    await incrementConsecutiveAutoTurns(storage, TASK_A);

    // Task A should be blocked
    const checkA = await checkAutoTurnBudget(storage, TASK_A, 3);
    expect(checkA.allowed).toBe(false);

    // Task B should still be allowed
    const checkB = await checkAutoTurnBudget(storage, TASK_B, 3);
    expect(checkB.allowed).toBe(true);
  });

  // INVARIANT: max_auto_turns is configurable.
  test('respects configurable max_auto_turns limit', async () => {
    await incrementConsecutiveAutoTurns(storage, TASK_ID);

    // With max_auto_turns=1, should be blocked after 1 turn
    const check1 = await checkAutoTurnBudget(storage, TASK_ID, 1);
    expect(check1.allowed).toBe(false);

    // With max_auto_turns=5, should still be allowed
    const check5 = await checkAutoTurnBudget(storage, TASK_ID, 5);
    expect(check5.allowed).toBe(true);
  });

  // INVARIANT: Auto-turn budget pauses the task via the auto-react pause mechanism.
  test('exhausting budget pauses auto-react for the task', async () => {
    const config = testConfig({ max_auto_turns: 2 });

    await incrementConsecutiveAutoTurns(storage, TASK_ID);
    await incrementConsecutiveAutoTurns(storage, TASK_ID);

    // This should trigger the pause
    const decision = await shouldAutoReact(storage, TASK_ID, 'ci_failure', config, dataDir);
    expect(decision.allowed).toBe(false);

    // Task should now be paused (subsequent calls blocked by gate 1, not gate 2)
    const decision2 = await shouldAutoReact(storage, TASK_ID, 'comment', config, dataDir);
    expect(decision2.allowed).toBe(false);
    expect(decision2.reason).toContain('Auto-turn budget exhausted');
  });
});

describe('global auto-react pause', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let dataDir: string;

  const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(async () => {
    storage = createMockStorage();
    dataDir = await mkdtemp(join(tmpdir(), 'lazy-budget-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  // INVARIANT: Global pause is off by default (no file = not paused).
  test('not paused by default', async () => {
    const result = await isGlobalAutoReactPaused(dataDir);
    expect(result.paused).toBe(false);
  });

  // INVARIANT: setGlobalAutoReactPaused(true) enables global pause.
  test('pause sets the global flag', async () => {
    await setGlobalAutoReactPaused(dataDir, true, 'testing');
    const result = await isGlobalAutoReactPaused(dataDir);
    expect(result.paused).toBe(true);
    expect(result.reason).toBe('testing');
  });

  // INVARIANT: setGlobalAutoReactPaused(false) clears global pause.
  test('resume clears the global flag', async () => {
    await setGlobalAutoReactPaused(dataDir, true, 'testing');
    await setGlobalAutoReactPaused(dataDir, false);
    const result = await isGlobalAutoReactPaused(dataDir);
    expect(result.paused).toBe(false);
  });

  // INVARIANT: Global pause blocks shouldAutoReact for ALL tasks (Gate 0).
  test('shouldAutoReact blocked when globally paused', async () => {
    const config = testConfig();
    await setGlobalAutoReactPaused(dataDir, true, 'emergency stop');

    const decision = await shouldAutoReact(storage, TASK_ID, 'ci_failure', config, dataDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('emergency stop');
  });

  // INVARIANT: Global resume allows shouldAutoReact to proceed (assuming other gates pass).
  test('shouldAutoReact allowed after global resume', async () => {
    const config = testConfig();
    await setGlobalAutoReactPaused(dataDir, true, 'testing');
    await setGlobalAutoReactPaused(dataDir, false);

    const decision = await shouldAutoReact(storage, TASK_ID, 'ci_failure', config, dataDir);
    expect(decision.allowed).toBe(true);
  });
});
