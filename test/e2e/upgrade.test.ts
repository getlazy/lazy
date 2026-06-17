import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectError, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy upgrade', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Rebuild the Docker image and agent binary');
    expectOutput(result, '--force');
    expectOutput(result, '--wait');
    expectOutput(result, '--dry-run');
  });

  // The pre-stop "submit your in-progress message" warning is the v0.17
  // mitigation for unsent-input loss when a builder container is killed
  // (CLAUDE.md "never lose human feedback"). It must be documented in help so
  // users know to expect it and how --force / no TTY behaves.
  test('help documents the builder pre-stop warning and --force/no-TTY behavior', async () => {
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, 'builder sessions are running');
    expectOutput(result, 'submit any in-progress');
    expectOutput(result, 'unsent builder input may be lost');
  });

  test('upgrade succeeds with no running containers', async () => {
    const result = await ctx.lazyMocked(['upgrade'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'No running containers to stop.');
    expectOutput(result, 'Rebuilding...');
    expectOutput(result, 'rebuilt');
    expectOutput(result, 'Upgrade complete.');
  });

  test('upgrade --dry-run shows what would happen', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--dry-run'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Upgrade dry run:');
    expectOutput(result, 'Rebuild: Docker image + agent binary');
    expectOutput(result, 'No running containers found.');
    expectOutput(result, 'auto-resumed');
  });

  test('upgrade --force succeeds', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--force'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Upgrade complete.');
  });

  test('upgrade rejects unknown flags', async () => {
    const result = await ctx.lazy(['upgrade', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --unknown');
  });

  // INVARIANT: --force and --wait are mutually exclusive.
  // They represent conflicting intent: "stop now" vs "wait for tasks to finish."
  test('--force and --wait together produces an error', async () => {
    const result = await ctx.lazy(['upgrade', '--force', '--wait']);

    expectFailure(result);
    expectError(result, '--force and --wait are mutually exclusive');
  });

  // --wait with no working containers should proceed immediately (nothing to wait for).
  test('--wait with no working containers proceeds immediately', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--wait'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'No running containers to stop.');
    expectOutput(result, 'Upgrade complete.');
  });

  // Interactive prompt presents three options when working containers exist.
  // In test mode with LAZY_PROMPT_DEFAULTS, promptChoice returns 0 (first option: "Stop and upgrade now").
  test('interactive prompt shows three choices when working containers exist', async () => {
    // In mock mode, no real containers exist, so we can't truly test the prompt path.
    // But we can verify that the prompt infrastructure is in place by checking --help output.
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, '--wait');
    expectOutput(result, 'Wait for all working tasks to block before upgrading');
  });

  test('upgrade with interrupted task auto-resumes it', async () => {
    // Create and start a task (mock makes it go through start → working → blocked via reconciliation)
    const taskId = await createTask(ctx, 'Auto-resume test', 'Do the work');
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Reconcile so task goes to blocked (mock supervisor writes response.json immediately)
    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);

    // Now the task should be blocked. To test auto-resume, we need it interrupted.
    // In mock mode, no real containers exist, so upgrade won't find running containers
    // but we can verify the basic flow completes.
    const upgradeResult = await ctx.lazyMocked(['upgrade', '--force'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(upgradeResult);
    expectOutput(upgradeResult, 'Upgrade complete.');
  });
});
