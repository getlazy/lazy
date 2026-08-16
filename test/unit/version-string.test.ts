/**
 * The version string's shape: {major}.{minor}.{commit-count}[-alpha].
 *
 * The `-alpha` suffix answers one question — "did this build come from main?" —
 * and it is the only thing in the version that is not mechanical. Two of the
 * cases below are the ones that get it wrong in practice:
 *
 *   - CI checks out a DETACHED HEAD, so `git rev-parse --abbrev-ref HEAD`
 *     returns the literal string `HEAD`. Comparing that against `main` marks
 *     every single CI build alpha, which is why GITHUB_REF_NAME wins.
 *   - A packaged install has no git at all. That is the release-identity case,
 *     not a pre-release, so "unknown branch" must NOT mean alpha.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from '../../src/utils/spawn';
import { computeVersion, detectBranch } from '../../scripts/version-string';

/** A repo with a known package.json version and exactly `commits` commits. */
async function makeRepo(commits = 3): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-version-string-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '7.4.0' }));

  const run = (...args: string[]) => {
    const result = spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
    }
  };

  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  for (let i = 0; i < commits; i++) {
    await writeFile(join(dir, `f${i}.txt`), String(i));
    run('add', '.');
    run('commit', '-m', `c${i}`);
  }
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout.toString().trim();
}

describe('computeVersion', () => {
  let dirs: string[];
  let savedRefName: string | undefined;

  beforeEach(() => {
    dirs = [];
    savedRefName = process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_REF_NAME;
  });

  afterEach(async () => {
    if (savedRefName === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = savedRefName;
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function repo(commits?: number): Promise<string> {
    const dir = await makeRepo(commits);
    dirs.push(dir);
    return dir;
  }

  test('on main: major.minor from package.json, patch from the commit count, no suffix', async () => {
    const dir = await repo(3);
    expect(computeVersion(dir)).toBe('7.4.3');
  });

  test('off main: the same version with -alpha', async () => {
    const dir = await repo(3);
    git(dir, 'checkout', '-b', 'some-feature');
    expect(computeVersion(dir)).toBe('7.4.3-alpha');
  });

  // The suffix marks a pre-release, so it has to SORT as one. If it did not,
  // an alpha would read as newer than the release it precedes.
  test('-alpha sorts before the release it precedes', async () => {
    expect(Bun.semver.order('7.4.3-alpha', '7.4.3')).toBe(-1);
  });

  // INVARIANT: GITHUB_REF_NAME wins over git. CI checks out a detached HEAD,
  // where `git rev-parse --abbrev-ref HEAD` says `HEAD` — trusting git there
  // would stamp every CI build, including main's, as alpha.
  test('GITHUB_REF_NAME=main beats a detached HEAD', async () => {
    const dir = await repo(3);
    git(dir, 'checkout', '--detach', 'HEAD');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');

    process.env.GITHUB_REF_NAME = 'main';
    expect(detectBranch(dir)).toBe('main');
    expect(computeVersion(dir)).toBe('7.4.3');
  });

  test('GITHUB_REF_NAME on a branch build yields -alpha', async () => {
    const dir = await repo(3);
    process.env.GITHUB_REF_NAME = 'release-v0.21';
    expect(computeVersion(dir)).toBe('7.4.3-alpha');
  });

  // A detached HEAD with no CI env is "branch unknown", not "not main".
  test('a detached HEAD with no CI env is not marked alpha', async () => {
    const dir = await repo(3);
    git(dir, 'checkout', '--detach', 'HEAD');
    expect(detectBranch(dir)).toBeNull();
    expect(computeVersion(dir)).toBe('7.4.3');
  });

  // The packaged/no-git case: package.json IS the release identity, verbatim.
  test('without git, package.json version is used verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-version-string-nogit-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '7.4.0' }));

    expect(computeVersion(dir)).toBe('7.4.0');
  });
});
