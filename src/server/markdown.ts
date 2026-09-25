/**
 * Lightweight Markdown to HTML renderer
 *
 * Handles the common Markdown constructs found in lazy turns:
 * - Headings (#, ##, ###, etc.)
 * - Code blocks (``` with language)
 * - Mermaid fences (```mermaid) — wrapped for the shared diagram enhancer
 *   (src/server/mermaid.ts); same toggle as in diffs
 * - Inline code (`code`)
 * - Bold (**text**) and italic (*text*)
 * - Links [text](url)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - Pipe tables (a header row followed by a `| --- | :--: |` delimiter row)
 * - Paragraphs
 */

import { wrapMermaidFence } from './mermaid';
import { escapeHtml } from './escape';

/**
 * URL schemes a rendered link may use. Everything else renders as inert text.
 *
 * WHY THIS EXISTS. Markdown reaching this renderer is not all ours. Comments
 * carry `source: 'remote'` text synced verbatim from PR/MR bodies, raised items
 * and turn reports are agent-written, and every one of them is read on a page
 * served from the origin that holds the dashboard session cookie — the cookie
 * that authorizes Unblock, Accept, Reject and the web shell. A single
 * `[looks fine](javascript:…)` that someone clicks therefore runs script with
 * full authority over this project's tasks. One click is a low bar for that
 * payoff, so the link is never rendered clickable in the first place.
 *
 * `mailto` is here because release notes and PR bodies legitimately carry one.
 * `data:` and `blob:` are deliberately absent: both can carry an HTML document.
 */
const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/**
 * ASCII whitespace and C0/C1 controls, which browsers STRIP while parsing a URL
 * scheme — so `java\tscript:x` and ` javascript:x` both navigate. Any scheme
 * check that does not remove these first is decorative.
 */
const URL_IGNORED_CHARS = /[\u0000-\u0020\u007f-\u009f]/g;

/**
 * What the text before a `:` must look like for it to be a SCHEME at all: a
 * letter, then letters, digits, `+` or `-`. No dot.
 *
 * The dot is what does the work here. `src/server/markdown.ts:192` is the most
 * common shape of code reference agents write — CLAUDE.md tells them to write
 * `file_path:line_number` because it is clickable — and treating `markdown.ts`
 * as an asserted scheme made every one of those render as grey inert text
 * captioned "unsupported URL scheme". On a shared renderer that is lazy issuing
 * a security warning about its own prose, in turn reports, raised items,
 * journal entries, comments, memory records and presented markdown alike.
 *
 * INVARIANT: this narrowing must not widen what is refused-by-allowlist.
 * `javascript`, `data`, `blob`, `vbscript` and `file` are all undotted
 * lowercase words, so every one of them still matches this pattern, still
 * reaches the allowlist, and is still refused. RFC 3986 does permit a dot in a
 * scheme, so a hostile `a.b:` prefix now falls through as a relative path —
 * which is exactly what a browser resolves it to as well, since it is not a
 * registered scheme and cannot execute anything.
 */
const URL_SCHEME_SHAPE = /^[a-z][a-z0-9+-]*$/;

/**
 * The href if it is safe to render as a link, or null if it must not be.
 *
 * Relative paths, query-only and fragment-only hrefs have no scheme and are
 * always allowed — that is what `/tasks/abc/changes`, `?sort=age` and
 * `#group-retry` are, and they are the majority of links lazy renders.
 *
 * A colon before the first `/`, `?` or `#` MAY be asserting a scheme. It only
 * counts as one when the text before it is scheme-shaped (see
 * {@link URL_SCHEME_SHAPE}); then it must be on the allowlist. A dotted prefix
 * — `markdown.ts:192`, `CLAUDE.md:1` — is the relative path it looks like. An
 * UNDOTTED prefix is still read as a scheme and still refused, so the
 * narrowing keys on the dot rather than on "looks pathlike".
 *
 * Takes the ALREADY HTML-escaped href, which is safe: escaping turns `&` into
 * `&amp;`, so an entity like `&Tab;` in the source can no longer decode to a
 * character the browser would strip — it is literal text inside the scheme,
 * which only makes the scheme invalid.
 */
