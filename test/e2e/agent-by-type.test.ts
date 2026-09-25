/**
 * E2E tests for `[agent.by_type]` — routing task types to agents from config.
 *
 * INVARIANT: Unmapped types fall back to `agent_id`. Explicit `--agent` and
 * inheritance (subtask/clone/redo) still win. Unknown type names or agent ids
 * in the mapping fail at config load time.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput, extractTaskId } from '../helpers/assertions';
import { readTaskJson } from '../helpers/storage';

function agentOf(root: string, taskId: string): string {
  return readTaskJson(root, taskId).agent_id;
}

async function appendToml(ctx: TestContext, extra: string): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(tomlPath, 'utf-8');
  await writeFile(tomlPath, existing + extra);
}

describe('agent.by_type routing', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    await appendToml(ctx, `

[agent.by_type]
fix = "cursor"
feature = "cursor"
`);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy fix picks the mapped agent and prints the source', async () => {
    const result = await ctx.lazy(['fix', '--goal', 'Broken thing']);
    expectSuccess(result);
    expectOutput(result, 'task type fix → [agent.by_type]');
    expectOutput(result, 'Agent:  cursor');

    const taskId = extractTaskId(result.stdout);
    expect(agentOf(ctx.root, taskId)).toBe('cursor');
  });

  test('lazy create --type feature uses the mapping', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Ship widgets', '--type', 'feature']);
    expectSuccess(result);
    expectOutput(result, 'task type feature → [agent.by_type]');

    const taskId = extractTaskId(result.stdout);
    expect(agentOf(ctx.root, taskId)).toBe('cursor');
  });

  test('explicit --agent overrides by_type', async () => {
    const result = await ctx.lazy([
      'create', '--goal', 'Override me', '--type', 'fix', '--agent', 'claude-code',
    ]);
    expectSuccess(result);
    expect(result.stdout).not.toContain('[agent.by_type]');

    const taskId = extractTaskId(result.stdout);
    expect(agentOf(ctx.root, taskId)).toBe('claude-code');
  });

  // INVARIANT: inheritance beats by_type — a subtask stays on its parent's agent.
  test('a subtask inherits its parent agent instead of by_type', async () => {
    const parent = await ctx.lazy(['create', '--goal', 'Parent', '--agent', 'claude-code']);
    const parentId = extractTaskId(parent.stdout);

    const child = await ctx.lazy(['create', '--goal', 'Child', '--parent', parentId, '--type', 'fix']);
    expectSuccess(child);

    expect(agentOf(ctx.root, extractTaskId(child.stdout))).toBe('claude-code');
  });

  test('unmapped task types fall back to agent_id', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Investigate', '--type', 'spike']);
    expectSuccess(result);
    expect(result.stdout).not.toContain('[agent.by_type]');

    const taskId = extractTaskId(result.stdout);
    expect(agentOf(ctx.root, taskId)).toBe('claude-code');
  });
});

describe('agent.by_type config validation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('unknown task type in by_type fails at load time', async () => {
    await appendToml(ctx, `

[agent.by_type]
not-a-type = "cursor"
`);

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expectError(result, 'Unknown task type');
    expectError(result, 'not-a-type');
  });

  test('unknown agent in by_type fails at load time', async () => {
    await appendToml(ctx, `

[agent.by_type]
fix = "not-an-agent"
`);

    const result = await ctx.lazy(['list']);
    expectFailure(result);
    expectError(result, 'Unknown agent');
    expectError(result, 'not-an-agent');
  });
});
