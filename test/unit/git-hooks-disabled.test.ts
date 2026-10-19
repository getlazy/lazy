/**
 * Lazy's own merges and commits never run repository hooks (src/utils/git.ts).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runGit, withHooksDisabled } from '../../src/utils/git';

describe('daemon-side git never runs repository hooks', () => {
  let dir: string | null = null;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

  test('every git command gets hooks disabled', () => {
    for (const args of [['commit', '-m', 'x'], ['add', '.'], ['push', 'origin', 'main'], ['worktree', 'add', 'p', 'b']]) {
      expect(withHooksDisabled(args)).toEqual(['-c', 'core.hooksPath=/dev/null', ...args]);
    }
  });

  // INVARIANT: a core.hooksPath pointing into the tracked tree never runs a
  // hook when lazy commits or merges. A task branch can write that tree, and
  // accept's squash runs on the host — a hook there is host code execution.
  test('a tracked-tree hooksPath hook never runs: add, commit, merge, ref update, worktree add, push', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-hooks-'));
    const marker = join(dir, 'HOOK_RAN');
    const g = (...a: string[]) => runGit(a, { cwd: dir!, env: { GIT_AUTHOR_EMAIL: 't@e', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_COMMITTER_NAME: 't' } });
    await g('init', '-q', '-b', 'main');
    await mkdir(join(dir, 'hooks'));
    for (const h of ['pre-commit', 'post-commit', 'post-merge', 'pre-merge-commit', 'post-index-change', 'reference-transaction', 'post-checkout', 'pre-push']) {
      await writeFile(join(dir, 'hooks', h), `#!/bin/sh\necho ${h} >> "${marker}"\n`);
      await chmod(join(dir, 'hooks', h), 0o755);
    }
    await g('config', 'core.hooksPath', 'hooks');
    await writeFile(join(dir, 'a'), '1');
    await g('add', '.');
    expect((await g('commit', '-q', '-m', 'one')).exitCode).toBe(0);
    await g('checkout', '-q', '-b', 'side');
    await writeFile(join(dir, 'b'), '2');
    await g('add', 'b');
    await g('commit', '-q', '-m', 'two');
    await g('checkout', '-q', 'main');
    expect((await g('merge', '--no-ff', '-m', 'm', 'side')).exitCode).toBe(0);
    expect((await g('update-ref', 'refs/heads/other', 'HEAD')).exitCode).toBe(0);
    expect((await g('worktree', 'add', '-q', join(dir, 'wt'), 'other')).exitCode).toBe(0);
    await g('init', '-q', '--bare', join(dir, 'remote.git'));
    expect((await g('push', '-q', join(dir, 'remote.git'), 'main')).exitCode).toBe(0);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});
