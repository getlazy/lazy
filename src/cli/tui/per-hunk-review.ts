/**
 * `lazy review -i <task>` — interactive per-hunk review loop.
 *
 * Walks the task's diff hunk-by-hunk. For each hunk the reviewer can:
 *   o  okay, advance
 *   n  next
 *   p  previous
 *   s  split this hunk at a context line
 *   a  ask the agent a question (resumes the agent's real claude session in
 *      plan mode — Q&A only, no writes)
 *   f  leave feedback (persisted immediately as a comment on the task)
 *   q  quit (prompts to submit feedback as unblock if any comments were made)
 */

import * as readline from 'readline';
import { existsSync } from 'fs';
import type { Storage } from '../../storage/interface';
import type { Task, Session } from '../../types';
import { getActor } from '../../constants';
import { queryDiff, queryUnblockTask, queryAskTask } from '../../daemon/rpc-fallback';
import { getWorktreePath } from '../helpers';
import { getBranchName } from '../helpers';
import { ansi } from '../../utils/ansi';
import { RpcError } from '../../daemon/rpc-handlers';
import { recoverMissingWorktreeWithFetch, branchExists } from '../../git/operations';
import { loadConfig } from '../../config/loader';
import { hunkHash } from '../../utils/hunk-hash';
import reviewQaPromptTemplate from '../../prompts/review-qa.md' with { type: 'text' };
import { loadTaskProtectionStatus, protectionHeadline } from '../../protection/status';
import { logger } from '../../utils/logger';

/**
 * The one-line protection headline for the per-hunk review header, or null when
 * there is no gate (or it cannot be resolved — a review must never fail over an
 * advisory line).
 */
