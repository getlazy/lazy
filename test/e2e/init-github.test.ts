import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...envOverrides },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function initGitRepo(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'Initial commit'], { cwd });
}

describe('lazy init GitHub detection', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('detects GitHub remote and configures driver', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));
    initGitRepo(tmpDir);

    // Add a GitHub remote
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    // Init should detect GitHub (non-interactive mode auto-configures)
    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Detected GitHub remote');
    expect(result.stdout).toContain('driver = "github"');

    // Verify lazy.toml was updated
    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('driver = "github"');
  });

  test('does not detect GitHub for non-GitHub remotes', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));
    initGitRepo(tmpDir);

    // Add a non-GitHub remote
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://gitlab.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    // Should NOT detect GitHub
    expect(result.stdout).not.toContain('Detected GitHub remote');

    // Verify lazy.toml was NOT updated to github
    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('driver = "local"');
  });

  test('does not detect GitHub when no remote', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Detected GitHub remote');
  });

  test('--skip-github-check suppresses GitHub detection', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));
    initGitRepo(tmpDir);

    // Add a GitHub remote
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--skip-github-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Detected GitHub remote');

    // Verify lazy.toml was NOT updated
    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('driver = "local"');
  });

  test('--skip-remote-check suppresses remote detection', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));
    initGitRepo(tmpDir);

    // Add a GitHub remote
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--skip-remote-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Detected GitHub remote');

    // Verify lazy.toml was NOT updated
    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('driver = "local"');
  });

  test('init --help shows remote check options', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-gh-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--skip-remote-check');
    expect(result.stdout).toContain('--skip-github-check');
  });
});

describe('lazy init smart remote detection', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // INVARIANT: When only one remote exists and it's not 'origin',
  // init should auto-select it and set git_remote in lazy.toml.
  test('single non-origin remote is auto-selected and stored in config', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-remote-'));
    initGitRepo(tmpDir);

    Bun.spawnSync(['git', 'remote', 'add', 'upstream', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Using git remote "upstream"');

    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('git_remote = "upstream"');
  });

  // INVARIANT: When multiple remotes exist and 'origin' is among them,
  // init should prefer 'origin' for backward compatibility.
  test('origin is preferred when multiple remotes exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-remote-'));
    initGitRepo(tmpDir);

    Bun.spawnSync(['git', 'remote', 'add', 'upstream', 'https://github.com/other/repo.git'], { cwd: tmpDir });
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);

    // git_remote should stay commented out (default 'origin')
    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('# git_remote = "origin"');
    expect(configContent).not.toMatch(/^git_remote = /m);
  });

  // INVARIANT: When no remotes exist, init uses 'origin' as default.
  test('no remotes defaults to origin', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-remote-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);

    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('# git_remote = "origin"');
  });

  // INVARIANT: When multiple remotes exist without 'origin', non-interactive
  // mode should pick the first one automatically.
  test('multiple remotes without origin uses first in non-interactive mode', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-remote-'));
    initGitRepo(tmpDir);

    Bun.spawnSync(['git', 'remote', 'add', 'github', 'https://github.com/test/repo.git'], { cwd: tmpDir });
    Bun.spawnSync(['git', 'remote', 'add', 'gitlab', 'https://gitlab.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);

    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    // Should have set git_remote to a non-origin value
    expect(configContent).toMatch(/^git_remote = "/m);
  });

  // INVARIANT: Driver auto-detection uses the chosen remote name.
  // When the only remote is 'upstream' pointing to GitHub, init should
  // still detect and configure the GitHub driver.
  test('detects GitHub on non-origin remote', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-remote-'));
    initGitRepo(tmpDir);

    Bun.spawnSync(['git', 'remote', 'add', 'upstream', 'https://github.com/test/repo.git'], { cwd: tmpDir });

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Detected GitHub remote');

    const configContent = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('driver = "github"');
    expect(configContent).toContain('git_remote = "upstream"');
  });
});
