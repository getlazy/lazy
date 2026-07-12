import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('[[mounts]] config', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function appendConfig(extra: string): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    await writeFile(configPath, existing + '\n' + extra, 'utf-8');
  }

  // INVARIANT: Absent [[mounts]] → unchanged behavior. The default config has no
  // mounts, so config loading and task creation must succeed exactly as before.
  test('no [[mounts]] section works (unchanged behavior)', async () => {
    const taskId = await createTask(ctx, 'No mounts task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('valid bind and volume mounts load successfully', async () => {
    await appendConfig(`
[[mounts]]
source = "/host/cache"
target = "/work/cache"
readonly = true

[[mounts]]
type = "volume"
name = "myproj-node-modules"
target = "{worktree}/node_modules"
`);
    const taskId = await createTask(ctx, 'Valid mounts task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  // INVARIANT: Invalid [[mounts]] fail loudly at config-load time with an
  // actionable message naming the offending entry — never a silent skip.
  test('fails loudly when a mount is missing target', async () => {
    await appendConfig(`
[[mounts]]
source = "/host/cache"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'missing required "target"');
  });

  test('fails loudly on unknown mount type', async () => {
    await appendConfig(`
[[mounts]]
type = "tmpfs"
target = "/work/cache"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'unknown type');
  });

  test('fails loudly when a bind mount has no source', async () => {
    await appendConfig(`
[[mounts]]
target = "/work/cache"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'requires "source"');
  });
});
