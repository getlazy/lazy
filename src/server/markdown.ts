/**
 * Lightweight Markdown to HTML renderer
 *
 * Handles the common Markdown constructs found in lazy turns:
 * - Headings (#, ##, ###, etc.)
 * - Code blocks (``` with language)
 * - Inline code (`code`)
 * - Bold (**text**) and italic (*text*)
 * - Links [text](url)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - Paragraphs
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  let result = escapeHtml(text);

  // Inline code (must be before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (single asterisk, not preceded/followed by space for ambiguity)
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

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

type LineKind = 'fence' | 'heading' | 'hr' | 'blockquote' | 'ul' | 'ol' | 'blank' | 'paragraph';

function classifyLine(line: string): LineKind {
  // Order matters and mirrors the order the render loop handles blocks in.
  if (line.trimStart().startsWith('```')) return 'fence';
  if (HEADING_RE.test(line)) return 'heading';
  if (HR_RE.test(line.trim())) return 'hr';
  if (line.startsWith('> ')) return 'blockquote';
  if (UL_RE.test(line)) return 'ul';
  if (OL_RE.test(line)) return 'ol';
  if (line.trim() === '') return 'blank';
  return 'paragraph';
}

export function renderMarkdown(markdown: string): string {
  // Normalize line endings first: a CRLF (or classic-Mac CR) document must
  // render identically to its LF twin. Everything below assumes no stray \r.
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let i = 0;

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
    const kind = classifyLine(line);

    // Fenced code blocks
    if (kind === 'fence') {
      closeList();
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && classifyLine(lines[i]) !== 'fence') {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      output.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings
    if (kind === 'heading') {
      const headingMatch = line.match(HEADING_RE)!;
      closeList();
      const level = headingMatch[1].length;
      output.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (kind === 'hr') {
      closeList();
      output.push('<hr>');
      i++;
      continue;
    }

    // Blockquote
    if (kind === 'blockquote') {
      closeList();
      const quoteLines: string[] = [];
      while (i < lines.length && classifyLine(lines[i]) === 'blockquote') {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      output.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list (indent-aware nesting via the listStack helper)
    if (kind === 'ul') {
      const ulMatch = line.match(UL_RE)!;
      const indent = ulMatch[1].length;
      adjustListsTo(indent, 'ul');
      output.push(`<li>${renderInline(ulMatch[2])}</li>`);
      i++;
      continue;
    }

    // Ordered list (same nesting story as unordered)
    if (kind === 'ol') {
      const olMatch = line.match(OL_RE)!;
      const indent = olMatch[1].length;
      adjustListsTo(indent, 'ol');
      output.push(`<li>${renderInline(olMatch[2])}</li>`);
      i++;
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
    const paraLines: string[] = [];
    while (i < lines.length && classifyLine(lines[i]) === 'paragraph') {
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
    output.push(`<p>${renderInline(paraLines.join('\n'))}</p>`);
  }

  closeList();
  return output.join('\n');
}
