/**
 * Per-task secret files (src/daemon/task-files.ts): intake validation, the
 * registry's no-contents read surface, delivery into a LINKED worktree, and
 * the exclusion + content guards that keep a delivered file out of commits.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, symlink, realpath, lstat, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateTaskFilePath,
  normalizeTaskFiles,
  setTaskFiles,
  listTaskFilePaths,
  clearTaskFiles,
  deliverTaskFiles,
  taskFileBlobs,
  deliveredGuardFor,
  retiredTaskFilePaths,
  MAX_FILES_PER_TASK,
  MAX_FILE_BYTES,
} from '../../src/daemon/task-files';
import { getTaskFilesPath } from '../../src/daemon/paths';
import { redactSecretValues } from '../../src/utils/redact';
import { runGit } from '../../src/utils/git';
import {
  deliveredExcludeFileFor,
  withDeliveredFilesGitConfig,
  gitBlobId,
  excludeLineFor,
} from '../../src/git/delivered-files-exclude';
import {
  findDeliveredFilesStaged,
  findDeliveredFilesAtRef,
  findDeliveredFilesInRange,
  readDeliveredManifest,
} from '../../src/git/delivered-files';

const SECRET = 'API_TOKEN=sk-test-0123456789abcdef-secret\n';

describe('task files: path validation', () => {
  test('accepts plain relative paths', () => {
    expect(validateTaskFilePath('.env')).toBe('.env');
    expect(validateTaskFilePath('config/creds/service.json')).toBe('config/creds/service.json');
  });

  // INVARIANT: a delivered path can never leave the worktree or land in git's
  // or lazy's own state. Delivery writes as the daemon, on the host — a path
  // that escapes is a host file write chosen by whoever set the files.
  test('refuses escapes, absolute paths and git/lazy state', () => {
    const bad: Array<[unknown, RegExp]> = [
      ['', /required/],
      [undefined, /required/],
      ['/etc/passwd', /absolute/],
      ['../outside', /escape/],
      ['a/../../b', /escape/],
      ['a//b', /empty or '\.'/],
      ['./a', /empty or '\.'/],
      ['a/', /empty or '\.'/],
      ['a\\b', /separators/],
      ['.git', /git's own state/],
      ['.git/hooks/pre-commit', /git's own state/],
      ['sub/.git/config', /git's own state/],
      ['.GIT/config', /git's own state/],
      ['.lazy/x', /lazy's own state/],
      ['.lazy-task-sandbox/x', /lazy's own state/],
      ['a\0b', /NUL/],
      // INVARIANT: a control character is refused — a newline would inject
      // lines into the worktree's exclude file (`foo\n*` hides every file).
      ['foo\n*', /control character/],
      ['a\rb', /control character/],
      ['a\tb', /control character/],
      ['a\x7fb', /control character/],
    ];
    for (const [path, re] of bad) expect(() => validateTaskFilePath(path)).toThrow(re);
  });

  test('refuses duplicates, case-only duplicates and nested paths', () => {
    expect(() => normalizeTaskFiles([{ path: '.env', contents: 'a' }, { path: '.env', contents: 'b' }], 't')).toThrow(/given twice/);
    expect(() => normalizeTaskFiles([{ path: '.ENV', contents: 'a' }, { path: '.env', contents: 'b' }], 't')).toThrow(/given twice/);
    expect(() => normalizeTaskFiles([{ path: 'a', contents: 'a' }, { path: 'a/b', contents: 'b' }], 't')).toThrow(/inside the other/);
  });

  test('enforces the caps and the contents shape', () => {
    const many = Array.from({ length: MAX_FILES_PER_TASK + 1 }, (_, i) => ({ path: `f${i}`, contents: 'x' }));
    expect(() => normalizeTaskFiles(many, 't')).toThrow(/limit/);
    expect(() => normalizeTaskFiles([{ path: 'big', contents: 'x'.repeat(MAX_FILE_BYTES + 1) }], 't')).toThrow(/limit/);
    expect(() => normalizeTaskFiles([{ path: 'a' }], 't')).toThrow(/exactly one/);
    expect(() => normalizeTaskFiles([{ path: 'a', contents: 'x', contentsBase64: 'eA==' }], 't')).toThrow(/exactly one/);
    expect(() => normalizeTaskFiles('nope', 't')).toThrow(/array/);
  });
});

describe('task files: delivered-files git config env', () => {
  test('adds, replaces and removes only its own excludesFile entry', () => {
    const base = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' };
    const added = withDeliveredFilesGitConfig(base, '/w/.lazy-task-sandbox/task-files.exclude');
    expect(added.set).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.excludesFile', GIT_CONFIG_VALUE_1: '/w/.lazy-task-sandbox/task-files.exclude',
    });
    const env = { ...base, ...added.set };
    const again = withDeliveredFilesGitConfig(env, '/w/.lazy-task-sandbox/task-files.exclude');
    expect(again.set.GIT_CONFIG_COUNT).toBe('2');
    const removed = withDeliveredFilesGitConfig(env, null);
    expect(removed.set).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' });
    expect(removed.unset).toEqual(['GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']);
    expect(withDeliveredFilesGitConfig({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/w/.lazy-task-sandbox/task-files.exclude' }, null).unset)
      .toContain('GIT_CONFIG_COUNT');
  });

  test('escapes glob specials so the line matches exactly the delivered path', () => {
    expect(excludeLineFor('.env')).toBe('/.env');
    expect(excludeLineFor('a[1]*.txt')).toBe('/a\\[1\\]\\*.txt');
    expect(excludeLineFor('#x')).toBe('/\\#x');
  });
});

/** A project with a LINKED task worktree at the path lazy uses, so runGit treats it as one. */
async function setupProject(base: string) {
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  const git = (args: string[], cwd = root) => runGit(args, { cwd });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@example.com']);
  await git(['config', 'user.name', 'T']);
  await writeFile(join(root, 'tracked.txt'), 'project file\n');
  await git(['add', 'tracked.txt']);
  await git(['commit', '-q', '-m', 'init']);
  const worktree = join(root, '.lazy', 'worktrees', 'task-a');
  const other = join(root, '.lazy', 'worktrees', 'task-b');
  await mkdir(join(root, '.lazy', 'worktrees'), { recursive: true });
  expect((await git(['worktree', 'add', '-q', '-b', 'lazy/task-a', worktree])).exitCode).toBe(0);
  expect((await git(['worktree', 'add', '-q', '-b', 'lazy/task-b', other])).exitCode).toBe(0);
  // What lazy's info/exclude block does for every project (src/git/lazy-exclude.ts).
  await mkdir(join(root, '.git', 'info'), { recursive: true });
  await writeFile(join(root, '.git', 'info', 'exclude'), '.lazy-task-sandbox/\n.lazy/*\n');
  return { root, worktree, other, git };
}

