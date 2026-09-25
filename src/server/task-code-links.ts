/**
 * Task-code autolink table for the shared markdown linkify pass.
 *
 * Conservative on purpose: `validateCode` still accepts 2-character codes
 * (`ab`), which would light up ordinary words. Autolink only fires when the
 * code is long enough AND looks like a slug (a hyphen, underscore, or digit).
 * Tightening validation itself is a separate, blocking raise — do not silently
 * change who can create a short code.
 */

import type { MarkdownLinkifyTable } from './markdown';

/** Minimum length at which a stored code is a candidate for word autolink. */
export const AUTOLINK_TASK_CODE_MIN_LENGTH = 8;

/**
 * Whether this stored code should become a link in prose.
 *
 * Matching only — not validation. A code that fails this still exists; we
 * just refuse to guess that a short dictionary word is a task.
 */
export function isAutolinkableTaskCode(code: string): boolean {
  if (code.length < AUTOLINK_TASK_CODE_MIN_LENGTH) return false;
  return /[-_0-9]/.test(code);
}

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
