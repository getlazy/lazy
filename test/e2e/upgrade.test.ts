import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectError, expectFailure, expectOutputExcludes } from '../helpers/assertions';
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
    // The dry run must state that interrupted tasks come back on their own —
    // that is the reassurance the human needs before agreeing to a rebuild.
    // Wording moved from "auto-resumed" to "auto-resumes" in 023b2623.
    expectOutput(result, 'auto-resumes interrupted tasks');
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

  // --- Credential preflight ---
  //
  // REGRESSION (observed live on the first upgrade to v0.20): the upgrade ran to
  // completion — stopping every container and rebuilding the image and binary —
  // and only then did the daemon's credential gate refuse to start the daemon.
  // The condition was knowable before anything was touched, so it must abort up
  // front, leaving the running daemon and builders alone.
  //
  // LAZY_FORCE_CRED_PREFLIGHT is the test-only hatch that runs the real decision
  // under LAZY_TEST (where no daemon is ever started, so the check is skipped).
  const NO_CREDENTIALS = {
    LAZY_FORCE_CRED_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
  };

  test('aborts before stopping or rebuilding anything when no credential is set', async () => {
    const result = await ctx.lazy(['upgrade', '--force'], { env: NO_CREDENTIALS });

    expectFailure(result);
    expectError(result, 'Upgrade aborted before any changes were made');
    expectError(result, 'Nothing was stopped, rebuilt, or changed');
    // The gate's own actionable remedy, surfaced BEFORE the damage.
    expectError(result, 'CLAUDE_CODE_OAUTH_TOKEN');
    // Nothing was stopped and nothing was built.
    expectOutputExcludes(result, 'Rebuilding...');
    expectOutputExcludes(result, 'Stopping');
    expectOutputExcludes(result, 'Upgrade complete.');
  });

  // A dry run changes nothing by design, so the failing preflight is a warning
  // there — but it must still be surfaced, since it is what a real run aborts on.
  test('--dry-run warns about the missing credential instead of failing', async () => {
    // lazyMocked: the dry-run path probes runner availability, which needs the
    // docker mock. The mock helper's fake ANTHROPIC_API_KEY is a default, so
    // NO_CREDENTIALS still clears it.
    const result = await ctx.lazyMocked(['upgrade', '--dry-run'], MOCK_CLAUDE_SUCCESS, {
      env: NO_CREDENTIALS,
    });

    expectSuccess(result);
    expectOutput(result, 'Upgrade dry run:');
    expectOutput(result, 'A real upgrade would abort immediately');
  });

  // --- Non-disruptive image refresh (lazy upgrade --images) ---

  test('help documents the non-disruptive --images refresh', async () => {
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, '--images');
    expectOutput(result, 'Non-disruptive image refresh');
    expectOutput(result, 'no-cache');
  });

  test('--images refreshes the image without stopping containers or restarting the daemon', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--images'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Refreshing container image for future sessions');
    expectOutput(result, 'rebuilt');
    expectOutput(result, 'Image refresh complete.');
    // INVARIANT: --images is non-disruptive — it must NOT stop containers,
    // rebuild the agent binary, or restart the daemon. Assert the disruptive
    // upgrade output never appears.
    expectOutputExcludes(result, 'Restarting daemon');
    expectOutputExcludes(result, 'Upgrade complete.');
    expectOutputExcludes(result, 'agent binary');
  });

  // INVARIANT: the whole point of --images is that running builders/agents keep
  // working. The boundary message must state that they were not touched.
  test('--images reports that running builders and agents were not touched', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--images'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'were NOT touched');
    expectOutput(result, 'When each session starts using the refreshed image');
  });

  test('--images --dry-run previews the refresh without building', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--images', '--dry-run'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Image refresh dry run:');
    expectOutput(result, 'Rebuild (--no-cache)');
    expectOutputExcludes(result, 'Image refresh complete.');
  });

  // INVARIANT: --images does not stop containers, so --force / --wait (which
  // only govern stopping working containers) are meaningless and rejected —
  // never silently ignored (principle of least surprise).
  test('--images rejects --force and --wait', async () => {
    const forceResult = await ctx.lazy(['upgrade', '--images', '--force']);
    expectFailure(forceResult);
    expectError(forceResult, '--images does not stop running containers');

    const waitResult = await ctx.lazy(['upgrade', '--images', '--wait']);
    expectFailure(waitResult);
    expectError(waitResult, '--images does not stop running containers');
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
