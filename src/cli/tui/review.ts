/**
 * TUI Review Interface for blocked tasks.
 *
 * Shows a two-panel layout with navigation on the left and content on the right.
 * Replaces the $EDITOR-based review flow with a richer, interactive experience.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { Terminal, getTerminalSize, type KeyPress } from './terminal';
import { render, renderTreeOverlay, renderHelpOverlay, flattenNavItems, formatMarkdown, colorDiff, wrapLines, statusColor, type NavItem, type LayoutState, type TreeOverlayNode, type SubtaskFilterMode } from './renderer';
import { getDiffStat, getDiffFull, getCurrentBranch, getRemoteDefaultBranch, getCommitDiff, getCommitChangedFiles, getFileAtCommit, branchExists, recoverMissingWorktreeWithFetch } from '../../git/operations';
import { shortId, displayId, requireStorage, formatDate, getWorktreePath, getBranchName, getBranchNameFromId } from '../helpers';
import type { TaskTreeNode } from '../../storage/types';
import { getNewNotesSince } from '../commands/shared';
import { groupTurnsIntoChunks } from '../../utils/turn-chunks';
import type { Task, Session, Turn, Comment, Commit, JournalEntry, FollowUp } from '../../types';
import { parentTaskIdOf } from '../../task-target';
import type { Storage } from '../../storage';
import { getDataDir } from '../init';
import { ansi } from './terminal';
import { loadConfig } from '../../config/loader';
import type { ResolvedConfig } from '../../config/types';
import { turnText } from '../../utils/turn-content';

// ── Review result ──────────────────────────────────────────────────────

export type ReviewAction = { type: 'quit' };

// ── Data loading ───────────────────────────────────────────────────────

/** Precomputed data for a single turn (agent or human). */
interface TurnInfo {
  turn: Turn;
  commits: Commit[];
  diffFull: string;         // full diff for this turn only
  diffFiles: string[];      // files changed in this turn
}

export interface ReviewData {
  task: Task;
  session: Session | null;
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  unseenComments: Comment[];
  /** Append-only, prompt-immune journal entries (orchestration metadata / memories). */
  journal: JournalEntry[];
  /** Passive, agent-recorded orthogonal-work notes. Display-only — never triggers anything. */
  followUps: FollowUp[];
  diffStat: string;
  diffFull: string;
  worktreePath: string;
  targetBranch: string;
  lastAgentTurn: Turn | null;
  /** Per-agent-turn precomputed data, keyed by turn sequence number. */
  turnInfoMap: Map<number, TurnInfo>;
  /** Task tree from root, null if no parent and no children. */
  taskTree: TaskTreeNode | null;
  /** Direct child tasks. */
  childTasks: Task[];
  /** Parent task, null if no parent. */
  parentTask: Task | null;
}

export async function loadReviewData(
  storage: Storage,
  task: Task,
  session: Session | null,
  root: string,
  config?: ResolvedConfig,
): Promise<ReviewData> {
  const taskShortId = shortId(task.id);
  const worktreePath = getWorktreePath(root, task);

  const parentId = parentTaskIdOf(task);

  // Determine target branch
  let targetBranch: string;
  if (parentId) {
    targetBranch = await getBranchNameFromId(parentId, storage);
  } else {
    targetBranch = await getRemoteDefaultBranch(root);
  }

  // Load all data in parallel (skip session-specific data if no session)
  const [turns, commits, comments, journal, followUps, parentTask] = await Promise.all([
    session ? storage.getSessionTurns(session.id) : Promise.resolve([]),
    session ? storage.getSessionCommits(session.id) : Promise.resolve([]),
    storage.getTaskComments(task.id),
    storage.getTaskJournal(task.id),
    storage.getTaskFollowUps(task.id),
    parentId ? storage.getTask(parentId) : Promise.resolve(null),
  ]);

  const lastAgentTurn = turns.filter(t => t.role === 'agent').pop() ?? null;
  const unseenComments = lastAgentTurn
    ? getNewNotesSince(comments, lastAgentTurn.timestamp)
    : comments;

  // Load diff — prefer worktree (has uncommitted changes), fall back to
  // branch-based diff from the main repo when the worktree is gone (e.g.
  // accepted subtasks whose worktrees have been cleaned up).
  let diffStat = '';
  let diffFull = '';
  if (existsSync(worktreePath)) {
    try {
      diffStat = await getDiffStat(targetBranch, 'HEAD', worktreePath) || '';
    } catch { /* branch may not exist */ }
    try {
      diffFull = await getDiffFull(targetBranch, 'HEAD', worktreePath) || '';
    } catch { /* branch may not exist */ }
  } else {
    // Worktree gone — try to recover from local or remote branch
    const taskBranch = session?.git_branch ?? getBranchName(task);
    const resolvedConfig = config ?? await loadConfig(root);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, taskBranch, resolvedConfig.remote.git_remote, root,
      );
      if (recovery.recovered) {
        // Worktree recovered — use it for diffing
        try {
          diffStat = await getDiffStat(targetBranch, 'HEAD', worktreePath) || '';
        } catch { /* branch may not exist */ }
        try {
          diffFull = await getDiffFull(targetBranch, 'HEAD', worktreePath) || '';
        } catch { /* branch may not exist */ }
      } else if (await branchExists(taskBranch, root)) {
        // Recovery failed but branch exists locally — diff from main repo root
        try {
          diffStat = await getDiffStat(targetBranch, taskBranch, root) || '';
        } catch { /* branch comparison may fail */ }
        try {
          diffFull = await getDiffFull(targetBranch, taskBranch, root) || '';
        } catch { /* branch comparison may fail */ }
      }
      // else: no worktree, no branch — fall through to empty diff
    } catch {
      // Recovery attempt failed — fall through to empty diff
      // Review should still work without diffs
    }
  }

  // Precompute per-turn data for ALL turns (human and agent)
  const sortedTurns = [...turns].sort((a, b) => a.sequence - b.sequence);
  const commitsByTurn = partitionCommitsByTurn(sortedTurns, commits);

  const turnInfoMap = new Map<number, TurnInfo>();
  for (const turn of sortedTurns) {
    const turnCommits = commitsByTurn.get(turn.sequence) ?? [];

    // Turn diff = combined diff of its commits. No commits = no diff.
    // Use worktree if available, otherwise fall back to main repo root
    // (commit SHAs are repo-wide so getCommitDiff works from any cwd).
    let turnDiffFull = '';
    let turnDiffFiles: string[] = [];
    const diffCwd = existsSync(worktreePath) ? worktreePath : root;
    if (turnCommits.length > 0) {
      const diffs: string[] = [];
      for (const c of turnCommits) {
        try {
          const d = await getCommitDiff(c.sha, diffCwd);
          if (d) diffs.push(d);
        } catch { /* commit may not be accessible */ }
      }
      turnDiffFull = diffs.join('\n');
      turnDiffFiles = extractDiffFiles(turnDiffFull);
    }

    turnInfoMap.set(turn.sequence, {
      turn,
      commits: turnCommits,
      diffFull: turnDiffFull,
      diffFiles: turnDiffFiles,
    });
  }

  // Build task tree if this task is part of a hierarchy
  let taskTree: TaskTreeNode | null = null;
  const childTasks = await storage.getChildTasks(task.id);
  if (parentId || childTasks.length > 0) {
    const rootTask = await storage.getRootTask(task.id);
    if (rootTask) {
      taskTree = await storage.getTaskTree(rootTask.id);
    }
  }

  return {
    task, session, turns, commits, comments, unseenComments, journal, followUps,
    diffStat, diffFull, worktreePath, targetBranch, lastAgentTurn,
    turnInfoMap, taskTree, childTasks, parentTask,
  };
}

/**
 * Load ReviewData for a task that may not have a session.
 * Returns minimal data for sessionless tasks.
 */
