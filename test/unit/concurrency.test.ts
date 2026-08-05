/**
 * Unit tests for the agent/builder concurrency limiter.
 *
 * INVARIANT: a slot is held by each *working* agent task. New launches at the
 * cap must be denied (the caller queues), and two concurrent launches must never
 * both grab the last slot — the count→decide→reserve step is serialized and a
 * reservation covers the admitted→working window.
 *
 * INVARIANT: an already-working (or reserved) task is always admitted without
 * consuming a new slot — an idempotent relaunch never trips the cap.
 *
 * INVARIANT: ephemeral overrides change the effective limit but never the
 * configured lazy.toml value.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  decideAgentSlot,
  countActiveAgents,
  tryAdmitAgentSlot,
  releaseAgentSlot,
  effectiveAgentLimit,
  effectiveBuilderLimit,
  setLimitOverride,
  getLimitOverride,
  resetConcurrencyStateForTest,
  orderQueuedTasks,
  queuePosition,
  selectContainersToReap,
} from '../../src/daemon/concurrency';
import type { Storage } from '../../src/storage';
import type { Task, TaskStatus, TaskPriority } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';

interface StubTask {
  id: string;
  status: TaskStatus;
  /** Non-null when a live supervisor container is attached (counts as a slot). */
  container?: string | null;
  priority?: TaskPriority;
  created_at?: number;
}

const TERMINAL: TaskStatus[] = ['complete', 'abandoned'];

/**
 * Minimal in-memory storage stub. A "live container" is modeled by a task's
 * `container` — countActiveAgents reads sessions' container_name, so the stub's
 * getSessionByTaskId returns { container_name } accordingly.
 */
function makeStorage(tasks: StubTask[]): Storage {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    async getTask(id: string) {
      const t = byId.get(id);
      return t ? ({ ...t } as unknown as Task) : null;
    },
    async getSessionByTaskId(id: string) {
      const t = byId.get(id);
      if (!t || t.container == null) return null;
      return { container_name: t.container } as any;
    },
    async listTasksWithOptions(options: { workingOnly?: boolean; queuedOnly?: boolean; nonTerminalOnly?: boolean }) {
      let all = [...byId.values()];
      if (options.workingOnly) all = all.filter((t) => t.status === 'working');
      if (options.queuedOnly) all = all.filter((t) => t.status === 'queued');
      if (options.nonTerminalOnly) all = all.filter((t) => !TERMINAL.includes(t.status));
      return all as unknown as Task[];
    },
  } as unknown as Storage;
}

/** A working task with a live container (the common slot-holding shape). */
function working(id: string): StubTask {
  return { id, status: 'working', container: `c-${id}` };
}

function configWithLimits(agents: number, builders: number): ResolvedConfig {
  return {
    limits: { max_concurrent_agents: agents, max_concurrent_builders: builders },
  } as unknown as ResolvedConfig;
}

beforeEach(() => {
  resetConcurrencyStateForTest();
});

describe('decideAgentSlot (pure decision)', () => {
  test('admits when running is below the limit and counts the new slot', () => {
    expect(decideAgentSlot(3, 8, false)).toEqual({ admitted: true, running: 4, limit: 8 });
  });

  test('denies when running is at the limit', () => {
    expect(decideAgentSlot(8, 8, false)).toEqual({ admitted: false, running: 8, limit: 8 });
  });

  test('denies when running exceeds the limit (e.g. after a manual unblock overshoot)', () => {
    expect(decideAgentSlot(9, 8, false)).toEqual({ admitted: false, running: 9, limit: 8 });
  });

  test('always admits an already-running task without consuming a new slot', () => {
    // Even at/over the cap, a re-entrant relaunch is admitted and running is unchanged.
    expect(decideAgentSlot(8, 8, true)).toEqual({ admitted: true, running: 8, limit: 8 });
  });
});

describe('countActiveAgents', () => {
  test('counts every non-terminal task with a LIVE container (working AND blocked)', async () => {
    // A blocked task keeps its supervisor container alive (no idle reaper), so it
    // holds a slot too — the whole point of counting live containers, not just
    // `working`. A queued task (no container) and a terminal task do not count.
    const storage = makeStorage([
      working('a'),
      { id: 'b', status: 'blocked', container: 'c-b' }, // idle-but-alive → counts
      { id: 'c', status: 'blocked', container: null }, // container removed → free
      { id: 'd', status: 'queued' },
      { id: 'e', status: 'complete', container: 'c-e' }, // terminal → excluded
    ]);
    expect(await countActiveAgents(storage)).toBe(2); // a + b
  });

  test('counts reserved (mid-launch) tasks that have no container yet, without double-counting', async () => {
    const storage = makeStorage([working('a')]);
    // Reserve a NOT-yet-launched task → 2 slots in use.
    await tryAdmitAgentSlot(storage, 'b', 8);
    expect(await countActiveAgents(storage)).toBe(2);
    // Reserving the already-live task must not add a slot.
    await tryAdmitAgentSlot(storage, 'a', 8);
    expect(await countActiveAgents(storage)).toBe(2);
  });
});

