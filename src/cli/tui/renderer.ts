/**
 * Two-panel layout renderer.
 * Left panel: navigation tree (1/8 screen)
 * Right panel: content viewer (7/8 screen)
 */

import { ansi, getTerminalSize, visibleLength, truncateVisible, stripAnsi } from './terminal';
import { formatMarkdown as _formatMarkdown } from '../../utils/markdown';

// ── Box-drawing characters ─────────────────────────────────────────────

const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
};

// ── Navigation item types ──────────────────────────────────────────────

export interface NavItem {
  label: string;
  key: string;        // unique identifier
  icon: string;       // single char or emoji
  badge?: string;     // e.g. count or "new"
  children?: NavItem[];
  expanded?: boolean;
}

// ── Layout state ───────────────────────────────────────────────────────

/** A flattened node for the task tree overlay. */
export interface TreeOverlayNode {
  taskId: string;
  label: string;           // display text (code or shortId)
  goal: string;            // one-line goal summary
  status: string;          // task status for coloring
  depth: number;           // nesting level
  isCurrent: boolean;      // true for the task being reviewed
}

export type SubtaskFilterMode = 'all' | 'active' | 'backlog';

export interface LayoutState {
  leftPanelFocused: boolean;
  navItems: NavItem[];
  flatNavItems: FlatNavItem[];  // computed from navItems
  selectedNavIndex: number;
  navScrollOffset: number;      // scroll offset for left panel
  contentLines: string[];
  contentScrollOffset: number;
  statusLine: string;
  taskHeader: string;
  /** Task tree overlay state (toggled with 't') */
  showTaskTree: boolean;
  treeOverlayNodes: TreeOverlayNode[];
  treeOverlaySelectedIndex: number;
  treeOverlayScrollOffset: number;
  /** Help overlay state (toggled with '?') */
  showHelp: boolean;
  /** Subtask filter mode for ]/[ cycling */
  subtaskFilterMode: SubtaskFilterMode;
  /** Whether this task has any subtasks (controls filter display) */
  hasSubtasks: boolean;
}

export interface FlatNavItem {
  item: NavItem;
  depth: number;
  parentKey?: string;
  isLast: boolean;
}

// ── Flatten nav tree ───────────────────────────────────────────────────

export function flattenNavItems(items: NavItem[], depth = 0, parentKey?: string): FlatNavItem[] {
  const result: FlatNavItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = i === items.length - 1;
    result.push({ item, depth, parentKey, isLast });
    if (item.children && item.expanded) {
      result.push(...flattenNavItems(item.children, depth + 1, item.key));
    }
  }
  return result;
}

// ── Renderer ───────────────────────────────────────────────────────────

