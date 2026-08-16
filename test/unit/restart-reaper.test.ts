/**
 * Unit tests: reaping the previous daemon generation's children at startup.
 *
 * A daemon restart leaves every container it launched pointed at a proxy port
 * that died with the old process, and nothing inside a container can notice
 * that for itself. The new daemon stops them on the way up — see
 * src/daemon/restart-reaper.ts.
 *
 * The eligible set is fixed by a snapshot taken before the daemon binds its
 * listeners, so the sweeps below take run names as an argument rather than
 * asking the runner what is alive — see snapshotPreviousGenerationChildren.
 *
 * These drive the two per-runner sweeps directly with a fake Runner and a
 * partial Storage, so no Docker and no real task launch is involved. The fake
 * storage's `listTasks()` is deliberately empty: that is the early exit inside
 * `maybeAutoResume` that keeps `interruptForDaemonRestart` from trying to
 * launch a real supervisor here. The reap is what is under test; the resume
 * path belongs to the reconciler.
 */

import { describe, test, expect } from 'bun:test';
import {
  reapTaskAgents,
  reapBuilders,
  RESTART_STOP_GRACE_SECONDS,
} from '../../src/daemon/restart-reaper';
import type { Runner } from '../../src/runner/types';
import type { Storage } from '../../src/storage/interface';

interface StopCall { name: string; gracefulTimeoutSeconds?: number }

function fakeRunner(opts: {
  runs?: string[];
  builders?: string[];
  failStopFor?: string[];
}): { runner: Runner; stops: StopCall[]; runs: string[]; builders: string[] } {
  const stops: StopCall[] = [];
  const runner = {
    discoverRunningRuns: async () => opts.runs ?? [],
    discoverProjectBuilderRuns: async () => opts.builders ?? [],
    stopRun: async (name: string, o?: { gracefulTimeoutSeconds?: number }) => {
      stops.push({ name, gracefulTimeoutSeconds: o?.gracefulTimeoutSeconds });
      if (opts.failStopFor?.includes(name)) throw new Error('runner refused');
      return true;
    },
    runDisplayName: (name: string) => name,
  } as unknown as Runner;
  // The reap works from the pre-listen SNAPSHOT, not from live discovery, so
  // tests hand it the same names the snapshot would have captured.
  return { runner, stops, runs: opts.runs ?? [], builders: opts.builders ?? [] };
}

interface FakeStorageOpts {
  /** short id → full id. A run whose short id is absent is another project's. */
  tasks?: Record<string, string>;
  /** Sessions are keyed by FULL task id. */
  session?: { id: string; user_stopped?: boolean; consecutive_interruptions?: number };
  failIntentFor?: string[];
}

function fakeStorage(opts: FakeStorageOpts): {
  storage: Storage;
  calls: {
    statuses: Array<{ taskId: string; status: string }>;
    interrupts: Array<{ sessionId: string; reason: string }>;
    resets: string[];
    intents: Array<{ builderId: string; reason?: string; at: number }>;
  };
  stopOrder: () => number;
} {
  const calls = {
    statuses: [] as Array<{ taskId: string; status: string }>,
    interrupts: [] as Array<{ sessionId: string; reason: string }>,
    resets: [] as string[],
    intents: [] as Array<{ builderId: string; reason?: string; at: number }>,
  };
  let seq = 0;
  const session = opts.session ?? { id: 'sess-1', consecutive_interruptions: 0 };

  const storage = {
    // Resolves by short id (as the run name carries it) or by full id (as the
    // status transition downstream looks it up), like real storage does.
    getTask: async (id: string) => {
      const entries = Object.entries(opts.tasks ?? {});
      const hit = entries.find(([short, full]) => short === id || full === id);
      if (!hit) throw new Error(`Task not found: ${id}`);
      return { id: hit[1], status: 'working' };
    },
    getSessionByTaskId: async () => ({
      consecutive_interruptions: 0,
      ended_at: null,
      ...session,
    }),
    updateTaskStatus: async (taskId: string, status: string) => {
      calls.statuses.push({ taskId, status });
    },
    recordInterrupt: async (sessionId: string, info: { reason: string }) => {
      calls.interrupts.push({ sessionId, reason: info.reason });
    },
    resetConsecutiveInterruptions: async (sessionId: string) => {
      calls.resets.push(sessionId);
    },
    updateSessionContainerName: async () => {},
    listTasks: async () => [],
    listSessions: async () => [],
    saveBuilderResumeIntent: async (intent: { builderId: string; reason?: string }) => {
      if (opts.failIntentFor?.includes(intent.builderId)) throw new Error('storage down');
      calls.intents.push({ builderId: intent.builderId, reason: intent.reason, at: seq++ });
    },
  } as unknown as Storage;

  return { storage, calls, stopOrder: () => seq++ };
}

