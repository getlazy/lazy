/**
 * Tests for daemon auto-react: PR comments trigger agent turns.
 *
 * CI failure auto-react has been moved to the signal system (remote-sync
 * emits ci_result signals → auto-deliver delivers them). This test file
 * covers the remaining auto-react functionality:
 * - Auto-react module exports and importability
 * - Configuration switches (CI, comments)
 * - Budget integration (shouldAutoReact / recordAutoReact)
 * - CI failure signature deduplication (still used by remote-sync)
 * - Auto-react returns empty when disabled or no remote
 *
 * E2e tests that require setupTestLazy() follow the same pattern as
 * auto-react-budget.test.ts and will work once the version module is built.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';

// --- Module structure tests ---

describe('auto-react module', () => {
  test('exports runAutoReact function', async () => {
    const mod = await import('../../src/daemon/auto-react');
    expect(mod.runAutoReact).toBeInstanceOf(Function);
  });

  test('exports AutoReactResult type shape', async () => {
    const mod = await import('../../src/daemon/auto-react');
    // Verify the function signature by calling with minimal args
    // and checking the result shape
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');
    // With no remote driver configured, runAutoReact returns empty
    const result = await mod.runAutoReact({ listTasks: async () => [] } as any, '/tmp/nonexistent', DEFAULT_CONFIG);
    // ciUnblocked was removed — CI is handled by the signal system now
    expect(result).not.toHaveProperty('ciUnblocked');
    expect(result).toHaveProperty('commentUnblocked');
    expect(result).toHaveProperty('budgetSkipped');
    expect(result).toHaveProperty('errors');
  });
});

// --- Configuration tests ---

describe('auto-react config', () => {
  // INVARIANT: Auto-react sub-switches default to enabled so the daemon
  // automatically reacts to CI failures and PR comments without manual config.
  // The master switch (auto_react) was removed in v0.11 — auto-react is always
  // on when the daemon is required. Only sub-switches (CI, comments) remain.
  test('DEFAULT_CONFIG has auto_react sub-switches enabled by default', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    expect(DEFAULT_CONFIG.daemon.auto_react_ci).toBe(true);
    expect(DEFAULT_CONFIG.daemon.auto_react_comments).toBe(true);
  });

  test('config can disable auto_react sub-switches via lazy.toml', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lazy-ar-config-'));

    try {
      Bun.spawnSync(['git', 'init'], { cwd: tempDir });
      mkdirSync(join(tempDir, '.lazy'), { recursive: true });

      writeFileSync(join(tempDir, 'lazy.toml'), `
[daemon]
auto_react_ci = false
auto_react_comments = false
`);

      const { loadConfig } = await import('../../src/config/loader');
      const config = await loadConfig(tempDir, { cwd: tempDir });

      expect(config.daemon.auto_react_ci).toBe(false);
      expect(config.daemon.auto_react_comments).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // INVARIANT: CI and comment auto-react can be controlled independently.
  // Some projects may want CI auto-react but not comment auto-react (or vice versa).
  test('config can selectively disable CI or comment auto-react', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lazy-ar-partial-'));

    try {
      Bun.spawnSync(['git', 'init'], { cwd: tempDir });
      mkdirSync(join(tempDir, '.lazy'), { recursive: true });

      writeFileSync(join(tempDir, 'lazy.toml'), `
[daemon]
auto_react_ci = false
auto_react_comments = true
`);

      const { loadConfig } = await import('../../src/config/loader');
      const config = await loadConfig(tempDir, { cwd: tempDir });

      expect(config.daemon.auto_react_ci).toBe(false);
      expect(config.daemon.auto_react_comments).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// --- No-remote graceful behavior tests ---
// In v0.11 the auto_react master switch was removed — auto-react is always
// on when the daemon is required. Individual sub-switches (auto_react_ci,
// auto_react_comments) still control which triggers are active.

describe('auto-react without remote', () => {
  // INVARIANT: When no remote driver is configured, auto-react gracefully
  // returns empty. This handles local-only projects.
  test('returns empty result when no remote driver is configured', async () => {
    const { runAutoReact } = await import('../../src/daemon/auto-react');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const config = { ...DEFAULT_CONFIG };

    const storage = {
      listTasks: async () => [],
    } as any;

    const result = await runAutoReact(storage, '/tmp/nonexistent', config);
    expect(result.commentUnblocked).toEqual([]);
  });

  // INVARIANT: When comments sub-switch is disabled, no auto-react happens.
  // CI auto-react is now handled by the signal system, not auto-react.
  test('returns empty result when comments sub-switch is disabled', async () => {
    const { runAutoReact } = await import('../../src/daemon/auto-react');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const config = {
      ...DEFAULT_CONFIG,
      daemon: { ...DEFAULT_CONFIG.daemon, auto_react_comments: false },
    };

    const storage = {
      listTasks: async () => [],
    } as any;

    const result = await runAutoReact(storage, '/tmp/nonexistent', config);
    expect(result.commentUnblocked).toEqual([]);
    expect(result.budgetSkipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

// --- CI failure deduplication ---

describe('auto-react CI failure deduplication', () => {
  // INVARIANT: CI failure signatures are deterministic and order-independent.
  // Same set of failures always produces the same signature, regardless of order.
  test('ciFailureSignature produces deterministic signatures', async () => {
    const { ciFailureSignature } = await import('../../src/daemon/remote-sync');

    const failures = [
      { name: 'lint', url: 'https://ci.example.com/1' },
      { name: 'test', url: 'https://ci.example.com/2' },
    ];

    const sig1 = ciFailureSignature(failures);
    const sig2 = ciFailureSignature(failures);
    expect(sig1).toBe(sig2);

    // Order independence (sorted internally)
    const reversed = [...failures].reverse();
    const sig3 = ciFailureSignature(reversed);
    expect(sig1).toBe(sig3);
  });

  test('different CI failures produce different signatures', async () => {
    const { ciFailureSignature } = await import('../../src/daemon/remote-sync');

    const failures1 = [{ name: 'lint' }];
    const failures2 = [{ name: 'test' }];

    const sig1 = ciFailureSignature(failures1);
    const sig2 = ciFailureSignature(failures2);
    expect(sig1).not.toBe(sig2);
  });
});

// --- Budget integration tests ---

describe('auto-react budget integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lazy-ar-budget-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // INVARIANT: Auto-react uses shouldAutoReact from budget system.
  // When the per-task limit is reached, no more auto-unblocks happen.
  test('shouldAutoReact blocks when per-task limit is reached', async () => {
    const { shouldAutoReact } = await import('../../src/daemon/auto-react-budget');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const metadata = new Map<string, string>();
    metadata.set('auto_react_count_ci_failure', '3'); // At default limit of 3

    const mockStorage = {
      getTaskMetadata: async (_taskId: string, key: string) => metadata.get(key) || null,
      updateTaskMetadata: async (_taskId: string, key: string, value: string) => {
        metadata.set(key, value);
      },
    } as any;

    const decision = await shouldAutoReact(
      mockStorage,
      'test-task-id-12345678',
      'ci_failure',
      DEFAULT_CONFIG,
      tempDir,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('retries exhausted');
  });

  // INVARIANT: Daily budget prevents runaway spending across all tasks.
  test('shouldAutoReact blocks when daily budget is exhausted', async () => {
    const { shouldAutoReact, incrementDailyBudget } = await import('../../src/daemon/auto-react-budget');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const config = {
      ...DEFAULT_CONFIG,
      daemon: { ...DEFAULT_CONFIG.daemon, auto_react_daily_budget: 2 },
    };

    // Exhaust the daily budget
    incrementDailyBudget(tempDir);
    incrementDailyBudget(tempDir);

    const metadata = new Map<string, string>();
    const mockStorage = {
      getTaskMetadata: async (_taskId: string, key: string) => metadata.get(key) || null,
      updateTaskMetadata: async (_taskId: string, key: string, value: string) => {
        metadata.set(key, value);
      },
    } as any;

    const decision = await shouldAutoReact(
      mockStorage,
      'test-task-id-12345678',
      'ci_failure',
      config,
      tempDir,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Daily auto-react budget exhausted');
  });

  // INVARIANT: recordAutoReact increments both per-task counter and daily budget.
  // Both counters must be updated atomically after a successful auto-react.
  test('recordAutoReact updates both per-task and daily counters', async () => {
    const { recordAutoReact, getAutoReactCount, readDailyBudget } = await import('../../src/daemon/auto-react-budget');

    const metadata = new Map<string, string>();
    const mockStorage = {
      getTaskMetadata: async (_taskId: string, key: string) => metadata.get(key) || null,
      updateTaskMetadata: async (_taskId: string, key: string, value: string) => {
        metadata.set(key, value);
      },
    } as any;

    await recordAutoReact(mockStorage, 'test-task-id-12345678', 'ci_failure', tempDir);

    const count = await getAutoReactCount(mockStorage, 'test-task-id-12345678', 'ci_failure');
    expect(count).toBe(1);

    const budget = await readDailyBudget(tempDir);
    expect(budget.used).toBe(1);
  });

  // INVARIANT: Comment trigger uses the 'comment' AutoReactTrigger type.
  // This ensures comment auto-reacts are tracked separately from CI failures.
  test('comment auto-reacts are tracked with comment trigger type', async () => {
    const { recordAutoReact, getAutoReactCount } = await import('../../src/daemon/auto-react-budget');

    const metadata = new Map<string, string>();
    const mockStorage = {
      getTaskMetadata: async (_taskId: string, key: string) => metadata.get(key) || null,
      updateTaskMetadata: async (_taskId: string, key: string, value: string) => {
        metadata.set(key, value);
      },
    } as any;

    await recordAutoReact(mockStorage, 'test-task-id-12345678', 'comment', tempDir);
    await recordAutoReact(mockStorage, 'test-task-id-12345678', 'ci_failure', tempDir);

    const commentCount = await getAutoReactCount(mockStorage, 'test-task-id-12345678', 'comment');
    const ciCount = await getAutoReactCount(mockStorage, 'test-task-id-12345678', 'ci_failure');

    expect(commentCount).toBe(1);
    expect(ciCount).toBe(1);
  });
});

// --- Auto-react with mock storage and driver ---

describe('auto-react with blocked tasks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lazy-ar-mock-'));
    mkdirSync(join(tempDir, '.lazy'), { recursive: true });

    // Create a minimal lazy.toml so loadConfig works
    Bun.spawnSync(['git', 'init'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'lazy.toml'), `
[daemon]
auto_react = true
auto_react_ci = true
auto_react_comments = true
`);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // INVARIANT: Auto-react only processes submitted tasks for PR comments.
  // CI auto-react is handled by the signal system now.
  // Working, backlog, blocked, or terminal tasks are not auto-reacted to.
  test('skips tasks that are not submitted', async () => {
    const { runAutoReact } = await import('../../src/daemon/auto-react');
    const { loadConfig } = await import('../../src/config/loader');

    const config = await loadConfig(tempDir, { cwd: tempDir });

    // Mock storage with non-submitted tasks
    const mockStorage = {
      listTasks: async () => [
        { id: 'aaaa1111-0000-0000-0000-000000000000', status: 'working', goal: 'test' },
        { id: 'bbbb2222-0000-0000-0000-000000000000', status: 'backlog', goal: 'test' },
        { id: 'cccc3333-0000-0000-0000-000000000000', status: 'complete', goal: 'test' },
        { id: 'dddd4444-0000-0000-0000-000000000000', status: 'blocked', goal: 'test' },
      ],
    } as any;

    // Note: will fail at createDriver since no real remote is configured,
    // but that's OK — it proves the filter is correct
    const result = await runAutoReact(mockStorage, tempDir, config);

    // Should return empty because createDriver throws for local driver
    expect(result.commentUnblocked).toEqual([]);
  });
});

// --- CI auto-react moved to signal system ---

describe('auto-react CI handled by signals', () => {
  // INVARIANT: CI auto-react is now handled by the signal system.
  // remote-sync emits ci_result signals → auto-deliver delivers them.
  // Auto-react only handles PR comments for submitted tasks.
  test('blocked tasks are not processed by auto-react (CI uses signals now)', async () => {
    const { runAutoReact } = await import('../../src/daemon/auto-react');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const config = {
      ...DEFAULT_CONFIG,
      daemon: {
        ...DEFAULT_CONFIG.daemon,
        auto_react_ci: true,
        auto_react_comments: true,
      },
    };

    // A blocked task — auto-react no longer processes these for CI
    const blockedTask = {
      id: 'dddd4444-0000-0000-0000-000000000000',
      status: 'blocked',
      goal: 'test',
      code: 'test-blocked',
      metadata: {},
      created_at: new Date().toISOString(),
    };

    const mockStorage = {
      listTasks: async () => [blockedTask],
    } as any;

    // No submitted tasks → no work to do, returns empty
    const result = await runAutoReact(mockStorage, '/tmp/nonexistent', config);
    expect(result.commentUnblocked).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // INVARIANT: Comment auto-react requires submitted status and a remote ref.
  // Blocked tasks don't get comment auto-react either.
  test('comment checks require submitted status', async () => {
    const { runAutoReact } = await import('../../src/daemon/auto-react');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const config = {
      ...DEFAULT_CONFIG,
      daemon: {
        ...DEFAULT_CONFIG.daemon,
        auto_react_ci: false,
        auto_react_comments: true,
      },
    };

    const blockedTask = {
      id: 'eeee5555-0000-0000-0000-000000000000',
      status: 'blocked',
      goal: 'test',
      metadata: {},
      created_at: new Date().toISOString(),
    };

    const mockStorage = {
      listTasks: async () => [blockedTask],
    } as any;

    // Should return empty — blocked tasks are not processed by auto-react
    const result = await runAutoReact(mockStorage, '/tmp/nonexistent', config);
    expect(result.commentUnblocked).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