export function render(state: LayoutState): string {
  const { rows, cols } = getTerminalSize();

  // Calculate panel widths
  const leftWidth = Math.max(Math.floor(cols / 5), 30);
  const rightWidth = cols - leftWidth - 1; // -1 for the divider
  const contentHeight = rows - 4; // -1 header, -1 panel border, -1 status bar, -1 help bar

  const lines: string[] = [];

  // ── Header bar ─────────────────────────────────────────────────────
  const headerText = ` ${state.taskHeader}`;
  const headerPadded = headerText + ' '.repeat(Math.max(0, cols - visibleLength(headerText)));
  lines.push(ansi.bg.blue + ansi.fg.white + ansi.bold + headerPadded + ansi.reset + ansi.clearToEOL);

  // ── Panel focus border ─────────────────────────────────────────────
  const leftBorderStyle = state.leftPanelFocused
    ? ansi.fg.cyan + ansi.bold
    : ansi.dim;
  const rightBorderStyle = !state.leftPanelFocused
    ? ansi.fg.cyan + ansi.bold
    : ansi.dim;
  const leftBorder = leftBorderStyle + BOX.horizontal.repeat(leftWidth - 1) + ansi.reset;
  const rightBorder = rightBorderStyle + BOX.horizontal.repeat(rightWidth) + ansi.reset;
  const borderJunction = ansi.dim + BOX.teeDown + ansi.reset;
  lines.push(leftBorder + borderJunction + rightBorder + ansi.clearToEOL);

  // ── Two panels ─────────────────────────────────────────────────────
  for (let row = 0; row < contentHeight; row++) {
    // Left panel content (with scroll offset)
    let leftContent = '';
    const navIdx = row + state.navScrollOffset;
    if (navIdx < state.flatNavItems.length) {
      const flat = state.flatNavItems[navIdx];
      const isSelected = navIdx === state.selectedNavIndex;
      const indent = '  '.repeat(flat.depth);
      const icon = flat.item.icon + ' ';
      const label = flat.item.label;
      const badge = flat.item.badge ? ` ${ansi.fg.yellow}(${flat.item.badge})${ansi.reset}` : '';
      const expandIcon = flat.item.children
        ? (flat.item.expanded ? '▾ ' : '▸ ')
        : '  ';

      const text = indent + expandIcon + icon + label + badge;

      if (isSelected) {
        const highlight = state.leftPanelFocused
          ? ansi.inverse
          : ansi.dim + ansi.underline;
        leftContent = highlight + truncateVisible(text, leftWidth - 1) + ansi.reset;
      } else {
        leftContent = truncateVisible(text, leftWidth - 1);
      }
    }

    // Pad left panel to width
    const leftVisible = visibleLength(leftContent);
    const leftPadding = Math.max(0, leftWidth - 1 - leftVisible);
    const leftLine = leftContent + ' '.repeat(leftPadding);

    // Divider
    const divider = ansi.dim + BOX.vertical + ansi.reset;

    // Right panel content
    const contentIdx = row + state.contentScrollOffset;
    let rightContent = '';
    if (contentIdx < state.contentLines.length) {
      rightContent = truncateVisible(state.contentLines[contentIdx], rightWidth - 1);
    }

    lines.push(leftLine + divider + ' ' + rightContent + ansi.clearToEOL);
  }

  // ── Status bar ─────────────────────────────────────────────────────
  let statusText = ' ' + state.statusLine;
  if (state.hasSubtasks) {
    const filterLabels: Record<SubtaskFilterMode, string> = {
      all: 'all tasks',
      active: 'active',
      backlog: 'backlog',
    };
    statusText += `  │  [${filterLabels[state.subtaskFilterMode]}]`;
  }
  const statusPadded = statusText.padEnd(cols);
  lines.push(ansi.bg.brightBlack + ansi.fg.white + statusPadded.substring(0, cols) + ansi.reset + ansi.clearToEOL);

  // ── Help bar ───────────────────────────────────────────────────────
  const actions = [
    `${ansi.bold}Tab${ansi.reset} switch panel`,
    `${ansi.bold}↑↓${ansi.reset} navigate`,
    `${ansi.bold}Enter${ansi.reset} select`,
    ...(state.hasSubtasks ? [`${ansi.bold}]/${ansi.reset}${ansi.bold}[${ansi.reset} cycle tasks`] : []),
    ...(state.treeOverlayNodes.length > 0 ? [`${ansi.bold}t${ansi.reset}ree`] : []),
    `${ansi.bold}q${ansi.reset}uit`,
  ];
  const actionLine = ' ' + actions.join('  ');
  lines.push(truncateVisible(actionLine, cols) + ansi.clearToEOL);

  return ansi.moveTo(1, 1) + lines.join('\n');
}

// ── Status colors for overlay ──────────────────────────────────────────

const STATUS_ANSI: Record<string, string> = {
  working: ansi.fg.blue,
  queued: ansi.dim,
  blocked: ansi.fg.yellow,
  conflict: ansi.fg.red,
  pairing: ansi.fg.magenta,
  merging: ansi.fg.cyan,
  complete: ansi.fg.green,
  completed: ansi.fg.green,
  accepted: ansi.fg.green,
  zombie: ansi.fg.red,
  interrupted: ansi.fg.red,
  abandoned: ansi.fg.red,
  rejected: ansi.fg.red,
  closed: ansi.dim,
  ended: ansi.dim,
};

export function statusColor(status: string): string {
  return STATUS_ANSI[status] ?? '';
}

// ── Task tree overlay renderer ────────────────────────────────────────

/**
 * Render a fullscreen task tree overlay with ~10% margins.
 * Covers both panels. Nodes colored by status, current marked with ★.
 */