describe('tryAdmitAgentSlot', () => {
  test('admits up to the cap, then denies — sequential', async () => {
    // Start empty; admit 8 distinct new tasks.
    const storage = makeStorage([]);
    for (let i = 0; i < 8; i++) {
      const d = await tryAdmitAgentSlot(storage, `t${i}`, 8);
      expect(d.admitted).toBe(true);
    }
    // 9th is denied — the queue signal.
    const denied = await tryAdmitAgentSlot(storage, 't8', 8);
    expect(denied.admitted).toBe(false);
    expect(denied.running).toBe(8);
    expect(denied.limit).toBe(8);
  });

  test('concurrent launches never overshoot the cap (only one gets the last slot)', async () => {
    // 7 already live; two brand-new tasks race for the single remaining slot.
    const storage = makeStorage([
      working('w0'), working('w1'), working('w2'), working('w3'),
      working('w4'), working('w5'), working('w6'),
    ]);
    const [a, b] = await Promise.all([
      tryAdmitAgentSlot(storage, 'x', 8),
      tryAdmitAgentSlot(storage, 'y', 8),
    ]);
    const admitted = [a, b].filter((d) => d.admitted);
    expect(admitted.length).toBe(1); // exactly one wins the last slot
    expect(await countActiveAgents(storage)).toBe(8); // 7 working + 1 reserved
  });

  test('releaseAgentSlot frees a reserved slot so a queued task can take it', async () => {
    const storage = makeStorage([]);
    await tryAdmitAgentSlot(storage, 'only', 1); // reserve the single slot
    expect((await tryAdmitAgentSlot(storage, 'next', 1)).admitted).toBe(false);
    releaseAgentSlot('only');
    expect((await tryAdmitAgentSlot(storage, 'next', 1)).admitted).toBe(true);
  });

  test('re-entrant admit for a live task never consumes a new slot even at the cap', async () => {
    const storage = makeStorage([working('a'), working('b')]);
    const d = await tryAdmitAgentSlot(storage, 'a', 2); // at cap, but 'a' already live
    expect(d.admitted).toBe(true);
    expect(await countActiveAgents(storage)).toBe(2); // unchanged
  });

  test('a blocked-but-alive container occupies a slot, so a new start is denied at the cap', async () => {
    // cap=1, one blocked task still holding a live container → no free slot.
    const storage = makeStorage([{ id: 'b', status: 'blocked', container: 'c-b' }]);
    const d = await tryAdmitAgentSlot(storage, 'new', 1);
    expect(d.admitted).toBe(false);
    expect(d.running).toBe(1);
  });
});

describe('effective limits & ephemeral overrides', () => {
  test('effective limit is the configured value when no override is set', () => {
    const config = configWithLimits(8, 8);
    expect(effectiveAgentLimit(config)).toBe(8);
    expect(effectiveBuilderLimit(config)).toBe(8);
  });

  test('override changes the effective limit but leaves configured untouched', () => {
    const config = configWithLimits(8, 8);
    setLimitOverride('max_concurrent_agents', 12);
    expect(effectiveAgentLimit(config)).toBe(12);
    expect(getLimitOverride('max_concurrent_agents')).toBe(12);
    expect(config.limits.max_concurrent_agents).toBe(8); // config never mutated
    expect(effectiveBuilderLimit(config)).toBe(8); // builder unaffected
  });

  test('clearing the override reverts to the configured value', () => {
    const config = configWithLimits(8, 8);
    setLimitOverride('max_concurrent_builders', 2);
    expect(effectiveBuilderLimit(config)).toBe(2);
    setLimitOverride('max_concurrent_builders', undefined);
    expect(effectiveBuilderLimit(config)).toBe(8);
    expect(getLimitOverride('max_concurrent_builders')).toBeUndefined();
  });
});

