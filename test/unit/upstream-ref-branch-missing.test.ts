/**
 * INVARIANT: a parent branch git says is not on the remote ("couldn't find
 * remote ref") is an ANSWER, not a connectivity failure. Both hosted drivers
 * stop after one fetch and throw RemoteBranchMissingError, whose message names
 * the branch and never mentions the network or --offline-override. Any other
 * fetch failure still retries and fails as before.
 */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import { RemoteBranchMissingError } from '../../src/remote/branch-missing';
import type { GitResult } from '../../src/utils/git';

const retryOptions = { maxAttempts: 3, backoffMs: [0, 0] };

function recordingGit(stderr: string) {
  const fetches: string[][] = [];
  const runGit = async (args: string[]): Promise<GitResult> => {
    if (args[0] === 'fetch') fetches.push(args);
    return { stdout: '', stderr, exitCode: 128 };
  };
  return { runGit, fetches };
}

const drivers = {
  github: (runGit: (args: string[]) => Promise<GitResult>) =>
    new GitHubDriver(DEFAULT_CONFIG as never, { runGit, retryOptions } as never),
  gitlab: (runGit: (args: string[]) => Promise<GitResult>) =>
    new GitLabDriver(DEFAULT_CONFIG as never, { runGit, retryOptions } as never),
};

for (const [name, make] of Object.entries(drivers)) {
  describe(`${name} resolveUpstreamRef`, () => {
    test('a branch not on the remote is reported as missing after one fetch', async () => {
      const { runGit, fetches } = recordingGit("fatal: couldn't find remote ref lazy/ac596f2b");
      const err = await make(runGit).resolveUpstreamRef('lazy/ac596f2b', '/wt').catch((e) => e);
      expect(err).toBeInstanceOf(RemoteBranchMissingError);
      expect((err as Error).message).toContain('lazy/ac596f2b does not exist on');
      expect((err as Error).message).not.toMatch(/network|offline-override/);
      expect(fetches).toHaveLength(1);
    });

    test('any other fetch failure still retries and fails as a fetch failure', async () => {
      const { runGit, fetches } = recordingGit('fatal: unable to access: Could not resolve host');
      const err = await make(runGit).resolveUpstreamRef('lazy/x', '/wt').catch((e) => e);
      expect(err).not.toBeInstanceOf(RemoteBranchMissingError);
      expect(fetches).toHaveLength(3);
    });
  });
}
