/**
 * The record of a task's last automatic services restart after a work turn
 * (written by src/daemon/services-restart.ts). Kept free of daemon imports so
 * the CLI's `lazy show --json` and the daemon's `show` / `servePorts` read it
 * through the same parser.
 */

export const SERVICES_RESTART_KEY = 'services_restart';

/** One step of an automatic restart. */
export interface ServicesRestartStep {
  ok: boolean;
  /** Why it failed (a readable sentence, with the command's output tail when it printed one). */
  error?: string;
}

/** The last automatic restart of a task's services. */
export interface ServicesRestartRecord {
  /** When the restart ran (ISO 8601). */
  at: string;
  /** The Start services command that ran. */
  command: string;
  stop: ServicesRestartStep;
  start: ServicesRestartStep;
  /** Set when start failed: the warning a surface shows, naming the step. */
  warning: string | null;
}

/** Parse the metadata value; null when absent or unreadable (never throws). */
export function parseServicesRestart(raw: string | null | undefined): ServicesRestartRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ServicesRestartRecord;
    return value && typeof value === 'object' && typeof value.at === 'string' ? value : null;
  } catch {
    // Unreadable metadata is reported as "no restart on record" — the same
    // answer a surface gives for a task that never had one.
    return null;
  }
}

/** The record off a task. */
export function servicesRestartOf(task: { metadata?: Record<string, string> | null }): ServicesRestartRecord | null {
  return parseServicesRestart(task.metadata?.[SERVICES_RESTART_KEY]);
}

/**
 * The command types a WORK turn runs under. Every work-turn launch writes one of
 * these — start, unblock, manual resume, the reconciler's auto-resume, and
 * auto-deliver's unblock (which a cluster restart and auto-react go through) —
 * and the supervisor copies it into its status as `command_type`. Asks, reviews,
 * syncs and accept gates have their own types.
 */
export const WORK_TURN_COMMAND_TYPES: ReadonlySet<string> = new Set(['start', 'unblock']);

export function isWorkTurnCommand(type: string | undefined | null): boolean {
  return !!type && WORK_TURN_COMMAND_TYPES.has(type);
}
