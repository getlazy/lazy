/**
 * Bounded regex matching for store search — the plain-text (non-structured,
 * non-fuzzy) path behind `lazy search`, `lazy_search`, and the dashboard's
 * `/search` page.
 *
 * That query is a case-insensitive JS regex, typed by a human or an agent and
 * evaluated against every task goal, prompt, turn, commit message, comment,
 * follow-up, raised item, conversation message, memory record, and scratch
 * file in the store. Compiling and running it on the daemon's thread is the
 * same ReDoS shape conversation search already fixed: one pattern like
 * `a*a*a*a*a*$` against a long run of `a` wedges the event loop for as long as
 * the engine backtracks, and nothing can interrupt it. Matching therefore runs
 * in a Worker with a deadline (see {@link runRegexWorker}).
 *
 * The deadline is per BATCH, not per search, on purpose: the store's text is
 * unbounded (a mature project has hundreds of megabytes of turns), so a
 * whole-search budget would refuse an ordinary word search on a big store while
 * a catastrophic pattern is already caught by the first batch it blows.
 */

import { runRegexWorker, SEARCH_REGEX_DEADLINE_MS } from './regex-worker';

export { SEARCH_REGEX_DEADLINE_MS };

/**
 * Batch size — how much text one Worker round trip carries, and therefore how
 * much matching the deadline covers. Small enough that a batch of ordinary text
 * finishes far inside the deadline; large enough that a whole store is a
 * handful of round trips rather than thousands.
 */
export const SEARCH_MATCH_BATCH_ITEMS = 500;
export const SEARCH_MATCH_BATCH_CHARS = 2_000_000;

/** Characters of context kept either side of a match in `match_context`. */
export const SEARCH_CONTEXT_CHARS = 40;

interface TextMatch {
  index: number;
  context: string;
}

interface MatchPayload {
  texts: string[];
  query: string;
  contextChars: number;
}

/**
 * The matching loop. A function *declaration* on purpose: the Worker source is
 * this function's `toString()`, so there is no second copy of the matching
 * rules to drift. Do not close over module-scope values — `toString()` does not
 * capture closures — and keep it to syntax that survives transpilation.
 */
function matchTextsUnbound(texts: string[], query: string, contextChars: number): TextMatch[] {
  const regex = new RegExp(query, 'i');
  const out: TextMatch[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const match = text.match(regex);
    if (!match || match.index === undefined) continue;

    const start = Math.max(0, match.index - contextChars);
    const end = Math.min(text.length, match.index + match[0].length + contextChars);
    let context = text.substring(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    out.push({ index: i, context: context });
  }

  return out;
}

/**
 * Worker body: the matching loop above, bound to a local name so a minified
 * build (release binaries are built with `--minify-syntax`) cannot rename the
 * function out from under the call below.
 */
function matchWorkerSource(): string {
  return `var __matchTexts = ${matchTextsUnbound.toString()};
self.onmessage = function (event) {
  try {
    var data = event.data;
    var matches = __matchTexts(data.texts, data.query, data.contextChars);
    self.postMessage({ ok: true, result: matches });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
`;
}

/** Literal (non-regex) context extraction, for the invalid-pattern fallback. */
function literalContext(text: string, needle: string, contextChars: number): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  const matchStart = idx === -1 ? 0 : idx;
  const start = Math.max(0, matchStart - contextChars);
  const end = Math.min(text.length, matchStart + needle.length + contextChars);

  let result = text.substring(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) result = '...' + result;
  if (end < text.length) result = result + '...';
  return result;
}

/**
 * Accumulates candidate haystacks for one search and matches them in bounded
 * batches, preserving the order they were added in.
 *
 * Usage: `add()` every candidate with a builder that turns the match context
 * into a result row, then `finish()` for the rows. A caller never sees the
 * regex, so it cannot accidentally run one on the daemon's thread.
 *
 * A pattern the engine rejects (`(unclosed`) keeps the long-standing fallback
 * to a case-insensitive literal search — that path is linear and runs here, on
 * the caller's thread, with no Worker involved.
 */
export class BoundedTextMatcher<T> {
  private readonly regex: RegExp | null;
  private pending: Array<{ text: string; build: (context: string) => T }> = [];
  private pendingChars = 0;
  private readonly results: T[] = [];

  constructor(
    private readonly query: string,
    private readonly contextChars: number = SEARCH_CONTEXT_CHARS,
  ) {
    // Compiling here (not in the Worker) keeps a typo failing instantly with
    // the literal-search fallback, exactly as before this was bounded.
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(query, 'i');
    } catch {
      compiled = null;
    }
    this.regex = compiled;
  }

  /**
   * Offer one haystack. `build` is called only if it matches, with the context
   * snippet for `match_context`.
   *
   * A non-string haystack is tolerated: a stored record can lack the field its
   * type declares (e.g. a crash turn persisted without `content`), and testing
   * `undefined` would silently match the literal string "undefined".
   */
  async add(text: unknown, build: (context: string) => T): Promise<void> {
    if (typeof text !== 'string') return;

    if (this.regex === null) {
      if (!text.toLowerCase().includes(this.query.toLowerCase())) return;
      this.results.push(build(literalContext(text, this.query, this.contextChars)));
      return;
    }

    this.pending.push({ text, build });
    this.pendingChars += text.length;
    if (
      this.pending.length >= SEARCH_MATCH_BATCH_ITEMS ||
      this.pendingChars >= SEARCH_MATCH_BATCH_CHARS
    ) {
      await this.flush();
    }
  }

  /** Match whatever is still pending and return every row, in add() order. */
  async finish(): Promise<T[]> {
    await this.flush();
    return this.results;
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.pendingChars = 0;

    const matches = await runRegexWorker<MatchPayload, TextMatch[]>({
      id: 'search-text-match',
      source: matchWorkerSource,
      payload: {
        texts: batch.map(item => item.text),
        query: this.query,
        contextChars: this.contextChars,
      },
      query: this.query,
    });

    for (const match of matches) {
      const item = batch[match.index];
      if (item) this.results.push(item.build(match.context));
    }
  }
}
