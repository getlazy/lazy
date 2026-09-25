/**
 * Linked-task helpers — one place that knows how a task records "this is
 * someone else's branch or PR, adopted by `lazy link`".
 *
 * Canonical metadata keys (written by every driver and by the daemon):
 *   import_source_url    — what the user linked (PR URL, branch URL, or branch)
 *   import_source_branch — the git branch that was adopted
 *
 * PR/MR URL and state stay on the driver (`getRemoteRefUrl` / `getRemoteRefState`)
 * and on `resolveTaskForgeLink`. Do not read `github_remote_ref_url` here.
 */

import type { Task } from '../types';
import { resolveTaskForgeLink, formatTaskForgeLink } from '../task-forge-link';

/** Driver-agnostic key: the original link argument. */
export const IMPORT_SOURCE_URL_KEY = 'import_source_url';
/** Driver-agnostic key: the adopted git branch. */
export const IMPORT_SOURCE_BRANCH_KEY = 'import_source_branch';

function stringMeta(metadata: Record<string, string> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** True when this task was created by `lazy link` (branch or PR). */
export function isLinkedTask(task: Task): boolean {
  return !!(linkedSourceOf(task) || linkedBranchOf(task));
}

/** Branch that was linked, if stored. */
export function linkedBranchOf(task: Task): string | undefined {
  return stringMeta(task.metadata, IMPORT_SOURCE_BRANCH_KEY);
}

/** Original link argument (PR URL, branch URL, or branch name). */
export function linkedSourceOf(task: Task): string | undefined {
  return stringMeta(task.metadata, IMPORT_SOURCE_URL_KEY);
}

/**
 * Short marker for list/show/web: `linked feature/foo` or `linked PR #12`.
 * Prefers the forge link when a PR is already attached, then the branch.
 */
export function formatLinkedMarker(task: Task): string | null {
  if (!isLinkedTask(task)) return null;
  const forge = resolveTaskForgeLink(task);
  const branch = linkedBranchOf(task);
  if (forge && branch) return `linked ${branch} · ${formatTaskForgeLink(forge)}`;
  if (forge) return `linked ${formatTaskForgeLink(forge)}`;
  if (branch) return `linked ${branch}`;
  const source = linkedSourceOf(task);
  return source ? `linked ${source}` : 'linked';
}

/** Keys the later-PR-discovery pass must not overwrite. */
export const LINK_IDENTITY_KEYS = [IMPORT_SOURCE_URL_KEY, IMPORT_SOURCE_BRANCH_KEY] as const;

export function applyLinkIdentity(
  metadata: Record<string, string>,
  source: string,
  branch: string,
): Record<string, string> {
  return {
    ...metadata,
    [IMPORT_SOURCE_URL_KEY]: source,
    [IMPORT_SOURCE_BRANCH_KEY]: branch,
  };
}