async function loadReviewDataForSubtask(
  storage: Storage,
  task: Task,
  root: string,
  config?: ResolvedConfig,
): Promise<ReviewData> {
  const sess = await storage.getSessionByTaskId(task.id);
  if (sess) {
    return loadReviewData(storage, task, sess, root, config);
  }

  // Minimal data for tasks without sessions
  const childTasks = await storage.getChildTasks(task.id);
  const parentId = parentTaskIdOf(task);
  const parentTask = parentId
    ? await storage.getTask(parentId)
    : null;

  const worktreePath = getWorktreePath(root, task);

  // Backlog tasks have never been started — no branch, no worktree, no diff.
  // Skip branch recovery entirely to avoid spurious fetch attempts.
  if (task.status === 'backlog') {
    return {
      task,
      session: null,
      turns: [],
      commits: [],
      comments: await storage.getTaskComments(task.id),
      unseenComments: [],
      journal: await storage.getTaskJournal(task.id),
      followUps: await storage.getTaskFollowUps(task.id),
      diffStat: '',
      diffFull: '',
      worktreePath,
      targetBranch: '',
      lastAgentTurn: null,
      turnInfoMap: new Map(),
      taskTree: null,
      childTasks,
      parentTask,
    };
  }

  // Non-backlog sessionless tasks (e.g., completed with cleaned-up session,
  // or missing session record) — still try to get branch diff
  // Determine target branch for diff
  let targetBranch = '';
  if (parentId) {
    targetBranch = await getBranchNameFromId(parentId, storage);
  } else {
    targetBranch = await getRemoteDefaultBranch(root);
  }

  let diffStat = '';
  let diffFull = '';
  const taskBranch = getBranchName(task);
  if (existsSync(worktreePath)) {
    try { diffStat = await getDiffStat(targetBranch, 'HEAD', worktreePath) || ''; } catch { /* */ }
    try { diffFull = await getDiffFull(targetBranch, 'HEAD', worktreePath) || ''; } catch { /* */ }
  } else {
    // Worktree gone — try to recover from local or remote branch
    const resolvedConfig = config ?? await loadConfig(root);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, taskBranch, resolvedConfig.remote.git_remote, root,
      );
      if (recovery.recovered) {
        // Worktree recovered — use it for diffing
        try { diffStat = await getDiffStat(targetBranch, 'HEAD', worktreePath) || ''; } catch { /* */ }
        try { diffFull = await getDiffFull(targetBranch, 'HEAD', worktreePath) || ''; } catch { /* */ }
      } else if (await branchExists(taskBranch, root)) {
        // Recovery failed but branch exists locally — diff from main repo root
        try { diffStat = await getDiffStat(targetBranch, taskBranch, root) || ''; } catch { /* */ }
        try { diffFull = await getDiffFull(targetBranch, taskBranch, root) || ''; } catch { /* */ }
      }
      // else: no worktree, no branch — fall through to empty diff
    } catch {
      // Recovery attempt failed — fall through to empty diff
      // Review should still work without diffs
    }
  }

  return {
    task,
    session: null,
    turns: [],
    commits: [],
    comments: await storage.getTaskComments(task.id),
    unseenComments: [],
    journal: await storage.getTaskJournal(task.id),
    followUps: await storage.getTaskFollowUps(task.id),
    diffStat,
    diffFull,
    worktreePath,
    targetBranch,
    lastAgentTurn: null,
    turnInfoMap: new Map(),
    taskTree: null,
    childTasks,
    parentTask,
  };
}

/**
 * Recursively load ReviewData for all descendant tasks.
 * Returns a Map keyed by short task ID.
 */
async function loadSubtaskDataMap(
  storage: Storage,
  rootTask: Task,
  root: string,
): Promise<Map<string, ReviewData>> {
  const map = new Map<string, ReviewData>();
  const visited = new Set<string>();

  // Load config once for all subtasks to avoid repeated disk reads
  const config = await loadConfig(root);

  async function loadChildren(parentId: string): Promise<void> {
    const children = await storage.getChildTasks(parentId);
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);

      const data = await loadReviewDataForSubtask(storage, child, root, config);
      map.set(shortId(child.id), data);
      await loadChildren(child.id);
    }
  }

  await loadChildren(rootTask.id);
  return map;
}

// ── Build navigation items ─────────────────────────────────────────────

/**
 * Build a NavItem for a task node (root or sub-task).
 * Ensures consistent icon, label, and badge rendering across all task nodes.
 */
function buildTaskNavItem(opts: {
  task: Task;
  key: string;
  children: NavItem[] | undefined;
  expanded: boolean;
}): NavItem {
  const goalPreview = opts.task.goal.length > 40
    ? opts.task.goal.substring(0, 37) + '...'
    : opts.task.goal;
  return {
    key: opts.key,
    label: `${displayId(opts.task)} ${goalPreview}`,
    icon: statusColor(opts.task.status) + '●' + ansi.reset,
    badge: opts.task.status,
    children: opts.children,
    expanded: opts.expanded,
  };
}

/**
 * Build NavItem tree for a task's review data, with recursive Sub-tasks.
 * @param data - ReviewData for this task
 * @param dataMap - Map of short task ID → ReviewData for all sub-tasks
 * @param keyPrefix - Key prefix for namespacing ('' for main task, 'st:abc:' for sub-tasks)
 * @param visited - Set of visited task IDs (cycle detection)
 */
export function buildNavItemsForTask(
  data: ReviewData,
  dataMap: Map<string, ReviewData>,
  keyPrefix: string = '',
  visited: Set<string> = new Set(),
): NavItem[] {
  const items: NavItem[] = [];
  visited.add(data.task.id);

  // ── Goal & Prompt ──────────────────────────────────────────────────
  items.push({
    key: `${keyPrefix}goal-prompt`,
    label: 'Goal & Prompt',
    icon: '🎯',
    expanded: false,
  });

  // ── Turns (grouped into review chunks; newest chunk/turn first) ─────
  // A chunk is one human/builder review boundary plus its following
  // agent/supervisor/system turns — grouped via the single source of truth so
  // intermediate auto-resume/supervisor turns are navigated WITH their boundary
  // instead of being skipped past. Turn-node keys are unchanged (content routing
  // still keys on `turn-node:<seq>`); chunk nodes are a new grouping level.
  if (data.turns.length > 0) {
    const ascending = [...data.turns].sort((a, b) => a.sequence - b.sequence);
    const chunks = groupTurnsIntoChunks(ascending);
    const newestSeq = ascending[ascending.length - 1].sequence;

    const buildTurnNode = (turn: Turn): NavItem => {
      const icon = turn.role === 'human'
        ? (turn.actor === 'supervisor' || turn.actor === 'system' ? '⚙️' : '👤')
        : '🤖';
      // Provenance: name the authoring actor for non-human human-role turns and
      // flag auto-triggered turns, so the reviewer can tell automation from human.
      const actorSuffix = turn.role === 'human' && turn.actor && turn.actor !== 'human'
        ? ` [${turn.actor}]` : '';
      const autoSuffix = turn.auto_triggered ? ' (auto)' : '';
      const children = buildTurnChildren(turn, data, keyPrefix);
      return {
        key: `${keyPrefix}turn-node:${turn.sequence}`,
        label: `Turn #${turn.sequence}${actorSuffix}${autoSuffix}`,
        icon,
        children: children.length > 0 ? children : undefined,
        expanded: turn.sequence === newestSeq, // expand the newest turn by default
      };
    };

    // Chunk nodes newest-first; turns within each chunk newest-first.
    const chunkNodes: NavItem[] = [...chunks].reverse().map(chunk => {
      const turnNodes = [...chunk.turns].reverse().map(buildTurnNode);
      const b = chunk.boundary;
      const boundaryLabel = b
        ? `#${b.sequence} ${b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role}`
        : 'leading auto turns';
      return {
        key: `${keyPrefix}chunk:${chunk.index}`,
        label: `Chunk ${chunk.index + 1} · ${boundaryLabel}`,
        icon: '🧩',
        badge: `${chunk.turns.length}`,
        children: turnNodes,
        expanded: chunk.index === chunks.length - 1, // expand the newest chunk
      };
    });

    items.push({
      key: `${keyPrefix}turns`,
      label: 'Turns',
      icon: '🔄',
      badge: `${data.turns.length}`,
      children: chunkNodes,
      expanded: keyPrefix === '', // only expand turns at top level
    });
  }

  // ── Comments (top-level, peer of Turns) ──────────────────────────
  if (data.comments.length > 0) {
    const unseenBadge = data.unseenComments.length > 0
      ? `${data.unseenComments.length} new`
      : undefined;

    const sorted = [...data.comments].reverse();
    const commentChildren: NavItem[] = sorted.map(note => {
      const isUnseen = data.unseenComments.some(n => n.id === note.id);
      const firstLine = note.content.split('\n')[0];
      const preview = firstLine.length > 25 ? firstLine.substring(0, 22) + '...' : firstLine;
      return {
        key: `${keyPrefix}comment:${note.id}`,
        label: preview,
        icon: '✍️',
        badge: isUnseen ? 'new' : undefined,
      };
    });

    items.push({
      key: `${keyPrefix}comments`,
      label: 'Comments',
      icon: '✍️',
      badge: unseenBadge || `${data.comments.length}`,
      children: commentChildren,
      expanded: false,
    });
  }

  // ── Journal (top-level, peer of Comments) ────────────────────────
  // Append-only, prompt-immune side channel. No unseen tracking — journal
  // entries are never delivered to the agent, so "seen by agent" is moot.
  if (data.journal.length > 0) {
    const sorted = [...data.journal].reverse();
    const journalChildren: NavItem[] = sorted.map(entry => {
      const firstLine = entry.content.split('\n')[0];
      const preview = firstLine.length > 25 ? firstLine.substring(0, 22) + '...' : firstLine;
      return {
        key: `${keyPrefix}journal-entry:${entry.id}`,
        label: preview,
        icon: '📓',
      };
    });

    items.push({
      key: `${keyPrefix}journal`,
      label: 'Journal',
      icon: '📓',
      badge: `${data.journal.length}`,
      children: journalChildren,
      expanded: false,
    });
  }

  // ── Follow-ups (top-level, peer of Comments) ─────────────────────
  // Passive, agent-recorded orthogonal-work notes — display only.
  if (data.followUps.length > 0) {
    const sorted = [...data.followUps].reverse();
    const followUpChildren: NavItem[] = sorted.map(f => {
      const firstLine = f.content.split('\n')[0];
      const preview = firstLine.length > 25 ? firstLine.substring(0, 22) + '...' : firstLine;
      return {
        key: `${keyPrefix}followup:${f.id}`,
        label: preview,
        icon: '📌',
      };
    });

    items.push({
      key: `${keyPrefix}followups`,
      label: 'Follow-ups',
      icon: '📌',
      badge: `${data.followUps.length}`,
      children: followUpChildren,
      expanded: false,
    });
  }

  // ── All Commits (descending — newest first) ────────────────────────
  if (data.commits.length > 0) {
    const descCommits = [...data.commits].reverse();
    const commitChildren: NavItem[] = descCommits.map(c => ({
      key: `${keyPrefix}commit:${c.sha}`,
      label: `${c.sha.substring(0, 7)} ${c.message.substring(0, 25)}`,
      icon: '•',
    }));

    items.push({
      key: `${keyPrefix}commits`,
      label: 'Commits',
      icon: '📦',
      badge: `${data.commits.length}`,
      children: commitChildren,
      expanded: false,
    });
  }

  // ── All Diffs ──────────────────────────────────────────────────────
  if (data.diffFull) {
    const files = extractDiffFiles(data.diffFull);
    const diffChildren: NavItem[] = files.map(f => ({
      key: `${keyPrefix}diff:${f}`,
      label: f,
      icon: '📄',
    }));

    items.push({
      key: `${keyPrefix}diff`,
      label: 'Diff',
      icon: '±',
      badge: `${files.length}`,
      children: diffChildren,
      expanded: false,
    });
  }

  // ── Sub-tasks (recursive) ──────────────────────────────────────────
  if (data.childTasks.length > 0) {
    const subtaskChildren: NavItem[] = [];

    for (const child of data.childTasks) {
      if (visited.has(child.id)) continue;

      const childShortId = shortId(child.id);
      const childData = dataMap.get(childShortId);

      const childPrefix = `${keyPrefix}st:${childShortId}:`;
      const childSections = childData
        ? buildNavItemsForTask(childData, dataMap, childPrefix, visited)
        : [];

      subtaskChildren.push(buildTaskNavItem({
        task: child,
        key: `${keyPrefix}st:${childShortId}:root`,
        children: childSections.length > 0 ? childSections : undefined,
        expanded: false,
      }));
    }

    if (subtaskChildren.length > 0) {
      items.push({
        key: `${keyPrefix}subtasks`,
        label: 'Sub-tasks',
        icon: '🔀',
        badge: `${data.childTasks.length}`,
        children: subtaskChildren,
        expanded: false,
      });
    }
  }

  return items;
}

