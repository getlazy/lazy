/**
 * `lazy init` .gitignore handling.
 *
 * INVARIANT: init writes ONE blanket `.lazy/` rule, not an enumeration of the
 * paths lazy happens to write today. The enumeration was a leftover from the
 * in-repo storage backend (where `.lazy/tasks/` was deliberately committed);
 * that backend is gone, nothing under a project's `.lazy/` is meant to be
 * tracked, and an enumerated list goes stale — silently leaking runtime state
 * into commits — every time lazy learns to write a new file there.
 *
 * INVARIANT: init must never strip a blanket `.lazy/` it finds. Older versions
 * actively deleted that line before adding the enumerated ones; if that
 * anti-migration comes back, init undoes the rule on every run.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { join, resolve } from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

/** The enumerated entries older versions of init wrote. All must be retired. */
const LEGACY_ENTRIES = [
  '.lazy/worktrees/',
  '.lazy/bin/',
  '.lazy/logs/',
  '.lazy/recovery/',
  '.lazy/tasks/*/*.tmp.*',
  '.lazy/tasks/*/*.backup.*',
  '.lazy/tasks/*/protocol/',
  '.lazy/storage.lock',
  '.lazy/.reconcile-lock',
  '.lazy/tmp',
  '.lazy/approve-passphrase',
];

async function runLazy(cwd: string, args: string[]) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: new TextDecoder().decode(r.stdout).trim(),
    exitCode: r.exitCode,
  };
}

function initGitRepo(cwd: string) {
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 'test@test.com');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'Initial commit');
}

function readGitignore(dir: string): string {
  return readFileSync(join(dir, '.gitignore'), 'utf-8');
}

/** Lines of the .gitignore, trimmed, blanks dropped. */
function entries(dir: string): string[] {
  return readGitignore(dir)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

const initArgs = ['init', '--skip-auth-check', '--non-interactive'];

describe('lazy init .gitignore', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test('fresh project: writes a blanket .lazy/ and no enumerated entries', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, initArgs);
    expect(result.exitCode).toBe(0);

    const lines = entries(tmpDir);
    expect(lines).toContain('.lazy/');
    // Siblings are NOT covered by `.lazy/` — gitignore matches whole path
    // components, so these prefixes still need their own rules.
    expect(lines).toContain('.lazy-task-sandbox/');
    expect(lines).toContain('.lazy-lock');
    expect(lines).toContain('.env');
    for (const legacy of LEGACY_ENTRIES) {
      expect(lines).not.toContain(legacy);
    }
  });

  test('existing project with the old enumerated block converges on .lazy/', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);
    await writeFile(
      join(tmpDir, '.gitignore'),
      ['node_modules/', '.env', '.lazy-task-sandbox/', '.lazy-lock', ...LEGACY_ENTRIES, ''].join('\n'),
    );

    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);

    const lines = entries(tmpDir);
    expect(lines).toContain('.lazy/');
    for (const legacy of LEGACY_ENTRIES) {
      expect(lines).not.toContain(legacy);
    }
    // The user's own entries survive.
    expect(lines).toContain('node_modules/');
    // No duplicates of anything lazy manages.
    for (const managed of ['.env', '.lazy-task-sandbox/', '.lazy-lock', '.lazy/']) {
      expect(lines.filter(l => l === managed)).toHaveLength(1);
    }
  });

  test('an existing blanket .lazy/ survives init and is not duplicated', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.lazy/\n');

    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);

    const lines = entries(tmpDir);
    expect(lines.filter(l => l === '.lazy/')).toHaveLength(1);
  });

  test('repeated runs are idempotent', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);

    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);
    const first = readGitignore(tmpDir);

    // A re-run on an already-initialized project...
    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);
    expect(readGitignore(tmpDir)).toBe(first);

    // ...and a full re-init over the .gitignore the first run left behind.
    // (lazy.toml goes too: its data.path points at .lazy, and preflight rejects
    // the config before init runs if that directory is missing.)
    await rm(join(tmpDir, '.lazy'), { recursive: true, force: true });
    await rm(join(tmpDir, 'lazy.toml'), { force: true });
    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);
    expect(readGitignore(tmpDir)).toBe(first);
  });

  test('re-running init on an already-initialized project retires the legacy block', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);
    expect((await runLazy(tmpDir, initArgs)).exitCode).toBe(0);

    // Simulate a project initialized before the blanket rule: .lazy/ exists on
    // disk (so init takes its already-initialized path) and .gitignore still
    // carries the enumeration. Without convergence here such a project could
    // never pick up the new rule.
    await writeFile(join(tmpDir, '.gitignore'), [...LEGACY_ENTRIES, ''].join('\n'));

    const result = await runLazy(tmpDir, initArgs);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already initialized');

    const lines = entries(tmpDir);
    expect(lines).toContain('.lazy/');
    for (const legacy of LEGACY_ENTRIES) {
      expect(lines).not.toContain(legacy);
    }
  });

  test('warns about already-tracked .lazy files instead of untracking them', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);

    // A project set up under the old in-repo backend: task JSON committed.
    await mkdir(join(tmpDir, '.lazy', 'tasks'), { recursive: true });
    await writeFile(join(tmpDir, '.lazy', 'tasks', 'abc123.json'), '{"id":"abc123"}\n');
    await writeFile(join(tmpDir, '.gitignore'), [...LEGACY_ENTRIES, ''].join('\n'));
    git(tmpDir, 'add', '-f', '.lazy/tasks/abc123.json', '.gitignore');
    git(tmpDir, 'commit', '-m', 'in-repo task state');

    const result = await runLazy(tmpDir, initArgs);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already tracking');
    expect(result.stdout).toContain('git rm -r --cached .lazy');

    // INVARIANT: init tells, it does not act. That state may be the only copy
    // of the human's task history — untracking it as a side effect of init
    // would be exactly the hidden side effect CLAUDE.md forbids.
    expect(git(tmpDir, 'ls-files', '--', '.lazy').stdout).toContain('.lazy/tasks/abc123.json');
  });

  test('no warning when nothing under .lazy is tracked', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-ignore-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, initArgs);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('already tracking');
  });
});
