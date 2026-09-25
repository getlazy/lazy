import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, readTaskJson, readSessionJson, setTaskMetadata, taskFilePath } from '../helpers/storage';

/**
 * A forge merge that lands while lazy is away is finished by the daemon's
 * remote-sync through the SAME commit point as every accept: transition to
 * `complete` first, then retryable follow-through. Here the follow-through's
 * fast-forward genuinely fails — local `main` has diverged from `origin/main`
 * — with no module mocks: a real daemon, real git, and a fake `gh` that only
 * knows the PR is merged, and into `main` (remote-sync checks a merged PR's
 * base before completing a task: src/daemon/review-base.ts).
 */

const FAKE_GH = `#!/bin/sh
case "$*" in
  *"pr view"*"--json state"*) echo '{"state":"MERGED"}'; exit 0 ;;
  *"pr view"*"--json baseRefName"*) echo '{"baseRefName":"main"}'; exit 0 ;;
  *"--version"*) echo "gh version 2.0.0 (fake)"; exit 0 ;;
esac
echo "fake gh: unsupported: $*" >&2
exit 1
`;

describe('forge merge follow-through', () => {
  let ctx: TestContext;
  let ghDir: string;

  beforeEach(async () => {
    ghDir = mkdtempSync(join(tmpdir(), 'lazy-fake-gh-'));
    writeFileSync(join(ghDir, 'gh'), FAKE_GH);
    chmodSync(join(ghDir, 'gh'), 0o755);
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { PATH: `${ghDir}:${process.env.PATH ?? ''}` } });
  });

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(ghDir, { recursive: true, force: true });
  });

  // INVARIANT (accept-merge-is-commit-point): when the forge merged the PR, the
  // task becomes `complete` even though the local fast-forward fails; the
  // fast-forward (and the tag that reads it) stay pending while independent
  // steps — cleanup — run; once the local branch can be fast-forwarded, the
  // daemon finishes it and tags the forge's merge commit.
  test('a failing fast-forward after a forge merge leaves the task complete and is retried', async () => {
    const taskId = await createTask(ctx, 'Forge-merged task', 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktree, 'forge.txt'), 'merged on the forge\n');
    expect(ctx.git('-C', worktree, 'add', 'forge.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add forge.txt').exitCode).toBe(0);
    const branch = ctx.git('-C', worktree, 'branch', '--show-current').stdout.trim();
    const sha = ctx.git('-C', worktree, 'rev-parse', 'HEAD').stdout.trim();
    // A real merge, not a spurious one: the session recorded the commit.
    const sess = readSessionJson(ctx.root, taskId)!;
    writeFileSync(taskFilePath(ctx.root, taskId, 'commits.json'), JSON.stringify({
      commits: [{ id: 'c1', session_id: sess.id, sha, message: 'Add forge.txt', status: 'committed', timestamp: Date.now() }],
    }));

    // Switch to GitHub against a local bare origin.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = readFileSync(tomlPath, 'utf-8');
    const github = toml.replace('driver = "local"', 'driver = "github"');
    expect(github).not.toBe(toml);
    writeFileSync(tomlPath, github);
    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', '-b', 'main', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) {
      expect(ctx.git('remote', 'set-url', 'origin', bare).exitCode).toBe(0);
    } else {
      expect(ctx.git('remote', 'add', 'origin', bare).exitCode).toBe(0);
    }
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);

    // The forge squash-merges the PR into origin/main...
    expect(ctx.git('merge', '--squash', branch).exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'Squash PR #7').exitCode).toBe(0);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
    const forgeMerge = ctx.git('rev-parse', 'main').stdout.trim();
    // ...while local main diverges, so a fast-forward is impossible. (`--keep`,
    // not `--hard`: the edited lazy.toml must survive the reset.)
    expect(ctx.git('reset', '--keep', 'HEAD~1').exitCode).toBe(0);
    writeFileSync(join(ctx.root, 'local-only.txt'), 'not pushed\n');
    expect(ctx.git('add', 'local-only.txt').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'local-only work').exitCode).toBe(0);

    // The task sits `blocked` with its PR open; the forge merged it while lazy was away.
    setTaskMetadata(ctx.root, taskId, 'github_pr_number', '7');

    // The daemon's remote-sync tick (every 60s) sees the PR merged.
    let deadline = Date.now() + 100_000;
    while (readTaskStatus(ctx.root, taskId) !== 'complete' && Date.now() < deadline) await Bun.sleep(1000);
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(readSessionJson(ctx.root, taskId)?.outcome).toBe('accepted');

    let owed: any;
    deadline = Date.now() + 30_000;
    do {
      await Bun.sleep(500);
      owed = JSON.parse(readTaskJson(ctx.root, taskId).metadata?.accept_followthrough || 'null');
    } while (!(owed && owed.attempts > 0) && Date.now() < deadline);
    expect(owed.done).not.toContain('fast-forward');
    expect(owed.done).not.toContain('accept-tag');
    expect(owed.done).toContain('cleanup');
    expect(owed.lastError).toContain('fast-forward');

    // Drop the local-only commit: the fast-forward can now land.
    expect(ctx.git('reset', '--keep', 'HEAD~1').exitCode).toBe(0);
    setTaskMetadata(ctx.root, taskId, 'accept_followthrough', JSON.stringify({ ...owed, nextAttemptAt: 0 }));
    deadline = Date.now() + 60_000;
    while (readTaskJson(ctx.root, taskId).metadata?.accept_followthrough && Date.now() < deadline) await Bun.sleep(500);
    expect(readTaskJson(ctx.root, taskId).metadata?.accept_followthrough ?? '').toBe('');
    expect(ctx.git('rev-parse', 'main').stdout.trim()).toBe(forgeMerge);
    const fullId = readTaskJson(ctx.root, taskId).id;
    expect(ctx.git('rev-parse', `refs/tags/lazy-accept-${fullId}^{commit}`).stdout.trim()).toBe(forgeMerge);
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
  }, 240_000);
});
