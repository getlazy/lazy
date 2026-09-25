/**
 * Protected files that were REVERTED during a task — surfaced at accept time.
 *
 * ## Why accept has to say this out loud
 *
 * HISTORICAL RECORDS ONLY since move-file-approval-to-accept: lazy no longer
 * reverts a protected file on any path, so no new task produces a `rejected`
 * record. Tasks whose sessions still carry one from the old behaviour do, and
 * accept must still say so — which is why this module stays wired in.
 *
 * When a reviewer rejected a protected file at `lazy unblock`, the daemon
 * restored it from its base SHA and committed the revert. From that moment the
 * task's diff simply does not contain the file — which reads EXACTLY like "the
 * task never touched it". The reviewer at accept has no way to tell the two
 * apart, and the one thing they most need to know is that the tree they are
 * merging is not the tree the agent built and verified: a revert can leave the
 * branch incoherent (restored tests for code the task deleted, an import of a
 * constant the task removed), and that is precisely how a task that did not
 * compile got merged.
 *
 * The revert itself is not weakened in any way. This module only READS the
 * decisions already recorded on the session's turns and names them where the
 * merge decision is actually made.
 *
 * ## Latest decision wins
 *
 * A file could be rejected in one round and re-approved in a later one. A
 * re-approved file is back in
 * the diff and needs no notice, so only files whose LATEST recorded decision is
 * `rejected` are reported. Turns are scanned in order and each file's status is
 * overwritten as later turns record it.
 */

import type { Turn } from '../types';

/**
 * Protected files whose latest recorded decision in this session was `rejected`
 * — i.e. reverted out of the task's diff and invisible to a reviewer.
 *
 * Pure: no storage, no git, no I/O. Sorted for a stable message.
 */
export function revertedProtectedFiles(turns: Turn[]): string[] {
  const latest = new Map<string, 'pending' | 'approved' | 'rejected'>();
  for (const turn of turns) {
    if (turn.role !== 'agent' || !turn.violations?.length) continue;
    for (const violation of turn.violations) {
      latest.set(violation.file, violation.status);
    }
  }
  return [...latest.entries()]
    .filter(([, status]) => status === 'rejected')
    .map(([file]) => file)
    .sort();
}

/**
 * The one-paragraph notice a reviewer sees before deciding. Empty string when
 * nothing was reverted, so call sites can interpolate unconditionally.
 */
export function revertedProtectedFilesNotice(files: string[]): string {
  if (files.length === 0) return '';
  const plural = files.length === 1 ? 'file was' : 'files were';
  return (
    `${files.length} protected ${plural} reverted during this task:\n` +
    files.map(f => `  ${f}`).join('\n') +
    `\n\nThose changes are NOT in the diff you are reviewing — the tree being merged is not the ` +
    `tree the agent last built against.`
  );
}
