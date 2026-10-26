/**
 * Doctor's one "Daemon health" line.
 *
 * Doctor summarises `lazy daemon health` in one check and points at it; it
 * never repeats a finding one of its own checks already reports. A failing
 * row's own reason and remedy ride in that check, because a client that cannot
 * run `lazy daemon health` (Lazy Teams) must still say which failure it is.
 */

import { describe, test, expect } from 'bun:test';
import { checkDaemonHealthSummary } from '../../src/doctor/sweep';
import { summarizeRows, type DaemonHealthReport, type DaemonHealthRow } from '../../src/daemon/daemon-health-rows';

function report(rows: DaemonHealthRow[]): DaemonHealthReport {
  const { state, counts } = summarizeRows(rows);
  return { checkedAt: new Date().toISOString(), projectRoot: '/p', pid: 1, state, counts, rows };
}

const OK: DaemonHealthRow = { id: 'proxy:listening', group: 'proxy', name: 'Proxy answering', state: 'ok', reason: 'fine' };
const BUILD_MISMATCH: DaemonHealthRow = {
  id: 'daemon:build-match', group: 'daemon', name: "Daemon runs the CLI's build", state: 'warn',
  reason: 'the daemon runs source aaa, this CLI is bbb', remedy: 'restart',
};

describe("doctor's daemon-health summary line", () => {
  // INVARIANT (doctor-single-warning-surface): doctor's own "Daemon runs
  // current code" check already reports a stale daemon build, so the summary
  // leaves the build-match row out rather than saying it a second time.
  test('a build mismatch is not repeated in the summary', async () => {
    const result = await checkDaemonHealthSummary('/p', async () => report([OK, BUILD_MISMATCH]));
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.label).toBe('Daemon health: all 1 checks OK');
  });

  test('runner failure is not reported twice by doctor', async () => {
    const fail: DaemonHealthRow = { ...OK, id: 'runner:available', group: 'runner', name: 'Runner', state: 'fail', reason: 'down' };
    const result = await checkDaemonHealthSummary('/p', async () => report([OK, fail]));
    expect(result.ok).toBe(true);
    expect(result.label).toBe('Daemon health: all 1 checks OK');
  });

  test('proxy listener failure already reported as Runner available does not produce a second notice', async () => {
    const listener = { ...OK, state: 'fail' as const, reason: 'proxy unavailable' };
    const audit = { ...OK, id: 'proxy:audit-log', name: 'Proxy audit log writable' };
    const result = await checkDaemonHealthSummary('/p', async () => report([listener, audit]), true);
    expect(result.ok).toBe(true);
    expect(result.label).toBe('Daemon health: all 1 checks OK');
  });

  test('independent proxy failures remain visible alongside a proxy-resolution failure', async () => {
    const listener = { ...OK, state: 'fail' as const, reason: 'proxy unavailable' };
    const audit = { ...OK, id: 'proxy:audit-log', name: 'Proxy audit log writable', state: 'fail' as const, reason: 'disk full' };
    const result = await checkDaemonHealthSummary('/p', async () => report([listener, audit]), true);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Proxy audit log writable');
    expect(result.detail).not.toContain('Proxy answering');
  });

  test('any other failing row fails the line and names it', async () => {
    const fail: DaemonHealthRow = { ...OK, state: 'fail', reason: 'down' };
    const result = await checkDaemonHealthSummary('/p', async () => report([fail, BUILD_MISMATCH]));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Proxy answering');
    expect(result.detail).not.toContain("CLI's build");
  });

  // INVARIANT: a failing summary carries each failing row's own reason and
  // remedy. Lazy Teams renders this check, not `lazy daemon health`; without
  // them its notice said only "1 failing: Storage lock" and told the operator
  // to send a support bundle for a failure a daemon restart fixes.
  test('a failing row brings its own reason and remedy', async () => {
    const lock: DaemonHealthRow = {
      id: 'storage:lock', group: 'storage', name: 'Storage lock', state: 'fail',
      reason: '/store/.storage-lock is gone: this daemon gave up the lock', remedy: 'Restart the daemon so it takes the lock again',
      remedyKind: 'restart-daemon',
    };
    const result = await checkDaemonHealthSummary('/p', async () => report([OK, lock]));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Storage lock: /store/.storage-lock is gone: this daemon gave up the lock');
    expect(result.detail).toContain('Fix: Restart the daemon so it takes the lock again');
    // Said once, in the detail — the remedy is generic so no surface repeats it.
    expect(result.remedy).not.toContain('so it takes the lock again');
    expect(result.remedy).toContain('Restart the daemon');
  });

  // INVARIANT: the summary is classified `restart-daemon` only when a restart
  // fixes EVERY failing row — then Lazy Teams offers its Restart button instead
  // of "send the support bundle". One row a restart does not fix keeps the
  // family's conservative `manual`.
  test('restart-daemon only when a restart fixes every failing row', async () => {
    const restartable: DaemonHealthRow = { ...OK, state: 'fail', reason: 'down', remedy: 'restart it', remedyKind: 'restart-daemon' };
    const manual: DaemonHealthRow = { ...OK, id: 'storage:lock', name: 'Storage lock', state: 'fail', reason: 'held by pid 7', remedy: 'stop pid 7' };
    const fixable = await checkDaemonHealthSummary('/p', async () => report([restartable]));
    expect(fixable.classification?.remedyKind).toBe('restart-daemon');
    expect(fixable.classification?.family).toBe('daemon-health');
    const mixed = await checkDaemonHealthSummary('/p', async () => report([restartable, manual]));
    expect(mixed.classification).toBeUndefined();
  });
});
