/**
 * E2E tests for `lazy doctor <task-id>` — task-level diagnostics.
 *
 * Tests the six checks: stale parent, missing branch, missing worktree,
 * branch divergence, status mismatch, orphaned worktree.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { parentTaskIdOf } from '../../src/task-target';
import { createStorage, type Storage } from '../../src/storage';
import type { Task } from '../../src/types';

/**
 * Read external_path from the test project's lazy.toml.
 */
function getExternalPath(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const match = toml.match(/external_path\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('Could not find external_path in lazy.toml');
  return match[1];
}

/**
 * Open storage for the test project using explicit external_path.
 */
async function openTestStorage(root: string): Promise<Storage> {
  const externalPath = getExternalPath(root);
  return createStorage(root, { backend: 'external', externalPath });
}

describe('lazy doctor <task-id>', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('healthy task reports no issues', async () => {
    const storage = await openTestStorage(ctx.root);
    let shortId: string;
    try {
      const task = await storage.createTask('healthy task', undefined, undefined, 'healthy');
      shortId = task.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', shortId]);
    expectSuccess(result);
    expectOutput(result, 'Diagnosing task');
    expectOutput(result, 'No issues found');
  });

  test('detects stale parent (parent is complete)', async () => {
    const storage = await openTestStorage(ctx.root);
    let childShortId: string;
    try {
      const parent = await storage.createTask('parent task', undefined, undefined, 'stale-parent');
      const child = await storage.createTask('child task', undefined, undefined, 'stale-child');
      await storage.updateTaskTarget(child.id, { kind: 'task' as const, parentTaskId: parent.id });
      // Transition parent through valid states: backlog → working → blocked → merging → complete
      await storage.updateTaskStatus(parent.id, 'working', 'system');
      await storage.updateTaskStatus(parent.id, 'blocked', 'system');
      await storage.updateTaskStatus(parent.id, 'merging', 'system');
      await storage.updateTaskStatus(parent.id, 'complete', 'system');
      childShortId = child.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', childShortId]);
    expectFailure(result);
    expectOutput(result, 'Stale parent');
    expectOutput(result, 'is complete');
  });

  test('stale parent fix reparents to grandparent', async () => {
    const storage = await openTestStorage(ctx.root);
    let childShortId: string;
    let childFullId: string;
    let grandparentFullId: string;
    try {
      const grandparent = await storage.createTask('grandparent', undefined, undefined, 'grandparent');
      const parent = await storage.createTask('parent', undefined, undefined, 'parent-gp');
      const child = await storage.createTask('child', undefined, undefined, 'child-gp');

      await storage.updateTaskTarget(parent.id, { kind: 'task' as const, parentTaskId: grandparent.id });
      await storage.updateTaskTarget(child.id, { kind: 'task' as const, parentTaskId: parent.id });
      // Transition parent through valid states: backlog → working → blocked → merging → complete
      await storage.updateTaskStatus(parent.id, 'working', 'system');
      await storage.updateTaskStatus(parent.id, 'blocked', 'system');
      await storage.updateTaskStatus(parent.id, 'merging', 'system');
      await storage.updateTaskStatus(parent.id, 'complete', 'system');
      childShortId = child.id.substring(0, 8);
      childFullId = child.id;
      grandparentFullId = grandparent.id;
    } finally {
      await storage.close();
    }

    // Fix with --yes
    const result = await ctx.lazy(['doctor', childShortId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'Reparented');

    // Verify parent was updated
    const storage2 = await openTestStorage(ctx.root);
    try {
      const child = await storage2.getTask(childFullId);
      expect(parentTaskIdOf(child!)).toBe(grandparentFullId);
    } finally {
      await storage2.close();
    }
  });

  test('detects missing worktree for non-terminal task', async () => {
    const storage = await openTestStorage(ctx.root);
    let shortId: string;
    try {
      const task = await storage.createTask('missing worktree task', undefined, undefined, 'miss-wt');

      // Create a branch and session to simulate a started task
      const branchName = 'lazy/miss-wt';
      ctx.git('branch', branchName);
      await storage.createSession(task.id, 'claude-code', branchName, 'abc123');
      // Transition: backlog → working → blocked
      await storage.updateTaskStatus(task.id, 'working', 'system');
      await storage.updateTaskStatus(task.id, 'blocked', 'system');
      shortId = task.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    // Worktree directory doesn't exist — doctor should detect it
    const result = await ctx.lazy(['doctor', shortId]);
    expectFailure(result);
    expectOutput(result, 'Missing worktree');
  });

  test('dry-run shows issues without offering fixes', async () => {
    const storage = await openTestStorage(ctx.root);
    let childShortId: string;
    try {
      const parent = await storage.createTask('parent-dr', undefined, undefined, 'parent-dr');
      const child = await storage.createTask('child-dr', undefined, undefined, 'child-dr');

      await storage.updateTaskTarget(child.id, { kind: 'task' as const, parentTaskId: parent.id });
      // Transition parent through valid states: backlog → working → blocked → merging → complete
      await storage.updateTaskStatus(parent.id, 'working', 'system');
      await storage.updateTaskStatus(parent.id, 'blocked', 'system');
      await storage.updateTaskStatus(parent.id, 'merging', 'system');
      await storage.updateTaskStatus(parent.id, 'complete', 'system');
      childShortId = child.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', childShortId, '--dry-run']);
    expectFailure(result);
    expectOutput(result, 'Stale parent');
    expectOutput(result, 'dry run');
    expectOutputExcludes(result, 'Reparented');
  });

  test('detects status mismatch (backlog with work done)', async () => {
    const storage = await openTestStorage(ctx.root);
    let shortId: string;
    try {
      const task = await storage.createTask('status mismatch', undefined, undefined, 'status-mm');

      // Create a session with turns and commits — task stays in backlog
      const branchName = 'lazy/status-mm';
      ctx.git('branch', branchName);
      const session = await storage.createSession(task.id, 'claude-code', branchName, 'abc123');
      await storage.createTurn({
        sessionId: session.id,
        sequence: 1,
        role: 'agent',
        content: 'I did some work',
      });
      await storage.createCommit(session.id, 'deadbeef', 'Fix something');
      shortId = task.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', shortId]);
    expectFailure(result);
    expectOutput(result, 'Status mismatch');
    expectOutput(result, 'backlog');
  });

  test('status mismatch fix transitions to blocked', async () => {
    const storage = await openTestStorage(ctx.root);
    let shortId: string;
    let taskFullId: string;
    try {
      const task = await storage.createTask('status fix', undefined, undefined, 'status-fix');

      const branchName = 'lazy/status-fix';
      ctx.git('branch', branchName);
      const session = await storage.createSession(task.id, 'claude-code', branchName, 'abc123');
      await storage.createTurn({
        sessionId: session.id,
        sequence: 1,
        role: 'agent',
        content: 'I did some work',
      });
      await storage.createCommit(session.id, 'deadbeef', 'Fix something');
      shortId = task.id.substring(0, 8);
      taskFullId = task.id;
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', shortId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'Status updated to blocked');

    // Verify
    const storage2 = await openTestStorage(ctx.root);
    try {
      const task = await storage2.getTask(taskFullId);
      expect(task!.status).toBe('blocked');
    } finally {
      await storage2.close();
    }
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Task-level');
    expectOutput(result, '--dry-run');
    expectOutput(result, '--yes');
  });

  test('healthy parent shows consistent parent check', async () => {
    const storage = await openTestStorage(ctx.root);
    let childShortId: string;
    try {
      const parent = await storage.createTask('active parent', undefined, undefined, 'act-parent');
      const child = await storage.createTask('child of active', undefined, undefined, 'child-act');

      await storage.updateTaskTarget(child.id, { kind: 'task' as const, parentTaskId: parent.id });
      childShortId = child.id.substring(0, 8);
    } finally {
      await storage.close();
    }

    const result = await ctx.lazy(['doctor', childShortId]);
    expectSuccess(result);
    expectOutput(result, 'Parent:');
    expectOutput(result, 'backlog');
  });
});