/**
 * Build child nav items for any turn (human or agent).
 * Agent turns get: Plan, Commits, Diff
 * Human turns get: Prompt (full prompt sent to agent), Commits, Diff
 * The turn's content is shown directly when the turn node itself is selected.
 */
function buildTurnChildren(turn: Turn, data: ReviewData, keyPrefix: string = ''): NavItem[] {
  const children: NavItem[] = [];
  const seq = turn.sequence;
  const info = data.turnInfoMap.get(seq);

  // Prompt (human turns only, if available)
  if (turn.role === 'human' && turn.prompt) {
    children.push({
      key: `${keyPrefix}turn-prompt:${seq}`,
      label: 'Prompt',
      icon: '📝',
      badge: undefined,
    });
  }

  // Plan (agent turns only)
  if (turn.role === 'agent') {
    const plan = extractPlanFromContent(turnText(turn));
    children.push({
      key: `${keyPrefix}turn-plan:${seq}`,
      label: 'Plan',
      icon: '📋',
      badge: plan ? undefined : 'none',
    });
  }

  // Commits for this turn (descending — newest first)
  const turnCommits = [...(info?.commits ?? [])].reverse();
  if (turnCommits.length > 0) {
    const commitChildren: NavItem[] = turnCommits.map(c => ({
      key: `${keyPrefix}commit:${c.sha}`,
      label: `${c.sha.substring(0, 7)} ${c.message.substring(0, 20)}`,
      icon: '•',
    }));

    children.push({
      key: `${keyPrefix}turn-commits:${seq}`,
      label: 'Commits',
      icon: '📦',
      badge: `${turnCommits.length}`,
      children: commitChildren,
      expanded: false,
    });
  }

  // Post-turn check results
  if (turn.check_exit_code !== undefined) {
    const passed = turn.check_exit_code === 0;
    children.push({
      key: `${keyPrefix}turn-check:${seq}`,
      label: 'Check',
      icon: passed ? '✓' : '✗',
      badge: passed ? 'OK' : `exit ${turn.check_exit_code}`,
    });
  }

  // Diff for this turn
  const turnDiffFiles = info?.diffFiles ?? [];
  if (turnDiffFiles.length > 0) {
    const diffChildren: NavItem[] = turnDiffFiles.map(f => ({
      key: `${keyPrefix}turn-diff-file:${seq}:${f}`,
      label: f,
      icon: '📄',
    }));

    children.push({
      key: `${keyPrefix}turn-diff:${seq}`,
      label: 'Diff',
      icon: '±',
      badge: `${turnDiffFiles.length}`,
      children: diffChildren,
      expanded: false,
    });
  }

  return children;
}

/**
 * Partition all commits into per-turn buckets based on timestamp ranges.
 * Each turn "owns" commits between its start time and the next turn's start time.
 */
function partitionCommitsByTurn(sortedTurns: Turn[], allCommits: Commit[]): Map<number, Commit[]> {
  const result = new Map<number, Commit[]>();
  if (sortedTurns.length === 0) return result;

  for (let i = 0; i < sortedTurns.length; i++) {
    const turn = sortedTurns[i];
    const turnStart = turn.timestamp;
    const nextTurnStart = i + 1 < sortedTurns.length
      ? new Date(sortedTurns[i + 1].timestamp).getTime()
      : Infinity;

    const turnCommits = allCommits.filter(c => {
      const commitTime = new Date(c.timestamp).getTime();
      return commitTime >= turnStart && commitTime < nextTurnStart;
    });

    result.set(turn.sequence, turnCommits);
  }

  return result;
}


// ── Content generation for each artifact ───────────────────────────────

async function getContentForItem(key: string, dataMap: Map<string, ReviewData>, mainData: ReviewData): Promise<string[]> {
  // ── Sub-task key resolution ──────────────────────────────────────────
  // Keys prefixed with st:<shortId>: are resolved by peeling off the prefix
  // and looking up the correct ReviewData from the dataMap.
  if (key.startsWith('st:')) {
    const rest = key.substring(3);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return ['Invalid sub-task key.'];
    const taskId = rest.substring(0, colonIdx);
    const innerKey = rest.substring(colonIdx + 1);

    // 'root' key shows the sub-task's overview
    if (innerKey === 'root') {
      const subData = dataMap.get(taskId);
      if (!subData) return [`Sub-task ${taskId} data not available.`];
      return getTaskOverviewContent(subData);
    }

    const subData = dataMap.get(taskId);
    if (!subData) return [`Sub-task ${taskId} data not available.`];
    return await getContentForItem(innerKey, dataMap, subData);
  }

  // Root task node overview
  if (key === 'root') {
    return getTaskOverviewContent(mainData);
  }

  // ── Goal & Prompt section ─────────────────────────────────────────
  if (key === 'goal-prompt') {
    return getGoalAndPromptContent(mainData);
  }

  // ── Sub-tasks section overview ─────────────────────────────────────
  if (key === 'subtasks') {
    return getSubtasksListContent(mainData);
  }

  // Turn groupings
  if (key === 'turns') {
    return getTurnsOverview(mainData);
  }
  if (key.startsWith('chunk:')) {
    const idx = parseInt(key.substring(6), 10);
    return getChunkOverview(mainData, idx);
  }
  if (key.startsWith('turn-node:')) {
    const seq = parseInt(key.substring(10), 10);
    return getTurnContent(mainData, seq);
  }

  // Per-turn plan
  if (key.startsWith('turn-plan:')) {
    const seq = parseInt(key.substring(10), 10);
    return getTurnPlanContent(mainData, seq);
  }

  // Per-turn prompt (full prompt sent to agent)
  if (key.startsWith('turn-prompt:')) {
    const seq = parseInt(key.substring(12), 10);
    return getTurnPromptContent(mainData, seq);
  }

  // Per-turn commits overview
  if (key.startsWith('turn-commits:')) {
    const seq = parseInt(key.substring(13), 10);
    return getTurnCommitsOverview(mainData, seq);
  }

  // Per-turn check results
  if (key.startsWith('turn-check:')) {
    const seq = parseInt(key.substring(11), 10);
    return getTurnCheckContent(mainData, seq);
  }

  // Per-turn diff overview (must check before turn-diff-file since both start with turn-diff)
  if (key.startsWith('turn-diff-file:')) {
    const rest = key.substring(15);
    const colonIdx = rest.indexOf(':');
    const seq = parseInt(rest.substring(0, colonIdx), 10);
    const file = rest.substring(colonIdx + 1);
    return getTurnFileDiff(mainData, seq, file);
  }
  if (key.startsWith('turn-diff:')) {
    const seq = parseInt(key.substring(10), 10);
    return getTurnDiffOverview(mainData, seq);
  }

  // Comments
  if (key === 'comments') {
    return getCommentsContent(mainData);
  }
  if (key.startsWith('comment:')) {
    const noteId = key.substring(8);
    return getSingleCommentContent(mainData, noteId);
  }

  // Journal
  if (key === 'journal') {
    return getJournalContent(mainData);
  }
  if (key.startsWith('journal-entry:')) {
    const entryId = key.substring('journal-entry:'.length);
    return getSingleJournalEntryContent(mainData, entryId);
  }

  // Follow-ups
  if (key === 'followups') {
    return getFollowUpsContent(mainData);
  }
  if (key.startsWith('followup:')) {
    const followUpId = key.substring(9);
    return getSingleFollowUpContent(mainData, followUpId);
  }

  // All Commits (top-level)
  if (key === 'commits') {
    return getCommitsOverview(mainData);
  }
  if (key.startsWith('commit:')) {
    const sha = key.substring(7);
    return await getCommitContent(mainData, sha);
  }

  // All Diffs (top-level)
  if (key === 'diff') {
    return getDiffOverview(mainData);
  }
  if (key.startsWith('diff:')) {
    const file = key.substring(5);
    return getFileDiff(mainData, file);
  }

  return ['Select an item from the left panel.'];
}