export function safeLinkHref(href: string): string | null {
  const probe = href.replace(URL_IGNORED_CHARS, '').toLowerCase();
  const colon = probe.indexOf(':');
  if (colon === -1) return href;
  const delimiter = probe.search(/[/?#]/);
  if (delimiter !== -1 && delimiter < colon) return href;
  const candidate = probe.slice(0, colon);
  if (!URL_SCHEME_SHAPE.test(candidate)) return href;
  return SAFE_LINK_SCHEMES.has(candidate) ? href : null;
}

/**
 * What a refused link renders as: the label and the URL it wanted, as plain
 * text, so the reader sees there was a link and what it pointed at without
 * being able to follow it. Silently dropping the href would leave text that
 * looks like an ordinary sentence and hide that someone tried something.
 */
function inertLinkHtml(label: string, href: string): string {
  return `<span class="md-blocked-link" title="Link not shown: unsupported URL scheme">${label} (${href})</span>`;
}

/**
 * One lookup table for the shared linkify pass. First table to match wins.
 *
 * `lookup` maps a name (task code, symbol) to an href. Empty maps are a no-op
 * so an unmarked render stays byte-identical to one with no options.
 */
export interface MarkdownLinkifyTable {
  lookup: ReadonlyMap<string, string>;
  /** Extra class on the wrapping <a>. */
  className?: string;
  /**
   * Also match the keys as bare words (task codes). Symbol tables leave this
   * off — only `` `name` `` / `` `name()` `` / `` `Type.method` `` linkify.
   */
  matchWords?: boolean;
}

function lookupLink(
  raw: string,
  tables: readonly MarkdownLinkifyTable[],
): { href: string; className?: string } | null {
  const candidates = [raw];
  if (raw.endsWith('()')) candidates.push(raw.slice(0, -2));
  const dot = raw.lastIndexOf('.');
  if (dot >= 0) {
    candidates.push(raw.slice(dot + 1));
    if (raw.endsWith('()')) candidates.push(raw.slice(dot + 1, -2));
  }
  for (const table of tables) {
    if (table.lookup.size === 0) continue;
    for (const name of candidates) {
      const href = table.lookup.get(name);
      if (href) return { href, className: table.className };
    }
  }
  return null;
}

function wrapLinkedCode(inner: string, hit: { href: string; className?: string }): string {
  // Table hrefs are lazy's own (`/tasks/…`), but the allowlist is applied on
  // every one of the three link paths rather than only the one reachable from
  // untrusted text today: a gap on two of three paths is one future linkify
  // table away from being the same hole again.
  if (safeLinkHref(escapeHtml(hit.href)) === null) return `<code>${inner}</code>`;
  const cls = hit.className ? ` class="${escapeHtml(hit.className)}"` : '';
  return `<a href="${escapeHtml(hit.href)}"${cls}><code>${inner}</code></a>`;
}

/** One alternation over every autolinkable word, plus the map back to its href. */
interface WordMatcher {
  re: RegExp;
  byCode: ReadonlyMap<string, { href: string; className?: string }>;
}

/**
 * Memo of compiled word matchers, keyed by the exact table objects.
 *
 * Building a matcher is O(number of codes) — every key escaped, sorted by
 * length and joined into one alternation — and `renderMarkdown` runs per
 * paragraph, while the task-code table holds every code in the store. Rebuilt
 * per call, rendering 54 turns therefore scaled with the size of the WHOLE
 * store: most of a 49ms Turns render on a 2000-task store was this function
 * recompiling the same regex hundreds of times.
 *
 * A chain of WeakMaps rather than one cache keyed on the array: `review.ts`
 * composes a fresh array per item out of the same tables, so array identity
 * would miss, and weak keys mean a request's tables (and their matcher) are
 * collected with the request. A table's `lookup` is a ReadonlyMap built once
 * per request — mutating one after a render would serve a stale matcher.
 */
interface MatcherNode {
  matcher?: WordMatcher;
  next: WeakMap<MarkdownLinkifyTable, MatcherNode>;
}
const matcherRoot: MatcherNode = { next: new WeakMap() };

function wordMatcherFor(tables: readonly MarkdownLinkifyTable[]): WordMatcher | null {
  const wordTables = tables.filter((t) => t.matchWords && t.lookup.size > 0);
  if (wordTables.length === 0) return null;

  let node = matcherRoot;
  for (const table of wordTables) {
    let child = node.next.get(table);
    if (!child) {
      child = { next: new WeakMap() };
      node.next.set(table, child);
    }
    node = child;
  }
  if (!node.matcher) node.matcher = buildWordMatcher(wordTables);
  return node.matcher;
}

/** Longest key first so `foo-bar-baz` wins over `foo-bar`. */
function buildWordMatcher(tables: readonly MarkdownLinkifyTable[]): WordMatcher {
  const entries: { code: string; href: string; className?: string }[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    for (const [code, href] of table.lookup) {
      if (seen.has(code)) continue;
      seen.add(code);
      entries.push({ code, href, className: table.className });
    }
  }
  entries.sort((a, b) => b.code.length - a.code.length);
  const alts = entries.map((e) => e.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    re: new RegExp(`(?<![A-Za-z0-9_-])(${alts.join('|')})(?![A-Za-z0-9_-])`, 'g'),
    byCode: new Map(entries.map((e) => [e.code, e])),
  };
}

/**
 * Word-level autolink for task codes. Skips text already inside <a> or <code>
 * so a markdown link or a backticked span is not wrapped twice.
 */
function linkifyWords(html: string, tables: readonly MarkdownLinkifyTable[]): string {
  const matcher = wordMatcherFor(tables);
  if (!matcher) return html;
  const { re, byCode } = matcher;

  const parts = html.split(/(<[^>]+>)/);
  let inA = 0;
  let inCode = 0;
  return parts.map((part) => {
    if (part.startsWith('<')) {
      if (/^<a[\s>/]/i.test(part)) inA++;
      else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1);
      else if (/^<code[\s>/]/i.test(part)) inCode++;
      else if (/^<\/code>/i.test(part)) inCode = Math.max(0, inCode - 1);
      return part;
    }
    if (inA || inCode) return part;
    return part.replace(re, (match) => {
      const hit = byCode.get(match);
      if (!hit) return match;
      // Same allowlist as the other two link paths — see wrapLinkedCode.
      if (safeLinkHref(escapeHtml(hit.href)) === null) return match;
      const cls = hit.className ? ` class="${escapeHtml(hit.className)}"` : '';
      return `<a href="${escapeHtml(hit.href)}"${cls}>${match}</a>`;
    });
  }).join('');
}

function renderInline(text: string, options: RenderMarkdownOptions = {}): string {
  let result = escapeHtml(text);
  const tables = options.linkify ?? [];
  const hasTables = tables.some((t) => t.lookup.size > 0);

  // Inline code (must be before bold/italic to avoid conflicts). The shared
  // linkify pass lives here so task-code and symbol tables compose: first
  // table to match wins, then exact / strip-() / last dotted segment.
  result = result.replace(/`([^`]+)`/g, (_, raw: string) => {
    if (hasTables) {
      const hit = lookupLink(raw, tables);
      if (hit) return wrapLinkedCode(raw, hit);
    }
    return `<code>${raw}</code>`;
  });

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (single asterisk, not preceded/followed by space for ambiguity)
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links [text](url). Hash-only hrefs can be prefixed so `#group-retry` on
  // Landing still lands on Changes.
  //
  // This is the path that carries UNTRUSTED text — a comment synced from a PR
  // body, an agent-written report — so a scheme outside the allowlist renders
  // as inert text instead of a clickable `javascript:` link. See safeLinkHref.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    const dest = options.hashLinkBase && href.startsWith('#')
      ? `${options.hashLinkBase}${href}`
      : href;
    const safe = safeLinkHref(dest);
    if (safe === null) return inertLinkHtml(label, href);
    return `<a href="${safe}">${label}</a>`;
  });

  if (hasTables) result = linkifyWords(result, tables);

  return result;
}

