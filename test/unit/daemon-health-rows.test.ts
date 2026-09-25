/**
 * The verdicts of `lazy daemon health`, row by row, from plain fakes.
 *
 * Each builder turns a snapshot into OK / WARN / FAIL. What matters most is the
 * boundary: a healthy daemon must read OK (or people learn to ignore the
 * command), and each failure the command exists for must read FAIL with a
 * remedy (or it is one more log line nobody reads).
 */

import { describe, test, expect } from 'bun:test';
import {
  buildAuditRow,
  buildBuildMatchRow,
  buildDashboardRow,
  buildHeldSyncsRow,
  buildImageRow,
  buildInterruptedRow,
  buildLoopRow,
  buildProxyRow,
  buildRunnerRows,
  buildStorageLockRow,
  buildStorageWritesRow,
  buildStuckWorkingRow,
  buildSweepRow,
  loopThresholds,
  notAliveGoneForMs,
  summarizeRows,
  STORAGE_WRITE_FAIL_MS,
  STORAGE_WRITE_WARN_MS,
  STUCK_WORKING_FAIL_MS,
  SWEEP_FAIL_AFTER_MS,
} from '../../src/daemon/daemon-health-rows';
import {
  DaemonHealthRecorder,
  daemonHealthRecorder,
  forgetDaemonHealth,
  runRecordedSweep,
  type LoopRecord,
  type ProxyHealthHandle,
  type SweepRecord,
} from '../../src/daemon/health-registry';

const NOW = 1_800_000_000_000;

function loop(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    name: 'reconcile',
    intervalMs: 5_000,
    startedAt: NOW - 600_000,
    ticksCompleted: 120,
    ticksSkipped: 0,
    lastTickStartedAt: NOW - 3_000,
    lastTickFinishedAt: NOW - 2_900,
    lastTickDurationMs: 100,
    currentTickStartedAt: null,
    currentPhase: null,
    lastError: null,
    lastErrorAt: null,
    lastTickFailed: false,
    ...overrides,
  };
}

function sweep(overrides: Partial<SweepRecord> = {}): SweepRecord {
  return {
    name: 'stranded-working',
    loop: 'reconcile',
    runs: 10,
    lastRunAt: NOW - 4_000,
    lastDurationMs: 12,
    lastOkAt: NOW - 3_990,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    failingSince: null,
    ...overrides,
  };
}

const PROXY: ProxyHealthHandle = {
  bind: '127.0.0.1',
  binds: ['127.0.0.1'],
  port: 41000,
  auditDir: '/p/.lazy/logs',
  auditHealth: () => ({ lastSuccessAt: null, lastFailure: null, lastFailureAt: null, droppedSinceSuccess: 0 }),
};

describe('loop rows', () => {
  test('a loop completing ticks on schedule is OK', () => {
    const row = buildLoopRow('reconcile', loop(), NOW);
    expect(row.state).toBe('ok');
    expect(row.reason).toContain('120 ticks since start');
  });

  // INVARIANT: staleness is measured from the last COMPLETED tick. A tick
  // wedged on one phase keeps the loop "running" while nothing it exists for
  // happens, and the row must say where it is stuck.
  test('a tick wedged past the fail threshold is a FAIL naming the phase', () => {
    const { failMs } = loopThresholds(5_000);
    const row = buildLoopRow('reconcile', loop({
      lastTickFinishedAt: NOW - failMs - 1_000,
      currentTickStartedAt: NOW - failMs,
      currentPhase: 'runAutoReact',
    }), NOW);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain("in 'runAutoReact'");
    expect(row.remedy).toContain('lazy daemon restart');
  });

  test('between the thresholds it is a WARN', () => {
    const { warnMs } = loopThresholds(5_000);
    expect(buildLoopRow('reconcile', loop({ lastTickFinishedAt: NOW - warnMs - 1 }), NOW).state).toBe('warn');
  });

  test('thresholds scale with the interval and have floors', () => {
    expect(loopThresholds(5_000)).toEqual({ warnMs: 60_000, failMs: 300_000 });
    expect(loopThresholds(60_000)).toEqual({ warnMs: 720_000, failMs: 3_600_000 });
    expect(loopThresholds(100)).toEqual({ warnMs: 60_000, failMs: 300_000 });
  });

  test('a fresh loop with no completed tick yet is OK, not stale', () => {
    const row = buildLoopRow('reconcile', loop({ startedAt: NOW - 2_000, ticksCompleted: 0, lastTickFinishedAt: null }), NOW);
    expect(row.state).toBe('ok');
    expect(row.reason).toContain('no tick completed yet');
  });

  test('a loop that was never started is a FAIL', () => {
    const row = buildLoopRow('reconcile', undefined, NOW);
    expect(row.state).toBe('fail');
    expect(row.remedy).toBeTruthy();
  });

  test('a tick that escaped its phase isolation is a WARN with the error', () => {
    const row = buildLoopRow('reconcile', loop({ lastTickFailed: true, lastError: 'storage closed\nstack…' }), NOW);
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('storage closed');
    expect(row.reason).not.toContain('stack');
  });
});

