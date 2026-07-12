/**
 * Local-timezone day helpers.
 *
 * Centralizes the notion of "today" in the machine's local timezone, the
 * timestamp of the next local midnight, and a human-readable countdown
 * formatter ("in 6h (00:00 local)"). Kept deliberately general (not
 * budget-specific) so other features that reason about local-day boundaries
 * and auto-expiry can reuse it.
 *
 * Why local, not UTC: users think in their own wall clock. A budget that
 * "resets today" should reset when their day rolls over, not at an arbitrary
 * UTC offset. If the machine crosses timezones, "today" naturally tracks the
 * current local zone because every computation re-derives from the live Date.
 */

/**
 * Local-day key in YYYY-MM-DD form, computed from local (not UTC) components.
 * Two instants on the same local calendar day produce the same key.
 */
export function localDayKey(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The next local midnight strictly after `from` — i.e. the start of tomorrow
 * in local time. This is the moment "today" rolls over.
 */
export function nextLocalMidnight(from: Date = new Date()): Date {
  const next = new Date(from);
  next.setHours(0, 0, 0, 0); // start of today, local
  next.setDate(next.getDate() + 1); // start of tomorrow, local
  return next;
}

/**
 * Format a Date as a local wall-clock time tagged "local", e.g. "00:00 local".
 */
export function formatLocalClock(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes} local`;
}

/**
 * Format a duration in milliseconds as a compact human string:
 * "30s", "45m", "6h", "2d 3h". Always rounds down to whole units, except
 * sub-minute durations which round up to at least "1s" so an imminent
 * boundary never reads as "0s".
 */
export function formatRelativeDuration(ms: number): string {
  if (ms <= 0) return 'now';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, seconds)}s`;
}

/**
 * Describe when a future instant arrives, e.g. "in 6h (00:00 local)".
 * Returns "now" if the target is in the past. The clock-time suffix lets the
 * reader anchor the countdown to an absolute wall-clock moment so there are no
 * silent boundaries.
 */
export function describeExpiry(target: Date, now: Date = new Date()): string {
  const remaining = target.getTime() - now.getTime();
  if (remaining <= 0) return `now (${formatLocalClock(target)})`;
  return `in ${formatRelativeDuration(remaining)} (${formatLocalClock(target)})`;
}
