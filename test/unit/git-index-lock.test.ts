/**
 * Unit tests for git index.lock stale-lock recovery.
 *
 * INVARIANT (fix-accept-index-lock): a zero-byte / fresh-mtime index.lock with
 * NO live opener must be cleared so accept can proceed; a lock with a live
 * opener must NEVER be deleted; when we cannot scan for openers we must refuse
 * to delete rather than guess. Age/mtime is deliberately not consulted — the
 * synthetic reproduction (touch'd lock, fresh mtime, no holder) is exactly the
 * case an age heuristic gets wrong.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath, open, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { pathExists } from '../../src/utils/fs';
import {
  clearStaleIndexLock,
  findIndexLockHolders,
  INCOMPLETE_PROCESS_TABLE_REASON,
  isIndexLockError,
  resolveIndexLockPath,
} from '../../src/git/index-lock';
import { squashMergeBranchIntoTarget } from '../../src/git/operations';

async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'init\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

/**
 * These suites exercise clear/squash against container-local temp repos. The
 * opener scan's "empty ⇒ safe to delete" result is only authorized when the
 * process table is complete (host daemon). Lazy's own unit runs often sit
 * inside a task container (/.dockerenv), which would fail-closed and block
 * every clear. Force the host verdict for the happy path; the incomplete-table
 * refusal is pinned separately via deps injection.
 */
let prevForceContainer: string | undefined;

beforeAll(() => {
  prevForceContainer = process.env.LAZY_FORCE_CONTAINER;
  process.env.LAZY_FORCE_CONTAINER = '0';
});

afterAll(() => {
  if (prevForceContainer === undefined) delete process.env.LAZY_FORCE_CONTAINER;
  else process.env.LAZY_FORCE_CONTAINER = prevForceContainer;
});

describe('isIndexLockError', () => {
  test('matches git\'s classic File exists message', () => {
    const stderr =
      "error: Unable to create '/repo/.git/worktrees/release-v022/index.lock': File exists.\n" +
      'Another git process seems to be running in this repository';
    expect(isIndexLockError(stderr)).toBe(true);
  });

  test('ignores unrelated merge failures', () => {
    expect(isIndexLockError('error: Merging is not possible because you have unmerged files.')).toBe(false);
  });
});

