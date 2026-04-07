/**
 * Dashboard TUI for `lazy review` (no task ID).
 *
 * Shows all non-terminal tasks in a tree rooted at "main", with periodic
 * auto-refresh. Selecting a task drills into the existing single-task
 * review view.
 */

import { Terminal, getTerminalSize, ansi, truncateVisible, visibleLength } from './terminal';
import { statusColor } from './renderer';
import { shortId, displayId, formatDate } from '../helpers';
import { isTerminalStatus } from '../../task-state-machine';
import { runReviewTUI } from './review';
import type { Task } from '../../types';
import type { Storage } from '../../storage';

// ── Types ─────────────────────────────────────────────────────────────

interface DashboardNode {
  task: Task;
  children: DashboardNode[];
  depth: number;
}

interface FlatDashboardNode {
  task: Task;
  depth: number;
}

interface DashboardState {
  nodes: FlatDashboardNode[];
  selectedIndex: number;
  scrollOffset: number;
  lastRefreshTime: number;
  refreshing: boolean;
  allTasks: Task[];  // for status bar counts
}

// ── Tree building ─────────────────────────────────────────────────────

function buildTaskForest(tasks: Task[]): FlatDashboardNode[] {
  // Group tasks by parent
  const childrenOf = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const parentKey = t.parent_task_id;
    const existing = childrenOf.get(parentKey) ?? [];
    existing.push(t);
    childrenOf.set(parentKey, existing);
  }

  // Known task IDs for detecting orphans (parent was terminal/filtered out)
  const knownIds = new Set(tasks.map(t => t.id));

  // Build tree recursively
  function buildChildren(parentId: string | null, depth: number): DashboardNode[] {
    const children = childrenOf.get(parentId) ?? [];
    // Sort: working first, then blocked, then rest, alphabetical within group
    children.sort((a, b) => {
      const order = statusOrder(a.status) - statusOrder(b.status);
      if (order !== 0) return order;
      return a.goal.localeCompare(b.goal);
    });
    return children.map(task => ({
      task,
      depth,
      children: buildChildren(task.id, depth + 1),
    }));
  }

  // Top-level = tasks with no parent OR whose parent is not in the active set
  const topLevel: Task[] = [];
  for (const t of tasks) {
    if (!t.parent_task_id || !knownIds.has(t.parent_task_id)) {
      topLevel.push(t);
    }
  }
  // Remove these from the null-parent bucket since we handle them explicitly
  const roots = topLevel.map(task => ({
    task,
    depth: 0,
    children: buildChildren(task.id, 1),
  }));
  roots.sort((a, b) => {
    const order = statusOrder(a.task.status) - statusOrder(b.task.status);
    if (order !== 0) return order;
    return a.task.goal.localeCompare(b.task.goal);
  });

  // Flatten
  const flat: FlatDashboardNode[] = [];
  function flatten(node: DashboardNode): void {
    flat.push({ task: node.task, depth: node.depth });
    for (const child of node.children) {
      flatten(child);
    }
  }
  for (const root of roots) {
    flatten(root);
  }
  return flat;
}