async function protectionHeadlineForTask(
  storage: Storage,
  root: string,
  task: Task,
): Promise<string | null> {
  try {
    const config = await loadConfig(root);
    return protectionHeadline(await loadTaskProtectionStatus(storage, config, root, task));
  } catch (err) {
    logger.debug(`Interactive review: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Hunk parsing ────────────────────────────────────────────────────────

export interface Hunk {
  /** 'code' → real git hunk; 'summary' → paragraph from agent's last response. */
  kind: 'code' | 'summary';
  /** File path (code hunks) or 'agent-response' (summary hunks). */
  file: string;
  /** Line range (code) or 'paraN' (summary). */
  lines: string;
  /** Unified diff text (code) or raw paragraph text (summary). */
  diff: string;
  /** Display variant — full diff-with-header for code, raw prose for summary. */
  display: string;
}

export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = diffText.split('\n');
  let i = 0;
  let currentFile = '(unknown)';

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      // Prefer the "+++ b/<path>" line when we see it, fall back to git header
      const m = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      currentFile = m?.[2] ?? '(unknown)';
      i++;
      // Consume file-level headers up to first hunk or next file
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        if (lines[i].startsWith('+++ b/')) {
          currentFile = lines[i].slice('+++ b/'.length);
        }
        i++;
      }
      continue;
    }

    if (line.startsWith('@@')) {
      const header = line;
      const m = header.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      const newStart = m ? parseInt(m[1], 10) : 1;
      const newCount = m && m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const rangeEnd = newCount > 0 ? newStart + newCount - 1 : newStart;
      const range = newCount <= 1 ? String(newStart) : `${newStart}-${rangeEnd}`;

      const bodyLines: string[] = [header];
      i++;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        bodyLines.push(lines[i]);
        i++;
      }
      const diff = bodyLines.join('\n');
      const display = `--- a/${currentFile}\n+++ b/${currentFile}\n${diff}`;
      hunks.push({ kind: 'code', file: currentFile, lines: range, diff, display });
      continue;
    }

    i++;
  }

  return hunks;
}

// ── Raw-mode key input ──────────────────────────────────────────────────

export interface Key {
  name: string;       // readline name: 'up','down','left','right','backspace','delete','return','escape','home','end','tab', or char
  ctrl: boolean;
  meta: boolean;      // option/alt
  shift: boolean;
  sequence: string;   // raw sequence
}

export interface RawSession {
  onKey: (h: (k: Key) => void) => void;
  close: () => void;
}

// Bracketed paste mode (DEC private mode 2004). When enabled, terminals wrap
// pasted content in ESC [ 200 ~ ... ESC [ 201 ~ markers so we can distinguish
// pasted Enter (literal newline) from typed Enter (submit).
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

function openRawKeys(): RawSession {
  const wasRaw = process.stdin.isRaw ?? false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write(BRACKETED_PASTE_ON);
  }
  readline.emitKeypressEvents(process.stdin);
  process.stdin.resume();

  let handler: ((k: Key) => void) | null = null;
  const onKeypress = (_ch: string, key: readline.Key | undefined) => {
    if (!key) return;
    handler?.({
      name: key.name ?? '',
      ctrl: key.ctrl ?? false,
      meta: (key as { meta?: boolean }).meta ?? false,
      shift: key.shift ?? false,
      sequence: key.sequence ?? '',
    });
  };
  process.stdin.on('keypress', onKeypress);

  return {
    onKey(h) { handler = h; },
    close() {
      process.stdin.off('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdout.write(BRACKETED_PASTE_OFF);
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.pause();
    },
  };
}

async function readSingleKey(raw: RawSession): Promise<Key> {
  return new Promise(resolve => {
    const h = (k: Key) => {
      raw.onKey(() => {}); // detach
      resolve(k);
    };
    raw.onKey(h);
  });
}

// ── Multi-line input ────────────────────────────────────────────────────

/**
 * Prompt the reviewer for multi-line text.
 *
 * - Arrow keys move the cursor. Ctrl+Arrow / Option+Arrow jump by word.
 * - Home/End jump to start/end of the current line.
 * - Backspace / Delete work across line boundaries.
 *   Option+Backspace deletes the previous word. Option+Delete deletes the next.
 * - Plain Enter submits. Option+Enter (meta+return) inserts a literal newline.
 *   Also accepts `\\` at end-of-line + Enter as a backslash-continuation fallback
 *   for terminals that don't send meta on option+Enter.
 * - Esc cancels (returns null).
 * - Ctrl+C aborts the whole review (re-throws).
 *
 * Rendered inline so the conversation stays in scrollback. Long logical rows
 * wrap in the terminal naturally; between redraws we navigate with *relative*
 * cursor motions keyed off the cursor's visual row offset from the previous
 * redraw. Absolute save/restore (`ESC 7` / `ESC 8`) is avoided because it
 * drifts when the terminal scrolls during editing — the saved row stays at
 * an absolute screen position while the editor content slides up, leaving
 * ghost copies above the redrawn area.
 *
 * Returns the submitted text (may be multi-line) or null if cancelled.
 */
export async function promptMultiLine(raw: RawSession, label: string): Promise<string | null> {
  const out = process.stdout;
  out.write(`${ansi.dim}${label}${ansi.reset} ${ansi.dim}(Enter=submit, Opt+Enter=newline, Opt+Backspace=word, Esc=cancel)${ansi.reset}\n`);

  // Editor state: rows of chars, and a cursor as (row, col).
  const rows: string[] = [''];
  let r = 0;
  let c = 0;

  // Visual row offset (0-based) where we left the cursor after the previous
  // redraw, measured from the top of the drawn editor area. Used to move
  // back up to the top before the next redraw. Starts at 0: nothing drawn yet.
  let lastTargetRow = 0;

  const MARKER_WIDTH = 2;

  const termWidth = (): number => {
    const w = process.stdout.columns ?? 80;
    return Math.max(20, w);
  };

  // Number of terminal rows a logical row consumes when rendered with the
  // leading marker at `w` columns. An empty row still occupies one row.
  const rowsFor = (L: number, w: number): number =>
    Math.max(1, Math.ceil((L + MARKER_WIDTH) / w));

  const totalRows = (w: number): number =>
    rows.reduce((sum, row) => sum + rowsFor(row.length, w), 0);

  // Visual (terminal row offset from editor top, col) for a logical (row,col).
  const visualAt = (row: number, col: number, w: number): { row: number; col: number } => {
    let vrow = 0;
    for (let k = 0; k < row; k++) vrow += rowsFor(rows[k].length, w);
    const off = MARKER_WIDTH + col;
    vrow += Math.floor(off / w);
    const vcol = off % w;
    return { row: vrow, col: vcol };
  };

  const redraw = () => {
    const w = termWidth();

    // Move up to the top of the previously-drawn block, then clear from there
    // to the end of the screen. Everything written from the last redraw goes
    // away, including any wrap-induced extra rows.
    if (lastTargetRow > 0) out.write(`\x1b[${lastTargetRow}A`);
    out.write('\r');
    out.write('\x1b[J');

    for (let k = 0; k < rows.length; k++) {
      const markerColor = k === 0 ? ansi.fg.cyan : ansi.dim;
      const markerText = k === 0 ? '> ' : '. ';
      out.write(`${markerColor}${markerText}${ansi.reset}${rows[k]}`);
      if (k < rows.length - 1) out.write('\n');
    }

    // Cursor now at the end of the last written char (possibly autowrap-
    // pending). `\r` normalises to col 0 of the same visual row, so we can
    // navigate relatively from a known position: (endRow, 0).
    out.write('\r');
    const endRow = totalRows(w) - 1;
    const v = visualAt(r, c, w);
    const up = endRow - v.row;
    if (up > 0) out.write(`\x1b[${up}A`);
    if (v.col > 0) out.write(`\x1b[${v.col + 1}G`);
    lastTargetRow = v.row;
  };

  const finish = (cancelled: boolean): string | null => {
    const w = termWidth();
    const last = rows.length - 1;
    const end = visualAt(last, rows[last].length, w);
    // Navigate from (lastTargetRow, lastTargetCol) to end, then drop a newline
    // so subsequent output starts fresh below the editor.
    out.write('\r');
    const delta = end.row - lastTargetRow;
    if (delta > 0) out.write(`\x1b[${delta}B`);
    else if (delta < 0) out.write(`\x1b[${-delta}A`);
    if (end.col > 0) out.write(`\x1b[${end.col + 1}G`);
    out.write('\n');
    if (cancelled) return null;
    return rows.join('\n');
  };

  // Word-boundary helpers. Words are alphanumeric/underscore runs (readline
  // / emacs convention). Punctuation and whitespace both count as separators,
  // so word nav stops between "foo" and "bar" in `foo-bar`. Matches what the
  // user's terminal sends as Meta-b / Meta-f (Esc+b / Esc+f on macOS).
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);

  const wordLeft = (): { row: number; col: number } => {
    let row = r, col = c;
    if (col === 0 && row > 0) {
      row--;
      col = rows[row].length;
    }
    // Skip separators going left, then skip word chars — lands at start of word.
    while (col > 0 && !isWord(rows[row][col - 1])) col--;
    while (col > 0 && isWord(rows[row][col - 1])) col--;
    return { row, col };
  };
  const wordRight = (): { row: number; col: number } => {
    let row = r, col = c;
    if (col === rows[row].length && row < rows.length - 1) {
      row++;
      col = 0;
    }
    // Skip separators going right, then skip word chars — lands at end of word.
    const line = () => rows[row];
    while (col < line().length && !isWord(line()[col])) col++;
    while (col < line().length && isWord(line()[col])) col++;
    return { row, col };
  };

  /**
   * Inverse of `visualAt`: given a target visual (row, col) relative to the
   * top of the editor area, find the logical (row, col) that lands the cursor
   * at — or as close as possible to — that visual position. Used by up/down
   * to navigate by *visual* row, so a long wrapped logical line can be
   * walked sub-row by sub-row.
   */
  const logicalAtVisual = (targetVRow: number, targetVCol: number, w: number): { row: number; col: number } => {
    if (targetVRow < 0) return { row: 0, col: 0 };
    let acc = 0;
    for (let k = 0; k < rows.length; k++) {
      const rc = rowsFor(rows[k].length, w);
      if (targetVRow < acc + rc) {
        const subRow = targetVRow - acc;
        const col = subRow === 0
          ? Math.max(0, targetVCol - MARKER_WIDTH)
          : (w - MARKER_WIDTH) + (subRow - 1) * w + targetVCol;
        return { row: k, col: Math.min(col, rows[k].length) };
      }
      acc += rc;
    }
    const last = rows.length - 1;
    return { row: last, col: rows[last].length };
  };

  // Bracketed-paste state. While true, every keypress (including Enter) is
  // treated as literal content. The terminal frames pastes with ESC[200~ ...
  // ESC[201~; without this flag readline would decode embedded \r as a
  // 'return' keypress and submit after the first pasted line.
  let pasting = false;
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  // Insert literal text at the cursor, splitting embedded CR/LF into row
  // breaks. Does not redraw — caller decides when.
  const insertText = (text: string): void => {
    if (!text) return;
    const parts = text.split(/\r\n|\r|\n/);
    for (let k2 = 0; k2 < parts.length; k2++) {
      const piece = parts[k2];
      rows[r] = rows[r].slice(0, c) + piece + rows[r].slice(c);
      c += piece.length;
      if (k2 < parts.length - 1) {
        const rest = rows[r].slice(c);
        rows[r] = rows[r].slice(0, c);
        rows.splice(r + 1, 0, rest);
        r++;
        c = 0;
      }
    }
  };

  redraw();

  return new Promise((resolve, reject) => {
    const handler = (k: Key) => {
      try {
        // Ctrl+C is the safety hatch — fires even mid-paste.
        if (k.ctrl && k.name === 'c') {
          raw.onKey(() => {});
          finish(true);
          reject(new Error('cancelled'));
          return;
        }

        // Bracketed-paste markers. Some terminals deliver the start marker,
        // content, and end marker as separate keypress events; others bundle
        // the whole paste into one event with markers embedded in `sequence`.
        // Handle both shapes here — before any other key dispatch — so the
        // markers never reach the normal handlers and embedded \r never
        // trips the submit path below.
        const seq = k.sequence ?? '';
        const startIdx = seq.indexOf(PASTE_START);
        const endIdx = seq.indexOf(PASTE_END);
        if (startIdx >= 0 && endIdx > startIdx) {
          insertText(seq.slice(0, startIdx));
          insertText(seq.slice(startIdx + PASTE_START.length, endIdx));
          const tail = seq.slice(endIdx + PASTE_END.length);
          // A bare trailing CR/LF after the end marker is almost certainly a
          // typed Enter the terminal flushed in the same event — honour it as
          // submit. Anything else falls through as literal post-paste content.
          if (tail === '\r' || tail === '\n' || tail === '\r\n') {
            raw.onKey(() => {});
            resolve(finish(false));
            return;
          }
          insertText(tail);
          redraw();
          return;
        }
        if (startIdx >= 0) {
          insertText(seq.slice(0, startIdx));
          insertText(seq.slice(startIdx + PASTE_START.length));
          pasting = true;
          redraw();
          return;
        }
        if (endIdx >= 0) {
          insertText(seq.slice(0, endIdx));
          pasting = false;
          insertText(seq.slice(endIdx + PASTE_END.length));
          redraw();
          return;
        }
        if (pasting) {
          // Inside a paste, every key is content. Enter becomes a literal
          // newline; ESC bytes are content too (so ESC[201~ inside a paste
          // can't be canceled by an Esc keypress).
          if (k.name === 'return' || k.name === 'enter') {
            const rest = rows[r].slice(c);
            rows[r] = rows[r].slice(0, c);
            rows.splice(r + 1, 0, rest);
            r++;
            c = 0;
          } else if (seq) {
            insertText(seq);
          }
          // Defer redraw until the end marker arrives — large pastes redraw
          // once instead of once per character.
          return;
        }

        if (k.name === 'escape') {
          raw.onKey(() => {});
          resolve(finish(true));
          return;
        }
        if (k.name === 'return' || k.name === 'enter') {
          // Option+Return (meta) → newline. Plain Return → submit, unless the
          // line ends with a single trailing backslash (continuation fallback).
          if (k.meta) {
            const rest = rows[r].slice(c);
            rows[r] = rows[r].slice(0, c);
            rows.splice(r + 1, 0, rest);
            r++;
            c = 0;
            redraw();
            return;
          }
          if (rows[r].endsWith('\\') && c === rows[r].length) {
            // Backslash-continuation: strip the backslash and insert newline
            rows[r] = rows[r].slice(0, -1);
            rows.splice(r + 1, 0, '');
            r++;
            c = 0;
            redraw();
            return;
          }
          raw.onKey(() => {});
          resolve(finish(false));
          return;
        }
        if (k.name === 'backspace') {
          if (k.meta || k.ctrl) {
            // Word-delete-left (Opt+Backspace or Ctrl+Backspace)
            const target = wordLeft();
            if (target.row === r) {
              rows[r] = rows[r].slice(0, target.col) + rows[r].slice(c);
              c = target.col;
            } else {
              // Span row boundary: delete to end of prev row then merge
              const prev = rows[target.row];
              const curr = rows[r];
              rows.splice(r, 1);
              r = target.row;
              rows[r] = prev.slice(0, target.col) + curr.slice(c);
              c = target.col;
            }
          } else if (c > 0) {
            rows[r] = rows[r].slice(0, c - 1) + rows[r].slice(c);
            c--;
          } else if (r > 0) {
            const prev = rows[r - 1];
            const curr = rows[r];
            rows.splice(r, 1);
            r--;
            c = prev.length;
            rows[r] = prev + curr;
          }
          redraw();
          return;
        }
        if (k.name === 'delete') {
          if (k.meta || k.ctrl) {
            // Word-delete-right (Opt+Delete or Ctrl+Delete)
            const target = wordRight();
            if (target.row === r) {
              rows[r] = rows[r].slice(0, c) + rows[r].slice(target.col);
            } else {
              rows[r] = rows[r].slice(0, c) + rows[r + 1].slice(target.col);
              rows.splice(r + 1, 1);
            }
          } else if (c < rows[r].length) {
            rows[r] = rows[r].slice(0, c) + rows[r].slice(c + 1);
          } else if (r < rows.length - 1) {
            rows[r] = rows[r] + rows[r + 1];
            rows.splice(r + 1, 1);
          }
          redraw();
          return;
        }
        // Meta-b / Meta-f (Esc+b / Esc+f) — Opt+Left / Opt+Right on macOS
        // Terminal and iTerm2 Natural Text Editing. readline delivers these
        // as {name:'b'|'f', meta:true, sequence:'\x1bb'|'\x1bf'}.
        if (k.meta && !k.ctrl && (k.name === 'b' || k.name === 'f')) {
          const t = k.name === 'b' ? wordLeft() : wordRight();
          r = t.row;
          c = t.col;
          redraw();
          return;
        }
        // Meta-d — word-delete-right on macOS (Esc+d). Complements Opt+Backspace.
        if (k.meta && !k.ctrl && k.name === 'd') {
          const target = wordRight();
          if (target.row === r) {
            rows[r] = rows[r].slice(0, c) + rows[r].slice(target.col);
          } else {
            rows[r] = rows[r].slice(0, c) + rows[r + 1].slice(target.col);
            rows.splice(r + 1, 1);
          }
          redraw();
          return;
        }
        if (k.name === 'left') {
          if (k.ctrl || k.meta) {
            const t = wordLeft();
            r = t.row;
            c = t.col;
          } else {
            if (c > 0) c--;
            else if (r > 0) { r--; c = rows[r].length; }
          }
          redraw();
          return;
        }
        if (k.name === 'right') {
          if (k.ctrl || k.meta) {
            const t = wordRight();
            r = t.row;
            c = t.col;
          } else {
            if (c < rows[r].length) c++;
            else if (r < rows.length - 1) { r++; c = 0; }
          }
          redraw();
          return;
        }
        // Visual up/down — walk by terminal rows, so long wrapped lines can
        // be navigated sub-row by sub-row. If a logical line occupies 3
        // visual rows, up/down moves within those rows first.
        if (k.name === 'up') {
          const w = termWidth();
          const v = visualAt(r, c, w);
          if (v.row === 0) {
            if (r !== 0 || c !== 0) { r = 0; c = 0; redraw(); }
          } else {
            const t = logicalAtVisual(v.row - 1, v.col, w);
            r = t.row;
            c = t.col;
            redraw();
          }
          return;
        }
        if (k.name === 'down') {
          const w = termWidth();
          const v = visualAt(r, c, w);
          const tot = totalRows(w);
          if (v.row === tot - 1) {
            const last = rows.length - 1;
            if (r !== last || c !== rows[last].length) {
              r = last; c = rows[last].length; redraw();
            }
          } else {
            const t = logicalAtVisual(v.row + 1, v.col, w);
            r = t.row;
            c = t.col;
            redraw();
          }
          return;
        }
        if (k.name === 'home') { c = 0; redraw(); return; }
        if (k.name === 'end')  { c = rows[r].length; redraw(); return; }
        // Ctrl+A / Ctrl+E aliases
        if (k.ctrl && k.name === 'a') { c = 0; redraw(); return; }
        if (k.ctrl && k.name === 'e') { c = rows[r].length; redraw(); return; }
        if (k.ctrl && k.name === 'u') { rows[r] = rows[r].slice(c); c = 0; redraw(); return; }
        if (k.ctrl && k.name === 'k') { rows[r] = rows[r].slice(0, c); redraw(); return; }

        // Insert any printable character (including multi-byte paste chunks).
        // Skip lone control bytes.
        if (seq && !k.ctrl) {
          // Handle pasted chunks that contain newlines
          let text = seq;
          // If meta flag slipped through but this isn't a known key, ignore the ESC prefix byte
          if (text.charCodeAt(0) === 0x1b) return;
          // Guard against other control chars
          if (text.length === 1 && text.charCodeAt(0) < 0x20) return;

          // Split on CR/LF to handle pastes
          const parts = text.split(/\r\n|\r|\n/);
          for (let k2 = 0; k2 < parts.length; k2++) {
            const piece = parts[k2];
            rows[r] = rows[r].slice(0, c) + piece + rows[r].slice(c);
            c += piece.length;
            if (k2 < parts.length - 1) {
              const rest = rows[r].slice(c);
              rows[r] = rows[r].slice(0, c);
              rows.splice(r + 1, 0, rest);
              r++;
              c = 0;
            }
          }
          redraw();
          return;
        }
      } catch (err) {
        raw.onKey(() => {});
        reject(err);
      }
    };
    raw.onKey(handler);
  });
}

// ── y/n prompt (raw) ────────────────────────────────────────────────────

async function promptYN(raw: RawSession, question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/n] `);
  while (true) {
    const k = await readSingleKey(raw);
    if (k.ctrl && k.name === 'c') { process.stdout.write('\n'); throw new Error('cancelled'); }
    if (k.name === 'y' || k.sequence === 'y' || k.sequence === 'Y') {
      process.stdout.write('y\n');
      return true;
    }
    if (k.name === 'n' || k.sequence === 'n' || k.sequence === 'N' || k.name === 'escape') {
      process.stdout.write('n\n');
      return false;
    }
  }
}

// ── Diff rendering ──────────────────────────────────────────────────────

function colorDiff(diff: string, dim: boolean = false): string {
  const out: string[] = [];
  // Per-line dim prefix is safer than a block-level dim wrap — ANSI
  // doesn't reliably nest dim around per-line color codes across
  // terminals.
  const d = dim ? ansi.dim : '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) out.push(`${d}${ansi.fg.cyan}${line}${ansi.reset}`);
    else if (line.startsWith('+')) out.push(`${d}${ansi.fg.green}${line}${ansi.reset}`);
    else if (line.startsWith('-')) out.push(`${d}${ansi.fg.red}${line}${ansi.reset}`);
    else out.push(`${d}${line}${dim ? ansi.reset : ''}`);
  }
  return out.join('\n');
}

/**
 * Per-extension regexes that identify lines which start a new semantic unit
 * (function, class, top-level heading, etc.). Matched against the diff line
 * with its +/- prefix already stripped — so "function foo() {" is the input
 * whether the source line is context, addition, or deletion.
 *
 * Kept intentionally conservative: top-level only, no decorators/JSDoc
 * lookbehind, no indented class methods. If a split lands imperfectly the
 * reviewer can press `s` again and fall through to the soft-boundary split.
 */
const SEMANTIC_BOUNDARY_PATTERNS: Record<string, RegExp> = {
  ts:   /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s/,
  tsx:  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s/,
  js:   /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s/,
  jsx:  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s/,
  mjs:  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s/,
  cjs:  /^(?:module\.exports|exports\.|function|class|const|let|var)\s/,
  py:   /^(?:async\s+def|def|class)\s/,
  go:   /^func\s/,
  rs:   /^(?:pub(?:\(\w+\))?\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|mod)\s/,
  rb:   /^(?:def|class|module)\s/,
  java: /^(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum)\s/,
  kt:   /^(?:public|private|internal|open|abstract|\s)*(?:fun|class|object|interface)\s/,
  swift: /^(?:public|private|internal|fileprivate|open|\s)*(?:func|class|struct|enum|protocol|extension)\s/,
  md:   /^#{1,6}\s/,
  markdown: /^#{1,6}\s/,
  sh:   /^(?:function\s+\w+|\w+\s*\(\s*\)\s*\{)/,
};

function semanticBoundaryPatternFor(file: string): RegExp | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  return SEMANTIC_BOUNDARY_PATTERNS[ext] ?? null;
}

/**
 * Try to split a hunk into two reviewable halves.
 *
 * For code hunks: prefer a *semantic* boundary — a line inside the hunk that
 * starts a new function/class/top-level declaration for the file's language
 * (diff +/- prefix stripped before matching). Fall back to a context-line
 * boundary between two groups of changed lines (the same rule `git add -p`
 * uses for its 's' key) when no semantic boundary exists.
 *
 * For summary hunks: split at the first blank-line run (paragraph boundary),
 * so progressive presses of `s` atomize the agent's narrative on demand.
 *
 * Returns two new hunks if a split point exists, or null if the hunk is
 * already atomic.
 *
 * Exported for tests.
 */
export function splitHunk(h: Hunk): [Hunk, Hunk] | null {
  if (h.kind === 'summary') {
    const text = h.diff;
    const m = text.match(/\n[ \t]*\n+/);
    if (!m || m.index === undefined) return null;
    const firstText = text.slice(0, m.index).trim();
    const secondText = text.slice(m.index + m[0].length).trim();
    if (!firstText || !secondText) return null;
    const mk = (content: string): Hunk => ({
      kind: 'summary',
      file: h.file,
      lines: h.lines,
      diff: content,
      display: content,
    });
    return [mk(firstText), mk(secondText)];
  }
  const lines = h.diff.split('\n');
  if (lines.length < 2) return null;
  const header = lines[0];
  const m = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return null;
  const oldStart = parseInt(m[1], 10);
  const newStart = parseInt(m[3], 10);
  const suffix = m[5] ?? '';
  // Trim trailing empty entries that split('\n') produces for a diff ending
  // with '\n' — they aren't real diff body lines and would otherwise get
  // miscounted as context.
  const body = lines.slice(1);
  while (body.length > 0 && body[body.length - 1] === '') body.pop();

  // Classify each line. We split 'add'/'del' into content vs. blank variants
  // so a blank added/removed line can serve as a "soft" split point — an
  // all-add hunk (new code block) has no context lines, but blank +lines
  // between logical chunks are still natural paragraph breaks.
  type Kind = 'ctx' | 'add' | 'del' | 'blankAdd' | 'blankDel' | 'noeol';
  const kinds: Kind[] = body.map(l => {
    if (l.startsWith(' ')) return 'ctx';
    if (l.startsWith('+')) return l.slice(1).trim() === '' ? 'blankAdd' : 'add';
    if (l.startsWith('-')) return l.slice(1).trim() === '' ? 'blankDel' : 'del';
    if (l.startsWith('\\')) return 'noeol';
    // Empty or unknown line — treat as context to be conservative.
    return 'ctx';
  });

  const isContentChange = (k: Kind) => k === 'add' || k === 'del';
  const isSoftBoundary = (k: Kind) => k === 'ctx' || k === 'blankAdd' || k === 'blankDel';

  let splitAt = -1;

  // First try: semantic boundary for the file's language. The boundary line
  // itself becomes the start of the second half, so e.g. splitting at
  // "function bar() {" puts the new function with whatever follows.
  const semanticPattern = semanticBoundaryPatternFor(h.file);
  const matchesPattern = (line: string | undefined): boolean => {
    if (!line || !semanticPattern) return false;
    const p = line[0];
    if (p !== ' ' && p !== '+' && p !== '-') return false;
    return semanticPattern.test(line.slice(1));
  };
  // Documentation/decorator lines that should stay attached to the declaration
  // they precede. For Markdown the `#` test below would fire on headings, so
  // it's excluded there.
  const isDocOrDecorator = (line: string | undefined): boolean => {
    if (!line) return false;
    const p = line[0];
    if (p !== ' ' && p !== '+' && p !== '-') return false;
    const content = line.slice(1).trimStart();
    if (content === '') return false;
    if (content.startsWith('/**') || content.startsWith('/*')) return true;
    if (content.startsWith('*/') || content.startsWith('*')) return true;
    if (content.startsWith('//') || content.startsWith('///') || content.startsWith('//!')) return true;
    if (content.startsWith('@')) return true; // decorator/annotation (TS/Java/Py/Kotlin)
    const ext = h.file.slice(h.file.lastIndexOf('.') + 1).toLowerCase();
    if ((ext === 'py' || ext === 'rb' || ext === 'sh') && content.startsWith('#')) return true;
    return false;
  };
  if (semanticPattern) {
    for (let i = 1; i < body.length; i++) {
      const line = body[i];
      if (!matchesPattern(line)) continue;
      // Skip the split point between a paired removal and re-addition of the
      // same declaration (`-def foo():` immediately followed by `+def foo():`).
      // That's one modified function, not two boundaries.
      const prev = body[i - 1];
      const isPairedModification =
        prev && prev[0] === '-' && line[0] === '+' && matchesPattern(prev);
      if (isPairedModification) continue;
      // Pull the split point back past any attached doc block so JSDoc /
      // decorators stay with the declaration they document.
      let candidate = i;
      while (candidate > 0 && isDocOrDecorator(body[candidate - 1])) {
        candidate--;
      }
      if (candidate === 0) continue; // nothing left for the first half
      const hasChangeBefore = kinds.slice(0, candidate).some(isContentChange);
      const hasChangeAfter = kinds.slice(candidate).some(isContentChange);
      if (hasChangeBefore && hasChangeAfter) {
        splitAt = candidate;
        break;
      }
    }
  }

  // Fallback: the first soft boundary (context or blank +/- line) between two
  // groups of content changes — the `git add -p` rule.
  if (splitAt < 0) {
    let changesBefore = 0;
    for (let i = 0; i < kinds.length; i++) {
      if (isContentChange(kinds[i])) {
        changesBefore++;
        continue;
      }
      if (isSoftBoundary(kinds[i]) && changesBefore > 0) {
        const hasChangeAfter = kinds.slice(i + 1).some(isContentChange);
        if (hasChangeAfter) {
          splitAt = i + 1;
          break;
        }
      }
    }
  }
  if (splitAt < 0) return null;

  const firstBody = body.slice(0, splitAt);
  const secondBody = body.slice(splitAt);
  const firstKinds = kinds.slice(0, splitAt);

  // Recount line counts for each half. The old file contains ctx + del +
  // blankDel lines; the new file contains ctx + add + blankAdd lines.
  const countOld = (ks: Kind[]) =>
    ks.filter(k => k === 'ctx' || k === 'del' || k === 'blankDel').length;
  const countNew = (ks: Kind[]) =>
    ks.filter(k => k === 'ctx' || k === 'add' || k === 'blankAdd').length;

  const firstOld = countOld(firstKinds);
  const firstNew = countNew(firstKinds);
  const secondOld = countOld(kinds.slice(splitAt));
  const secondNew = countNew(kinds.slice(splitAt));

  const firstHeader = `@@ -${oldStart},${firstOld} +${newStart},${firstNew} @@${suffix}`;
  const secondHeader = `@@ -${oldStart + firstOld},${secondOld} +${newStart + firstNew},${secondNew} @@${suffix}`;

  const firstDiff = [firstHeader, ...firstBody].join('\n');
  const secondDiff = [secondHeader, ...secondBody].join('\n');

  const firstRange = firstNew <= 1 ? `${newStart}` : `${newStart}-${newStart + firstNew - 1}`;
  const secondNewStart = newStart + firstNew;
  const secondRange = secondNew <= 1 ? `${secondNewStart}` : `${secondNewStart}-${secondNewStart + secondNew - 1}`;

  const hA: Hunk = {
    kind: 'code',
    file: h.file,
    lines: firstRange,
    diff: firstDiff,
    display: `--- a/${h.file}\n+++ b/${h.file}\n${firstDiff}`,
  };
  const hB: Hunk = {
    kind: 'code',
    file: h.file,
    lines: secondRange,
    diff: secondDiff,
    display: `--- a/${h.file}\n+++ b/${h.file}\n${secondDiff}`,
  };
  return [hA, hB];
}

/**
 * Wrap the agent's last response as a single reviewable summary hunk. The
 * reviewer can press `s` to split it on paragraph boundaries as needed,
 * rather than getting a pre-atomized list where short heading paragraphs
 * become their own awkward one-line hunks.
 *
 * Exported for tests.
 */
export function summaryHunksFromText(text: string): Hunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [{
    kind: 'summary',
    file: 'agent-response',
    lines: 'summary',
    diff: trimmed,
    display: trimmed,
  }];
}

function renderHunk(
  h: Hunk,
  idx: number,
  total: number,
  reviewed: boolean,
  persistedApproved: boolean = false,
): string {
  const mark = reviewed || persistedApproved ? `${ansi.fg.green}✓${ansi.reset} ` : '  ';
  const persistedSuffix = persistedApproved
    ? ` ${ansi.dim}(reviewed)${ansi.reset}`
    : '';
  const header = `${ansi.bold}${mark}[${idx + 1}/${total}] ${h.file}:${h.lines}${ansi.reset}${persistedSuffix}`;
  if (h.kind === 'summary') {
    const body = persistedApproved
      ? `${ansi.dim}${h.display}${ansi.reset}`
      : h.display;
    return `\n${header}\n${body}`;
  }
  return `\n${header}\n${colorDiff(h.diff, persistedApproved)}`;
}

function renderSeparator(): string {
  const w = Math.max(20, process.stdout.columns ?? 80);
  return `${ansi.dim}${'─'.repeat(w)}${ansi.reset}`;
}

function statusLine(
  idx: number,
  total: number,
  commentsMade: number,
  approvedCount: number = 0,
  showApproved: boolean = false,
): string {
  const pos = `${ansi.bold}[${idx + 1}/${total}]${ansi.reset}`;
  const commentsHint = commentsMade > 0
    ? ` ${ansi.fg.cyan}(${commentsMade} comment${commentsMade === 1 ? '' : 's'})${ansi.reset}`
    : '';
  const approvedHint = approvedCount > 0
    ? ` ${ansi.dim}(${approvedCount} reviewed${showApproved ? ', shown' : ', skipped'})${ansi.reset}`
    : '';
  // Short-form legend next to the position indicator (per user feedback).
  const legend = `${ansi.dim}o=ok n=next p=prev s=split a=ask f=feedback u=toggle-reviewed q=quit${ansi.reset}`;
  return `${pos}${commentsHint}${approvedHint} ${legend} `;
}

// ── Resume agent session for Q&A ────────────────────────────────────────

/**
 * Typed sentinel thrown when the daemon rejects the ask because the task is
 * not in `blocked` status. The reviewer's question is preserved in the outer
 * loop so they can retry once the task is blocked again.
 */
class AskRejected extends Error {
  constructor(public readonly daemonStatus: number, message: string) {
    super(message);
    this.name = 'AskRejected';
  }
}

/**
 * Thrown when the reviewer hits Ctrl+C while an ask is in-flight. Raw mode
 * swallows SIGINT (stdin just delivers 0x03 as a keypress), so without an
 * explicit listener the reviewer is stuck until the 10-minute timeout.
 *
 * The daemon can't cancel an in-flight supervisor turn — by the time we see
 * Ctrl+C, claude is already burning reasoning tokens. We abandon the ask
 * locally and let the reconciler absorb the response whenever it lands.
 */
class AskAborted extends Error {
  constructor() {
    super('ask aborted by Ctrl+C');
    this.name = 'AskAborted';
  }
}

/**
 * Send a review question to the agent via the daemon's ask RPC (read-only,
 * plan-mode resume). The daemon enforces that the task is in `blocked` or
 * `conflict` status — this is the only way a review question ever turns into an
 * agent turn. If the daemon has auto-transitioned the task (CI failure, upstream
 * sync, incoming comment), we get a 409 and surface it to the reviewer.
 *
 * Waits for `response.json` written by the supervisor, then returns its
 * `result` text. We do NOT consume the response — the daemon reconciler
 * picks it up and persists the agent turn, matching how any other turn
 * materializes in the session history.
 */
// Review Q&A is latency-sensitive; the questions are usually simple ("why did
// you do X?", "is Y correct?"). Low effort keeps answers snappy.
const ASK_EFFORT = 'low' as const;

async function askAgent(
  raw: RawSession,
  taskId: string,
  hunk: Hunk,
  question: string,
): Promise<string> {
  const payload = reviewQaPromptTemplate
    .replace(/\{\{file\}\}/g, hunk.file)
    .replace(/\{\{lines\}\}/g, hunk.lines)
    .replace(/\{\{hunk\}\}/g, hunk.diff)
    .replace(/\{\{question\}\}/g, question);

  const verbose = process.env.LAZY_VERBOSE === '1';
  const t0 = Date.now();

  // Waiting-line renderer: elapsed seconds, redrawn every 1s using \r so the
  // line is a live progress indicator rather than a frozen "Asking agent…".
  const baseLine = `${ansi.dim}Asking agent (reflective, read-only, ${ASK_EFFORT} effort)…${ansi.reset}`;
  const CLEAR_LINE = '\r\x1b[2K';
  process.stdout.write(`${baseLine}  ${ansi.dim}0s (Ctrl+C to abort)${ansi.reset}`);
  const progressTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    process.stdout.write(`${CLEAR_LINE}${baseLine}  ${ansi.dim}${sec}s (Ctrl+C to abort)${ansi.reset}`);
  }, 1000);
  const stopProgress = () => {
    clearInterval(progressTimer);
    process.stdout.write(CLEAR_LINE);
  };

  // Raw mode eats SIGINT — install a stdin listener that converts Ctrl+C
  // (byte 0x03) into AskAborted so the reviewer isn't hostage to the
  // 10-minute RPC timeout when they want to bail.
  const abortPromise = new Promise<never>((_, reject) => {
    raw.onKey((k) => {
      if (k.ctrl && k.name === 'c') reject(new AskAborted());
    });
  });
  const detachAbort = () => raw.onKey(() => {});

  try {
    const result = await Promise.race([
      queryAskTask({
        taskId,
        message: payload,
        effortOverride: ASK_EFFORT,
      }),
      abortPromise,
    ]);
    detachAbort();
    stopProgress();
    if (verbose) {
      const total = Date.now() - t0;
      // An older daemon (pre-timings) returns no `timings` field — degrade
      // gracefully to just total so the ask doesn't hard-fail over telemetry.
      if (!result.timings) {
        console.log(`${ansi.dim}[verbose] ask: total=${total}ms (daemon missing timings — restart daemon)${ansi.reset}`);
      } else {
        const { daemon_ms, wait_ms, agent_ms } = result.timings;
        // Layer breakdown:
        //   agent       — claude process time (supervisor reports it)
        //   supervisor  — container-side overhead (wait minus agent)
        //   daemon      — prep/post around the supervisor wait
        //   rpc         — CLI↔daemon wire + process handoff
        const rpc = Math.max(0, total - daemon_ms);
        const daemonOverhead = Math.max(0, daemon_ms - wait_ms);
        const supervisorOverhead = agent_ms !== undefined
          ? Math.max(0, wait_ms - agent_ms)
          : undefined;
        const parts: string[] = [];
        if (agent_ms !== undefined) parts.push(`agent=${agent_ms}ms`);
        if (supervisorOverhead !== undefined) parts.push(`supervisor=${supervisorOverhead}ms`);
        else parts.push(`wait=${wait_ms}ms`);
        parts.push(`daemon=${daemonOverhead}ms`, `rpc=${rpc}ms`, `total=${total}ms`);
        console.log(`${ansi.dim}[verbose] ask: ${parts.join(' ')}${ansi.reset}`);
      }
    }
    return result.answer.trim();
  } catch (err) {
    detachAbort();
    stopProgress();
    if (err instanceof RpcError && err.status === 409) {
      throw new AskRejected(409, err.message);
    }
    throw err;
  }
}

// ── Split-lineage replay ────────────────────────────────────────────────

/**
 * In-memory lineage tag for a hunk that was produced by one or more splits.
 * Lets us persist split-hunk approvals against a stable anchor (parent file
 * + line range) and a deterministic split recipe — the parent's hash isn't
 * used as the lookup key, so unrelated edits to surrounding diff context
 * don't orphan child approvals.
 *
 * `null` lineage entries mean "this hunk is an original parent emitted by
 * `parseHunks` — its identity is its own content hash".
 */
export interface HunkLineage {
  parentFile: string;
  parentLines: string;
  /** Sequence of '0'/'1' digits, one per split level applied to the parent. */
  path: string;
}

/**
 * Replay a recorded split path on a parent hunk. Returns null if any split
 * along the path can't be performed (the diff content has drifted enough
 * that `splitHunk` no longer finds the same boundary, or the hunk became
 * atomic before reaching the recorded depth).
 *
 * Exported for tests.
 */
export function replaySplitPath(parent: Hunk, path: string): Hunk | null {
  let cur = parent;
  for (const c of path) {
    const split = splitHunk(cur);
    if (!split) return null;
    cur = c === '0' ? split[0] : split[1];
  }
  return cur;
}

/**
 * Reconstruct the in-memory hunk list a previous review session would have
 * seen, given the freshly-parsed parent hunks and the persisted approvals.
 *
 * The algorithm: for each parent location with split-hunk approvals, build
 * a binary split tree just deep enough to expose every persisted leaf path,
 * then replace the parent with that tree's leaves (in left-to-right order).
 * Each leaf carries lineage so future approvals/splits in this session
 * persist with the right anchor.
 *
 * For each leaf produced:
 *   - if its hash matches a persisted approval whose `split_path` matches
 *     this leaf's path → mark approved (the approval survived).
 *   - if its hash mismatches → the content drifted within this sub-region;
 *     the approval is correctly invalidated and the reviewer sees the leaf
 *     fresh.
 *
 * Whole-hunk approvals (no `split_path`) are surfaced through the returned
 * `wholeHashes` set — the caller seeds `hunkApproved` for un-split hunks
 * by hash match, exactly as before.
 *
 * Exported for tests.
 */
export function reconstructHunksWithApprovals(
  parents: Hunk[],
  approvals: ReadonlyArray<{
    hunk_hash: string;
    parent_file?: string;
    parent_lines?: string;
    split_path?: string;
  }>,
): {
  hunks: Hunk[];
  lineage: (HunkLineage | null)[];
  approvedHashes: Set<string>;
} {
  // Group split-lineage approvals by their parent location anchor. The hash
  // is a tripwire we'll check after replay — not part of the lookup key.
  type SplitApproval = { hash: string; path: string };
  const splitGroups = new Map<string, SplitApproval[]>();
  const wholeHashes = new Set<string>();

  for (const a of approvals) {
    if (a.parent_file !== undefined && a.parent_lines !== undefined && a.split_path) {
      const key = `${a.parent_file}\0${a.parent_lines}`;
      let group = splitGroups.get(key);
      if (!group) {
        group = [];
        splitGroups.set(key, group);
      }
      group.push({ hash: a.hunk_hash, path: a.split_path });
    } else {
      wholeHashes.add(a.hunk_hash);
    }
  }

  const outHunks: Hunk[] = [];
  const outLineage: (HunkLineage | null)[] = [];

  for (const parent of parents) {
    const key = `${parent.file}\0${parent.lines}`;
    const group = splitGroups.get(key);
    if (!group || group.length === 0) {
      outHunks.push(parent);
      outLineage.push(null);
      continue;
    }
    // Build the leaf set: every path in the group becomes a leaf. To produce
    // them deterministically, we walk the binary tree depth-first from the
    // root, splitting any node that is a strict prefix of some path in the
    // group, and emitting any node that exactly matches a path or that
    // isn't a prefix of any other path.
    type Frame = { path: string; hunk: Hunk };
    const stack: Frame[] = [{ path: '', hunk: parent }];
    const leaves: Frame[] = [];
    const paths = group.map(g => g.path);
    while (stack.length > 0) {
      const top = stack.pop()!;
      const isPrefix = paths.some(p => p.startsWith(top.path) && p.length > top.path.length);
      if (!isPrefix) {
        leaves.push(top);
        continue;
      }
      const split = splitHunk(top.hunk);
      if (!split) {
        // Persisted paths wanted to descend into this node, but the hunk
        // won't split here. Treat the node as a leaf at its current path.
        // The hash-verification phase will correctly drop any approval
        // whose path is strictly deeper than this leaf (no leaf will
        // match), while approvals on sibling branches keep replaying
        // independently. A split failure in one sub-region must not
        // cascade across the parent.
        leaves.push(top);
        continue;
      }
      // Push right child first so left ('0') is processed/emitted first.
      stack.push({ path: top.path + '1', hunk: split[1] });
      stack.push({ path: top.path + '0', hunk: split[0] });
    }
    if (leaves.length === 0) continue;
    for (const leaf of leaves) {
      outHunks.push(leaf.hunk);
      outLineage.push({
        parentFile: parent.file,
        parentLines: parent.lines,
        path: leaf.path,
      });
    }
  }

  // Build the approved-hash set from approvals that survived replay. A
  // persisted approval survives iff (a) its parent location matched a
  // freshly-parsed hunk, (b) the path replay produced a leaf, and (c) the
  // leaf's content hash equals the persisted hunk_hash.
  const approvedHashes = new Set<string>(wholeHashes);
  for (let i = 0; i < outHunks.length; i++) {
    const lin = outLineage[i];
    if (!lin) continue;
    const key = `${lin.parentFile}\0${lin.parentLines}`;
    const group = splitGroups.get(key);
    if (!group) continue;
    const leafHash = hunkHash(outHunks[i]);
    const matching = group.find(g => g.path === lin.path && g.hash === leafHash);
    if (matching) approvedHashes.add(leafHash);
  }

  return { hunks: outHunks, lineage: outLineage, approvedHashes };
}

// ── Main loop ────────────────────────────────────────────────────────────

export interface RunInteractiveReviewOptions {
  /** Skip the agent Q&A call, echo a stub answer. For tests. */
  stubAgent?: boolean;
}

export async function runInteractiveReview(
  storage: Storage,
  task: Task,
  sess: Session,
  root: string,
  options: RunInteractiveReviewOptions = {},
): Promise<void> {
  const worktreePath = getWorktreePath(root, task);
  if (!existsSync(worktreePath)) {
    // Worktree gone (accepted/closed/cleaned-up task). Match the non-
    // interactive review's behavior and try to rehydrate from local or
    // remote branch before giving up.
    const taskBranch = sess.git_branch ?? getBranchName(task);
    const config = await loadConfig(root);
    console.log(`${ansi.dim}Worktree missing — attempting to rehydrate from branch '${taskBranch}'…${ansi.reset}`);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, taskBranch, config.remote.git_remote, root,
      );
      if (!recovery.recovered) {
        const localExists = await branchExists(taskBranch, root);
        console.error(
          `Worktree not found at ${worktreePath} and could not be rehydrated ` +
          `(branch '${taskBranch}' ${localExists ? 'exists locally but recovery failed' : 'not found locally or on remote'}).`,
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(`Worktree not found at ${worktreePath} and rehydrate failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Fetch the agent's last response, the task diff, and persisted hunk
  // approvals in parallel. Approvals seed the in-memory "already reviewed"
  // set so previously-cleared hunks don't re-appear unless their content
  // changed.
  const [summaryHunks, diffResult, approvals] = await Promise.all([
    (async () => {
      try {
        const turns = await storage.getSessionTurns(sess.id);
        // Pick the last substantive agent turn — skip Q&A responses from
        // previous review sessions so the summary always reflects the
        // agent's latest narrative, not the answer to "why did you X?".
        // Missing turn_type defaults to 'work' (the narrative-advancing kind).
        const lastAgentTurn = turns
          .filter(t => t.role === 'agent' && (t.turn_type ?? 'work') === 'work')
          .pop();
        return lastAgentTurn?.content ? summaryHunksFromText(lastAgentTurn.content) : [];
      } catch {
        // Non-fatal — the reviewer can still walk the diff.
        return [];
      }
    })(),
    queryDiff({ taskId: task.id, full: true }),
    storage.listHunkApprovals(task.id).catch(() => [] as Array<{
      hunk_hash: string;
      parent_file?: string;
      parent_lines?: string;
      split_path?: string;
    }>),
  ]);

  const diffText = diffResult.output;
  const codeHunks = diffText && diffText.trim() ? parseHunks(diffText) : [];
  const parentHunks = [...summaryHunks, ...codeHunks];
  // Replay any persisted splits so previously-approved sub-hunks reappear in
  // the same shape as the previous session, with their approvals re-anchored.
  const reconstructed = reconstructHunksWithApprovals(parentHunks, approvals);
  const hunks = reconstructed.hunks;
  const lineage = reconstructed.lineage;
  const approvedHashes = reconstructed.approvedHashes;

  if (hunks.length === 0) {
    console.log('Nothing to review — no agent response and no changes.');
    return;
  }

  const claudeSessionId = sess.agent_session_id;
  if (!claudeSessionId) {
    console.log(`${ansi.fg.yellow}Note: task has no agent session id — 'a' (ask) will be disabled.${ansi.reset}`);
  }

  const reviewStartedAt = new Date();

  // Per-index approval state, parallel to `hunks`. `hunkApproved[i]` is
  // true when the hunk's content hash matches a persisted approval —
  // these get skipped in n/p navigation by default, can be walked with
  // the `u` toggle.
  const hunkApproved: boolean[] = hunks.map(h => approvedHashes.has(hunkHash(h)));
  let showApproved = false;
  const approvedCount = () => hunkApproved.filter(Boolean).length;

  const reviewed = new Set<number>();
  // Start the cursor on the first non-approved hunk (or 0 if all approved
  // — the reviewer can still see them by toggling `u`).
  let i = hunkApproved.findIndex(a => !a);
  if (i === -1) i = 0;

  const raw = openRawKeys();
  let commentsMade = 0;

  try {
    console.log(`\n${ansi.bold}Interactive review: ${task.goal}${ansi.reset}`);
    // Same header fact as the full-screen review: if accepting this task will
    // need `lazy approve`, say so before the reviewer starts approving hunks.
    const protectionLine = await protectionHeadlineForTask(storage, root, task);
    if (protectionLine) {
      console.log(`${ansi.fg.yellow}${protectionLine}${ansi.reset}`);
    }
    const approvedNow = approvedCount();
    if (approvedNow > 0) {
      console.log(
        `${ansi.dim}${hunks.length} hunk(s) — ${approvedNow} already reviewed; press u to walk them.${ansi.reset}`,
      );
    } else {
      console.log(`${ansi.dim}${hunks.length} hunk(s)${ansi.reset}`);
    }

    let lastRenderedIdx = -1;
    while (i < hunks.length) {
      if (i !== lastRenderedIdx) {
        process.stdout.write(renderHunk(hunks[i], i, hunks.length, reviewed.has(i), hunkApproved[i]));
        lastRenderedIdx = i;
      }
      process.stdout.write(`\n${renderSeparator()}\n`);
      process.stdout.write(statusLine(i, hunks.length, commentsMade, approvedCount(), showApproved));

      // Read keys until we get one of the documented actions. Unknown keys
      // (arrows, f-keys, mouse events, stray bytes from terminal events) are
      // dropped silently so the status prompt doesn't flicker or scroll.
      const KNOWN_ACTIONS = new Set(['o', 'n', 'p', 's', 'a', 'f', 'u', 'q']);
      let k: Key;
      let name = '';
      while (true) {
        k = await readSingleKey(raw);
        if (k.ctrl && k.name === 'c') break;
        const cand = k.name || k.sequence;
        if (!k.ctrl && !k.meta && KNOWN_ACTIONS.has(cand)) {
          name = cand;
          break;
        }
      }
      if (k.ctrl && k.name === 'c') { process.stdout.write('\n'); break; }
      process.stdout.write('\n');

      // Helpers that respect the "skip approved by default" UX. When
      // `showApproved` is true, all hunks are walked (the reviewer
      // toggled `u` to revisit them).
      const isVisible = (idx: number) => showApproved || !hunkApproved[idx];
      const nextVisible = (from: number): number | null => {
        for (let j = from + 1; j < hunks.length; j++) if (isVisible(j)) return j;
        return null;
      };
      const prevVisible = (from: number): number | null => {
        for (let j = from - 1; j >= 0; j--) if (isVisible(j)) return j;
        return null;
      };

      // For navigation messages: when n/p has nowhere to go but hidden
      // (already-approved-and-filtered) hunks exist, surface that escape
      // hatch so the reviewer isn't dead-ended without knowing why.
      const endHint = (where: 'end' | 'start'): string => {
        const hidden = !showApproved ? hunkApproved.filter(Boolean).length : 0;
        const baseEnd = where === 'end' ? '(end of hunks)' : '(already at first hunk)';
        if (hidden === 0) return baseEnd;
        const baseVisible = where === 'end' ? 'end of visible hunks' : 'already at first visible hunk';
        return `(${baseVisible} — ${hidden} hidden, press u to show all)`;
      };

      if (name === 'o') {
        reviewed.add(i);
        // Persist. Best-effort — a storage failure just leaves the
        // approval session-local; raw mode stays clean.
        const hash = hunkHash(hunks[i]);
        const lin = lineage[i];
        const lineagePayload = lin
          ? { parent_file: lin.parentFile, parent_lines: lin.parentLines, split_path: lin.path }
          : undefined;
        try {
          await storage.createHunkApproval(task.id, hash, getActor(), lineagePayload);
          hunkApproved[i] = true;
        } catch (err) {
          console.log(`${ansi.fg.yellow}Warning: could not persist approval — ${err instanceof Error ? err.message : err}${ansi.reset}`);
        }
        const next = nextVisible(i);
        if (next !== null) { i = next; }
        else {
          console.log(`${ansi.fg.green}All hunks reviewed.${ansi.reset}`);
          break;
        }
      } else if (name === 'n') {
        const next = nextVisible(i);
        if (next !== null) { i = next; }
        else { console.log(`${ansi.dim}${endHint('end')}${ansi.reset}`); }
      } else if (name === 'p') {
        const prev = prevVisible(i);
        if (prev !== null) { i = prev; lastRenderedIdx = -1; }
        else { console.log(`${ansi.dim}${endHint('start')}${ansi.reset}`); }
      } else if (name === 'u') {
        showApproved = !showApproved;
        lastRenderedIdx = -1;
        console.log(
          `${ansi.dim}(${showApproved ? 'showing' : 'skipping'} reviewed hunks)${ansi.reset}`,
        );
      } else if (name === 's') {
        const cur = hunks[i];
        const split = splitHunk(cur);
        if (!split) {
          console.log(`${ansi.dim}(cannot split — no interior context between changes)${ansi.reset}`);
        } else {
          // Splicing shifts every subsequent reviewed index by +1.
          const shifted = new Set<number>();
          for (const idx of reviewed) {
            if (idx < i) shifted.add(idx);
            else if (idx === i) { shifted.add(idx); shifted.add(idx + 1); }
            else shifted.add(idx + 1);
          }
          reviewed.clear();
          for (const idx of shifted) reviewed.add(idx);
          hunks.splice(i, 1, split[0], split[1]);
          // Recompute hunkApproved for the two new entries — split halves
          // have hashes distinct from the parent, so they show as fresh.
          hunkApproved.splice(i, 1,
            approvedHashes.has(hunkHash(split[0])),
            approvedHashes.has(hunkHash(split[1])),
          );
          // Track lineage so an approval on either half carries the parent
          // anchor + split path for next-session replay.
          const parentLin = lineage[i];
          const childParentFile = parentLin?.parentFile ?? cur.file;
          const childParentLines = parentLin?.parentLines ?? cur.lines;
          const childPathBase = parentLin?.path ?? '';
          lineage.splice(i, 1,
            { parentFile: childParentFile, parentLines: childParentLines, path: childPathBase + '0' },
            { parentFile: childParentFile, parentLines: childParentLines, path: childPathBase + '1' },
          );
          // Stay on the first half so the reviewer sees the split.
          lastRenderedIdx = -1;
        }
      } else if (name === 'q') {
        break;
      } else if (name === 'a') {
        if (!claudeSessionId) {
          console.log(`${ansi.fg.yellow}Cannot ask — no resumable agent session.${ansi.reset}`);
          continue;
        }
        const q = await promptMultiLine(raw, 'Ask the agent about this hunk:');
        if (q === null || !q.trim()) {
          console.log(`${ansi.dim}(cancelled)${ansi.reset}`);
          continue;
        }
        try {
          const answer = options.stubAgent
            ? '(stub answer)'
            : await askAgent(raw, task.id, hunks[i], q);
          console.log(`\n${ansi.fg.magenta}── agent ──${ansi.reset}\n${answer}\n${ansi.fg.magenta}───────────${ansi.reset}\n`);
        } catch (err) {
          if (err instanceof AskAborted) {
            // Reviewer hit Ctrl+C while the ask was in-flight. The agent may
            // still be working on it — surface that clearly and bail the
            // whole review so we don't trap them in raw mode.
            console.log(`${ansi.fg.yellow}Ask aborted. Agent may still be working — its answer will land in the session when it finishes.${ansi.reset}`);
            break;
          }
          if (err instanceof AskRejected) {
            // Daemon rejected because the task is not blocked. Tell the
            // reviewer *why* and preserve their question for retry.
            console.log(`${ansi.fg.yellow}Question rejected: ${err.message}${ansi.reset}`);
            console.log(`${ansi.dim}Your question is preserved below. Retry with 'a' once the task is blocked again:${ansi.reset}`);
            console.log(`${ansi.dim}---${ansi.reset}`);
            console.log(q);
            console.log(`${ansi.dim}---${ansi.reset}`);
          } else {
            console.log(`${ansi.fg.red}Agent call failed: ${err instanceof Error ? err.message : err}${ansi.reset}`);
          }
        }
      } else if (name === 'f') {
        const fb = await promptMultiLine(raw, 'Feedback on this hunk:');
        if (fb === null || !fb.trim()) {
          console.log(`${ansi.dim}(cancelled)${ansi.reset}`);
          continue;
        }
        const h = hunks[i];
        // For summary hunks, include the paragraph text so the comment reads
        // standalone in the task history. For code hunks the git hunk is
        // recoverable from `lazy diff`, so a header-only anchor is enough.
        const anchor = `On ${h.file}:${h.lines}:`;
        const body = h.kind === 'summary'
          ? `${anchor}\n\n> ${h.display.split('\n').join('\n> ')}\n\n${fb.trim()}`
          : `${anchor}\n\n${fb.trim()}`;
        try {
          // Intentionally NOT emitting a 'comment' signal here. Review-i
          // batches comments: the reviewer may add many across a single
          // walkthrough and asks questions (plan-mode) in between, which
          // require task.status === 'blocked'. Auto-delivering each comment
          // would transition the task to 'working' and block further asks,
          // plus race the explicit "Submit as unblock?" call at the end.
          // The end-of-review submit is the sole unblock path; quitting
          // without submitting leaves comments durably persisted until the
          // reviewer explicitly unblocks.
          const comment = await storage.createComment(task.id, body, getActor());
          commentsMade++;
          console.log(`${ansi.fg.green}✓ comment saved (${comment.id.slice(0, 8)})${ansi.reset}`);
        } catch (err) {
          console.log(`${ansi.fg.red}Failed to save comment: ${err instanceof Error ? err.message : err}${ansi.reset}`);
        }
      }
    }

    // Exit: offer to submit feedback as unblock
    if (commentsMade > 0) {
      console.log('');
      const submit = await promptYN(raw, `Submit ${commentsMade} feedback comment${commentsMade === 1 ? '' : 's'} as unblock?`);
      if (submit) {
        // Close raw mode before the RPC, which may print its own output
        raw.close();
        const message = `Please address the review comments I added since ${reviewStartedAt.toISOString()}.`;
        try {
          const result = await queryUnblockTask({
            taskId: task.id,
            message,
            approvedFiles: [],
          });
          for (const w of result.warnings) console.log(w);
          console.log(`${ansi.fg.green}Task unblocked (turn ${result.turnNumber}).${ansi.reset}`);
        } catch (err) {
          console.log(`${ansi.fg.red}Unblock failed: ${err instanceof Error ? err.message : err}${ansi.reset}`);
          console.log(`Your ${commentsMade} comment(s) are safe on the task. Retry with: lazy unblock ${task.id.slice(0, 8)}`);
        }
        return;
      } else {
        console.log(`Comments stay on the task. Unblock later with: lazy unblock ${task.id.slice(0, 8)}`);
      }
    }
  } finally {
    raw.close();
  }
}
