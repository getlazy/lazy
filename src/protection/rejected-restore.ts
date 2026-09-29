/**
 * Carrying out a reviewer's Reject: lazy's SUPERVISOR restores each rejected
 * protected file to its base, commits that as lazy's own commit, and only THEN
 * lets the agent run — never the agent (engineer decision 2026-09-28: "we
 * cannot trust the agent to revert, so lazy's supervisor does that").
 *
 * ## Why before a turn, and never on its own
 *
 * The revert-at-unblock that move-file-approval-to-accept removed restored the
 * file with NO agent turn after it, and a task that no longer compiled was
 * merged: the restored tests referred to code the task had deleted. The restore
 * here always runs as the first step of a WORK turn, so the agent's job on that
 * turn is to make the tree coherent with the restored file, and every
 * verification a turn gets (push-back, post-turn check, pre-accept) runs on the
 * restored tree.
 *
 * ## The pieces
 *
 *   - `planRejectedRestores` — what the daemon puts on the unblock command,
 *     from the same outstanding set accept gates on.
 *   - `applyProtectedRestores` — the git work, shared by the supervisor (when
 *     it can write refs itself) and the daemon's host-side git channel (when it
 *     cannot, inside a container; src/mcp/internal-git.ts re-validates the
 *     plan against its own records first).
 *   - `restoredViolationRecords` — what the reconciler records on the work
 *     turn, which is what accept reads to warn the reviewer.
 *   - `buildRestoredProtectedFilesNotice` — what the agent is told.
 *
 * A file the agent edits AGAIN on that turn is re-detected as a fresh `pending`
 * record (undecided): a new change needs a new decision. There is exactly one
 * restore per turn — nothing here loops.
 */

import restoredPrompt from '../prompts/rejected-protected-files.md' with { type: 'text' };
import { runGit } from '../utils/git';
import type { FileViolation } from '../types';
import type { ProtectedRestore, ProtectedRestoreDone } from '../protocol/types';
import { rejectedOutstanding } from './rejected-files';

/** The git author on every restore commit — the commit is lazy's, not the agent's. */
export const RESTORE_COMMIT_EMAIL = 'supervisor@lazy.invalid';
export const RESTORE_COMMIT_AUTHOR = `Lazy Supervisor <${RESTORE_COMMIT_EMAIL}>`;

/** Restores for every rejected file still outstanding, sorted. Empty when none. */
export function planRejectedRestores(outstanding: readonly FileViolation[]): ProtectedRestore[] {
  return rejectedOutstanding(outstanding).map((v) => ({ file: v.file, base_sha: v.base_sha }));
}

/**
 * Refuse a plan entry that could make git do something other than restore one
 * path: an option-looking path, a path escaping the worktree, a base that is
 * not a SHA. The plan crosses the protocol dir, which is writable in the
 * container.
 */
export function assertRestorePlanShape(plan: readonly ProtectedRestore[]): void {
  for (const r of plan) {
    const segments = r.file.split('/');
    if (!r.file || r.file.startsWith('/') || r.file.startsWith('-') || segments.includes('..') || r.file.includes('\0')) {
      throw new Error(`Refusing to restore "${r.file}": not a plain path inside the worktree.`);
    }
    if (!/^[0-9a-f]{7,64}$/.test(r.base_sha)) {
      throw new Error(`Refusing to restore "${r.file}": base "${r.base_sha}" is not a commit SHA.`);
    }
  }
}

export function restoreCommitMessage(plan: readonly ProtectedRestore[]): string {
  const noun = plan.length === 1 ? 'file' : 'files';
  return (
    `lazy: restore ${plan.length} rejected protected ${noun} to base\n\n` +
    plan.map((r) => `- ${r.file} (base ${r.base_sha.substring(0, 8)})`).join('\n') +
    `\n\nA reviewer rejected these changes. Restored by lazy's supervisor before the ` +
    `agent's next turn; this commit is lazy's own, not the agent's.`
  );
}

/**
 * Put every planned file back to its base and commit exactly those paths.
 * A file that did not exist at its base is deleted. Returns the restore
 * commit's SHA, or null when every file already matched its base (nothing to
 * commit). Throws, naming the file, on any git failure — leaving whatever it
 * staged for the caller to report.
 */
export async function applyProtectedRestores(
  cwd: string,
  plan: readonly ProtectedRestore[],
): Promise<string | null> {
  assertRestorePlanShape(plan);
  if (plan.length === 0) return null;

  for (const r of plan) {
    const atBase = await runGit(['cat-file', '-e', `${r.base_sha}:${r.file}`], { cwd });
    if (atBase.exitCode === 0) {
      const checkout = await runGit(['checkout', r.base_sha, '--', r.file], { cwd });
      if (checkout.exitCode !== 0) {
        throw new Error(`Failed to restore ${r.file} from ${r.base_sha.substring(0, 8)}: ${checkout.stderr.trim()}`);
      }
    } else {
      const removed = await runGit(['rm', '-q', '-f', '--ignore-unmatch', '--', r.file], { cwd });
      if (removed.exitCode !== 0) {
        throw new Error(`Failed to remove ${r.file} (absent at base ${r.base_sha.substring(0, 8)}): ${removed.stderr.trim()}`);
      }
    }
  }

  const paths = plan.map((r) => r.file);
  const changed = await runGit(['diff', '--quiet', 'HEAD', '--', ...paths], { cwd });
  if (changed.exitCode === 0) return null;

  const commit = await runGit(
    ['commit', '--no-verify', `--author=${RESTORE_COMMIT_AUTHOR}`, '-m', restoreCommitMessage(plan), '--', ...paths],
    { cwd },
  );
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit the restore of ${paths.join(', ')}: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  const head = await runGit(['rev-parse', 'HEAD'], { cwd });
  return head.stdout.trim();
}

/** The violation records the reconciler writes on the work turn for a restore. */
export function restoredViolationRecords(done: readonly ProtectedRestoreDone[], now: number): FileViolation[] {
  return done.map((d) => ({
    file: d.file,
    base_sha: d.base_sha,
    status: 'rejected' as const,
    restored_at: now,
    restore_sha: d.commit_sha,
  }));
}

/**
 * What the agent is told at the top of its prompt. `failed` names a restore
 * the supervisor could not carry out, so the agent does not assume it happened.
 */
export function buildRestoredProtectedFilesNotice(
  done: readonly ProtectedRestoreDone[],
  failed?: { plan: readonly ProtectedRestore[]; error: string },
): string {
  const parts: string[] = [];
  if (done.length > 0) {
    const files = done.map((d) => `- ${d.file} (base: ${d.base_sha}, restore commit: ${d.commit_sha.substring(0, 8)})`).join('\n');
    parts.push(restoredPrompt.replace('{{files}}', files).trim());
  }
  if (failed && failed.plan.length > 0) {
    parts.push(
      `REJECTED PROTECTED FILES — lazy could NOT restore these to their base before your turn ` +
      `(${failed.error}):\n` +
      failed.plan.map((r) => `- ${r.file} (base: ${r.base_sha})`).join('\n') +
      `\n\nDo not restore or re-edit them yourself; say in your report that the restore failed. ` +
      `The task cannot be accepted while they still differ from their base.`,
    );
  }
  return parts.join('\n\n');
}
