/**
 * Asking a running daemon for its health report — the client half shared by
 * `lazy daemon health` and `lazy doctor`'s summary line.
 *
 * Imports only the row module (./daemon-health-rows.ts), never the collector:
 * doctor's sweep imports this module, and the collector reaches doctor's own
 * lock and image probes, so importing it here would be a cycle — and would load
 * the daemon's handler graph into every CLI process that renders a report.
 *
 * Never auto-starts a daemon: a health check that started the thing it is
 * checking would report on a daemon nobody had.
 */

import { DaemonClient, DaemonNotRunningError, RpcApplicationError } from './client';
import { DAEMON_HEALTH_CHANNEL, type DaemonHealthReport, type DaemonHealthRow, type HealthClientIdentity, type HealthGroup, type HealthState } from './daemon-health-rows';
import type { ProgressEvent } from './progress';


/** Whole-report deadline on the client side. Longer than any single check's, which the daemon bounds itself. */
export const DAEMON_HEALTH_CLIENT_TIMEOUT_MS = 45_000;

const STATES: ReadonlySet<string> = new Set<HealthState>(['ok', 'warn', 'fail']);
const GROUPS: ReadonlySet<string> = new Set<HealthGroup>(['daemon', 'loops', 'sweeps', 'proxy', 'storage', 'runner', 'tasks', 'dashboard']);

/**
 * Validate one row off the wire. The daemon may be a different build than this
 * client, so a row is checked rather than trusted; a malformed one is dropped
 * from the live stream (the final report still carries every row).
 */
export function parseHealthRow(payload: unknown): DaemonHealthRow | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.reason !== 'string') return null;
  if (typeof row.state !== 'string' || !STATES.has(row.state)) return null;
  if (typeof row.group !== 'string' || !GROUPS.has(row.group)) return null;
  if (row.remedy !== undefined && typeof row.remedy !== 'string') return null;
  return row as unknown as DaemonHealthRow;
}

/** Validate the final report; throws naming what is wrong. */
export function parseHealthReport(body: unknown): DaemonHealthReport {
  if (!body || typeof body !== 'object') {
    throw new Error('the daemon answered daemonHealth with no report');
  }
  const report = body as Record<string, unknown>;
  if (!Array.isArray(report.rows)) {
    throw new Error('the daemon answered daemonHealth without rows — it may predate `lazy daemon health`; restart it');
  }
  const rows = report.rows.map(parseHealthRow);
  if (rows.some(r => r === null)) {
    throw new Error('the daemon answered daemonHealth with a malformed row');
  }
  return report as unknown as DaemonHealthReport;
}

/** This process's own build, for the daemon's build-match row. */
export async function localClientIdentity(): Promise<HealthClientIdentity> {
  const identity: HealthClientIdentity = {};
  try {
    identity.version = (await import('../version')).VERSION;
  } catch {
    // Generated file absent (some test trees): the daemon then compares source ids only.
  }
  try {
    const source = await (await import('../utils/source-id')).getSourceIdentity();
    identity.sourceId = source.id;
    identity.sourceIdKind = source.kind;
  } catch {
    // Unreadable source identity: the daemon reports the comparison as not made.
  }
  return identity;
}

/**
 * The daemon answering is older than `lazy daemon health`: it was started
 * before an upgrade and still runs the code it started with. Not a fault in
 * the daemon — restarting it picks up the current code, command included.
 */
export class DaemonPredatesHealthError extends Error {
  constructor() {
    super('the running daemon predates `lazy daemon health` — it was started before lazy was upgraded');
    this.name = 'DaemonPredatesHealthError';
  }
}

/**
 * Turn a failed health request into the error a caller can act on. A daemon
 * that does not know the command answers with its generic unknown-command 404
 * (matched on that text, as `lazy watch` does for its own RPC); that becomes a
 * DaemonPredatesHealthError. Anything else is returned unchanged.
 */
export function classifyHealthRequestError(err: unknown): unknown {
  if (
    err instanceof RpcApplicationError &&
    err.status === 404 &&
    /unknown rpc command/i.test(err.message) &&
    err.message.includes('daemonHealth')
  ) {
    return new DaemonPredatesHealthError();
  }
  return err;
}

export interface RequestDaemonHealthOptions {
  /** Called with each row the daemon streams, as it lands. */
  onRow?: (row: DaemonHealthRow) => void;
  timeoutMs?: number;
  /**
   * Send this process's build so the daemon can compare (default true). Doctor
   * sends none: its own check already answers that question.
   */
  sendClientIdentity?: boolean;
}

/**
 * Ask the project's running daemon for its health report.
 *
 * Throws DaemonNotRunningError when there is no daemon to ask,
 * DaemonPredatesHealthError when the daemon is too old to know the command, and
 * an Error naming the failure when it does not answer in time or answers badly —
 * the caller turns each into a row of its own.
 */
export async function requestDaemonHealth(
  projectRoot: string,
  options: RequestDaemonHealthOptions = {},
): Promise<DaemonHealthReport> {
  const client = await DaemonClient.create(projectRoot);
  if (!client) throw new DaemonNotRunningError();
  const identity = options.sendClientIdentity === false ? {} : await localClientIdentity();
  const timeoutMs = options.timeoutMs ?? DAEMON_HEALTH_CLIENT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const onProgress = options.onRow
    ? (event: ProgressEvent) => {
        if (event.kind !== 'activity' || event.channel !== DAEMON_HEALTH_CHANNEL) return;
        const row = parseHealthRow(event.payload);
        if (row) options.onRow!(row);
      }
    : undefined;
  let body: unknown;
  try {
    body = await client.rpc(
      'daemonHealth',
      projectRoot,
      {
        clientVersion: identity.version,
        clientSourceId: identity.sourceId,
        clientSourceIdKind: identity.sourceIdKind,
      },
      { onProgress },
      signal,
    );
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`the daemon did not finish its health report within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw classifyHealthRequestError(err);
  }
  return parseHealthReport(body);
}
