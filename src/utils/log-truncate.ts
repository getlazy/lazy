/**
 * Truncate a CI log to the last N lines.
 * CI logs can be very large — this keeps comments manageable while
 * preserving the most actionable output (failures are usually at the end).
 */
export function truncateLog(log: string, maxLines: number = 200): string {
  const lines = log.split('\n');
  if (lines.length <= maxLines) return log;

  const kept = lines.slice(-maxLines);
  return `... (${lines.length - maxLines} lines truncated)\n${kept.join('\n')}`;
}
