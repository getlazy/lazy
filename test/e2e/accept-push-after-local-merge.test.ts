import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Regression tests for task `fix-push-after-local-merge`.
 *
 * The bug: when `lazy accept` merges a task into an UNPROTECTED parent branch
 * (which includes `main` when the remote has no branch-protection rules), the
 * merge is a LOCAL squash merge — but the merged parent branch was NEVER pushed
 * to origin. So local `<parent>` drifted permanently ahead of `origin/<parent>`
 * (the engineer's #1 bug), AND a direct consequence: `lazy sync` resolves
 * upstream to a stale `origin/<parent>` and falsely reports "Already up to date".
 *
 * The fix: after a successful local merge into a remote-backed unprotected
 * parent, push the parent branch to origin (a plain branch push, never a PR/MR).
 */
describe('lazy accept: push parent after local merge', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` + `accept` require a real daemon (post-v0.11: CLI goes through the
    // daemon for storage — see accept-auto-sync.test.ts for rationale).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Switch the test repo to the GitHub driver backed by a LOCAL bare remote so
   * `git push` succeeds. The bare-remote URL is a plain file path, so the GitHub
   * driver cannot parse a repo identifier and treats `main` as UNPROTECTED —
   * exactly the real-world case the bug fired in (no branch-protection rules).
   */
  function switchToGitHubDriver(): string {
    const tomlPath = join(ctx.root, 'lazy.toml');
    let toml = readFileSync(tomlPath, 'utf-8');
    toml = toml.replace('driver = "local"', 'driver = "github"');
    writeFileSync(tomlPath, toml);

    const bareRemotePath = join(ctx.root, '.test-remote.git');
    const initBare = ctx.git('init', '--bare', bareRemotePath);
    expect(initBare.exitCode).toBe(0);

    const checkRemote = ctx.git('remote', 'get-url', 'origin');
    if (checkRemote.exitCode === 0) {
      expect(ctx.git('remote', 'set-url', 'origin', bareRemotePath).exitCode).toBe(0);
    } else {
      expect(ctx.git('remote', 'add', 'origin', bareRemotePath).exitCode).toBe(0);
    }

    const pushMain = ctx.git('push', '-u', 'origin', 'main');
    if (pushMain.exitCode !== 0) {
      throw new Error(`Push to origin failed: ${pushMain.stderr}`);
    }
    return bareRemotePath;
  }

  function bareSha(bareRemotePath: string, ref: string): string {
    const r = ctx.git('--git-dir', bareRemotePath, 'rev-parse', ref);
    expect(r.exitCode).toBe(0);
    return r.stdout.trim();
  }

  // INVARIANT: a local squash merge into a remote-backed unprotected parent MUST
  // push the merged parent branch to origin. Without the push, local `main` is
  // permanently ahead of `origin/main` (the "local-always-ahead" bug). This is a
  // plain branch push — NO PR/MR is opened (that would regress fix-mr-targets-main).
  test('accept local-merges into unprotected main AND pushes main to origin (no divergence)', async () => {
    const taskId = await createTask(ctx, 'Push-after-merge test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Add a real commit in the worktree so the squash merge produces a commit.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'some content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'new-file.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add new file').exitCode).toBe(0);

    const bareRemotePath = switchToGitHubDriver();
    const originMainBefore = bareSha(bareRemotePath, 'main');

    // Accept: unprotected `main` → LOCAL squash merge, then push to origin.
    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectSuccess(acceptResult);
    // No PR/MR was opened — a local merge has no remote URL to report.
    expect(acceptResult.stdout).not.toContain('No remote reference found');
    expect(acceptResult.stderr).not.toContain('PR creation failed');

    const localMainAfter = ctx.git('rev-parse', 'main').stdout.trim();
    const originMainAfter = bareSha(bareRemotePath, 'main');

    // The merge produced a new commit on local main...
    expect(localMainAfter).not.toBe(originMainBefore);
    // ...and origin/main now points at the SAME commit — no divergence. Before
    // the fix, origin/main would still be at originMainBefore (stale).
    expect(originMainAfter).toBe(localMainAfter);
  });

  // INVARIANT: because the parent push keeps origin fresh, `lazy sync` reads a
  // live upstream and no longer falsely reports "Already up to date". This is the
  // exact downstream regression the engineer hit. We assert the root cause is
  // gone: after accept, the local remote-tracking ref `origin/main` is in lockstep
  // with the bare remote (no stale tracking ref feeding hasUpstreamChanges).
  test('after accept, origin/main is not stale (sync sees a live upstream)', async () => {
    const taskId = await createTask(ctx, 'Honest-sync test', 'Add a file');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    const bareRemotePath = switchToGitHubDriver();

    expectSuccess(await ctx.lazy(['accept', taskId]));

    // Fetch so the local remote-tracking ref reflects what was actually pushed.
    expect(ctx.git('fetch', 'origin').exitCode).toBe(0);
    const trackingMain = ctx.git('rev-parse', 'refs/remotes/origin/main').stdout.trim();
    const bareMain = bareSha(bareRemotePath, 'main');
    const localMain = ctx.git('rev-parse', 'main').stdout.trim();

    // origin/main (tracking), the bare remote, and local main all agree.
    // hasUpstreamChanges (`git rev-list --count HEAD..origin/<parent>`) therefore
    // reads a fresh upstream — no false "Already up to date" from a stale ref.
    expect(bareMain).toBe(localMain);
    expect(trackingMain).toBe(localMain);
  });
});
