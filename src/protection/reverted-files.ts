/**
 * Protected files lazy RESTORED during a task — surfaced at accept time.
 *
 * ## Why accept has to say this out loud
 *
 * When a reviewer rejects a protected file, lazy's supervisor restores it to
 * its base and commits that before the agent's next work turn
 * (src/protection/rejected-restore.ts), and records the file as `rejected`
 * with `restored_at`. (Sessions from before move-file-approval-to-accept carry
 * `rejected` records from the old revert-at-unblock, which read the same.)
 * From that moment the task's diff simply does not contain the file — which
 * reads EXACTLY like "the task never touched it". The reviewer at accept has
 * no way to tell the two apart, and the one thing they most need to know is
 * that the tree they are merging holds a lazy-made restore: a restore can leave
 * the branch incoherent (restored tests for code the task deleted, an import of
 * a constant the task removed), and that is precisely how a task that did not
 * compile was once merged. The agent now gets a turn after the restore to make
 * the tree coherent, but the reviewer must still be told.
 *
 * This module only READS the records on the session's turns and names them
 * where the merge decision is actually made.
 *
 * ## Latest decision wins
 *
 * A restored file the agent edits again is re-detected as a fresh `pending`
 * record on a later turn — back in the diff and owed a new decision, so it
 * needs no notice. Only files whose LATEST record is `rejected` are reported.
 * Turns are scanned in order and each file's status is overwritten as later
 * turns record it.
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
    `${files.length} protected ${plural} reverted during this task — a reviewer rejected the change and lazy restored the base version:\n` +
    files.map(f => `  ${f}`).join('\n') +
    `\n\nThose changes are NOT in the diff you are reviewing: the tree being merged holds lazy's own ` +
    `restore commit. The agent had a turn after the restore to make the tree coherent — check that it did.`
  );
}
