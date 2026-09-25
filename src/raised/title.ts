/**
 * Display-derived raised-item title — first sentence, trimmed for list/detail headings.
 */

/** Normalize whitespace so sentence scanning sees one line of words. */
export function normalizeRaisedContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

/**
 * First sentence of a raised item body.
 *
 * Prefer the first line: collapsing the whole body to one line is what made
 * a title-plus-paragraph look like one run of sentences.
 *
 * Sentence end is `.!?` followed by whitespace or end-of-string, but only
 * outside backticks and parentheses — otherwise `loader.ts` / `` `foo. bar` ``
 * / `(see docs.)` would cut the goal mid-thought. Enumerator prefixes
 * (`H.`, `1.`, `A)`) are not sentence ends — `H. MOVE candidates…` used to
 * become `H.`. No terminator → the whole first line.
 */
export function firstSentence(content: string): string {
  const firstLine = content.split(/\n/, 1)[0] ?? '';
  const normalized = normalizeRaisedContent(firstLine);
  if (!normalized) return '';

  let i = skipEnumeratorPrefix(normalized, 0);
  let inBackticks = false;
  let parenDepth = 0;
  for (; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '`') {
      inBackticks = !inBackticks;
      continue;
    }
    if (inBackticks) continue;
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (parenDepth > 0) continue;
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = normalized[i + 1];
      if (next === undefined || /\s/.test(next)) {
        return normalized.slice(0, i + 1).trim();
      }
    }
  }
  return normalized;
}

/**
 * `H. `, `12. `, `A) ` at `from` — the period or paren is an enumerator, not
 * a sentence terminator. Returns the index after the prefix, or `from`.
 */
function skipEnumeratorPrefix(text: string, from: number): number {
  const slice = text.slice(from);
  const match = slice.match(/^(?:(?:[A-Za-z]|[0-9]+)\.|[A-Za-z]\))\s+/);
  return match ? from + match[0].length : from;
}

/**
 * Cap at a word boundary and append an ellipsis. Mid-word slice is what
 * produced the 120-char "CLI `--m" promote goal; never do that here.
 */
export function truncateAtWordBoundary(text: string, maxLen: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxLen) return normalized;
  if (maxLen <= 1) return '…';

  const budget = maxLen - 1;
  const slice = normalized.slice(0, budget);
  const breakAt = slice.lastIndexOf(' ');
  // A single huge token still has to be cut; only honor a break if it leaves
  // a usable prefix (at least half the budget, or 40 chars).
  const minBreak = Math.min(40, Math.floor(budget / 2));
  const cut = breakAt >= minBreak ? breakAt : budget;
  return slice.slice(0, cut).trimEnd() + '…';
}

/** First sentence (or first line) of a raised item body, capped for table headings. */
export function raisedTitle(content: string, maxLen = 80): string {
  const title = firstSentence(content);
  if (!title) return '(empty raised item)';
  return truncateAtWordBoundary(title, maxLen);
}

/** Canonical stored body from structured proposal fields. */
export function composeRaisedContent(title: string, explanation?: string): string {
  const t = title.trim();
  const e = explanation?.trim();
  if (!e) return t;
  return `${t}\n\n${e}`;
}

/**
 * Full body for display — every field the caller supplied, none of them lost.
 *
 * `title`, `content` and `explanation` are independent, so the body is their
 * composition. Two shapes must not double-print:
 *
 *  - an item whose `content` was DERIVED from title+explanation (the caller
 *    gave no body of its own, and every item stored before title and content
 *    were made independent) — the derived text is dropped, leaving exactly
 *    what this function rendered before;
 *  - `content` identical to `title` (derived, title-only item).
 *
 * Reading only title+explanation is what hid the create-time clobber on every
 * surface: even once the body was stored, nothing displayed it.
 */
export function raisedDisplayBody(item: {
  content: string;
  title?: string;
  explanation?: string;
}): string {
  const title = item.title?.trim();
  const content = item.content?.trim() ?? '';
  const explanation = item.explanation?.trim();
  if (!title) return item.content;

  const derived = content === title || content === composeRaisedContent(title, explanation);
  const parts = [title];
  if (content && !derived) parts.push(content);
  if (explanation) parts.push(explanation);
  return parts.join('\n\n');
}
