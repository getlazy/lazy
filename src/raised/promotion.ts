/**
 * Derive which raised items were likely promoted to tasks when the record
 * itself carries no promoted state.
 *
 * Builders often open promoted tasks with "Promoted from a follow-up on …" in
 * the prompt, and lazy's own promotion appends "Promoted from raised item <id>
 * on task <ref>". That text is the best signal we have for manual promotions;
 * it is imperfect (a promotion without that boilerplate stays invisible), and a
 * record that WAS promoted through lazy carries `promoted_task_id` instead, so
 * this index only backfills the rest.
 */

import type { Task } from '../types';

/**
 * Matches both provenance spellings:
 *   - legacy builder prose: `Promoted from a follow-up on fix-foo`
 *   - lazy's own promote:   `Promoted from raised item <id> on task fix-foo`
 *
 * The follow-up spelling stays matched forever: promoted tasks created before
 * unification carry it in their stored prompts, and dropping it would silently
 * empty the promotion hints on the whole existing backlog.
 *
 * A trailing `.` is excluded from the reference along with `:` — the provenance
 * ends in one or the other depending on whether the originating task had a
 * goal, and a code can never contain a dot (it becomes a hostname label).
 */
const PROMOTED_FROM_RE =
  /Promoted from (?:a follow-up on|(?:a )?(?:follow-up|raised item) \S+ on task) [`']?([^`'\s(:.]+)/gi;

/** Cheap pre-filter so we only regex prompts that could possibly match. */
const PROMOTED_MARKER_RE = /Promoted from (?:a follow-up|follow-up|a raised item|raised item)/i;

/**
 * Map originating task id → task ids whose prompt claims promotion from it.
 */
export function buildPromotionIndex(tasks: Task[]): Map<string, string[]> {
  const byCode = new Map<string, string>();
  const byRef = new Map<string, string>();

  for (const task of tasks) {
    if (task.code) byCode.set(task.code.toLowerCase(), task.id);
    byRef.set(task.id.toLowerCase(), task.id);
    byRef.set(task.id.slice(0, 8).toLowerCase(), task.id);
  }

  const promotions = new Map<string, string[]>();

  for (const task of tasks) {
    const prompt = task.prompt ?? '';
    if (!PROMOTED_MARKER_RE.test(prompt)) continue;

    PROMOTED_FROM_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROMOTED_FROM_RE.exec(prompt)) !== null) {
      const ref = match[1]!.toLowerCase();
      const sourceId =
        byCode.get(ref) ??
        byRef.get(ref) ??
        (ref.length >= 8 ? byRef.get(ref.slice(0, 8)) : undefined);
      if (!sourceId) continue;

      const existing = promotions.get(sourceId) ?? [];
      if (!existing.includes(task.id)) existing.push(task.id);
      promotions.set(sourceId, existing);
    }
  }

  return promotions;
}
