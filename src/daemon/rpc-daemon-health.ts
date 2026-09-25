/**
 * The `daemonHealth` RPC — behind `lazy daemon health` and doctor's summary line.
 *
 * Read-only: it reports what the daemon's loops, sweeps, proxy, store, runner
 * and tasks are doing and changes none of it. Each row is also streamed as it
 * completes (an `activity` progress event on the `daemon-health` channel), so a
 * human watching the CLI sees the checks land instead of a pause.
 */

import type { ProgressEmitter } from './progress';
import { optionalString } from './rpc-params';
import { collectDaemonHealth } from './daemon-health';
import { DAEMON_HEALTH_CHANNEL, type DaemonHealthReport, type HealthClientIdentity } from './daemon-health-rows';

export async function handleDaemonHealth(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
): Promise<DaemonHealthReport> {
  // The caller's build, compared against the daemon's for the build-match row.
  // Optional — an MCP or script caller has no CLI build to compare.
  const client: HealthClientIdentity = {
    version: optionalString(params, 'clientVersion'),
    sourceId: optionalString(params, 'clientSourceId'),
    sourceIdKind: optionalString(params, 'clientSourceIdKind'),
  };
  return collectDaemonHealth(projectRoot, {
    client,
    onRow: progress
      ? (row) => progress({ kind: 'activity', channel: DAEMON_HEALTH_CHANNEL, payload: row })
      : undefined,
  });
}
