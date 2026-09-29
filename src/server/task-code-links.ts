/**
 * Task-code autolink table for the shared markdown linkify pass.
 *
 * Conservative on purpose: `validateCode` still accepts 2-character codes
 * (`ab`), which would light up ordinary words. Autolink only fires when the
 * code is long enough AND looks like a slug (a hyphen, underscore, or digit).
 * Tightening validation itself is a separate, blocking raise — do not silently
 * change who can create a short code.
 */

import type { MarkdownLinkifyTable, RenderMarkdownOptions } from './markdown';
import type { Storage } from '../storage/interface';
import type { TaskCodeEntry } from '../storage/types';
import { logger } from '../utils/logger';
import { buildIdLinkIndex, isAutolinkableTaskCode, type IdLinkIndex } from '../task/id-links';

// The rule moved to src/task/id-links.ts so the daemon RPC shares it.
export { AUTOLINK_TASK_CODE_MIN_LENGTH, isAutolinkableTaskCode } from '../task/id-links';
import { duplicateTaskCodes, taskPath } from './task-urls';

/**
 * Build a word-matching linkify table from the project's tasks.
 *
 * Duplicate codes (should not happen) are omitted rather than guessed.
 */
export function buildTaskCodeLinkify(
  tasks: ReadonlyArray<{ id: string; code?: string | null }>,
): MarkdownLinkifyTable {
  const lookup = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    const code = task.code?.trim();
    if (!code || !isAutolinkableTaskCode(code)) continue;
    if (lookup.has(code) || duplicates.has(code)) {
      lookup.delete(code);
      duplicates.add(code);
      continue;
    }
    lookup.set(code, `/tasks/${encodeURIComponent(code)}`);
  }
  return { lookup, className: 'lz-task-link', matchWords: true };
}

/**
 * The dashboard's hrefs for ids the daemon resolved (src/task/id-links.ts):
 * task → its page, raised item → `/raised/<id>`, commit → the task's commit
 * page. What exists is the index's decision; this only spells the URL.
 */
export function idLinkHrefs(
  index: IdLinkIndex,
  duplicated?: ReadonlySet<string>,
): NonNullable<RenderMarkdownOptions['idLinks']> {
  return (token) => {
    const hit = index.resolve(token);
    if (!hit) return null;
    switch (hit.kind) {
      case 'task':
        return { href: taskPath({ id: hit.taskId, code: hit.taskCode }, duplicated), className: 'lz-task-link' };
      case 'raised':
        return { href: `/raised/${encodeURIComponent(hit.raisedId)}`, className: 'lz-raised-link' };
      case 'commit':
        return {
          href: `${taskPath({ id: hit.taskId, code: hit.taskCode }, duplicated)}/commits/${encodeURIComponent(hit.commitId)}`,
          className: 'lz-commit-link',
        };
    }
  };
}

/**
 * Snapshot the store and return the dashboard's id resolver in one step, or
 * `undefined` when the snapshot cannot be read: a missing link is never worth
 * a failed page (same posture as the symbol table).
 */
export async function loadIdLinks(
  storage: Storage,
  taskId?: string | null,
  /** The caller's already-loaded `listTaskCodes()`, when it has one. */
  taskCodes?: readonly TaskCodeEntry[],
): Promise<RenderMarkdownOptions['idLinks']> {
  try {
    const codes = taskCodes ?? await storage.listTaskCodes();
    const index = await buildIdLinkIndex(storage, { taskId, taskCodes: codes });
    return idLinkHrefs(index, duplicateTaskCodes(codes));
  } catch (err) {
    logger.debug(`id links unavailable${taskId ? ` for ${taskId.slice(0, 8)}` : ''}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
