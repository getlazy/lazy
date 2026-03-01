import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string | undefined>,
) {
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

describe('auto-init', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('non-interactive: commands fail with error in uninitialized repo', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-auto-init-'));
    initGitRepo(tmpDir);

    // Without TTY, auto-init won't prompt — command should fail normally
    const result = await runLazy(tmpDir, ['list']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not in a lazy project');
  });

  test('help and version work without lazy project', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-auto-init-'));
    initGitRepo(tmpDir);

    const helpResult = await runLazy(tmpDir, ['--help']);
    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toContain('Usage: lazy');

    const versionResult = await runLazy(tmpDir, ['--version']);
    expect(versionResult.exitCode).toBe(0);
  });

  test('init command does not trigger auto-init', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-auto-init-'));
    initGitRepo(tmpDir);

    // Running init directly should work without auto-init prompt
    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized');
  });

  test('commands work from subdirectories of initialized repo', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-auto-init-'));
    initGitRepo(tmpDir);
    await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    // Commit init so the repo is clean
    Bun.spawnSync(['git', 'add', '.'], { cwd: tmpDir });
    Bun.spawnSync(['git', 'commit', '-m', 'init lazy'], { cwd: tmpDir });

    // Create a subdirectory and run from there
    const subDir = join(tmpDir, 'src', 'deep');
    Bun.spawnSync(['mkdir', '-p', subDir]);

    const result = await runLazy(subDir, ['list']);
    expect(result.exitCode).toBe(0);
  });
});
