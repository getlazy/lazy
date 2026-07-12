/**
 * INVARIANT: Task-level follow-ups are (a) TASK-level — they live on the task,
 * independent of any session/turn, so they survive auto-turns and auto-resumes;
 * and (b) NON-TRIGGERING — recording one fires NO comment, status change, or
 * signal, so it can never kick off an auto-turn/auto-resume. That non-triggering
 * property is exactly what distinguishes follow-ups from comments: comments feed
 * the comment auto-react loop (daemon/auto-react.ts reads getTaskComments), which
 * would spuriously resume the agent — the "lost turn" failure follow-ups exist to
 * avoid. See CLAUDE.md and the FollowUp type doc in src/types/index.ts.
 *
 * Do NOT weaken these tests to match a change that routes follow-ups through
 * comments or that mutates task state on write — that would reintroduce the bug.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';
import type { Task } from '../../src/types';

describe('task-level follow-ups', () => {
  let testDir: string;
  let storage: Storage;
  let task: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-followup-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    task = await storage.createTask('Test task', undefined, undefined, 'test-task');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  function ctxForTask(): McpToolContext {
    return { taskId: task.id, worktreePath: testDir, storage };
  }

  test('a follow-up persists at task level, independent of sessions/turns', async () => {
    const handlers = createAllHandlers(ctxForTask());
    const add = handlers.get('lazy_add_followup')!;

    const res = (await add({ note: 'Extract the retry helper into a shared module' })) as any;
    expect(res.id).toBeDefined();
    expect(res.content).toBe('Extract the retry helper into a shared module');

    // INVARIANT (task-level): stored against the task itself, with no session
    // required. This is why follow-ups survive auto-turns/auto-resumes — they are
    // not tied to the turn that created them (unlike the old turn-level proposals).
    const followUps = await storage.getTaskFollowUps(task.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].content).toBe('Extract the retry helper into a shared module');
    expect(followUps[0].task_id).toBe(task.id);
  });

  test('follow-ups survive a fresh storage instance (cross-turn durability)', async () => {
    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_add_followup')!)({ note: 'first' });
    await (handlers.get('lazy_add_followup')!)({ note: 'second' });

    // A later turn / auto-resume reopens storage from scratch — the follow-ups
    // must still be there, in order.
    await storage.close();
    storage = await createStorage(testDir, { backend: 'external' });

    const followUps = await storage.getTaskFollowUps(task.id);
    expect(followUps.map(f => f.content)).toEqual(['first', 'second']);
  });

  test('recording a follow-up does NOT trigger a resume/auto-turn', async () => {
    const statusBefore = (await storage.getTask(task.id))!.status;

    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_add_followup')!)({ note: 'orthogonal cleanup' });

    // ASSERT AGAINST THE AUTO-REACT PATH: daemon/auto-react.ts decides whether to
    // resume an agent by reading the task's COMMENTS (storage.getTaskComments).
    // A follow-up must add ZERO comments, so it can never enter that loop — this
    // is the whole reason follow-ups are not comments.
    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(0);

    // And it must not mutate task state (no status change → nothing for the
    // reconciler to react to).
    const statusAfter = (await storage.getTask(task.id))!.status;
    expect(statusAfter).toBe(statusBefore);
  });

  test('lazy_show surfaces follow-ups (the builder triage queue)', async () => {
    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_add_followup')!)({ note: 'follow-up A' });
    await (handlers.get('lazy_add_followup')!)({ note: 'follow-up B' });

    const show = handlers.get('lazy_show')!;
    const result = (await show({ task_id: task.id })) as any;

    // Always included so the builder sees them at review without drilling in.
    expect(result.follow_up_count).toBe(2);
    expect(result.follow_ups).toBeDefined();
    expect(result.follow_ups.map((f: any) => f.content)).toEqual(['follow-up A', 'follow-up B']);
  });

  test('storage.search finds a follow-up by content (plain-regex search path)', async () => {
    await storage.createFollowUp(task.id, 'Extract the retry helper into a shared module', null);

    const results = await storage.search('retry helper');
    const followUpHit = results.find(r => r.entity_type === 'followup');
    expect(followUpHit).toBeDefined();
    expect(followUpHit!.task_id).toBe(task.id);
    expect(followUpHit!.content).toContain('retry helper');
  });
});
