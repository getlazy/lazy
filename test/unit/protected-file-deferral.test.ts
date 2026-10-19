/**
 * Where a task's protected-file questions are asked — `resolveProtectedFileDeferral`.
 *
 * INVARIANT (engineer, 2026-10-04): an agent-audience task with a live parent
 * — every subtask of a cluster — is NOT asked about its protected files at its
 * own accept. They are carried up undecided and asked at the parent's accept,
 * where a person reviews the whole work. Before this, cluster drivers parked
 * finished children "awaiting engineer approval of protected test files" and
 * raised blocking items for it, holding the cluster up on a question the
 * cluster's own accept asks anyway.
 *
 * INVARIANT: the predicate is AUDIENCE, the same `audienceOf` the parent's
 * resolver uses to decide which children's files it must ask about. A child
 * that skipped its question while its parent counted it as decided would merge
 * a protected change nobody was asked about.
 *
 * INVARIANT: every doubt answers "not deferred" — no parent, a finished or
 * missing parent, an unreadable store. Asked at its own accept over-asks;
 * deferred wrongly can merge unseen.
 */

import { describe, test, expect } from 'bun:test';
import { resolveProtectedFileDeferral } from '../../src/protection/deferral';
import type { Actor, Task, TaskStatus, Turn } from '../../src/types';

const PARENT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

function launch(actor: Actor): Pick<Turn, 'role' | 'actor'> {
  return { role: 'human', actor };
}

/** An agent's reply turn as production writes it: attributed to the `agent` channel. */
function reply(): Pick<Turn, 'role' | 'actor'> {
  return { role: 'agent', actor: 'agent' };
}

function childOf(parentId: string | null): Pick<Task, 'id' | 'target'> {
  return {
    id: 'bbbbbbbb-1111-4222-8333-444444444444',
    target: parentId
      ? { kind: 'task', parentTaskId: parentId }
      : { kind: 'branch', branch: 'main' },
  };
}

function storageWith(opts: {
  parent?: { type: string; status: TaskStatus; code?: string } | null;
  parentThrows?: boolean;
  createdBy?: Actor;
}) {
  return {
    getTask: async (id: string) => {
      if (opts.parentThrows) throw new Error('store unreadable');
      if (!opts.parent) return null;
      return { id, code: opts.parent.code ?? 'the-parent', ...opts.parent } as unknown as Task;
    },
    getStatusHistory: async () => [{ status: 'backlog', timestamp: 1, actor: opts.createdBy ?? 'human' }] as never,
  };
}

describe('resolveProtectedFileDeferral', () => {
  test('a cluster\'s child defers to the cluster, even when a human launched it', async () => {
    const deferral = await resolveProtectedFileDeferral(
      storageWith({ parent: { type: 'cluster', status: 'working', code: 'patch-cluster' } }),
      childOf(PARENT_ID),
      [launch('human'), reply()],
    );
    expect(deferral).toEqual({ taskId: PARENT_ID, displayId: 'patch-cluster' });
  });

  test('an agent-launched subtask of an ordinary task defers too', async () => {
    const deferral = await resolveProtectedFileDeferral(
      storageWith({ parent: { type: 'task', status: 'working' } }),
      childOf(PARENT_ID),
      [launch('agent')],
    );
    expect(deferral?.taskId).toBe(PARENT_ID);
  });

  // A person reads a human-audience subtask, so it is asked where it merges —
  // and that approval does count at its parent.
  test('a human-launched subtask of an ordinary task is asked at its own accept', async () => {
    const deferral = await resolveProtectedFileDeferral(
      storageWith({ parent: { type: 'task', status: 'blocked' } }),
      childOf(PARENT_ID),
      [launch('agent'), reply(), launch('human'), reply()],
    );
    expect(deferral).toBeNull();
  });

  test('a top-level task is always asked at its own accept', async () => {
    const deferral = await resolveProtectedFileDeferral(
      storageWith({ parentThrows: true }),
      childOf(null),
      [launch('agent')],
    );
    expect(deferral).toBeNull();
  });

  // A parent that will never be accepted again cannot ask anything.
  test('a finished parent does not take the question', async () => {
    for (const status of ['complete', 'abandoned'] as const) {
      const deferral = await resolveProtectedFileDeferral(
        storageWith({ parent: { type: 'cluster', status } }),
        childOf(PARENT_ID),
        [launch('agent')],
      );
      expect(deferral).toBeNull();
    }
  });

  test('a missing or unreadable parent does not take the question', async () => {
    expect(await resolveProtectedFileDeferral(storageWith({ parent: null }), childOf(PARENT_ID), [launch('agent')]))
      .toBeNull();
    expect(await resolveProtectedFileDeferral(storageWith({ parentThrows: true }), childOf(PARENT_ID), [launch('agent')]))
      .toBeNull();
  });

  // No launch recorded yet: the creation actor decides, exactly as audienceOf.
  test('with no launching turn, an agent-created subtask defers', async () => {
    const deferral = await resolveProtectedFileDeferral(
      storageWith({ parent: { type: 'task', status: 'working' }, createdBy: 'agent' }),
      childOf(PARENT_ID),
      [],
    );
    expect(deferral?.taskId).toBe(PARENT_ID);
  });
});
