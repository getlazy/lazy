/**
 * Escape special regex metacharacters in a string so it can be safely
 * interpolated into a RegExp pattern as a literal match.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
