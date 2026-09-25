import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';

/**
 * Regression tests for task `fix-branch-prefix-and-auto-push-config`.
 *
 * The bug (reported against a released build): `[remote] github_auto_push` was
 * documented, defaulted and schema-validated, but NO code read it. The daemon
 * pushed every task branch after every turn regardless, so a user who set
 * `github_auto_push = false` still watched their branches appear on GitHub.
 *
 * INVARIANT: `<driver>_auto_push = false` disables the AUTOMATIC pushes only —
 * the post-turn push and the background sync tick's branch export. Pushes that
 * a merge depends on for correctness (accept pushing the parent before a remote
 * merge, `lazy submit` publishing a branch for its PR) are NOT opt-out: the
 * setting is "don't push behind my back", not "never push".
 */
describe('[remote] <driver>_auto_push', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The post-turn push happens in the daemon's reconcile loop, so this needs
    // a real daemon — a daemonless run never reaches that code path.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Switch the test repo to the GitHub driver backed by a LOCAL bare remote so
   * `git push` really succeeds and the bare repo is an observable record of
   * every push that happened. Editing keys in the init-produced lazy.toml (not
   * overwriting it) keeps `external_path` pointing at the real test store.
   */
  function switchToGitHubDriver(opts: { autoPush?: boolean } = {}): string {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(tomlPath, 'utf-8');
    let toml = before.replace('driver = "local"', 'driver = "github"');
    expect(toml).not.toBe(before);

    if (opts.autoPush !== undefined) {
      const withPush = toml.replace(
        '# github_auto_push = true   # Push task branches automatically; false keeps them local',
        `github_auto_push = ${opts.autoPush}`,
      );
      expect(withPush).not.toBe(toml);
      toml = withPush;
    }
    writeFileSync(tomlPath, toml);

    const bareRemotePath = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', bareRemotePath).exitCode).toBe(0);

    const checkRemote = ctx.git('remote', 'get-url', 'origin');
    if (checkRemote.exitCode === 0) {
      expect(ctx.git('remote', 'set-url', 'origin', bareRemotePath).exitCode).toBe(0);
    } else {
      expect(ctx.git('remote', 'add', 'origin', bareRemotePath).exitCode).toBe(0);
    }

    const pushMain = ctx.git('push', '-u', 'origin', 'main');
    if (pushMain.exitCode !== 0) throw new Error(`Push to origin failed: ${pushMain.stderr}`);
    return bareRemotePath;
  }

  /** Task branches present in the bare remote (i.e. actually pushed). */
  function pushedTaskBranches(bareRemotePath: string): string[] {
    const r = ctx.git('--git-dir', bareRemotePath, 'branch', '--format=%(refname:short)');
    expect(r.exitCode).toBe(0);
    return r.stdout.split('\n').map(l => l.trim()).filter(b => b && b !== 'main');
  }

  /** Run one task turn to completion, leaving a commit on its branch. */
  async function runOneTurn(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    return taskId;
  }

  // Control: with auto-push at its default (true), the daemon DOES push the
  // task branch after the turn. This is what makes the negative test below
  // meaningful rather than vacuously green.
  test('auto-push enabled (default): the task branch reaches the remote after a turn', async () => {
    const bareRemotePath = switchToGitHubDriver();
    await runOneTurn('Auto-push enabled');

    // The push is fired-and-forgotten from the reconcile tick; give it a tick
    // or two to land before asserting.
    await waitFor(() => pushedTaskBranches(bareRemotePath).length > 0);
    expect(pushedTaskBranches(bareRemotePath).length).toBe(1);
  });

  // INVARIANT: github_auto_push = false means lazy does not push task branches
  // behind the user's back. Before the fix this assertion failed — the key was
  // read by nothing and the daemon pushed anyway.
  test('github_auto_push = false: no task branch is pushed after a turn', async () => {
    const bareRemotePath = switchToGitHubDriver({ autoPush: false });
    await runOneTurn('Auto-push disabled');

    // Give the daemon the same grace the control test needed, so this is a
    // real "nothing happened" and not just "we looked too early".
    await sleep(3000);
    expect(pushedTaskBranches(bareRemotePath)).toEqual([]);
  });

  // The opt-out must not reach pushes a merge depends on: accept pushes the
  // parent branch after a local squash merge so origin never drifts behind.
  test('github_auto_push = false still pushes the parent branch on accept', async () => {
    const bareRemotePath = switchToGitHubDriver({ autoPush: false });
    const taskId = await runOneTurn('Accept still pushes');

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'accepted.txt'), 'content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'accepted.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add accepted file').exitCode).toBe(0);

    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, taskId);

    expectSuccess(await ctx.lazy(['accept', taskId]));

    const localMain = ctx.git('rev-parse', 'main').stdout.trim();
    const remoteMain = ctx.git('--git-dir', bareRemotePath, 'rev-parse', 'main').stdout.trim();
    expect(remoteMain).toBe(localMain);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error('waitFor: condition never became true');
}
