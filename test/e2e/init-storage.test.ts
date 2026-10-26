import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join, basename } from 'path';
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { existsSync } from 'fs';

interface WorkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ENTRY_PATH = join(__dirname, '../../src/index.ts');

function spawnGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

async function runLazy(cwd: string, args: string[], input?: string, extraEnv?: Record<string, string>): Promise<WorkResult> {
  const proc = Bun.spawn(['bun', 'run', ...(extraEnv?.LAZY_MOCK_CLAUDE_RESPONSE ? ['--preload', join(__dirname, '../mocks/preload-mocks.ts')] : []), ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: input ? 'pipe' : undefined,
    // LAZY_TEST=1 keeps the CLI from auto-starting a daemon. This suite is
    // daemonless by design (it only runs `init` and `create`), and without the
    // flag every invocation left a live daemon holding `.storage-lock` on the
    // external store — which then failed the NEXT `lazy init` with "Failed to
    // acquire storage lock after 50 attempts". Mirrors test/helpers/setup.ts.
    env: { ...process.env, LAZY_TEST: '1', ...extraEnv },
  });

  if (input && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe('lazy init storage location', () => {
  let testRoot: string;
  let externalPath: string;
  let projectName: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'lazy-init-test-'));
    externalPath = join(testRoot, 'external-storage');

    // Initialize git repo
    spawnGit(testRoot, 'init');
    spawnGit(testRoot, 'config', 'user.email', 'test@lazy.test');
    spawnGit(testRoot, 'config', 'user.name', 'Lazy Test');
    spawnGit(testRoot, 'checkout', '-b', 'main');

    // Add git remote to test project name extraction.
    //
    // The repo name must be UNIQUE per test: lazy derives the default external
    // storage path from it (`~/.lazy/<project-name>`), so a fixed name made
    // every temp repo in this suite — and any other suite using the same name —
    // share one store and contend on its `.storage-lock`.
    projectName = `my-project-${basename(testRoot)}`;
    spawnGit(testRoot, 'remote', 'add', 'origin', `git@github.com:test/${projectName}.git`);

    // Create initial commit
    await writeFile(join(testRoot, 'README.md'), '# Test\n');
    spawnGit(testRoot, 'add', '.');
    spawnGit(testRoot, 'commit', '-m', 'Initial commit');
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test('non-interactive init defaults to external storage', async () => {
    const result = await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized lazy');
    expect(result.stdout).toContain('external');

    // Verify .lazy directory was created
    expect(existsSync(join(testRoot, '.lazy'))).toBe(true);

    // Verify config file has correct backend
    const configContent = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('backend = "external"');
  });

  test('manual config for external storage path is respected', async () => {
    // Initialize with default external first
    await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive']);

    // Manually edit config to set external storage path
    const configPath = join(testRoot, 'lazy.toml');
    let config = await readFile(configPath, 'utf-8');
    // `init` writes a POPULATED external_path (~/.lazy/<project-name>), so the old
    // literal replace of `external_path = ""` silently matched nothing and the task
    // landed in the default store — the assertion below then failed on an empty dir.
    const before = config;
    config = config.replace(/^external_path\s*=\s*"[^"]*"/m, `external_path = "${externalPath}"`);
    expect(config).not.toBe(before);
    await writeFile(configPath, config);

    // Create external storage directory
    await mkdir(join(externalPath, 'tasks'), { recursive: true });

    // Create a task - this should use external storage
    const createResult = await runLazy(testRoot, ['create', '--goal', 'Test task']);
    expect(createResult.exitCode).toBe(0);

    // Verify task was created in external storage
    const tasksDir = join(externalPath, 'tasks');
    expect(existsSync(tasksDir)).toBe(true);

    // List directory to check if task was created
    const entries = Bun.spawnSync(['ls', tasksDir], { stdout: 'pipe' });
    const taskDirs = entries.stdout.toString().trim().split('\n').filter(d => d && d !== '.gitkeep');
    expect(taskDirs.length).toBeGreaterThan(0);
  });

  test('config template includes storage section', async () => {
    await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive']);

    const configContent = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('[storage]');
    expect(configContent).toContain('backend =');
    expect(configContent).toContain('external_path =');
  });

  // INVARIANT: --external-path is the non-interactive seam for placing the store.
  // Without a TTY there is no storage prompt, so before this flag the store path
  // was unreachable from outside and a provisioning system (the lazy-teams fleet
  // supervisor) had to hand-edit lazy.toml after init. The flag must WIN in every
  // config shape — a flag that silently no-ops on a repo shipping its own
  // lazy.toml would be worse than no flag at all.
  describe('--external-path', () => {
    // INVARIANT: moving a project and neighboring store together retains its tasks. Cwd must never select a different store.
    test('preserves a relative store and runs a task after moving the parent', async () => {
      const original = join(testRoot, 'original');
      const project = join(original, 'project');
      await mkdir(project, { recursive: true });
      for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@lazy.test'], ['config', 'user.name', 'Lazy Test'], ['commit', '--allow-empty', '-m', 'Initial']]) {
        expect(spawnGit(project, ...args).exitCode).toBe(0);
      }
      const init = await runLazy(project, ['init', '--skip-auth-check', '--non-interactive', '--external-path', '../stores/portable']);
      expect(init.exitCode).toBe(0);
      expect(await readFile(join(project, 'lazy.toml'), 'utf8')).toContain('external_path = "../stores/portable"');
      const created = await runLazy(project, ['create', '--goal', 'Portable task', '--prompt', 'Verify the moved project works', '--code', 'portable-task']);
      expect(created.exitCode).toBe(0);
      const moved = join(testRoot, 'moved');
      await rename(original, moved);
      const movedProject = join(moved, 'project');
      const subdir = join(movedProject, 'nested');
      await mkdir(subdir);
      const listed = await runLazy(subdir, ['list']);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('Portable task');
      const started = await runLazy(subdir, ['start', 'portable-task'], undefined, {
        ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
        LAZY_PROTOCOL_BASE: join(testRoot, 'protocol'),
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({ result: 'Moved project task ran successfully', session_id: 'portable-session', usage: { input_tokens: 1, output_tokens: 1 } }),
      });
      expect(started).toMatchObject({ exitCode: 0 });
      const shown = await runLazy(subdir, ['show', 'portable-task']);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain('Portable task');
      const doctor = await runLazy(subdir, ['doctor']);
      expect(doctor.stdout).toContain('relative to project root');
      expect(doctor.stdout).toContain('../stores/portable');
    });

    test('reports both configured and resolved paths when the store is missing', async () => {
      const init = await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive', '--external-path', 'missing-store']);
      expect(init.exitCode).toBe(0);
      await rm(join(testRoot, 'missing-store'), { recursive: true });
      const listed = await runLazy(testRoot, ['list'], undefined, { LAZY_TEST: '' });
      expect(listed.exitCode).not.toBe(0);
      expect(listed.stderr).toContain('value:        missing-store');
      expect(listed.stderr).toContain(`resolved to:  ${join(testRoot, 'missing-store')}`);
    });

    test('places the store on a fresh repo', async () => {
      const store = join(testRoot, 'fleet-store');
      const result = await runLazy(testRoot, [
        'init', '--skip-auth-check', '--non-interactive', '--external-path', store,
      ]);

      expect(result.exitCode).toBe(0);

      const config = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
      expect(config).toContain('backend = "external"');
      expect(config).toContain(`external_path = "${store}"`);
      expect(existsSync(join(store, 'tasks'))).toBe(true);
    });

    test('rewrites a [storage] section that has no external_path', async () => {
      // A repo whose committed lazy.toml declares [storage] but omits the key.
      // applyTomlOverrides only REPLACES existing keys, so this shape is exactly
      // where a replace-only implementation silently does nothing.
      await writeFile(
        join(testRoot, 'lazy.toml'),
        '[storage]\nbackend = "external"\n\n[git]\ndefault_branch_prefix = "lazy"\n',
      );

      const store = join(testRoot, 'fleet-store');
      const result = await runLazy(testRoot, [
        'init', '--skip-auth-check', '--non-interactive', '--external-path', store,
      ]);

      expect(result.exitCode).toBe(0);

      const config = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
      expect(config).toContain(`external_path = "${store}"`);
      // The rest of the committed config survives — init edits the key, not the file.
      expect(config).toContain('default_branch_prefix = "lazy"');
    });

    test('replaces a stale external_path pointing at a nonexistent directory', async () => {
      // The real provisioning case: the cloned repo's committed external_path
      // points wherever ITS authors keep their store, which does not exist on
      // the fleet host. LAZY_FORCE_PREFLIGHT arms the config-path validation that
      // production runs and LAZY_TEST normally skips, so this asserts the
      // `init --external-path` bypass: validating the STALE value would reject
      // the config for the exact staleness this invocation exists to fix.
      const stale = join(testRoot, 'does-not-exist', 'someone-elses-store');
      await writeFile(
        join(testRoot, 'lazy.toml'),
        `[storage]\nbackend = "postgres"\nexternal_path = "${stale}"\n\n[git]\ndefault_branch_prefix = "lazy"\n`,
      );

      const store = join(testRoot, 'fleet-store');
      const result = await runLazy(
        testRoot,
        ['init', '--skip-auth-check', '--non-interactive', '--external-path', store],
        undefined,
        { LAZY_FORCE_PREFLIGHT: '1' },
      );

      expect(result.exitCode).toBe(0);

      const config = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
      expect(config).toContain(`external_path = "${store}"`);
      expect(config).not.toContain(stale);
      // backend is forced to external too: an external_path under a `postgres`
      // backend would be inert, so the flag would still not have placed the store.
      expect(config).toContain('backend = "external"');
      expect(config).not.toContain('backend = "postgres"');
      expect(existsSync(join(store, 'tasks'))).toBe(true);
    });

    test('rejects a missing value instead of silently ignoring the flag', async () => {
      const result = await runLazy(testRoot, [
        'init', '--skip-auth-check', '--non-interactive', '--external-path',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--external-path requires a directory path');
    });
  });
});