export function renderTreeOverlay(state: LayoutState): string {
  const { rows, cols } = getTerminalSize();

  // ~10% margins
  const marginY = Math.max(2, Math.floor(rows * 0.1));
  const marginX = Math.max(4, Math.floor(cols * 0.1));
  const boxWidth = cols - marginX * 2;
  const boxHeight = rows - marginY * 2;
  const innerWidth = boxWidth - 4; // 2 border + 2 padding
  const innerHeight = boxHeight - 4; // 2 border + title + hint bar

  const lines: string[] = [];

  // Fill lines above the overlay box
  for (let r = 0; r < marginY; r++) {
    lines.push(ansi.clearToEOL);
  }

  // ── Top border ──
  const title = ' Task Tree ';
  const borderBeforeTitle = Math.floor((boxWidth - title.length - 2) / 2);
  const borderAfterTitle = boxWidth - 2 - borderBeforeTitle - title.length;
  const topBorder = ' '.repeat(marginX)
    + BOX.topLeft
    + BOX.horizontal.repeat(borderBeforeTitle)
    + ansi.bold + title + ansi.reset
    + BOX.horizontal.repeat(Math.max(0, borderAfterTitle))
    + BOX.topRight;
  lines.push(topBorder + ansi.clearToEOL);

  // ── Hint line ──
  const hint = `  ${ansi.dim}↑↓ navigate  Enter open  t/Esc dismiss${ansi.reset}`;
  const hintLine = ' '.repeat(marginX) + BOX.vertical + ' ' + truncateVisible(hint, innerWidth) + ' '.repeat(Math.max(0, innerWidth - visibleLength(hint))) + ' ' + BOX.vertical;
  lines.push(hintLine + ansi.clearToEOL);

  // ── Separator ──
  const sepLine = ' '.repeat(marginX)
    + BOX.teeRight
    + BOX.horizontal.repeat(boxWidth - 2)
    + BOX.teeLeft;
  lines.push(sepLine + ansi.clearToEOL);

  // ── Tree content rows ──
  for (let row = 0; row < innerHeight; row++) {
    const nodeIdx = row + state.treeOverlayScrollOffset;
    let content = '';

    if (nodeIdx < state.treeOverlayNodes.length) {
      const node = state.treeOverlayNodes[nodeIdx];
      const isSelected = nodeIdx === state.treeOverlaySelectedIndex;

      // Build tree line with indentation
      const indent = '  '.repeat(node.depth);
      const marker = node.isCurrent ? ansi.fg.yellow + '★ ' + ansi.reset : '  ';
      const color = statusColor(node.status);
      const statusBadge = color + `[${node.status}]` + ansi.reset;
      const goalPreview = node.goal.length > (innerWidth - indent.length - node.label.length - node.status.length - 10)
        ? node.goal.substring(0, Math.max(10, innerWidth - indent.length - node.label.length - node.status.length - 13)) + '...'
        : node.goal;

      const text = `${indent}${marker}${color}${ansi.bold}${node.label}${ansi.reset} ${statusBadge} ${goalPreview}`;

      if (isSelected) {
        content = ansi.inverse + truncateVisible(text, innerWidth) + ansi.reset;
      } else {
        content = truncateVisible(text, innerWidth);
      }
    }

    const visible = visibleLength(content);
    const padding = Math.max(0, innerWidth - visible);
    const line = ' '.repeat(marginX)
      + BOX.vertical + ' '
      + content + ' '.repeat(padding)
      + ' ' + BOX.vertical;
    lines.push(line + ansi.clearToEOL);
  }

  // ── Bottom border ──
  const bottomBorder = ' '.repeat(marginX)
    + BOX.bottomLeft
    + BOX.horizontal.repeat(boxWidth - 2)
    + BOX.bottomRight;
  lines.push(bottomBorder + ansi.clearToEOL);

  // Fill lines below the overlay box
  while (lines.length < rows) {
    lines.push(ansi.clearToEOL);
  }

  return ansi.moveTo(1, 1) + lines.join('\n');
}

/**
 * Render help overlay showing all available keybindings.
 */
