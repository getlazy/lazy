/**
 * Mechanical grouping for cross-task raised-item listings.
 *
 * Groups raised items by shared vocabulary so recurrence is visible without an
 * LLM. Two passes:
 *   1. Exact fingerprint — sorted significant words (length >= 4) joined.
 *   2. Near-duplicate merge — Jaccard similarity on those word sets >= 0.55.
 *
 * Explainable and deterministic: every recurrence_id is the fingerprint string or
 * the first member's id when the text has no significant words.
 */

/** Words that carry signal for grouping — drop very short tokens. */
const MIN_WORD_LEN = 4;

/** Near-duplicate threshold on significant-word Jaccard similarity. */
const NEAR_DUPLICATE_JACCARD = 0.55;

export function significantWords(content: string): string[] {
  const norm = content.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!norm) return [];
  const words = norm.split(/\s+/).filter((w) => w.length >= MIN_WORD_LEN);
  return [...new Set(words)].sort();
}

export function wordSet(content: string): Set<string> {
  return new Set(significantWords(content));
}

export function fingerprint(content: string): string {
  return significantWords(content).join('|');
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface GroupableRaisedItem {
  id: string;
  content: string;
}

export interface RaisedItemRecurrence {
  recurrence_id: string;
  size: number;
  sample_content: string;
  raised_item_ids: string[];
  task_ids: string[];
}

/**
 * Assign each raised item to a recurrence and return recurrence summaries.
 * Recurrence leader id is the fingerprint when non-empty, else the first member id.
 */
export function groupRaisedItemsByRecurrence(
  items: GroupableRaisedItem[],
  taskIdFor: (raisedItemId: string) => string,
): {
  recurrenceIdFor: Map<string, string>;
  recurrences: RaisedItemRecurrence[];
} {
  type RecurrenceState = {
    recurrence_id: string;
    words: Set<string>;
    fingerprint: string;
    raised_item_ids: string[];
    task_ids: string[];
    sample_content: string;
  };

  const recurrences: RecurrenceState[] = [];
  const recurrenceIdFor = new Map<string, string>();

  for (const item of items) {
    const fp = fingerprint(item.content);
    const words = wordSet(item.content);
    const taskId = taskIdFor(item.id);

    let match: RecurrenceState | undefined;
    if (fp) {
      match = recurrences.find((c) => c.fingerprint === fp);
    }
    if (!match) {
      match = recurrences.find((c) => jaccardSimilarity(c.words, words) >= NEAR_DUPLICATE_JACCARD);
    }

    if (match) {
      match.raised_item_ids.push(item.id);
      if (!match.task_ids.includes(taskId)) match.task_ids.push(taskId);
      recurrenceIdFor.set(item.id, match.recurrence_id);
      for (const w of words) match.words.add(w);
    } else {
      const recurrence_id = fp || item.id;
      const state: RecurrenceState = {
        recurrence_id,
        words,
        fingerprint: fp,
        raised_item_ids: [item.id],
        task_ids: [taskId],
        sample_content: item.content,
      };
      recurrences.push(state);
      recurrenceIdFor.set(item.id, recurrence_id);
    }
  }

  const summaries: RaisedItemRecurrence[] = recurrences
    .map((c) => ({
      recurrence_id: c.recurrence_id,
      size: c.raised_item_ids.length,
      sample_content: c.sample_content,
      raised_item_ids: c.raised_item_ids,
      task_ids: c.task_ids,
    }))
    .sort((a, b) => b.size - a.size || a.recurrence_id.localeCompare(b.recurrence_id));

  return { recurrenceIdFor, recurrences: summaries };
}