describe('sweep rows', () => {
  test('a sweep whose last run succeeded is OK, and still mentions an earlier error', () => {
    const row = buildSweepRow(sweep({ lastError: 'git lock busy', lastErrorAt: NOW - 3_600_000 }), NOW);
    expect(row.state).toBe('ok');
    expect(row.reason).toContain('git lock busy');
  });

  test('a sweep that just started failing is a WARN', () => {
    const row = buildSweepRow(sweep({
      consecutiveFailures: 1, failingSince: NOW - 4_000, lastError: 'boom', lastErrorAt: NOW - 3_990,
    }), NOW);
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('boom');
    expect(row.remedy).toContain('lazy daemon logs');
  });

  // INVARIANT: a sweep failing on every tick for minutes is a FAIL — the
  // failure is caught and logged by design, which is exactly why nobody sees it.
  test('a sweep failing continuously past the threshold is a FAIL', () => {
    const row = buildSweepRow(sweep({
      consecutiveFailures: 80, failingSince: NOW - SWEEP_FAIL_AFTER_MS - 1, lastError: 'boom',
    }), NOW);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('80 runs in a row');
  });
});

describe('proxy rows', () => {
  test('answering proxy is OK with its round trip', () => {
    const row = buildProxyRow(PROXY, { ok: true, url: 'http://127.0.0.1:41000/_lazy/health', rttMs: 3 });
    expect(row.state).toBe('ok');
    expect(row.reason).toContain('answered in 3ms');
  });

  test('a proxy that does not answer is a FAIL with a remedy', () => {
    const row = buildProxyRow(PROXY, { ok: false, url: 'http://127.0.0.1:41000/_lazy/health', error: 'Connection refused' });
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('Connection refused');
    expect(row.remedy).toContain('lazy daemon restart');
  });

  test('no proxy at all is a FAIL', () => {
    expect(buildProxyRow(null, null).state).toBe('fail');
  });

  test('a failing audit append is a FAIL even when the directory looks writable', () => {
    const row = buildAuditRow(PROXY, { ok: true }, {
      lastSuccessAt: NOW - 60_000, lastFailure: 'ENOSPC: no space left on device', lastFailureAt: NOW - 1_000, droppedSinceSuccess: 7,
    }, NOW);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('7 records dropped');
    expect(row.reason).toContain('ENOSPC');
  });

  test('an unwritable audit directory is a FAIL', () => {
    const row = buildAuditRow(PROXY, { ok: false, error: 'EACCES' }, PROXY.auditHealth(), NOW);
    expect(row.state).toBe('fail');
  });
});

