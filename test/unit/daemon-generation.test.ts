/**
 * Unit tests: daemon generation detection.
 *
 * A daemon restart invalidates every child the previous daemon launched (the
 * in-process audit proxy moves to a new OS-assigned port and no child re-reads
 * ANTHROPIC_BASE_URL). This module is the shared "is that a different daemon"
 * signal every stop-and-resume path keys off — see src/daemon/generation.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  generationChanged,
  watchDaemonGeneration,
} from '../../src/daemon/generation';
import type { DaemonStatus } from '../../src/daemon/lifecycle';

const up = (over: Partial<DaemonStatus> = {}): DaemonStatus => ({
  running: true,
  pid: 100,
  buildTime: 'b1',
  uptime: 50,
  instanceId: 'gen-1',
  ...over,
});

describe('generationChanged', () => {
  test('same instanceId is the same daemon, whatever else moved', () => {
    expect(generationChanged(up(), up({ uptime: 900, pid: 100 }))).toBe(false);
  });

  test('different instanceId is a restart', () => {
    expect(generationChanged(up(), up({ instanceId: 'gen-2' }))).toBe(true);
  });

  // INVARIANT: the exact id WINS over every heuristic. A daemon that legitimately
  // reports a lower uptime (clock adjustment) or lands on a recycled pid must not
  // be reported as restarted when it says it is the same process — a false
  // positive stops a live child for nothing.
  test('instanceId match overrides a pid change and an uptime reset', () => {
    expect(generationChanged(
      up({ pid: 1, uptime: 900 }),
      up({ pid: 2, uptime: 1 }),
    )).toBe(false);
  });

  // INVARIANT: "down" is not a restart. Acting while the daemon is away would
  // stop the child with nowhere to resume to; the replacement is the event.
  test('a daemon that is merely down is not a restart', () => {
    expect(generationChanged(up(), { running: false })).toBe(false);
  });

  test('a live daemon observed after a down baseline is a restart', () => {
    expect(generationChanged({ running: false }, up())).toBe(true);
  });

  describe('legacy fallback (one side predates instanceId)', () => {
    test('buildTime change', () => {
      expect(generationChanged(
        { running: true, pid: 1, buildTime: 'old' },
        { running: true, pid: 1, buildTime: 'new' },
      )).toBe(true);
    });

    test('pid change with buildTime unchanged (dev builds)', () => {
      expect(generationChanged(
        { running: true, pid: 1, buildTime: 'dev' },
        { running: true, pid: 2, buildTime: 'dev' },
      )).toBe(true);
    });

    test('uptime going backwards', () => {
      expect(generationChanged(
        { running: true, pid: 1, uptime: 500 },
        { running: true, pid: 1, uptime: 3 },
      )).toBe(true);
    });

    // An id APPEARING is itself evidence the daemon was replaced by a newer
    // build — which is precisely the upgrade case.
    test('instanceId appearing where the baseline had none', () => {
      expect(generationChanged(
        { running: true, pid: 1, buildTime: 'b', uptime: 5 },
        { running: true, pid: 1, buildTime: 'b', uptime: 9, instanceId: 'gen-1' },
      )).toBe(true);
    });

    test('an unchanged legacy daemon is not a restart', () => {
      expect(generationChanged(
        { running: true, pid: 1, buildTime: 'b', uptime: 5 },
        { running: true, pid: 1, buildTime: 'b', uptime: 9 },
      )).toBe(false);
    });
  });
});

describe('watchDaemonGeneration', () => {
  const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  test('fires once when the generation changes, then stops polling', async () => {
    let reads = 0;
    let fired = 0;
    const watch = watchDaemonGeneration({
      projectRoot: '/proj',
      baseline: up(),
      intervalMs: 5,
      readStatus: async () => { reads++; return up({ instanceId: 'gen-2' }); },
      onRestart: () => { fired++; },
    });
    await settle(60);
    watch.stop();
    expect(fired).toBe(1);
    // Stopped at the first change rather than polling on.
    expect(reads).toBeLessThanOrEqual(2);
  });

  test('does not fire while the same daemon keeps answering', async () => {
    let fired = 0;
    const watch = watchDaemonGeneration({
      projectRoot: '/proj',
      baseline: up(),
      intervalMs: 5,
      readStatus: async () => up({ uptime: 500 }),
      onRestart: () => { fired++; },
    });
    await settle(40);
    watch.stop();
    expect(fired).toBe(0);
  });

  // A status probe that throws is indistinguishable from "daemon momentarily
  // down" — not an event, and never a reason to take down the watch.
  test('reader errors are swallowed and polling continues', async () => {
    let reads = 0;
    let fired = 0;
    const watch = watchDaemonGeneration({
      projectRoot: '/proj',
      baseline: up(),
      intervalMs: 5,
      readStatus: async () => {
        reads++;
        if (reads < 3) throw new Error('connection refused');
        return up({ instanceId: 'gen-2' });
      },
      onRestart: () => { fired++; },
    });
    await settle(80);
    watch.stop();
    expect(fired).toBe(1);
  });

  test('stop() before any change prevents the callback entirely', async () => {
    let fired = 0;
    const watch = watchDaemonGeneration({
      projectRoot: '/proj',
      baseline: up(),
      intervalMs: 5,
      readStatus: async () => up({ instanceId: 'gen-2' }),
      onRestart: () => { fired++; },
    });
    watch.stop();
    await settle(40);
    expect(fired).toBe(0);
  });

  // With no baseline the watch takes its own on the first poll, so the daemon
  // that is up when the watch starts is by definition "current".
  test('self-baselines when none is supplied', async () => {
    let reads = 0;
    let fired = 0;
    const watch = watchDaemonGeneration({
      projectRoot: '/proj',
      intervalMs: 5,
      readStatus: async () => {
        reads++;
        return up({ instanceId: reads <= 2 ? 'gen-1' : 'gen-2' });
      },
      onRestart: () => { fired++; },
    });
    await settle(80);
    watch.stop();
    expect(fired).toBe(1);
  });
});
