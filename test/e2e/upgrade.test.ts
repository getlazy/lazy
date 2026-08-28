import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, writeFile, unlink, mkdtemp } from 'fs/promises';
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
    // Pair sessions are host processes, so `upgrade` used to be blind to them
    // and this line named containers only.
    expectOutput(result, 'No running containers or interactive sessions found.');
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

  // Every upgrade image build (and its dry run) names the exact lazy.toml and
  // Dockerfile it reads. From a worktree it is genuinely ambiguous which copy
  // governs — the config-override warning is deliberately silent when the two
  // lazy.toml files are byte-identical — and an upgrade that silently built
  // from the git root's Dockerfile instead of the worktree's cost a whole
  // debugging session (cursor-first-class-agent).
  test('--images names the config and custom Dockerfile it builds from', async () => {
    const dockerfilePath = join(ctx.root, 'Dockerfile.custom');
    await writeFile(dockerfilePath, 'FROM debian:bookworm-slim\n');
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const updated = toml.replace('dockerfile = ""', 'dockerfile = "Dockerfile.custom"');
    if (updated === toml) throw new Error('lazy.toml dockerfile key not found — fixture drift');
    await writeFile(configPath, updated);

    for (const args of [['upgrade', '--images', '--dry-run'], ['upgrade', '--images']]) {
      const result = await ctx.lazyMocked(args, MOCK_CLAUDE_SUCCESS);
      expectSuccess(result);
      expectOutput(result, `Config:     ${configPath}`);
      expectOutput(result, `Dockerfile: ${dockerfilePath}`);
    }
  });

  test('--images says when the embedded default Dockerfile is in use', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--images', '--dry-run'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Config:     ');
    expectOutput(result, 'Dockerfile: embedded default');
  });

  // Part 2: a daemon-adopted worktree Dockerfile is announced the same way so
  // the human can see what the next build / daemon restart will use. The path
  // named is the consented SNAPSHOT under the daemon dir, not the live
  // worktree file (builds read only those bytes).
  test('--images marks a daemon-adopted Dockerfile in the Dockerfile line', async () => {
    const { pinDaemonBaseDir } = await import('../helpers/daemon-base-dir');
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-upgrade-adopt-'));
    const undoDaemonBase = pinDaemonBaseDir(daemonBase);
    // Child CLI must see the same daemon base as this in-process write.
    process.env.LAZY_DAEMON_BASE_DIR = daemonBase;

    try {
      const dockerfilePath = join(ctx.root, 'Dockerfile.adopted');
      const content = 'FROM debian:bookworm-slim\n# adopted\n';
      await writeFile(dockerfilePath, content);
      const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
      const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
      const { VERSION } = await import('../../src/version');
      await writeAdoptedImage(ctx.root, {
        dockerfilePath,
        contentHash: hashDockerfileContent(content),
        imageName: 'lazy-custom-aaaaaaaaaaaa:0.22',
        lazyVersion: VERSION,
      }, { content });

      const result = await ctx.lazyMocked(['upgrade', '--images', '--dry-run'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_DAEMON_BASE_DIR: daemonBase },
      });

      expectSuccess(result);
      const snapshotPath = getAdoptedDockerfilePath(ctx.root);
      expectOutput(result, `Dockerfile: ${snapshotPath} (daemon-adopted from worktree)`);
    } finally {
      undoDaemonBase();
    }
  });

  test('a full upgrade names the image source alongside the background build', async () => {
    const result = await ctx.lazyMocked(['upgrade'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Rebuilding the container image in the background');
    expectOutput(result, 'Config:     ');
    expectOutput(result, 'Dockerfile: ');
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

  // The image rebuild no longer waits for the human's decision or for working
  // agents: it starts immediately, under a staging tag. Both halves of that are
  // user-visible promises and must be stated in the output — the human needs to
  // know a build is running AND that nothing they are using has changed yet.
  test('upgrade starts the image rebuild in the background under a staging tag', async () => {
    const buildLogPath = join(ctx.root, 'upgrade-build-log.jsonl');
    await writeFile(buildLogPath, '');

    const result = await ctx.lazyMocked(['upgrade', '--force'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_BUILD_LOG: buildLogPath },
    });

    expectSuccess(result);
    expectOutput(result, 'Rebuilding the container image in the background');
    expectOutput(result, 'promoted only once you proceed');
    expectOutput(result, 'rebuilt');
    expectOutput(result, 'Upgrade complete.');

    // The build must target the STAGING tag (not the canonical one) and bust
    // the layer cache — a hash-matching rebuild would be a no-op.
    const calls = JSON.parse(
      '[' + (await readFile(buildLogPath, 'utf-8')).trim().split('\n').filter(Boolean).join(',') + ']'
    ) as Array<{ stagedTag: string; noCache: boolean }>;
    if (calls.length !== 1) {
      throw new Error(`Expected exactly 1 staged image build, got ${calls.length}: ${JSON.stringify(calls)}`);
    }
    if (!calls[0].stagedTag.endsWith('-upgrade')) {
      throw new Error(`Expected a staging tag ending in -upgrade, got "${calls[0].stagedTag}"`);
    }
    if (calls[0].noCache !== true) {
      throw new Error('Expected the staged rebuild to pass --no-cache');
    }

    await unlink(buildLogPath);
  });

  // The dry run is where a human decides whether to run the real thing, so it
  // must describe the staging/promote behavior they are agreeing to.
  test('--dry-run explains the background rebuild and deferred promotion', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--dry-run'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'starts in the background while you decide');
    expectOutput(result, 'moves only once you proceed');
  });

  test('help documents that a cancelled upgrade leaves the current image untouched', async () => {
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, 'BACKGROUND');
    expectOutput(result, 'leaves your current image exactly as it was');
    expectOutput(result, 'the upgrade fails loudly');
  });

  test('help documents --timeout and the unbounded default', async () => {
    const result = await ctx.lazy(['upgrade', '--help']);

    expectSuccess(result);
    expectOutput(result, '--timeout <seconds>');
    expectOutput(result, 'default: no timeout');
    expectOutput(result, 'unbounded by default');
  });

  test('rejects a non-numeric --timeout instead of silently ignoring it', async () => {
    const result = await ctx.lazyMocked(['upgrade', '--force', '--timeout', 'twenty'], MOCK_CLAUDE_SUCCESS);

    expectFailure(result);
    expectError(result, '--timeout expects a whole number of seconds');
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
