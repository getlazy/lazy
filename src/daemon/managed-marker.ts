/**
 * The marker a daemon Lazy Teams manages leaves in its private directory, and
 * the one check every daemon start makes against it.
 *
 * A Teams daemon is started by the fleet with an environment the fleet owns:
 * managed mode, the store and config paths, the seeded credentials. A daemon
 * started from a shell WITHOUT that environment (`lazy daemon restart` typed in
 * a machine shell that did not source it) comes up as an ordinary unmanaged
 * daemon: wrong store rules, no forge token, no pushes (2026-10-20). The
 * marker is how a start — typed, or the auto-start any command performs —
 * tells that it is about to do that, and refuses.
 */

import { readFile, writeFile } from 'fs/promises';
import { getManagedDaemonMarkerPath } from './paths';
import { isManagedMode } from '../config/managed-mode';

export async function writeManagedDaemonMarker(projectRoot: string): Promise<void> {
  await writeFile(getManagedDaemonMarkerPath(projectRoot), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

/** True when a Teams-managed daemon has run with this daemon directory. */
export async function managedDaemonMarkerExists(projectRoot: string): Promise<boolean> {
  try {
    await readFile(getManagedDaemonMarkerPath(projectRoot), 'utf-8');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export const MANAGED_RESTART_REFUSAL =
  'This project is managed by Lazy Teams: restart it from its page (god mode → Restart) so it keeps its credentials. ' +
  'A daemon started from this shell would not have the environment Teams starts it with ' +
  '(its credentials and managed settings). In a machine shell opened from Teams, which loads that environment, ' +
  '`lazy daemon restart` works.';

/** Thrown by {@link assertManagedStartAllowed}; carries the refusal text. */
export class ManagedDaemonStartRefused extends Error {
  constructor() {
    super(MANAGED_RESTART_REFUSAL);
    this.name = 'ManagedDaemonStartRefused';
  }
}

/**
 * THE one check every daemon start goes through: `startDaemonBackground` (the
 * CLI's `daemon start`/`restart` and the auto-start `ensureDaemon` performs
 * for any command) and `startDaemonServer` (a foreground start, and the
 * background child itself). A process without the managed environment may not
 * start a daemon in a directory a Teams-managed daemon has used. Throws, never
 * exits: the daemon and long-lived clients call it too.
 */
export async function assertManagedStartAllowed(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (isManagedMode(env)) return;
  if (await managedDaemonMarkerExists(projectRoot)) throw new ManagedDaemonStartRefused();
}
