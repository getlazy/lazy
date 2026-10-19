/**
 * Page-shaped `list` answers: the rows Teams' project page and Tasks page
 * render, not the whole tree.
 */

import { describe, test, expect } from 'bun:test';
import { RpcError } from '../../src/daemon/rpc-error';
import {
  ACTIVE_PAGE_STATUSES,
  OVERVIEW_STRIP_LIMIT,
  buildOverview,
  buildTasksPage,
  parsePageListParams,
  selectActiveTree,
  selectPageTasks,
  sortPageTasks,
  type PageViewReads,
} from '../../src/daemon/page-views';
import type { Session, Task, TaskStatus } from '../../src/types';

function task(partial: {
  id: string;
  status?: TaskStatus;
  parent?: string;
  code?: string;
  goal?: string;
  created_at?: number;
  completed_at?: number | null;
  agent_id?: string;
  prompt?: string;
}): Task {
  return {
    id: partial.id,
    code: partial.code ?? partial.id,
    goal: partial.goal ?? partial.id,
    prompt: partial.prompt ?? `prompt-of-${partial.id}`,
    type: 'task',
    status: partial.status ?? 'backlog',
    created_at: partial.created_at ?? 1,
    completed_at: partial.completed_at ?? null,
    target: partial.parent
      ? { kind: 'task', parentTaskId: partial.parent }
      : { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: partial.agent_id ?? 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    sync_count: 0,
    pending_sync: 0,
  } as Task;
}

function session(taskId: string, at: number): Session {
  return { id: `s-${taskId}`, task_id: taskId, last_interaction_at: at } as Session;
}

describe('selectActiveTree', () => {
  // INVARIANT: the Tasks landing keeps an inactive ancestor when a descendant
  // is active, and drops an inactive sibling. That is the tree the page draws;
  // filtering after a full tree build was the page's cost.
  test('keeps a backlog parent of a working child and drops the idle sibling', () => {
    const tasks = [
      task({ id: 'parent', status: 'backlog' }),
      task({ id: 'running', status: 'working', parent: 'parent' }),
      task({ id: 'idle', status: 'backlog', parent: 'parent' }),
      task({ id: 'elsewhere', status: 'backlog' }),
    ];
    expect(selectActiveTree(tasks).map((t) => t.id)).toEqual(['parent', 'running']);
  });

  test('a child whose parent is not in the set is a root', () => {
    const tasks = [task({ id: 'child', status: 'working', parent: 'finished-and-absent' })];
    expect(selectActiveTree(tasks).map((t) => t.id)).toEqual(['child']);
  });

  test('active statuses match the Tasks page', () => {
    expect(ACTIVE_PAGE_STATUSES.has('working')).toBe(true);
    expect(ACTIVE_PAGE_STATUSES.has('conflict')).toBe(true);
    expect(ACTIVE_PAGE_STATUSES.has('backlog')).toBe(false);
    expect(ACTIVE_PAGE_STATUSES.has('complete')).toBe(false);
  });
});

describe('selectPageTasks', () => {
  const tasks = [
    task({ id: 'w', status: 'working' }),
    task({ id: 'b', status: 'blocked' }),
    task({ id: 'c', status: 'conflict' }),
    task({ id: 's', status: 'submitted' }),
    task({ id: 'k', status: 'backlog' }),
    task({ id: 'done', status: 'complete' }),
    task({ id: 'left', status: 'abandoned' }),
  ];

  test('blocked includes conflict', () => {
    const ids = selectPageTasks(tasks, { view: 'status', status: 'blocked', sort: 'activity', dir: 'desc' })
      .map((t) => t.id);
    expect(ids).toEqual(['b', 'c']);
  });

  test('submitted includes externally linked tasks regardless of status', () => {
    const linked = task({ id: 'linked', status: 'working' });
    linked.metadata = { github_remote_ref_url: 'https://github.com/org/repo/pull/12' };
    const finished = task({ id: 'finished', status: 'complete' });
    finished.metadata = { gitlab_remote_ref_url: 'https://gitlab.com/org/repo/-/merge_requests/2' };
    const ids = selectPageTasks([...tasks, linked, finished],
      { view: 'status', status: 'submitted', sort: 'activity', dir: 'desc' }).map((item) => item.id);
    expect(ids).toEqual(['s', 'linked', 'finished']);
  });

  test('done is complete and abandoned', () => {
    const ids = selectPageTasks(tasks, { view: 'status', status: 'done', sort: 'activity', dir: 'desc' })
      .map((t) => t.id);
    expect(ids).toEqual(['done', 'left']);
  });

  test('open drops terminal tasks', () => {
    const ids = selectPageTasks(tasks, { view: 'open', sort: 'activity', dir: 'desc' }).map((t) => t.id);
    expect(ids).not.toContain('done');
    expect(ids).not.toContain('left');
    expect(ids).toContain('k');
  });
});

describe('sortPageTasks', () => {
  test('activity desc is newest interaction first', () => {
    const tasks = [
      task({ id: 'old', created_at: 10 }),
      task({ id: 'new', created_at: 1 }),
    ];
    const sessions = new Map<string, Session | null>([
      ['old', session('old', 50)],
      ['new', session('new', 500)],
    ]);
    expect(sortPageTasks(tasks, sessions, 'activity', 'desc').map((t) => t.id)).toEqual(['new', 'old']);
  });
});

describe('parsePageListParams', () => {
  test('a page view is required and an unknown one is a 400', () => {
    expect(() => parsePageListParams({})).toThrow(RpcError);
    expect(() => parsePageListParams({ view: 'sideways' })).toThrow(/view/);
    expect(() => parsePageListParams({ view: 'status' })).toThrow(/status/);
  });

  test('activity defaults to newest first', () => {
    expect(parsePageListParams({ view: 'active' })).toEqual({
      view: 'active', status: undefined, sort: 'activity', dir: 'desc',
    });
  });
});

function fakeStorage(tasks: Task[], sessions: Record<string, number> = {}): PageViewReads & {
  turnReads: string[];
  getTaskReads: string[];
  listAllReads: number;
} {
  const turnReads: string[] = [];
  const getTaskReads: string[] = [];
  const store = {
    turnReads,
    getTaskReads,
    listAllReads: 0,
    listTasks: async () => {
      store.listAllReads += 1;
      return tasks;
    },
    listTasksWithOptions: async () => tasks.filter((t) => t.status !== 'complete' && t.status !== 'abandoned'),
    getTask: async (id: string) => {
      getTaskReads.push(id);
      return tasks.find((t) => t.id === id) ?? null;
    },
    getSessionByTaskId: async (id: string) => (sessions[id] !== undefined ? session(id, sessions[id]!) : null),
    getTurnCountByTaskId: async (id: string) => {
      turnReads.push(id);
      return 4;
    },
  };
  return store;
}

describe('buildOverview', () => {
  test('returns five-card strips, the real total, and no prompts', async () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => task({
        id: `b${i}`, status: 'blocked', created_at: i, goal: `needs ${i}`,
      })),
      task({ id: 'run', status: 'working', created_at: 1, goal: 'running' }),
      task({ id: 'ship', status: 'complete', completed_at: 9, goal: 'shipped' }),
      task({ id: 'gone', status: 'abandoned', goal: 'abandoned' }),
    ];
    const storage = fakeStorage(tasks, { b7: 100, run: 50, ship: 80 });
    const reply = await buildOverview(storage);

    expect(reply.shaped).toBe(true);
    expect(reply.overview.needsYou).toHaveLength(OVERVIEW_STRIP_LIMIT);
    expect(reply.overview.needsYouTotal).toBe(8);
    expect(reply.overview.needsYou[0]!.task).not.toHaveProperty('prompt');
    expect(reply.overview.recentActivity.map((row) => row.task).every((t) => !('prompt' in t))).toBe(true);
    expect(reply.overview.recentlyMerged.map((row) => row.task.id)).toEqual(['ship']);
    expect(reply.overview.active).toBe(1);
    expect(reply.overview.blocked).toBe(8);
    expect(reply.overview.total).toBe(tasks.length);
    // Turn counts only for the cards that show them.
    expect(storage.turnReads).toHaveLength(OVERVIEW_STRIP_LIMIT);
    expect(reply.overview.needsYou[0]!.turnCount).toBe(4);
    expect(reply.overview.recentActivity[0]!.turnCount).toBe(0);
  });
});

