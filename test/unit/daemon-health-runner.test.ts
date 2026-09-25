/**
 * The Runner rows of `lazy daemon health`.
 *
 * Health runs on demand and on every doctor run, so it asks the runner only the
 * cheap questions (is the binary there, does its daemon answer, is the image
 * present) and never starts a container. When the runtime is slow, the row says
 * so and points at the runtime — never at restarting lazy's daemon, which
 * interrupts every agent and fixes nothing about Docker.
 */

import { describe, test, expect } from 'bun:test';
import { collectRunnerRows, runBoundedCheck } from '../../src/daemon/daemon-health';
import { runnerTimeoutRow, buildRunnerRows, buildSweepRow, CHECK_FALLBACK_IDS } from '../../src/daemon/daemon-health-rows';
import type { Runner, HealthCheck } from '../../src/runner';

describe('runner rows', () => {
  // INVARIANT: health never launches a container to answer.
  test('asks the runner for its diagnostics without launch probes', async () => {
    const seen: unknown[] = [];
    const runner = {
      diagnose: async (options?: unknown): Promise<HealthCheck[]> => {
        seen.push(options);
        return [{ state: 'ok', what: 'Claude Code CLI installed (9.9.9)' }];
      },
    } as unknown as Runner;
    const rows = await collectRunnerRows('/p', 'host-process', runner);
    expect(seen).toEqual([{ launchProbes: false }]);
    expect(rows.map(r => r.id)).toContain('runner:image');
  });

  // INVARIANT: a slow container runtime is reported as the runtime being slow,
  // with a runtime remedy — never "restart the lazy daemon".
  test('a runner check that times out points at the runtime, not a daemon restart', () => {
    const docker = runnerTimeoutRow('docker', 35_000);
    expect(docker.state).toBe('fail');
    expect(docker.reason).toContain('Docker did not answer within 35s');
    expect(docker.remedy).toContain('docker info');
    expect(docker.remedy).not.toContain('restart');
    expect(runnerTimeoutRow('podman', 35_000).remedy).toContain('podman');
  });
});

describe('fallback row ids', () => {
  // INVARIANT: when a check produces no rows of its own (it threw, or ran out
  // of time), the row that stands in for it carries an id from the SAME family
  // as its success rows — so a script filtering `--json` on `runner:*` or
  // `sweep:*` sees the failure instead of losing it under a different prefix.
  test('a throwing runner or sweeps check keeps its success-row family', async () => {
    const family = (id: string) => id.split(':')[0];

    const runnerSuccess = buildRunnerRows('docker', [{ state: 'ok', what: 'Docker installed (v27.1.0)' }]);
    const sweepSuccess = buildSweepRow({
      name: 'stranded-working', loop: 'reconcile', runs: 1, lastRunAt: 1, lastDurationMs: 1, lastOkAt: 1,
      lastError: null, lastErrorAt: null, consecutiveFailures: 0, failingSince: null,
    }, 2);

    for (const [fallback, success] of [
      [CHECK_FALLBACK_IDS.runner, runnerSuccess[0]!.id],
      [CHECK_FALLBACK_IDS.sweeps, sweepSuccess.id],
    ] as const) {
      expect(family(fallback)).toBe(family(success));
      const [errored] = await runBoundedCheck({
        id: fallback, group: 'runner', name: 'x', run: async () => { throw new Error('boom'); },
      });
      expect(errored!.id).toBe(fallback);
      const [timedOut] = await runBoundedCheck({
        id: fallback, group: 'runner', name: 'x', timeoutMs: 10, run: () => new Promise(() => {}),
      });
      expect(timedOut!.id).toBe(fallback);
    }
    // The runner's own timeout row uses the same id as its fallback.
    expect(runnerTimeoutRow('docker', 1_000).id).toBe(CHECK_FALLBACK_IDS.runner);
  });
});
