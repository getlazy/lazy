/**
 * Unit tests for the MCP `lazy_edit` guard on started tasks.
 *
 * The MCP surface must mirror the `lazy edit` CLI: once a task has turns,
 * goal/prompt/type/code/parent edits are rejected, but model and effort edits
 * are allowed. That model-only exemption is the supported way to durably change a
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

  // INVARIANT: effort is editable on a started task, like model. It PERSISTS
  // on the task (lazy start --effort writes it), so a turn that ran at max
  // would otherwise pin the task there with no way down from this surface.
  test('effort-only edit succeeds on a task with turns and persists', async () => {
    const result = await handler()({ task_id: task.id, effort: 'medium' }) as { changes: string[] };
    expect(result.changes).toEqual(['effort']);

    const verify = new FileStorage(lazyRoot, { basePath });
    await verify.initialize();
    try {
      const updated = await verify.getTask(task.id);
      expect(updated?.metadata?.effort).toBe('medium');
    } finally {
      await verify.close();
    }
  });

  // An invalid level is refused with the same value set the CLI enforces —
  // the schema enum is advisory, the handler is the real boundary.
  test('invalid effort is rejected', async () => {
    await expect(handler()({ task_id: task.id, effort: 'banana' }))
      .rejects.toThrow(/Invalid effort 'banana'/);
  });

  // INVARIANT: Non-model fields stay frozen once the task has turns —
  // changing goal/prompt/etc. mid-flight is unsafe. The error names the one
  // allowed change so the caller knows what IS possible.
  test('goal edit is rejected on a task with turns', async () => {
    await expect(handler()({ task_id: task.id, goal: 'New goal' }))
      .rejects.toThrow(/only model, effort and review mode can be changed/);
  });

  // INVARIANT: The model-only exemption does not extend to combined edits —
  // model together with a disallowed field is rejected as a whole, nothing
  // partially applied.
  test('model combined with goal is rejected on a task with turns', async () => {
    await expect(handler()({ task_id: task.id, model: 'claude-haiku-4-5-20251001', goal: 'New goal' }))
      .rejects.toThrow(/only model, effort and review mode can be changed/);

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

/*
 * AN AGENT MAY NOT CHANGE ITS OWN TASK'S REVIEW SETTINGS.
 *
 * Found by a cold review of this branch, and it is the reason the rule exists
 * rather than a hypothetical: `assertAgentMayTarget` permits self-targeting and
 * the review arguments are mid-flight-safe, so a working agent could have
 * called `lazy_edit(task_id: <its own>, review_gate: "never")` and the review
 * of its own work would have stopped holding accept. That is
 * `lazy accept --allow-review-issues` — CLI/TTY-only precisely so no agent can
 * wave away a review of its own work — reached through another door.
 *
 * A DIRECT SUBTASK stays allowed: a cluster driver deciding how its CHILD is
 * reviewed is arranging work it is responsible for, not overruling a verdict on
 * itself. The two differ by exactly one comparison, and both halves are pinned.
 */
describe('MCP lazy_edit review settings — own task vs a subtask', () => {
  beforeEach(setupStartedTask);

  afterEach(async () => {
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  /** The handler as the agent RUNNING `task` — `ctx.taskId` is its own id. */
  function asOwnAgent() {
    return createEditHandler({ taskId: task.id, worktreePath: lazyRoot, storage });
  }

  for (const [name, args] of [
    ['review', { review: 'off' }],
    ['review_gate', { review_gate: 'never' }],
    ['review_auto_fix', { review_auto_fix: false }],
  ] as const) {
    test(`refuses ${name} on the caller's own task`, async () => {
      await expect(asOwnAgent()({ task_id: task.id, ...args }))
        .rejects.toThrow(/cannot change their OWN task's review settings/);
    });
  }

  // Nothing else about self-editing changed: model and effort are still the
  // supported mid-flight dials, and refusing the review args must not take
  // them with it.
  test('still allows model and effort on the caller\'s own task', async () => {
    const result = await asOwnAgent()({
      task_id: task.id, model: 'claude-haiku-4-5-20251001', effort: 'high',
    }) as { changes: string[] };
    expect(result.changes).toEqual(expect.arrayContaining(['model', 'effort']));
  });

  test('allows the review settings on a DIRECT SUBTASK', async () => {
    const child = await storage.createTask('Child goal', task.id);
    const driver = createEditHandler({ taskId: task.id, worktreePath: lazyRoot, storage });

    const result = await driver({ task_id: child.id, review: 'separate' }) as { changes: string[] };
    expect(result.changes).toContain('review');

    const verify = new FileStorage(lazyRoot, { basePath });
    await verify.initialize();
    try {
      expect((await verify.getTask(child.id))?.metadata?.review_mode).toBe('separate');
    } finally {
      await verify.close();
    }
  });
});
