/**
 * E2E coverage for `lazy sync <task>` resolving and merging the LIVE remote
 * upstream — guarding the fix-sync-stale-upstream regression.
 *
 * Background: a `git fetch` change made sync resolve the merge target from a
 * STALE local `origin/<parent>` tracking ref (or the bare local branch) instead
 * of fetching the live remote first. The symptom was `lazy sync` reporting
 * "Already up to date" even when the real remote parent had moved on and the MR
 * showed conflicts — accepts then failed with "MR has merge conflicts" that no
 * local sync could resolve. The fix makes the remote drivers' resolveUpstreamRef
 * fetch the remote before returning `<remote>/<parent>`, and surfaces (rather
 * than swallows) a fetch failure.
 *
 * The existing unit tests (test/unit/resolve-upstream-ref.test.ts) cover the
 * driver in isolation. These tests exercise the actual end-to-end `lazy sync`
 * flow against a REAL git remote (a bare repo + a second clone that advances the
 * remote parent out of band), proving sync delivers the live remote upstream and
 * a fetch failure fails hard instead of degrading to a stale/local-ref merge.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Run a git command in an arbitrary directory (for remotes/clones outside ctx.root). */
function gitIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe('lazy sync <task> — live remote upstream', () => {
  let ctx: TestContext;
  // Temp dirs created per-test for the bare remote and the out-of-band clone.
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    // `start`/`sync` route through the daemon for storage and supervisor launch
    // since the v0.11 daemon refactor — these tests need a real daemon.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  /**
   * Wire ctx.root up to a fresh bare git remote named `origin`, push `main`, and
   * select the github driver (its resolveUpstreamRef does a plain `git fetch
   * origin <parent>` — no gh CLI needed). Returns the bare remote path.
   */
  async function setupGithubRemote(): Promise<string> {
    const bareRemote = await mkdtemp(join(tmpdir(), 'lazy-e2e-origin-'));
    tmpDirs.push(bareRemote);
    gitIn(bareRemote, 'init', '--bare', '--initial-branch=main');

    // Commit the github-driver config BEFORE pushing/branching: the task worktree
    // is checked out from origin/main, so config must be in the committed tree
    // for syncTask's `loadConfig(projectRoot, { cwd: worktreePath })` to see it.
    await writeFile(join(ctx.root, 'lazy.toml'), '[remote]\ndriver = "github"\n');
    expect(ctx.git('add', 'lazy.toml').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'Use github driver').exitCode).toBe(0);

    expect(ctx.git('remote', 'add', 'origin', bareRemote).exitCode).toBe(0);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
    return bareRemote;
  }

  /**
   * Advance the remote `main` OUT OF BAND via a second clone, so ctx.root's local
   * `main` AND its local `origin/main` tracking ref are both left STALE. This is
   * exactly the regression's ground truth: only a live fetch can see the new
   * upstream commit; a stale/local-ref merge silently reports "up to date".
   * Returns the SHA of the new upstream commit.
   */
  async function advanceRemoteMainOutOfBand(bareRemote: string): Promise<string> {
    const clone = await mkdtemp(join(tmpdir(), 'lazy-e2e-clone-'));
    tmpDirs.push(clone);
    expect(gitIn(clone, 'clone', bareRemote, '.').exitCode).toBe(0);
    gitIn(clone, 'config', 'user.email', 'upstream@lazy.test');
    gitIn(clone, 'config', 'user.name', 'Upstream Dev');
    await writeFile(join(clone, 'upstream-only.txt'), 'landed on the remote parent\n');
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-m', 'Upstream commit that only exists on the remote');
    expect(gitIn(clone, 'push', 'origin', 'main').exitCode).toBe(0);
    return gitIn(clone, 'rev-parse', 'HEAD').stdout.trim();
  }

  /** Start a task and wait for the daemon to settle it out of 'working'. */
  async function startAndSettle(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    const waitResult = await ctx.lazy(['wait', taskId]);
    expect(waitResult.exitCode).toBe(0);
  }

  // INVARIANT: sync delivers the LIVE remote upstream. The task branched from
  // origin/main, then origin/main advanced out of band (a second clone pushed a
  // commit). ctx.root's local main and local origin/main tracking ref are both
  // stale, so the ONLY way to see the new commit is to fetch the live remote —
  // which is exactly what resolveUpstreamRef must do. A stale/local-ref merge
  // would silently report "Already up to date" and drop the upstream change.
  test('sync fetches the live remote parent and does NOT report "up to date" when it has moved', async () => {
    const bareRemote = await setupGithubRemote();

    const taskId = await createTask(ctx, 'Live upstream sync', 'Do work');
    await startAndSettle(taskId);

    // Capture the local tracking ref BEFORE advancing — proves it is stale
    // relative to the remote after the out-of-band push.
    const staleLocalOriginMain = ctx.git('rev-parse', 'origin/main').stdout.trim();
    const liveUpstreamSha = await advanceRemoteMainOutOfBand(bareRemote);
    expect(liveUpstreamSha).not.toBe(staleLocalOriginMain);

    // Local origin/main is still stale at this point (nothing in ctx.root fetched).
    expect(ctx.git('rev-parse', 'origin/main').stdout.trim()).toBe(staleLocalOriginMain);

    const result = await ctx.lazy(['sync', taskId]);
    const output = result.stdout + result.stderr;

    // The load-bearing assertion: sync must NOT short-circuit to "up to date".
    // A stale/local-ref merge (the regression) would, because the local refs
    // never saw the new commit.
    expect(output.includes('up to date')).toBe(false);

    // And the live fetch must have actually updated ctx.root's origin/main to the
    // real remote SHA — confirming sync resolved the LIVE remote, not a stale ref.
    expect(ctx.git('rev-parse', 'origin/main').stdout.trim()).toBe(liveUpstreamSha);
  }, 30_000);

  // INVARIANT: a fetch failure surfaces — sync must NOT silently fall back to a
  // stale/local-ref merge and report success/"up to date". Per CLAUDE.md "fail
  // hard on remote failures — no silent fallbacks", syncTask marks the task for
  // retry (pending_sync) and exits non-zero when the upstream fetch fails.
  test('sync fails hard when the upstream fetch fails (no silent stale-ref merge)', async () => {
    const bareRemote = await setupGithubRemote();

    const taskId = await createTask(ctx, 'Fetch failure surfaces', 'Do work');
    await startAndSettle(taskId);

    // Break the remote AFTER the task is established: point origin at a path that
    // does not exist so `git fetch origin main` fails for real.
    await rm(bareRemote, { recursive: true, force: true });

    const result = await ctx.lazy(['sync', taskId]);
    const output = result.stdout + result.stderr;

    // Must fail loudly, not pretend success.
    expectFailure(result);
    // Must NOT claim the branch is current — that would be the silent-stale-merge
    // bug this guards against.
    expect(output.includes('up to date')).toBe(false);
    // Should name the fetch failure / retry intent so the human knows what broke.
    expect(/fetch failed|marked for retry|retry/i.test(output)).toBe(true);
  }, 30_000);
});