describe('buildTasksPage', () => {
  test('the active view is nested and does not carry prompts', async () => {
    const tasks = [
      task({ id: 'parent', status: 'backlog', prompt: 'secret parent prompt' }),
      task({ id: 'child', status: 'working', parent: 'parent', prompt: 'secret child prompt' }),
      task({ id: 'idle', status: 'backlog' }),
    ];
    const seen: string[] = [];
    // A working task with no session has no run to probe. The child has one.
    const reply = await buildTasksPage(fakeStorage(tasks, { child: 10 }), '/tmp/unused', {
      view: 'active', sort: 'activity', dir: 'desc',
    }, {
      probe: async (task) => {
        seen.push(task.id);
        return { kind: 'agent' } as never;
      },
    });
    expect(reply.tree.map((row) => row.task.id)).toEqual(['parent']);
    expect(reply.tree[0]!.children.map((row) => row.task.id)).toEqual(['child']);
    expect(reply.tree[0]!.task).not.toHaveProperty('prompt');
    expect(reply.tree[0]!.children[0]!.task).not.toHaveProperty('prompt');
    // Only the working row is probed.
    expect(seen).toEqual(['child']);
    expect(reply.tree[0]!.children[0]!.workingSubstate).toEqual({ kind: 'agent' });
    expect(reply.tree[0]!.workingSubstate).toBeUndefined();
    // A live run is not a crash. The badge is the substate, not [CRASHED].
    expect(reply.tree[0]!.children[0]!.crashed).toBeUndefined();
  });

  test('a working run that is not alive is marked crashed', async () => {
    const tasks = [task({ id: 'gone', status: 'working' })];
    const reply = await buildTasksPage(fakeStorage(tasks, { gone: 10 }), '/tmp/unused', {
      view: 'active', sort: 'activity', dir: 'desc',
    }, {
      probe: async () => ({ kind: 'not-alive' }) as never,
    });
    expect(reply.tree[0]!.crashed).toBe(true);
    expect(reply.tree[0]!.task).not.toHaveProperty('prompt');
  });

  // INVARIANT: a finished parent is context for its active child, and it is
  // read by id. The non-terminal list does not contain it, and a pile of
  // unrelated finished tasks is never opened.
  test('a finished parent is fetched by id and unrelated finished tasks are not', async () => {
    const tasks = [
      task({ id: 'grand', status: 'complete', prompt: 'secret grand prompt' }),
      task({ id: 'finished', status: 'abandoned', parent: 'grand', prompt: 'secret parent prompt' }),
      task({ id: 'child', status: 'working', parent: 'finished', prompt: 'secret child prompt' }),
      ...Array.from({ length: 40 }, (_, i) => task({ id: `old-${i}`, status: 'complete', prompt: `secret ${i}` })),
    ];
    const storage = fakeStorage(tasks, { child: 10, finished: 5, grand: 1 });
    const reply = await buildTasksPage(storage, '/tmp/unused', {
      view: 'active', sort: 'activity', dir: 'desc',
    }, {
      probe: async () => ({ kind: 'agent' }) as never,
    });

    expect(storage.listAllReads).toBe(0);
    expect(storage.getTaskReads).toEqual(['finished', 'grand']);
    expect(reply.tree.map((row) => row.task.id)).toEqual(['grand']);
    expect(reply.tree[0]!.children.map((row) => row.task.id)).toEqual(['finished']);
    expect(reply.tree[0]!.children[0]!.children.map((row) => row.task.id)).toEqual(['child']);
    expect(reply.tree[0]!.task).not.toHaveProperty('prompt');
    expect(reply.tree[0]!.children[0]!.task).not.toHaveProperty('prompt');
    expect(reply.tree[0]!.children[0]!.children[0]!.task).not.toHaveProperty('prompt');
  });

  // INVARIANT: a parked row on the active view is probed, and Crashed is the
  // runtime saying that run is gone. The same row on another view is not probed.
  test('a parked task on the active view is marked crashed', async () => {
    const tasks = [
      task({ id: 'stuck', status: 'blocked' }),
      task({ id: 'live', status: 'conflict' }),
      task({ id: 'paused', status: 'interrupted' }),
    ];
    const probed: string[] = [];
    const reply = await buildTasksPage(fakeStorage(tasks, { stuck: 1, live: 2, paused: 3 }), '/tmp/unused', {
      view: 'active', sort: 'activity', dir: 'desc',
    }, {
      crashedProbe: async (task) => {
        probed.push(task.id);
        return task.id === 'stuck';
      },
    });
    expect(probed.sort()).toEqual(['live', 'paused', 'stuck']);
    const byId = new Map(reply.tree.map((row) => [row.task.id, row]));
    expect(byId.get('stuck')!.crashed).toBe(true);
    expect(byId.get('live')!.crashed).toBeUndefined();
    expect(byId.get('paused')!.crashed).toBeUndefined();
  });

  test('a parked task on another view is not probed', async () => {
    const tasks = [task({ id: 'stuck', status: 'blocked' })];
    let probed = 0;
    const reply = await buildTasksPage(fakeStorage(tasks, { stuck: 1 }), '/tmp/unused', {
      view: 'open', sort: 'activity', dir: 'desc',
    }, {
      crashedProbe: async () => {
        probed += 1;
        return true;
      },
    });
    expect(probed).toBe(0);
    expect(reply.tree[0]!.crashed).toBeUndefined();
  });

  // INVARIANT: [P] is an Active-tree marker. All and Open do not load a
  // protection context and do not ask the gate per row. The active view still
  // does, and a gated row carries the marker.
  test('protection is computed for the active view and not for all or open', async () => {
    const tasks = [
      task({ id: 'gated', status: 'working' }),
      task({ id: 'plain', status: 'blocked' }),
    ];
    const calls = { context: 0, status: [] as string[] };
    const protection = {
      context: async () => {
        calls.context += 1;
        return true;
      },
      status: async (id: string) => {
        calls.status.push(id);
        return id === 'gated';
      },
    };
    const quiet = {
      protection,
      probe: async () => ({ kind: 'agent' }) as never,
      crashedProbe: async () => false,
    };

    const active = await buildTasksPage(fakeStorage(tasks, { gated: 1, plain: 2 }), '/tmp/unused', {
      view: 'active', sort: 'activity', dir: 'desc',
    }, quiet);
    expect(calls.context).toBe(1);
    expect(calls.status.sort()).toEqual(['gated', 'plain']);
    const byId = new Map(active.tree.map((row) => [row.task.id, row]));
    expect(byId.get('gated')!.protection).toEqual({ gated: true });
    expect(byId.get('plain')!.protection).toBeUndefined();

    calls.context = 0;
    calls.status = [];
    for (const view of ['all', 'open'] as const) {
      const reply = await buildTasksPage(fakeStorage(tasks, { gated: 1, plain: 2 }), '/tmp/unused', {
        view, sort: 'activity', dir: 'desc',
      }, quiet);
      expect(calls.context).toBe(0);
      expect(calls.status).toEqual([]);
      expect(reply.tree.every((row) => row.protection === undefined)).toBe(true);
    }
  });
});
