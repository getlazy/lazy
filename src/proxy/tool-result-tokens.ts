/**
 * Token size of a `tool_result` block, counted once per tool call.
 *
 * WHY THIS EXISTS: a tool's real cost is not the call, it is the RESULT the
 * call pushed into the conversation — and that result rides in the next
 * request's input/cache-read counters with no per-block breakdown on the wire.
 * The proxy is the only place holding the full result text, so it is the only
 * place that can size it. Sizing it here, against the `tool_use` id the result
 * answers, is what makes "what did Read actually cost" answerable downstream
 * (src/task/stats.ts) without splitting a request's usage across tools, which
 * would be an invention.
 *
 * WHY A CACHE, AND WHY IT IS NOT OPTIONAL: every request re-sends the entire
 * conversation, so a single audited request carries every `tool_result` the
 * session has ever produced. Measured on a real log, one task's window held
 * 3,966 tool_result blocks totalling 5.7M characters — but only 142 DISTINCT
 * results, 198K characters. Tokenising each block on each request would put
 * megabytes of BPE work on the proxy's request path per call, growing with the
 * session. Keying on the `tool_use` id collapses that to one count per result,
 * ever: the steady-state request does N map lookups and tokenises only the one
 * or two results that are actually new.
 *
 * BOUNDED BY CONSTRUCTION: the cache holds at most MAX_CACHED_RESULTS entries
 * and evicts oldest-first. It is process-local and disposable — losing it costs
 * a re-count, nothing else — so it is not storage state under any reading of
 * CLAUDE.md's carve-out.
 *
 * THE COUNT IS AN APPROXIMATION AND SAYS SO. It comes from the project's BPE
 * tier (src/utils/token-count.ts), which undercounts Claude by roughly 15-20%.
 * That is the honest offline answer; the chars/4 heuristic is explicitly not a
 * method anyone may produce a figure with. Until the encoder's table has
 * loaded, this returns null — "not measured" — never 0, which would read as
 * "this tool's output was free".
 */

import { countTokensBpeSync, warmBpeEncoder } from '../utils/token-count';

/**
 * Distinct tool results remembered. A long session produces a few hundred; the
 * cap is generous enough that a real conversation never evicts, and small
 * enough that the map stays a rounding error against a proxy's footprint.
 */
export const MAX_CACHED_RESULTS = 20_000;

/** tool_use id → tokens in the result that answered it. */
const cache = new Map<string, number>();

/**
 * Start loading the BPE table so {@link toolResultTokens} can answer.
 *
 * Called once when the proxy server is constructed. Deliberately fire-and-
 * forget at the call site: a request arriving before the table is ready gets a
 * null token count for its results, which is a recording gap of a few hundred
 * milliseconds at daemon start, not a reason to delay serving.
 */
export function warmToolResultTokenizer(): Promise<void> {
  return warmBpeEncoder();
}

/**
 * Tokens in one `tool_result` body, or null when the count is not available.
 *
 * `toolUseId` is the cache key. A result with no id (the API always sends one;
 * this is the malformed case) is counted every time it is seen — there is no
 * key to remember it by, and guessing one would merge unrelated results.
 */
export function toolResultTokens(toolUseId: string | null, content: string): number | null {
  if (toolUseId !== null) {
    const cached = cache.get(toolUseId);
    if (cached !== undefined) return cached;
  }

  const tokens = countTokensBpeSync(content);
  if (tokens === null) return null;

  if (toolUseId !== null) {
    // Oldest-first eviction. Map preserves insertion order, so the first key is
    // the oldest; one eviction per insertion keeps the cap exact.
    if (cache.size >= MAX_CACHED_RESULTS) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(toolUseId, tokens);
  }
  return tokens;
}

/** Drop everything remembered. Tests only — the cache is otherwise process-lifetime. */
export function resetToolResultTokenCache(): void {
  cache.clear();
}

/** Entries currently held, for tests and diagnostics. */
export function toolResultTokenCacheSize(): number {
  return cache.size;
}
