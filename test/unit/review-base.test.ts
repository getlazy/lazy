/**
 * src/daemon/review-base.ts — which branch a forge accept compares a PR's base
 * against, and the comparison itself. Uses a real git repository whose remote
 * default branch is `master`, because that is the case a literal `main`
 * fallback gets wrong.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mismatchedReviewBase, reviewComparisonTarget } from '../../src/daemon/review-base';
import type { RepositoryDriver } from '../../src/remote/driver';
import type { Task, TaskTarget } from '../../src/types';

let repo: string;

function git(...args: string[]): void {
  const res = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString()}`);
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lazy-review-base-')));
  git('init', '-q', '-b', 'master');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'root');
  // origin's default branch is `master`, as `git clone` records it.
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function task(target: TaskTarget): Task {
  return {
    id: 'task-id', code: 'root-task', goal: 'Goal', prompt: '', type: 'task', status: 'blocked',
    created_at: Date.now(), completed_at: null, target, branched_from_sha: null, close_reason: null,
    model: null, agent_id: 'claude-code', metadata: { github_remote_ref_id: '7' },
    pending_sync: 0, runner_type: null, tags: [],
  };
}

const driverWithBase = (base: string) => ({
  hasRemoteRef: () => true,
  getReviewBase: async () => base,
}) as unknown as RepositoryDriver;

describe('reviewComparisonTarget', () => {
  // INVARIANT: a root task with no named target integrates into the REMOTE'S
  // DEFAULT branch — the drivers open its PR there — so a forge accept compares
  // the PR's base against that default, never the literal `main` the accept's
  // merge target falls back to. In a `master` repo the literal refused every
  // such PR as review-base-mismatch.
  test('an unresolved or HEAD root target compares against the remote default (master)', async () => {
    for (const target of [{ kind: 'branch', branch: '' }, { kind: 'branch', branch: 'HEAD' }] as TaskTarget[]) {
      const compareTo = await reviewComparisonTarget(task(target), 'main', repo, 'origin');
      expect(compareTo).toBe('master');
      expect(await mismatchedReviewBase(driverWithBase('master'), task(target), compareTo)).toBeNull();
    }
  });

  test('a named target, and a stacked task, compare against the accept\'s own target', async () => {
    expect(await reviewComparisonTarget(task({ kind: 'branch', branch: 'develop' }), 'develop', repo, 'origin')).toBe('develop');
    expect(await reviewComparisonTarget(task({ kind: 'task', parentTaskId: 'p' }), 'lazy/parent', repo, 'origin')).toBe('lazy/parent');
    // ...so a named target still refuses a PR merging somewhere else.
    expect(await mismatchedReviewBase(driverWithBase('master'), task({ kind: 'branch', branch: 'develop' }), 'develop')).toBe('master');
  });
});

describe('mismatchedReviewBase on a linked task', () => {
  // INVARIANT (src/daemon/review-base.ts): a LINKED task's PR (`lazy link`) is
  // never checked — neither the forge accept nor remote-sync second-guesses
  // where its owner points or merges it — and the forge is not even asked.
  test('answers null without asking the forge', async () => {
    let asked = 0;
    const driver = { hasRemoteRef: () => true, getReviewBase: async () => { asked++; return 'develop'; } } as unknown as RepositoryDriver;
    const linked = task({ kind: 'branch', branch: 'main' });
    linked.metadata = { ...linked.metadata, import_source_url: 'https://github.com/acme/widgets/pull/7', import_source_branch: 'feature/x' };
    expect(await mismatchedReviewBase(driver, linked, 'main')).toBeNull();
    expect(asked).toBe(0);
  });
});
