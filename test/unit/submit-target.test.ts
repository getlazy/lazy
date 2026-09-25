/**
 * The submit target rule (src/daemon/submit-target.ts): where a submit's PR/MR
 * goes, and when a PR/MR a person opened by hand may be adopted. Uses a real
 * git repository whose remote default branch is `master`, because that is the
 * case a literal `main` fallback gets wrong.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordedReviewBase, resolveSubmitTarget, reviewBaseMismatch, reviewComparisonBranch } from '../../src/daemon/submit-target';
import type { OpenReview, RepositoryDriver } from '../../src/remote/driver';
import type { Storage } from '../../src/storage';
import type { Task, TaskTarget } from '../../src/types';

let repo: string;

function git(...args: string[]): void {
  const res = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString()}`);
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lazy-submit-target-')));
  git('init', '-q', '-b', 'master');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'root');
  // origin's default branch is `master`, as `git clone` records it.
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function rootTask(target: TaskTarget): Task {
  return {
    id: 'root-task-id', code: 'root-task', goal: 'Goal', prompt: '', type: 'task',
    status: 'blocked' as const, created_at: Date.now(), completed_at: null, target,
    branched_from_sha: null, close_reason: null, model: null, agent_id: 'claude-code',
    metadata: {}, pending_sync: 0, runner_type: null, tags: [],
  };
}

// A root task never reaches storage: its target is on the task itself.
const noStorage = {} as Storage;

const review = (baseBranch: string): OpenReview => ({
  url: 'https://github.com/o/r/pull/7',
  baseBranch,
  metadata: { github_remote_ref_url: 'https://github.com/o/r/pull/7', github_remote_ref_id: '7' },
});

async function comparisonFor(target: TaskTarget): Promise<string> {
  return await reviewComparisonBranch(await resolveSubmitTarget(rootTask(target), noStorage), repo, 'origin');
}

const UNRESOLVED: TaskTarget[] = [{ kind: 'branch', branch: '' }, { kind: 'branch', branch: 'HEAD' }];

describe('reviewBaseMismatch', () => {
  // INVARIANT: a root task whose target is unresolved integrates into the
  // REMOTE'S default branch, whatever it is called — compared by its real
  // name. A hand-opened PR into that default is adoptable; on a `master` repo
  // it used to be refused as "merges into `master` while this task integrates
  // into `main`", because the unresolved target was compared as the literal
  // fallback name.
  test('an unresolved root target compares against the remote default, so a PR into `master` is adoptable', async () => {
    for (const target of UNRESOLVED) {
      expect(await comparisonFor(target)).toBe('master');
      expect(reviewBaseMismatch(review('master'), await comparisonFor(target))).toBe(false);
    }
  });

  // INVARIANT: ...and a hand-opened PR into ANOTHER branch is refused at submit.
  // Skipping the comparison for a target-less root task adopted a PR into
  // `release-x`, which the forge accept then refused (or, merged on the forge,
  // landed outside the default branch) — the refusal belongs at submit.
  test('an unresolved root target refuses a PR into a branch that is not the remote default', async () => {
    for (const target of UNRESOLVED) {
      expect(reviewBaseMismatch(review('release-x'), await comparisonFor(target))).toBe(true);
    }
  });

  // INVARIANT: a NAMED target is compared, so a hand-opened PR merging somewhere
  // else is never silently adopted — lazy's record would disagree with the forge.
  test('a named target refuses a PR with a different base and accepts its own', async () => {
    const comparison = await comparisonFor({ kind: 'branch', branch: 'develop' });
    expect(comparison).toBe('develop');
    expect(reviewBaseMismatch(review('main'), comparison)).toBe(true);
    expect(reviewBaseMismatch(review('develop'), comparison)).toBe(false);
  });

  test('a base the forge did not report is not compared', async () => {
    expect(reviewBaseMismatch(review(''), await comparisonFor({ kind: 'branch', branch: 'develop' }))).toBe(false);
  });
});

describe('recordedReviewBase', () => {
  const driver = (hasRef: boolean, base: () => Promise<string | null>) => ({
    hasRemoteRef: () => hasRef,
    getReviewBase: base,
  }) as unknown as RepositoryDriver;

  async function check(target: TaskTarget, d: RepositoryDriver) {
    return await recordedReviewBase(d, rootTask(target), await resolveSubmitTarget(rootTask(target), noStorage), repo, 'origin');
  }

  test('no recorded PR is nothing to check', async () => {
    expect(await check({ kind: 'branch', branch: 'develop' }, driver(false, async () => 'x'))).toEqual({ kind: 'none' });
  });

  test('a recorded PR into the current target matches; one into another branch is a mismatch', async () => {
    expect(await check({ kind: 'branch', branch: 'develop' }, driver(true, async () => 'develop'))).toEqual({ kind: 'match' });
    expect(await check({ kind: 'branch', branch: 'develop' }, driver(true, async () => 'lazy/old-parent')))
      .toEqual({ kind: 'mismatch', base: 'lazy/old-parent', comparison: 'develop' });
    // A no-target root task compares against the remote default's real name.
    expect(await check({ kind: 'branch', branch: '' }, driver(true, async () => 'master'))).toEqual({ kind: 'match' });
  });

  // INVARIANT: a base the forge cannot report is `unreadable`, never a match —
  // submit refuses on it (fail-closed, like an unconfirmed close) rather than
  // report `submitted` with a PR that may merge into a branch the task left.
  test('a forge that errors, or reports no base, is unreadable', async () => {
    const failed = await check({ kind: 'branch', branch: 'develop' }, driver(true, async () => { throw new Error('gh pr view failed'); }));
    expect(failed).toEqual({ kind: 'unreadable', comparison: 'develop', reason: 'gh pr view failed' });
    const blank = await check({ kind: 'branch', branch: 'develop' }, driver(true, async () => null));
    expect(blank.kind).toBe('unreadable');
  });
});
