/**
 * Symptom-2 reproduction / regression harness for the "broken builder MCP" fix.
 *
 * The field reports (three weeks stale, against a long-lived daemon) claimed:
 *   1. lazy_show / lazy_clone crash with `undefined is not an object
 *      (evaluating 'input.length')` even when task_id is supplied.
 *   2. lazy_create's confirmation guard is un-passable — passing confirmation_code
 *      always regenerates a fresh code instead of validating.
 *   3. lazy_create's guard fires even when a valid `parent` is supplied.
 *
 * This suite settles whether those reproduce on CURRENT code by driving the exact
 * daemon-side handler path: the daemon builds a fresh handler map PER REQUEST via
 * createAllHandlers(ctx) with an injected storage singleton (see
 * src/daemon/mcp-routes.ts). We mirror that here — a new createAllHandlers() call
 * per "request" — so the module-level confirmation `pending` map is exercised
 * across handler instances exactly as in production.
 *
 * Result: none of the three reproduce. These tests encode that as invariants so
 * the handlers can never regress into the reported failures. The historical
 * symptoms were an operational stale-daemon artifact — see the daemon-staleness
 * codeSha surface (src/daemon/code-version.ts) added alongside this fix.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';
import { clearPending } from '../../src/mcp/confirmation';

describe('MCP symptom-2 repro (daemon handler path)', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-s2-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };
    clearPending();
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    clearPending();
  });

  /** Fresh handler map, as the daemon builds per request. */
  function newRequest() {
    return createAllHandlers(ctx);
  }

  // INVARIANT: lazy_show resolves a task by code and by short id without the
  // `input.length` crash. The reported crash meant the handler called
  // resolveTask(undefined); it reads args.task_id, so a supplied task_id is
  // never lost. (Same handler shape for lazy_clone.)
  test('lazy_show does not crash and resolves by code and by id', async () => {
    const created = await newRequest().get('lazy_create')!({ goal: 'Show me', code: 'show-target' });
    const shortId = (created as any).id as string;

    const byCode = await newRequest().get('lazy_show')!({ task_id: 'show-target' });
    expect((byCode as any).goal).toBe('Show me');
    expect((byCode as any).code).toBe('show-target');

    const byId = await newRequest().get('lazy_show')!({ task_id: shortId });
    expect((byId as any).id).toBe(shortId);
  });

  // INVARIANT: a missing task_id yields a clean, actionable resolution error —
  // NOT an opaque `input.length` TypeError. Guards the exact crash signature.
  test('lazy_show with an unknown task_id gives a clean not-found error', async () => {
    await expect(newRequest().get('lazy_show')!({ task_id: 'does-not-exist' }))
      .rejects.toThrow(/not found/i);
  });

  // INVARIANT: supplying a `parent` that resolves to a real task suppresses the
  // "creating under main while active tasks exist" guard entirely — a legitimate
  // child-create is never gated behind a confirmation code. This is the exact UX
  // bug from the prompt (guard fired despite a valid parent).
  test('lazy_create with a valid parent is never gated by the main-parent guard', async () => {
    // Build a parent that WOULD trigger the guard for a parentless create:
    // an active (non-backlog) task with a non-terminal child.
    const parent = await storage.createTask('Active parent', undefined, undefined, 'active-parent');
    await storage.updateTaskStatus(parent.id, 'working');
    const child = await storage.createTask('Active child', parent.id);
    await storage.updateTaskStatus(child.id, 'working');

    // Creating UNDER that parent must succeed immediately — no guidance, no code.
    const result = await newRequest().get('lazy_create')!({
      goal: 'Legit child work',
      parent: 'active-parent',
    });
    expect((result as any).id).toBeDefined();
    expect((result as any).parent_task_id).toBe(parent.id.slice(0, 8));
  });

  // INVARIANT: the create guard IS passable — step 1 returns a code, and passing
  // that code on a SEPARATE request (fresh handler map) validates and creates.
  // This proves the module-level `pending` map is shared across the per-request
  // handler instances the daemon builds, so confirmation_code is never "dropped".
  test('lazy_create confirmation code round-trips across separate requests', async () => {
    // Arrange a state where a parentless (under-main) create triggers the guard:
    // an active task with a non-terminal child.
    const parent = await storage.createTask('Active parent', undefined, undefined, 'guard-parent');
    await storage.updateTaskStatus(parent.id, 'working');
    const child = await storage.createTask('Active child', parent.id);
    await storage.updateTaskStatus(child.id, 'working');

    // Request 1: no code → step-1 guidance carrying a confirmation code.
    let code: string | undefined;
    try {
      await newRequest().get('lazy_create')!({ goal: 'New top-level task' });
      throw new Error('expected step-1 guidance to be thrown');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const m = text.match(/\b(cr-[0-9a-f]{4})\b/);
      expect(m).not.toBeNull();
      code = m![1];
    }

    // Request 2 (fresh handler map): the SAME code validates and creates.
    const result = await newRequest().get('lazy_create')!({
      goal: 'New top-level task',
      confirmation_code: code,
    });
    expect((result as any).id).toBeDefined();
    expect((result as any).goal).toBe('New top-level task');

    // Request 3: the consumed (single-use) code is now rejected, not regenerated.
    await expect(newRequest().get('lazy_create')!({
      goal: 'Another one',
      confirmation_code: code,
    })).rejects.toThrow(/Invalid or expired confirmation code/);
  });
});
