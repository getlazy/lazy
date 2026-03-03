import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy worktree.include', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('copies single untracked file into worktree on start', async () => {
    // Create an untracked .env file in the repo root
    const envPath = join(ctx.root, '.env');
    writeFileSync(envPath, 'SECRET=test123\n');

    // Configure worktree.include in lazy.toml
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = [".env"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Verify .env was copied to the worktree
    const worktreeEnvPath = join(ctx.root, '.lazy', 'worktrees', taskId, '.env');
    expect(existsSync(worktreeEnvPath)).toBe(true);
    const copiedContent = readFileSync(worktreeEnvPath, 'utf-8');
    expect(copiedContent).toBe('SECRET=test123\n');

    // Verify the copy was logged
    expectOutput(result, 'Copied .env to worktree');
  });

  test('copies multiple files matching glob pattern', async () => {
    // Create multiple .env files
    const env1Path = join(ctx.root, '.env');
    const env2Path = join(ctx.root, '.env.local');
    writeFileSync(env1Path, 'SECRET1=test\n');
    writeFileSync(env2Path, 'SECRET2=local\n');

    // Configure worktree.include with glob pattern
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = [".env*"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Verify both files were copied
    const worktreeEnv1 = join(ctx.root, '.lazy', 'worktrees', taskId, '.env');
    const worktreeEnv2 = join(ctx.root, '.lazy', 'worktrees', taskId, '.env.local');
    expect(existsSync(worktreeEnv1)).toBe(true);
    expect(existsSync(worktreeEnv2)).toBe(true);

    expectOutput(result, 'Copied .env to worktree');
    expectOutput(result, 'Copied .env.local to worktree');
  });

  test('does not copy tracked files even if they match the pattern', async () => {
    // Create a tracked .env.example file
    const envExamplePath = join(ctx.root, '.env.example');
    writeFileSync(envExamplePath, 'EXAMPLE=value\n');
    await ctx.git('add', '.env.example');
    await ctx.git('commit', '-m', 'Add .env.example');

    // Create an untracked .env file
    const envPath = join(ctx.root, '.env');
    writeFileSync(envPath, 'SECRET=test\n');

    // Configure worktree.include with pattern that matches both
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = [".env*"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Verify only .env was copied (not .env.example since it's tracked)
    const worktreeEnv = join(ctx.root, '.lazy', 'worktrees', taskId, '.env');
    expect(existsSync(worktreeEnv)).toBe(true);

    expectOutput(result, 'Copied .env to worktree');
    // Should NOT log copying .env.example
  });

  test('handles missing files gracefully (no error)', async () => {
    // Configure worktree.include with a pattern that won't match anything
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = [".env", ".env.local"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task (no .env files exist)
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Should succeed without error
  });

  test('copies files into subdirectories', async () => {
    // Create a config file in a subdirectory
    const configDir = join(ctx.root, 'config');
    Bun.spawnSync(['mkdir', '-p', configDir]);
    const configPath = join(configDir, 'local.yml');
    writeFileSync(configPath, 'key: value\n');

    // Configure worktree.include
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = ["config/local.yml"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Verify file was copied with correct directory structure
    const worktreeConfigPath = join(ctx.root, '.lazy', 'worktrees', taskId, 'config', 'local.yml');
    expect(existsSync(worktreeConfigPath)).toBe(true);
    const copiedContent = readFileSync(worktreeConfigPath, 'utf-8');
    expect(copiedContent).toBe('key: value\n');
  });

  test('works on reopen command after task is closed', async () => {
    // Configure worktree.include
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = [".env"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create task, start it, close it (no .env file yet, so worktree is clean)
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Close the task to remove worktree
    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'test']);
    expectSuccess(closeResult);

    // Now create the .env file
    const envPath = join(ctx.root, '.env');
    writeFileSync(envPath, 'SECRET=test\n');

    // Reopen the task - should recreate worktree and copy .env
    const result = await ctx.lazy(['reopen', taskId]);
    expectSuccess(result);

    // Verify .env was copied during reopen
    const worktreeEnvPath = join(ctx.root, '.lazy', 'worktrees', taskId, '.env');
    expect(existsSync(worktreeEnvPath)).toBe(true);
    const copiedContent = readFileSync(worktreeEnvPath, 'utf-8');
    expect(copiedContent).toBe('SECRET=test\n');
  });

  test('preserves file permissions', async () => {
    // Create an executable script
    const scriptPath = join(ctx.root, 'script.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho "test"\n');
    Bun.spawnSync(['chmod', '+x', scriptPath]);

    // Configure worktree.include
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = ["script.sh"]\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);

    // Verify the script is executable in the worktree
    const worktreeScriptPath = join(ctx.root, '.lazy', 'worktrees', taskId, 'script.sh');
    expect(existsSync(worktreeScriptPath)).toBe(true);

    // Check that it's executable
    const result = Bun.spawnSync(['test', '-x', worktreeScriptPath]);
    expect(result.exitCode).toBe(0);
  });

  test('empty include array does nothing', async () => {
    // Create .env file
    const envPath = join(ctx.root, '.env');
    writeFileSync(envPath, 'SECRET=test\n');

    // Configure empty worktree.include
    const tomlPath = join(ctx.root, 'lazy.toml');
    const config = readFileSync(tomlPath, 'utf-8');
    const updatedConfig = config + '\n[worktree]\ninclude = []\n';
    writeFileSync(tomlPath, updatedConfig);

    // Create and start a task
    const taskId = await createTask(ctx, 'Test task', 'Do some work');
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // Verify .env was NOT copied
    const worktreeEnvPath = join(ctx.root, '.lazy', 'worktrees', taskId, '.env');
    expect(existsSync(worktreeEnvPath)).toBe(false);
  });
});
