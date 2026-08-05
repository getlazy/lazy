import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

// The `lazy init` template ALREADY writes [remote] and [docker]. Appending a
// second copy of either is a TOML redefinition error, not a config change — and
// it used to be invisible, because loadConfig warned and silently returned
// DEFAULT_CONFIG. These tests then asserted that commands "work with a custom
// [remote]/[docker] section" while lazy was in fact running on defaults with the
// whole file discarded. So: set keys inside the section that is already there.

/**
 * Set `key = value` inside an existing TOML section, replacing the key (even if
 * it is commented out) or inserting it just below the section header.
 */
function setConfigKey(config: string, section: string, key: string, value: string): string {
  const lines = config.split('\n');
  const header = lines.findIndex(l => l.trim() === `[${section}]`);
  if (header === -1) throw new Error(`lazy init template no longer writes [${section}] — update this test`);

  let end = header + 1;
  while (end < lines.length && !lines[end].startsWith('[')) end++;

  const keyPattern = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const existing = lines.slice(header + 1, end).findIndex(l => keyPattern.test(l));
  if (existing === -1) lines.splice(header + 1, 0, `${key} = ${value}`);
  else lines[header + 1 + existing] = `${key} = ${value}`;
  return lines.join('\n');
}

describe('config remote and docker sections', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('works with default config (no remote/docker sections)', async () => {
    // Default lazy.toml should not have remote/docker but commands still work
    const taskId = await createTask(ctx, 'Default config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with remote and docker config sections in lazy.toml', async () => {
    // Write a lazy.toml with the new sections
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    let newConfig = setConfigKey(existingConfig, 'remote', 'driver', '"github"');
    newConfig = setConfigKey(newConfig, 'remote', 'github_auto_push', 'false');
    newConfig = setConfigKey(newConfig, 'docker', 'dockerfile', '"Dockerfile.custom"');
    await writeFile(configPath, newConfig, 'utf-8');

    // Commands should still work with the new config sections
    const taskId = await createTask(ctx, 'Custom config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('works with partial remote config', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = await readFile(configPath, 'utf-8');

    const newConfig = setConfigKey(existingConfig, 'remote', 'driver', '"github"');
    await writeFile(configPath, newConfig, 'utf-8');

    const taskId = await createTask(ctx, 'Partial remote config task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });
});