// Block-level line classification.
//
// INVARIANT: this is the ONE place a line's block kind is decided. The outer
// render loop and the paragraph-collection lookahead MUST both go through
// `classifyLine` — they used to carry separate, hand-maintained copies of these
// patterns, and the copies drifted: the outer patterns ended in `(.*)$`, which
// (in JS, without /m) rejects a trailing `\r`, while the lookahead's prefix-only
// copies accepted it. A CRLF heading/list line therefore fell through to the
// paragraph branch, which then refused to consume it — `i` never advanced and
// the whole daemon event loop spun forever. One classifier, no drift.
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+\.\s+(.*)$/;
const HR_RE = /^(\-{3,}|\*{3,}|_{3,})$/;

// A table's delimiter row: the second line of a pipe table, e.g. `|---|:--:|`.
// It must contain a pipe, so a bare `---` stays a horizontal rule.
const TABLE_DELIM_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

function isTableDelimiter(line: string | undefined): boolean {
  return line !== undefined && line.includes('|') && TABLE_DELIM_RE.test(line);
}

type LineKind =
  | 'fence' | 'heading' | 'hr' | 'blockquote' | 'ul' | 'ol' | 'blank' | 'table' | 'paragraph';

/**
 * A line's block kind. `next` is the FOLLOWING line, needed only by the table
 * rule: a row of pipes is a table header exactly when a delimiter row follows
 * it, and is ordinary prose otherwise. Every caller must pass it (see the
 * one-classifier invariant above) — omitting it silently demotes tables to
 * paragraphs, which is the bug this argument exists to prevent.
 */
