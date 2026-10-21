/**
 * Where the dashboard's Run pages live, and the keys a run's in-flight work is
 * recorded under in the page registries (./action-run.ts, ./container-start.ts).
 *
 * A run's page is `/runs/<id>` — the path the daemon itself names
 * (`runPagePath`, src/run/identity.ts) and the service proxy sends a dead
 * service's navigation to. Pages always link by the run's id, never its slug:
 * the id is what the proxy redirect carries, and one spelling keeps the
 * registries' keys unambiguous.
 */

import { runPagePath } from '../run/identity';

export const RUNS_INDEX_PATH = '/runs';

/** The run's page. */
export function runPath(runId: string): string {
  return runPagePath(runId);
}

/**
 * The key a run's actions and container start are recorded under. Task
 * entries are keyed by a task id (a UUID) and Link's by a bare per-request
 * UUID, so the `run:` prefix cannot collide with either.
 */
export function runActionKey(runId: string): string {
  return `run:${runId}`;
}