describe('task files: registry and delivery', () => {
  let base: string;
  let prevBaseDir: string | undefined;
  const taskId = '11111111-2222-3333-4444-555555555555';

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-task-files-')));
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon-base');
  });

  afterEach(async () => {
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: the registry lives in the daemon's own dir at 0600, and no read
  // returns contents — only paths. Same rule as per-task env: a surface that
  // cannot see a value cannot print it.
  test('stores outside the project at 0600 and reads back paths only', async () => {
    const { root } = await setupProject(base);
    const paths = await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'k/b.bin', contentsBase64: Buffer.from([0, 1, 2]).toString('base64') }]);
    expect(paths).toEqual(['.env', 'k/b.bin']);
    expect(JSON.stringify(paths)).not.toContain('sk-test');
    const file = getTaskFilesPath(root);
    expect(file.startsWith(process.env.LAZY_DAEMON_BASE_DIR!)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await listTaskFilePaths(root, taskId)).toEqual(['.env', 'k/b.bin']);
    // Contents are scrubbed from free text (logs, turns) while the task holds them.
    expect(redactSecretValues('leaked sk-test-0123456789abcdef-secret here')).not.toContain('sk-test-0123456789abcdef-secret');
    expect(await clearTaskFiles(root, taskId)).toBe(2);
    expect(await listTaskFilePaths(root, taskId)).toEqual([]);
    expect(redactSecretValues('sk-test-0123456789abcdef-secret')).toContain('sk-test-0123456789abcdef-secret');
  });

  test('delivers 0600 files that lazy and a `git add -A` agent never stage, without leaking to other worktrees', async () => {
    const { root, worktree, other, git } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'config/sa.json', contents: '{"key":"private-key-material-xyz"}' }]);
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(d).toEqual({ written: ['.env', 'config/sa.json'], refused: [], retired: [] });
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);
    expect((await stat(join(worktree, '.env'))).mode & 0o777).toBe(0o600);

    // lazy's own git (runGit) in the task worktree: `git add -A` skips them.
    await writeFile(join(worktree, 'work.txt'), 'real work\n');
    expect((await git(['add', '-A'], worktree)).exitCode).toBe(0);
    const staged = (await git(['diff', '--cached', '--name-only'], worktree)).stdout.split('\n');
    expect(staged).toEqual(['work.txt']);
    // The dirty check (accept's, commit-leftovers') does not see them either.
    expect((await git(['status', '--porcelain'], worktree)).stdout).toBe('A  work.txt');

    // An agent's own git, with the env the supervisor gives it.
    const exclude = await deliveredExcludeFileFor(worktree);
    expect(exclude).toBe(join(worktree, '.lazy-task-sandbox/task-files.exclude'));
    const agentEnv = { ...process.env, ...withDeliveredFilesGitConfig(process.env, exclude).set };
    const agentAdd = Bun.spawnSync(['git', 'add', '-A'], { cwd: worktree, env: agentEnv });
    expect(agentAdd.exitCode).toBe(0);
    const agentCommit = Bun.spawnSync(['git', 'commit', '-q', '-am', 'agent commit'], { cwd: worktree, env: agentEnv });
    expect(agentCommit.exitCode).toBe(0);
    const tree = (await git(['ls-tree', '-r', '--name-only', 'HEAD'], worktree)).stdout.split('\n');
    expect(tree).toContain('work.txt');
    expect(tree).not.toContain('.env');
    expect(tree).not.toContain('config/sa.json');

    // INVARIANT: the exclusion is per task. Another task's worktree (and the
    // project root) still sees its own `.env` as ordinary untracked work —
    // which is why this is not written to the shared info/exclude.
    await writeFile(join(other, '.env'), 'their own\n');
    expect((await git(['status', '--porcelain'], other)).stdout).toContain('.env');
  });

  test('a delivered file staged anyway (`git add -f`) is caught by content, in the index and on the branch', async () => {
    const { root, worktree, git } = await setupProject(base);
    const start = (await git(['rev-parse', 'HEAD'], worktree)).stdout;
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    const manifest = await readDeliveredManifest(worktree);
    expect(manifest).toEqual([{ path: '.env', blob: gitBlobId(SECRET) }]);
    expect(await taskFileBlobs(root, taskId)).toEqual(manifest);

    expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesStaged(worktree, manifest)).toEqual(['.env']);
    expect((await git(['commit', '-q', '-m', 'oops'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesAtRef(worktree, 'HEAD', manifest)).toEqual(['.env']);
    // Deleted again: the tip is clean, the history is not.
    expect((await git(['rm', '-q', '--cached', '.env'], worktree)).exitCode).toBe(0);
    expect((await git(['commit', '-q', '-m', 'remove'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesAtRef(worktree, 'HEAD', manifest)).toEqual([]);
    expect(await findDeliveredFilesInRange(worktree, 'HEAD', [`^${start}`], manifest)).toEqual(['.env']);
    // Different content at the same path is not the secret.
    await writeFile(join(worktree, '.env'), 'API_TOKEN=placeholder-for-docs\n');
    expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesStaged(worktree, manifest)).toEqual([]);
  });

  // INVARIANT: a path the branch tracks is never overwritten with a secret —
  // refused per path and reported, so the caller can show it.
  test('refuses a tracked path and leaves the project file alone', async () => {
    const { root, worktree } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: 'tracked.txt', contents: SECRET }, { path: 'tracked.txt.d/x', contents: 'y' }, { path: '.env', contents: SECRET }]);
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(d.written).toEqual(['.env', 'tracked.txt.d/x']);
    expect(d.refused).toEqual([{ path: 'tracked.txt', reason: expect.stringContaining('tracks a file at tracked.txt') }]);
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf-8')).toBe('project file\n');
    expect(JSON.stringify(d)).not.toContain('sk-test');
  });

  test('replaces a symlink planted at the path and refuses a symlinked parent', async () => {
    const { root, worktree } = await setupProject(base);
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'host file\n');
    await symlink(outside, join(worktree, '.env'));
    await mkdir(join(base, 'elsewhere'));
    await symlink(join(base, 'elsewhere'), join(worktree, 'conf'));
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'conf/a.json', contents: '{}' }]);
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(d.written).toEqual(['.env']);
    expect(d.refused.map(r => r.path)).toEqual(['conf/a.json']);
    expect(await readFile(outside, 'utf-8')).toBe('host file\n');
    expect((await lstat(join(worktree, '.env'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);
  });

  // INVARIANT: lazy never deletes a delivered file. A launch repairs an edited
  // file that is still selected; a DESELECTED one is left exactly where it is,
  // still excluded from git, and reported as retired so a person can remove it.
  test('a launch repairs an edited file; a dropped file stays in place, excluded, and is reported', async () => {
    const { root, worktree, git } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'b.txt', contents: 'bbbbbbbbbbbbbbbb' }]);
    await deliverTaskFiles(root, taskId, worktree);
    await writeFile(join(worktree, '.env'), 'clobbered by a merge\n');
    await deliverTaskFiles(root, taskId, worktree);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);

    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(await readFile(join(worktree, 'b.txt'), 'utf-8')).toBe('bbbbbbbbbbbbbbbb');
    expect(d.retired).toEqual(['b.txt']);
    await setTaskFiles(root, taskId, []);
    const cleared = await deliverTaskFiles(root, taskId, worktree);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe(SECRET);
    expect(cleared).toEqual({ written: [], refused: [], retired: ['.env', 'b.txt'] });
    expect(await retiredTaskFilePaths(root, taskId, worktree)).toEqual(['.env', 'b.txt']);
    expect(await deliveredExcludeFileFor(worktree)).not.toBeNull();
    expect((await git(['add', '-A'], worktree)).exitCode).toBe(0);
    expect((await git(['status', '--porcelain'], worktree)).stdout).toBe('');
  });

  // INVARIANT: delivering a file set that has not changed touches NOTHING in the
  // worktree — every delivered file, the exclude list and the manifest keep
  // their inode and mtime. Delivery runs before every turn launch (and once more
  // on every Teams environment push), while the task's services keep running in
  // its container: a dev server watching `.env` restarted on every replace, so
  // each turn restarted the person's app (engineer, 2026-10-20).
  test('an unchanged file set is not rewritten: same inode and mtime for every file it delivers', async () => {
    const { root, worktree } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'config/sa.json', contents: '{"key":"private-key-material-xyz"}' }]);
    await deliverTaskFiles(root, taskId, worktree);
    const watched = ['.env', 'config/sa.json', '.lazy-task-sandbox/task-files.exclude', '.lazy-task-sandbox/task-files.json'];
    const snapshot = async () => Promise.all(watched.map(async (p) => {
      const st = await lstat(join(worktree, p));
      return { p, ino: st.ino, mtimeMs: st.mtimeMs, mode: st.mode };
    }));
    const before = await snapshot();
    // A coarse-mtime filesystem would hide a rewrite inside the same tick.
    await Bun.sleep(20);

    // What every launch does, and what a Teams push of the same set does.
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'config/sa.json', contents: '{"key":"private-key-material-xyz"}' }]);
    const again = await deliverTaskFiles(root, taskId, worktree);
    await deliverTaskFiles(root, taskId, worktree);

    expect(again).toEqual({ written: ['.env', 'config/sa.json'], refused: [], retired: [] });
    expect(await snapshot()).toEqual(before);
  });

  // The other half: a CHANGED file is still written (and only that one), and a
  // secret someone loosened to world-readable is put back to 0600.
  test('a changed file is written; its unchanged sibling is left alone', async () => {
    const { root, worktree } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'b.txt', contents: 'bbbbbbbbbbbbbbbb' }]);
    await deliverTaskFiles(root, taskId, worktree);
    const sibling = await lstat(join(worktree, 'b.txt'));
    const envBefore = await lstat(join(worktree, '.env'));
    await Bun.sleep(20);

    await setTaskFiles(root, taskId, [{ path: '.env', contents: 'API_TOKEN=rotated-0123456789abcdef\n' }, { path: 'b.txt', contents: 'bbbbbbbbbbbbbbbb' }]);
    await deliverTaskFiles(root, taskId, worktree);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe('API_TOKEN=rotated-0123456789abcdef\n');
    expect((await lstat(join(worktree, '.env'))).ino).not.toBe(envBefore.ino);
    const siblingAfter = await lstat(join(worktree, 'b.txt'));
    expect([siblingAfter.ino, siblingAfter.mtimeMs]).toEqual([sibling.ino, sibling.mtimeMs]);

    await chmod(join(worktree, 'b.txt'), 0o644);
    await deliverTaskFiles(root, taskId, worktree);
    expect((await stat(join(worktree, 'b.txt'))).mode & 0o777).toBe(0o600);
  });

  // INVARIANT: a ROOT daemon (a Teams machine) never leaves a delivered secret
  // owned by root in a worktree its container user owns — the 0600 file would be
  // unreadable to the task's running services until the next supervisor
  // adoption. The new file is handed over BEFORE it is renamed into place.
  // Root-only: elsewhere there is nobody to hand it to.
  test.if(process.getuid?.() === 0)('a root daemon writes a changed file already owned by the worktree owner', async () => {
    const { root, worktree } = await setupProject(base);
    await Bun.spawn(['chown', '-R', '1234:1234', worktree]).exited;
    // root's git refuses a worktree another uid owns; a real root daemon trusts
    // its task worktrees through its own config.
    const trust = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
    Object.assign(process.env, trust);
    try {
      await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
      await deliverTaskFiles(root, taskId, worktree);
    } finally {
      for (const k of Object.keys(trust)) delete process.env[k];
    }
    const st = await stat(join(worktree, '.env'));
    expect([st.uid, st.gid, st.mode & 0o777]).toEqual([1234, 1234, 0o600]);
    expect((await stat(join(worktree, '.lazy-task-sandbox/task-files.exclude'))).uid).toBe(1234);
  });

  // INVARIANT: a retired file stays in the worktree where the agent can read
  // it, so its content stays scrubbed from logs and turns until the task ends.
  test('a deselected file stays scrubbed until the task is forgotten', async () => {
    const { forgetTaskFiles } = await import('../../src/daemon/task-files');
    const { root, worktree } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    await setTaskFiles(root, taskId, []);
    expect(redactSecretValues('x sk-test-0123456789abcdef-secret y')).not.toContain('sk-test-0123456789abcdef-secret');
    await forgetTaskFiles(root, taskId);
    expect(redactSecretValues('sk-test-0123456789abcdef-secret')).toContain('sk-test-0123456789abcdef-secret');
  });

  // INVARIANT: an edited secret added while resolving a MERGE is caught by
  // path too — a merge's own resolution is part of the range.
  test('an edited delivered path added in a merge resolution is caught', async () => {
    const { root, worktree, git } = await setupProject(base);
    const start = (await git(['rev-parse', 'HEAD'], worktree)).stdout;
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    await writeFile(join(root, 'upstream.txt'), 'u\n');
    await git(['add', 'upstream.txt']);
    await git(['commit', '-q', '-m', 'upstream']);
    await writeFile(join(worktree, 'mine.txt'), 'm\n');
    await git(['add', 'mine.txt'], worktree);
    await git(['commit', '-q', '-m', 'mine'], worktree);
    expect((await git(['merge', '-q', '--no-ff', '--no-commit', 'main'], worktree)).exitCode).toBe(0);
    await writeFile(join(worktree, '.env'), 'API_TOKEN=edited-during-merge-0042\n');
    await git(['add', '-f', '.env'], worktree);
    expect((await git(['commit', '-q', '-m', 'merge main'], worktree)).exitCode).toBe(0);
    const guard = await deliveredGuardFor(root, { taskId });
    expect(await findDeliveredFilesInRange(worktree, 'HEAD', [`^${start}`], guard.entries, guard.paths)).toEqual(['.env']);
  });

  // INVARIANT: a sync merge that cleanly takes an upstream commit adding a
  // tracked file at a delivered path is NOT the task carrying the secret.
  // The callers (accept, the record-time notice) exclude what is already on the
  // parent branch, and `git log -c` keeps the merge's clean take out — so
  // neither blocks accept nor files a comment for a file the task never touched.
  // The same path still catches a secret edited in WHILE resolving a merge.
  test('a clean sync merge of an upstream file at a delivered path is not reported; a resolution edit is', async () => {
    const { noteDeliveredSecretsInSession } = await import('../../src/daemon/task-files');
    const { deliveredFilesUpstreamExclude } = await import('../../src/daemon/delivered-files-upstream');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');
    const { root, worktree, git } = await setupProject(base);
    const start = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    await rm(join(worktree, '.env'));
    await writeFile(join(root, '.env'), 'PUBLIC_SAMPLE=upstream-sample-value-123\n');
    await git(['add', '-f', '.env']);
    await git(['commit', '-q', '-m', 'upstream adds .env']);
    await writeFile(join(worktree, 'mine.txt'), 'm\n');
    await git(['add', 'mine.txt'], worktree);
    await git(['commit', '-q', '-m', 'mine'], worktree);
    expect((await git(['merge', '-q', '--no-ff', '-m', 'sync', 'main'], worktree)).exitCode).toBe(0);

    const exclusion = () => deliveredFilesUpstreamExclude({
      task: { id: taskId, goal: 't', target: { kind: 'branch', branch: 'main' } } as never,
      session: { upstream_merge_sha: null } as never,
      storage: {} as never,
      projectRoot: root,
      worktreePath: worktree,
      config: { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'local' } },
    });
    const comments: string[] = [];
    const meta = new Map<string, string>();
    const storage = {
      createComment: async (_t: string, content: string) => { comments.push(content); return {} as never; },
      getTaskMetadata: async (_t: string, k: string) => meta.get(k) ?? null,
      updateTaskMetadata: async (_t: string, k: string, v: string) => { meta.set(k, v); },
    };
    await noteDeliveredSecretsInSession(storage, root, taskId, worktree, start, await exclusion());
    expect(comments).toEqual([]);

    // The next sync's resolution edits the delivered path: that IS the task's.
    await writeFile(join(root, 'upstream2.txt'), 'u\n');
    await git(['add', 'upstream2.txt']);
    await git(['commit', '-q', '-m', 'upstream 2']);
    expect((await git(['merge', '-q', '--no-ff', '--no-commit', 'main'], worktree)).exitCode).toBe(0);
    await writeFile(join(worktree, '.env'), 'API_TOKEN=edited-during-merge-0042\n');
    await git(['add', '-f', '.env'], worktree);
    expect((await git(['commit', '-q', '-m', 'sync 2'], worktree)).exitCode).toBe(0);
    await noteDeliveredSecretsInSession(storage, root, taskId, worktree, start, await exclusion());
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain('.env');
  });

  // INVARIANT: dotenv files register their VALUES only — a comment or a
  // non-secret line such as NODE_ENV=production is never scrubbed.
  test('a delivered dotenv file scrubs its values, never its comments or keys', async () => {
    const { root, worktree } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: '# Local settings for the dev server\nNODE_ENV=production\n' + SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    expect(redactSecretValues('x sk-test-0123456789abcdef-secret')).not.toContain('sk-test-0123456789abcdef-secret');
    expect(redactSecretValues('# Local settings for the dev server')).toBe('# Local settings for the dev server');
    expect(redactSecretValues('NODE_ENV=production')).toBe('NODE_ENV=production');
    expect(redactSecretValues('API_TOKEN=')).toBe('API_TOKEN=');
  });

  // INVARIANT: the registry is written atomically (no temp file left behind),
  // and a damaged one is never answered with advice to delete it — it holds
  // the history of delivered paths that keeps them out of commits.
  test('the registry is replaced atomically and a damaged one is not to be deleted', async () => {
    const { root } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    const path = getTaskFilesPath(root);
    const { readdir } = await import('fs/promises');
    const { dirname, basename } = await import('path');
    expect((await readdir(dirname(path))).filter(n => n.startsWith(basename(path) + '.'))).toEqual([]);
    expect(((await stat(path)).mode & 0o777)).toBe(0o600);
    await writeFile(path, '{"tasks":{');
    const err = await listTaskFilePaths(root, taskId).then(() => null, e => e as Error);
    expect(err?.message).toContain('Do not delete it');
  });

  // INVARIANT (defect C): what was delivered is known from the daemon's
  // registry alone. A manifest the agent forged — naming the worktree's own
  // `.git` pointer or any other file with its exact hash — makes the daemon
  // delete nothing.
  test('a forged manifest cannot make delivery delete .git or any other file', async () => {
    const { root, worktree, git } = await setupProject(base);
    const gitPointer = await readFile(join(worktree, '.git'));
    const tracked = await readFile(join(worktree, 'tracked.txt'));
    await writeFile(join(worktree, 'mine.txt'), 'agent work\n');
    await mkdir(join(worktree, '.lazy-task-sandbox'), { recursive: true });
    await writeFile(join(worktree, '.lazy-task-sandbox/task-files.json'), JSON.stringify({ files: [
      { path: '.git', blob: gitBlobId(gitPointer) },
      { path: 'tracked.txt', blob: gitBlobId(tracked) },
      { path: 'mine.txt', blob: gitBlobId('agent work\n') },
    ] }));
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    await setTaskFiles(root, taskId, []);
    await deliverTaskFiles(root, taskId, worktree);
    expect(await readFile(join(worktree, '.git'))).toEqual(gitPointer);
    expect(await readFile(join(worktree, 'tracked.txt'))).toEqual(tracked);
    expect(await readFile(join(worktree, 'mine.txt'), 'utf-8')).toBe('agent work\n');
    expect((await git(['status', '--porcelain'], worktree)).exitCode).toBe(0);
    // Nor does a forged manifest widen or narrow the guard.
    const guard = await deliveredGuardFor(root, { taskId });
    expect(guard.paths).toEqual(['.env']);
  });

  // INVARIANT (defect B): a path ever delivered to the task is guarded BY PATH
  // for its whole life — deselected and edited, it still cannot be staged
  // silently, committed, or pushed.
  test('an edited, deselected secret file is still excluded and caught in the index, the branch and a push', async () => {
    const { deliveredSecretsToPush } = await import('../../src/daemon/task-files');
    const { root, worktree, git } = await setupProject(base);
    const start = (await git(['rev-parse', 'HEAD'], worktree)).stdout;
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    await writeFile(join(worktree, '.env'), 'API_TOKEN=sk-test-0123456789abcdef-rotated\n');
    await setTaskFiles(root, taskId, []);
    await deliverTaskFiles(root, taskId, worktree);

    expect((await git(['add', '-A'], worktree)).exitCode).toBe(0);
    expect((await git(['diff', '--cached', '--name-only'], worktree)).stdout).toBe('');

    const guard = await deliveredGuardFor(root, { taskId });
    expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesStaged(worktree, guard.entries, guard.paths)).toEqual(['.env']);
    expect((await git(['commit', '-q', '-m', 'oops'], worktree)).exitCode).toBe(0);
    expect(await findDeliveredFilesAtRef(worktree, 'HEAD', guard.entries, guard.paths)).toEqual(['.env']);
    expect(await findDeliveredFilesInRange(worktree, 'HEAD', [`^${start}`], guard.entries, guard.paths)).toEqual(['.env']);
    expect(await deliveredSecretsToPush(root, 'lazy/task-a')).toEqual(['.env']);
    // Another task's branch is not guarded by this task's paths.
    expect(await deliveredSecretsToPush(root, 'lazy/task-b')).toEqual([]);
  });

  // INVARIANT: an untracked file lazy did not put there (a `[worktree]
  // include` copy, the agent's own work) is never overwritten — refused and
  // reported, like a tracked one.
  test('refuses to overwrite an untracked file it did not deliver', async () => {
    const { root, worktree } = await setupProject(base);
    await writeFile(join(worktree, '.env'), 'copied in by [worktree] include\n');
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }, { path: 'same.txt', contents: 'identical-content' }]);
    await writeFile(join(worktree, 'same.txt'), 'identical-content');
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(d.written).toEqual(['same.txt']);
    expect(d.refused).toEqual([{ path: '.env', reason: expect.stringContaining('untracked file lazy did not deliver') }]);
    expect(await readFile(join(worktree, '.env'), 'utf-8')).toBe('copied in by [worktree] include\n');
  });

  // INVARIANT (defect A): scrubbing is per task. A set the scrubber cannot
  // hold is refused at intake with nothing stored, and an oversized entry
  // already on disk breaks only its own task — never another task's commit,
  // push, accept or scrub.
  test('an oversized file set is refused at intake and an oversized stored entry wedges no other task', async () => {
    const { root, worktree, other } = await setupProject(base);
    const big = Array.from({ length: 4200 }, (_, i) => `LINE_${i}=value-${i}-abcdefghijklmnop`).join('\n');
    await expect(setTaskFiles(root, taskId, [{ path: '.env', contents: big }])).rejects.toThrow(/Nothing was stored/);
    expect(await listTaskFilePaths(root, taskId)).toEqual([]);

    // An entry written before intake checked the cap.
    const otherTask = 'aaaaaaaa-2222-3333-4444-555555555555';
    await setTaskFiles(root, otherTask, [{ path: '.env', contents: 'OTHER=sk-other-task-0123456789-secret\n' }]);
    const file = getTaskFilesPath(root);
    const reg = JSON.parse(await readFile(file, 'utf-8'));
    reg.tasks[taskId] = { '.env': Buffer.from(big).toString('base64') };
    await writeFile(file, JSON.stringify(reg), { mode: 0o600 });

    expect(await listTaskFilePaths(root, otherTask)).toEqual(['.env']);
    expect(redactSecretValues('x sk-other-task-0123456789-secret y')).not.toContain('sk-other-task-0123456789-secret');
    const theirs = await deliverTaskFiles(root, otherTask, other);
    expect(theirs.written).toEqual(['.env']);
    await expect(deliveredGuardFor(root, { taskId: otherTask })).resolves.toBeDefined();
    const mine = await deliverTaskFiles(root, taskId, worktree);
    expect(mine.written).toEqual([]);
    expect(mine.refused[0].reason).toContain('cannot be scrubbed');
    await expect(stat(join(worktree, '.env'))).rejects.toThrow();
  });
});

