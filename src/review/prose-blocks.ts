/**
 * The report's prose blocks with their anchors, as the daemon's dashboard
 * anchors them — for a client that renders the report itself (Lazy Teams).
 *
 * The dashboard's review island splits each `data-rv-prose` container into
 * leaf blocks (PROSE_BLOCK_SEL in src/server/review.ts) and hashes each
 * block's `textContent` with {@link proseAnchorLine}. This module does the same
 * over the same server-rendered HTML, so a client is handed the anchor rather
 * than a copy of the hash: it matches its own rendered block to one of these by
 * text, and a block it cannot match simply gets no comment affordance.
 */

import type { TurnReport } from '../types';
import { renderMarkdown } from '../server/markdown';
import { PROSE_ANCHOR_SIDE, PROSE_REPORT_FILE, proseAnchorLine } from './prose-anchor';

/** The prose block tags — the review island builds its PROSE_BLOCK_SEL from this list. */
export const PROSE_BLOCK_TAGS: readonly string[] = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'figcaption'];
const BLOCK_TAGS = new Set(PROSE_BLOCK_TAGS);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Section kind under which the dashboard anchors a screenshot caption. */
export const SCREENSHOTS_PROSE_KIND = 'screenshots';

export interface ProseBlock {
  file: string;
  side: typeof PROSE_ANCHOR_SIDE;
  line: number;
  /** Section kind; '' for walkthrough prose, `screenshots` for captions. */
  kind: string;
  /** The block's text with whitespace runs collapsed — the match key. */
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/**
 * `textContent` of every leaf block in daemon-rendered HTML, in document
 * order — a leaf being a block that holds no other block, exactly the island's
 * rule. Works on the renderer's own well-formed output, not arbitrary HTML.
 * A container with no block at all is one block itself, as on the island.
 */
export function proseLeafTexts(html: string): string[] {
  type Frame = { tag: string; block: boolean; text: string; hasBlock: boolean };
  const stack: Frame[] = [];
  const leaves: string[] = [];
  let all = '';
  const addText = (raw: string) => {
    const t = decodeEntities(raw);
    all += t;
    for (const f of stack) if (f.block) f.text += t;
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    addText(html.slice(last, m.index));
    last = re.lastIndex;
    if (!m[2]) continue; // comment
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at < 0) continue;
      for (const f of stack.splice(at)) {
        if (f.block && !f.hasBlock) leaves.push(f.text);
      }
      continue;
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(m[3] ?? '')) continue;
    const block = BLOCK_TAGS.has(tag);
    if (block) for (const f of stack) if (f.block) f.hasBlock = true;
    stack.push({ tag, block, text: '', hasBlock: false });
  }
  addText(html.slice(last));
  for (const f of stack) if (f.block && !f.hasBlock) leaves.push(f.text);
  const texts = leaves.map((t) => t.trim()).filter((t) => t !== '');
  if (texts.length === 0 && all.trim() !== '') return [all.trim()];
  return texts;
}

function blocksOf(kind: string, html: string): ProseBlock[] {
  return proseLeafTexts(html).map((text) => ({
    file: PROSE_REPORT_FILE,
    side: PROSE_ANCHOR_SIDE,
    line: proseAnchorLine(kind, text),
    kind,
    text: text.replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * Every anchored prose block of one report: each section (keyed by its kind,
 * as the report card keys it — verification sections included, so a client
 * can tell a conversation on one apart from a lost one), each screenshot
 * caption, and the walkthrough's group summaries and prose items (no kind).
 */
export function reportProseBlocks(report: TurnReport | null): ProseBlock[] {
  if (!report) return [];
  const out: ProseBlock[] = [];
  for (const s of report.sections ?? []) {
    if (!s.body || !s.body.trim()) continue;
    out.push(...blocksOf(s.kind, renderMarkdown(s.body)));
  }
  const pres = report.presentation;
  for (const shot of pres?.screenshots ?? []) {
    // The figcaption screenshotsCardHtml renders: the caption, then the
    // artifact name when a caption was given.
    const text = shot.caption ? `${shot.caption} ${shot.artifact}` : shot.artifact;
    out.push(...blocksOf(SCREENSHOTS_PROSE_KIND, `<figcaption>${escapeText(text)}</figcaption>`));
  }
  for (const group of pres?.groups ?? []) {
    if (group.summary) out.push(...blocksOf('', renderMarkdown(group.summary)));
    for (const item of group.items ?? []) {
      if (item.kind === 'prose' && item.body) out.push(...blocksOf('', renderMarkdown(item.body)));
    }
  }
  return out;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
