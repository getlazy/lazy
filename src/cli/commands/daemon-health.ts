/**
 * `lazy daemon health`
 *
 * Whether the running daemon's moving parts are alive: its loops, each sweep,
 * the proxy, the store, the runner, stuck tasks and the dashboard. The daemon
 * decides every row (src/daemon/daemon-health.ts); this command renders them as
 * they stream in, and exits non-zero when any row FAILs.
 *
 * It never starts a daemon: with none running, that is the one row it reports.
 */

import { readFile } from 'fs/promises';
import { parseFlags, requireLazyRoot } from '../helpers';
import { writeStdoutLine } from '../../utils/stdio';
import { theme } from '../../render/theme';
import { isDaemonRunning, getStartupErrorPath } from '../../daemon';
import { requestDaemonHealth, DaemonPredatesHealthError } from '../../daemon/daemon-health-client';
import {
  HEALTH_GROUP_TITLES,
  summarizeRows,
  type DaemonHealthReport,
  type DaemonHealthRow,
} from '../../daemon/daemon-health-rows';

function mark(row: DaemonHealthRow): string {
  switch (row.state) {
    case 'ok': return theme.success('✓');
    case 'warn': return theme.warning('!');
    case 'fail': return theme.error('✗');
  }
}

function printRow(row: DaemonHealthRow): void {
  console.log(`  ${mark(row)} ${row.name} — ${row.reason}`);
  if (row.remedy && row.state !== 'ok') console.log(`      ${theme.label('→')} ${row.remedy}`);
}

/**
 * Streaming renderer. Rows arrive in report order, so a group heading is
 * printed when the group changes. Healthy sweeps are folded into one line
 * unless --verbose: there are a couple of dozen of them and the ones worth
 * reading are the ones that are not OK, which are always printed in full.
 */
function createRenderer(verbose: boolean) {
  let group: string | null = null;
  let foldedOk = 0;

  const flushFolded = () => {
    if (foldedOk > 0) {
      console.log(`  ${theme.success('✓')} ${foldedOk} sweep${foldedOk === 1 ? '' : 's'} healthy ${theme.label('(--verbose lists each)')}`);
    }
    foldedOk = 0;
  };

  return {
    row(row: DaemonHealthRow): void {
      if (row.group !== group) {
        flushFolded();
        group = row.group;
        console.log(`\n${theme.header(HEALTH_GROUP_TITLES[row.group] ?? row.group)}`);
      }
      if (!verbose && row.group === 'sweeps' && row.state === 'ok') {
        foldedOk++;
        return;
      }
      printRow(row);
    },
    finish(rows: DaemonHealthRow[]): void {
      flushFolded();
      const { counts } = summarizeRows(rows);
      const parts = [
        theme.success(`${counts.ok} OK`),
        counts.warn > 0 ? theme.warning(`${counts.warn} WARN`) : `${counts.warn} WARN`,
        counts.fail > 0 ? theme.error(`${counts.fail} FAIL`) : `${counts.fail} FAIL`,
      ];
      console.log(`\n${parts.join(', ')}`);
    },
  };
}

/** The report for a daemon that is not there to ask. */
async function notRunningRow(projectRoot: string): Promise<DaemonHealthRow> {
  let lastStart = '';
  try {
    const marker = (await readFile(getStartupErrorPath(projectRoot), 'utf-8')).trim();
    if (marker) lastStart = ` The last start attempt failed: ${marker.split('\n')[0]}`;
  } catch (err) {
    // No marker is the normal case (the daemon was simply stopped).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      lastStart = ` (the last start's error file could not be read: ${(err as Error).message})`;
    }
  }
  return {
    id: 'daemon:running',
    group: 'daemon',
    name: 'Daemon running',
    state: 'fail',
    reason: `no daemon is running for ${projectRoot}.${lastStart}`,
    remedy: 'Start it with `lazy daemon start` (`lazy daemon logs` shows why an earlier one stopped).',
  };
}

const RESTART_EFFECT =
  'that interrupts running agent and pair sessions; each agent turn resumes against the new daemon.';

