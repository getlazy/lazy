import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
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

async function runLazy(cwd: string, args: string[], input?: string): Promise<WorkResult> {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: input ? 'pipe' : undefined,
    env: process.env,
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

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'lazy-init-test-'));
    externalPath = join(testRoot, 'external-storage');

    // Initialize git repo
    spawnGit(testRoot, 'init');
    spawnGit(testRoot, 'config', 'user.email', 'test@lazy.test');
    spawnGit(testRoot, 'config', 'user.name', 'Lazy Test');
    spawnGit(testRoot, 'checkout', '-b', 'main');

    // Add git remote to test project name extraction
    spawnGit(testRoot, 'remote', 'add', 'origin', 'git@github.com:test/my-project.git');

    // Create initial commit
    await writeFile(join(testRoot, 'README.md'), '# Test\n');
    spawnGit(testRoot, 'add', '.');
    spawnGit(testRoot, 'commit', '-m', 'Initial commit');
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test('non-interactive init defaults to in-repo storage', async () => {
    const result = await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized lazy');
    expect(result.stdout).toContain('in-repo');

    // Verify .lazy directory was created
    expect(existsSync(join(testRoot, '.lazy'))).toBe(true);
    expect(existsSync(join(testRoot, '.lazy', 'tasks'))).toBe(true);

    // Verify config file has correct backend
    const configContent = await readFile(join(testRoot, 'lazy.toml'), 'utf-8');
    expect(configContent).toContain('backend = "in-repo"');
  });

  test('manual config for external storage is respected', async () => {
    // Initialize with default in-repo first
    await runLazy(testRoot, ['init', '--skip-auth-check', '--non-interactive']);

    // Manually edit config to use external storage
    const configPath = join(testRoot, 'lazy.toml');
    let config = await readFile(configPath, 'utf-8');
    config = config.replace('backend = "in-repo"', `backend = "external"`);
    config = config.replace('external_path = ""', `external_path = "${externalPath}"`);
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
    expect(configContent).toContain('orphan_branch_name =');
  });
});