function statusOrder(status: string): number {
  switch (status) {
    case 'blocked': return 0;
    case 'conflict': return 1;
    case 'pairing': return 2;
    case 'submitted': return 3;
    case 'merging': return 4;
    case 'working': return 5;
    case 'interrupted': return 6;
    case 'zombie': return 7;
    case 'backlog': return 8;
    default: return 9;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

const BOX_H = '─';
const BOX_V = '│';

function renderDashboard(state: DashboardState): string {
  const { rows, cols } = getTerminalSize();
  const lines: string[] = [];

  // Header
  const headerText = ' lazy review — Active Tasks';
  const headerPadded = headerText + ' '.repeat(Math.max(0, cols - visibleLength(headerText)));
  lines.push(ansi.bg.blue + ansi.fg.white + ansi.bold + headerPadded + ansi.reset + ansi.clearToEOL);

  // Border
  lines.push(ansi.dim + BOX_H.repeat(cols) + ansi.reset + ansi.clearToEOL);

  // Content area
  const contentHeight = rows - 4; // header + border + status bar + help bar

  if (state.nodes.length === 0) {
    // Empty state
    const emptyMsg = 'No active tasks.';
    const pad = Math.floor((cols - emptyMsg.length) / 2);
    const emptyRow = Math.floor(contentHeight / 2);
    for (let row = 0; row < contentHeight; row++) {
      if (row === emptyRow) {
        lines.push(ansi.dim + ' '.repeat(pad) + emptyMsg + ansi.reset + ansi.clearToEOL);
      } else {
        lines.push(ansi.clearToEOL);
      }
    }
  } else {
    for (let row = 0; row < contentHeight; row++) {
      const idx = row + state.scrollOffset;
      if (idx < state.nodes.length) {
        const node = state.nodes[idx];
        const isSelected = idx === state.selectedIndex;

        const indent = '  '.repeat(node.depth);
        const treeChar = node.depth > 0 ? '├ ' : '';
        const color = statusColor(node.task.status);
        const statusBadge = color + `[${node.task.status}]` + ansi.reset;
        const label = displayId(node.task);
        const model = node.task.model ? ansi.dim + ` (${node.task.model})` + ansi.reset : '';

        // Calculate how much space is left for the goal
        const prefixLen = indent.length + treeChar.length + label.length
          + node.task.status.length + 3 /* brackets+space */ + (node.task.model ? node.task.model.length + 3 : 0);
        const goalSpace = cols - prefixLen - 4; // margin
        const goal = node.task.goal.length > goalSpace && goalSpace > 10
          ? node.task.goal.substring(0, goalSpace - 3) + '...'
          : node.task.goal;

        const text = `${indent}${treeChar}${color}${ansi.bold}${label}${ansi.reset} ${statusBadge} ${goal}${model}`;

        if (isSelected) {
          lines.push(ansi.inverse + truncateVisible(text, cols) + ansi.reset + ansi.clearToEOL);
        } else {
          lines.push(truncateVisible(text, cols) + ansi.clearToEOL);
        }
      } else {
        lines.push(ansi.clearToEOL);
      }
    }
  }

  // Status bar
  const working = state.allTasks.filter(t => t.status === 'working').length;
  const blocked = state.allTasks.filter(t => t.status === 'blocked').length;
  const conflict = state.allTasks.filter(t => t.status === 'conflict').length;
  const total = state.allTasks.length;

  const refreshIndicator = state.refreshing ? ' ↻' : '';
  const lastRefresh = formatDate(state.lastRefreshTime);
  let statusParts = ` ${total} tasks`;
  if (working > 0) statusParts += `  │  ${working} working`;
  if (blocked > 0) statusParts += `  │  ${blocked} blocked`;
  if (conflict > 0) statusParts += `  │  ${conflict} conflict`;
  statusParts += `  │  ${lastRefresh}${refreshIndicator}`;
  const statusPadded = statusParts.padEnd(cols);
  lines.push(ansi.bg.brightBlack + ansi.fg.white + statusPadded.substring(0, cols) + ansi.reset + ansi.clearToEOL);

  // Help bar
  const actions = [
    `${ansi.bold}Enter${ansi.reset} open`,
    `${ansi.bold}r${ansi.reset}efresh`,
    `${ansi.bold}q${ansi.reset}uit`,
  ];
  const actionLine = ' ' + actions.join('  ');
  lines.push(truncateVisible(actionLine, cols) + ansi.clearToEOL);

  return ansi.moveTo(1, 1) + lines.join('\n');
}

// ── Scroll helper ─────────────────────────────────────────────────────

function ensureVisible(state: DashboardState): void {
  const { rows } = getTerminalSize();
  const contentHeight = rows - 4;
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + contentHeight) {
    state.scrollOffset = state.selectedIndex - contentHeight + 1;
  }
}

// ── Data fetching ─────────────────────────────────────────────────────

async function fetchActiveTasks(storage: Storage): Promise<Task[]> {
  const all = await storage.listTasks();
  return all.filter(t => !isTerminalStatus(t.status));
}

// ── Fingerprint for change detection ──────────────────────────────────

function fingerprint(tasks: Task[]): string {
  return tasks.map(t => `${t.id}:${t.status}`).sort().join(',');
}

// ── Main entry point ──────────────────────────────────────────────────

export async function runDashboardTUI(storage: Storage, root: string): Promise<void> {
  const terminal = new Terminal();

  const tasks = await fetchActiveTasks(storage);
  const state: DashboardState = {
    nodes: buildTaskForest(tasks),
    selectedIndex: 0,
    scrollOffset: 0,
    lastRefreshTime: Date.now(),
    refreshing: false,
    allTasks: tasks,
  };

  let currentFingerprint = fingerprint(tasks);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  return new Promise<void>((resolve) => {
    terminal.enter();

    function draw(): void {
      terminal.write(renderDashboard(state));
    }

    function cleanup(): void {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      terminal.exit();
      resolve();
    }

    async function refreshData(): Promise<void> {
      if (state.refreshing) return;
      state.refreshing = true;
      draw();

      try {
        const freshTasks = await fetchActiveTasks(storage);
        const freshFP = fingerprint(freshTasks);

        // Only rebuild if data changed
        if (freshFP !== currentFingerprint) {
          currentFingerprint = freshFP;

          // Preserve selection by task ID
          const selectedTaskId = state.nodes[state.selectedIndex]?.task.id;

          state.allTasks = freshTasks;
          state.nodes = buildTaskForest(freshTasks);

          // Restore selection
          if (selectedTaskId) {
            const newIdx = state.nodes.findIndex(n => n.task.id === selectedTaskId);
            if (newIdx >= 0) {
              state.selectedIndex = newIdx;
            } else {
              state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.nodes.length - 1));
            }
          }
          ensureVisible(state);
        }

        state.lastRefreshTime = Date.now();
      } catch {
        // Safe to suppress: refresh is periodic and best-effort. On failure the
        // user sees the previous (still valid) task list, and the next auto-refresh
        // in 5s will retry. No data is lost or corrupted — only the timestamp
        // won't advance, which signals staleness to the user.
      }

      state.refreshing = false;
      draw();
    }

    // Auto-refresh every 5 seconds
    refreshTimer = setInterval(() => {
      refreshData();
    }, 5000);

    terminal.onResize(() => {
      draw();
    });

    terminal.onKey(async (key) => {
      // Ctrl+C always quits
      if (key.ctrl && key.name === 'c') {
        cleanup();
        return;
      }

      if (key.name === 'q') {
        cleanup();
        return;
      }

      if (key.name === 'r') {
        await refreshData();
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          ensureVisible(state);
        }
        draw();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        if (state.selectedIndex < state.nodes.length - 1) {
          state.selectedIndex++;
          ensureVisible(state);
        }
        draw();
        return;
      }

      if (key.name === 'pageup') {
        const { rows } = getTerminalSize();
        const pageSize = rows - 4;
        state.selectedIndex = Math.max(0, state.selectedIndex - pageSize);
        ensureVisible(state);
        draw();
        return;
      }

      if (key.name === 'pagedown') {
        const { rows } = getTerminalSize();
        const pageSize = rows - 4;
        state.selectedIndex = Math.min(state.nodes.length - 1, state.selectedIndex + pageSize);
        ensureVisible(state);
        draw();
        return;
      }

      if (key.name === 'home') {
        state.selectedIndex = 0;
        state.scrollOffset = 0;
        draw();
        return;
      }

      if (key.name === 'end') {
        state.selectedIndex = Math.max(0, state.nodes.length - 1);
        ensureVisible(state);
        draw();
        return;
      }

      if (key.name === 'return') {
        const node = state.nodes[state.selectedIndex];
        if (!node) return;

        // Pause auto-refresh while in single-task view
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }

        // Exit dashboard terminal mode before entering review TUI
        terminal.exit();

        // Drill into single-task review
        const task = node.task;
        const session = await storage.getSessionByTaskId(task.id);
        await runReviewTUI(storage, task, session ?? null, root);

        // Return to dashboard — re-enter terminal and refresh
        terminal.enter();
        await refreshData();

        // Restart auto-refresh
        refreshTimer = setInterval(() => {
          refreshData();
        }, 5000);

        draw();
        return;
      }
    });

    draw();
  });
}