function getTurnContent(data: ReviewData, seq: number): string[] {
  const turn = data.turns.find(t => t.sequence === seq);
  if (!turn) return ['Turn not found.'];

  const roleColor = turn.role === 'human' ? ansi.fg.green : ansi.fg.blue;
  const roleLabel = turn.role.toUpperCase();
  const lines: string[] = [];
  lines.push(roleColor + ansi.bold + `── Turn #${turn.sequence} [${roleLabel}] ──` + ansi.reset);
  lines.push('');

  // Show violations prominently for agent turns (before the agent's response)
  if (turn.role === 'agent' && turn.violations && turn.violations.length > 0) {
    const fileCount = turn.violations.length;
    const fileLabel = fileCount === 1 ? 'file' : 'files';
    lines.push(ansi.fg.yellow + ansi.bold + `⚠ PERMISSION VIOLATIONS (${fileCount} ${fileLabel})` + ansi.reset);

    for (const v of turn.violations) {
      const statusColor =
        v.status === 'approved' ? ansi.fg.green :
        v.status === 'rejected' ? ansi.fg.red :
        ansi.fg.yellow;
      const statusLabel = statusColor + `[${v.status}]` + ansi.reset;
      lines.push(`  - ${v.file} ${statusLabel}`);
    }
    lines.push('');
  }

  // Show post-turn check failure prominently
  if (turn.check_exit_code !== undefined && turn.check_exit_code !== 0) {
    const msg = turn.check_exit_code === -2 ? 'POST-TURN CHECK TIMED OUT'
      : turn.check_exit_code === -1 ? 'POST-TURN CHECK FAILED TO EXECUTE'
      : `POST-TURN CHECK FAILED (exit ${turn.check_exit_code})`;
    lines.push(ansi.fg.red + ansi.bold + `✗ ${msg}` + ansi.reset);
    lines.push('');
  }

  if (turn.role === 'agent') {
    lines.push(...formatMarkdown(turnText(turn)));
  } else {
    lines.push(...turnText(turn).split('\n'));
  }
  return lines;
}

function getTurnPlanContent(data: ReviewData, seq: number): string[] {
  const turn = data.turns.find(t => t.sequence === seq && t.role === 'agent');
  if (!turn) return ['Turn not found.'];
  const plan = extractPlanFromContent(turnText(turn));
  if (plan) return formatMarkdown(plan);
  return [ansi.dim + 'No plan found in the agent response.' + ansi.reset];
}

function getTurnPromptContent(data: ReviewData, seq: number): string[] {
  const turn = data.turns.find(t => t.sequence === seq && t.role === 'human');
  if (!turn) return ['Turn not found.'];
  if (!turn.prompt) return [ansi.dim + 'No full prompt available for this turn.' + ansi.reset];

  const lines: string[] = [];
  lines.push(ansi.bold + ansi.fg.yellow + '── Full prompt sent to agent ──' + ansi.reset);
  lines.push('');
  lines.push(...turn.prompt.split('\n'));
  return lines;
}

function getTurnCheckContent(data: ReviewData, seq: number): string[] {
  const turn = data.turns.find(t => t.sequence === seq);
  if (!turn) return ['Turn not found.'];
  if (turn.check_exit_code === undefined) return [ansi.dim + 'No post-turn check was run.' + ansi.reset];

  const lines: string[] = [];
  const passed = turn.check_exit_code === 0;

  if (passed) {
    lines.push(ansi.fg.green + ansi.bold + '✓ Post-turn check passed' + ansi.reset);
  } else if (turn.check_exit_code === -2) {
    lines.push(ansi.fg.red + ansi.bold + '✗ Post-turn check timed out' + ansi.reset);
  } else if (turn.check_exit_code === -1) {
    lines.push(ansi.fg.red + ansi.bold + '✗ Post-turn check failed to execute' + ansi.reset);
  } else {
    lines.push(ansi.fg.red + ansi.bold + `✗ Post-turn check failed (exit ${turn.check_exit_code})` + ansi.reset);
  }

  if (turn.check_output) {
    lines.push('');
    lines.push(ansi.bold + '── Output ──' + ansi.reset);
    lines.push('');
    lines.push(...turn.check_output.split('\n'));
  }

  return lines;
}

function getTurnCommitsOverview(data: ReviewData, seq: number): string[] {
  const info = data.turnInfoMap.get(seq);
  if (!info || info.commits.length === 0) {
    return [ansi.dim + 'No commits in this turn.' + ansi.reset];
  }

  const lines: string[] = [];
  lines.push(ansi.bold + `Commits for turn #${seq} (${info.commits.length})` + ansi.reset);
  lines.push('');

  for (const c of info.commits) {
    lines.push(
      ansi.fg.yellow + c.sha.substring(0, 8) + ansi.reset +
      ` [${c.status}] ${c.message}`
    );
  }

  lines.push('');
  lines.push(ansi.dim + 'Select a commit to see its diff.' + ansi.reset);
  return lines;
}

function getTurnDiffOverview(data: ReviewData, seq: number): string[] {
  const info = data.turnInfoMap.get(seq);
  if (!info || !info.diffFull) {
    return [ansi.dim + 'No diff for this turn.' + ansi.reset];
  }

  const lines: string[] = [];
  lines.push(ansi.bold + `Diff for turn #${seq}` + ansi.reset);
  lines.push('');
  lines.push(`${info.diffFiles.length} file(s) changed`);
  lines.push('');
  lines.push(ansi.dim + 'Select a file to see its diff.' + ansi.reset);
  return lines;
}

function getTurnFileDiff(data: ReviewData, seq: number, file: string): string[] {
  const info = data.turnInfoMap.get(seq);
  if (!info || !info.diffFull) return [`No diff found for ${file}`];

  const sections = info.diffFull.split(/^(?=diff --git)/m);
  for (const section of sections) {
    if (section.includes(`a/${file} `) || section.includes(`b/${file}`)) {
      return colorDiff(section);
    }
  }
  return [`No diff found for ${file}`];
}