describe('clearStaleIndexLock', () => {
  let repo: string;
  let parentWorktree: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'lazy-idxlock-')));
    await initRepo(repo);
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(parentWorktree, { recursive: true, force: true });
  });

  test('no-ops when no lock file exists', async () => {
    const result = await clearStaleIndexLock(parentWorktree);
    expect(result.cleared).toBe(false);
    expect(result.lockPath).toBeTruthy();
  });

  // INVARIANT: zero-byte lock, no live holder, recent mtime → clear it.
  // This is the synthetic reproduction the engineer left in place (touch'd
  // lock) and the shape of the original ~11h-stale wild failure.
  test('removes a zero-byte lock with no live holder (fresh mtime)', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    await writeFile(lockPath!, '');

    const warnings: string[] = [];
    const result = await clearStaleIndexLock(parentWorktree, {
      warn: (msg) => warnings.push(msg),
    });

    expect(result.cleared).toBe(true);
    expect(result.lockPath).toBe(lockPath);
    expect(await pathExists(lockPath!)).toBe(false);
    expect(warnings.some((w) => w.includes('Removed stale git index lock'))).toBe(true);
    expect(warnings.some((w) => w.includes(lockPath!))).toBe(true);
  });

  test('refuses to remove a lock when a live process has it open', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();

    // Hold the file open via an fd in THIS process — the procfs scanner must
    // see us. Keep the handle for the duration of the assertion.
    const handle = await open(lockPath!, 'w');
    try {
      // On hosts without /proc and without lsof the scan is unavailable; the
      // injected-holder test below still pins the refusal contract. Here we only
      // assert when a real scan is possible.
      const probe = await findIndexLockHolders(lockPath!);
      if (!probe.scanned) {
        console.log('skip live-fd holder check: opener scan unavailable in this environment');
        return;
      }
      await expect(clearStaleIndexLock(parentWorktree)).rejects.toThrow(/held by a live process/);
      // Lock must still be there — never blind-rm a live holder's lock.
      expect(await pathExists(lockPath!)).toBe(true);
    } finally {
      await handle.close();
      try {
        await unlink(lockPath!);
      } catch {
        // Already gone is fine.
      }
    }
  });

  // Same refusal path, without depending on /proc seeing our fd — pins the
  // "live holder → never delete" contract even on hosts where the scanner
  // cannot observe this process's open files.
  test('refuses to remove when findHolders reports a live opener', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    await writeFile(lockPath!, '');

    await expect(
      clearStaleIndexLock(parentWorktree, {
        findHolders: async () => ({
          scanned: true,
          holders: [{ pid: 4242, command: 'git merge --squash' }],
        }),
      }),
    ).rejects.toThrow(/pid 4242.*git merge --squash/);

    expect(await pathExists(lockPath!)).toBe(true);
    await unlink(lockPath!);
  });

  test('refuses to remove when the opener scan is unavailable', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    await writeFile(lockPath!, '');

    await expect(
      clearStaleIndexLock(parentWorktree, {
        findHolders: async () => ({
          scanned: false,
          reason: 'test: scan disabled',
        }),
      }),
    ).rejects.toThrow(/could not check whether a process still holds it/);

    expect(await pathExists(lockPath!)).toBe(true);
    await unlink(lockPath!);
  });

  // INVARIANT: never-corrupt — an empty scan inside an incomplete process table
  // (PID namespace / container) must NOT authorize deletion. A host git holding
  // a bind-mounted lock would be invisible; deleting it would corrupt the index.
  test('refuses to remove on an empty scan when the process table may be incomplete', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    await writeFile(lockPath!, '');

    await expect(
      clearStaleIndexLock(parentWorktree, {
        processTableMayBeIncomplete: async () => true,
      }),
    ).rejects.toThrow(/could not check whether a process still holds it/);

    expect(await pathExists(lockPath!)).toBe(true);
    await unlink(lockPath!);
  });

  test('findIndexLockHolders treats empty results as unverifiable when the table is incomplete', async () => {
    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    await writeFile(lockPath!, '');

    const probe = await findIndexLockHolders(lockPath!, {
      processTableMayBeIncomplete: async () => true,
    });
    expect(probe.scanned).toBe(false);
    if (!probe.scanned) {
      expect(probe.reason).toBe(INCOMPLETE_PROCESS_TABLE_REASON);
    }
    await unlink(lockPath!);
  });
});

describe('squashMergeBranchIntoTarget recovers from a stale index.lock', () => {
  let repo: string;
  let parentWorktree: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'lazy-squash-idxlock-')));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    if (parentWorktree) await rm(parentWorktree, { recursive: true, force: true });
  });

  // Bug reproduction first: without recovery, squash merge into a worktree
  // with a planted index.lock fails. With recovery, it succeeds.
  test('accept-style squash merge succeeds after clearing a stale lock in the target worktree', async () => {
    await runGit(['branch', 'lazy/parent'], { cwd: repo });
    parentWorktree = `${repo}-parent`;
    await runGit(['worktree', 'add', '-q', parentWorktree, 'lazy/parent'], { cwd: repo });

    await runGit(['checkout', '-q', '-b', 'lazy/child', 'lazy/parent'], { cwd: repo });
    await writeFile(join(repo, 'child.txt'), 'child work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'child work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    const lockPath = await resolveIndexLockPath(parentWorktree);
    expect(lockPath).toBeTruthy();
    // Fresh mtime, zero bytes, no holder — the synthetic case.
    await writeFile(lockPath!, '');

    await squashMergeBranchIntoTarget('lazy/child', 'lazy/parent', 'Accept child', repo);

    const log = await runGit(['log', '--format=%s', 'lazy/parent'], { cwd: repo });
    expect(log.stdout).toContain('Accept child');
    expect(await pathExists(lockPath!)).toBe(false);
  });
});

describe('findIndexLockHolders', () => {
  test('reports no holders for a file nobody has open (when scan works)', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-holders-')));
    try {
      const lockPath = join(dir, 'index.lock');
      await writeFile(lockPath, '');
      const probe = await findIndexLockHolders(lockPath);
      // On Linux we expect a successful empty scan via procfs. On platforms
      // without /proc or lsof, scanned may be false — both are honest.
      if (probe.scanned) {
        expect(probe.holders).toEqual([]);
      } else {
        expect(probe.reason.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
