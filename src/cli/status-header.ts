/**
 * Render a one-line supervisor status header for `lazy watch` and `lazy show`.
 *
 * Reads SupervisorStatus and produces a human-readable summary like:
 *   Supervisor: phase=post_turn_check (23m12s)
 *
 * Pure function: takes a `now` for deterministic tests.
 */

import type { SupervisorStatus } from '../protocol/types';

export function renderStatusHeader(
  status: SupervisorStatus | null,
  now: Date = new Date(),
): string {
  if (!status) {
    return 'Supervisor: no status';
  }

  const phaseStart = status.phase_started_at ?? status.updated_at ?? status.started_at;
  const phaseElapsed = elapsedFrom(phaseStart, now);

  let header = `Supervisor: phase=${status.phase}`;
  if (phaseElapsed !== null) {
    header += ` (${phaseElapsed})`;
  }

  if (status.current_command) {
    header += `, running: ${status.current_command}`;
    const cmdElapsed = elapsedFrom(status.current_command_started_at, now);
    if (cmdElapsed !== null) {
      header += ` (${cmdElapsed})`;
    }
  }

  return header;
}

function elapsedFrom(iso: string | undefined, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = Math.max(0, now.getTime() - t);
  return formatElapsed(ms);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${pad2(seconds)}s`;
  }
  return `${seconds}s`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