export function renderHelpOverlay(state: LayoutState): string {
  const { rows, cols } = getTerminalSize();

  // Keybindings organized by category
  const keybindings: Array<{ category: string; bindings: Array<{ key: string; description: string }> }> = [
    {
      category: 'Navigation',
      bindings: [
        { key: 'Tab', description: 'Switch between left/right panels' },
        { key: '↑/↓ or j/k', description: 'Navigate up/down' },
        { key: '←/→', description: 'Collapse/expand tree items (left panel)' },
        { key: 'Enter', description: 'Toggle expand/collapse (left panel)' },
        { key: 'PgUp/PgDn', description: 'Scroll page up/down (right panel)' },
        { key: 'Home/End', description: 'Jump to top/bottom (right panel)' },
        { key: 'g', description: 'Jump to top (right panel)' },
        { key: 'Shift+G', description: 'Jump to bottom (right panel)' },
      ],
    },
    {
      category: 'Actions',
      bindings: [
        { key: 't', description: 'Toggle task tree overlay' },
        { key: ']/[', description: 'Cycle through subtasks by status' },
        { key: 'Ctrl+R', description: 'Refresh task data' },
        { key: '?', description: 'Show this help' },
        { key: 'q', description: 'Quit review' },
        { key: 'Ctrl+C', description: 'Quit review' },
      ],
    },
  ];

  // Calculate required dimensions
  const maxKeyWidth = Math.max(
    ...keybindings.flatMap(cat => cat.bindings.map(b => visibleLength(b.key)))
  );
  const maxDescWidth = Math.max(
    ...keybindings.flatMap(cat => cat.bindings.map(b => visibleLength(b.description)))
  );

  // Calculate content height
  let contentHeight = 0;
  for (const cat of keybindings) {
    contentHeight += 1; // category header
    contentHeight += cat.bindings.length;
    contentHeight += 1; // spacing after category
  }

  // Box dimensions with margins
  const marginY = Math.max(2, Math.floor(rows * 0.1));
  const marginX = Math.max(4, Math.floor(cols * 0.1));
  const boxWidth = Math.min(cols - marginX * 2, maxKeyWidth + maxDescWidth + 15);
  const boxHeight = Math.min(rows - marginY * 2, contentHeight + 6);
  const innerWidth = boxWidth - 4;
  const innerHeight = boxHeight - 4;

  const lines: string[] = [];

  // Fill lines above the overlay box
  for (let r = 0; r < marginY; r++) {
    lines.push(ansi.clearToEOL);
  }

  // ── Top border ──
  const title = ' Keyboard Shortcuts ';
  const borderBeforeTitle = Math.floor((boxWidth - title.length - 2) / 2);
  const borderAfterTitle = boxWidth - 2 - borderBeforeTitle - title.length;
  const topBorder = ' '.repeat(marginX)
    + BOX.topLeft
    + BOX.horizontal.repeat(borderBeforeTitle)
    + ansi.bold + title + ansi.reset
    + BOX.horizontal.repeat(Math.max(0, borderAfterTitle))
    + BOX.topRight;
  lines.push(topBorder + ansi.clearToEOL);

  // ── Hint line ──
  const hint = `  ${ansi.dim}Press any key to dismiss${ansi.reset}`;
  const hintLine = ' '.repeat(marginX) + BOX.vertical + ' '
    + truncateVisible(hint, innerWidth)
    + ' '.repeat(Math.max(0, innerWidth - visibleLength(hint))) + ' ' + BOX.vertical;
  lines.push(hintLine + ansi.clearToEOL);

  // ── Separator ──
  const sepLine = ' '.repeat(marginX)
    + BOX.teeRight
    + BOX.horizontal.repeat(boxWidth - 2)
    + BOX.teeLeft;
  lines.push(sepLine + ansi.clearToEOL);

  // ── Content rows ──
  let currentRow = 0;
  for (const cat of keybindings) {
    if (currentRow >= innerHeight) break;

    // Category header
    const categoryHeader = ansi.bold + ansi.fg.cyan + cat.category + ansi.reset;
    const categoryLine = ' '.repeat(marginX) + BOX.vertical + ' '
      + categoryHeader + ' '.repeat(Math.max(0, innerWidth - visibleLength(cat.category)))
      + ' ' + BOX.vertical;
    lines.push(categoryLine + ansi.clearToEOL);
    currentRow++;

    // Bindings in this category
    for (const binding of cat.bindings) {
      if (currentRow >= innerHeight) break;

      const key = ansi.fg.yellow + binding.key.padEnd(maxKeyWidth + 2) + ansi.reset;
      const desc = binding.description;
      const content = key + desc;
      const padding = Math.max(0, innerWidth - visibleLength(content));

      const bindingLine = ' '.repeat(marginX) + BOX.vertical + ' '
        + content + ' '.repeat(padding)
        + ' ' + BOX.vertical;
      lines.push(bindingLine + ansi.clearToEOL);
      currentRow++;
    }

    // Spacing after category
    if (currentRow < innerHeight) {
      const emptyLine = ' '.repeat(marginX) + BOX.vertical + ' '
        + ' '.repeat(innerWidth)
        + ' ' + BOX.vertical;
      lines.push(emptyLine + ansi.clearToEOL);
      currentRow++;
    }
  }

  // Fill remaining content rows
  while (currentRow < innerHeight) {
    const emptyLine = ' '.repeat(marginX) + BOX.vertical + ' '
      + ' '.repeat(innerWidth)
      + ' ' + BOX.vertical;
    lines.push(emptyLine + ansi.clearToEOL);
    currentRow++;
  }

  // ── Bottom border ──
  const bottomBorder = ' '.repeat(marginX)
    + BOX.bottomLeft
    + BOX.horizontal.repeat(boxWidth - 2)
    + BOX.bottomRight;
  lines.push(bottomBorder + ansi.clearToEOL);

  // Fill lines below the overlay box
  while (lines.length < rows) {
    lines.push(ansi.clearToEOL);
  }

  return ansi.moveTo(1, 1) + lines.join('\n');
}

