/**
 * The one search entry point.
 *
 * Choosing a matching mode (fuzzy / structured / regex), applying the type
 * filter, and explaining an empty tag result are business rules, so they live
 * here and every client calls in: the daemon's `search` RPC (behind `lazy
 * search` and the `lazy_search` MCP tool) and the dashboard's `/search` page
 * and `/api/search` palette endpoint.
 *
 * The dashboard used to call `storage.search()` directly, which skipped mode
 * selection entirely: `code:spike` was parsed as a field by the CLI and as a
 * raw regex by the web UI, so the same query returned nothing in one surface
 * and a handful of literal-text hits in the other. Any new surface must call
 * this function rather than reaching for `storage.search()`.
 *
 * Every result this function returns has also been through rankSearchResults()
 * (src/search/ranking.ts): exact code first, then entity type tiers, then
 * match strength, then recency. The order is applied here — once — so all
 * four surfaces agree; sorting in a client would reintroduce the divergence
 * above with a different symptom.
 */

import type { Storage } from '../storage/interface';
import type { SearchResult } from '../storage/types';
import { isStructuredQuery, parseQuery } from './parser';
import { structuredSearch, buildTagHint } from './structured';
import { rankSearchResults, queryLiteralTerms } from './ranking';

export interface SearchRequest {
  query: string;
  /** Typo-tolerant matching. Bypasses the query language entirely. */
  fuzzy?: boolean;
  /** Entity types to keep, e.g. ['task', 'turn']. Empty/absent keeps all. */
  types?: string[];
}

export interface SearchOutcome {
  query: string;
  results: SearchResult[];
  /** Present only on a zero-result tag query — explains why nothing matched. */
  hint?: string;
}

/**
 * Legacy spellings the `types` filter accepts. `followup`/`followups` are the
 * pre-unification names of the raised item — one entity, two spellings, the
 * same alias `in:followups` already honours. Before this table the CLI's
 * `--followups` flag (which pushes `followup`) matched nothing at all: no
 * producer emits a `followup` row, so every hit was filtered away and the
 * flag silently returned zero results.
 */
const TYPE_FILTER_ALIASES: Record<string, string> = {
  followup: 'raised',
  followups: 'raised',
};

/**
 * A regex the store refused (it ran past its evaluation deadline). Distinct
 * from QueryParseError so callers can map both to a 400 while telling the human
 * which of the two happened.
 */
export class SearchPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchPatternError';
  }
}

export async function executeSearch(storage: Storage, request: SearchRequest): Promise<SearchOutcome> {
  const { query } = request;
  const fuzzy = request.fuzzy === true;

  let results: SearchResult[];

  if (fuzzy) {
    // Dynamic import to avoid loading fuse.js until needed
    const { getAllSearchableContent, fuzzySearch } = await import('./fuzzy');
    const items = await getAllSearchableContent(storage);
    results = fuzzySearch(items, query);
  } else if (isStructuredQuery(query)) {
    results = await structuredSearch(storage, query);
  } else {
    try {
      results = await storage.search(query);
    } catch (err) {
      throw new SearchPatternError(err instanceof Error ? err.message : String(err));
    }
  }

  if (request.types && request.types.length > 0) {
    const typeSet = new Set(request.types.map(t => TYPE_FILTER_ALIASES[t] ?? t));
    results = results.filter(r => typeSet.has(r.entity_type));
  }

  // Rank before returning, so every caller's offset/limit pages over the
  // ranked list — the MCP handler and the CLI slice after this returns, and
  // the dashboard renders the array in order.
  //
  // The literal terms are the query's text, per mode: the raw query for the
  // fuzzy and regex modes, the structured query's text terms for the
  // structured one. The re-parse below cannot fail by the time it runs —
  // structuredSearch already parsed this exact query successfully, and the
  // same input throws the same QueryParseError it would have thrown there.
  const literalTerms = fuzzy || !isStructuredQuery(query)
    ? [query]
    : queryLiteralTerms(parseQuery(query));
  results = rankSearchResults(results, literalTerms);

  // A tag query that matches nothing is indistinguishable from a typo, a
  // never-applied tag, or an unquoted multi-word value — say which it is.
  // Structured queries only: the fuzzy and regex paths never parse `tag:`.
  let hint: string | null = null;
  if (results.length === 0 && !fuzzy && isStructuredQuery(query)) {
    hint = await buildTagHint(storage, query);
  }

  return { query, results, ...(hint ? { hint } : {}) };
}
