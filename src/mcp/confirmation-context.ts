/**
 * Context-gathering and scaling functions for the confirmation protocol.
 *
 * Each operation has:
 * 1. A scaling function that determines the confirmation level
 * 2. A context-gathering function that collects data for template rendering
 */

import type { ConfirmationLevel } from './confirmation';
import type { Task } from '../types';

// --- Diff stat type ---

export interface DiffStat {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

// --- Scaling functions ---

/**
 * Accept scales with diff size.
 * - Tiny diff (<=20 lines, <=2 files) -> none
 * - Large (>100 lines or >5 files) -> standard
 * - Very large (>500 lines or >10 files) -> stern
 * - Otherwise -> light
 */
export function acceptConfirmationLevel(diffStat: DiffStat): ConfirmationLevel {
  const { filesChanged, linesAdded, linesRemoved } = diffStat;
  const totalLines = linesAdded + linesRemoved;

  if (totalLines <= 20 && filesChanged <= 2) return 'none';
  if (totalLines > 500 || filesChanged > 10) return 'stern';
  if (totalLines > 100 || filesChanged > 5) return 'standard';
  return 'light';
}

/** Reject is always stern. */
export function rejectConfirmationLevel(): ConfirmationLevel {
  return 'stern';
}

/**
 * Close scales with work invested.
 * - No commits and backlog status -> light
 * - Has commits -> stern
 * - Otherwise -> standard
 */
export function closeConfirmationLevel(
  task: Pick<Task, 'status'>,
  commitCount: number,
): ConfirmationLevel {
  if (commitCount === 0 && task.status === 'backlog') return 'light';
  if (commitCount > 0) return 'stern';
  return 'standard';
}

/**
 * Redo scales with old task history.
 * - Many commits (>5) -> stern
 * - Otherwise -> standard
 */
export function redoConfirmationLevel(commitCount: number): ConfirmationLevel {
  if (commitCount > 5) return 'stern';
  return 'standard';
}

/**
 * Reopen scales with task completion status.
 * - Reopening a completed (accepted) task -> standard
 * - Otherwise -> light
 */
export function reopenConfirmationLevel(
  task: Pick<Task, 'status'>,
): ConfirmationLevel {
  if (task.status === 'complete') return 'standard';
  return 'light';
}

/**
 * Create scales with how clearly the project uses parent-child hierarchy.
 * - No parent specified or parent is not main -> none (explicit parent choice)
 * - Parent is main, no active tasks -> none (standalone work is fine)
 * - Parent is main, active tasks exist but none have children -> light (gentle nudge)
 * - Parent is main, active tasks with children exist -> stern (almost certainly a mistake)
 */
export function createConfirmationLevel(
  parentId: string | undefined,
  activeTasks: Array<{ task: Task; childCount: number }>,
): ConfirmationLevel {
  if (!parentId || parentId !== 'main') return 'none';
  if (activeTasks.length === 0) return 'none';
  const withChildren = activeTasks.filter((t) => t.childCount > 0);
  if (withChildren.length > 0) return 'stern';
  return 'light';
}

// --- Context types for template rendering ---

export interface AcceptContext {
  [key: string]: string | number;
  task_code: string;
  task_id: string;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  commit_count: number;
  parent_branch: string;
  confirmation_code: string;
}

export interface RejectContext {
  [key: string]: string | number;
  task_code: string;
  task_id: string;
  commit_count: number;
  lines_changed: number;
  confirmation_code: string;
}

export interface CloseContext {
  [key: string]: string | number;
  task_code: string;
  task_id: string;
  commit_count: number;
  lines_changed: number;
  confirmation_code: string;
}

export interface RedoContext {
  [key: string]: string | number;
  task_code: string;
  task_id: string;
  commit_count: number;
  confirmation_code: string;
}

export interface ReopenContext {
  [key: string]: string | number;
  task_code: string;
  task_id: string;
  confirmation_code: string;
}

export interface CreateParentWarningContext {
  [key: string]: string | number;
  active_task_code: string;
  confirmation_code: string;
}

export interface CreateParentWarningSternContext {
  [key: string]: string | number;
  active_task_code: string;
  child_count: number;
  confirmation_code: string;
}

// --- Context-gathering functions ---
// These collect diff stats, commit counts, etc. for template rendering.
// They take pre-gathered data rather than calling storage directly,
// so they remain pure and testable. The MCP handlers are responsible
// for querying storage and git before calling these.

export function gatherAcceptContext(
  task: Pick<Task, 'code' | 'id'>,
  diffStat: DiffStat,
  commitCount: number,
  parentBranch: string,
  confirmationCode: string,
): AcceptContext {
  return {
    task_code: task.code ?? task.id.slice(0, 8),
    task_id: task.id.slice(0, 8),
    files_changed: diffStat.filesChanged,
    lines_added: diffStat.linesAdded,
    lines_removed: diffStat.linesRemoved,
    commit_count: commitCount,
    parent_branch: parentBranch,
    confirmation_code: confirmationCode,
  };
}

export function gatherRejectContext(
  task: Pick<Task, 'code' | 'id'>,
  commitCount: number,
  linesChanged: number,
  confirmationCode: string,
): RejectContext {
  return {
    task_code: task.code ?? task.id.slice(0, 8),
    task_id: task.id.slice(0, 8),
    commit_count: commitCount,
    lines_changed: linesChanged,
    confirmation_code: confirmationCode,
  };
}

export function gatherCloseContext(
  task: Pick<Task, 'code' | 'id'>,
  commitCount: number,
  linesChanged: number,
  confirmationCode: string,
): CloseContext {
  return {
    task_code: task.code ?? task.id.slice(0, 8),
    task_id: task.id.slice(0, 8),
    commit_count: commitCount,
    lines_changed: linesChanged,
    confirmation_code: confirmationCode,
  };
}

export function gatherRedoContext(
  task: Pick<Task, 'code' | 'id'>,
  commitCount: number,
  confirmationCode: string,
): RedoContext {
  return {
    task_code: task.code ?? task.id.slice(0, 8),
    task_id: task.id.slice(0, 8),
    commit_count: commitCount,
    confirmation_code: confirmationCode,
  };
}

export function gatherReopenContext(
  task: Pick<Task, 'code' | 'id'>,
  confirmationCode: string,
): ReopenContext {
  return {
    task_code: task.code ?? task.id.slice(0, 8),
    task_id: task.id.slice(0, 8),
    confirmation_code: confirmationCode,
  };
}

export function gatherCreateParentWarningContext(
  activeTask: Pick<Task, 'code' | 'id'>,
  confirmationCode: string,
): CreateParentWarningContext {
  return {
    active_task_code: activeTask.code ?? activeTask.id.slice(0, 8),
    confirmation_code: confirmationCode,
  };
}

export function gatherCreateParentWarningSternContext(
  activeTask: Pick<Task, 'code' | 'id'>,
  childCount: number,
  confirmationCode: string,
): CreateParentWarningSternContext {
  return {
    active_task_code: activeTask.code ?? activeTask.id.slice(0, 8),
    child_count: childCount,
    confirmation_code: confirmationCode,
  };
}
