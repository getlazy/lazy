/**
 * Unit tests for git's "dubious ownership" refusal — detection, the message
 * lazy puts in front of the human, and the safe.directory remedy.
 *
 * WHY THIS MATTERS (fix-dubious-ownership-merge): the agent container runs as
 * its own uid against a worktree the host user owns. git compares the repository
 * directory's owner against the uid running git and refuses on mismatch, which
 * kills EVERY git command in that worktree — the merge phase is just where it
 * was first observed in the wild. Docker Desktop for macOS mounts binds as
 * `fakeowner` (stat reports the caller's own uid) and made the check vacuous,
 * which is why this went unnoticed; podman, Colima and Linux hosts whose uid is
 * not the image's do not fake it.
 *
 * The last describe block induces a REAL refusal by chowning a repo to another
 * uid, so nothing here is faked. It needs passwordless chown (lazy's own agent
 * container has it) and prints one line and skips where it is unavailable — a
 * skip is not a pass.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { runGit } from '../../src/utils/git';
import {
  DUBIOUS_OWNERSHIP_MARKER,
  isDubiousOwnershipError,
  explainDubiousOwnership,
} from '../../src/utils/git-ownership';
import { spawn } from '../../src/utils/spawn';

/** Verbatim git 2.39 output, so detection is pinned against the real string. */
const REAL_GIT_STDERR =
  "fatal: detected dubious ownership in repository at '/Users/x/prg/p/.lazy/worktrees/t'\n" +
  'To add an exception for this directory, call:\n\n' +
  '\tgit config --global --add safe.directory /Users/x/prg/p/.lazy/worktrees/t';

describe('dubious-ownership detection', () => {
  test('recognises the real git refusal', () => {
    expect(isDubiousOwnershipError(REAL_GIT_STDERR)).toBe(true);
    expect(REAL_GIT_STDERR).toContain(DUBIOUS_OWNERSHIP_MARKER);
  });

  test('does not fire on other git fatals', () => {
    expect(isDubiousOwnershipError('fatal: not a git repository')).toBe(false);
    expect(isDubiousOwnershipError('error: pathspec did not match')).toBe(false);
    expect(isDubiousOwnershipError('')).toBe(false);
  });
});

describe('dubious-ownership explanation', () => {
  // The container message is the one that matters: git's own suggestion is to
  // run `git config --global` — advice the human would apply on the HOST for a
  // path git is complaining about from INSIDE a container, where a host git
  // config is never read. It has to say that plainly or it is worse than silence.
  test('in-container message contradicts git\'s host-side suggestion', () => {
    const msg = explainDubiousOwnership('/w/t', true);
    expect(msg).toContain('agent container');
    expect(msg).toContain('not read in here');
    expect(msg).toContain('.lazy-task-sandbox/.gitconfig');
  });

  test('host message tells the human not to paper over it', () => {
    const msg = explainDubiousOwnership('/w/t', false);
    expect(msg).toContain('/w/t');
    expect(msg).toContain('do not add a');
    expect(msg).toContain('safe.directory');
  });

  test('never tells the human to blanket-trust every repository', () => {
    for (const inContainer of [true, false]) {
      const msg = explainDubiousOwnership('/w/t', inContainer);
      expect(msg).not.toContain("safe.directory '*'");
      expect(msg).not.toContain('safe.directory=*');
    }
  });
});

/** Can this test process hand a directory to another uid? */
async function canChown(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const probe = spawn(['sudo', '-n', 'true'], { stdout: 'ignore', stderr: 'ignore', timeout: 5000 });
  return (await probe.exited) === 0;
}

describe('a real dubious-ownership refusal', () => {
  let available = false;
  let root: string;
  let repo: string;

  beforeAll(async () => {
    available = await canChown();
    if (!available) {
      console.log(
        '[skip] a real dubious-ownership refusal — needs passwordless sudo chown ' +
        `(platform=${process.platform}). A skip is not a pass.`,
      );
    }
  });

  beforeEach(async () => {
    if (!available) return;
    root = await mkdtemp(join(tmpdir(), 'lazy-dubious-'));
    repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
    await runGit(['config', 'user.name', 'Test'], { cwd: repo });
    await runGit(['config', 'user.email', 'test@example.test'], { cwd: repo });
    await writeFile(join(repo, 'f.txt'), 'hello\n');
    await runGit(['add', 'f.txt'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: repo });
    // Hand the whole repo to a uid this process is not. This is exactly the
    // shape of the container case: host-owned files, a different uid running git.
    await spawn(['sudo', '-n', 'chown', '-R', '12345:12345', repo], { stdout: 'ignore', stderr: 'ignore' }).exited;
  });

  afterEach(async () => {
    if (!available || !root) return;
    await spawn(['sudo', '-n', 'rm', '-rf', root], { stdout: 'ignore', stderr: 'ignore' }).exited;
    await rm(root, { recursive: true, force: true });
  });

  test('git really refuses, and runGit puts lazy\'s explanation in the stderr', async () => {
    if (!available) return;

    const result = await runGit(['rev-parse', 'HEAD'], { cwd: repo });

    expect(result.exitCode).not.toBe(0);
    // git's own text is kept: it names the offending path and is what a human
    // searches for. Lazy's explanation is appended, never a replacement.
    expect(result.stderr).toContain(DUBIOUS_OWNERSHIP_MARKER);
    expect(result.stderr).toContain('lazy:');
    expect(result.stderr).toContain('safe.directory');
  });

  // INVARIANT: this is the actual remedy setupSandbox writes. If a scoped
  // safe.directory in a GLOBAL config did not clear a real refusal, the fix in
  // src/utils/sandbox.ts would be theatre.
  test('a scoped safe.directory in the global config clears it', async () => {
    if (!available) return;

    const gitconfig = join(root, 'gitconfig');
    await writeFile(gitconfig, `[safe]\n\tdirectory = "${repo}"\n`);

    const before = await runGit(['rev-parse', 'HEAD'], { cwd: repo });
    expect(before.exitCode).not.toBe(0);

    const after = await runGit(['rev-parse', 'HEAD'], {
      cwd: repo,
      env: { GIT_CONFIG_GLOBAL: gitconfig },
    });

    expect(after.exitCode).toBe(0);
    expect(after.stdout).toMatch(/^[0-9a-f]{40}$/);
  });

  // The scope is the whole argument for why this is safe to ship: trusting
  // lazy's own worktree must NOT trust every other repository the container
  // can see.
  test('the scoped entry does not trust an unrelated repository', async () => {
    if (!available) return;

    const other = join(root, 'other');
    await mkdir(other, { recursive: true });
    await runGit(['init', '-q', '-b', 'main'], { cwd: other });
    await spawn(['sudo', '-n', 'chown', '-R', '12345:12345', other], { stdout: 'ignore', stderr: 'ignore' }).exited;

    const gitconfig = join(root, 'gitconfig');
    await writeFile(gitconfig, `[safe]\n\tdirectory = "${repo}"\n`);

    const result = await runGit(['status', '--porcelain'], {
      cwd: other,
      env: { GIT_CONFIG_GLOBAL: gitconfig },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(DUBIOUS_OWNERSHIP_MARKER);
  });
});