// ── Content formatting helpers ─────────────────────────────────────────

/**
 * Wrap a single line to a given visible width, preserving ANSI codes.
 * Breaks at word boundaries when possible, hard-breaks otherwise.
 */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (visibleLength(line) <= width) return [line];

  const results: string[] = [];
  let currentLine = '';
  let currentVisible = 0;
  let inEscape = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === '\x1b') {
      // Collect the entire escape sequence
      let esc = ch;
      i++;
      while (i < line.length) {
        esc += line[i];
        if (line[i] === 'm') { i++; break; }
        i++;
      }
      currentLine += esc;
      continue;
    }

    if (currentVisible >= width) {
      // Try to break at last space
      const lastSpace = currentLine.lastIndexOf(' ');
      if (lastSpace > 0 && visibleLength(currentLine.substring(0, lastSpace)) > width / 3) {
        results.push(currentLine.substring(0, lastSpace) + ansi.reset);
        // Carry over the rest (strip leading space)
        const remainder = currentLine.substring(lastSpace + 1);
        currentLine = remainder;
        currentVisible = visibleLength(remainder);
      } else {
        results.push(currentLine + ansi.reset);
        currentLine = '';
        currentVisible = 0;
      }
    }

    currentLine += ch;
    currentVisible++;
    i++;
  }

  if (currentLine) {
    results.push(currentLine);
  }

  return results;
}

/**
 * Wrap an array of content lines to fit within a given visible width.
 * Each input line that exceeds the width is broken into multiple output lines.
 * ANSI escape codes are preserved across breaks.
 */
export function wrapLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const line of lines) {
    result.push(...wrapLine(line, width));
  }
  return result;
}

/**
 * Apply basic syntax coloring to unified diff text.
 */
export function colorDiff(diffText: string): string[] {
  return diffText.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return ansi.bold + line + ansi.reset;
    }
    if (line.startsWith('+')) {
      return ansi.fg.green + line + ansi.reset;
    }
    if (line.startsWith('-')) {
      return ansi.fg.red + line + ansi.reset;
    }
    if (line.startsWith('@@')) {
      return ansi.fg.cyan + line + ansi.reset;
    }
    if (line.startsWith('diff ')) {
      return ansi.bold + ansi.fg.yellow + line + ansi.reset;
    }
    return line;
  });
}

/**
 * Format markdown-like text with basic ANSI styling.
 * Re-exported from utils/markdown for backward compatibility.
 */
export const formatMarkdown = _formatMarkdown;