describe('storage rows', () => {
  const lockPath = '/store/.storage-lock';

  test('held by this daemon is OK', () => {
    const row = buildStorageLockRow({ kind: 'held', lockPath, pid: 100, acquiredAt: new Date(NOW - 60_000).toISOString(), verdict: { alive: true } }, 100, NOW);
    expect(row.state).toBe('ok');
    expect(row.reason).toContain('held by this daemon');
  });

  test('held by another live process is a FAIL that says not to delete it', () => {
    const row = buildStorageLockRow({ kind: 'held', lockPath, pid: 200, acquiredAt: null, verdict: { alive: true } }, 100, NOW);
    expect(row.state).toBe('fail');
    expect(row.remedy).toContain('Do NOT delete');
  });

  // INVARIANT (memory: storage-lock-pid-reuse-wedge): a recycled pid is a dead
  // holder, and the row says so rather than calling it alive.
  test('a holder whose pid was recycled is reported as pid reuse', () => {
    const row = buildStorageLockRow({ kind: 'held', lockPath, pid: 200, acquiredAt: null, verdict: { alive: false, reason: 'pid-reused' } }, 100, NOW);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('pid reuse');
  });

  test('a missing lock file is a FAIL: nothing keeps a second writer out', () => {
    const row = buildStorageLockRow({ kind: 'missing', lockPath }, 100, NOW);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('second process');
  });

  test('a backend without a file lock is OK', () => {
    expect(buildStorageLockRow({ kind: 'no-file-lock', backend: 'sqlite' }, 100, NOW).state).toBe('ok');
  });

  test('writes: idle is OK, a long write WARNs then FAILs', () => {
    const idle = { lockPath, lastSuccessAt: NOW - 5_000, activeSince: null, waiting: 0 };
    expect(buildStorageWritesRow(idle, true, NOW).state).toBe('ok');
    expect(buildStorageWritesRow({ ...idle, activeSince: NOW - STORAGE_WRITE_WARN_MS }, true, NOW).state).toBe('warn');
    const wedged = buildStorageWritesRow({ ...idle, activeSince: NOW - STORAGE_WRITE_FAIL_MS, waiting: 4 }, true, NOW);
    expect(wedged.state).toBe('fail');
    expect(wedged.reason).toContain('4 queued');
  });
});

describe('runner rows', () => {
  test('runner diagnostics map one-to-one, verdicts unchanged', () => {
    const rows = buildRunnerRows('docker', [
      { state: 'ok', what: 'Docker installed' },
      { state: 'fail', what: 'Docker daemon running', reason: 'Cannot connect to the Docker daemon' },
    ]);
    expect(rows.map(r => r.state)).toEqual(['ok', 'fail']);
    expect(rows[1]!.remedy).toContain('Cannot connect');
  });

  // INVARIANT: a runner row's id is stable across versions and outcomes, so a
  // script keyed on it (`--json | jq`) keeps working after Docker or the agent
  // is upgraded, and an OK row and its FAIL counterpart share one id.
  test('row ids do not change with versions, parenthesised detail or outcome', () => {
    const a = buildRunnerRows('docker', [
      { state: 'ok', what: 'Docker installed (v27.1.0)' },
      { state: 'ok', what: 'claude in the runner image: 2.1.0 (lazy-runner:abc)' },
      { state: 'ok', what: '[agent] pi reachable at http://localhost:11434' },
    ]);
    const b = buildRunnerRows('docker', [
      { state: 'ok', what: 'Docker installed (v28.0.1)' },
      { state: 'ok', what: 'claude in the runner image: 2.2.4 (lazy-runner:def)' },
      { state: 'fail', what: '[agent] pi reachable', reason: 'connection refused' },
    ]);
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
    expect(a.map(r => r.id)).toEqual(['runner:docker-installed', 'runner:claude-in-the-runner-image', 'runner:agent-pi-reachable']);
  });

  test('a missing image is a WARN (built on next launch), a host runner has none', () => {
    expect(buildImageRow('docker', { name: 'lazy-runner:x', present: false }).state).toBe('warn');
    expect(buildImageRow('docker', { name: 'lazy-runner:x', present: true }).state).toBe('ok');
    expect(buildImageRow('host-process', null).state).toBe('ok');
  });
});

