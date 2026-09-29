/**
 * Protected files a reviewer REJECTED — what "Reject" means, end to end.
 *
 * A Reject is recorded as `status: 'pending'` plus `rejected_at` (see
 * `setViolationDecision`), so every accept gate keeps refusing exactly as for
 * an undecided file. The next WORK turn's supervisor restores each rejected
 * file to its base and commits that as lazy's own commit before the agent
 * runs (src/protection/rejected-restore.ts); the agent is then told to make
 * the tree coherent with it. Once restored the file drops out of the
 * outstanding set, and its record turns `rejected` with `restored_at`, which
 * accept reads to tell the reviewer the tree holds a lazy-made restore.
 */

import type { FileViolation } from '../types';

/** The outstanding files a reviewer rejected, sorted. */
export function rejectedOutstanding(outstanding: readonly FileViolation[]): FileViolation[] {
  return outstanding
    .filter((v) => v.status === 'pending' && !!v.rejected_at)
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * A protected file's decision as a reviewer sees it. `undecided` and `rejected`
 * both keep accept refused; `rejected` also makes the next unblock restore it.
 * A `status: 'rejected'` record (the file was restored) reads as rejected.
 */
export type ViolationDecision = 'undecided' | 'approved' | 'rejected';

export function violationDecisionOf(v: Pick<FileViolation, 'status' | 'rejected_at'>): ViolationDecision {
  if (v.status === 'approved') return 'approved';
  if (v.status === 'rejected' || v.rejected_at) return 'rejected';
  return 'undecided';
}
