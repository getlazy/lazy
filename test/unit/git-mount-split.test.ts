/**
 * Split `.git` bind mount for agent containers.
 *
 * The containment boundary for agent containers is the kernel mount table, not
 * prompts or tool shims: the repository's shared git dir is mounted read-only,
 * and only `objects` (append-only, content-addressed) plus THIS task's own
 * per-worktree gitdir are writable. These tests pin the mount specs that
 * enforce it. The live FAIL/WORK matrix against a real container lives in
 * `scripts/verify-container-git-containment.sh` (needs Docker/Podman).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  resolveGitMountPaths,
  buildGitMountArgs,
  type GitMountPaths,
} from '../../src/capture/git-mounts';
import { buildDockerArgs } from '../../src/capture/claude';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  }
}

describe('resolveGitMountPaths', () => {
  let root: string;
  let repo: string;
  let worktree: string;

  beforeAll(async () => {
    // realpath, because these tests compare git's answers against paths we
    // compose ourselves. `git rev-parse --path-format=absolute` reports paths
    // rooted at the process's real cwd, with every symlink already resolved —
    // so on a host whose temp dir is reached through one, a hand-composed
    // `join(repo, '.git')` names the same directory by a spelling git will
    // never print. macOS is exactly that host: `tmpdir()` is `/var/folders/…`
    // and `/var` is a symlink to `/private/var`, so the comparison failed there
    // while passing in Linux containers, where `/tmp` is a real directory.
    // Resolving once here keeps the assertions about mount SPLIT rather than
    // about path spelling.
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-git-mounts-')));
    repo = join(root, 'repo');
    worktree = join(root, 'wt');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'file.txt'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'worktree', 'add', '-b', 'task', worktree, 'main');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('resolves the common dir, objects dir and this worktree gitdir', async () => {
    const paths = await resolveGitMountPaths(worktree);

    // The common dir is the MAIN repo's .git — shared refs/config/hooks live here.
    expect(paths.commonDir).toBe(join(repo, '.git'));
    expect(paths.objectsDir).toBe(join(repo, '.git', 'objects'));

    // INVARIANT: the writable gitdir is this worktree's own entry, never the
    // whole `worktrees/` directory — a sibling task's index/HEAD must not be
    // reachable for writing from inside this container.
    expect(paths.worktreeGitDir.startsWith(join(repo, '.git', 'worktrees') + '/')).toBe(true);
    expect(paths.worktreeGitDir).not.toBe(join(repo, '.git', 'worktrees'));
  });

  test('refuses a main checkout, where refs and the index share one directory', async () => {
    // INVARIANT: agent containers require a linked worktree. In a main checkout
    // HEAD/index sit alongside refs/, so there is no mount split that keeps the
    // index writable while refs stay read-only — fail loudly instead of silently
    // handing the agent a writable refs/.
    await expect(resolveGitMountPaths(repo)).rejects.toThrow(/main checkout/);
  });

  test('reports git failures instead of guessing paths', async () => {
    const notARepo = join(root, 'not-a-repo');
    await mkdir(notARepo, { recursive: true });
    await expect(resolveGitMountPaths(notARepo)).rejects.toThrow(/Failed to resolve git directories/);
  });
});

describe('buildGitMountArgs', () => {
  const PATHS: GitMountPaths = {
    commonDir: '/repo/.git',
    objectsDir: '/repo/.git/objects',
    worktreeGitDir: '/repo/.git/worktrees/task-a',
  };

  test('mounts the common dir read-only with exactly two writable carve-outs', () => {
    const args = buildGitMountArgs(PATHS);

    // INVARIANT: refs/, packed-refs, config, hooks/ and logs/refs/ are covered
    // ONLY by this :ro mount. Making any of them writable re-enables in-container
    // ref moves, history rewrites and `core.hooksPath` escapes — the exact
    // failures this task exists to prevent.
    expect(args).toContain('/repo/.git:/repo/.git:ro');

    // Carve-out 1: objects is content-addressed and append-only — writing here
    // can add unreferenced objects but cannot move anything.
    expect(args).toContain('/repo/.git/objects:/repo/.git/objects');

    // Carve-out 2: this worktree's gitdir only (index, HEAD, MERGE_HEAD), never
    // the parent `worktrees/` directory.
    expect(args).toContain('/repo/.git/worktrees/task-a:/repo/.git/worktrees/task-a');
    expect(args).not.toContain('/repo/.git/worktrees:/repo/.git/worktrees');

    // Exactly three mounts, nothing else.
    expect(args.filter(a => a === '-v')).toHaveLength(3);
  });

  test('no writable mount covers refs, config, hooks or the worktrees dir', () => {
    const writable = buildGitMountArgs(PATHS)
      .filter(a => a !== '-v')
      .filter(a => !a.endsWith(':ro'))
      .map(a => a.split(':')[1]!);

    for (const spec of writable) {
      // INVARIANT: enumerated rather than pattern-matched so that adding a new
      // writable mount forces a deliberate decision here.
      expect(['/repo/.git/objects', '/repo/.git/worktrees/task-a']).toContain(spec);
    }
  });
});

describe('buildDockerArgs', () => {
  const sandbox = { worktreePath: '/wt/task-a', sandboxPath: '/wt/task-a/.lazy-task-sandbox' };
  const gitMounts = buildGitMountArgs({
    commonDir: '/repo/.git',
    objectsDir: '/repo/.git/objects',
    worktreeGitDir: '/repo/.git/worktrees/task-a',
  });

  test('carries the split .git mount into the container command line', () => {
    const args = buildDockerArgs(sandbox, ['claude'], '/bin/lazy-agent', 'img', 'docker', undefined, [], gitMounts);

    expect(args).toContain('/repo/.git:/repo/.git:ro');
    expect(args).toContain('/repo/.git/objects:/repo/.git/objects');
    expect(args).toContain('/repo/.git/worktrees/task-a:/repo/.git/worktrees/task-a');
  });

  test('never mounts a repo .git read-write', () => {
    const args = buildDockerArgs(sandbox, ['claude'], '/bin/lazy-agent', 'img', 'docker', undefined, [], gitMounts);

    // INVARIANT: this is the regression this task fixes. The old arg vector had
    // `-v <repo>/.git:<repo>/.git` (read-write), which made the read-only repo
    // mount cosmetic — an agent could move any ref, including main.
    const bareGitRw = args.filter(a => /(^|:)[^:]*\.git:[^:]*\.git$/.test(a));
    expect(bareGitRw).toEqual([]);
  });

  test('is identical for podman — same code path, same mount semantics', () => {
    const dockerArgs = buildDockerArgs(sandbox, ['claude'], '/bin/lazy-agent', 'img', 'docker', undefined, [], gitMounts);
    const podmanArgs = buildDockerArgs(sandbox, ['claude'], '/bin/lazy-agent', 'img', 'podman', undefined, [], gitMounts);

    expect(podmanArgs.slice(1)).toEqual(dockerArgs.slice(1));
    expect(podmanArgs[0]).toBe('podman');
  });
});
