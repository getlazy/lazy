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
import { mkdtempSync, writeFileSync } from 'fs';
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
    writeFileSync(join(ctx.root, 'lazy.toml'), '[remote]\ndriver = "github"\n');
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

  // INVARIANT: Online, a genuinely-missing remote parent ref must fail hard with
  // an actionable error (per CLAUDE.md "fail hard on remote failures — no silent
  // fallbacks"), pointing the user at --force-local. Start must NOT silently
  // branch from a stale local ref just because the fetch failed.
  test('online: missing remote parent ref fails actionably without --force-local', async () => {
    const childId = await childWithLocalOnlyParent();
    await ctx.lazy(['system', 'online']); // fetch will be attempted and fail

    const result = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectFailure(result);
    expectError(result, '--force-local');
  }, 20000); // remote fetch retries with 2s + 4s backoff before failing

  // INVARIANT: --force-local is the online escape hatch — when the remote parent
  // ref genuinely cannot be fetched, start falls back to the parent's local HEAD
  // instead of aborting. Exposed on the CLI (--force-local) and the MCP
  // lazy_start tool (force_local).
  test('online: --force-local starts from local HEAD when remote parent ref is missing', async () => {
    const childId = await childWithLocalOnlyParent();
    await ctx.lazy(['system', 'online']);

    const result = await ctx.lazyMocked(['start', childId, '--yes', '--force-local'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
  }, 20000); // fetch is still attempted (retries) before falling back to local HEAD
});
