import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

/**
 * Per-role model targets: [models.roles.builder] / [models.roles.agent] config.
 * These tests exercise config-load validation (no daemon needed — `create`/`show`
 * never launch an agent), which is where the fail-hard config guardrails live.
 */
describe('per-role model targets', () => {
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

  test('per-role config with both roles parses and works', async () => {
    await appendConfig(`
[models.roles.builder]
backend = "anthropic"
model = "claude-opus-4-8"

[models.roles.agent]
backend = "ollama"
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
`);
    const taskId = await createTask(ctx, 'Per-role task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  // INVARIANT: No silent name substitution — an ollama/proxy role with no model
  // is a config bug the user must see immediately, not a silent degrade.
  test('fails when an agent role uses ollama backend without a model', async () => {
    await appendConfig(`
[models.roles.agent]
backend = "ollama"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'no model is set');
  });

  // INVARIANT (default-on proxy): a proxy role may omit `endpoint` — the daemon
  // injects the live (OS-assigned) address at launch. With the proxy on by
  // default this holds even with NO [proxy] section at all.
  test('a proxy role with no endpoint is accepted with no [proxy] section (default-on)', async () => {
    await appendConfig(`
[models.roles.builder]
backend = "proxy"
model = "claude-opus-4-8"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectSuccess(result);
  });

  test('a proxy role with no endpoint is accepted with an explicit [proxy] section', async () => {
    await appendConfig(`
[proxy]

[models.roles.builder]
backend = "proxy"
model = "claude-opus-4-8"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectSuccess(result);
  });

  // INVARIANT: the one hard failure left — routing a role at a proxy that is
  // switched off. Fail at load rather than launching with an empty base URL,
  // which would silently bypass the audit/policy plane.
  test('fails when a proxy role has no endpoint AND the proxy is disabled', async () => {
    await appendConfig(`
[proxy]
enabled = false

[models.roles.builder]
backend = "proxy"
model = "claude-opus-4-8"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'proxy is disabled');
  });

  // INVARIANT: An unknown backend is a config error — lazy supports exactly
  // anthropic | ollama | proxy and must not silently ignore typos.
  test('fails on an invalid backend value', async () => {
    await appendConfig(`
[models.roles.agent]
backend = "openai"
model = "gpt-4"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'Invalid backend');
  });

  // INVARIANT: The legacy [ollama] block must keep working unchanged — it maps
  // to "all roles → ollama" so existing configs are not broken by the per-role split.
  test('legacy [ollama] block still works (maps to all roles)', async () => {
    await appendConfig(`
[ollama]
enabled = true
model = "qwen3-coder"
`);
    const taskId = await createTask(ctx, 'Legacy ollama task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  test('ollama agent role defaults its endpoint when omitted', async () => {
    await appendConfig(`
[models.roles.agent]
backend = "ollama"
model = "qwen3-coder"
`);
    const taskId = await createTask(ctx, 'Ollama default endpoint role');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });
});
