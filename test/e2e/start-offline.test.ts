/**
 * E2E tests for `lazy start` offline handling and the --force-local escape hatch.
 *
 * These run WITHOUT a daemon so `lazy start` executes launchTask() in-process
 * (queryStartTask → handleStartTask fallback under LAZY_TEST). A daemon is
 * deliberately avoided here: the daemon resolves the configured driver and
 * offline state once at request time from a long-lived process, which makes the
 * toggling these tests exercise (offline ↔ online, driver = github) racy. The
 * behavior under test lives entirely in launchTask, which the in-process path
 * runs faithfully.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy start (offline / force-local)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Set up a project with a real remote driver (github) whose parent branch
   * exists ONLY locally: the parent task is started while offline, so its lazy/
   * branch is created but never pushed (LocalDriver.publishBranch is a no-op).
   * Only `main` is on the remote. Returns the child task's short ID and leaves
   * lazy in offline mode.
   *
   * A real driver is required — LocalDriver never fetches, so it would mask the
   * bug this exercises (start attempting a remote fetch it cannot satisfy).
   */
  async function childWithLocalOnlyParent(): Promise<string> {
    // Edit the key init wrote, never overwrite the file: a stub would drop the
    // store's external_path and the commands below would see another store.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = readFileSync(tomlPath, 'utf-8');
    const withGithub = toml.replace(/^driver = "local"$/m, 'driver = "github"');
    if (withGithub === toml) throw new Error('lazy.toml has no driver = "local" to switch');
    writeFileSync(tomlPath, withGithub);
    const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
    ctx.git('remote', 'add', 'origin', bareRepo);
    ctx.git('push', 'origin', 'main');
    ctx.git('remote', 'set-head', 'origin', 'main');

    // Start the parent while offline so its branch is never pushed to origin.
    await ctx.lazy(['system', 'offline']);
    const parentId = await createTask(ctx, 'Parent hub', 'Parent work');
    await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const cr = await ctx.lazy(['create', '--goal', 'Child', '--prompt', 'Child work', '--parent', parentId]);
    return extractTaskId(cr.stdout);
  }

  // INVARIANT: `start` must honor offline mode. When offline, the parent ref is
  // resolved from the LOCAL branch with no remote fetch, mirroring sync/reparent.
  // A parent branch that only exists locally (created while offline, never
  // pushed) must NOT make start fail on a remote it is not allowed to reach.
  test('offline: child with local-only parent branch starts from local HEAD', async () => {
    const childId = await childWithLocalOnlyParent(); // stays offline

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    // Warning mirrors sync's offline warning: local-only, no remote fetch.
    expectOutput(result, 'offline mode');
    expectOutput(result, 'local parent branch');
  });

  // INVARIANT: Online, a parent TASK branch that is not on origin yet is
  // ordinary (since 2026-10-14): a parent's agent commits can never be pushed by
  // it, and accept merges into the parent locally anyway, so start branches from
  // the local parent branch and SAYS so. Not a silent fallback: the warning
  // names the branch and the remote.
  test('online: a parent task branch not on origin yet starts from the local branch, with a warning', async () => {
    const childId = await childWithLocalOnlyParent();
    await ctx.lazy(['system', 'online']);

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'does not exist on origin yet; used the local branch');
  }, 20000);

  // INVARIANT: Online, a missing NAMED parent branch (not a lazy task branch)
  // still fails hard with an actionable error pointing at --force-local (AGENTS.md
  // "fail hard on remote failures — no silent fallbacks"): start must not quietly
  // branch from a local ref nobody pushed.
  test('online: a missing named parent branch fails actionably without --force-local', async () => {
    await childWithLocalOnlyParent(); // github driver + origin with only main
    ctx.git('branch', 'release-x', 'main'); // local only, never pushed
    await ctx.lazy(['system', 'online']);
    const created = await ctx.lazy(['create', '--goal', 'On release-x', '--prompt', 'Work', '--parent', 'release-x']);
    expectSuccess(created);

    const result = await ctx.lazyMocked(['start', extractTaskId(created.stdout), '--yes'], MOCK_CLAUDE_SUCCESS);

    expectFailure(result);
    expectError(result, '--force-local');
  }, 20000); // remote fetch retries with 2s + 4s backoff before failing

  // INVARIANT: --force-local is the online escape hatch — when the remote parent
  // ref genuinely cannot be fetched, start falls back to the parent's local HEAD
  // instead of aborting. Exposed on the CLI (--force-local) and the MCP
  // lazy_start tool (force_local).
  // Exercised on a NAMED parent branch, the case where start without the flag
  // still fails — on a task branch it would succeed anyway and prove nothing.
  test('online: --force-local starts from local HEAD when remote parent ref is missing', async () => {
    await childWithLocalOnlyParent(); // github driver + origin with only main
    ctx.git('branch', 'release-x', 'main'); // local only, never pushed
    await ctx.lazy(['system', 'online']);
    const created = await ctx.lazy(['create', '--goal', 'On release-x', '--prompt', 'Work', '--parent', 'release-x']);
    expectSuccess(created);
    const childId = extractTaskId(created.stdout);

    expectFailure(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const result = await ctx.lazyMocked(['start', childId, '--yes', '--force-local'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
  }, 40000); // fetch is attempted (retries) on both starts
});