describe('task rows', () => {
  // INVARIANT: a task that has only just launched has no live run and no
  // status checkpoint yet — its container is still being created. That is not
  // a stuck task: the reconciler itself leaves it alone for its grace period,
  // and health must not FAIL on what the reconciler is right to wait for.
  test('a just-launched task inside the reconciler grace is not reported stuck', () => {
    const justLaunched = { finishedAt: null, statusUpdatedAt: null, lastInteractionAt: NOW - 3_000 };
    // null = not a candidate at all, so the row never lists it.
    expect(notAliveGoneForMs(justLaunched, NOW, 30_000)).toBeNull();
  });

  test('past the grace, the launch time is the fallback sign of life', () => {
    const signs = { finishedAt: null, statusUpdatedAt: null, lastInteractionAt: NOW - 45_000 };
    expect(notAliveGoneForMs(signs, NOW, 30_000)).toBe(45_000);
    expect(buildStuckWorkingRow([{ code: 'a', goneForMs: 45_000 }], 1).state).toBe('warn');
  });

  test('the latest sign of life wins, and none at all is unknown', () => {
    const signs = {
      finishedAt: new Date(NOW - 200_000).toISOString(),
      statusUpdatedAt: new Date(NOW - 150_000).toISOString(),
      lastInteractionAt: NOW - 600_000,
    };
    expect(notAliveGoneForMs(signs, NOW, 30_000)).toBe(150_000);
    expect(notAliveGoneForMs({ finishedAt: null, statusUpdatedAt: null, lastInteractionAt: null }, NOW, 30_000)).toBe('unknown');
  });

  test('no stuck working tasks is OK', () => {
    expect(buildStuckWorkingRow([], 3).state).toBe('ok');
  });

  // INVARIANT: this command REPORTS working(not-alive); it never recovers the
  // task itself. A run gone for minutes is a FAIL naming each task.
  test('a working task whose run is long gone is a FAIL naming it', () => {
    const row = buildStuckWorkingRow([{ code: 'fix-it', goneForMs: STUCK_WORKING_FAIL_MS + 1 }], 1);
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('fix-it');
    expect(row.remedy).toContain('lazy stop');
  });

  test('a run gone only seconds (reconciler not due yet) is a WARN', () => {
    expect(buildStuckWorkingRow([{ code: 'a', goneForMs: 5_000 }], 1).state).toBe('warn');
  });

  test('an unknown gone-for time is treated as overdue', () => {
    expect(buildStuckWorkingRow([{ code: 'a', goneForMs: null }], 1).state).toBe('fail');
  });

  test('held syncs: queued is OK, repeatedly failing is a WARN', () => {
    expect(buildHeldSyncsRow([]).state).toBe('ok');
    expect(buildHeldSyncsRow([{ code: 'a', pending: 1, state: 'due', attempt: null }]).state).toBe('ok');
    const failing = buildHeldSyncsRow([{ code: 'a', pending: 2, state: 'fetch failed, attempt 3', attempt: 2 }]);
    expect(failing.state).toBe('warn');
    expect(failing.remedy).toContain('lazy sync');
  });

  test('interrupted: past the auto-resume budget is a WARN, stopped-by-a-person is fine', () => {
    expect(buildInterruptedRow([{ code: 'a', state: 'queued' }, { code: 'b', state: 'stopped' }], true).state).toBe('ok');
    const gaveUp = buildInterruptedRow([{ code: 'a', state: 'gave-up' }], true);
    expect(gaveUp.state).toBe('warn');
    expect(gaveUp.remedy).toContain('lazy resume');
  });

  test('interrupted with auto-resume off: nothing resumes them', () => {
    const row = buildInterruptedRow([{ code: 'a', state: 'queued' }], false);
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('auto_resume is off');
  });
});

describe('dashboard and daemon rows', () => {
  test('bound is OK; a failed container-reachability bind is a WARN carrying the logged reason', () => {
    const primary = { surface: 'dashboard' as const, host: '127.0.0.1', port: 26024, primary: true, ok: true };
    expect(buildDashboardRow({ managed: false, binds: [primary], dashboardUrl: 'http://lazy.localhost:26024', bridgeUnreachable: null }).state).toBe('ok');
    const row = buildDashboardRow({
      managed: false,
      binds: [primary, { surface: 'dashboard', host: '172.17.0.1', port: 26024, primary: false, ok: false, reason: 'Could not also bind the daemon to 172.17.0.1:26024 (port busy on that interface).' }],
      dashboardUrl: null,
      bridgeUnreachable: null,
    });
    expect(row.state).toBe('warn');
    expect(row.reason).toContain('172.17.0.1');
  });

  test('managed mode has no dashboard, and that is OK', () => {
    expect(buildDashboardRow({ managed: true, binds: [], dashboardUrl: null, bridgeUnreachable: null }).state).toBe('ok');
  });

  test('build match: same checkout is OK, different source or version WARNs, incomparable kinds are not judged', () => {
    const daemon = { version: '0.23.1', sourceId: 'aaa', sourceIdKind: 'computed' };
    expect(buildBuildMatchRow(daemon, { version: '0.23.1', sourceId: 'aaa', sourceIdKind: 'baked' }).state).toBe('ok');
    expect(buildBuildMatchRow(daemon, { version: '0.23.1', sourceId: 'bbb', sourceIdKind: 'computed' }).state).toBe('warn');
    expect(buildBuildMatchRow(daemon, { version: '0.22.0', sourceId: 'aaa', sourceIdKind: 'computed' }).state).toBe('warn');
    const incomparable = buildBuildMatchRow(daemon, { version: '0.23.1', sourceId: 'build-x', sourceIdKind: 'build' });
    expect(incomparable.state).toBe('ok');
    expect(incomparable.reason).toContain('not comparable');
  });

  test('summary takes the worst state', () => {
    const ok = buildImageRow('host', null);
    const fail = buildProxyRow(null, null);
    expect(summarizeRows([ok, fail])).toEqual({ state: 'fail', counts: { ok: 1, warn: 0, fail: 1 } });
  });
});

