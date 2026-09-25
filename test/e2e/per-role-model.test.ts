import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

/**
 * Per-role model targets: `[models.roles.builder]` / `[models.roles.agent]`.
 *
 * A role names the agent PROFILE it defaults to — `agent = "<profile>"` — and
 * nothing else: harness, model, upstream and credential are the profile's, so
 * that two tasks in the same role can run different agents against different
 * upstreams. These tests exercise config-load validation (no daemon needed —
 * `create`/`show` never launch an agent), which is where the fail-hard config
 * guardrails live.
 *
 * The removed `backend` / `model` / `endpoint` role keys, and the removed
 * `[ollama]` block, are covered by test/e2e/agent-profile-migration.test.ts,
 * which asserts both the refusal and the `lazy doctor --fix agents` rewrite.
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

  test('both roles naming a profile parses and works', async () => {
    await appendConfig(`
[models.roles.builder]
agent = "claude-code"

[models.roles.agent]
agent = "local-ollama"

[agents.local-ollama]
harness = "claude-code"
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://localhost:11434"
`);
    const taskId = await createTask(ctx, 'Per-role task');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
  });

  // INVARIANT: a role that names a profile the project does not define is a
  // config error listing the alternatives — never a silent fall-back to the
  // default profile, which would launch every task of that role somewhere the
  // file plainly does not say.
  test('fails on a role that names an unknown profile', async () => {
    await appendConfig(`
[models.roles.agent]
agent = "nope"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'Unknown agent profile "nope"');
    expectError(result, '[models.roles.agent] agent');
    expectError(result, 'Available profiles');
  });

  // INVARIANT: no silent name substitution — a profile that pins an endpoint
  // must name its model. Model names belong to the endpoint ("opus" does not
  // exist on an Ollama box), so lazy refuses at load rather than guess one.
  test('fails when a role default profile pins an endpoint without a model', async () => {
    await appendConfig(`
[models.roles.agent]
agent = "local-ollama"

[agents.local-ollama]
harness = "claude-code"
endpoint = "http://localhost:11434"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'sets endpoint but no model');
  });

  // INVARIANT (proxy-always-on): `[proxy] enabled = false` is rejected outright,
  // however the roles are configured. The audit plane cannot be switched off —
  // deliberate product change after the per-role opt-out and the enabled
  // toggle were removed.
  test('rejects [proxy] enabled = false even with roles configured', async () => {
    await appendConfig(`
[proxy]
enabled = false

[models.roles.builder]
agent = "claude-code"
`);
    const result = await ctx.lazy(['create', '--goal', 'test task']);
    expectFailure(result);
    expectError(result, 'has been removed');
    expectError(result, 'always on');
  });
});
