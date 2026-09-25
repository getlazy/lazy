/**
 * Value formatting shared by every surface that renders one.
 *
 * Timestamps, durations and token counts are printed by the CLI, the web
 * review surface, the daemon's own log lines and the report one-shots alike.
 * The formatting rules are the same everywhere, so they live outside `src/cli/`
 * and none of those callers has to import a CLI module to print a date.
 */

import type { TokenUsage } from '../types';

/**
 * Format a unix timestamp (ms since epoch) for display.
 * Returns "YYYY-MM-DD HH:MM" in UTC.
 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format milliseconds as a human-readable duration
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format a token count compactly (e.g., 1234 -> "1.2k", 1234567 -> "1.2M")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  } else if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Get total input tokens including cached tokens.
 * Claude Code reports non-cached input separately from cache creation and cache read tokens,
 * but they all count as input tokens.
 */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

/**
 * Get total tokens (input + output) from a TokenUsage object
 */
export function totalTokens(usage: TokenUsage | null): number {
  if (!usage) return 0;
  return totalInputTokens(usage) + usage.outputTokens;
}
