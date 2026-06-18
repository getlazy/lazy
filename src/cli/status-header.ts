/**
 * Render a one-line supervisor status header for `lazy watch` and `lazy show`.
 *
 * Reads SupervisorStatus and produces a human-readable summary like:
 *   Supervisor: phase=post_turn_check (23m12s)
 *
 * Pure function: takes a `now` for deterministic tests.
 */

import type { SupervisorStatus } from '../protocol/types';
import { elapsedFrom } from '../utils/elapsed';

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
