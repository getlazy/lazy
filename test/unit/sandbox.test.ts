/**
 * Unit tests for setupSandbox — the shared helper every supervisor-launching
 * code path depends on (start, resume, sync, unblock, auto-resume, auto-unblock).
 *
 * Exercises the real helper against a tmpdir filesystem, no mocks. The four
 * cases pin the behaviors that used to be open-coded in four separate call
 * sites before fix-sync-sandbox-setup consolidated them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { setupSandbox, SANDBOX_DIR } from '../../src/utils/sandbox';

const DEFAULT_GITCONFIG = '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n';

describe('setupSandbox', () => {
  let worktree: string;
  let fakeHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-sandbox-test-worktree-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-sandbox-test-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test('creates .claude and writes default .gitconfig when sandbox is missing', async () => {
    // Pre-condition: no .lazy-task-sandbox in the worktree and no host
    // .gitconfig — the coldest possible start.
    const result = await setupSandbox(worktree);

    expect(result.worktreePath).toBe(worktree);
    expect(result.sandboxPath).toBe(join(worktree, SANDBOX_DIR));

    const claudeStat = await stat(join(result.sandboxPath, '.claude'));
    expect(claudeStat.isDirectory()).toBe(true);

    const gitconfigPath = join(result.sandboxPath, '.gitconfig');
    const gitconfigStat = await stat(gitconfigPath);
    expect(gitconfigStat.isFile()).toBe(true);

    const contents = await readFile(gitconfigPath, 'utf-8');
    expect(contents).toBe(DEFAULT_GITCONFIG);
  });

  // INVARIANT (fix-sync-sandbox-setup): setupSandbox MUST recover when
  // .lazy-task-sandbox/.gitconfig exists as a *directory*. Docker creates one
  // automatically when the bind-mount source is missing at container launch,
  // and every subsequent git operation inside the sandbox aborts with
  // "fatal: could not lock config file .gitconfig: Is a directory" until the
  // stale directory is removed. If a future refactor drops the `rm -r` step
  // in setupSandbox, this test will fail loudly.
  test('replaces a directory at .gitconfig with a regular file', async () => {
    const sandboxPath = join(worktree, SANDBOX_DIR);
    const staleDir = join(sandboxPath, '.gitconfig');
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, 'junk'), 'bind-mount leftover');

    const result = await setupSandbox(worktree);

    const gitconfigStat = await stat(result.sandboxPath + '/.gitconfig');
    expect(gitconfigStat.isDirectory()).toBe(false);
    expect(gitconfigStat.isFile()).toBe(true);

    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');
    expect(contents).toBe(DEFAULT_GITCONFIG);
  });

  test('writes default gitconfig when host has no .gitconfig', async () => {
    // fakeHome was just mkdtemp'd; it contains no .gitconfig.
    const result = await setupSandbox(worktree);

    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');
    expect(contents).toBe(DEFAULT_GITCONFIG);
  });

  test('copies the host .gitconfig byte-for-byte when one exists', async () => {
    const sentinel = '[user]\n\tname = Alice Example\n\temail = alice@example.test\n[alias]\n\tst = status\n';
    await writeFile(join(fakeHome, '.gitconfig'), sentinel);

    const result = await setupSandbox(worktree);

    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');
    expect(contents).toBe(sentinel);
  });
});