describe('reapTaskAgents', () => {
  test('stops this project’s task supervisors and marks them interrupted', async () => {
    const { runner, stops, runs } = fakeRunner({ runs: ['lazy-aaaa1111'] });
    const { storage, calls } = fakeStorage({ tasks: { aaaa1111: 'aaaa1111-full-task-id' } });

    const reaped = await reapTaskAgents(runner, storage, '/proj', runs);

    expect(reaped).toEqual(['aaaa1111']);
    expect(stops).toEqual([
      { name: 'lazy-aaaa1111', gracefulTimeoutSeconds: RESTART_STOP_GRACE_SECONDS },
    ]);
    expect(calls.statuses).toEqual([
      { taskId: 'aaaa1111-full-task-id', status: 'interrupted' },
    ]);
  });

  // INVARIANT: never SIGKILL. The runner gets an explicit grace period so the
  // agent can finish writing its turn; that is the same courtesy `lazy upgrade`
  // gives builders, and the whole point of stopping rather than abandoning.
  test('every stop carries the grace period', async () => {
    const { runner, stops, runs } = fakeRunner({ runs: ['lazy-aaaa1111', 'lazy-bbbb2222'] });
    const { storage } = fakeStorage({
      tasks: { aaaa1111: 'full-a', bbbb2222: 'full-b' },
    });
    await reapTaskAgents(runner, storage, '/proj', runs);
    expect(stops.every(s => s.gracefulTimeoutSeconds === RESTART_STOP_GRACE_SECONDS)).toBe(true);
  });

  // INVARIANT: builder containers also match `lazy-*` but have entirely different
  // stop semantics (durable resume intent, host-side relaunch wrapper). Sweeping
  // one up as a task agent would stop it with no intent behind it — a builder
  // session that silently never comes back.
  test('builder runs are excluded from the task sweep', async () => {
    const { runner, stops, runs } = fakeRunner({ runs: ['lazy-builder-abc123', 'lazy-aaaa1111'] });
    const { storage } = fakeStorage({ tasks: { aaaa1111: 'full-a', 'builder-abc123': 'nope' } });

    await reapTaskAgents(runner, storage, '/proj', runs);

    expect(stops.map(s => s.name)).toEqual(['lazy-aaaa1111']);
  });

  // INVARIANT: one daemon per project, but one Docker per machine. Discovery
  // returns every lazy run on the host, so ownership is proved against THIS
  // project's storage before anything is signalled.
  test('runs belonging to another project are never touched', async () => {
    const { runner, stops, runs } = fakeRunner({ runs: ['lazy-ffff9999'] });
    const { storage, calls } = fakeStorage({ tasks: {} });

    expect(await reapTaskAgents(runner, storage, '/proj', runs)).toEqual([]);
    expect(stops).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  test('a run whose stop fails is not marked interrupted', async () => {
    const { runner, runs } = fakeRunner({ runs: ['lazy-aaaa1111'], failStopFor: ['lazy-aaaa1111'] });
    const { storage, calls } = fakeStorage({ tasks: { aaaa1111: 'full-a' } });

    expect(await reapTaskAgents(runner, storage, '/proj', runs)).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  test('the recorded reason names the daemon restart', async () => {
    const { runner, runs } = fakeRunner({ runs: ['lazy-aaaa1111'] });
    const { storage, calls } = fakeStorage({ tasks: { aaaa1111: 'full-a' } });

    await reapTaskAgents(runner, storage, '/proj', runs);

    expect(calls.interrupts.length).toBe(1);
    expect(calls.interrupts[0]!.reason).toContain('daemon restarted');
  });

  // INVARIANT: a restart is not the task's fault, so the crash circuit breaker
  // must not creep toward its limit on it. The counter is RESET, not incremented
  // — otherwise three unrelated restarts would strand a healthy task.
  test('the interruption counter is reset rather than counted against the task', async () => {
    const { runner, runs } = fakeRunner({ runs: ['lazy-aaaa1111'] });
    const { storage, calls } = fakeStorage({
      tasks: { aaaa1111: 'full-a' },
      session: { id: 'sess-1', consecutive_interruptions: 2 },
    });

    await reapTaskAgents(runner, storage, '/proj', runs);

    expect(calls.resets).toEqual(['sess-1']);
  });

  // INVARIANT: only the pre-listen snapshot is eligible. The reap runs on the
  // first reconcile tick, by which time the socket is up and a human may have
  // started something — and killing THAT is the failure this split exists to
  // prevent. The sweep must work from the snapshotted names, never from what the
  // runner reports at reap time.
  test('a run that appeared after the snapshot is never stopped', async () => {
    const { runner, stops } = fakeRunner({ runs: ['lazy-aaaa1111', 'lazy-cccc3333'] });
    const { storage } = fakeStorage({ tasks: { aaaa1111: 'full-a', cccc3333: 'full-c' } });

    // Snapshot saw only aaaa1111; cccc3333 started while the daemon came up.
    await reapTaskAgents(runner, storage, '/proj', ['lazy-aaaa1111']);

    expect(stops.map(s => s.name)).toEqual(['lazy-aaaa1111']);
  });

  // INVARIANT: resetConsecutiveInterruptions also clears `user_stopped` — that is
  // how a manual resume re-arms auto-resume. Calling it here would silently undo
  // a human's `lazy stop` just because the daemon happened to restart.
  test('a user-stopped session keeps its stop (no counter reset)', async () => {
    const { runner, runs } = fakeRunner({ runs: ['lazy-aaaa1111'] });
    const { storage, calls } = fakeStorage({
      tasks: { aaaa1111: 'full-a' },
      session: { id: 'sess-1', user_stopped: true },
    });

    await reapTaskAgents(runner, storage, '/proj', runs);

    expect(calls.resets).toEqual([]);
  });
});

describe('reapBuilders', () => {
  test('stops this project’s builders with a daemon-restart resume intent', async () => {
    const { runner, stops, builders } = fakeRunner({ builders: ['lazy-builder-abc12345'] });
    const { storage, calls } = fakeStorage({});

    expect(await reapBuilders(runner, storage, '/proj', builders)).toEqual(['abc12345']);
    expect(stops).toEqual([
      { name: 'lazy-builder-abc12345', gracefulTimeoutSeconds: RESTART_STOP_GRACE_SECONDS },
    ]);
    // Canonical intent key is the SHORT id, exactly as `lazy upgrade` writes it.
    expect(calls.intents.map(i => i.builderId)).toEqual(['abc12345']);
    expect(calls.intents[0]!.reason).toBe('daemon-restart');
  });

  // INVARIANT: intent FIRST, stop second. The host-side relaunch wrapper unblocks
  // the instant the container dies and immediately looks for an intent; writing
  // it afterwards races, and a missed intent is a builder session that silently
  // does not come back.
  test('the resume intent is durable before the container is signalled', async () => {
    const order: string[] = [];
    const { runner, builders } = fakeRunner({ builders: ['lazy-builder-abc12345'] });
    const patched = {
      ...runner,
      stopRun: async () => { order.push('stop'); return true; },
      discoverProjectBuilderRuns: runner.discoverProjectBuilderRuns.bind(runner),
      runDisplayName: (n: string) => n,
    } as unknown as Runner;
    const storage = {
      saveBuilderResumeIntent: async () => { order.push('intent'); },
    } as unknown as Storage;

    await reapBuilders(patched, storage, '/proj', builders);

    expect(order).toEqual(['intent', 'stop']);
  });

  // If the intent cannot be persisted, stopping the builder would destroy the
  // session with nothing to bring it back. Better a builder still running against
  // a dead proxy — the human can see and restart that — than one silently gone.
  test('a builder whose intent cannot be saved is left running', async () => {
    const { runner, stops, builders } = fakeRunner({ builders: ['lazy-builder-abc12345'] });
    const { storage } = fakeStorage({ failIntentFor: ['abc12345'] });

    expect(await reapBuilders(runner, storage, '/proj', builders)).toEqual([]);
    expect(stops).toEqual([]);
  });

  test('no builders means no storage writes at all', async () => {
    const { runner, stops, builders } = fakeRunner({ builders: [] });
    const { storage, calls } = fakeStorage({});

    expect(await reapBuilders(runner, storage, '/proj', builders)).toEqual([]);
    expect(stops).toEqual([]);
    expect(calls.intents).toEqual([]);
  });
});
