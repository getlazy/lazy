/**
 * Unit tests for resolveUpstreamMergeRef — the shared answer to "which ref does
 * this parent branch actually live on?"
 *
 * Background (fix-sync-stale-origin-parent): `lazy sync` resolved the merge
 * target through `driver.resolveUpstreamRef`, which always returns
 * `origin/<parent>` for a hosted driver. But `lazy accept` merges an UNPROTECTED
 * target — every intermediate `lazy/...` task branch — into the LOCAL branch,
 * and a parent task's own agent commits can never be on origin (task agents have
 * no push credentials). So sync reported "Already up to date" while accept
 * refused with conflicts, and its advice to "run lazy sync" was unactionable.
 *
 * The opposite miss must not regress (fix-upstream-ref / fix-upstream-remote):
 * the local parent can be BEHIND origin after a forge-side accept, and merging a
 * stale local branch drops upstream work.
 */

import { describe, test, expect } from 'bun:test';
import {
  isIntermediateBranch,
  mergeLandsLocally,
  resolveUpstreamMergeRef,
} from '../../src/remote/upstream-ref';
import type { GitResult } from '../../src/utils/git';

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string): GitResult => ({ stdout: '', stderr, exitCode: 1 });

interface FakeDriverOpts {
  needsSync: boolean;
  /** null → resolveUpstreamRef returns the branch unchanged (no remote). */
  remote: string | null;
  protectedBranches?: string[];
  protectionError?: Error;
}

function fakeDriver(opts: FakeDriverOpts) {
  const calls: string[] = [];
  const driver = {
    needsSync: opts.needsSync,
    resolveUpstreamRef: async (branch: string) => {
      calls.push(`resolveUpstreamRef:${branch}`);
      return opts.remote ? `${opts.remote}/${branch}` : branch;
    },
    isTargetBranchProtected: async (branch: string) => {
      calls.push(`isTargetBranchProtected:${branch}`);
      if (opts.protectionError) throw opts.protectionError;
      return (opts.protectedBranches ?? []).includes(branch);
    },
  };
  return { driver, calls };
}

/**
 * Canned git responses keyed by the first two argv words, so a test states only
 * the facts it cares about (does the local branch exist, how do the two sides
 * diverge) rather than transcribing git plumbing.
 */
