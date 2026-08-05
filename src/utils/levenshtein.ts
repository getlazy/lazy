/**
 * Levenshtein edit distance — shared by the CLI's unknown-command suggester and
 * search's "no task is tagged #x, did you mean …" hint.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;

  // Single-row DP
  const row = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const current = Math.min(
        row[j] + 1,       // deletion
        row[j - 1] + 1,   // insertion
        prev + cost,       // substitution
      );
      prev = row[j];
      row[j] = current;
    }
  }

  return row[n];
}