describe('orderQueuedTasks (pure drain ordering)', () => {
  const q = (id: string, priority: TaskPriority, created_at: number) => ({ id, priority, created_at });

  test('higher priority drains first', () => {
    const ordered = orderQueuedTasks([
      q('a', 'low', 1),
      q('b', 'urgent', 2),
      q('c', 'normal', 3),
      q('d', 'high', 4),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  test('ties break FIFO by created_at (oldest first)', () => {
    const ordered = orderQueuedTasks([
      q('newer', 'high', 200),
      q('older', 'high', 100),
      q('middle', 'high', 150),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['older', 'middle', 'newer']);
  });

  test('priority dominates age: a newer urgent beats an older low', () => {
    const ordered = orderQueuedTasks([
      q('old-low', 'low', 1),
      q('new-urgent', 'urgent', 999),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['new-urgent', 'old-low']);
  });

  test('does not mutate its input', () => {
    const input = [q('a', 'low', 2), q('b', 'high', 1)];
    const snapshot = input.map((t) => t.id);
    orderQueuedTasks(input);
    expect(input.map((t) => t.id)).toEqual(snapshot);
  });
});

describe('queuePosition', () => {
  const q = (id: string, priority: TaskPriority, created_at: number) => ({ id, priority, created_at });
  const set = [q('a', 'low', 1), q('b', 'urgent', 2), q('c', 'high', 3)];

  test('reports 1-based position and total per the drain ordering', () => {
    // Ordering: b (urgent), c (high), a (low).
    expect(queuePosition(set, 'b')).toEqual({ position: 1, total: 3 });
    expect(queuePosition(set, 'c')).toEqual({ position: 2, total: 3 });
    expect(queuePosition(set, 'a')).toEqual({ position: 3, total: 3 });
  });

  test('returns null for a task not in the queued set', () => {
    expect(queuePosition(set, 'nope')).toBeNull();
  });
});

describe('selectContainersToReap (idle reaper decision)', () => {
  const GRACE = 10 * 60_000; // 10 minutes
  const NOW = 1_000_000_000;
  const minsAgo = (m: number) => NOW - m * 60_000;

  function reap(overrides: Partial<Parameters<typeof selectContainersToReap>[0]>): string[] {
    return selectContainersToReap({
      blocked: [],
      queued: [],
      working: [],
      limit: 1,
      graceMs: GRACE,
      nowMs: NOW,
      baseReapEnabled: true,
      ...overrides,
    });
  }

  const blocked = (id: string, priority: TaskPriority, idleMins: number) =>
    ({ taskId: id, priority, idleSinceMs: minsAgo(idleMins) });
  const demand = (id: string, priority: TaskPriority, created_at = 1) => ({ id, priority, created_at, taskId: id });

  test('grace holds with no demand until G, then base-reaps', () => {
    // In grace (idle 5m < 10m), no queued demand → kept warm.
    expect(reap({ blocked: [blocked('b', 'normal', 5)] })).toEqual([]);
    // Over grace (idle 11m), no demand → base reap (RAM bound).
    expect(reap({ blocked: [blocked('b', 'normal', 11)] })).toEqual(['b']);
  });

  test('strictly-lower-priority queued demand does NOT break grace', () => {
    const out = reap({
      blocked: [blocked('b', 'high', 2)],
      queued: [demand('q', 'low')],
      limit: 1,
    });
    expect(out).toEqual([]); // low demand can't evict a high-priority warm container
  });

  test('same-priority queued demand overrides grace', () => {
    const out = reap({
      blocked: [blocked('b', 'normal', 2)],
      queued: [demand('q', 'normal')],
      limit: 1,
    });
    expect(out).toEqual(['b']);
  });

  test('higher-priority queued demand overrides grace', () => {
    const out = reap({
      blocked: [blocked('b', 'normal', 2)],
      queued: [demand('q', 'high')],
      limit: 1,
    });
    expect(out).toEqual(['b']);
  });

  test('a strictly-lower-priority WORKING task preserves grace (its slot will free and drain to the queued task)', () => {
    const out = reap({
      blocked: [blocked('b', 'high', 2)],
      queued: [demand('q', 'high')],
      working: [{ taskId: 'w', priority: 'low' }],
      limit: 2, // w + b occupy both slots; none free now
    });
    expect(out).toEqual([]); // grace preserved by the pending lower-priority working slot
  });

  test('corollary: a task that blocks while a strictly-higher task is queued is reaped immediately', () => {
    const out = reap({
      blocked: [blocked('justBlocked', 'normal', 0)], // no idle age at all
      queued: [demand('q', 'high')],
      working: [], // nothing lower-priority will free
      limit: 1,
    });
    expect(out).toEqual(['justBlocked']);
  });

  test('demand reap picks the lowest-priority, then oldest-idle candidate first', () => {
    const out = reap({
      blocked: [
        blocked('high', 'high', 3),
        blocked('low-new', 'low', 1),
        blocked('low-old', 'low', 4), // same priority, idle longer → chosen first
      ],
      queued: [demand('q', 'high')], // one demand → reap exactly one
      limit: 3,
    });
    expect(out).toEqual(['low-old']);
  });

  test('host-process (baseReapEnabled=false): no base reap, but demand reap still applies', () => {
    // Over grace, no demand → NOT reaped (cheap idle process, exempt).
    expect(reap({ blocked: [blocked('b', 'normal', 30)], baseReapEnabled: false })).toEqual([]);
    // Same-priority queued demand → still reaped (slot fairness, runner-agnostic).
    expect(
      reap({
        blocked: [blocked('b', 'normal', 1)],
        queued: [demand('q', 'normal')],
        baseReapEnabled: false,
        limit: 1,
      }),
    ).toEqual(['b']);
  });

  test('a free slot serves demand without reaping', () => {
    // limit 2, one blocked container, one queued → a free slot exists → no reap.
    const out = reap({
      blocked: [blocked('b', 'normal', 1)],
      queued: [demand('q', 'urgent')],
      limit: 2,
    });
    expect(out).toEqual([]);
  });
});
