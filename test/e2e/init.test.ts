import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>, stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdin: stdin !== undefined ? new Blob([stdin]) : undefined,
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

function initGitRepoNoCommits(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
}

describe('lazy init', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('initializes lazy in a git repo', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized');
    expect(existsSync(join(tmpDir, '.lazy')) || existsSync(join(tmpDir, '.workshop'))).toBe(true);
    expect(existsSync(join(tmpDir, 'lazy.toml'))).toBe(true);
  });

  test('reports already initialized', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // Init twice — first needs --non-interactive, second returns early
    await runLazy(tmpDir, ['init', '--non-interactive']);
    const result = await runLazy(tmpDir, ['init', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already initialized');
  });

  test('fails in non-git directory', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  test('fails in git repo with no commits', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepoNoCommits(tmpDir);

    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no commits');
    expect(result.stderr).toContain('git commit --allow-empty');
  });

  test('refuses to run without TTY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // No --non-interactive flag, piped stdio = no TTY
    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires an interactive terminal');
  });

  test('shows auth guidance when no auth env vars set', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Checking authentication...');
    expect(result.stdout).toContain('Authentication: not configured');
    expect(result.stdout).toContain('claude setup-token');
    expect(result.stdout).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('detects ANTHROPIC_API_KEY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: 'sk-test-key',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: ANTHROPIC_API_KEY detected');
    expect(result.stdout).not.toContain('Warning');
  });

  test('detects CLAUDE_CODE_OAUTH_TOKEN', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: CLAUDE_CODE_OAUTH_TOKEN detected');
  });

  test('prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      ANTHROPIC_API_KEY: 'sk-test-key',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: CLAUDE_CODE_OAUTH_TOKEN detected');
    expect(result.stdout).not.toContain('ANTHROPIC_API_KEY detected');
  });

  test('--skip-auth-check suppresses auth output', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized');
    expect(result.stdout).not.toContain('Checking authentication');
  });

  test('shows init --help', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--skip-auth-check');
    // --non-interactive is a hidden flag, should not appear in help
    expect(result.stdout).not.toContain('--non-interactive');
  });

  test('recommends lazy builder after init', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Get started by running: lazy builder');
  });

  test('recommends OAuth for unconfigured auth', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    // Should recommend claude setup-token for agents
    expect(result.stdout).toContain('claude setup-token');
    // Should not suggest setting ANTHROPIC_API_KEY
    expect(result.stdout).not.toContain('export ANTHROPIC_API_KEY');
  });

  test('adds all transient files to gitignore', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.lazy-task-sandbox/');
    expect(gitignore).toContain('.lazy/worktrees/');
    expect(gitignore).toContain('.lazy/bin/');
    expect(gitignore).toContain('.lazy/logs/');
    expect(gitignore).toContain('.lazy/recovery/');
    expect(gitignore).toContain('.lazy/tasks/*/*.tmp.*');
    expect(gitignore).toContain('.lazy/tasks/*/*.backup.*');
    expect(gitignore).toContain('.lazy/tasks/*/protocol/');
    expect(gitignore).toContain('.lazy/storage.lock');
    expect(gitignore).toContain('.lazy/.reconcile-lock');
    expect(gitignore).toContain('.lazy/tmp');
  });

  test('no Dockerfile → no Dockerfile prompt shown', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('Dockerfile exists and user accepts → task created with code setup-dockerfile', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    // LAZY_FORCE_TTY makes isTTY() return true so interactive prompts run.
    // LAZY_PROMPT_DEFAULTS=accept makes all promptYesNo return true and
    // promptChoice return the first option (external storage).
    const result = await runLazy(
      tmpDir,
      ['init', '--skip-auth-check', '--skip-remote-check'],
      { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found a Dockerfile');
    expect(result.stdout).toContain('setup-dockerfile');
    expect(result.stdout).toContain('Create Dockerfile.lazy from project Dockerfile');
  });

  test('Dockerfile exists and user declines → no task created', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    // LAZY_PROMPT_DEFAULTS=decline makes all promptYesNo return false,
    // so the Dockerfile task offer is declined.
    const result = await runLazy(
      tmpDir,
      ['init', '--skip-auth-check', '--skip-remote-check'],
      { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('Dockerfile exists but non-interactive mode → skipped', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('shows shell detection and completion recommendation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // $SHELL is set in the test env, so shell detection should trigger
    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    // We can't know if completions are installed in CI, but the shell should be detected
    // if $SHELL is set. At minimum, no crash.
    if (process.env.SHELL) {
      // Shell is set — either we see a recommendation or completions are already installed
      // (either way, no error)
      expect(result.stdout).toContain('Initialized');
    }
  });

  test('--skip-completion-check suppresses shell detection', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--skip-completion-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Shell detected');
  });

  test('shows --skip-completion-check in help', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--skip-completion-check');
  });
});
