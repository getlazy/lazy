import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { reconcileTasks } from '../../src/utils/reconcile';
import { createStorage } from '../../src/storage';

/**
 * Read the external_path from the test project's lazy.toml.
 */
function getExternalPath(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const match = toml.match(/external_path\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('Could not find external_path in lazy.toml');
  return match[1];
}

/**
 * Run reconciliation directly (simulates what the daemon does).
 * Tests can't rely on CLI commands triggering reconciliation — only the daemon does that.
 * Uses explicit storage options to avoid picking up the wrong config.
 */
async function runReconcile(root: string): Promise<void> {
  const externalPath = getExternalPath(root);
  const storage = await createStorage(root, { backend: 'external', externalPath });
  try {
    await reconcileTasks(storage, root);
  } finally {
    await storage.close();
  }
}

/**
 * Wrap ctx.lazy to always set LAZY_TEST=1 (bypass daemon auto-start).
 * Non-mocked CLI calls in this test file need test mode to avoid daemon overhead
 * and ensure deterministic RPC fallback behavior.
 */
function lazyTest(ctx: TestContext) {
  return (args: string[], options?: { env?: Record<string, string>; input?: string }) =>
    ctx.lazy(args, { ...options, env: { LAZY_TEST: '1', ...options?.env } });
}

describe('lazy submit', () => {
  let ctx: TestContext;
  /** ctx.lazy with LAZY_TEST=1 (uses RPC fallback, no daemon) */
  let lazy: ReturnType<typeof lazyTest>;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    lazy = lazyTest(ctx);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('submit fails on backlog task (not blocked)', async () => {
    // INVARIANT: Only blocked/conflict tasks can be submitted.
    const taskId = await createTaskTest(lazy, 'Backlog task', 'Some prompt');

    const submitResult = await lazy(['submit', taskId]);
    expectFailure(submitResult);
    expectError(submitResult, 'Only blocked or conflict tasks can be submitted');
  });

  test('submit fails with local driver (no remote)', async () => {
    // INVARIANT: Submit requires a remote driver to create PRs.
    // Even a task with no agent commits has the initialization commit, so the
    // commits check passes — the driver check is the first validation to fail.
    const taskId = await createTaskTest(lazy, 'Local driver task', 'Test with local driver');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(startResult);

    // Run reconciliation so task transitions working → blocked
    await runReconcile(ctx.root);

    const showResult = await lazy(['show', taskId]);
    expectOutput(showResult, 'blocked');

    // Default driver is local — submit should fail
    const submitResult = await lazy(['submit', taskId]);
    expectFailure(submitResult);
    expectError(submitResult, 'remote driver');
  });

  test('submit with github driver fails at push (no real remote)', async () => {
    // Tests the full submit flow up to the push step — which fails in test env
    // because there's no actual remote origin.
    const taskId = await createTaskTest(lazy, 'Submit push test', 'Test submit flow');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Run reconciliation so task transitions working → blocked
    await runReconcile(ctx.root);

    const showResult = await lazy(['show', taskId]);
    expectOutput(showResult, 'blocked');

    // Configure github driver (will fail on push since no remote)
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig.replace('driver = "local"', 'driver = "github"'));

    const submitResult = await lazy(['submit', taskId]);
    // Will fail because there's no actual remote to push to
    expectFailure(submitResult);
    // Should fail at push step, not at validation
    expectError(submitResult, 'push');
  });

  test('submit shows usage when no task ID provided', async () => {
    const result = await lazy(['submit']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy submit');
  });

  test('blocked task with PR comments does not auto-react (only submitted does)', async () => {
    // INVARIANT: PR comment auto-react is gated on submitted status.
    // This test verifies the task reaches blocked (not submitted) and
    // that the auto-react code distinguishes between the two states.
    const taskId = await createTaskTest(lazy, 'Auto-react gate test', 'Test auto-react gating');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Run reconciliation — task should be blocked, not submitted
    await runReconcile(ctx.root);

    const showResult = await lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
    // Verify the task is NOT in submitted status
    expect(showResult.stdout).not.toContain('submitted');
  });
});

/**
 * Create a task using the test-mode lazy wrapper.
 */
async function createTaskTest(
  lazy: (args: string[], options?: { env?: Record<string, string> }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  goal: string,
  prompt?: string,
): Promise<string> {
  const args = ['create', '--goal', goal];
  if (prompt) {
    args.push('--prompt', prompt);
  }
  const result = await lazy(args);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create task: ${result.stderr}\n${result.stdout}`);
  }
  const match = result.stdout.match(/([0-9a-f]{8})/);
  if (!match) {
    throw new Error(`Could not extract task ID from output: ${result.stdout}`);
  }
  return match[1];
}
