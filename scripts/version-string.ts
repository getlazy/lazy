/**
 * The single place that decides what lazy's version string looks like.
 *
 * Shared by `scripts/generate-version.ts` (the real generator) and
 * `test/preload-generate.ts` (which regenerates a missing src/version.ts before
 * a bare `bun test`). They used to each carry their own copy of this logic, so
 * the two drifted the moment either changed.
 *
 * Format: {major}.{minor}.{commit-count}[-alpha]
 *   - major/minor come from package.json
 *   - the patch component is `git rev-list --count HEAD`
 *   - `-alpha` is appended whenever the build is NOT from `main`
 *
 * If git is unavailable (e.g. `bun install` in a non-git context), falls back to
 * package.json's version verbatim.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

function git(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    // Git not available, or not a git repo.
    return null;
  }
}

/**
 * The branch this build comes from, or null when it cannot be determined.
 *
 * `GITHUB_REF_NAME` is consulted FIRST and trusted over git: CI checks out a
 * detached HEAD, so `git rev-parse --abbrev-ref HEAD` there returns the literal
 * string `HEAD` — which is not a branch name and must never be compared against
 * `main`. Locally the env var is unset and the git call is authoritative.
 */
export function detectBranch(root: string): string | null {
  const fromCI = process.env.GITHUB_REF_NAME?.trim();
  if (fromCI) return fromCI;

  const branch = git('rev-parse --abbrev-ref HEAD', root);
  if (!branch || branch === 'HEAD') return null;
  return branch;
}

/**
 * Compute the version string for a checkout at `root`.
 *
 * The `-alpha` suffix marks "this build did not come from main" — worktree
 * builds, feature branches, and anything a contributor compiled locally. It is
 * deliberately NOT applied when the branch cannot be determined at all: that is
 * the packaged/no-git case, where the package.json version is already the
 * release identity and calling it alpha would be a lie in the opposite
 * direction. Semver orders `0.21.1373-alpha` before `0.21.1373`, so the suffix
 * sorts the way a pre-release should.
 */
export function computeVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

  const commitCount = git('rev-list --count HEAD', root);
  if (!commitCount || !/^\d+$/.test(commitCount)) {
    return pkg.version;
  }

  const [major, minor] = String(pkg.version).split('.');
  const branch = detectBranch(root);
  const suffix = branch !== null && branch !== 'main' ? '-alpha' : '';
  return `${major}.${minor}.${commitCount}${suffix}`;
}
