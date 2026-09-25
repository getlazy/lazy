/**
 * The protected files a task still owes a decision on — computed over the WHOLE
 * branch, not over one turn's snapshot.
 *
 * ## Why this exists
 *
 * Detection is per-TURN: the supervisor scans `turn-start-SHA..HEAD` after each
 * agent turn and records what it found on that turn. Until
 * move-file-approval-to-accept that was safe, because a `conflict` task could
 * not run another turn until the reviewer had decided — the newest record was
 * always the whole story.
 *
 * Deferring the decision to accept removed that guarantee. A conflict task now
 * runs as many turns as the work needs, and two things go wrong if the gate
 * keeps reading one turn:
 *
 *   1. **A second file on a later turn.** Turn 1 modifies `a.spec.ts`; turn 2
 *      modifies `b.spec.ts` and re-detects over turn 2's range only, so its
 *      record is `[b.spec.ts]` and becomes "the latest violation turn".
 *      Approving `b.spec.ts` then merged `a.spec.ts` with nobody having looked
 *      at it.
 *   2. **An authoritative empty re-detect.** A later turn that touches no
 *      protected file records `violations: []`, which storage persists
 *      deliberately as "the prior pending set is cleared". The task parks
 *      `blocked`, every surface shows nothing owed, and turn 1's protected edit
 *      merges silently.
 *
 * Both are the same bug: a per-turn RECORDER was being read as a whole-branch
 * LEDGER.
 *
 * ## The rule
 *
 * Two sources, each answering the question it can answer:
 *
 *   - **git says what is in the merge.** Re-detecting from the task's diff base
 *     to HEAD is mechanistic and cannot forget an earlier turn. A file the agent
 *     later reverted to base is simply not in that diff and correctly drops out.
 *   - **the records say what a human decided.** Scanned across ALL turns,
 *     latest decision per file — the same shape `revertedProtectedFiles` already
 *     uses. An approved file stays approved however many turns run afterwards.
 *
 * Outstanding = detected AND not approved. That is what accept gates on, what
 * the `conflict` label means, and what the review page's "Before you can accept"
 * block lists. WHICH CHANGES are scanned is the resolver's business, and it is
 * the task's DIRECT ones — a hub must not re-ask about files its accepted
 * children already had approved; see outstanding-resolver.ts.
 *
 * `outstandingFromRecords` is the fallback for callers that cannot run git (no
 * worktree, a failed scan). It is deliberately the CONSERVATIVE direction: it
 * never lets a later turn clear an earlier pending file, so it can overstate
 * what is owed but never understate it. A gate that overstates asks a human an
 * unnecessary question; one that understates merges a file nobody approved.
 */

import type { FileViolation, Turn } from '../types';

/**
 * The latest recorded decision for every protected file this session ever
 * violated, scanned across ALL turns in order.
 *
 * NOT `latestViolationTurn` (src/utils/turns.ts), which answers a different
 * question — "what did the most recent scan see" — and is still the right read
 * for the per-turn push-back the supervisor drives.
 *
 * Any turn CARRYING violations counts, not only agent turns. Detection writes
 * them on agent turns, so in practice that is where they are; the exception is
 * the approval ledger accept records when a session has no agent turn to hold
 * it (see the ledger note below). Reading only agent turns there would have
 * made that write a silent no-op — an approval that claimed to land and did not.
 */
export function violationRecordsByFile(turns: Turn[]): Map<string, FileViolation> {
  const latest = new Map<string, FileViolation>();
  for (const turn of turns) {
    if (!turn.violations?.length) continue;
    for (const violation of turn.violations) {
      latest.set(violation.file, violation);
    }
  }
  return latest;
}

/** Files whose latest recorded decision across the whole session is `approved`. */
export function approvedFilesFromRecords(turns: Turn[]): string[] {
  return [...violationRecordsByFile(turns).values()]
    .filter((v) => v.status === 'approved')
    .map((v) => v.file)
    .sort();
}

/**
 * The outstanding set: files the whole-branch scan still sees changed, minus the
 * ones a human has already approved.
 *
 * A detected file with no record at all is outstanding — that is exactly case 2
 * above, where the record was cleared by a later empty re-detect but the change
 * is still in the merge. Its `base_sha` comes from the detection, so it points
 * at the base the file would be compared against.
 */
export function outstandingFromDetection(
  detected: readonly FileViolation[],
  turns: Turn[],
): FileViolation[] {
  const records = violationRecordsByFile(turns);
  const outstanding: FileViolation[] = [];
  for (const hit of detected) {
    if (records.get(hit.file)?.status === 'approved') continue;
    outstanding.push({ ...hit, status: 'pending' });
  }
  return outstanding;
}

/**
 * Records-only fallback, for callers with no worktree to scan.
 *
 * Every file whose latest recorded decision is still `pending` counts —
 * including files a later turn's empty re-detect would have cleared. Without
 * git there is no way to tell "the agent reverted it" from "the later turn
 * simply did not look at it", and only one of those two guesses can merge an
 * unapproved protected file.
 *
 * `rejected` does NOT count here, unlike in the detection path above. A rejected
 * record only exists on sessions from before move-file-approval-to-accept, and
 * it means the reviewer refused the change AND lazy reverted it — a decision
 * that was made and carried out. (In the detection path the same record with the
 * file still in the diff means the opposite: the change came back and nobody has
 * approved THAT.)
 */
export function pendingFilesFromRecords(turns: Turn[]): string[] {
  return outstandingFromRecords(turns).map((v) => v.file);
}

export function outstandingFromRecords(turns: Turn[]): FileViolation[] {
  return [...violationRecordsByFile(turns).values()]
    .filter((v) => v.status === 'pending')
    .map((v) => ({ ...v }));
}

/**
 * The record set to persist once `approved` are approved: every file this
 * session has a record for, plus the newly-approved ones, with the latest
 * decision per file. Written to ONE turn so that turn becomes the complete
 * ledger — subsequent reads of it are then whole-branch-correct by themselves.
 */
export function mergedViolationRecords(
  turns: Turn[],
  detected: readonly FileViolation[],
  approved: readonly string[],
): FileViolation[] {
  const merged = violationRecordsByFile(turns);
  for (const hit of detected) {
    if (!merged.has(hit.file)) merged.set(hit.file, { ...hit, status: 'pending' });
  }
  const approvedSet = new Set(approved);
  return [...merged.values()].map((v) =>
    approvedSet.has(v.file) ? { ...v, status: 'approved' as const } : v,
  );
}
