import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureTaskWorktree } from '../../src/daemon/task-worktree';
import { resolveTaskDiffContext } from '../../src/daemon/task-diff-context';
import { recoverMissingWorktree, recoverMissingWorktreeWithFetch } from '../../src/git/operations';
import { getWorktreePath } from '../../src/task/identity';
import { branchTarget } from '../../src/task-target';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';
import { spawn } from '../../src/utils/spawn';
import { pathExists } from '../../src/utils/fs';

let root: string;
let task: Task;
let worktree: string;

function git(argv: string[], cwd = root) {
  const result = Bun.spawnSync(['git', ...argv], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'task-worktree-recovery-')));
  git(['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'tracked.txt'), 'saved work\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  await writeFile(join(root, 'lazy.toml'), '[remote]\ngit_remote = "origin"\n');
  task = { id: 'recover-task-id', status: 'blocked', target: branchTarget('main'), metadata: { task_ref: 'recover-task' } } as unknown as Task;
  worktree = getWorktreePath(root, task);
  git(['worktree', 'add', '-qb', 'lazy/recover-task', worktree]);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('automatic task worktree recovery', () => {
  test('preserves an existing worktree and its uncommitted files', async () => {
    await writeFile(join(worktree, 'tracked.txt'), 'local edit\n');
    expect(await ensureTaskWorktree(root, task, 'missing-branch')).toBe(worktree);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('local edit\n');
  });

  test('restores a deleted checkout without starting or changing the task', async () => {
    await rm(worktree, { recursive: true });
    const messages: string[] = [];
    expect(await ensureTaskWorktree(root, task, 'lazy/recover-task', message => messages.push(message))).toBe(worktree);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
    expect(task.status).toBe('blocked');
    expect(messages).toEqual(['Restoring task files…']);
    expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe('lazy/recover-task');
  });

  test('coalesces concurrent recovery requests', async () => {
    await rm(worktree, { recursive: true });
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureTaskWorktree(root, task, 'lazy/recover-task')));
    expect(results).toEqual(Array(5).fill(worktree));
  });

  test('coordinates terminal, local lifecycle and fetch-capable recovery through the same primitive', async () => {
    await rm(worktree, { recursive: true });
    const results = await Promise.all([
      ensureTaskWorktree(root, task, 'lazy/recover-task'),
      recoverMissingWorktree(worktree, 'lazy/recover-task', root),
      recoverMissingWorktreeWithFetch(worktree, 'lazy/recover-task', 'origin', root),
    ]);
    expect(results[0]).toBe(worktree);
    expect(results[1]).toEqual({ recovered: true, branchExists: true, dirty: false });
    expect(results[2]).toEqual({ recovered: true, branchExists: true, dirty: false });
  });

  async function withGitWrapper(body: string, action: (env: Record<string, string | undefined>) => Promise<void>) {
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('git is required');
    const bin = join(root, 'git-wrapper-bin');
    await mkdir(bin);
    const wrapper = join(bin, 'git');
    // lazy prefixes every git it runs with `-c core.hooksPath=/dev/null`
    // (src/utils/git.ts). The wrapper strips that prefix so `body` can match on
    // the subcommand, and `real_git` puts it back for the real invocation.
    const hooksOffGit = join(bin, 'real-git-hooks-off');
    await writeFile(hooksOffGit, `#!/bin/sh\nexec ${JSON.stringify(realGit)} -c core.hooksPath=/dev/null "$@"\n`);
    await chmod(hooksOffGit, 0o755);
    await writeFile(wrapper, `#!/bin/sh\nreal_git=${JSON.stringify(realGit)}\nif [ "$1" = -c ] && [ "$2" = core.hooksPath=/dev/null ]; then shift 2; real_git=${JSON.stringify(hooksOffGit)}; fi\n${body}\nexec "$real_git" "$@"\n`);
    await chmod(wrapper, 0o755);
    await action({ ...process.env, PATH: `${bin}:${process.env.PATH}` });
  }

  async function runRecoveryProcess(script: string, env: Record<string, string | undefined>) {
    const child = spawn(['bun', '-e', script], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
  }

  test('a terminal waits for a diff recovery already filling an existing checkout directory', async () => {
    await rm(worktree, { recursive: true });
    const started = join(root, 'recovery-started');
    const finished = join(root, 'recovery-finished');
    await withGitWrapper(`if [ "$1" = worktree ] && [ "$2" = add ]; then
  "$real_git" "$@" || exit $?
  touch ${JSON.stringify(started)}
  sleep 0.1
  touch ${JSON.stringify(finished)}
  exit 0
fi`, async env => {
      const operations = join(import.meta.dir, '../../src/git/operations.ts');
      const taskWorktree = join(import.meta.dir, '../../src/daemon/task-worktree.ts');
      await runRecoveryProcess(`
import assert from 'node:assert/strict';
import { recoverMissingWorktreeWithFetch } from ${JSON.stringify(operations)};
import { ensureTaskWorktree } from ${JSON.stringify(taskWorktree)};
const recovery = recoverMissingWorktreeWithFetch(${JSON.stringify(worktree)}, 'lazy/recover-task', 'origin', ${JSON.stringify(root)});
try {
  for (let attempts = 0; attempts < 500 && !await Bun.file(${JSON.stringify(started)}).exists(); attempts++) await Bun.sleep(2);
  assert(await Bun.file(${JSON.stringify(started)}).exists());
  assert.equal(await ensureTaskWorktree(${JSON.stringify(root)}, ${JSON.stringify(task)}, 'lazy/recover-task'), ${JSON.stringify(worktree)});
  assert(await Bun.file(${JSON.stringify(finished)}).exists());
} finally { await recovery; }
`, env);
      expect(await pathExists(finished)).toBe(true);
    });
  });

  test('validates a competing checkout after git worktree add loses the race', async () => {
    await rm(worktree, { recursive: true });
    const competing = join(root, 'competing-recovery');
    await withGitWrapper(`if [ "$1" = worktree ] && [ "$2" = add ]; then
  "$real_git" "$@" || exit $?
  touch ${JSON.stringify(competing)}
  echo 'another recovery created this checkout' >&2
  exit 1
fi`, async env => {
      const operations = join(import.meta.dir, '../../src/git/operations.ts');
      await runRecoveryProcess(`
import assert from 'node:assert/strict';
import { recoverMissingWorktree } from ${JSON.stringify(operations)};
assert.deepEqual(await recoverMissingWorktree(${JSON.stringify(worktree)}, 'lazy/recover-task', ${JSON.stringify(root)}), { recovered: true, branchExists: true, dirty: false });
`, env);
      expect(await pathExists(competing)).toBe(true);
      expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe('lazy/recover-task');
    });
  });

  test.each([false, true])('a diff and terminal restore the same checkout concurrently (remote-only: %s)', async remoteOnly => {
    if (remoteOnly) {
      const origin = join(root, 'origin.git');
      git(['init', '--bare', '-q', origin]);
      git(['remote', 'add', 'origin', origin]);
      git(['push', '-q', 'origin', 'lazy/recover-task']);
      git(['worktree', 'remove', worktree]);
      git(['branch', '-D', 'lazy/recover-task']);
    } else {
      await rm(worktree, { recursive: true });
    }
    const session = { id: 'recovered-session', git_branch: 'lazy/recover-task' };
    const storage = {
      resolveTask: async () => ({ task }),
      getSessionByTaskId: async () => session,
      getChildTasks: async () => [],
    } as unknown as Storage;
    const [diff, terminal] = await Promise.all([
      resolveTaskDiffContext(storage, root, task.id),
      ensureTaskWorktree(root, task, session.git_branch),
    ]);
    expect(diff.worktreePath).toBe(worktree);
    expect(terminal).toBe(worktree);
    expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe(session.git_branch);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
  });

  test('independent processes accept a competing recovery only after checking its repository and branch', async () => {
    const origin = join(root, 'origin.git');
    git(['init', '--bare', '-q', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-q', 'origin', 'lazy/recover-task']);
    git(['worktree', 'remove', worktree]);
    git(['branch', '-D', 'lazy/recover-task']);
    const modulePath = join(import.meta.dir, '../../src/git/operations.ts');
    const script = `import { recoverMissingWorktreeWithFetch } from ${JSON.stringify(modulePath)}; const result = await recoverMissingWorktreeWithFetch(${JSON.stringify(worktree)}, 'lazy/recover-task', 'origin', ${JSON.stringify(root)}); if (!result.recovered) throw new Error('Recovery failed');`;
    const processes = Array.from({ length: 3 }, () => spawn(['bun', '-e', script], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    }));
    for (const process of processes) {
      const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
      if (exitCode !== 0) throw new Error(stderr);
    }
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
    expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe('lazy/recover-task');
  });

  test('a valid competing checkout keeps its uncommitted edits', async () => {
    await writeFile(join(worktree, 'tracked.txt'), 'keep this edit\n');
    expect(await recoverMissingWorktree(worktree, 'lazy/recover-task', root)).toEqual({ recovered: true, branchExists: true, dirty: true });
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('keep this edit\n');
  });

  test('a detached checkout recovered from a commit remains idempotent', async () => {
    const commit = git(['rev-parse', 'HEAD']);
    git(['worktree', 'remove', worktree]);
    const expected = { recovered: true, branchExists: true, dirty: false };
    expect(await recoverMissingWorktree(worktree, commit, root)).toEqual(expected);
    expect(await recoverMissingWorktree(worktree, commit, root)).toEqual(expected);
    expect(git(['rev-parse', 'HEAD'], worktree)).toBe(commit);
  });

  test('does not treat an existing checkout of another branch as successful recovery', async () => {
    git(['checkout', '-qb', 'other/task'], worktree);
    await expect(recoverMissingWorktree(worktree, 'lazy/recover-task', root)).rejects.toThrow('does not match branch');
    expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe('other/task');
  });

  test('does not treat an unrelated directory as successful recovery', async () => {
    await rm(worktree, { recursive: true });
    await mkdir(worktree);
    await writeFile(join(worktree, 'do-not-replace.txt'), 'unrelated files\n');
    await expect(recoverMissingWorktree(worktree, 'lazy/recover-task', root)).rejects.toThrow('not a git worktree');
    expect(await readFile(join(worktree, 'do-not-replace.txt'), 'utf8')).toBe('unrelated files\n');
  });

  test('refuses redirected git pointers instead of accepting an apparent recovery', async () => {
    await writeFile(join(worktree, '.git'), 'gitdir: /outside\n');
    await expect(recoverMissingWorktreeWithFetch(worktree, 'lazy/recover-task', 'origin', root)).rejects.toThrow();
    expect(await readFile(join(worktree, '.git'), 'utf8')).toBe('gitdir: /outside\n');
  });

  test('fetches the recorded branch after store adoption into a fresh clone', async () => {
    const origin = join(root, 'origin.git');
    git(['init', '--bare', '-q', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-q', 'origin', 'lazy/recover-task']);
    git(['worktree', 'remove', worktree]);
    git(['branch', '-D', 'lazy/recover-task']);
    git(['update-ref', '-d', 'refs/remotes/origin/lazy/recover-task']);
    await ensureTaskWorktree(root, task, 'lazy/recover-task');
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
    expect(git(['symbolic-ref', '--short', 'HEAD'], worktree)).toBe('lazy/recover-task');
  });

  test('reports a genuinely unavailable branch and permits a later retry', async () => {
    await rm(worktree, { recursive: true });
    await expect(ensureTaskWorktree(root, task, 'lost-branch')).rejects.toThrow("branch 'lost-branch' is not available");
    await ensureTaskWorktree(root, task, 'lazy/recover-task');
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
  });

  test('does not fetch in offline mode', async () => {
    await rm(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[remote]\noffline = true\n');
    await expect(ensureTaskWorktree(root, task, 'lost-branch')).rejects.toThrow('offline mode is enabled');
  });

  test('honors the temporary project offline toggle', async () => {
    await rm(worktree, { recursive: true });
    await writeFile(join(root, '.lazy', 'offline.json'), JSON.stringify({ enabled: true }));
    await expect(ensureTaskWorktree(root, task, 'lost-branch')).rejects.toThrow('offline mode is enabled');
    await ensureTaskWorktree(root, task, 'lazy/recover-task');
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('saved work\n');
  });
});
