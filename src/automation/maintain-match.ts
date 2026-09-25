/**
 * Shared glob matching for [[automation.maintain]] patterns.
 *
 * Used by the supervisor skip check and the review presentation renderer so
 * maintained-file diffs never land in the residual "Other changes" bucket.
 */

import type { MaintainEntry } from '../config/types';

/** True when `filePath` matches a single maintain glob (Bun.Glob, same as permissions). */
export function pathMatchesMaintainPattern(filePath: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(filePath);
}

/** True when `filePath` matches any configured maintain group. */
export function pathMatchesAnyMaintainPattern(
  filePath: string,
  entries: readonly MaintainEntry[],
): boolean {
  for (const entry of entries) {
    if (pathMatchesMaintainPattern(filePath, entry.pattern)) return true;
  }
  return false;
}
