/**
 * The daemon's synchronous turns (`ask`, `pre_accept`) must notice a supervisor
 * that died instead of polling a directory nothing will ever write to.
 *
 * INVARIANT: waiting for a response is liveness-aware. A bare response poll
 * turned a supervisor that crashed at startup — or was never launched because a
 * stale `isRunning` said one was already up — into a ~35-minute `lazy accept`
 * spinner with nothing running at all. That is the field incident this helper
 * exists for.
 *
 * INVARIANT: the two graces are load-bearing, and neither may be dropped to
 * make an abort faster.
 *   - The supervisor legitimately writes `response.json` and THEN exits, so
 *     "gone" and "answered" is the NORMAL successful ending. A run seen gone
 *     must never abort a wait whose response is already on disk or about to be.
 *   - A run the caller just launched is not instantly visible to `isRunning`, so
 *     a slow start must not read as a death.
 *
 * INVARIANT: a liveness probe that THROWS means "unknown", never "dead".
 * Manufacturing an abort out of a transient `docker inspect` failure would turn
 * a hiccup into a refused accept.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { waitForSupervisorResponse } from '../../src/daemon/supervisor-wait';
import { writeResponse } from '../../src/protocol';
import type { CompletedResponse } from '../../src/protocol';
import type { Runner } from '../../src/runner/types';

const answered: CompletedResponse = {
  status: 'completed',
  result: 'the turn finished',
  session_id: 'agent-session-1',
  usage: { input_tokens: 0, output_tokens: 0 },
};

/**
 * A runner that only has to answer the three questions this helper asks.
 * `isRunning` is a caller-supplied function so a test can script a run that
 * dies mid-wait; everything else is fixed diagnostics.
 */
function fakeRunner(opts: {
  isRunning: () => boolean | Promise<boolean>;
  exitCode?: number | null;
  logs?: string | null;
}): Runner {
  return {
    isRunning: async () => opts.isRunning(),
    getRunExitCode: async () => opts.exitCode ?? null,
    getRunLogs: async () => opts.logs ?? null,
  } as unknown as Runner;
}

/** Graces small enough for a unit test, large enough to still be graces. */
const FAST = { intervalMs: 10, startupGraceMs: 40, deathGraceMs: 60, livenessIntervalMs: 10 };

describe('waitForSupervisorResponse', () => {
  let protoDir: string;

  beforeEach(async () => { protoDir = await mkdtemp(join(tmpdir(), 'lazy-supwait-')); });
  afterEach(async () => { await rm(protoDir, { recursive: true, force: true }); });

  test('returns the response as soon as the supervisor writes one', async () => {
    const runner = fakeRunner({ isRunning: () => true });
    setTimeout(() => writeResponse(protoDir, answered), 30);

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 5_000, ...FAST,
    });

    expect(outcome.kind).toBe('response');
    if (outcome.kind === 'response') expect(outcome.response.status).toBe('completed');
  });

  test('aborts as dead when the run is gone and no response ever arrives', async () => {
    const runner = fakeRunner({ isRunning: () => false, exitCode: 137, logs: 'oom-killed' });

    const started = Date.now();
    const outcome = await waitForSupervisorResponse({
      // A 30-minute budget stands in for the real pre-accept timeout: the point
      // is that the abort does NOT wait for it.
      protoDir, runner, runName: 'lazy-x', timeoutMs: 30 * 60 * 1000, ...FAST,
    });

    expect(outcome.kind).toBe('dead');
    expect(Date.now() - started).toBeLessThan(5_000);
    if (outcome.kind === 'dead') {
      expect(outcome.diagnostics).toContain('exit code 137');
      expect(outcome.diagnostics).toContain('oom-killed');
    }
  });

  test('a run that exits right AFTER answering is a success, not a death', async () => {
    // The real ordering: response written, process exits, only then is it
    // observed gone. Turning this race into an abort would fail every
    // one-shot supervisor turn.
    let alive = true;
    const runner = fakeRunner({ isRunning: () => alive });
    setTimeout(() => { writeResponse(protoDir, answered); alive = false; }, 60);

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 5_000, ...FAST,
    });

    expect(outcome.kind).toBe('response');
  });

  test('a response landing inside the death grace still wins', async () => {
    // Same race observed in the other order: the probe sees the run gone first,
    // and the response appears while the grace is running.
    let alive = true;
    setTimeout(() => { alive = false; }, 50);
    setTimeout(() => writeResponse(protoDir, answered), 80);
    const runner = fakeRunner({ isRunning: () => alive });

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 5_000, ...FAST,
    });

    expect(outcome.kind).toBe('response');
  });

  test('a probe that throws is treated as alive, so the wait falls back to its timeout', async () => {
    const runner = fakeRunner({ isRunning: () => { throw new Error('docker daemon unreachable'); } });

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 300, ...FAST,
    });

    expect(outcome.kind).toBe('timeout');
  });

  test('a live run that never answers times out rather than being called dead', async () => {
    const runner = fakeRunner({ isRunning: () => true });

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 300, ...FAST,
    });

    expect(outcome.kind).toBe('timeout');
  });

  test('the startup grace protects a run that is not visible yet', async () => {
    // Not running for the first stretch, then up and answering. Probing during
    // that window would abort a perfectly healthy launch.
    const start = Date.now();
    const runner = fakeRunner({ isRunning: () => Date.now() - start > 120 });
    setTimeout(() => writeResponse(protoDir, answered), 200);

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 5_000,
      intervalMs: 10, startupGraceMs: 150, deathGraceMs: 60, livenessIntervalMs: 10,
    });

    expect(outcome.kind).toBe('response');
  });

  test('alreadyRunning skips the startup grace — a reused run is meaningful at once', async () => {
    // The stale-`isRunning` shape: launch was skipped because a run was reported
    // up, and there is nothing actually there. Nothing to wait for, so the
    // answer must come back in death-grace time.
    const runner = fakeRunner({ isRunning: () => false });

    const started = Date.now();
    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 30 * 60 * 1000,
      alreadyRunning: true, intervalMs: 10, deathGraceMs: 60, livenessIntervalMs: 10,
    });

    expect(outcome.kind).toBe('dead');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('diagnostics are optional — a runner that knows nothing still aborts', async () => {
    const runner = fakeRunner({ isRunning: () => false, exitCode: null, logs: null });

    const outcome = await waitForSupervisorResponse({
      protoDir, runner, runName: 'lazy-x', timeoutMs: 30 * 60 * 1000, ...FAST,
    });

    expect(outcome.kind).toBe('dead');
    if (outcome.kind === 'dead') expect(outcome.diagnostics).toBeNull();
  });
});
