/**
 * Search result ranking — the ONE place that decides result order.
 *
 * Search results used to come back in whatever order the store happened to
 * produce: a regex query walked task directories, a structured query walked
 * task lists. Typing a task's exact code buried that task under every turn
 * and commit that merely mentions it. The engineer's rule (2026-09): an exact
 * code must be the first hit, and entity types rank in a fixed order.
 *
 * Ranking lives here because executeSearch() (src/search/run.ts) is the one
 * search entry point — the daemon RPC behind `lazy search` and `lazy_search`,
 * the dashboard's `/search` page and the `/api/search` palette endpoint all
 * return whatever this module orders. A surface that sorted on its own would
 * answer the same query differently the first time one of them was edited
 * alone, which is exactly the failure the shared entry point exists to
 * prevent.
 *
 * The order, top to bottom:
 *
 *   1. Entity type tier — task, prompt, turn, commit, comment, raised,
 *      conversation, memory, scratch. The PRIMARY key. A task beats a
 *      stronger match in a lower tier, which is what "tasks should always
 *      have preference over prompts, and those over turns" means.
 *   2. Within a tier, match strength against the query's literal text:
 *      exact, then prefix, then substring, then everything else. This is
 *      also what makes the exact-code case the very first hit: task is the
 *      top tier and an exact code is the top strength within it.
 *   3. Then recency — newer `entity_time` first.
 *   4. Full ties keep the engine's original order, which is the store's own
 *      deterministic walk.
 *
 * Ranking only REORDERS. It never adds, drops or merges rows, and every
 * caller pages over the ranked list, so `offset`/`limit` address the same
 * rows the unranked search would have returned, in rank order.
 */

import type { SearchResult } from '../storage/types';
import type { QueryNode } from './parser';

/**
 * Tier per entity type — the engineer's stated order, stated here and
 * nowhere else. `comment` before `raised` before `conversation` is the order
 * the feedback named ("comments, raised items, conversations, ...");
 * memories and scratch files are project-level reference material and rank
 * last. Unknown types (a future entity the ranking has not been taught) fall
 * to the bottom rather than crashing the sort.
 */
const TYPE_TIERS: Record<SearchResult['entity_type'], number> = {
  task: 0,
  prompt: 1,
  turn: 2,
  commit: 3,
  comment: 4,
  // 'followup' is the pre-unification spelling of 'raised' — same entity,
  // same tier. Kept so a legacy row (if a backend ever emits one) lands in
  // the tier it belongs to instead of the unknown-type fallback.
  raised: 5,
  followup: 5,
  conversation: 6,
  memory: 7,
  scratch: 8,
};

const UNKNOWN_TYPE_TIER = TYPE_TIERS.scratch + 1;

const STRENGTH_EXACT = 0;
const STRENGTH_PREFIX = 1;
const STRENGTH_SUBSTRING = 2;
const STRENGTH_NONE = 3;

/**
 * The texts a row is judged by: the task's code when the row belongs to a
 * task, and the row's own content (for a task row, that is the code or the
 * goal; for everything else, the entity's full text).
 *
 * `match_context` is deliberately NOT one of these — it is a lossy snippet
 * around the match (with `...` markers), so testing it would mis-rank rows
 * whose full text starts with or equals the query.
 */
function identityTexts(row: SearchResult): string[] {
  const texts: string[] = [];
  if (row.task_code) texts.push(row.task_code);
  if (row.content) texts.push(row.content);
  return texts;
}

/**
 * Match strength of one literal term against one row's identity texts.
 * Case-insensitive throughout, like the matching underneath it.
 */
function strengthAgainst(term: string, texts: string[]): number {
  let best = STRENGTH_NONE;
  if (!term) return best;
  for (const text of texts) {
    const hay = text.toLowerCase();
    if (hay === term) return STRENGTH_EXACT; // cannot be beaten
    if (hay.startsWith(term)) best = Math.min(best, STRENGTH_PREFIX);
    else if (hay.includes(term)) best = Math.min(best, STRENGTH_SUBSTRING);
  }
  return best;
}

/**
 * The literal text a structured query looks for — free-text terms, `in:`
 * values, and the `goal:` / `task:` field values.
 *
 * Deliberately NOT the same set as evaluator.ts's extractTextTerms(): that
 * one feeds match-context extraction, where a `task:` value would push
 * ADDITIONAL rows (every turn containing the code substring) and change
 * which results come back. Ranking only orders rows already produced, so it
 * can afford the wider set — `task:spike` then ranks the code row of
 * `spike-vm-isolation` by prefix strength above rows that merely contain
 * "spike" somewhere.
 *
 * Like that extractor, it skips NOT branches: a negated term is an exclusion
 * criterion, not text the human is looking for.
 */
export function queryLiteralTerms(node: QueryNode): string[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return [...queryLiteralTerms(node.left), ...queryLiteralTerms(node.right)];
    case 'not':
      return [];
    case 'text':
    case 'in':
      return [node.value];
    case 'field':
      return node.field === 'goal' || node.field === 'task' ? [node.value] : [];
    case 'has':
    case 'date':
      return [];
  }
}

/**
 * Parse an ISO timestamp into epoch ms, or undefined when absent/unparseable.
 *
 * Conversation records store timestamps as ISO strings (they are imported
 * Claude Code transcripts), while every other entity already carries epoch
 * ms. Producers use this to fill `entity_time` uniformly; a record whose
 * timestamp cannot be parsed simply ranks without a time, falling back to
 * the stable order rather than fabricating one.
 */
export function entityTimeFromIso(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Order search results. Same rows in, ranked rows out — never a different
 * set. `literalTerms` are the query's text, as the human typed it: the raw
 * query for the regex and fuzzy modes, {@link queryLiteralTerms} output for
 * a structured query. Terms are matched case-insensitively; an empty term
 * list (e.g. a pure `status:` query) leaves every row at equal strength, so
 * tier and recency decide.
 */
export function rankSearchResults(results: SearchResult[], literalTerms: string[]): SearchResult[] {
  const terms = literalTerms.map(t => t.trim().toLowerCase()).filter(t => t.length > 0);

  return results
    .map((row, index) => {
      let strength = STRENGTH_NONE;
      if (terms.length > 0) {
        const texts = identityTexts(row);
        // The row's best term decides: a hit that one term matches exactly
        // and another barely mentions is still an exact hit.
        strength = Math.min(...terms.map(term => strengthAgainst(term, texts)));
      }
      return {
        row,
        index,
        tier: TYPE_TIERS[row.entity_type] ?? UNKNOWN_TYPE_TIER,
        strength,
        time: row.entity_time ?? 0,
      };
    })
    .sort((a, b) =>
      a.tier - b.tier ||
      a.strength - b.strength ||
      b.time - a.time ||
      a.index - b.index
    )
    .map(entry => entry.row);
}