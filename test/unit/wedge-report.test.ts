import { describe, test, expect, beforeEach } from 'bun:test';
import {
  boundedStep,
  collectWedgeReport,
  inFlightRequests,
  logWedgeIfStuck,
  loopWedgeViews,
  pendingStepLabels,
  resetWedgeReportForTests,
  threadWaitChannels,
  trackRequest,
  WEDGE_LOG_AFTER_MS,
} from '../../src/daemon/wedge-report';
import { DaemonHealthRecorder, daemonHealthRecorder, forgetDaemonHealth } from '../../src/daemon/health-registry';

const ROOT = '/tmp/wedge-report-test-root';

describe('wedge report', () => {
  beforeEach(() => {
    resetWedgeReportForTests();
    forgetDaemonHealth(ROOT);
  });

  // INVARIANT: a bounded step never waits past its deadline, and a step still
  // pending is reused rather than asked again. A status poll every few seconds
  // against a dependency that never answers must not pile up one waiter per poll.
  test('a step that never settles times out, and the next call reuses it', async () => {
    let calls = 0;
    const never = () => { calls++; return new Promise<number>(() => {}); };
    const first = await boundedStep('stuck', never, 20);
    expect(first).toEqual({ ok: false, reason: 'timeout' });
    expect(pendingStepLabels()).toContain('stuck');
    await boundedStep('stuck', never, 20);
    expect(calls).toBe(1);
  });

  test('a settled step answers and is forgotten; a throwing one is an error, not a timeout', async () => {
    expect(await boundedStep('fine', async () => 7, 1_000)).toEqual({ ok: true, value: 7 });
    expect(pendingStepLabels()).not.toContain('fine');
    const failed = await boundedStep('broken', async () => { throw new Error('nope'); }, 1_000);
    expect(failed).toEqual({ ok: false, reason: 'error', error: 'nope' });
  });

  test('in-flight requests are listed oldest first until they settle', () => {
    const doneA = trackRequest('GET', '/daemon/status', 1_000);
    trackRequest('POST', '/rpc/list', 2_000);
    expect(inFlightRequests(5_000)).toEqual([
      { method: 'GET', route: '/daemon/status', ageMs: 4_000 },
      { method: 'POST', route: '/rpc/list', ageMs: 3_000 },
    ]);
    doneA();
    expect(inFlightRequests(5_000).map((r) => r.route)).toEqual(['/rpc/list']);
  });

  // INVARIANT: a loop tick wedged past the threshold is logged once, with its
  // phase — the log is the one surface left when the HTTP route is the thing stuck.
  test('a wedged loop tick is reported once per tick, with its phase', () => {
    const health = daemonHealthRecorder(ROOT);
    health.loopStarted('reconcile', 5_000);
    health.tickStarted('reconcile');
    health.tickPhase('reconcile', 'getOrCreateStorage');
    const later = Date.now() + WEDGE_LOG_AFTER_MS + 1_000;
    expect(logWedgeIfStuck(ROOT, () => null, later)).toBe(true);
    expect(logWedgeIfStuck(ROOT, () => null, later + 15_000)).toBe(false);

    const report = collectWedgeReport(ROOT, { stage: 'acquiring the storage lock', sinceMs: 9_000 }, later);
    expect(report.loops[0]).toMatchObject({ name: 'reconcile', phase: 'getOrCreateStorage' });
    expect(report.storeOpen?.stage).toBe('acquiring the storage lock');
  });

  // INVARIANT: "stalled" measures time since a tick COMPLETED, so a stuck-tick
  // force-reset (which abandons the tick and starts a new one) cannot reset it.
  // The fleet restarts on this; a clock that a force-reset zeroed every 300s
  // would never pass its grace.
  test('a force-reset tick does not reset the stall clock, and is recorded as a failure', () => {
    let now = 1_000_000;
    const health = new DaemonHealthRecorder(() => now);
    health.loopStarted('reconcile', 5_000);
    health.tickStarted('reconcile');
    now += 300_001;
    health.tickAbandoned('reconcile', new Error('tick abandoned after 300s'));
    health.tickStarted('reconcile');
    now += 1_000;
    const loop = health.snapshot().loops[0]!;
    expect(loop.lastTickFailed).toBe(true);
    expect(loop.lastTickFinishedAt).toBeNull();
    expect(now - loop.startedAt).toBe(301_001);
  });

  test('a loop is stalled only past the threshold plus two intervals', () => {
    const health = daemonHealthRecorder(ROOT);
    health.loopStarted('remote-sync', 60_000);
    const started = health.snapshot().loops[0]!.startedAt;
    expect(loopWedgeViews(ROOT, started + WEDGE_LOG_AFTER_MS + 100_000)[0]!.stalled).toBe(false);
    const late = loopWedgeViews(ROOT, started + WEDGE_LOG_AFTER_MS + 121_000)[0]!;
    expect(late.stalled).toBe(true);
    expect(late.stalledMs).toBe(WEDGE_LOG_AFTER_MS + 121_000);
  });

  test('thread wait channels are counted on Linux', () => {
    const channels = threadWaitChannels();
    if (process.platform !== 'linux') {
      expect(channels).toBeNull();
      return;
    }
    expect(Object.values(channels!).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
