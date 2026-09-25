/**
 * Doctor's one "Daemon health" line.
 *
 * Doctor summarises `lazy daemon health` in a single line and points at it;
 * it never repeats a finding one of its own checks already reports.
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

  test('any other failing row fails the line and names it', async () => {
    const fail: DaemonHealthRow = { ...OK, state: 'fail', reason: 'down' };
    const result = await checkDaemonHealthSummary('/p', async () => report([fail, BUILD_MISMATCH]));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Proxy answering');
    expect(result.detail).not.toContain("CLI's build");
  });
});
