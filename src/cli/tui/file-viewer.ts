/**
 * Simple full-screen file viewer with scrolling support.
 * Used by `lazy show` to render files when argument is a path.
 */

import { Terminal, getTerminalSize, type KeyPress } from './terminal';
import { ansi, truncateVisible, visibleLength } from './terminal';
import { formatMarkdown, wrapLines } from './renderer';
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

export interface FileViewerState {
  filename: string;
  contentLines: string[];
  scrollOffset: number;
}

function renderFileViewer(state: FileViewerState): string {
  const { rows, cols } = getTerminalSize();
  const contentHeight = rows - 3; // -1 header, -1 status bar, -1 help bar
  const lines: string[] = [];

  // ── Header bar ─────────────────────────────────────────────────────
  const headerText = ` ${state.filename}`;
  const headerPadded = headerText + ' '.repeat(Math.max(0, cols - visibleLength(headerText)));
  lines.push(ansi.bg.blue + ansi.fg.white + ansi.bold + headerPadded + ansi.reset + ansi.clearToEOL);

  // ── Content rows ───────────────────────────────────────────────────
  for (let row = 0; row < contentHeight; row++) {
    const contentIdx = row + state.scrollOffset;
    let content = '';
    if (contentIdx < state.contentLines.length) {
      content = truncateVisible(state.contentLines[contentIdx], cols - 1);
    }
    lines.push(content + ansi.clearToEOL);
  }

  // ── Status bar ─────────────────────────────────────────────────────
  const totalLines = state.contentLines.length;
  const visibleEnd = Math.min(state.scrollOffset + contentHeight, totalLines);
  const scrollPos = totalLines > 0
    ? `Lines ${state.scrollOffset + 1}-${visibleEnd} of ${totalLines}`
    : 'Empty file';
  const statusPadded = (' ' + scrollPos).padEnd(cols);
  lines.push(ansi.bg.brightBlack + ansi.fg.white + statusPadded.substring(0, cols) + ansi.reset + ansi.clearToEOL);

  // ── Help bar ───────────────────────────────────────────────────────
  const actions = [
    `${ansi.bold}↑↓${ansi.reset} scroll`,
    `${ansi.bold}PgUp/PgDn${ansi.reset} page`,
    `${ansi.bold}Home/End${ansi.reset} top/bottom`,
    `${ansi.bold}q${ansi.reset}uit`,
  ];
  const actionLine = ' ' + actions.join('  ');
  lines.push(truncateVisible(actionLine, cols) + ansi.clearToEOL);

  return ansi.moveTo(1, 1) + lines.join('\n');
}

function handleKeyPress(state: FileViewerState, key: KeyPress): 'quit' | 'redraw' | null {
  const { rows } = getTerminalSize();
  const contentHeight = rows - 3;
  const maxScroll = Math.max(0, state.contentLines.length - contentHeight);

  if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
    return 'quit';
  }

  // Scrolling keys
  if (key.name === 'up') {
    state.scrollOffset = Math.max(0, state.scrollOffset - 1);
    return 'redraw';
  }
  if (key.name === 'down') {
    state.scrollOffset = Math.min(maxScroll, state.scrollOffset + 1);
    return 'redraw';
  }
  if (key.name === 'pageup') {
    state.scrollOffset = Math.max(0, state.scrollOffset - contentHeight);
    return 'redraw';
  }
  if (key.name === 'pagedown') {
    state.scrollOffset = Math.min(maxScroll, state.scrollOffset + contentHeight);
    return 'redraw';
  }
  if (key.name === 'home') {
    state.scrollOffset = 0;
    return 'redraw';
  }
  if (key.name === 'end') {
    state.scrollOffset = maxScroll;
    return 'redraw';
  }

  return null;
}

/**
 * Launch a full-screen file viewer for the given file path.
 * Returns when user quits.
 */
export async function showFileViewer(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  const isMarkdown = filePath.endsWith('.md');

  // Format content based on file type
  let contentLines: string[];
  if (isMarkdown) {
    contentLines = formatMarkdown(content);
  } else {
    contentLines = content.split('\n');
  }

  // Wrap lines to fit terminal width
  const { cols } = getTerminalSize();
  contentLines = wrapLines(contentLines, cols - 1);

  const state: FileViewerState = {
    filename: basename(filePath),
    contentLines,
    scrollOffset: 0,
  };

  const term = new Terminal();
  term.enter();

  const render = () => {
    term.write(renderFileViewer(state));
  };

  term.onKey((key: KeyPress) => {
    const result = handleKeyPress(state, key);
    if (result === 'quit') {
      term.exit();
      process.exit(0);
    }
    if (result === 'redraw') {
      render();
    }
  });

  term.onResize(() => {
    // Re-wrap lines on terminal resize
    const { cols: newCols } = getTerminalSize();
    let rawLines: string[];
    if (isMarkdown) {
      rawLines = formatMarkdown(content);
    } else {
      rawLines = content.split('\n');
    }
    state.contentLines = wrapLines(rawLines, newCols - 1);
    render();
  });

  render();

  // Keep process alive
  await new Promise(() => {});
}
