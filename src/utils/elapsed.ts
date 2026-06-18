/**
 * Elapsed-time formatting shared across the supervisor status header and the
 * working-substate renderers, so "how long has this been running" reads the
 * same everywhere (e.g. `45s`, `23m12s`, `1h05m03s`).
 */

/**
 * Format a duration in milliseconds as a compact elapsed string.
 *   <1m  → `45s`
 *   <1h  → `23m12s`
 *   ≥1h  → `1h05m03s`
 */
export function formatElapsed(ms: number): string {
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

/**
 * Compute elapsed time from an ISO timestamp to `now`. Returns null when the
 * timestamp is missing or unparseable. Negative elapsed (clock skew) is clamped
 * to zero.
 */
export function elapsedFrom(iso: string | undefined, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return formatElapsed(Math.max(0, now.getTime() - t));
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