/** The one row to show when the daemon is up but no report came back. */
export function healthRequestFailureRow(err: unknown): DaemonHealthRow {
  if (err instanceof DaemonPredatesHealthError) {
    return {
      id: 'daemon:answering',
      group: 'daemon',
      name: 'Daemon answering',
      state: 'fail',
      reason: `${err.message}, so it cannot report on itself`,
      remedy: `Restart it to run the current code: \`lazy daemon restart\` — ${RESTART_EFFECT}`,
    };
  }
  return {
    id: 'daemon:answering',
    group: 'daemon',
    name: 'Daemon answering',
    state: 'fail',
    reason: `the daemon process is up but did not return a health report: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    remedy: `\`lazy daemon logs\` shows what it is doing. \`lazy daemon restart\` clears a hung daemon — ${RESTART_EFFECT}`,
  };
}

function reportOf(projectRoot: string, rows: DaemonHealthRow[]): DaemonHealthReport {
  const { state, counts } = summarizeRows(rows);
  return { checkedAt: new Date().toISOString(), projectRoot, pid: 0, state, counts, rows };
}

export async function commandDaemonHealth(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'json', takesValue: false },
    { name: 'verbose', aliases: ['v'], takesValue: false },
    { name: 'project', takesValue: true },
  ], 'daemon health');
  // Same resolution as every other `lazy daemon` subcommand.
  const projectFlag = parsed.flags.get('project');
  const projectRoot = typeof projectFlag === 'string' ? projectFlag : requireLazyRoot();
  const json = parsed.flags.get('json') === true;
  const verbose = parsed.flags.get('verbose') === true;

  const finish = async (report: DaemonHealthReport): Promise<void> => {
    // writeStdoutLine, not console.log: a large report piped to a script would
    // otherwise be cut short by the exit below.
    if (json) await writeStdoutLine(JSON.stringify(report, null, 2));
    process.exit(report.state === 'fail' ? 1 : 0);
  };

  const render = json ? null : createRenderer(verbose);
  if (!json) console.log(theme.header(`Daemon health — ${projectRoot}`));

  if (!isDaemonRunning(projectRoot)) {
    const row = await notRunningRow(projectRoot);
    render?.row(row);
    render?.finish([row]);
    await finish(reportOf(projectRoot, [row]));
    return;
  }

  let report: DaemonHealthReport;
  try {
    report = await requestDaemonHealth(projectRoot, { onRow: render ? (row) => render.row(row) : undefined });
  } catch (err) {
    const row = healthRequestFailureRow(err);
    render?.row(row);
    render?.finish([row]);
    await finish(reportOf(projectRoot, [row]));
    return;
  }

  render?.finish(report.rows);
  await finish(report);
}

export function daemonHealthUsage(): void {
  console.log(`Usage: lazy daemon health [--json] [--verbose] [--project PATH]

Check whether the running daemon's moving parts are alive — the things that can
stop working without the daemon itself crashing:

  Daemon      version, uptime, and whether it runs this CLI's build
  Loops       the reconcile, sync-retry and remote-sync loops are completing ticks
  Sweeps      each reconciler sweep's last run, duration and last error
  Proxy       it answers a self-check request (spends nothing), audit log writable
  Storage     who holds the storage lock, whether writes are completing
  Runner      docker/podman (or the host agent) reachable, container image present
  Tasks       working tasks with no live run, held syncs, interrupted tasks
              nothing will resume
  Dashboard   bound, and on which addresses

Each row is OK, WARN or FAIL with a one-line reason; WARN and FAIL rows say
what to do. Rows print as each check completes. Never starts a daemon.

Options:
  --json          Print the full report as JSON (for scripts)
  -v, --verbose   List every sweep, not only the ones that are not OK
  --project PATH  Explicit project root (default: auto-detect from cwd)

Exit status: 1 when any row FAILs (or no daemon is running), 0 otherwise.

Examples:
  lazy daemon health
  lazy daemon health --json | jq '.rows[] | select(.state != "ok")'`);
}
