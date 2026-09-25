/**
 * Does the dashboard address lazy.toml asks for match the one being served?
 *
 * `[server] dashboard_url` is read when the daemon STARTS. Setting it on a
 * running daemon — the ordinary way anyone edits a config file — changes
 * nothing until a restart, and before this existed every surface went on
 * printing the old `http://lazy.localhost:<port>` address with no word about
 * why. That is exactly what the first person to configure it reported: "it just
 * displayed the same lazy.localhost message". The other way to get the same
 * silence is the key typed under the wrong table (a lazy.toml with no `[server]`
 * section invites appending it at the bottom, inside whatever table came last),
 * where the loader never looks for it.
 *
 * One comparison, two kinds of reader: `lazy doctor` turns it into the full
 * diagnosis, and the commands that print the address (`lazy dashboard`,
 * `lazy daemon dashboard-url`) turn it into ONE line pointing there — the
 * point-of-occurrence half of doctor being the single warning surface.
 *
 * Why not read the key per request instead, so a restart is never needed: the
 * dashboard's Host/Origin gate, its WebSocket guards, the in-process context
 * the builder prompt and `lazy_status` read, and the status payload all hold
 * the value from startup. Making them live means a cached, re-validated config
 * read on the gate's hot path, a rule for a lazy.toml that stops parsing
 * mid-edit (keep the last good boundary? drop to the default?), and a security
 * boundary that moves on a file write rather than on a restart someone chose.
 * Every other `[server]` key is start-time too. Not taken here; the warning
 * makes the one-command remedy impossible to miss instead.
 */

import { loadConfig, loadRawConfig } from '../config/loader';
import type { DaemonStatus } from './lifecycle';
import { resolveDashboardUrl } from './dashboard-url';

type StatusView = Pick<DaemonStatus, 'running' | 'webPort' | 'bindHost' | 'dashboardUrl'>;

/** lazy.toml and the running daemon disagree about the dashboard's address. */
export interface DashboardAddressDrift {
  kind: 'drift';
  /** What lazy.toml asks for; `''` when it no longer sets the key. */
  configured: string;
  /** What the running daemon serves (and so what every surface prints). */
  served: string;
}

/** `dashboard_url` sits in a table other than `[server]`, where nothing reads it. */
export interface DashboardAddressMisplaced {
  kind: 'misplaced';
  /** Where it was found, as the TOML header that holds it, e.g. `[remote]`. */
  tables: string[];
}

export type DashboardAddressProblem = DashboardAddressDrift | DashboardAddressMisplaced;

/**
 * Every place in a parsed lazy.toml a `dashboard_url` key sits OTHER than
 * `[server]`. Walks nested tables and arrays of tables, because the table that
 * came last in a file — where an appended line lands — is often one of those.
 */
export function misplacedDashboardUrlTables(raw: Record<string, unknown> | null): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string[], arrayOfTables: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, true);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const table = value as Record<string, unknown>;
    if ('dashboard_url' in table && path.join('.') !== 'server') {
      found.push(path.length === 0
        ? 'the top level (before any [section])'
        : arrayOfTables ? `[[${path.join('.')}]]` : `[${path.join('.')}]`);
    }
    for (const [key, child] of Object.entries(table)) {
      if (child !== null && typeof child === 'object') walk(child, [...path, key], false);
    }
  };
  walk(raw, [], false);
  return [...new Set(found)];
}

/**
 * The comparison itself: pure, so doctor and the CLI cannot answer differently.
 *
 * A daemon that is not running, or that serves no dashboard at all (managed
 * mode reports `dashboardUrl: null`), has nothing to disagree with. A key under
 * the wrong table is reported ahead of drift: until it moves, no restart helps.
 */
export function compareDashboardAddress(
  configured: string,
  misplaced: string[],
  status: StatusView | null,
): DashboardAddressProblem | null {
  if (!configured && misplaced.length > 0) return { kind: 'misplaced', tables: misplaced };
  if (!status?.running || typeof status.dashboardUrl !== 'string') return null;
  const wanted = configured
    || (status.webPort ? resolveDashboardUrl(status.bindHost, status.webPort) : null);
  if (wanted && status.dashboardUrl !== wanted) {
    return { kind: 'drift', configured, served: status.dashboardUrl };
  }
  return null;
}

/**
 * Read lazy.toml and compare it with a running daemon's status.
 *
 * A lazy.toml that does not load is reported as `unreadable` rather than
 * thrown: the command printing the address still has a working link to print,
 * and doctor is where a broken config is diagnosed.
 */
export async function checkDashboardAddress(
  projectRoot: string,
  status: StatusView | null,
): Promise<DashboardAddressProblem | { kind: 'unreadable' } | null> {
  let configured: string;
  try {
    configured = (await loadConfig(projectRoot)).server.dashboard_url;
  } catch (err) {
    // Deliberately not rethrown: the caller is printing an address the daemon
    // is serving right now, and a config it cannot compare against is a thing
    // to point at, not a reason to withhold the link. The loader's own message
    // is what `lazy doctor` reports as "lazy.toml parses".
    void err;
    return { kind: 'unreadable' };
  }
  return compareDashboardAddress(configured, misplacedDashboardUrlTables(await loadRawConfig(projectRoot)), status);
}

/**
 * The ONE line a command that prints the dashboard address adds when lazy.toml
 * and the daemon disagree — what is wrong, the remedy, and where the full
 * diagnosis is. Never more than one line, by design: doctor holds the rest.
 */
export function dashboardAddressNote(problem: DashboardAddressProblem | { kind: 'unreadable' }): string {
  switch (problem.kind) {
    case 'misplaced':
      return (
        `Note: lazy.toml has dashboard_url under ${problem.tables.join(', ')}, where it is ignored — ` +
        'it belongs under [server]. Run `lazy doctor` for details.'
      );
    case 'drift':
      return (
        (problem.configured
          ? `Note: lazy.toml sets [server] dashboard_url = "${problem.configured}", `
          : 'Note: lazy.toml no longer sets [server] dashboard_url, ') +
        `but the running daemon still serves ${problem.served} — run \`lazy daemon restart\` to apply it ` +
        '(`lazy doctor` explains).'
      );
    case 'unreadable':
      return 'Note: lazy.toml does not load, so its dashboard_url could not be checked — run `lazy doctor`.';
  }
}
