/**
 * Unit tests for setupSandbox — the shared helper every supervisor-launching
 * code path depends on (start, resume, sync, unblock, auto-resume, auto-unblock).
 *
 * Exercises the real helper against a tmpdir filesystem, no mocks. The four
 * cases pin the behaviors that used to be open-coded in four separate call
 * sites before fix-sync-sandbox-setup consolidated them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { setupSandbox, SANDBOX_DIR } from '../../src/utils/sandbox';
import { runGit } from '../../src/utils/git';

const DEFAULT_GITCONFIG = '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n';
/**
 * Appended to every sandbox gitconfig by setupSandbox. The agent container sees
 * the repository's shared git dir read-only (see src/capture/git-mounts.ts), so
 * an auto-gc triggered in there could only fail — it wants to repack objects and
 * rewrite packed-refs. Disabling it keeps that failure from surfacing as a
 * confusing error on an unrelated git command.
 */
const GC_OFF = '\n[gc]\n\tauto = 0\n';

/**
 * The `[safe]` stanza setupSandbox appends. Format duplicated here on purpose so
 * a silent change to the emitted syntax fails a test rather than shipping a
 * gitconfig the container's git parses differently than intended.
 */
function safeStanza(...paths: string[]): string {
  return '\n[safe]\n' + paths.map(p => `\tdirectory = "${p}"\n`).join('');
}

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
    expect(contents).toBe(DEFAULT_GITCONFIG + GC_OFF + safeStanza(worktree));
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
    expect(contents).toBe(DEFAULT_GITCONFIG + GC_OFF + safeStanza(worktree));
  });

  test('writes default gitconfig when host has no .gitconfig', async () => {
    // fakeHome was just mkdtemp'd; it contains no .gitconfig.
    const result = await setupSandbox(worktree);

    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');
    expect(contents).toBe(DEFAULT_GITCONFIG + GC_OFF + safeStanza(worktree));
  });

  test('preserves the host .gitconfig verbatim, appending only the lazy stanzas', async () => {
    const sentinel = '[user]\n\tname = Alice Example\n\temail = alice@example.test\n[alias]\n\tst = status\n';
    await writeFile(join(fakeHome, '.gitconfig'), sentinel);

    const result = await setupSandbox(worktree);

    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');
    // INVARIANT: the host's config is copied byte-for-byte — lazy never edits,
    // reorders or drops the user's own git settings. The only additions are the
    // appended gc.auto=0 and safe.directory stanzas.
    expect(contents).toBe(sentinel + GC_OFF + safeStanza(worktree));
  });
});

/**
 * INVARIANT (fix-dubious-ownership-merge): the sandbox gitconfig must vouch for
 * the worktree AND both git dirs lazy bind-mounts into the agent container.
 *
 * The container runs as its own uid against a worktree the host user owns, so
 * git's ownership check refuses the repository — `fatal: detected dubious
 * ownership in repository at ...` — and every git command in that worktree dies,
 * not just the merge phase where it was first reported. Docker Desktop for macOS
 * mounts binds as `fakeowner` (stat reports the caller's uid), which made the
 * check vacuous and hid this; podman, Colima and Linux hosts whose uid is not the
 * image's do not fake it.
 *
 * The scope is the point: exactly the paths lazy created and mounted (see
 * src/capture/git-mounts.ts), never `*`. If a future change widens this to `*`,
 * or drops the git-dir entries, these tests fail.
 */
describe('setupSandbox safe.directory scope', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let fakeHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    // realpath: git prints resolved paths, and on macOS tmpdir() is a symlink
    // (/var -> /private/var), so a hand-composed path never matches git's spelling.
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-safe-dir-')));
    repo = join(root, 'repo');
    worktree = join(root, 'wt');
    fakeHome = join(root, 'home');
    await mkdir(repo, { recursive: true });
    await mkdir(fakeHome, { recursive: true });

    await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
    await runGit(['config', 'user.name', 'Test'], { cwd: repo });
    await runGit(['config', 'user.email', 'test@example.test'], { cwd: repo });
    await writeFile(join(repo, 'f.txt'), 'hello\n');
    await runGit(['add', 'f.txt'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: repo });
    await runGit(['worktree', 'add', '-q', '-b', 'task', worktree], { cwd: repo });

    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  });

  test('trusts the worktree, the common git dir and this worktree gitdir — and nothing else', async () => {
    const result = await setupSandbox(worktree);
    const contents = await readFile(join(result.sandboxPath, '.gitconfig'), 'utf-8');

    const commonDir = join(repo, '.git');
    const worktreeGitDir = join(commonDir, 'worktrees', 'wt');

    expect(contents).toContain(`\tdirectory = "${worktree}"\n`);
    expect(contents).toContain(`\tdirectory = "${commonDir}"\n`);
    expect(contents).toContain(`\tdirectory = "${worktreeGitDir}"\n`);

    // Never blanket trust: `*` disarms the check for every repository the
    // container can see, including any the human mounts in themselves.
    expect(contents).not.toContain('directory = "*"');
    expect(contents).not.toContain('directory = *');
    // Exactly three entries — no accidental widening to a parent directory.
    expect(contents.match(/\n\tdirectory = /g)?.length).toBe(3);
  });

  test('git actually parses the stanza and reports the trusted paths', async () => {
    // Reading it back through git is the only honest proof the emitted syntax is
    // what git understands — a hand-checked string could be quoted wrong and the
    // container would still refuse the repo.
    const result = await setupSandbox(worktree);
    const read = await runGit(['config', '--file', join(result.sandboxPath, '.gitconfig'), '--get-all', 'safe.directory']);

    expect(read.exitCode).toBe(0);
    const values = read.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    expect(values).toContain(worktree);
    expect(values).toContain(join(repo, '.git'));
    expect(values).toContain(join(repo, '.git', 'worktrees', 'wt'));
  });

  test('quotes paths so a `#` or trailing space in a path survives git config parsing', async () => {
    const oddWorktree = join(root, 'odd # name ');
    await runGit(['worktree', 'add', '-q', '-b', 'odd', oddWorktree], { cwd: repo });

    const result = await setupSandbox(oddWorktree);
    const read = await runGit(['config', '--file', join(result.sandboxPath, '.gitconfig'), '--get-all', 'safe.directory']);

    expect(read.exitCode).toBe(0);
    // Unquoted, git would truncate at the `#` and strip the trailing space,
    // leaving an entry that never matches the real path.
    expect(read.stdout.split('\n')).toContain(oddWorktree);
  });
});
