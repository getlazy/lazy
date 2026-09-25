/**
 * GitLabDriver's seams for an explicit human `lazy submit` into an
 * intermediate branch (src/daemon/submit-target.ts): an explicit MR target,
 * the open-MR lookup that lets submit adopt a hand-opened MR, and the
 * remote-branch lookup that refuses a base the remote does not have.
 * The GitHub twin is test/unit/github-driver-mark-ready.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  remote: { ...DEFAULT_CONFIG.remote, driver: 'gitlab', git_remote: 'origin' },
} as ResolvedConfig;

function stackedTask(metadata: Record<string, string> = {}): Task {
  return {
    id: 'child-task-id',
    code: null,
    goal: 'Child goal',
    prompt: 'Child prompt',
    type: 'task',
    status: 'blocked' as const,
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'task' as const, parentTaskId: 'parent-id' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata,
    pending_sync: 0,
    runner_type: null,
    tags: [],
  };
}

const ok = (stdout = ''): GlResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error', exitCode = 1): GlResult => ({ stdout: '', stderr, exitCode });

function driverWith(runGl: GitLabDriverDeps['runGl'], runGit: GitLabDriverDeps['runGit'] = async () => ok()): GitLabDriver {
  return new GitLabDriver(config, { runGl, runGit });
}

describe('GitLabDriver markReadyForReview on a stacked task', () => {
  // INVARIANT: with no explicit base, a task stacked on another task is still
  // REFUSED — the "no MR for intermediate branches" default lives in the
  // driver too, so an automatic caller cannot open one by accident.
  test('refuses without an explicit base, and calls glab not at all', async () => {
    const calls: string[][] = [];
    const driver = driverWith(async (args) => { calls.push([...args]); return fail('unexpected'); });
    await expect(driver.markReadyForReview(stackedTask())).rejects.toThrow('stacked on another task');
    expect(calls).toEqual([]);
  });

  // INVARIANT: an explicit base reaches glab verbatim as --target-branch.
  test('creates the MR against an explicit base', async () => {
    const calls: string[][] = [];
    const url = 'https://gitlab.com/o/r/-/merge_requests/12';
    const driver = driverWith(async (args) => {
      calls.push([...args]);
      if (args[0] === 'mr' && args[1] === 'create') return ok(`${url}\n`);
      if (args[0] === 'mr' && args[1] === 'view') return ok(JSON.stringify({ iid: 12, web_url: url, state: 'opened' }));
      return fail('unexpected gl call');
    });
    const result = await driver.markReadyForReview(stackedTask(), { baseBranch: 'lazy/parent' });
    const create = calls.find((c) => c[0] === 'mr' && c[1] === 'create')!;
    expect(create[create.indexOf('--target-branch') + 1]).toBe('lazy/parent');
    expect(result.metadata?.gitlab_remote_ref_url).toBe(url);
  });
});

describe('GitLabDriver findOpenReviewForBranch', () => {
  test('maps an opened MR, its target branch becoming the base', async () => {
    const url = 'https://gitlab.com/o/r/-/merge_requests/3';
    const driver = driverWith(async () => ok(JSON.stringify({ web_url: url, iid: 3, state: 'opened', target_branch: 'lazy/parent' })));
    expect(await driver.findOpenReviewForBranch('lazy/child')).toEqual({
      url,
      baseBranch: 'lazy/parent',
      metadata: { gitlab_remote_ref_url: url, gitlab_remote_ref_id: '3' },
    });
  });

  test('a merged or closed MR is not open, so there is nothing to adopt', async () => {
    for (const state of ['merged', 'closed']) {
      const driver = driverWith(async () => ok(JSON.stringify({ web_url: 'u', iid: 3, state, target_branch: 'main' })));
      expect(await driver.findOpenReviewForBranch('lazy/child')).toBeNull();
    }
  });

  test('glab saying the branch has no MR answers null', async () => {
    const driver = driverWith(async () => fail('no open merge request available for "lazy/child"'));
    expect(await driver.findOpenReviewForBranch('lazy/child')).toBeNull();
  });

  // INVARIANT: failing to ASK is not "no MR" — submit would then try to open a
  // second one, or tell the person there is none when there is.
  test('an auth or network failure throws instead of reading as "no MR"', async () => {
    for (const stderr of ['401 Unauthorized', 'dial tcp: lookup gitlab.com: no such host']) {
      const driver = driverWith(async () => fail(stderr));
      await expect(driver.findOpenReviewForBranch('lazy/child')).rejects.toThrow(stderr);
    }
  });

  test('unparseable output throws', async () => {
    const driver = driverWith(async () => ok('not json'));
    await expect(driver.findOpenReviewForBranch('lazy/child')).rejects.toThrow('unparseable JSON');
  });
});

describe('GitLabDriver remoteBranchHead', () => {
  test('the SHA when the remote has the branch', async () => {
    const gitCalls: string[][] = [];
    const driver = driverWith(async () => fail('unused'), async (args) => {
      gitCalls.push([...args]);
      return ok('0123abcd\trefs/heads/lazy/parent\n');
    });
    expect(await driver.remoteBranchHead('lazy/parent')).toBe('0123abcd');
    expect(gitCalls[0]).toEqual(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/lazy/parent']);
  });

  // INVARIANT: "the remote has no such branch" (ls-remote exit 2) is an
  // answer, and every other failure is not — it throws, so a network blip is
  // never reported to the person as "your parent branch is not on origin".
  test('null when the remote answers it has no such branch; throws when it cannot be asked', async () => {
    let reply: GlResult = fail('', 2);
    const driver = driverWith(async () => fail('unused'), async () => reply);
    expect(await driver.remoteBranchHead('lazy/parent')).toBeNull();
    reply = fail('fatal: unable to access', 128);
    await expect(driver.remoteBranchHead('lazy/parent')).rejects.toThrow('unable to access');
  });
});

describe('GitLabDriver getReviewBase', () => {
  const withMr = () => stackedTask({ gitlab_remote_ref_id: '12', gitlab_remote_ref_url: 'https://gitlab.com/o/r/-/merge_requests/12' });

  test('reads the recorded MR\'s target branch; null when the task records no MR', async () => {
    const calls: string[][] = [];
    const driver = driverWith(async (args) => { calls.push([...args]); return ok(JSON.stringify({ target_branch: 'lazy/parent' })); });
    expect(await driver.getReviewBase(withMr())).toBe('lazy/parent');
    expect(calls[0]).toEqual(['mr', 'view', '12', '--output', 'json']);
    expect(await driver.getReviewBase(stackedTask())).toBeNull();
  });

  // INVARIANT: a base that cannot be read is an error, never "no MR".
  test('throws when the forge cannot be asked or answers without a target branch', async () => {
    let reply: GlResult = fail('401 Unauthorized');
    const driver = driverWith(async () => reply);
    await expect(driver.getReviewBase(withMr())).rejects.toThrow('401 Unauthorized');
    reply = ok('{}');
    await expect(driver.getReviewBase(withMr())).rejects.toThrow('no usable target branch');
  });
});

describe('GitLabDriver retargetReview', () => {
  const withMr = () => stackedTask({ gitlab_remote_ref_id: '12' });

  test('moves the recorded MR with glab mr update --target-branch', async () => {
    const calls: string[][] = [];
    const driver = driverWith(async (args) => { calls.push([...args]); return ok(); });
    await driver.retargetReview(withMr(), 'main');
    expect(calls[0]).toEqual(['mr', 'update', '12', '--target-branch', 'main']);
  });

  // INVARIANT: a refused retarget throws — the caller then CLOSES the MR.
  test('throws when the forge refuses, and when the task records no MR', async () => {
    const driver = driverWith(async () => fail('403 Forbidden'));
    await expect(driver.retargetReview(withMr(), 'main')).rejects.toThrow('403 Forbidden');
    await expect(driver.retargetReview(stackedTask(), 'main')).rejects.toThrow('records no MR');
  });
});
