/**
 * INVARIANT: inside a task container, `<worktree>/.git`, `<gitdir>/commondir`
 * and `<gitdir>/gitdir` cannot be rewritten, replaced or removed — they are
 * read-only copies bind-mounted over the originals — while git in the
 * container keeps working (status, add, diff, checkout). A container that
 * could rewrite them would get the next git OUTSIDE it (lazy's, or the
 * human's) to run its code; see src/git/worktree-pointers.ts.
 *
 * Needs a reachable docker (or podman via LAZY_TEST_CONTAINER_BINARY) and an
 * image with git and sh (LAZY_TEST_GIT_IMAGE, default `lazy-runner:latest`).
 * Skipped — loudly — without them: a skip is never a pass.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTaskGitMounts } from '../../src/capture/git-mounts';

const binary = process.env.LAZY_TEST_CONTAINER_BINARY ?? 'docker';
const image = process.env.LAZY_TEST_GIT_IMAGE ?? 'lazy-runner:latest';

function available(): boolean {
  try {
    const info = Bun.spawnSync([binary, 'image', 'inspect', image], { stdout: 'ignore', stderr: 'ignore' });
    return info.exitCode === 0;
  } catch {
    // ENOENT: no container binary at all — the skip line below says so.
    return false;
  }
}

const skip = !available();
if (skip) console.log(`[skip] test/e2e/task-container-git-pointers.test.ts: no ${binary} with image ${image}`);

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

describe.skipIf(skip)('task container git pointers', () => {
  let base: string;
  let repo: string;
  let worktree: string;
  let gitdir: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ctr-pointers-')));
    repo = join(base, 'repo');
    await mkdir(repo);
    git(['init', '-q', '-b', 'main'], repo);
    await writeFile(join(repo, 'f.txt'), 'hello\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    worktree = join(repo, '.lazy', 'worktrees', 'ctr-task');
    git(['worktree', 'add', '-q', '-b', 'lazy/ctr-task', worktree], repo);
    gitdir = join(repo, '.git', 'worktrees', 'ctr-task');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('cannot be rewritten from inside, and git still works', async () => {
    const before = await Promise.all([join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir')].map((p) => readFile(p, 'utf-8')));
    const { args } = await buildTaskGitMounts(repo, worktree);
    const script = [
      'G="git -c safe.directory=*"',
      `for f in "${worktree}/.git" "${gitdir}/commondir" "${gitdir}/gitdir"; do`,
      '  (echo evil > "$f") 2>/dev/null && echo "WROTE $f"',
      '  mv "$f" "$f.x" 2>/dev/null && echo "MOVED $f"',
      '  rm -f "$f" 2>/dev/null; [ -e "$f" ] || echo "REMOVED $f"',
      'done',
      'echo change >> f.txt',
      '$G status --porcelain || echo "GITFAIL status"',
      '$G add f.txt || echo "GITFAIL add"',
      '$G diff --cached --stat || echo "GITFAIL diff"',
      '$G reset -q f.txt || echo "GITFAIL reset"',
      '$G checkout -- f.txt || echo "GITFAIL checkout"',
      'echo DONE',
    ].join('\n');
    const r = Bun.spawnSync([
      binary, 'run', '--rm', '--entrypoint', 'sh',
      '-v', `${repo}:${repo}:ro`, '-v', `${worktree}:${worktree}`, ...args,
      '-w', worktree, image, '-c', script,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const out = r.stdout.toString();
    expect(out).toContain('DONE');
    expect(out).not.toMatch(/WROTE|MOVED|REMOVED|GITFAIL/);
    const after = await Promise.all([join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir')].map((p) => readFile(p, 'utf-8')));
    expect(after).toEqual(before);
  }, 120_000);
});