describe('the recorder', () => {
  test('ticks, skips and sweep streaks are recorded', () => {
    let t = 1_000;
    const rec = new DaemonHealthRecorder(() => t);
    rec.loopStarted('reconcile', 5_000);
    rec.tickStarted('reconcile');
    const started = t;
    rec.tickPhase('reconcile', 'reconcileTasks');
    rec.tickSkipped('reconcile');
    t += 50;
    rec.sweepFinished('reconcile', 'x', started, new Error('first'));
    t += 50;
    rec.sweepFinished('reconcile', 'x', started + 50, new Error('second'));
    rec.tickFinished('reconcile', started);

    const snap = rec.snapshot();
    const l = snap.loops[0]!;
    expect(l.ticksCompleted).toBe(1);
    expect(l.ticksSkipped).toBe(1);
    expect(l.currentTickStartedAt).toBeNull();
    expect(l.lastTickDurationMs).toBe(100);
    const s = snap.sweeps[0]!;
    expect(s.consecutiveFailures).toBe(2);
    expect(s.failingSince).toBe(started);
    expect(s.lastError).toBe('second');

    rec.sweepFinished('reconcile', 'x', t);
    expect(rec.snapshot().sweeps[0]!.consecutiveFailures).toBe(0);
    expect(rec.snapshot().sweeps[0]!.lastError).toBe('second');
  });

  // INVARIANT: a finished sweep hands the phase back. Otherwise a tick wedged
  // BETWEEN phases is reported as stuck in a phase that already completed,
  // sending whoever reads it after the wrong code.
  test('a recorded sweep restores the phase it replaced, success or failure', async () => {
    const root = `/tmp/health-phase-${Math.random()}`;
    const rec = daemonHealthRecorder(root);
    rec.loopStarted('reconcile', 5_000);
    rec.tickStarted('reconcile');
    rec.tickPhase('reconcile', 'reconcileTasks');
    await runRecordedSweep(root, 'reconcile', 'stranded-working', async () => {
      expect(rec.snapshot().loops[0]!.currentPhase).toBe('stranded-working');
    }, () => {});
    expect(rec.snapshot().loops[0]!.currentPhase).toBe('reconcileTasks');
    await runRecordedSweep(root, 'reconcile', 'merged-branches', async () => { throw new Error('boom'); }, () => {});
    expect(rec.snapshot().loops[0]!.currentPhase).toBe('reconcileTasks');
    forgetDaemonHealth(root);
  });

  // INVARIANT: a tick the reconciler force-reset past finishes late; its close
  // must not erase the NEWER tick's in-flight marker, or a wedged loop would
  // read as idle.
  test('a late-finishing old tick does not clear the current tick', () => {
    let t = 0;
    const rec = new DaemonHealthRecorder(() => t);
    rec.loopStarted('reconcile', 5_000);
    rec.tickStarted('reconcile');
    const old = t;
    t = 400_000;
    rec.tickStarted('reconcile');
    rec.tickFinished('reconcile', old);
    expect(rec.snapshot().loops[0]!.currentTickStartedAt).toBe(400_000);
  });
});
