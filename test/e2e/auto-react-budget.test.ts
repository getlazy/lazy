/**
 * E2e tests for auto-react budget controls.
 *
 * Tests cover:
 * - Per-task auto-react counter increments
 * - Counter resets on manual unblock
 * - Auto-react refusal when limit is reached
 * - Global daily budget enforcement
 * - Auto-react paused flag shown in show/blocked output
 * - Backoff calculation
 * - Config loading
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';

// --- Unit-style tests that don't need the full lazy e2e setup ---

describe('auto-react backoff calculation', () => {
  test('exponential backoff delays', async () => {
    const { calculateBackoffDelay } = await import('../../src/daemon/auto-react-budget');

    // 1st auto-unblock (count=0): immediate
    expect(calculateBackoffDelay('exponential', 0)).toBe(0);

    // 2nd auto-unblock (count=1): 1 minute
    expect(calculateBackoffDelay('exponential', 1)).toBe(60_000);

    // 3rd auto-unblock (count=2): 5 minutes
    expect(calculateBackoffDelay('exponential', 2)).toBe(300_000);

    // Beyond max: clamp to last delay
    expect(calculateBackoffDelay('exponential', 10)).toBe(300_000);
  });

  test('linear backoff delays', async () => {
    const { calculateBackoffDelay } = await import('../../src/daemon/auto-react-budget');

    expect(calculateBackoffDelay('linear', 0)).toBe(0);
    expect(calculateBackoffDelay('linear', 1)).toBe(60_000);
    expect(calculateBackoffDelay('linear', 2)).toBe(120_000);
  });

  test('no backoff when strategy is none', async () => {
    const { calculateBackoffDelay } = await import('../../src/daemon/auto-react-budget');

    expect(calculateBackoffDelay('none', 0)).toBe(0);
    expect(calculateBackoffDelay('none', 5)).toBe(0);
  });
});

describe('auto-react daily budget file', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lazy-budget-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('daily budget file is created with correct format', async () => {
    const { incrementDailyBudget, readDailyBudget, isDailyBudgetExhausted } = await import('../../src/daemon/auto-react-budget');
    const { localDayKey } = await import('../../src/utils/local-day');

    // Initial state: no budget file
    const initial = await readDailyBudget(tempDir);
    expect(initial.used).toBe(0);
    // INVARIANT: the budget day key is the LOCAL calendar day, not UTC.
    // "Today" must roll over at the user's local midnight so the budget tracks
    // their wall clock (previously this asserted the UTC ISO date, which reset
    // at an arbitrary offset from the user's day).
    expect(initial.date).toBe(localDayKey());

    // Increment
    const count = await incrementDailyBudget(tempDir);
    expect(count).toBe(1);

    // Read back
    const after = await readDailyBudget(tempDir);
    expect(after.used).toBe(1);

    // Not exhausted at 1/50
    expect(await isDailyBudgetExhausted(tempDir, 50)).toBe(false);

    // Exhausted at 1/1
    expect(await isDailyBudgetExhausted(tempDir, 1)).toBe(true);
  });

  test('daily budget resets on new (local) day', async () => {
    const { readDailyBudget } = await import('../../src/daemon/auto-react-budget');
    const { localDayKey } = await import('../../src/utils/local-day');

    // Write a budget file with yesterday's date
    const budgetPath = join(tempDir, 'auto-react-budget.json');
    writeFileSync(budgetPath, JSON.stringify({ date: '2025-01-01', used: 42 }));

    // Reading should reset because the date doesn't match today's LOCAL day key.
    // INVARIANT: day-boundary reset is anchored to local midnight, not UTC.
    const budget = await readDailyBudget(tempDir);
    expect(budget.used).toBe(0);
    expect(budget.date).toBe(localDayKey());
  });

  // INVARIANT: Daily budget prevents runaway spending.
  // Without this, a project could accumulate unlimited auto-triggered
  // turns in a single day from pathological loops.
  test('multiple increments track correctly', async () => {
    const { incrementDailyBudget, readDailyBudget, isDailyBudgetExhausted } = await import('../../src/daemon/auto-react-budget');

    for (let i = 0; i < 5; i++) {
      await incrementDailyBudget(tempDir);
    }

    const budget = await readDailyBudget(tempDir);
    expect(budget.used).toBe(5);
    expect(await isDailyBudgetExhausted(tempDir, 5)).toBe(true);
    expect(await isDailyBudgetExhausted(tempDir, 6)).toBe(false);
  });

  test('today-only cap override changes the effective limit, not the config', async () => {
    const { adjustDailyCap, readDailyBudget, effectiveDailyLimit, isDailyBudgetExhausted, incrementDailyBudget } =
      await import('../../src/daemon/auto-react-budget');

    // Absolute set
    let cap = await adjustDailyCap(tempDir, 50, { kind: 'absolute', value: 100 });
    expect(cap).toBe(100);
    let state = await readDailyBudget(tempDir);
    expect(effectiveDailyLimit(state, 50)).toBe(100);

    // Relative add/subtract operate on the current effective cap
    cap = await adjustDailyCap(tempDir, 50, { kind: 'relative', value: -30 });
    expect(cap).toBe(70);

    // Cap floors at 0
    cap = await adjustDailyCap(tempDir, 50, { kind: 'relative', value: -999 });
    expect(cap).toBe(0);

    // Reset to a usable cap; exhaustion respects the override (not the config limit)
    await adjustDailyCap(tempDir, 50, { kind: 'absolute', value: 2 });
    await incrementDailyBudget(tempDir);
    await incrementDailyBudget(tempDir);
    expect(await isDailyBudgetExhausted(tempDir, 50)).toBe(true); // 2/2 even though config is 50
  });

  test('incrementDailyBudget appends an activity-log entry when given one', async () => {
    const { incrementDailyBudget, readDailyBudget } = await import('../../src/daemon/auto-react-budget');

    await incrementDailyBudget(tempDir, { taskId: 'abc12345', taskCode: 'fix-thing', trigger: 'ci_failure' });
    await incrementDailyBudget(tempDir, { taskId: 'def67890', trigger: 'comment' });
    // A bare increment (no entry) must still bump the counter without a log row.
    await incrementDailyBudget(tempDir);

    const state = await readDailyBudget(tempDir);
    expect(state.used).toBe(3);
    expect(state.log).toHaveLength(2);
    expect(state.log![0]).toMatchObject({ taskId: 'abc12345', taskCode: 'fix-thing', trigger: 'ci_failure' });
    expect(typeof state.log![0].ts).toBe('number');
    expect(state.log![1]).toMatchObject({ taskId: 'def67890', trigger: 'comment' });
  });
});

describe('auto-react config defaults', () => {
  test('DEFAULT_CONFIG has daemon section with budget defaults', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    expect(DEFAULT_CONFIG.daemon.auto_react_max_retries).toBe(3);
    expect(DEFAULT_CONFIG.daemon.auto_react_backoff).toBe('exponential');
    expect(DEFAULT_CONFIG.daemon.auto_react_daily_budget).toBe(50);
  });

  test('config can override daemon defaults via loadConfig', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lazy-config-test-'));

    try {
      // loadConfig needs a git root to find config — create minimal setup
      Bun.spawnSync(['git', 'init'], { cwd: tempDir });
      mkdirSync(join(tempDir, '.lazy'), { recursive: true });

      // Write a lazy.toml with custom daemon settings
      writeFileSync(join(tempDir, 'lazy.toml'), `
[daemon]
auto_react_max_retries = 5
auto_react_backoff = "linear"
auto_react_daily_budget = 100
`);

      const { loadConfig } = await import('../../src/config/loader');
      // Pass cwd: tempDir so findConfigDir starts searching from the temp dir,
      // not from the test process's cwd (which would find the repo's lazy.toml).
      const config = await loadConfig(tempDir, { cwd: tempDir });

      expect(config.daemon.auto_react_max_retries).toBe(5);
      expect(config.daemon.auto_react_backoff).toBe('linear');
      expect(config.daemon.auto_react_daily_budget).toBe(100);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// --- E2e tests that need the full lazy setup ---
// These tests exercise the CLI commands and require setupTestLazy().
// They may fail in environments without the lazy-agent module.

describe('auto-react budget (e2e)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // These tests exercise `start` / `unblock` and assert on `blocked`-list
    // and session-gated `show` output — all of which require a real daemon.
    // Daemonless, `start` leaves the task stuck in 'working' (no reconciler
    // moves it to 'blocked'), so `blocked` never lists it and `unblock`
    // refuses. Mirrors the accept-* withDaemon suites.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Start a task and wait for the reconciler to move it out of 'working' into
   * 'blocked' — the state that gives it a session (so `show` renders the
   * session-gated auto-react section) and lists it under `blocked`. The
   * explicit `wait` is mandatory because `start` launches the supervisor
   * asynchronously under the daemon.
   */
  async function startAndWait(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);

    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
  }

  /**
   * Resolve the tasks directory for the test project. Test projects init with
   * external storage (external_path in lazy.toml), so tasks live outside the
   * repo — reading ctx.root/.lazy/tasks finds nothing ("Task dir not found").
   * Fall back to the in-repo layout only when no external_path is configured.
   * Mirrors tasksDirFor() in auto-resume.test.ts / reconcile.test.ts.
   */
  function tasksDirFor(): string {
    const toml = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');
    const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
    if (m && m[1]) return join(m[1], 'tasks');
    return join(ctx.root, '.lazy', 'tasks');
  }

  /**
   * Read task.json directly from storage to inspect metadata.
   */
  function readTaskJson(taskShortId: string): Record<string, unknown> {
    const tasksDir = tasksDirFor();
    const entries = Bun.spawnSync(['ls', tasksDir], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
    const taskDir = entries.find(e => e.startsWith(taskShortId));
    if (!taskDir) throw new Error(`Task dir not found for ${taskShortId}`);
    return JSON.parse(readFileSync(join(tasksDir, taskDir, 'task.json'), 'utf-8'));
  }

  /**
   * Write task.json directly to storage (for test setup).
   */
  function writeTaskJson(taskShortId: string, data: Record<string, unknown>): void {
    const tasksDir = tasksDirFor();
    const entries = Bun.spawnSync(['ls', tasksDir], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
    const taskDir = entries.find(e => e.startsWith(taskShortId));
    if (!taskDir) throw new Error(`Task dir not found for ${taskShortId}`);
    writeFileSync(join(tasksDir, taskDir, 'task.json'), JSON.stringify(data, null, 2));
  }

  test('show displays auto-react paused status when metadata is set', async () => {
    // Start the task so it has a session — the auto-react section in `show`'s
    // text output only renders for tasks with a session (see show.ts).
    const taskId = await createTask(ctx, 'Test auto-react display', 'Some work');
    await startAndWait(taskId);

    // Set auto-react paused metadata directly on the task
    const taskJson = readTaskJson(taskId);
    taskJson.metadata = {
      ...(taskJson.metadata as Record<string, string> || {}),
      auto_react_paused: 'true',
      auto_react_paused_reason: 'Auto-react paused: 3 crash retries exhausted',
      auto_react_count_crash: '3',
    };
    writeTaskJson(taskId, taskJson);

    // Show should display auto-react status
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Auto-react paused');
    expectOutput(result, 'Crashes');
  });

  test('show JSON includes auto-react status', async () => {
    const taskId = await createTask(ctx, 'Test auto-react json');

    // Set auto-react metadata
    const taskJson = readTaskJson(taskId);
    taskJson.metadata = {
      ...(taskJson.metadata as Record<string, string> || {}),
      auto_react_paused: 'true',
      auto_react_paused_reason: 'Budget exhausted',
      auto_react_count_ci_failure: '2',
      auto_react_count_crash: '1',
    };
    writeTaskJson(taskId, taskJson);

    const result = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(result);
    const json = JSON.parse(result.stdout);
    expect(json.auto_react_status).toBeDefined();
    expect(json.auto_react_status.paused).toBe(true);
    expect(json.auto_react_status.counts.ci_failure).toBe(2);
    expect(json.auto_react_status.counts.crash).toBe(1);
  });

  test('show omits auto-react section when no counters are set', async () => {
    const taskId = await createTask(ctx, 'Test no auto-react data');

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    // Should NOT show auto-react section since there's no data
    expect(result.stdout).not.toContain('Auto-react');
  });

  test('blocked list shows AUTO-REACT PAUSED indicator', async () => {
    const taskId = await createTask(ctx, 'Test blocked auto-react indicator', 'Some work');

    // Start and let it complete to get a session and blocked status
    await startAndWait(taskId);

    // Set auto-react paused metadata
    const taskJson = readTaskJson(taskId);
    taskJson.metadata = {
      ...(taskJson.metadata as Record<string, string> || {}),
      auto_react_paused: 'true',
      auto_react_paused_reason: 'Auto-react paused: 3 CI failure retries exhausted',
    };
    writeTaskJson(taskId, taskJson);

    // Blocked list should show the indicator
    const result = await ctx.lazy(['blocked']);
    expectSuccess(result);
    expectOutput(result, 'AUTO-REACT PAUSED');
  });

  // INVARIANT: Manual unblock resets auto-react counters.
  // When a human manually provides feedback, the auto-react budget
  // resets because the human is taking over supervision.
  test('unblock resets auto-react counters', async () => {
    const taskId = await createTask(ctx, 'Test counter reset on unblock', 'Some work');

    // Start the task (into blocked, with a session) so unblock has something to
    // resume.
    await startAndWait(taskId);

    // Set auto-react counters
    const taskJson = readTaskJson(taskId);
    taskJson.metadata = {
      ...(taskJson.metadata as Record<string, string> || {}),
      auto_react_paused: 'true',
      auto_react_paused_reason: 'Auto-react paused: 3 crash retries exhausted',
      auto_react_count_crash: '3',
      auto_react_last_crash: String(Date.now()),
    };
    writeTaskJson(taskId, taskJson);

    // Unblock the task (non-interactive, pipe feedback)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'please try again'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept', LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    // Verify counters were reset
    const afterJson = readTaskJson(taskId);
    const meta = afterJson.metadata as Record<string, string>;
    expect(meta.auto_react_paused || '').toBe('');
    expect(meta.auto_react_paused_reason || '').toBe('');
    expect(meta.auto_react_count_crash || '').toBe('');
  });
});
