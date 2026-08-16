/**
 * Search data layer — shared between CLI direct mode and daemon RPC handlers.
 *
 * Extracted from search.ts to avoid importing CLI rendering/theme code
 * in the daemon process.
 */

import type { SearchResult } from '../../storage';
import Fuse from 'fuse.js';
import { FUZZY_SEARCH_OPTIONS, type SearchableItem } from '../../search/searchable';

// The loader and the item shape have ONE owner (src/search/searchable.ts).
// This module used to carry its own near-identical copy; they drifted silently
// — see the note there. Re-exported so existing callers keep their import.
export { getAllSearchableContent } from '../../search/searchable';
export type { SearchableItem } from '../../search/searchable';

function getMatchContext(content: string, matchStart: number, matchLength: number): string {
  const contextChars = 40;
  const start = Math.max(0, matchStart - contextChars);
  const end = Math.min(content.length, matchStart + matchLength + contextChars);

  let result = content.substring(start, end);
  result = result.replace(/\s+/g, ' ').trim();

  if (start > 0) result = '...' + result;
  if (end < content.length) result = result + '...';

  return result;
}

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

export function fuzzySearch(items: SearchableItem[], query: string): SearchResult[] {
  const fuse = new Fuse(items, FUZZY_SEARCH_OPTIONS);

  const fuseResults = fuse.search(query);

  return fuseResults.map(result => {
    const item = result.item;
    const matchInfo = result.matches?.[0];

    let matchedContent = item.content;
    if (matchInfo && matchInfo.indices.length > 0) {
      const [start, end] = matchInfo.indices[0];
      matchedContent = getMatchContext(item.content, start, end - start + 1);
    } else {
      matchedContent = truncate(item.content, 100);
    }

    return {
      entity_type: item.type,
      entity_id: item.taskId,
      task_id: item.taskId,
      task_code: item.taskCode,
      task_goal: item.taskGoal,
      content: item.content,
      match_context: matchedContent,
      ...(item.entityIndex !== undefined ? { entity_index: item.entityIndex } : {}),
      ...(item.turnSequence !== undefined ? { turn_sequence: item.turnSequence } : {}),
    };
  });
}