/** Extract a plan section from agent response content. */
function extractPlanFromContent(content: string): string | null {
  const planPatterns = [
    /(?:^|\n)(#{1,3}\s+Plan\b[\s\S]*?)(?=\n#{1,3}\s+[^P]|\n#{1,3}\s+$|$)/i,
    /(?:^|\n)(\*\*Plan\*\*[\s\S]*?)(?=\n\*\*[^P]|$)/i,
    /(?:^|\n)((?:#{1,3}\s+)?(?:Implementation )?Plan:?\n[\s\S]*?)(?=\n#{1,3}\s|$)/i,
  ];

  for (const pattern of planPatterns) {
    const match = content.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

function extractDiffFiles(diffFull: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.+?) b\//gm;
  let match;
  while ((match = regex.exec(diffFull)) !== null) {
    files.push(match[1]);
  }
  return files;
}

function getDiffOverview(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + 'Diff Summary' + ansi.reset);
  lines.push('');
  if (data.diffStat) {
    lines.push(...data.diffStat.split('\n'));
  }
  lines.push('');
  lines.push(ansi.dim + 'Select a file in the left panel to see its diff.' + ansi.reset);
  lines.push(ansi.dim + 'Press Enter on "Diff" to expand/collapse file list.' + ansi.reset);
  return lines;
}

function getFileDiff(data: ReviewData, file: string): string[] {
  // Extract the diff for this specific file
  const sections = data.diffFull.split(/^(?=diff --git)/m);
  for (const section of sections) {
    if (section.includes(`a/${file} `) || section.includes(`b/${file}`)) {
      return colorDiff(section);
    }
  }
  return [`No diff found for ${file}`];
}

function getCommentsContent(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Comments (${data.comments.length} total, ${data.unseenComments.length} unseen)` + ansi.reset);
  lines.push('');

  // Show newest first
  const sorted = [...data.comments].reverse();
  for (const note of sorted) {
    const isUnseen = data.unseenComments.some(n => n.id === note.id);
    const marker = isUnseen
      ? ansi.fg.yellow + ansi.bold + ' NEW ' + ansi.reset
      : '';
    lines.push(ansi.dim + `[${formatDate(note.created_at)}]` + ansi.reset + marker);
    lines.push(...note.content.split('\n'));
    lines.push('');
  }

  return lines;
}

function getSingleCommentContent(data: ReviewData, noteId: string): string[] {
  const note = data.comments.find(n => n.id === noteId);
  if (!note) return ['Comment not found.'];

  const isUnseen = data.unseenComments.some(n => n.id === noteId);
  const lines: string[] = [];
  if (isUnseen) {
    lines.push(ansi.fg.yellow + ansi.bold + 'NEW — unseen by agent' + ansi.reset);
    lines.push('');
  }
  lines.push(ansi.dim + `Date: ${formatDate(note.created_at)}` + ansi.reset);
  lines.push('');
  lines.push(...note.content.split('\n'));
  return lines;
}

function getJournalContent(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Journal (${data.journal.length})` + ansi.reset);
  lines.push(ansi.dim + 'Append-only orchestration metadata & memories — never sent to the agent.' + ansi.reset);
  lines.push('');

  // Show newest first
  const sorted = [...data.journal].reverse();
  for (const entry of sorted) {
    const who = entry.actor ? ansi.dim + ` (${entry.actor})` + ansi.reset : '';
    lines.push(ansi.dim + `[${formatDate(entry.created_at)}]` + ansi.reset + who);
    lines.push(...entry.content.split('\n'));
    lines.push('');
  }

  return lines;
}

function getFollowUpsContent(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Follow-ups (${data.followUps.length})` + ansi.reset);
  lines.push('');

  // Show newest first
  const sorted = [...data.followUps].reverse();
  for (const f of sorted) {
    lines.push(ansi.dim + `[${formatDate(f.created_at)}]` + ansi.reset);
    lines.push(...f.content.split('\n'));
    lines.push('');
  }

  return lines;
}

function getSingleJournalEntryContent(data: ReviewData, entryId: string): string[] {
  const entry = data.journal.find(e => e.id === entryId);
  if (!entry) return ['Journal entry not found.'];

  const lines: string[] = [];
  lines.push(ansi.dim + `Date: ${formatDate(entry.created_at)}` + (entry.actor ? ` · ${entry.actor}` : '') + ansi.reset);
  lines.push('');
  lines.push(...entry.content.split('\n'));
  return lines;
}

function getSingleFollowUpContent(data: ReviewData, followUpId: string): string[] {
  const f = data.followUps.find(x => x.id === followUpId);
  if (!f) return ['Follow-up not found.'];

  const lines: string[] = [];
  lines.push(ansi.dim + `Date: ${formatDate(f.created_at)}` + ansi.reset);
  lines.push('');
  lines.push(...f.content.split('\n'));
  return lines;
}

function getCommitsOverview(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Commits (${data.commits.length})` + ansi.reset);
  lines.push('');

  for (const c of data.commits) {
    lines.push(
      ansi.fg.yellow + c.sha.substring(0, 8) + ansi.reset +
      ` [${c.status}] ${c.message}`
    );
  }

  lines.push('');
  lines.push(ansi.dim + 'Select a commit in the left panel to see its diff.' + ansi.reset);
  return lines;
}

async function getCommitContent(data: ReviewData, sha: string): Promise<string[]> {
  try {
    const lines: string[] = [];

    // Get the list of changed files in this commit
    const changedFiles = await getCommitChangedFiles(sha, data.worktreePath);

    // Separate .md files from other files
    const mdFiles = changedFiles.filter(f => f.endsWith('.md'));
    const otherFiles = changedFiles.filter(f => !f.endsWith('.md'));

    // Render .md files with the markdown viewer
    if (mdFiles.length > 0) {
      for (const filepath of mdFiles) {
        const content = await getFileAtCommit(sha, filepath, data.worktreePath);
        // Only render if content exists and appears to be valid text
        if (content !== null && !content.includes('\0')) {
          // Add file header
          lines.push(ansi.bold + ansi.fg.cyan + `── ${filepath} ──` + ansi.reset);
          lines.push('');

          // Render markdown content
          const formatted = formatMarkdown(content);
          lines.push(...formatted);
          lines.push('');
          lines.push('');
        }
      }
    }

    // Show diff for non-.md files
    if (otherFiles.length > 0 || mdFiles.length === 0) {
      const diff = await getCommitDiff(sha, data.worktreePath);
      if (diff) {
        if (mdFiles.length > 0) {
          // Add separator if we already showed markdown files
          lines.push(ansi.bold + ansi.fg.yellow + '── Diff for other files ──' + ansi.reset);
          lines.push('');
        }
        lines.push(...colorDiff(diff));
      }
    }

    if (lines.length > 0) return lines;
  } catch { /* commit may not be accessible */ }
  return [`Could not load content for commit ${sha.substring(0, 8)}`];
}

function getTurnsOverview(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Conversation History (${data.turns.length} turns)` + ansi.reset);
  lines.push('');

  for (const turn of data.turns) {
    const roleColor = turn.role === 'human' ? ansi.fg.green : ansi.fg.blue;
    const roleLabel = turn.role.toUpperCase();
    const preview = turnText(turn).substring(0, 60).replace(/\n/g, ' ');
    lines.push(roleColor + `#${turn.sequence} [${roleLabel}]` + ansi.reset + ` ${preview}...`);
  }

  lines.push('');
  lines.push(ansi.dim + 'Expand a turn to see its content, plan, commits, and diff.' + ansi.reset);
  return lines;
}

/** Overview for a single review chunk (its boundary + member turns). */
export function getChunkOverview(data: ReviewData, index: number): string[] {
  const ascending = [...data.turns].sort((a, b) => a.sequence - b.sequence);
  const chunks = groupTurnsIntoChunks(ascending);
  const chunk = chunks[index];
  if (!chunk) return ['Chunk not found.'];

  const lines: string[] = [];
  const b = chunk.boundary;
  const boundaryDesc = b
    ? `#${b.sequence} [${b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role}]`
    : '(no boundary — leading automation turns)';
  lines.push(ansi.bold + `Chunk ${chunk.index + 1} — ${boundaryDesc}` + ansi.reset);
  lines.push(ansi.dim + `${chunk.turns.length} turn${chunk.turns.length === 1 ? '' : 's'} (boundary + following agent/supervisor/system turns)` + ansi.reset);
  lines.push('');

  for (const turn of chunk.turns) {
    const roleColor = turn.role === 'human' ? ansi.fg.green : ansi.fg.blue;
    const actorLabel = turn.role === 'human' && turn.actor && turn.actor !== 'human'
      ? turn.actor.toUpperCase()
      : turn.role.toUpperCase();
    const autoSuffix = turn.auto_triggered ? ansi.dim + ' (auto)' + ansi.reset : '';
    const preview = turnText(turn).substring(0, 60).replace(/\n/g, ' ');
    lines.push(roleColor + `#${turn.sequence} [${actorLabel}]` + ansi.reset + autoSuffix + ` ${preview}...`);
  }

  lines.push('');
  lines.push(ansi.dim + 'Expand a turn to see its content, plan, commits, and diff.' + ansi.reset);
  return lines;
}

/** Content for the "Sub-tasks" section header. */
function getSubtasksListContent(data: ReviewData): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold + `Sub-tasks (${data.childTasks.length})` + ansi.reset);
  lines.push('');
  for (const child of data.childTasks) {
    lines.push(
      `  ${displayId(child)} [${child.status}] ${child.goal}`
    );
  }
  lines.push('');
  lines.push(ansi.dim + 'Expand a sub-task to see its full review content.' + ansi.reset);
  return lines;
}

