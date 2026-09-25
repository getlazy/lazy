/**
 * INVARIANT: Raised items are (a) TASK-level — they live on the task,
 * independent of any session/turn, so they survive auto-turns and auto-resumes;
 * and (b) NON-TRIGGERING — recording one fires NO comment, status change, or
 * signal, so it can never kick off an auto-turn/auto-resume. That non-triggering
 * property is exactly what distinguishes raised items from comments: comments feed
 * the comment auto-react loop (daemon/auto-react.ts reads getTaskComments), which
 * would spuriously resume the agent — the "lost turn" failure this entity exists
 * to avoid. See CLAUDE.md and the RaisedItem type doc in src/types/index.ts.
 *
 * Both flags live in ONE store: `blocking: true` is what used to be a raised
 * item and gates accept; `blocking: false` is what used to be a follow-up and
 * never gates. See docs/design/raised-items-unified.md.
 *
 * Do NOT weaken these tests to match a change that routes raised items through
 * comments or that mutates task state on write — that would reintroduce the bug.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { Task } from '../../src/types';

describe('task-level raised items', () => {
  let testDir: string;
  let storage: Storage;
  let task: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-raised-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

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

  test('a raised item persists at task level, independent of sessions/turns', async () => {
    const handlers = createAllHandlers(ctxForTask());
    const raise = handlers.get('lazy_raise')!;

    const res = (await raise({
      blocking: true,
      content: 'Should the new flag default on?',
    })) as any;
    expect(res.id).toBeDefined();
    expect(res.content).toBe('Should the new flag default on?');

    // INVARIANT (task-level): stored against the task itself, with no session
    // required. This is why raised items survive auto-turns/auto-resumes — they
    // are not tied to the turn that created them.
    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised).toHaveLength(1);
    expect(raised[0].content).toBe('Should the new flag default on?');
    expect(raised[0].task_id).toBe(task.id);
    expect(raised[0].blocking).toBe(true);
  });

  // INVARIANT: `blocking` has NO default. Whether an item holds up accept is a
  // judgement the agent must make explicitly — guessing it either wedges a task
  // that should have shipped or lets a real question through the gate.
  test('lazy_raise refuses to guess the blocking flag', async () => {
    const handlers = createAllHandlers(ctxForTask());
    const raise = handlers.get('lazy_raise')!;

    await expect(raise({ content: 'Should this gate or not?' })).rejects.toThrow(/blocking/);
    expect(await storage.getTaskRaisedItems(task.id)).toHaveLength(0);
  });

  // INVARIANT: a non-blocking raised item is what a "follow-up" is now — one
  // store, one entity, no second code path. The pre-unification aliases
  // (lazy_add_followup / lazy_followups / lazy_followup_promote) are gone; if
  // one reappears it must not bring a parallel record with it.
  test('a non-blocking raised item is recorded as one raised item', async () => {
    const handlers = createAllHandlers(ctxForTask());
    expect(handlers.has('lazy_add_followup')).toBe(false);
    await (handlers.get('lazy_raise')!)({ blocking: false, content: 'orthogonal cleanup idea' });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised).toHaveLength(1);
    expect(raised[0].content).toBe('orthogonal cleanup idea');
    expect(raised[0].blocking).toBe(false);
  });

  test('raised items survive a fresh storage instance (cross-turn durability)', async () => {
    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_raise')!)({ blocking: false, content: 'first' });
    await (handlers.get('lazy_raise')!)({ blocking: true, content: 'second' });

    // A later turn / auto-resume reopens storage from scratch — the items must
    // still be there, in order, with their flags intact.
    await storage.close();
    storage = await createStorage(testDir, { backend: 'external' });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised.map(r => [r.content, r.blocking])).toEqual([
      ['first', false],
      ['second', true],
    ]);
  });

  test('recording a raised item does NOT trigger a resume/auto-turn', async () => {
    const statusBefore = (await storage.getTask(task.id))!.status;

    const handlers = createAllHandlers(ctxForTask());
    // The blocking flag makes no difference here: neither kind may touch the
    // auto-react loop.
    await (handlers.get('lazy_raise')!)({ blocking: true, content: 'a real question' });
    await (handlers.get('lazy_raise')!)({ blocking: false, content: 'orthogonal cleanup' });

    // ASSERT AGAINST THE AUTO-REACT PATH: daemon/auto-react.ts decides whether to
    // resume an agent by reading the task's COMMENTS (storage.getTaskComments).
    // A raised item must add ZERO comments, so it can never enter that loop —
    // this is the whole reason raised items are not comments.
    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(0);

    // And it must not mutate task state (no status change → nothing for the
    // reconciler to react to).
    const statusAfter = (await storage.getTask(task.id))!.status;
    expect(statusAfter).toBe(statusBefore);
  });

  // INVARIANT: ONE array in lazy_show, carrying the flag — never a `raised_items`
  // list beside a `follow_ups` list. A reviewer reads one queue.
  test('lazy_show surfaces every raised item in one array with its flag', async () => {
    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_raise')!)({ blocking: true, content: 'gating question' });
    await (handlers.get('lazy_raise')!)({ blocking: false, content: 'orthogonal proposal' });

    const show = handlers.get('lazy_show')!;
    const result = (await show({ task_id: task.id })) as any;

    // Always included so the builder sees them at review without drilling in.
    expect(result.raised_item_count).toBe(2);
    expect(result.raised_items).toBeDefined();
    expect(result.raised_items.map((r: any) => [r.content, r.blocking])).toEqual([
      ['gating question', true],
      ['orthogonal proposal', false],
    ]);
    expect(result.follow_ups).toBeUndefined();
    expect(result.follow_up_count).toBeUndefined();
  });

  test('structured proposal fields are stored on a raised item of either flag', async () => {
    const handlers = createAllHandlers(ctxForTask());

    const res = (await (handlers.get('lazy_raise')!)({
      blocking: false,
      title: 'Extract retry helper',
      explanation: 'Three sites duplicate backoff.',
      proposed_code: 'extract-retry',
      proposed_prompt: 'Move retry logic to shared module.',
    })) as any;

    expect(res.title).toBe('Extract retry helper');
    expect(res.proposed_code).toBe('extract-retry');
    expect(res.proposed_prompt).toContain('shared module');

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised[0].title).toBe('Extract retry helper');
    expect(raised[0].proposed_code).toBe('extract-retry');
    expect(raised[0].blocking).toBe(false);
  });

  // INVARIANT: `title` and `content` are INDEPENDENT fields end to end. An
  // agent that files an item the recommended way — one-line headline in
  // `title`, the substance in `content` — must get BOTH back.
  //
  // Regression: normalizeRaisedCreateInput used to compose the stored content
  // from title+explanation whenever a title was present, so the body the agent
  // wrote was replaced by its own headline at write time, with no error on any
  // surface. The human read a one-line item and never learned the rest had been
  // destroyed. Never re-derive `content` when the caller supplied one.
  test('lazy_raise round-trips title AND content together — neither clobbers the other', async () => {
    const handlers = createAllHandlers(ctxForTask());

    const body =
      'The retry path swallows errors.\n\n' +
      'Reproduced twice: paths, instructions and rationale are all lost.';

    const res = (await (handlers.get('lazy_raise')!)({
      blocking: false,
      title: 'Failed retries should surface, not vanish',
      content: body,
      explanation: 'Operators see a green run that did nothing.',
    })) as any;

    expect(res.title).toBe('Failed retries should surface, not vanish');
    expect(res.content).toBe(body);
    expect(res.explanation).toBe('Operators see a green run that did nothing.');

    // On disk, and after a fresh storage instance — a later turn or the review
    // page must read the same three fields.
    await storage.close();
    storage = await createStorage(testDir, { backend: 'external' });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised).toHaveLength(1);
    expect(raised[0].title).toBe('Failed retries should surface, not vanish');
    expect(raised[0].content).toBe(body);
    expect(raised[0].explanation).toBe('Operators see a green run that did nothing.');

    // And through the surface an agent reads back.
    const show = (await (handlers.get('lazy_show')!)({ task_id: task.id })) as any;
    expect(show.raised_items[0].content).toBe(body);
    expect(show.raised_items[0].title).toBe('Failed retries should surface, not vanish');
  });

  // The derivation is a FALLBACK, not the rule: with no body of its own an item
  // still needs non-empty content, so title+explanation compose it as before.
  test('content is derived from title only when the caller supplied no body', async () => {
    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_raise')!)({
      blocking: true,
      title: 'Stale credentials should fail loudly',
      explanation: 'Today the run hangs instead.',
    });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised[0].content).toBe(
      'Stale credentials should fail loudly\n\nToday the run hangs instead.',
    );
  });

  // Dedupe keys on the item, not on one of its fields: same body under two
  // different headlines is two items, and swallowing the second would lose the
  // agent's text exactly the way the clobber did.
  test('two items sharing a body but not a title are both kept', async () => {
    const handlers = createAllHandlers(ctxForTask());
    const raise = handlers.get('lazy_raise')!;

    await raise({ blocking: false, title: 'First headline', content: 'same body' });
    await raise({ blocking: false, title: 'Second headline', content: 'same body' });
    // Identical title AND body is still one item (idempotent re-raise).
    await raise({ blocking: false, title: 'Second headline', content: 'same body' });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised.map(r => r.title)).toEqual(['First headline', 'Second headline']);
  });

  // INVARIANT: blocking and non-blocking items share one entity_type in search.
  // The flag is a property of the item, not a different kind of thing.
  test('storage.search finds a raised item by content (plain-regex search path)', async () => {
    await storage.createRaisedItem(task.id, {
      blocking: false,
      content: 'Extract the retry helper into a shared module',
      session_id: null,
    });

    const results = await storage.search('retry helper');
    const hit = results.find(r => r.entity_type === 'raised');
    expect(hit).toBeDefined();
    expect(hit!.task_id).toBe(task.id);
    expect(hit!.content).toContain('retry helper');
  });

  // INVARIANT: Multi-paragraph raised content preserves its newlines on disk.
  // The collapsed (single-space) form is only for dedupe keys, not stored content.
  // Regression: the create path once ran normalizeRaisedContent on string input,
  // which collapsed all whitespace — multi-paragraph notes rendered as one
  // run-on paragraph through the markdown renderer.
  test('multi-paragraph note round-trips with newlines preserved', async () => {
    const twoParas = 'First paragraph about the issue.\n\nSecond paragraph with details.';

    const handlers = createAllHandlers(ctxForTask());
    await (handlers.get('lazy_raise')!)({ blocking: false, content: twoParas });

    const raised = await storage.getTaskRaisedItems(task.id);
    expect(raised).toHaveLength(1);
    expect(raised[0].content).toBe(twoParas);
    expect(raised[0].content).toContain('\n\n');
  });

  // INVARIANT: agent comments on a raise are passive — append-only, never
  // resolve status, never fire a signal/auto-turn. That is why they are not
  // dismiss and not task Comments.
  test('addRaisedItemComment appends without resolving', async () => {
    const item = await storage.createRaisedItem(task.id, {
      blocking: true,
      content: 'Should the default stay off?',
    });
    expect(item.status).toBe('open');

    const updated = await storage.addRaisedItemComment(task.id, item.id, {
      content: 'Disagree — default off is correct for alpha.',
      actor: 'agent',
      turn_sequence: 3,
    });
    expect(updated.status).toBe('open');
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0]!.content).toContain('Disagree');
    expect(updated.comments![0]!.actor).toBe('agent');
    expect(updated.comments![0]!.turn_sequence).toBe(3);

    const again = await storage.addRaisedItemComment(task.id, item.id.slice(0, 8), {
      content: 'Also fixed related docs.',
      actor: 'agent',
    });
    expect(again.status).toBe('open');
    expect(again.comments).toHaveLength(2);

    const handlers = createAllHandlers(ctxForTask());
    const comment = handlers.get('lazy_raised_item_comment')!;
    const result = await comment({
      item_id: item.id.slice(0, 8),
      content: 'Via MCP: leaving open for human triage.',
    }) as { comment_count: number; status: string };
    expect(result.status).toBe('open');
    expect(result.comment_count).toBe(3);

    const reloaded = await storage.getTaskRaisedItems(task.id);
    expect(reloaded[0]!.comments).toHaveLength(3);
  });
});
