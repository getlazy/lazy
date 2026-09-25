/**
 * A daemon started before `lazy daemon health` existed.
 *
 * The realistic skew: someone upgrades lazy and keeps the daemon they already
 * had. That daemon answers the health RPC with its generic unknown-command 404.
 * The answer is "restart it to pick up the new code", not "it is hung" — and
 * doctor, whose own "Daemon runs current code" check already says so, must not
 * report the same cause a second time.
 */

import { describe, test, expect } from 'bun:test';
import { RpcApplicationError } from '../../src/daemon/client';
import { DaemonPredatesHealthError, classifyHealthRequestError } from '../../src/daemon/daemon-health-client';
import { healthRequestFailureRow } from '../../src/cli/commands/daemon-health';
import { checkDaemonHealthSummary } from '../../src/doctor/sweep';

const UNKNOWN = new RpcApplicationError(404, 'Unknown RPC command: daemonHealth');

describe('a daemon that predates daemonHealth', () => {
  test('its unknown-command 404 is recognised as "predates", anything else passes through', () => {
    expect(classifyHealthRequestError(UNKNOWN)).toBeInstanceOf(DaemonPredatesHealthError);
    const other = new RpcApplicationError(500, 'storage closed');
    expect(classifyHealthRequestError(other)).toBe(other);
    // A 404 about something else (a missing task, say) is not this case.
    const notFound = new RpcApplicationError(404, 'Task not found: abc');
    expect(classifyHealthRequestError(notFound)).toBe(notFound);
  });

  // INVARIANT: a predating daemon gets a restart remedy, never the hung-daemon
  // one — sending someone to the logs for a daemon that is merely old wastes
  // their time and hides the one action that fixes it.
  test('the CLI reports it as a restart, not a hang', () => {
    const row = healthRequestFailureRow(new DaemonPredatesHealthError());
    expect(row.state).toBe('fail');
    expect(row.reason).toContain('predates');
    expect(row.remedy).toContain('lazy daemon restart');
    expect(row.remedy).not.toContain('hung');
    expect(healthRequestFailureRow(new Error('socket hang up')).remedy).toContain('hung');
  });

  // INVARIANT (doctor-single-warning-surface): doctor's own "Daemon runs
  // current code" check reports the old daemon; the health line only says it
  // was skipped.
  test("doctor skips the line and defers to its own code-current check", async () => {
    const result = await checkDaemonHealthSummary('/p', async () => { throw new DaemonPredatesHealthError(); });
    expect(result.ok).toBe(true);
    expect(result.label).toContain('skipped');
    expect(result.detail).toBeUndefined();
  });
});