/** Content for a specific sub-task node (its overview). */
function getTaskOverviewContent(data: ReviewData): string[] {
  const task = data.task;
  const lines: string[] = [];

  lines.push(ansi.bold + `Task ${displayId(task)}` + ansi.reset);
  lines.push('');

  lines.push(`  ${ansi.bold}ID:${ansi.reset}      ${shortId(task.id)}`);
  if (task.code) {
    lines.push(`  ${ansi.bold}Code:${ansi.reset}    ${task.code}`);
  }
  lines.push(`  ${ansi.bold}Status:${ansi.reset}  ${task.status}`);
  lines.push(`  ${ansi.bold}Model:${ansi.reset}   ${task.model ?? '-'}`);

  // Show parent task if exists
  if (data.parentTask) {
    lines.push(`  ${ansi.bold}Parent:${ansi.reset}  ${displayId(data.parentTask)} — ${data.parentTask.goal}`);
  }

  lines.push('');
  lines.push(`  ${ansi.bold}Goal:${ansi.reset}`);
  lines.push(`  ${task.goal}`);

  // Show prompt if exists
  if (task.prompt) {
    lines.push('');
    lines.push(ansi.bold + '  Prompt:' + ansi.reset);
    lines.push('');
    const formattedPrompt = formatMarkdown(task.prompt);
    for (const line of formattedPrompt) {
      lines.push(`  ${line}`);
    }
  }

  if (data.session) {
    lines.push('');
    lines.push(`  ${ansi.bold}Branch:${ansi.reset}  ${data.session.git_branch}`);
    const status = data.session.outcome ?? (data.session.ended_at ? 'ended' : task.status);
    lines.push(`  ${ansi.bold}Session:${ansi.reset} ${status}`);
  } else {
    lines.push('');
    lines.push(ansi.dim + 'No session — task not started yet.' + ansi.reset);
  }

  if (data.childTasks.length > 0) {
    lines.push('');
    lines.push(`  ${ansi.bold}Children:${ansi.reset} ${data.childTasks.length}`);
    for (const child of data.childTasks) {
      lines.push(`    ${displayId(child)} [${child.status}] ${child.goal}`);
    }
  }

  lines.push('');
  lines.push(`  ${ansi.bold}Turns:${ansi.reset}   ${data.turns.length}`);
  lines.push(`  ${ansi.bold}Commits:${ansi.reset} ${data.commits.length}`);
  if (data.comments.length > 0) {
    lines.push(`  ${ansi.bold}Comments:${ansi.reset} ${data.comments.length}`);
  }
  if (data.journal.length > 0) {
    lines.push(`  ${ansi.bold}Journal:${ansi.reset} ${data.journal.length}`);
  }
  if (data.followUps.length > 0) {
    lines.push(`  ${ansi.bold}Follow-ups:${ansi.reset} ${data.followUps.length}`);
  }
  lines.push('');
  lines.push(ansi.dim + 'Expand this node to see its Turns, Comments, Commits, and Diff.' + ansi.reset);

  return lines;
}

function getGoalAndPromptContent(data: ReviewData): string[] {
  const task = data.task;
  const lines: string[] = [];

  // ── Goal ──────────────────────────────────────────────────────────
  lines.push(ansi.bold + ansi.fg.cyan + '── Goal ──' + ansi.reset);
  lines.push('');
  lines.push(task.goal);
  lines.push('');

  // ── Prompt ────────────────────────────────────────────────────────
  // Show the task prompt (from task creation via `lazy create --prompt`).
  // Per-turn prompts (which include goal context, turn history, notes, etc.)
  // are visible under each turn's "Prompt" subsection.
  if (task.prompt) {
    lines.push(ansi.bold + ansi.fg.cyan + '── Prompt ──' + ansi.reset);
    lines.push('');
    const formattedPrompt = formatMarkdown(task.prompt);
    lines.push(...formattedPrompt);
  } else {
    lines.push(ansi.dim + 'No prompt specified for this task.' + ansi.reset);
  }

  return lines;
}

// ── Task tree overlay helpers ───────────────────────────────────────────

/**
 * Flatten a TaskTreeNode into a list of TreeOverlayNodes for the overlay.
 * Walks the tree depth-first, producing a flat navigable list with depth info.
 */
