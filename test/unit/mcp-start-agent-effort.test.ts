/**
 * Unit test: the MCP `lazy_start` `agent` and `effort` parameters, and the
 * boundary validation of `effort` shared with `lazy_ask`.
 *
 * Background: the CLI's `lazy start` has had `--agent` and `--effort` since
 * they existed; `lazy_start` did not (parity audit finding C2-4). A parent
 * agent orchestrating subtasks therefore could not dial reasoning effort or
 * pick an agent for a subtask it was starting.
 *
 * INVARIANT: `effort` is validated at the MCP boundary, not downstream.
 * `resolveAndPersistEffort` (src/daemon/effort.ts) blind-casts its argument and
 * writes it to task metadata, so an unvalidated level is PERSISTED and governs
 * every later turn of that task. MCP is a first-class external surface and must
 * reject the value itself rather than rely on someone else doing it.
 *
 * These tests exercise the boundary only — they assert on the tool schema and
 * on rejection before any launch. Actually launching a task needs a daemon and
 * is covered in the e2e suites.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, allTools, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { VALID_EFFORT_LEVELS } from '../../src/config/types';
import { listAgents } from '../../src/agent/registry';

function toolNamed(name: string) {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not advertised: ${name}`);
  return tool;
}

describe('MCP lazy_start agent/effort parity', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-start-parity-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // --- schema ---

  test('lazy_start advertises agent and effort', () => {
    const props = toolNamed('lazy_start').inputSchema.properties ?? {};

    expect(props.agent).toBeDefined();
    expect(props.agent?.type).toBe('string');
    expect(props.effort).toBeDefined();
    expect(props.effort?.type).toBe('string');

    // Neither is required — both are overrides on top of the task's own values.
    const required = toolNamed('lazy_start').inputSchema.required ?? [];
    expect(required).not.toContain('agent');
    expect(required).not.toContain('effort');
    expect(required).toContain('task_id');
  });

  test('effort is enum-constrained to the real levels on lazy_start and lazy_ask', () => {
    for (const name of ['lazy_start', 'lazy_ask']) {
      const effort = (toolNamed(name).inputSchema.properties ?? {}).effort;
      expect(effort, `${name}.effort`).toBeDefined();
      expect(effort!.enum, `${name}.effort.enum`).toEqual([...VALID_EFFORT_LEVELS]);
    }
  });

  // INVARIANT (see file header): `lazy start` creates nothing, and neither does
  // `lazy_start`. Inline creation was removed deliberately in
  // `remove-start-inline-create` (commit a709663) because a task created and
  // started in one step cannot have a forgotten --parent/--code corrected. This
  // pins the schema so the flags cannot be re-added without a human noticing.
  // Rationale: public-docs/surface-asymmetries.md section 9.
  test('lazy_start advertises NO creation parameters', () => {
    const props = toolNamed('lazy_start').inputSchema.properties ?? {};

    for (const creationParam of ['goal', 'prompt', 'code', 'type', 'parent']) {
      expect(props[creationParam], `lazy_start must not accept '${creationParam}'`).toBeUndefined();
    }
  });

  // --- boundary validation ---

  test('lazy_start rejects an unknown effort level before launching', async () => {
    const handlers = createAllHandlers(ctx);
    const created = await handlers.get('lazy_create')!({ goal: 'Effort task' });

    await expect(
      handlers.get('lazy_start')!({ task_id: (created as any).full_id, effort: 'banana' }),
    ).rejects.toThrow(/Invalid effort 'banana'/);

    // Rejected at the boundary: nothing was launched, so the task is untouched.
    const task = await storage.getTask((created as any).full_id);
    expect(task?.status).toBe('backlog');
    expect(task?.metadata?.effort).toBeUndefined();
  });

  test('lazy_ask rejects an unknown effort level', async () => {
    const handlers = createAllHandlers(ctx);
    const created = await handlers.get('lazy_create')!({ goal: 'Ask task' });

    // Must fail on effort, NOT on the later "no session" precondition —
    // validation happens before the task is even resolved.
    await expect(
      handlers.get('lazy_ask')!({ task_id: (created as any).full_id, message: 'hi', effort: 'turbo' }),
    ).rejects.toThrow(/Invalid effort 'turbo'/);
  });

  test('lazy_start rejects an unknown agent before launching', async () => {
    const handlers = createAllHandlers(ctx);
    const created = await handlers.get('lazy_create')!({ goal: 'Agent task' });

    await expect(
      handlers.get('lazy_start')!({ task_id: (created as any).full_id, agent: 'not-a-real-agent' }),
    ).rejects.toThrow(/Unknown agent 'not-a-real-agent'/);

    const task = await storage.getTask((created as any).full_id);
    expect(task?.status).toBe('backlog');
  });

  // Guard the guard: if listAgents() ever returned nothing, every agent value
  // would be rejected and the test above would pass for the wrong reason.
  test('the agent registry is non-empty', () => {
    expect(listAgents().length).toBeGreaterThan(0);
  });
});
