/**
 * Unit tests for the MCP `lazy_edit` guard on started tasks.
 *
 * The MCP surface must mirror the `lazy edit` CLI: once a task has turns,
 * goal/prompt/type/code/parent edits are rejected, but a MODEL-ONLY edit is
 * allowed. That model-only exemption is the supported way to durably change a
 * running task's model — auto-resume/auto-deliver relaunch from task.model,
 * and a stale value there caused a real crash-loop incident (task relaunched
 * on a model that no longer existed).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { createEditHandler } from '../../src/mcp/tools';
import type { Task } from '../../src/types';

let lazyRoot: string;
let basePath: string;
let storage: FileStorage;
let task: Task;

async function setupStartedTask(): Promise<void> {
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-mcp-edit-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-mcp-edit-store-'));
  storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  task = await storage.createTask('Started task goal');
  await storage.updateTaskModel(task.id, 'claude-opus-4-6');
  const session = await storage.createSession(task.id, 'claude-code', 'lazy/test-branch', 'deadbeef');
  // One recorded turn = the agent has worked on the task.
  await storage.createTurn({
    sessionId: session.id,
    sequence: 1,
    role: 'human',
    content: 'Initial prompt',
  });
}

describe('MCP lazy_edit on started tasks', () => {
  beforeEach(setupStartedTask);

  afterEach(async () => {
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  function handler() {
    return createEditHandler({ taskId: '', worktreePath: lazyRoot, storage });
  }

  // INVARIANT: A model-only lazy_edit is allowed on a task with turns and
  // persists to task.model — same relaxation as the CLI, so both surfaces
  // give agents/builders a durable way to switch a started task's model.
  test('model-only edit succeeds on a task with turns and persists', async () => {
    const result = await handler()({ task_id: task.id, model: 'claude-haiku-4-5-20251001' }) as {
      changes: string[];
    };
    expect(result.changes).toEqual(['model']);

    const verify = new FileStorage(lazyRoot, { basePath });
    await verify.initialize();
    try {
      const updated = await verify.getTask(task.id);
      expect(updated?.model).toBe('claude-haiku-4-5-20251001');
    } finally {
      await verify.close();
    }
  });

  // INVARIANT: Non-model fields stay frozen once the task has turns —
  // changing goal/prompt/etc. mid-flight is unsafe. The error names the one
  // allowed change so the caller knows what IS possible.
  test('goal edit is rejected on a task with turns', async () => {
    await expect(handler()({ task_id: task.id, goal: 'New goal' }))
      .rejects.toThrow(/only model can be changed/);
  });

  // INVARIANT: The model-only exemption does not extend to combined edits —
  // model together with a disallowed field is rejected as a whole, nothing
  // partially applied.
  test('model combined with goal is rejected on a task with turns', async () => {
    await expect(handler()({ task_id: task.id, model: 'claude-haiku-4-5-20251001', goal: 'New goal' }))
      .rejects.toThrow(/only model can be changed/);

    const verify = new FileStorage(lazyRoot, { basePath });
    await verify.initialize();
    try {
      const updated = await verify.getTask(task.id);
      expect(updated?.model).toBe('claude-opus-4-6');
    } finally {
      await verify.close();
    }
  });
});
