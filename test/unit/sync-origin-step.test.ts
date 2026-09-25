/**
 * Unit tests for the supervisor's ORIGIN step — merging `origin/<task-branch>`
 * into the task's worktree when a colleague has pushed to the task's own branch.
 *
 * INVARIANTS this file encodes:
 *
 *   1. runSyncWithRemote reports the same structured outcome as the parent step
 *      (merged / preMergeSha / postMergeSha / targetSha). Returning only a
 *      conflict list is what made an honest "Merged origin/... @ <sha>" turn
 *      impossible, so the step could not be recorded on the task at all.
 *   2. Already current is an honest NO-OP: merged === false and pre === post.
 *      A no-op step records no turn, so a fake success here would manufacture a
 *      "Merged origin/..." line for a merge that never happened.
 *   3. A fast-forwardable origin branch is merged — the colleague's commit is in
 *      the worktree afterwards.
 *   4. The step NEVER touches the remote-tracking ref or the parent branch: only
 *      the task's own branch moves.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { runSyncWithRemote } from '../../src/supervisor/merge';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  return r.stdout.trim();
}

/**
 * A worktree whose branch has a remote-tracking ref that is AHEAD of it — the
 * shape a colleague's push produces. Built with a real bare "origin" so the
 * refs under test are genuine remote-tracking refs, not local aliases.
 */
async function setupClone(): Promise<{ clone: string; upstream: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lazy-origin-step-'));
  const origin = join(root, 'origin.git');
  const upstream = join(root, 'colleague');
  const clone = join(root, 'task');

  await runGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: root });

  await runGit(['clone', '-q', origin, upstream], { cwd: root });
  await git(upstream, 'config', 'user.email', 'colleague@example.com');
  await git(upstream, 'config', 'user.name', 'Colleague');
  await writeFile(join(upstream, 'shared.txt'), 'base\n');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'base');
  await git(upstream, 'checkout', '-q', '-b', 'lazy/task');
  await git(upstream, 'push', '-q', '-u', 'origin', 'main', 'lazy/task');

  await runGit(['clone', '-q', origin, clone], { cwd: root });
  await git(clone, 'config', 'user.email', 'task@example.com');
  await git(clone, 'config', 'user.name', 'Task');
  await git(clone, 'checkout', '-q', 'lazy/task');

  return { clone, upstream, root };
}

/** Colleague pushes `content` to the shared task branch; task clone fetches. */
async function colleaguePushes(upstream: string, clone: string, file: string, content: string): Promise<void> {
  await writeFile(join(upstream, file), content);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', `colleague: ${file}`);
  await git(upstream, 'push', '-q', 'origin', 'lazy/task');
  await git(clone, 'fetch', '-q', 'origin', 'lazy/task');
}

describe('sync origin step: runSyncWithRemote', () => {
  let clone: string;
  let upstream: string;
  let root: string;

  beforeEach(async () => {
    ({ clone, upstream, root } = await setupClone());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT 2: already current is an honest no-op, not a fake success.
  test('already current reports merged:false with pre === post', async () => {
    const preSha = await git(clone, 'rev-parse', 'HEAD');

    const result = await runSyncWithRemote(clone, 'origin/lazy/task');

    expect(result.merged).toBe(false);
    expect(result.preMergeSha).toBe(preSha);
    expect(result.postMergeSha).toBe(preSha);
    expect(result.conflicts).toHaveLength(0);
    // INVARIANT 1: the target is resolved even for a no-op, so the step can say
    // WHICH commit it was already current with.
    expect(result.targetSha).toBe(preSha);
  });

  // INVARIANT 3 + 4: the colleague's commit lands on the task branch, and
  // nothing else moves.
  test('merges a colleague commit pushed to the task branch', async () => {
    await colleaguePushes(upstream, clone, 'colleague.txt', 'from a colleague\n');
    const preSha = await git(clone, 'rev-parse', 'HEAD');
    const mainBefore = await git(clone, 'rev-parse', 'origin/main');

    const result = await runSyncWithRemote(clone, 'origin/lazy/task');

    expect(result.merged).toBe(true);
    expect(result.preMergeSha).toBe(preSha);
    expect(result.postMergeSha).not.toBe(preSha);
    expect(result.conflicts).toHaveLength(0);
    expect(result.targetSha).toBe(await git(clone, 'rev-parse', 'origin/lazy/task'));

    // The colleague's file is present, and the merged commit is an ancestor.
    const contains = await runGit(['merge-base', '--is-ancestor', result.targetSha, 'HEAD'], { cwd: clone });
    expect(contains.exitCode).toBe(0);

    // INVARIANT 4: the parent branch is untouched by the origin step.
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(mainBefore);
    expect(await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lazy/task');
  });

  // A second run right after the first is a no-op: sync is idempotent, so an
  // auto-sync retry can never double-merge the colleague's commits.
  test('a second run after merging is a no-op', async () => {
    await colleaguePushes(upstream, clone, 'colleague.txt', 'from a colleague\n');
    await runSyncWithRemote(clone, 'origin/lazy/task');
    const afterFirst = await git(clone, 'rev-parse', 'HEAD');

    const second = await runSyncWithRemote(clone, 'origin/lazy/task');

    expect(second.merged).toBe(false);
    expect(second.postMergeSha).toBe(afterFirst);
  });

  // An unresolvable target is an actionable error, never a silent "nothing to do".
  test('throws with context when the remote ref does not exist', async () => {
    await expect(runSyncWithRemote(clone, 'origin/lazy/does-not-exist')).rejects.toThrow(
      /Failed to resolve merge target origin\/lazy\/does-not-exist/,
    );
  });
});
