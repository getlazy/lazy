/**
 * Keyword similarity for raised-item detail pages — reuses the recurrence-grouping vocabulary.
 */

import { jaccardSimilarity, wordSet } from './recurrence';
import type { ListedRaisedItem } from './index';

export interface SimilarRaisedItem {
  item: ListedRaisedItem;
  score: number;
}

/**
 * Rank other raised items by Jaccard similarity on significant words (≥4 chars).
 * Excludes the source item and returns highest scores first.
 */
export function findSimilarRaisedItems(
  source: ListedRaisedItem,
  candidates: ListedRaisedItem[],
  limit = 8,
): SimilarRaisedItem[] {
  const sourceWords = wordSet(source.content);
  const out: SimilarRaisedItem[] = [];

  for (const item of candidates) {
    if (item.id === source.id) continue;
    const score = jaccardSimilarity(sourceWords, wordSet(item.content));
    if (score <= 0) continue;
    out.push({ item, score });
  }

  out.sort((a, b) => b.score - a.score || b.item.created_at - a.item.created_at);
  return out.slice(0, limit);
}