describe('task files: lazy_commit', () => {
  let base: string;
  let prevBaseDir: string | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-task-files-commit-')));
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon-base');
    const env: Record<string, string | undefined> = {
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      LAZY_CONFIG: undefined,
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: lazy_commit never commits a delivered secret file. `git add -A`
  // skips it (the exclude list); a staged copy (`git add -f`) is unstaged and
  // the commit refused, loudly, with nothing committed.
  test('commits the work without the file, and refuses a force-staged copy', async () => {
    const { createStorage } = await import('../../src/storage');
    const { createCommitHandler } = await import('../../src/mcp/tools');
    const { root, worktree, git } = await setupProject(base);
    const storage = await createStorage(root, { backend: 'external' });
    try {
      const task = await storage.createTask('Secret files commit');
      await storage.createSession(task.id, 'claude-code', 'lazy/task-a', (await git(['rev-parse', 'HEAD'], worktree)).stdout);
      await setTaskFiles(root, task.id, [{ path: '.env', contents: SECRET }]);
      await deliverTaskFiles(root, task.id, worktree);
      const commit = createCommitHandler({ taskId: task.id, worktreePath: worktree, storage, projectRoot: root });

      await writeFile(join(worktree, 'work.txt'), 'work\n');
      const ok = await commit({ message: 'work' }) as { committed: boolean };
      expect(ok.committed).toBe(true);
      expect((await git(['ls-tree', '-r', '--name-only', 'HEAD'], worktree)).stdout.split('\n')).not.toContain('.env');

      const before = (await git(['rev-parse', 'HEAD'], worktree)).stdout;
      expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
      await writeFile(join(worktree, 'more.txt'), 'more\n');
      await expect(commit({ message: 'sneaky', files: ['more.txt'] })).rejects.toThrow(/\.env is a per-task secret file/);
      expect((await git(['rev-parse', 'HEAD'], worktree)).stdout).toBe(before);
      expect((await git(['diff', '--cached', '--name-only'], worktree)).stdout).toBe('more.txt');
    } finally {
      await storage.close();
    }
  });
});

describe('task files: push, record-time and delivery-order guards', () => {
  let base: string;
  let prevBaseDir: string | undefined;
  const taskId = '99999999-2222-3333-4444-555555555555';

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-task-files-guard-')));
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon-base');
  });

  afterEach(async () => {
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: no push publishes a delivered file — every task-branch push
  // (after-turn, submit, remote sync, pair) asks this one guard first. It
  // compares against the daemon REGISTRY too, so deleting the agent-writable
  // manifest does not switch it off.
  test('a branch carrying a delivered file is refused for push, even with the manifest deleted', async () => {
    const { deliveredSecretsToPush, assertNoDeliveredSecretsToPush } = await import('../../src/daemon/task-files');
    const { root, worktree, git } = await setupProject(base);
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    expect(await deliveredSecretsToPush(root, 'lazy/task-a')).toEqual([]);

    expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
    expect((await git(['commit', '-q', '-m', 'oops'], worktree)).exitCode).toBe(0);
    await rm(join(worktree, '.lazy-task-sandbox/task-files.json'));
    expect(await deliveredSecretsToPush(root, 'lazy/task-a')).toEqual(['.env']);
    const err = await assertNoDeliveredSecretsToPush(root, 'lazy/task-a', 'Pushing lazy/task-a').catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('.env');
    expect(err!.message).toContain('NOT pushed');
    expect(err!.message).not.toContain('sk-test');
    // Another branch is unaffected.
    expect(await deliveredSecretsToPush(root, 'lazy/task-b')).toEqual([]);
  });

  test('a commit carrying a delivered file is reported on the task once, naming the path only', async () => {
    const { noteDeliveredSecretsInSession } = await import('../../src/daemon/task-files');
    const { root, worktree, git } = await setupProject(base);
    const start = (await git(['rev-parse', 'HEAD'], worktree)).stdout;
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    await deliverTaskFiles(root, taskId, worktree);
    const comments: Array<{ content: string; actor: unknown }> = [];
    const meta = new Map<string, string>();
    const storage = {
      createComment: async (_t: string, content: string, actor?: unknown) => { comments.push({ content, actor }); return {} as never; },
      getTaskMetadata: async (_t: string, k: string) => meta.get(k) ?? null,
      updateTaskMetadata: async (_t: string, k: string, v: string) => { meta.set(k, v); },
    };
    await noteDeliveredSecretsInSession(storage, root, taskId, worktree, start);
    expect(comments).toEqual([]);

    expect((await git(['add', '-f', '.env'], worktree)).exitCode).toBe(0);
    expect((await git(['commit', '-q', '-m', 'oops'], worktree)).exitCode).toBe(0);
    await noteDeliveredSecretsInSession(storage, root, taskId, worktree, start);
    await noteDeliveredSecretsInSession(storage, root, taskId, worktree, start);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toContain('.env');
    expect(comments[0].content).not.toContain('sk-test');
    expect(comments[0].actor).toBe('system');
  });

  // INVARIANT: no secret is ever on disk without the exclude list that keeps
  // it out of commits. If the list cannot be written, nothing is delivered.
  test('when the exclude list cannot be written, no secret file is written', async () => {
    const { root, worktree } = await setupProject(base);
    await mkdir(join(base, 'elsewhere'));
    await rm(join(worktree, '.lazy-task-sandbox'), { recursive: true, force: true });
    await symlink(join(base, 'elsewhere'), join(worktree, '.lazy-task-sandbox'));
    await setTaskFiles(root, taskId, [{ path: '.env', contents: SECRET }]);
    const d = await deliverTaskFiles(root, taskId, worktree);
    expect(d.written).toEqual([]);
    expect(d.refused.map(r => r.path)).toEqual(['.env']);
    expect(d.refused[0].reason).toContain('exclude list');
    await expect(stat(join(worktree, '.env'))).rejects.toThrow();
  });

  test('scrub strings skip comments and PEM armor but keep the key material', async () => {
    const { secretStringsForFile } = await import('../../src/utils/secret-file-strings');
    const pem = '# service cert\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
    const strings = secretStringsForFile('key.pem', pem);
    expect(strings).toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(strings).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(strings).not.toContain('-----END PRIVATE KEY-----');
    expect(strings).not.toContain('# service cert');
  });
});
