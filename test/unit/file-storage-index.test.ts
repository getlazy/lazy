import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { FileStorage } from '../../src/storage/file-storage';
import { parentTaskIdOf, taskTarget, branchTarget, descendantCounts } from '../../src/task-target';
import type { Task, TaskTreeNode } from '../../src/storage/types';

/**
 * INVARIANT: FileStorage's in-memory task index is an optimization only —
 * getChildTasks / getTaskTree / session lookups must return exactly what the
 * un-indexed full-store scan returned, on every path that can mutate
 * parentage, sessions, or the set of tasks.
 *
 * The index caches IDS ONLY, so these tests check two separate things:
 *   1. equivalence with a reference implementation that rescans the store, and
 *   2. coherence of the cached ids after each mutating path, including the
 *      self-healing READ path in listTasksWithOptions (which writes task.json).
 */
describe('FileStorage task index', () => {
  let root: string;
  let base: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-fs-index-'));
    base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`,
    );
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  // --- Reference implementations: what the code did before the index ---

  /** The pre-index getChildTasks: filter a full store scan. */
  async function referenceChildren(parentTaskId: string): Promise<Task[]> {
    const all = await storage.listTasks();
    return all.filter((t) => parentTaskIdOf(t) === parentTaskId);
  }

  /** The pre-index getTaskTree: recurse, rescanning the store per node. */
  async function referenceTree(taskId: string, depth = 0): Promise<TaskTreeNode | null> {
    const task = await storage.getTask(taskId);
    if (!task) return null;
    const session = await storage.getSessionByTaskId(task.id);
    const children = await referenceChildren(task.id);
    const childNodes: TaskTreeNode[] = [];
    for (const child of children) {
      const node = await referenceTree(child.id, depth + 1);
      if (node) childNodes.push(node);
    }
    return { task, session, children: childNodes, depth };
  }

  /** Compare two trees structurally, ignoring sibling order. */
  function normalizeTree(node: TaskTreeNode): unknown {
    return {
      id: node.task.id,
      status: node.task.status,
      depth: node.depth,
      session: node.session?.id ?? null,
      children: node.children
        .map(normalizeTree)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }

  function ids(tasks: Task[]): string[] {
    return tasks.map((t) => t.id).sort();
  }

  async function buildFixture() {
    const root1 = await storage.createTask('root one');
    const childA = await storage.createTask('child a', root1.id);
    const childB = await storage.createTask('child b', root1.id);
    const grandchild = await storage.createTask('grandchild', childA.id);
    const root2 = await storage.createTask('root two');
    return { root1, childA, childB, grandchild, root2 };
  }

  // --- Equivalence ---

  test('getChildTasks and getTaskTree match the un-indexed reference', async () => {
    const f = await buildFixture();

    for (const t of [f.root1, f.childA, f.childB, f.grandchild, f.root2]) {
      expect(ids(await storage.getChildTasks(t.id))).toEqual(ids(await referenceChildren(t.id)));
    }

    const tree = await storage.getTaskTree(f.root1.id);
    const reference = await referenceTree(f.root1.id);
    expect(tree).not.toBeNull();
    expect(normalizeTree(tree!)).toEqual(normalizeTree(reference!));
  });

  test('a leaf task and an unknown task both yield no children', async () => {
    const f = await buildFixture();
    expect(await storage.getChildTasks(f.grandchild.id)).toEqual([]);
    expect(await storage.getChildTasks(randomUUID())).toEqual([]);
    expect(await storage.getTaskTree(randomUUID())).toBeNull();
  });

  test('children come back newest-first, as the full-scan filter did', async () => {
    const parent = await storage.createTask('parent');
    const older = await storage.createTask('older', parent.id);
    const newer = await storage.createTask('newer', parent.id);

    // createTask stamps Date.now(), so several tasks can share a millisecond.
    // Force distinct timestamps to make the ordering assertion meaningful.
    for (const [task, createdAt] of [[older, 1000], [newer, 2000]] as const) {
      const path = join(base, 'tasks', task.id, 'task.json');
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      raw.created_at = createdAt;
      writeFileSync(path, JSON.stringify(raw, null, 2));
    }

    const children = await storage.getChildTasks(parent.id);
    expect(children.map((t) => t.goal)).toEqual(['newer', 'older']);
    expect(children.map((t) => t.id)).toEqual((await referenceChildren(parent.id)).map((t) => t.id));
  });

  // --- Coherence across mutating paths ---

  test('a task created after the index is built appears in the tree', async () => {
    const parent = await storage.createTask('parent');
    // Build the index while the parent is childless.
    expect(await storage.getChildTasks(parent.id)).toEqual([]);

    const child = await storage.createTask('late child', parent.id);

    expect(ids(await storage.getChildTasks(parent.id))).toEqual([child.id]);
    const tree = await storage.getTaskTree(parent.id);
    expect(tree!.children.map((c) => c.task.id)).toEqual([child.id]);
  });

  test('reparenting moves the child in the index, both directions', async () => {
    const f = await buildFixture();
    // Build the index with the original shape.
    await storage.getTaskTree(f.root1.id);

    await storage.updateTaskTarget(f.grandchild.id, taskTarget(f.root2.id));

    expect(ids(await storage.getChildTasks(f.childA.id))).toEqual([]);
    expect(ids(await storage.getChildTasks(f.root2.id))).toEqual([f.grandchild.id]);
    expect(ids(await storage.getChildTasks(f.root2.id))).toEqual(
      ids(await referenceChildren(f.root2.id)),
    );

    // And reparenting onto a raw branch makes it a root again.
    await storage.updateTaskTarget(f.grandchild.id, branchTarget('main'));
    expect(ids(await storage.getChildTasks(f.root2.id))).toEqual([]);
    expect(await storage.getTaskTree(f.grandchild.id)).not.toBeNull();
  });

  test('a reparented subtree keeps its own children', async () => {
    const f = await buildFixture();
    await storage.getTaskTree(f.root1.id);

    await storage.updateTaskTarget(f.childA.id, taskTarget(f.root2.id));

    const tree = await storage.getTaskTree(f.root2.id);
    expect(tree!.children.map((c) => c.task.id)).toEqual([f.childA.id]);
    expect(tree!.children[0].children.map((c) => c.task.id)).toEqual([f.grandchild.id]);
    expect(normalizeTree(tree!)).toEqual(normalizeTree((await referenceTree(f.root2.id))!));
  });

  // --- Session index ---

  test('sessions resolve by full id and by prefix', async () => {
    const task = await storage.createTask('task');
    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');

    expect((await storage.getSession(session.id))?.id).toBe(session.id);
    expect((await storage.getSession(session.id.slice(0, 8)))?.id).toBe(session.id);
    expect(await storage.getSession(randomUUID())).toBeNull();
  });

  test('a session created after the index is built is found', async () => {
    const task = await storage.createTask('task');
    // Build the index while the task has no session.
    expect(await storage.getSession(randomUUID())).toBeNull();

    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    expect((await storage.getSession(session.id))?.id).toBe(session.id);
  });

  test('replacing a task session retires the old session id', async () => {
    const task = await storage.createTask('task');
    const first = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    expect((await storage.getSession(first.id))?.id).toBe(first.id);

    await storage.endSession(first.id, 'accepted');
    const second = await storage.createSession(task.id, 'claude-code', 'br2', 'sha2');

    expect((await storage.getSession(second.id))?.id).toBe(second.id);
    // session.json holds one session per task, so the first id is gone from
    // disk — the index must not keep resolving it.
    expect(await storage.getSession(first.id)).toBeNull();
  });

  test('session-keyed writes still land on the right task', async () => {
    const a = await storage.createTask('a');
    const b = await storage.createTask('b');
    const sessionA = await storage.createSession(a.id, 'claude-code', 'ba', 'sa');
    const sessionB = await storage.createSession(b.id, 'claude-code', 'bb', 'sb');

    await storage.createTurn({
      sessionId: sessionB.id,
      sequence: await storage.getNextTurnSequence(sessionB.id),
      role: 'agent',
      content: 'hello from b',
    });

    expect(await storage.getSessionTurns(sessionA.id)).toEqual([]);
    const turns = await storage.getSessionTurns(sessionB.id);
    expect(turns.map((t) => t.content)).toEqual(['hello from b']);
  });

  // --- The self-healing READ path ---

  test('listTasksWithOptions self-heal leaves the index coherent', async () => {
    const parent = await storage.createTask('parent');
    const child = await storage.createTask('child', parent.id);
    const session = await storage.createSession(child.id, 'claude-code', 'br', 'sha');

    // Build the index, then end the session WITHOUT moving the task status —
    // exactly the inconsistency listTasksWithOptions repairs by rewriting
    // task.json outside the normal updateTaskStatus path.
    await storage.getTaskTree(parent.id);
    await storage.endSession(session.id, 'accepted');

    const listed = await storage.listTasksWithOptions({});
    expect(listed.find((t) => t.id === child.id)?.status).toBe('complete');

    // The heal rewrote task.json; parentage and session must be untouched.
    expect(ids(await storage.getChildTasks(parent.id))).toEqual([child.id]);
    expect((await storage.getSession(session.id))?.id).toBe(session.id);

    const tree = await storage.getTaskTree(parent.id);
    expect(normalizeTree(tree!)).toEqual(normalizeTree((await referenceTree(parent.id))!));
    expect(tree!.children[0].task.status).toBe('complete');
  });

  test('task content is always read from disk, never served from the index', async () => {
    const parent = await storage.createTask('parent');
    const child = await storage.createTask('child', parent.id);
    await storage.getTaskTree(parent.id); // build the index

    await storage.updateTaskGoal(child.id, 'renamed');

    expect((await storage.getChildTasks(parent.id))[0].goal).toBe('renamed');
    expect((await storage.getTaskTree(parent.id))!.children[0].task.goal).toBe('renamed');
  });

  // --- Reconciliation with the tasks directory ---

  test('a task directory that appears out-of-band is picked up', async () => {
    const parent = await storage.createTask('parent');
    const donor = await storage.createTask('donor', parent.id);
    await storage.getTaskTree(parent.id); // build the index

    // Simulate a store restore/import writing a task directory directly.
    const restoredId = randomUUID();
    const restoredDir = join(base, 'tasks', restoredId);
    cpSync(join(base, 'tasks', donor.id), restoredDir, { recursive: true });
    const taskPath = join(restoredDir, 'task.json');
    const raw = JSON.parse(readFileSync(taskPath, 'utf-8'));
    raw.id = restoredId;
    raw.goal = 'restored';
    writeFileSync(taskPath, JSON.stringify(raw, null, 2));

    expect(ids(await storage.getChildTasks(parent.id))).toEqual([donor.id, restoredId].sort());
    expect(ids(await storage.getChildTasks(parent.id))).toEqual(
      ids(await referenceChildren(parent.id)),
    );
  });

  test('a task directory that disappears out-of-band is dropped', async () => {
    const parent = await storage.createTask('parent');
    const child = await storage.createTask('child', parent.id);
    await storage.getTaskTree(parent.id); // build the index

    rmSync(join(base, 'tasks', child.id), { recursive: true, force: true });

    expect(await storage.getChildTasks(parent.id)).toEqual([]);
    expect((await storage.getTaskTree(parent.id))!.children).toEqual([]);
  });

  test('orphaned children survive their parent directory disappearing', async () => {
    // The full-store filter this index replaces returned a child for its
    // recorded parent id whether or not that parent still existed, so dropping
    // the vanished parent must not drop the surviving children with it.
    const parent = await storage.createTask('parent');
    const child = await storage.createTask('child', parent.id);
    await storage.getChildTasks(parent.id); // build the index

    rmSync(join(base, 'tasks', parent.id), { recursive: true, force: true });

    expect(ids(await storage.getChildTasks(parent.id))).toEqual([child.id]);
    expect(ids(await referenceChildren(parent.id))).toEqual([child.id]);
  });

  test('a session written out-of-band is still found on a miss', async () => {
    const a = await storage.createTask('a');
    const b = await storage.createTask('b');
    await storage.createSession(a.id, 'claude-code', 'ba', 'sa');
    // Build the index while b has no session.
    await storage.listTasksWithOptions({});

    // Another writer replaces b's session.json wholesale.
    const sessionPath = join(base, 'tasks', b.id, 'session.json');
    const smuggled = {
      id: randomUUID(),
      task_id: b.id,
      agent_id: 'claude-code',
      started_at: 5,
      ended_at: null,
      outcome: null,
      git_branch: 'bb',
      git_start_sha: 'sb',
      agent_session_id: null,
      last_interaction_at: 5,
      total_duration_ms: 0,
    };
    writeFileSync(sessionPath, JSON.stringify(smuggled, null, 2));

    expect((await storage.getSession(smuggled.id))?.task_id).toBe(b.id);
  });

  // --- Concurrency ---

  test('writes racing the first index build stay coherent', async () => {
    const parent = await storage.createTask('parent');

    // Kick off a read that builds the index and a write that mutates it, in the
    // same tick: applyIndexUpdate must not lose the write, whichever lands first.
    const [, child] = await Promise.all([
      storage.getChildTasks(parent.id),
      storage.createTask('racing child', parent.id),
    ]);

    expect(ids(await storage.getChildTasks(parent.id))).toEqual([child.id]);
  });

  test('concurrent tree reads share one coherent index', async () => {
    const f = await buildFixture();
    const trees = await Promise.all([
      storage.getTaskTree(f.root1.id),
      storage.getTaskTree(f.root1.id),
      storage.getTaskTree(f.root1.id),
    ]);
    const reference = normalizeTree((await referenceTree(f.root1.id))!);
    for (const tree of trees) expect(normalizeTree(tree!)).toEqual(reference);
  });

  // --- Code resolution ---
  //
  // INVARIANT: the code map narrows lookups, it never decides them. Resolving
  // a code still opens the candidate task.json files, so the disambiguation
  // rules run on fresh status and created_at — the index only says which files
  // to open, and a miss falls back to the scan it replaced.

  /** The pre-index code lookup: read every task.json and filter. */
  async function referenceByCode(code: string): Promise<string[]> {
    const all = await storage.listTasks();
    return all.filter((t) => t.code === code).map((t) => t.id).sort();
  }

  test('a code resolves to the same task the full-store scan found', async () => {
    await storage.createTask('other', undefined, undefined, 'other-code');
    const task = await storage.createTask('coded', undefined, undefined, 'my-code');

    expect((await storage.getTask('my-code'))?.id).toBe(task.id);
    expect(await referenceByCode('my-code')).toEqual([task.id]);
    expect(await storage.getTask('no-such-code')).toBeNull();
  });

  test('a code changed by updateTaskCode resolves at its new name, not its old', async () => {
    const task = await storage.createTask('coded', undefined, undefined, 'before');
    await storage.getTask('before'); // seed the index with the old code

    await storage.updateTaskCode(task.id, 'after');

    expect((await storage.getTask('after'))?.id).toBe(task.id);
    expect(await storage.getTask('before')).toBeNull();
    expect(await referenceByCode('before')).toEqual([]);
  });

  test('a reused code still disambiguates on live status, not on index order', async () => {
    // A code may be reused once its holder is terminal, so the index maps one
    // code to several ids and the files decide between them.
    const old = await storage.createTask('old holder', undefined, undefined, 'shared');
    await storage.getTask('shared'); // index it while it is the only holder
    await storage.updateTaskStatus(old.id, 'abandoned');
    const live = await storage.createTask('new holder', undefined, undefined, 'shared');

    expect(await referenceByCode('shared')).toEqual([old.id, live.id].sort());
    // Non-terminal wins, whichever order the index happened to record.
    expect((await storage.getTask('shared'))?.id).toBe(live.id);
  });

  test('a code written out-of-band is found, and the index learns it', async () => {
    const donor = await storage.createTask('donor', undefined, undefined, 'donor-code');
    await storage.listTaskCodes(); // build the index without the smuggled task

    // A store restore/import writes a task directory directly.
    const smuggledId = randomUUID();
    const smuggledDir = join(base, 'tasks', smuggledId);
    cpSync(join(base, 'tasks', donor.id), smuggledDir, { recursive: true });
    const taskPath = join(smuggledDir, 'task.json');
    const raw = JSON.parse(readFileSync(taskPath, 'utf-8'));
    raw.id = smuggledId;
    raw.code = 'smuggled-code';
    writeFileSync(taskPath, JSON.stringify(raw, null, 2));

    expect((await storage.getTask('smuggled-code'))?.id).toBe(smuggledId);
    // The fallback repaired the index, so the next lookup needs no rescan.
    expect((await storage.getTask('smuggled-code'))?.id).toBe(smuggledId);
    expect((await storage.listTaskCodes()).find((e) => e.id === smuggledId)?.code).toBe(
      'smuggled-code',
    );
  });

  // --- Identity-only projections ---

  test('listTaskCodes matches ids and codes read off the full task set', async () => {
    await buildFixture();
    await storage.createTask('coded', undefined, undefined, 'a-code');

    const reference = (await storage.listTasks())
      .map((t) => ({ id: t.id, code: t.code ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const actual = (await storage.listTaskCodes()).sort((a, b) => a.id.localeCompare(b.id));

    expect(actual).toEqual(reference);
  });

  test('countDescendants matches descendantCounts over the full task set', async () => {
    const f = await buildFixture();
    const rootIds = [f.root1.id, f.childA.id, f.childB.id, f.grandchild.id, f.root2.id];

    const reference = descendantCounts(await storage.listTasks());
    const actual = await storage.countDescendants(rootIds);

    for (const id of rootIds) {
      expect(actual[id]).toBe(reference.get(id) ?? 0);
    }
    // Spelled out, so a change in either implementation is visible here.
    expect(actual[f.root1.id]).toBe(3);
    expect(actual[f.childA.id]).toBe(1);
    expect(actual[f.childB.id]).toBe(0);
    expect(actual[f.root2.id]).toBe(0);
  });

  test('countDescendants answers zero for a task that does not exist', async () => {
    const missing = randomUUID();
    expect(await storage.countDescendants([missing])).toEqual({ [missing]: 0 });
  });

  test('countDescendants sees a subtree reparented after the index was built', async () => {
    const f = await buildFixture();
    await storage.countDescendants([f.root1.id]); // build the index

    await storage.updateTaskTarget(f.childA.id, taskTarget(f.root2.id));

    const reference = descendantCounts(await storage.listTasks());
    const actual = await storage.countDescendants([f.root1.id, f.root2.id]);
    expect(actual[f.root1.id]).toBe(reference.get(f.root1.id) ?? 0);
    expect(actual[f.root2.id]).toBe(reference.get(f.root2.id) ?? 0);
    expect(actual[f.root2.id]).toBe(2);
  });
});