function classifyLine(line: string, next?: string): LineKind {
  // Order matters and mirrors the order the render loop handles blocks in.
  if (line.trimStart().startsWith('```')) return 'fence';
  if (HEADING_RE.test(line)) return 'heading';
  if (HR_RE.test(line.trim())) return 'hr';
  if (line.startsWith('> ')) return 'blockquote';
  if (UL_RE.test(line)) return 'ul';
  if (OL_RE.test(line)) return 'ol';
  if (line.trim() === '') return 'blank';
  if (line.includes('|') && isTableDelimiter(next)) return 'table';
  return 'paragraph';
}

/** Cells of one pipe-table row, outer pipes stripped and each cell trimmed. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

/** Per-column alignment from the delimiter row: `:--`, `--:`, `:--:`. */
function tableAlignments(delimiter: string): ('left' | 'center' | 'right' | null)[] {
  return splitTableRow(delimiter).map(spec => {
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * Optional line marking: stamp a class on the element a given source line
 * produced.
 *
 * This is how a caller that knows something about individual LINES (the review
 * diff knows which ones the patch added) says so without re-implementing the
 * block structure. Rendering is unaffected otherwise — the marks are an extra
 * attribute on elements this renderer was going to emit anyway, so the document
 * still renders as one document: a list stays one `<ul>`, a table one `<table>`.
 *
 * Marking is per BLOCK ELEMENT, which is as fine as this renderer's own
 * resolution goes: a marked line inside a paragraph marks the paragraph, a
 * marked row marks that `<tr>`, a marked item marks that `<li>`.
 */
export interface RenderMarkdownOptions {
  /** 1-based source line number of the first line of `markdown`. Default 1. */
  firstLine?: number;
  /** Source line numbers whose element gets `markClass`. */
  markLines?: ReadonlySet<number>;
  /** Class to stamp. Marking is off unless this and a non-empty set are given. */
  markClass?: string;
  /**
   * Lookup tables for the shared linkify pass (symbols, task codes). Absent or
   * empty leaves the render byte-identical to no options — same invariant as
   * marking.
   */
  linkify?: readonly MarkdownLinkifyTable[];
  /**
   * Prefix hash-only markdown links (`[the retry path](#group-retry)`) so they
   * still land when this prose is not on the Changes tab.
   */
  hashLinkBase?: string;
}

export function renderMarkdown(markdown: string, options: RenderMarkdownOptions = {}): string {
  // Normalize line endings first: a CRLF (or classic-Mac CR) document must
  // render identically to its LF twin. Everything below assumes no stray \r.
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let i = 0;

  const { firstLine = 1, markLines, markClass } = options;
  const marking = markClass !== undefined && markLines !== undefined && markLines.size > 0;
  /**
   * ` class="…"` when any source line in the 0-based index range [from, to] is
   * marked, and '' otherwise — so an unmarked render is byte-identical to one
   * with no options at all.
   */
  const markAttrs = (from: number, to: number = from): string => {
    if (!marking) return '';
    // An unterminated fence leaves the cursor one line past the end (the skip
    // over a closing ``` that was never there), so clamp: a mark must never be
    // decided by a line this render did not consume.
    const last = Math.min(to, lines.length - 1);
    for (let n = from; n <= last; n++) {
      if (markLines!.has(firstLine + n)) return ` class="${escapeHtml(markClass!)}"`;
    }
    return '';
  };

  // List nesting stack. Each entry is one open <ul>/<ol>; deeper indent
  // pushes, shallower indent pops. Two-space indent steps are the typical
  // markdown convention (and what our prompts ask the model to produce).
  const listStack: Array<{ indent: number; type: 'ul' | 'ol' }> = [];

  function closeList(): void {
    while (listStack.length > 0) {
      const top = listStack.pop()!;
      output.push(top.type === 'ul' ? '</ul>' : '</ol>');
    }
  }

  function openListLevel(indent: number, type: 'ul' | 'ol'): void {
    output.push(type === 'ul' ? '<ul>' : '<ol>');
    listStack.push({ indent, type });
  }

  function adjustListsTo(indent: number, type: 'ul' | 'ol'): void {
    // Pop any deeper levels — we've outdented.
    while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
      const top = listStack.pop()!;
      output.push(top.type === 'ul' ? '</ul>' : '</ol>');
    }
    const top = listStack[listStack.length - 1];
    if (!top) {
      openListLevel(indent, type);
      return;
    }
    if (top.indent === indent) {
      // Same level — if the type differs, swap by closing+reopening.
      if (top.type !== type) {
        output.push(top.type === 'ul' ? '</ul>' : '</ol>');
        listStack.pop();
        openListLevel(indent, type);
      }
      return;
    }
    // top.indent < indent → deeper nesting, open a new level.
    openListLevel(indent, type);
  }

  while (i < lines.length) {
    const line = lines[i];
    const kind = classifyLine(line, lines[i + 1]);

    // Fenced code blocks
    if (kind === 'fence') {
      closeList();
      const fenceStart = i;
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && classifyLine(lines[i], lines[i + 1]) !== 'fence') {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      // Mermaid goes through the shared wrapper so markdown views and diffs
      // share one enhancer, one toggle, and one asset route.
      if (/^mermaid\b/i.test(lang)) {
        // The wrapper's own markup is the mermaid contract, so a mark goes on a
        // plain wrapper around it rather than into it.
        const mermaidMarkAttrs = markAttrs(fenceStart, i - 1);
        const wrapped = wrapMermaidFence(codeLines.join('\n'));
        output.push(mermaidMarkAttrs ? `<div${mermaidMarkAttrs}>${wrapped}</div>` : wrapped);
        continue;
      }
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      output.push(
        `<pre${markAttrs(fenceStart, i - 1)}><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // Headings
    if (kind === 'heading') {
      const headingMatch = line.match(HEADING_RE)!;
      closeList();
      const level = headingMatch[1].length;
      output.push(`<h${level}${markAttrs(i)}>${renderInline(headingMatch[2], options)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (kind === 'hr') {
      closeList();
      output.push(`<hr${markAttrs(i)}>`);
      i++;
      continue;
    }

    // Blockquote
    if (kind === 'blockquote') {
      closeList();
      const quoteStart = i;
      const quoteLines: string[] = [];
      while (i < lines.length && classifyLine(lines[i], lines[i + 1]) === 'blockquote') {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      // Marked as a whole: the recursive render has its own line numbering, and
      // a quote is small enough that the quote is the honest unit.
      // Pass linkify through so a quoted task code still becomes a link.
      // Marking is per-quote-block above; the recursive render has its own lines.
      output.push(
        `<blockquote${markAttrs(quoteStart, i - 1)}>${renderMarkdown(quoteLines.join('\n'), {
          linkify: options.linkify,
          hashLinkBase: options.hashLinkBase,
        })}</blockquote>`,
      );
      continue;
    }

    // Unordered list (indent-aware nesting via the listStack helper)
    if (kind === 'ul') {
      const ulMatch = line.match(UL_RE)!;
      const indent = ulMatch[1].length;
      adjustListsTo(indent, 'ul');
      output.push(`<li${markAttrs(i)}>${renderInline(ulMatch[2], options)}</li>`);
      i++;
      continue;
    }

    // Ordered list (same nesting story as unordered)
    if (kind === 'ol') {
      const olMatch = line.match(OL_RE)!;
      const indent = olMatch[1].length;
      adjustListsTo(indent, 'ol');
      output.push(`<li${markAttrs(i)}>${renderInline(olMatch[2], options)}</li>`);
      i++;
      continue;
    }

    // Pipe table: header row, delimiter row, then body rows until a blank line
    // or a line that is no longer part of the table. Agents write these all the
    // time (a `| Check | Result |` verification table); without this branch the
    // whole table fell through to the paragraph rule and the reader got literal
    // pipes in a <p>.
    if (kind === 'table') {
      closeList();
      const tableStart = i;
      const aligns = tableAlignments(lines[i + 1]);
      const header = splitTableRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].includes('|') &&
        !lines[i].trimStart().startsWith('```')
      ) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const attr = (col: number) =>
        aligns[col] ? ` style="text-align: ${aligns[col]}"` : '';
      // Rows are padded/clipped to the header's column count so a ragged table
      // still produces well-formed HTML.
      const cellsHtml = (row: string[], tag: 'th' | 'td') =>
        header
          .map((_, c) => `<${tag}${attr(c)}>${renderInline(row[c] ?? '', options)}</${tag}>`)
          .join('');
      // Row-level marking: a changed cell marks its row, not the whole table.
      // The header row stands in for the delimiter row too — nothing else can.
      const headHtml = `<thead><tr${markAttrs(tableStart, tableStart + 1)}>${cellsHtml(header, 'th')}</tr></thead>`;
      const bodyHtml = bodyRows.length
        ? `<tbody>${bodyRows
            .map((r, n) => `<tr${markAttrs(tableStart + 2 + n)}>${cellsHtml(r, 'td')}</tr>`)
            .join('')}</tbody>`
        : '';
      output.push(`<table class="md-table">${headHtml}${bodyHtml}</table>`);
      continue;
    }

    // Empty line
    if (kind === 'blank') {
      closeList();
      i++;
      continue;
    }

    // Paragraph - collect consecutive non-empty lines
    closeList();
    const paraStart = i;
    const paraLines: string[] = [];
    while (i < lines.length && classifyLine(lines[i], lines[i + 1]) === 'paragraph') {
      paraLines.push(lines[i]);
      i++;
    }
    // INVARIANT: the outer loop must advance on every iteration. `kind` is
    // 'paragraph' here, so the collection loop consumes at least this line —
    // but consume it unconditionally anyway, so no future classifier change can
    // reintroduce a zero-progress iteration (an infinite loop that freezes the
    // daemon's whole event loop, not just the request rendering it).
    if (paraLines.length === 0) {
      paraLines.push(lines[i]);
      i++;
    }
    output.push(`<p${markAttrs(paraStart, i - 1)}>${renderInline(paraLines.join('\n'), options)}</p>`);
  }

  closeList();
  return output.join('\n');
}