function fakeGit(opts: { localExists?: boolean; counts?: string; countsFail?: string }) {
  const seen: string[][] = [];
  const git = async (args: string[]): Promise<GitResult> => {
    seen.push(args);
    if (args[0] === 'rev-parse') {
      return opts.localExists === false ? fail('not a valid ref') : ok('deadbeef');
    }
    if (args[0] === 'rev-list') {
      if (opts.countsFail) return fail(opts.countsFail);
      return ok(opts.counts ?? '0\t0');
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  return { git, seen };
}

describe('isIntermediateBranch', () => {
  test('claims lazy task branches and nothing else', () => {
    expect(isIntermediateBranch('lazy/fix-thing')).toBe(true);
    expect(isIntermediateBranch('lazy/release-v022')).toBe(true);
    expect(isIntermediateBranch('main')).toBe(false);
    expect(isIntermediateBranch('feature/lazy')).toBe(false);
  });
});

describe('mergeLandsLocally', () => {
  // INVARIANT: this predicate IS accept's merge-routing rule. acceptTask routes
  // an unprotected target through a LocalDriver (local squash merge into the
  // local branch) and only a protected target through the forge. Sync resolves
  // its merge ref through the same function so the two cannot drift apart.
  test('mirrors accept: local unless the target is protected on a real remote', () => {
    expect(mergeLandsLocally({ needsSync: false, targetIsProtected: false })).toBe(true);
    expect(mergeLandsLocally({ needsSync: false, targetIsProtected: true })).toBe(true);
    expect(mergeLandsLocally({ needsSync: true, targetIsProtected: false })).toBe(true);
    expect(mergeLandsLocally({ needsSync: true, targetIsProtected: true })).toBe(false);
  });
});

describe('resolveUpstreamMergeRef', () => {
  test('local driver: returns the branch unchanged and never touches git', async () => {
    const { driver } = fakeDriver({ needsSync: false, remote: null });
    const { git, seen } = fakeGit({});
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('main');
    expect(result.remoteRef).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('parent that exists only on the remote resolves to the remote ref', async () => {
    const { driver } = fakeDriver({ needsSync: true, remote: 'origin' });
    const { git } = fakeGit({ localExists: false });
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('origin/main');
    expect(result.warnings).toEqual([]);
  });

  // INVARIANT (fix-upstream-ref): when the remote CONTAINS the local branch,
  // the remote ref wins. A forge-side accept advances origin while the local
  // branch stays behind; merging the local branch there drops upstream work.
  test('local behind the remote: uses the remote ref, silently', async () => {
    const { driver, calls } = fakeDriver({ needsSync: true, remote: 'origin' });
    const { git } = fakeGit({ counts: '0\t3' });
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('origin/main');
    expect(result.remoteOnly).toBe(3);
    expect(result.warnings).toEqual([]);
    // No protection question is asked when the two refs cannot disagree.
    expect(calls).not.toContain('isTargetBranchProtected:main');
  });

  // The incident itself: a parent TASK branch whose agent's commits are
  // local-only. Accept merges into the local branch, so sync must too.
  test('lazy/ parent ahead of origin: uses the LOCAL branch and warns', async () => {
    const { driver, calls } = fakeDriver({ needsSync: true, remote: 'origin' });
    const { git } = fakeGit({ counts: '2\t0' });
    const result = await resolveUpstreamMergeRef(driver, 'lazy/parent-task', '/wt', { git });

    expect(result.ref).toBe('lazy/parent-task');
    expect(result.localOnly).toBe(2);
    const warning = result.warnings.join('\n');
    // Names both refs, which one was used, and how the commits could reach origin.
    expect(warning).toContain('lazy/parent-task');
    expect(warning).toContain('origin/lazy/parent-task');
    expect(warning).toContain('Used `lazy/parent-task`');
    expect(warning).toContain('no push credentials');
    // A lazy/ branch is never protected — no network call to find that out.
    expect(calls).not.toContain('isTargetBranchProtected:lazy/parent-task');
  });

  test('unprotected named parent ahead of origin: uses local and names the push', async () => {
    const { driver } = fakeDriver({ needsSync: true, remote: 'origin' });
    const { git } = fakeGit({ counts: '1\t1' });
    const result = await resolveUpstreamMergeRef(driver, 'integration', '/wt', { git });

    expect(result.ref).toBe('integration');
    // NEVER auto-push the parent — the human may be mid-manual-work on it.
    expect(result.warnings.join('\n')).toContain('git push origin integration');
  });

  test('protected parent ahead of origin: keeps the remote ref and warns', async () => {
    const { driver } = fakeDriver({
      needsSync: true,
      remote: 'origin',
      protectedBranches: ['main'],
    });
    const { git } = fakeGit({ counts: '1\t0' });
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('origin/main');
    const warning = result.warnings.join('\n');
    expect(warning).toContain('Used `origin/main`');
    expect(warning).toContain('protected');
  });

  test('unreachable forge: keeps the remote ref rather than guessing, and says so', async () => {
    const { driver } = fakeDriver({
      needsSync: true,
      remote: 'origin',
      protectionError: new Error('api unreachable'),
    });
    const { git } = fakeGit({ counts: '1\t0' });
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('origin/main');
    expect(result.warnings.join('\n')).toContain('api unreachable');
  });

  test('rev-list failure is surfaced, not swallowed', async () => {
    const { driver } = fakeDriver({ needsSync: true, remote: 'origin' });
    const { git } = fakeGit({ countsFail: 'bad revision' });
    const result = await resolveUpstreamMergeRef(driver, 'main', '/wt', { git });

    expect(result.ref).toBe('origin/main');
    expect(result.warnings.join('\n')).toContain('bad revision');
  });

  test('honours a non-default remote name in its advice', async () => {
    const { driver } = fakeDriver({ needsSync: true, remote: 'upstream' });
    const { git } = fakeGit({ counts: '1\t0' });
    const result = await resolveUpstreamMergeRef(driver, 'integration', '/wt', {
      git,
      remoteName: 'upstream',
    });

    expect(result.ref).toBe('integration');
    expect(result.warnings.join('\n')).toContain('git push upstream integration');
  });
});
