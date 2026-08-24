/**
 * Parent-chain cycle guards in FileStorage's tree walks.
 *
 * INVARIANT under test throughout: a corrupt store must never hang or crash
 * the daemon. A parent cycle (A → B → A) is only reachable through corrupt
 * data, but corrupt data is exactly what these walks must survive:
 * `getTaskAncestry` used to loop forever (growing its array by `unshift` on
 * every pass) and `getRootTask` used to recurse until the stack overflowed.
 * Both now stop at the first repeated id and return the chain walked so far,
 * mirroring the long-standing guard in `collectSubtreeIds`
 * (src/task-target.ts): "guard against a cyclic parent link so a corrupt
 * store can't hang us".
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { taskTarget } from '../../src/task-target';
import { logger } from '../../src/utils/logger';

let lazyRoot: string;
let basePath: string;
let storage: FileStorage;

beforeEach(async () => {
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-cycleguard-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-cycleguard-store-'));
  storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();
});

afterEach(async () => {
  await rm(lazyRoot, { recursive: true, force: true });
  await rm(basePath, { recursive: true, force: true });
});

/** Seed a two-task parent cycle: A's parent is B, B's parent is A. */
async function seedCycle(): Promise<{ a: string; b: string }> {
  const a = await storage.createTask('task A', undefined, undefined, 'cycle-a');
  const b = await storage.createTask('task B', undefined, undefined, 'cycle-b');
  await storage.updateTaskTarget(a.id, taskTarget(b.id));
  await storage.updateTaskTarget(b.id, taskTarget(a.id));
  return { a: a.id, b: b.id };
}

describe('FileStorage parent-chain cycle guards', () => {
  // INVARIANT: a corrupt store must never hang the daemon. Without the
  // visited-set this test never returns.
  test('getTaskAncestry terminates on a parent cycle and returns the partial chain', async () => {
    const { a, b } = await seedCycle();
    const errors: string[] = [];
    const spy = spyOn(logger, 'error').mockImplementation((msg: string) => { errors.push(msg); });

    try {
      const ancestry = await storage.getTaskAncestry(a);

      // Each task appears exactly once — no unbounded unshift growth.
      const ids = ancestry.map((t) => t.id);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
      // Root-first ordering is preserved for the chain that was walked.
      expect(ids[ids.length - 1]).toBe(a);

      // Errors are for humans: the diagnostic names the actual ids so the
      // store can be repaired.
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('parent cycle detected');
      expect(errors[0]).toContain(a);
      expect(errors[0]).toContain(b);
    } finally {
      spy.mockRestore();
    }
  });

  // INVARIANT: a corrupt store must never crash the daemon. This walk used to
  // be unguarded recursion, so a cycle blew the stack.
  test('getRootTask terminates on a parent cycle instead of overflowing the stack', async () => {
    const { a, b } = await seedCycle();
    const spy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      const root = await storage.getRootTask(a);
      expect(root).not.toBeNull();
      // The highest task reached before the cycle closed.
      expect([a, b]).toContain(root!.id);
    } finally {
      spy.mockRestore();
    }
  });

  // A self-parent (A → A) is the degenerate one-node cycle.
  test('a self-referential parent link terminates too', async () => {
    const a = await storage.createTask('self parent', undefined, undefined, 'cycle-self');
    await storage.updateTaskTarget(a.id, taskTarget(a.id));
    const spy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      const ancestry = await storage.getTaskAncestry(a.id);
      expect(ancestry.map((t) => t.id)).toEqual([a.id]);
      expect((await storage.getRootTask(a.id))!.id).toBe(a.id);
    } finally {
      spy.mockRestore();
    }
  });

  // Regression guard: the cycle handling must not change acyclic behavior.
  test('an ordinary chain is still returned root-first and in full', async () => {
    const gp = await storage.createTask('grandparent', undefined, undefined, 'chain-gp');
    const parent = await storage.createTask('parent', gp.id, undefined, 'chain-parent');
    const child = await storage.createTask('child', parent.id, undefined, 'chain-child');

    const ancestry = await storage.getTaskAncestry(child.id);
    expect(ancestry.map((t) => t.id)).toEqual([gp.id, parent.id, child.id]);
    expect((await storage.getRootTask(child.id))!.id).toBe(gp.id);
  });
});
