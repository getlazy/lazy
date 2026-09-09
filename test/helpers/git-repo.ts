/**
 * Tiny git-repo fixtures for unit tests.
 *
 * Several suites need a directory that is genuinely a git worktree with a real
 * commit — the consent flows record the worktree HEAD as provenance, so a plain
 * temp directory cannot exercise that field.
 * Identity is configured locally so the developer's own git config (or its
 * absence in CI) never decides whether a commit succeeds.
 */

import { runGit } from '../../src/utils/git';

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** `git init` + local identity. Does not commit. */
export async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@lazy.test']);
  await git(dir, ['config', 'user.name', 'Lazy Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

/** Stage everything and commit. Returns the new commit SHA. */
export async function commitAll(dir: string, message = 'fixture'): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message, '--no-verify']);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/** `initGitRepo` + `commitAll` for a directory whose files already exist. */
export async function initGitRepoWithCommit(dir: string, message = 'fixture'): Promise<string> {
  await initGitRepo(dir);
  return commitAll(dir, message);
}
