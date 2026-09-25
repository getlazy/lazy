/**
 * A task PINNED to a base commit — `lazy clone --same-base` / `--base <sha>`.
 *
 * A same-base clone exists to re-run a task on exactly the code the original
 * saw, so two agents or models can be compared like for like. That comparison
 * is destroyed the moment anything merges the parent in, and every automatic
 * merge path would do so without anyone noticing. So the pin is task metadata
 * that:
 *
 *   - the launcher honours when it cuts the branch (instead of the parent's
 *     current head),
 *   - every AUTOMATIC upstream merge respects (auto-sync after an upstream
 *     accept, the sync retry loop, auto-resume's pre-turn merge, an agent's own
 *     `lazy_sync`),
 *   - an EXPLICIT human/builder `lazy sync` lifts: that is the one way to bring
 *     the parent in, and after it the task is an ordinary task again.
 *
 * Accept is unaffected — it merges the task branch into its parent as usual.
 */

/** Task metadata key holding the full SHA the task is pinned to ('' = none). */
export const BASE_PIN_KEY = 'pinned_base_sha';

/** The SHA a task is pinned to, or null when it is not pinned. */
export function pinnedBaseOf(task: { metadata?: Record<string, string> | null }): string | null {
  const value = task.metadata?.[BASE_PIN_KEY];
  return value ? value : null;
}