function flattenTreeForOverlay(tree: TaskTreeNode, currentTaskId: string): TreeOverlayNode[] {
  const nodes: TreeOverlayNode[] = [];
  const visited = new Set<string>();

  function walk(node: TaskTreeNode, depth: number): void {
    if (visited.has(node.task.id)) return;
    visited.add(node.task.id);

    nodes.push({
      taskId: shortId(node.task.id),
      label: node.task.code || shortId(node.task.id),
      goal: node.task.goal,
      status: node.task.status,
      depth,
      isCurrent: node.task.id === currentTaskId,
    });

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(tree, 0);
  return nodes;
}


// ── Subtask filter cycling ──────────────────────────────────────────────

/** Info about a subtask for cycling purposes. */
interface SubtaskEntry {
  shortId: string;
  status: string;
  navKey: string;  // the :root key in the nav tree
}

/** Collect all subtask root entries from the nav tree in display order. */
function collectSubtaskEntries(items: NavItem[]): SubtaskEntry[] {
  const result: SubtaskEntry[] = [];
  for (const item of items) {
    if (item.key.endsWith(':root') && item.key.includes('st:')) {
      // Extract the shortId from the key: "st:<id>:root" or nested "st:abc:st:def:root"
      const match = item.key.match(/st:([a-f0-9]+):root$/);
      if (match) {
        result.push({
          shortId: match[1],
          status: item.badge ?? '',
          navKey: item.key,
        });
      }
    }
    if (item.children) {
      result.push(...collectSubtaskEntries(item.children));
    }
  }
  return result;
}

/** Filter subtask entries by the current filter mode. */
function filterSubtaskEntries(entries: SubtaskEntry[], mode: SubtaskFilterMode): SubtaskEntry[] {
  switch (mode) {
    case 'all':
      return entries;
    case 'active':
      return entries.filter(e => e.status === 'working' || e.status === 'blocked' || e.status === 'conflict');
    case 'backlog':
      return entries.filter(e => e.status === 'backlog');
  }
}

const FILTER_ORDER: SubtaskFilterMode[] = ['all', 'active', 'backlog'];

/** Advance to the next filter mode. */
function nextFilterMode(current: SubtaskFilterMode): SubtaskFilterMode {
  const idx = FILTER_ORDER.indexOf(current);
  return FILTER_ORDER[(idx + 1) % FILTER_ORDER.length];
}

/** Go to the previous filter mode. */
function prevFilterMode(current: SubtaskFilterMode): SubtaskFilterMode {
  const idx = FILTER_ORDER.indexOf(current);
  return FILTER_ORDER[(idx - 1 + FILTER_ORDER.length) % FILTER_ORDER.length];
}

/**
 * Extract the subtask shortId that the current nav selection is "inside of",
 * or null if the selection is not inside any subtask.
 */
function currentSubtaskId(state: LayoutState): string | null {
  const flat = state.flatNavItems[state.selectedNavIndex];
  if (!flat) return null;
  const key = flat.item.key;
  if (!key.includes('st:')) return null;
  // Find the outermost subtask ID: the first st:<id>: in the key
  const match = key.match(/st:([a-f0-9]+):/);
  return match ? match[1] : null;
}

/**
 * Cycle to the next/previous subtask in the current filter group.
 * When the filter group is exhausted, switch to the next/previous group.
 */
async function cycleSubtask(
  state: LayoutState,
  forward: boolean,
  dataMap: Map<string, ReviewData>,
  mainData: ReviewData,
): Promise<void> {
  const allEntries = collectSubtaskEntries(state.navItems);
  if (allEntries.length === 0) return;

  const currentId = currentSubtaskId(state);

  // Try the current filter first, then cycle through other filters
  for (let attempt = 0; attempt < FILTER_ORDER.length; attempt++) {
    const filtered = filterSubtaskEntries(allEntries, state.subtaskFilterMode);

    if (filtered.length > 0) {
      const currentIdx = currentId
        ? filtered.findIndex(e => e.shortId === currentId)
        : -1;

      let targetIdx: number;
      if (forward) {
        if (currentIdx < 0) {
          // Not on a matching subtask — go to first
          targetIdx = 0;
        } else if (currentIdx < filtered.length - 1) {
          // Go to next
          targetIdx = currentIdx + 1;
        } else {
          // At last subtask — switch to next filter group
          state.subtaskFilterMode = nextFilterMode(state.subtaskFilterMode);
          continue;  // retry with new filter
        }
      } else {
        if (currentIdx < 0) {
          // Not on a matching subtask — go to last
          targetIdx = filtered.length - 1;
        } else if (currentIdx > 0) {
          // Go to previous
          targetIdx = currentIdx - 1;
        } else {
          // At first subtask — switch to previous filter group
          state.subtaskFilterMode = prevFilterMode(state.subtaskFilterMode);
          continue;  // retry with new filter
        }
      }

      const target = filtered[targetIdx];
      await navigateToSubtaskByKey(state, target.navKey, dataMap, mainData);
      return;
    }

    // Empty filter group — skip to next/previous
    state.subtaskFilterMode = forward
      ? nextFilterMode(state.subtaskFilterMode)
      : prevFilterMode(state.subtaskFilterMode);
  }
  // All filter groups are empty (shouldn't happen if hasSubtasks is true)
}

/**
 * Navigate to a subtask by its nav key, expanding ancestors as needed.
 */
async function navigateToSubtaskByKey(
  state: LayoutState,
  navKey: string,
  dataMap: Map<string, ReviewData>,
  mainData: ReviewData,
): Promise<void> {
  // Expand all ancestors of the target key in the nav tree
  function expandAncestors(items: NavItem[]): boolean {
    for (const item of items) {
      if (item.key === navKey) {
        return true;
      }
      if (item.children) {
        if (expandAncestors(item.children)) {
          item.expanded = true;
          return true;
        }
      }
    }
    return false;
  }

  expandAncestors(state.navItems);
  state.flatNavItems = flattenNavItems(state.navItems);

  const targetIdx = state.flatNavItems.findIndex(f => f.item.key === navKey);
  if (targetIdx >= 0) {
    state.selectedNavIndex = targetIdx;
    // Also expand the subtask node to show its content
    const targetItem = state.flatNavItems[targetIdx].item;
    if (targetItem.children && !targetItem.expanded) {
      targetItem.expanded = true;
      state.flatNavItems = flattenNavItems(state.navItems);
    }
  }

  state.leftPanelFocused = true;
  ensureNavVisible(state);
  await updateContentFromNav(state, dataMap, mainData);
}

// ── Main review TUI ────────────────────────────────────────────────────

export async function runReviewTUI(
  storage: Storage,
  task: Task,
  session: Session | null,
  root: string,
): Promise<ReviewAction> {
  const data = await loadReviewData(storage, task, session, root);
  const subtaskDataMap = await loadSubtaskDataMap(storage, task, root);
  const terminal = new Terminal();

  // Build sections for the current task, then wrap in a root node —
  // structurally identical to how sub-tasks are wrapped, ensuring
  // both go through the same buildNavItemsForTask code path.
  const sections = buildNavItemsForTask(data, subtaskDataMap);
  if (sections.length === 0) {
    return { type: 'quit' };
  }

  const navItems: NavItem[] = [buildTaskNavItem({
    task,
    key: 'root',
    children: sections,
    expanded: true,
  })];

  /** Compute the right panel width and wrap content lines to fit. */
  async function wrappedContent(key: string): Promise<string[]> {
    const { cols } = getTerminalSize();
    const leftWidth = Math.max(Math.floor(cols / 5), 30);
    const rightWidth = cols - leftWidth - 3; // -1 divider, -1 left pad, -1 margin
    const raw = await getContentForItem(key, subtaskDataMap, data);
    return wrapLines(raw, rightWidth);
  }

  // Precompute overlay nodes from task tree
  const treeOverlayNodes = data.taskTree
    ? flattenTreeForOverlay(data.taskTree, task.id)
    : [];

  const state: LayoutState = {
    leftPanelFocused: true,
    navItems,
    flatNavItems: flattenNavItems(navItems),
    selectedNavIndex: 0,
    navScrollOffset: 0,
    contentLines: await wrappedContent(navItems[0]?.key ?? ''),
    contentScrollOffset: 0,
    statusLine: buildStatusLine(data),
    taskHeader: `Review: ${displayId(task)} — ${task.goal}`,
    showTaskTree: false,
    treeOverlayNodes,
    treeOverlaySelectedIndex: treeOverlayNodes.findIndex(n => n.isCurrent),
    treeOverlayScrollOffset: 0,
    showHelp: false,
    subtaskFilterMode: 'all',
    hasSubtasks: data.childTasks.length > 0,
  };

  return new Promise<ReviewAction>((resolve) => {
    terminal.enter();

    function draw(): void {
      if (state.showHelp) {
        terminal.write(renderHelpOverlay(state));
      } else if (state.showTaskTree) {
        terminal.write(renderTreeOverlay(state));
      } else {
        terminal.write(render(state));
      }
    }

    async function updateContent(): Promise<void> {
      const flat = state.flatNavItems[state.selectedNavIndex];
      if (flat) {
        state.contentLines = await wrappedContent(flat.item.key);
        state.contentScrollOffset = 0;
      }
    }

    function cleanup(action: ReviewAction): void {
      terminal.exit();
      resolve(action);
    }

    async function refreshData(): Promise<void> {
      // Save current selection
      const currentKey = state.flatNavItems[state.selectedNavIndex]?.item.key;

      // Show refreshing indicator
      const originalStatusLine = state.statusLine;
      state.statusLine = 'Refreshing...';
      draw();

      try {
        // Reload data from storage
        const freshData = await loadReviewData(storage, task, session, root);
        const freshSubtaskDataMap = await loadSubtaskDataMap(storage, task, root);

        // Rebuild navigation items
        const freshSections = buildNavItemsForTask(freshData, freshSubtaskDataMap);
        if (freshSections.length === 0) {
          // No data to show anymore - restore original and return
          state.statusLine = originalStatusLine;
          draw();
          return;
        }

        const freshNavItems: NavItem[] = [buildTaskNavItem({
          task: freshData.task,
          key: 'root',
          children: freshSections,
          expanded: true,
        })];

        // Update state with fresh data
        state.navItems = freshNavItems;
        state.flatNavItems = flattenNavItems(freshNavItems);
        state.statusLine = buildStatusLine(freshData);
        state.hasSubtasks = freshData.childTasks.length > 0;

        // Try to restore previous selection
        if (currentKey) {
          const newIndex = state.flatNavItems.findIndex(item => item.item.key === currentKey);
          if (newIndex >= 0) {
            state.selectedNavIndex = newIndex;
          } else {
            // Key not found, reset to first item
            state.selectedNavIndex = 0;
            state.navScrollOffset = 0;
          }
        }

        // Update content for the selected item
        await updateContent();

        // Rebuild tree overlay nodes
        state.treeOverlayNodes = freshData.taskTree
          ? flattenTreeForOverlay(freshData.taskTree, task.id)
          : [];
        state.treeOverlaySelectedIndex = state.treeOverlayNodes.findIndex(n => n.isCurrent);
        if (state.treeOverlaySelectedIndex < 0) {
          state.treeOverlaySelectedIndex = 0;
        }

        // Update references in closure for getContentForItem
        Object.assign(data, freshData);
        subtaskDataMap.clear();
        for (const [k, v] of freshSubtaskDataMap.entries()) {
          subtaskDataMap.set(k, v);
        }

        draw();
      } catch (err) {
        // On error, restore status and redraw
        state.statusLine = `Refresh failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
        draw();
      }
    }

    terminal.onResize(() => {
      draw();
    });

    terminal.onKey(async (key: KeyPress) => {
      // Ctrl+C always quits
      if (key.ctrl && key.name === 'c') {
        cleanup({ type: 'quit' });
        return;
      }

      // Ctrl+R refreshes task data
      if (key.ctrl && key.name === 'r') {
        refreshData();
        return;
      }

      // ── Help overlay mode ──────────────────────────────────────────
      if (state.showHelp) {
        // Any key dismisses the help overlay
        state.showHelp = false;
        draw();
        return;
      }

      // ── Task tree overlay mode ────────────────────────────────────
      if (state.showTaskTree) {
        if (key.name === 't' || key.name === 'escape' || key.name === 'q') {
          state.showTaskTree = false;
          draw();
          return;
        }
        if (key.name === 'up' || key.name === 'k') {
          if (state.treeOverlaySelectedIndex > 0) {
            state.treeOverlaySelectedIndex--;
            ensureTreeOverlayVisible(state);
          }
          draw();
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          if (state.treeOverlaySelectedIndex < state.treeOverlayNodes.length - 1) {
            state.treeOverlaySelectedIndex++;
            ensureTreeOverlayVisible(state);
          }
          draw();
          return;
        }
        if (key.name === 'return') {
          const node = state.treeOverlayNodes[state.treeOverlaySelectedIndex];
          if (node) {
            state.showTaskTree = false;
            // Navigate to this task in the main nav tree
            await navigateToTaskInNav(state, node.taskId, node.isCurrent, subtaskDataMap, data);
          }
          draw();
          return;
        }
        // Ignore all other keys when overlay is active
        return;
      }

      // Ctrl-modified keys are never action keys — handle them as navigation
      if (key.ctrl) {
        if (!state.leftPanelFocused) {
          handleRightPanelKey(key, state);
          draw();
        }
        return;
      }

      // Tab: switch panels
      if (key.name === 'tab') {
        state.leftPanelFocused = !state.leftPanelFocused;
        draw();
        return;
      }

      // Navigation keys (up/down/left/right/enter/pageup/pagedown/home/end)
      const navKeys = ['up', 'down', 'left', 'right', 'return', 'pageup', 'pagedown', 'home', 'end'];
      if (navKeys.includes(key.name)) {
        if (state.leftPanelFocused) {
          await handleLeftPanelKey(key, state, subtaskDataMap, data);
        } else {
          handleRightPanelKey(key, state);
        }
        draw();
        return;
      }

      // Action keys (single letters)
      if (key.name === 'q') {
        cleanup({ type: 'quit' });
        return;
      }
      // 't' toggles task tree overlay (only when tree data exists)
      if (key.name === 't' && state.treeOverlayNodes.length > 0) {
        state.showTaskTree = true;
        draw();
        return;
      }
      // '?' shows help overlay
      if (key.raw === '?') {
        state.showHelp = true;
        draw();
        return;
      }

      // ]/[ cycle through subtasks by status group
      if (state.hasSubtasks && (key.raw === ']' || key.raw === '[')) {
        const forward = key.raw === ']';
        await cycleSubtask(state, forward, subtaskDataMap, data);
        draw();
        return;
      }

      // Right panel: vim-style scrolling with j/k
      if (!state.leftPanelFocused) {
        if (key.name === 'j') {
          handleRightPanelKey({ ...key, name: 'down' }, state);
          draw();
          return;
        }
        if (key.name === 'k') {
          handleRightPanelKey({ ...key, name: 'up' }, state);
          draw();
          return;
        }
        if (key.name === 'g') {
          handleRightPanelKey(key, state);
          draw();
          return;
        }
      }
    });

    draw();
  });
}

/**
 * Navigate the main nav tree to a specific task.
 * For the current task, selects the first item (Turns).
 * For sub-tasks, finds and expands the sub-task's node in the nav tree.
 */
async function navigateToTaskInNav(
  state: LayoutState,
  taskShortId: string,
  isCurrent: boolean,
  dataMap: Map<string, ReviewData>,
  mainData: ReviewData,
): Promise<void> {
  if (isCurrent) {
    // Go to top of the nav tree
    state.selectedNavIndex = 0;
    state.leftPanelFocused = true;
    ensureNavVisible(state);
    updateContentFromNav(state, dataMap, mainData);
    return;
  }

  // Find the nav item for this sub-task by searching for its :root key
  // The key pattern is st:<id>:root, possibly nested: st:abc:st:def:root
  const targetSuffix = `st:${taskShortId}:root`;

  // First, expand all ancestor nav items so the target becomes visible
  function expandAncestors(items: NavItem[]): boolean {
    for (const item of items) {
      if (item.key.endsWith(targetSuffix)) {
        return true; // found it
      }
      if (item.children) {
        if (expandAncestors(item.children)) {
          item.expanded = true;
          return true;
        }
      }
    }
    return false;
  }

  expandAncestors(state.navItems);
  state.flatNavItems = flattenNavItems(state.navItems);

  // Now find the index of the target in the flat list
  const targetIdx = state.flatNavItems.findIndex(f => f.item.key.endsWith(targetSuffix));
  if (targetIdx >= 0) {
    state.selectedNavIndex = targetIdx;
    // Also expand the target itself to show its review content
    const targetItem = state.flatNavItems[targetIdx].item;
    if (targetItem.children && !targetItem.expanded) {
      targetItem.expanded = true;
      state.flatNavItems = flattenNavItems(state.navItems);
    }
  }

  state.leftPanelFocused = true;
  ensureNavVisible(state);
  await updateContentFromNav(state, dataMap, mainData);
}

/** Keep navScrollOffset in sync so the selected item is always visible. */
function ensureNavVisible(state: LayoutState): void {
  const { rows } = getTerminalSize();
  const contentHeight = rows - 4; // must match renderer: header + panel border + status + action

  // If selected is above the visible area, scroll up
  if (state.selectedNavIndex < state.navScrollOffset) {
    state.navScrollOffset = state.selectedNavIndex;
  }
  // If selected is below the visible area, scroll down
  if (state.selectedNavIndex >= state.navScrollOffset + contentHeight) {
    state.navScrollOffset = state.selectedNavIndex - contentHeight + 1;
  }
}

/** Keep tree overlay scroll offset in sync so the selected item is visible. */
function ensureTreeOverlayVisible(state: LayoutState): void {
  const { rows } = getTerminalSize();
  const marginY = Math.max(2, Math.floor(rows * 0.1));
  const boxHeight = rows - marginY * 2;
  const innerHeight = boxHeight - 4; // border + title + action bar

  if (state.treeOverlaySelectedIndex < state.treeOverlayScrollOffset) {
    state.treeOverlayScrollOffset = state.treeOverlaySelectedIndex;
  }
  if (state.treeOverlaySelectedIndex >= state.treeOverlayScrollOffset + innerHeight) {
    state.treeOverlayScrollOffset = state.treeOverlaySelectedIndex - innerHeight + 1;
  }
}

async function handleLeftPanelKey(key: KeyPress, state: LayoutState, dataMap: Map<string, ReviewData>, mainData: ReviewData): Promise<void> {
  if (key.name === 'up') {
    if (state.selectedNavIndex > 0) {
      state.selectedNavIndex--;
      ensureNavVisible(state);
      await updateContentFromNav(state, dataMap, mainData);
    }
  } else if (key.name === 'down') {
    if (state.selectedNavIndex < state.flatNavItems.length - 1) {
      state.selectedNavIndex++;
      ensureNavVisible(state);
      await updateContentFromNav(state, dataMap, mainData);
    }
  } else if (key.name === 'return') {
    const flat = state.flatNavItems[state.selectedNavIndex];
    if (flat && flat.item.children) {
      flat.item.expanded = !flat.item.expanded;
      state.flatNavItems = flattenNavItems(state.navItems);
      // Clamp selection
      if (state.selectedNavIndex >= state.flatNavItems.length) {
        state.selectedNavIndex = state.flatNavItems.length - 1;
      }
    }
    ensureNavVisible(state);
    updateContentFromNav(state, dataMap, mainData);
  } else if (key.name === 'right') {
    // Expand current item
    const flat = state.flatNavItems[state.selectedNavIndex];
    if (flat?.item.children && !flat.item.expanded) {
      flat.item.expanded = true;
      state.flatNavItems = flattenNavItems(state.navItems);
      ensureNavVisible(state);
    }
  } else if (key.name === 'left') {
    // Collapse current item
    const flat = state.flatNavItems[state.selectedNavIndex];
    if (flat?.item.children && flat.item.expanded) {
      flat.item.expanded = false;
      state.flatNavItems = flattenNavItems(state.navItems);
      ensureNavVisible(state);
    }
  }
}

function handleRightPanelKey(key: KeyPress, state: LayoutState): void {
  const { rows } = getTerminalSize();
  const contentHeight = rows - 4; // must match renderer: header + panel border + status + action
  const maxScroll = Math.max(0, state.contentLines.length - contentHeight);

  if (key.name === 'up') {
    if (state.contentScrollOffset > 0) {
      state.contentScrollOffset--;
    }
  } else if (key.name === 'down') {
    if (state.contentScrollOffset < maxScroll) {
      state.contentScrollOffset++;
    }
  } else if (key.name === 'pageup' || (key.name === 'b' && key.ctrl)) {
    state.contentScrollOffset = Math.max(0, state.contentScrollOffset - contentHeight);
  } else if (key.name === 'pagedown' || (key.name === 'f' && key.ctrl)) {
    state.contentScrollOffset = Math.min(maxScroll, state.contentScrollOffset + contentHeight);
  } else if (key.name === 'home' || (key.name === 'g' && !key.shift)) {
    state.contentScrollOffset = 0;
  } else if (key.name === 'end' || (key.name === 'g' && key.shift)) {
    state.contentScrollOffset = maxScroll;
  }
}

async function updateContentFromNav(state: LayoutState, dataMap: Map<string, ReviewData>, mainData: ReviewData): Promise<void> {
  const flat = state.flatNavItems[state.selectedNavIndex];
  if (flat) {
    const { cols } = getTerminalSize();
    const leftWidth = Math.max(Math.floor(cols / 5), 30);
    const rightWidth = cols - leftWidth - 3;
    state.contentLines = wrapLines(await getContentForItem(flat.item.key, dataMap, mainData), rightWidth);
    state.contentScrollOffset = 0;
  }
}

function buildStatusLine(data: ReviewData): string {
  const parts: string[] = [];
  parts.push(`${displayId(data.task)}`);
  parts.push(`Status: ${data.task.status}`);
  parts.push(`Turns: ${data.turns.length}`);
  parts.push(`Commits: ${data.commits.length}`);
  if (data.unseenComments.length > 0) {
    parts.push(`${data.unseenComments.length} unseen comment(s)`);
  }
  if (data.followUps.length > 0) {
    parts.push(`${data.followUps.length} follow-up(s)`);
  }
  return parts.join('  │  ');
}
