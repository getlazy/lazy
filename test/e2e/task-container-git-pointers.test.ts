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
import { hardwareTestEnv } from '../helpers/hardware-env';
import { buildTaskGitMounts } from '../../src/capture/git-mounts';

const binary = process.env.LAZY_TEST_CONTAINER_BINARY ?? 'docker';
const image = process.env.LAZY_TEST_GIT_IMAGE ?? 'lazy-runner:latest';

function available(): boolean {
  try {
    const info = Bun.spawnSync([binary, 'image', 'inspect', image], { env: hardwareTestEnv(), stdout: 'ignore', stderr: 'ignore' });
    return info.exitCode === 0;
  } catch {
    // ENOENT: no container binary at all — the skip line below says so.
    return false;
  }
}

const skip = !available();
if (skip) console.log(`[skip] test/e2e/task-container-git-pointers.test.ts: no ${binary} with image ${image}`);

const env = hardwareTestEnv({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
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
  }, 120_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  }, 120_000);

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
    ], { env, stdout: 'pipe', stderr: 'pipe' });
    const out = r.stdout.toString();
    expect(out).toContain('DONE');
    expect(out).not.toMatch(/WROTE|MOVED|REMOVED|GITFAIL/);
    const after = await Promise.all([join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir')].map((p) => readFile(p, 'utf-8')));
    expect(after).toEqual(before);
  }, 120_000);

  test('pointer reads and git stay valid during concurrent launch preparation', async () => {
    const { args } = await buildTaskGitMounts(repo, worktree);
    const probe = await mkdtemp(join(worktree, '.pointer-probe-'));
    const pointers = [join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir')];
    for (const [index, pointer] of pointers.entries()) {
      await writeFile(join(probe, 'expected-' + index), await readFile(pointer, 'utf-8'));
    }
    const script = [
      'exec 2> "' + probe + '/errors"',
      "trap 'printf \"%s\\n\" \"$?\" > \"" + probe + "/exit-code\"' 0",
      'while [ ! -f "' + probe + '/stop" ]; do',
      ...pointers.flatMap((pointer, index) => [
        '[ -f "' + pointer + '" ] && [ ! -L "' + pointer + '" ] || { echo "MISSING ' + pointer + '" >&2; exit 1; }',
        'actual=$(cat "' + pointer + '") || exit 1',
        'expected=$(cat "' + probe + '/expected-' + index + '") || exit 1',
        '[ "$actual" = "$expected" ] || { echo "CHANGED ' + pointer + '" >&2; exit 1; }',
      ]),
      'git -c safe.directory="*" status --porcelain > /dev/null || exit 1',
      'printf "." >> "' + probe + '/checks"',
      'printf "ready" > "' + probe + '/ready"',
      'done',
    ].join('\n');
    const started = Bun.spawnSync([
      binary, 'run', '-d', '--rm', '--entrypoint', 'sh',
      '-v', repo + ':' + repo + ':ro', '-v', worktree + ':' + worktree, ...args,
      '-w', worktree, image, '-c', script,
    ], { env, stdout: 'pipe', stderr: 'pipe' });
    const container = started.stdout.toString().trim();
    const waitFor = async (name: string): Promise<string> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const content = await readFile(join(probe, name), 'utf-8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (content !== null && content.length > 0) return content;
        const errors = await readFile(join(probe, 'errors'), 'utf-8').catch(() => '');
        if (errors) throw new Error('container pointer probe failed: ' + errors);
        await Bun.sleep(20);
      }
      throw new Error('container pointer probe did not produce ' + name);
    };
    try {
      expect(started.stderr.toString()).toBe('');
      expect(started.exitCode).toBe(0);
      await waitFor('ready');
      const before = (await readFile(join(probe, 'checks'), 'utf-8')).length;
      for (let launch = 0; launch < 100; launch++) {
        await Promise.all(Array.from({ length: 4 }, () => buildTaskGitMounts(repo, worktree)));
      }
      const after = (await readFile(join(probe, 'checks'), 'utf-8')).length;
      expect(after).toBeGreaterThan(before);
      await writeFile(join(probe, 'stop'), 'stop');
      expect((await waitFor('exit-code')).trim()).toBe('0');
      expect(await readFile(join(probe, 'errors'), 'utf-8')).toBe('');
      for (const [index, pointer] of pointers.entries()) {
        expect(await readFile(pointer, 'utf-8')).toBe(await readFile(join(probe, 'expected-' + index), 'utf-8'));
      }
    } finally {
      if (container) Bun.spawnSync([binary, 'stop', '-t', '0', container], { env: hardwareTestEnv(), stdout: 'ignore', stderr: 'ignore' });
      await rm(probe, { recursive: true, force: true });
    }
  }, 120_000);

});
