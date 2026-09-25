/**
 * Fuzzy (typo-tolerant) search over the searchable content index.
 *
 * Split out of the `lazy search` command so the daemon could run a fuzzy query
 * without dragging the CLI's rendering and theme code into its process — but it
 * then sat under `src/cli/commands/` while the daemon's RPC handler was its only
 * remaining caller, which is the coupling it was extracted to avoid. It lives
 * beside the index it searches instead.
 *
 * Still loaded dynamically by the daemon: fuse.js is the only reason this module
 * is expensive, and a non-fuzzy query must not pay for it.
 */

import type { SearchResult } from '../storage';
import Fuse from 'fuse.js';
import { FUZZY_SEARCH_OPTIONS, type SearchableItem } from './searchable';

// The loader and the item shape have ONE owner (src/search/searchable.ts).
// This module used to carry its own near-identical copy; they drifted silently
// — see the note there. Re-exported so existing callers keep their import.
export { getAllSearchableContent } from './searchable';
export type { SearchableItem } from './searchable';

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
      // Ranking's recency signal — fuse's own score is not carried here: the
      // result order is decided once, in rankSearchResults (src/search/run.ts),
      // not by fuse's internal score ordering.
      ...(item.entityTime !== undefined ? { entity_time: item.entityTime } : {}),
    };
  });
}
