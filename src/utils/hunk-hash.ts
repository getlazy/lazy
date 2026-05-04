/**
 * Content-addressable hash of a review hunk.
 *
 * Used by `lazy review -i` to persist per-hunk approvals: a hunk that's
 * been marked reviewed stays cleared on subsequent sessions only as
 * long as its content remains the same. Any change to the hunk body
 * (added, removed, or surrounding context line) yields a fresh hash
 * and forces re-review.
 *
 * The function is deterministic and pure — same inputs, same hex
 * digest, no side effects.
 */

import { createHash } from 'crypto';

/**
 * Structural shape of the fields needed for hashing — kept local so
 * this util has no upstream dependencies (the test for it imports both
 * the parser and this hasher, and we don't want to drag in the whole
 * CLI/TUI layer through the type).
 */
export interface HashableHunk {
  kind: 'code' | 'summary';
  file: string;
  diff: string;
}

/**
 * Compute a stable content hash for a review hunk.
 *
 * For code hunks: strips the leading `@@ -... +... @@` line so a
 * surrounding-code edit that only shifts line counts (without touching
 * the hunk body itself) does NOT invalidate the approval. Trims trailing
 * blank lines for the same reason.
 *
 * For summary hunks: hashes the trimmed paragraph text.
 *
 * The `kind` is part of the input so a code hunk and a summary hunk
 * with textually identical bodies cannot collide.
 */
export function hunkHash(hunk: HashableHunk): string {
  const body = canonicalBody(hunk);
  return createHash('sha1')
    .update(hunk.kind)
    .update('\0')
    .update(hunk.file)
    .update('\0')
    .update(body)
    .digest('hex');
}

function canonicalBody(hunk: Pick<HashableHunk, 'kind' | 'diff'>): string {
  if (hunk.kind === 'summary') {
    return hunk.diff.trim();
  }
  // Strip the leading @@ ... @@ header line; everything after that is
  // the actual hunk body (context + +/- lines). Then trim trailing
  // blanks so trailing whitespace differences don't invalidate.
  const lines = hunk.diff.split('\n');
  const start = lines[0]?.startsWith('@@') ? 1 : 0;
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}
