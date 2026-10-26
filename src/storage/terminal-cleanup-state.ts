/** Durable evidence of finished-task cleanup, independent of Docker recovery. */
export interface TerminalCleanupItem {
  /** `task-data`: the task's persistent data directory ($LAZY_TASK_DATA, a named volume). */
  kind: 'worktree' | 'task-container' | 'member-environment' | 'task-data';
  id: string;
  taskId: string;
  taskCode: string;
  name: string;
  bytes: number | null;
  blockedReason?: string;
}

export interface TerminalCleanupFailure {
  item: TerminalCleanupItem;
  error: string;
  attempts: number;
  since: string;
  lastAt: string;
}

export interface TerminalCleanupState {
  lastRun: { startedAt: string; finishedAt: string; reason: string;
    removed: TerminalCleanupItem[]; skipped: TerminalCleanupItem[]; error?: string } | null;
  /** Manual reclaim must not overwrite evidence of the periodic sweep. */
  lastSweep?: TerminalCleanupState['lastRun'];
  failures: TerminalCleanupFailure[];
}
