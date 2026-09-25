/**
 * INVARIANT: there is ONE resolver for "this task's current prompt", and every
 * surface uses it.
 *
 * The reported failure (builder session, 2026-08-25): a task was created with
 * prompt v1, edited to v2 while still in backlog, then started. Storage held
 * v2, the agent ran on v2, `lazy_search` indexed v2 — and `lazy_show`'s
 * top-level `prompt` field alone reported v1, contradicting the `turns` array
 * in the SAME response. A reviewer reading v1 next to a diff produced from v2
 * concludes the agent went off-instruction when it did exactly as told.
 *
 * Cause: `Storage.getPromptHistory` has no stated ordering and the two backends
 * disagree — FileStorage sorts newest-first, PostgresStorage oldest-first —
 * while five callers took `history[history.length - 1]` to mean "current".
 * On the default file backend that is the ORIGINAL prompt. `lazy_show` merely
 * displayed it; `clone`/`redo` went further and seeded the new task with it,
 * so the superseded text was executed.
 *
 * Fix: `currentPromptOf(task)` (src/task-prompt.ts) reads `task.prompt`, which
 * `updateTaskPrompt` writes in the same operation as the history entry. The
 * backend ordering divergence is left alone on purpose — aligning it would edit
 * an assertion in an invariant test (test/unit/storage-concurrent-writes.test.ts)
 * and that needs human approval. Nobody depends on the order any more.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { currentPromptOf } from '../../src/task-prompt';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const V1 = 'ORIGINAL PROMPT\n\n## Note on your own worktree\nYou are a child of release-v022.';
const V2 = 'EDITED PROMPT\n\nYou are targeting `main`, deliberately.\n\n## One hazard to watch\n...';

describe('current prompt resolution', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-current-prompt-'));
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

  test('lazy_show reports the edited prompt, not the original', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Edited task', prompt: V1 });

    await handlers.get('lazy_edit')!({ task_id: created.id, prompt: V2 });

    const shown: any = await handlers.get('lazy_show')!({ task_id: created.id });
    expect(shown.prompt).toBe(V2);
  });

  // The shape the incident took: the edit landed BEFORE the first turn, so the
  // agent ran on v2. `prompt` and `turns` are read from the same response and
  // must not contradict each other.
  test('lazy_show prompt agrees with the turn the agent actually received', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Started task', prompt: V1 });
    await handlers.get('lazy_edit')!({ task_id: created.id, prompt: V2 });

    // Stand in for `lazy start`: launch composes turn 1 from the task's current
    // prompt (src/daemon/task-launcher.ts), which is v2.
    const task = (await storage.getTask(created.id))!;
    const session = await storage.createSession(task.id, task.agent_id, 'lazy/started-task', 'deadbeef');
    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'human',
      content: currentPromptOf(task)!,
      actor: 'builder',
    });

    const shown: any = await handlers.get('lazy_show')!({ task_id: created.id, sections: ['turns'] });
    expect(shown.prompt).toBe(V2);
    expect(shown.turns[0].content).toBe(V2);
    expect(shown.prompt).toBe(shown.turns[0].content);
  });

  // Worse than a misreport: clone EXECUTES whatever prompt it inherits.
  test('lazy_clone inherits the edited prompt', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Cloneable task', prompt: V1 });
    await handlers.get('lazy_edit')!({ task_id: created.id, prompt: V2 });

    const clone: any = await handlers.get('lazy_clone')!({ task_id: created.id });

    const shown: any = await handlers.get('lazy_show')!({ task_id: clone.id });
    expect(shown.prompt).toBe(V2);
  });

  test('a task with no prompt reports none rather than an empty string', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Promptless task' });

    const shown: any = await handlers.get('lazy_show')!({ task_id: created.id });
    expect(shown.prompt).toBeUndefined();

    expect(currentPromptOf((await storage.getTask(created.id))!)).toBeNull();
  });

  // Versioning is deliberate — the fix must not "solve" the stale read by
  // dropping superseded versions. Note this asserts nothing about the ORDER of
  // getPromptHistory: that is backend-dependent (FileStorage newest-first,
  // Postgres oldest-first) and is exactly the trap `currentPromptOf` exists to
  // keep callers out of. Sort by version if you care.
  test('every prompt version survives an edit and stays addressable', async () => {
    const task = await storage.createTask('History task');
    await storage.updateTaskPrompt(task.id, V1);
    await storage.updateTaskPrompt(task.id, V2);

    const history = await storage.getPromptHistory(task.id);
    const byVersion = [...history].sort((a, b) => a.version - b.version);
    expect(byVersion.map((v) => v.version)).toEqual([1, 2]);
    expect(byVersion.map((v) => v.content)).toEqual([V1, V2]);

    // Superseded versions stay individually addressable (the web
    // /tasks/:id/prompts/:version route).
    expect((await storage.getPromptVersion(task.id, 1))!.content).toBe(V1);

    // ...while the current prompt comes from the resolver, not the array.
    expect(currentPromptOf((await storage.getTask(task.id))!)).toBe(V2);
  });
});
