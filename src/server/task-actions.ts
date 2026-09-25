/**
 * The port through which the web layer edits a task.
 *
 * INVARIANT (same as ./review-actions.ts): all mutations go through the daemon.
 * The web handler runs in-process with the daemon and calls this method, which
 * is implemented in src/daemon/task-edit-service.ts — it never calls
 * `editTask` or Storage writes itself. This file lives in src/server/ because
 * src/daemon/server.ts already imports src/server; the reverse import would be
 * a module cycle.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests), the edit routes answer 503 rather than half-working.
 */

import type { ProgressEmitter } from '../daemon/progress';

/**
 * Fields the web form can change. Deliberately narrower than `EditTaskInput`:
 * the page offers the two fields a human rewrites (goal, prompt) plus the three
 * that stay changeable after a task has started. `type`, `code` and `parent`
 * are structural and stay with the CLI.
 *
 * Every field is optional and an omitted field is NOT a change — an empty
 * prompt box means "clear the prompt", which is why the route passes `''`
 * rather than omitting it.
 */
export interface TaskEditInput {
  goal?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  agent?: string;
}

/** Deliberately loose, so daemon result shapes stay out of src/server. */
export interface TaskCreateInput {
  goal: string;
  prompt?: string;
  code?: string;
  parent?: string;
  type?: string;
  model?: string;
  effort?: string;
  review?: string;
  reviewGate?: string;
  reviewAutoFix?: string;
  agent?: string;
}

export interface TaskCreateResult {
  taskId: string;
  displayId: string;
  derivedCode: boolean;
  /** Follow-up field writes that failed after the task row existed. */
  warnings?: string[];
}

export interface TaskEditResult {
  /** Names of the fields that actually changed, e.g. ['goal', 'prompt']. */
  changes: string[];
  /** Human-readable notes the daemon wants shown (e.g. an agent switch). */
  announcements?: string[];
}

/**
 * Deliberately loose, so daemon lifecycle result shapes stay out of src/server
 * (same posture as `UnblockResult` in ./review-actions.ts): the page only ever
 * surfaces warnings and redirects back to the task.
 */
export interface TaskLifecycleResult {
  warnings?: string[];
}

export interface TaskActions {
  /**
   * Apply the edit through the daemon's one implementation, which enforces the
   * edit rules and — for a prompt — writes a NEW prompt version rather than
   * overwriting the old text, exactly as `lazy edit --prompt` does.
   */
  editTask(taskId: string, input: TaskEditInput): Promise<TaskEditResult>;

  /**
   * Create a backlog task through the daemon's one implementation — the same
   * validation, parent resolution and agent resolution `lazy create` uses.
   * Starting it is a separate call (`startTask`) so the form can land in
   * backlog or kick off a turn without a second writer.
   */
  createTask(input: TaskCreateInput): Promise<TaskCreateResult>;

  // Lifecycle verbs. Each one is the daemon's own implementation — the same
  // functions behind `lazy start` / `lazy stop` / `lazy close` / `lazy reject`
  // / `lazy resume` / `lazy reopen` — so the web layer never grows a second
  // copy of the state machine. Which verbs the PAGE offers comes from
  // ./task-verbs.ts; the daemon still refuses anything illegal.

  /** Start a backlog task: worktree, branch, first agent turn. Returns once launched. */
  startTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;
  /** Halt a running task without auto-resume. Reason is required. */
  stopTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;
  /** Close (abandon) the task. Reason is required. */
  closeTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;
  /** Reject the task's work and end its session. Reason is required. */
  rejectTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;
  /** Relaunch a blocked/interrupted task with no new feedback. Returns once launched. */
  resumeTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;
  /**
   * Reopen a terminal task to blocked (had a session) or backlog. A reason is
   * required for a `complete` task and recorded as a comment, exactly as
   * `lazy reopen --reason` does. Does not recreate the worktree — the next
   * start/unblock does.
   */
  reopenTask(taskId: string, reason?: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult>;

  /**
   * Bring the task's container up WITHOUT starting a turn — the same daemon path
   * `lazy shell` uses. Nobody is asking for agent work: the human wants the
   * environment, so the shell and the published service ports become reachable.
   *
   * `onProgress` receives the launch's own narration (image resolution, a
   * `docker build` that can run for minutes, the container start). The web layer
   * shows it verbatim; nothing here is load-bearing.
   */
  ensureContainer(taskId: string, onProgress?: (detail: string) => void): Promise<EnsureContainerResult>;

  /** No-network behind/ahead + merge-tree preview. */
  getUpstreamStatus(taskId: string): Promise<TaskUpstreamStatusView>;
  /** Merge upstream into the task — same syncTask the CLI runs. */
  syncTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskSyncResult>;
  reparentTask(taskId: string, parent: string, onProgress?: ProgressEmitter): Promise<TaskReparentResult>;
  /**
   * Adopt a PR URL or git branch as a blocked linked task — the same
   * `linkTask` the CLI and `lazy_link` call.
   */
  linkTask(input: TaskLinkInput, onProgress?: ProgressEmitter): Promise<TaskLinkResult>;
  /**
   * Run an agent review of the task — the same `launchReviewTask` the CLI
   * and `lazy_review` call.
   */
  reviewTask(taskId: string, input: TaskReviewInput, onProgress?: ProgressEmitter): Promise<TaskReviewResult>;
  redoTask(taskId: string, reason: string): Promise<TaskRedoResult>;
  cloneTask(taskId: string, input: TaskCloneInput): Promise<TaskCloneResult>;
  submitPreflight(taskId: string): Promise<TaskSubmitPreflight>;
  submitTask(taskId: string): Promise<TaskSubmitResult>;
  listReparentTargets(exceptTaskId?: string): Promise<TaskReparentTargets>;
}

export interface TaskUpstreamStatusView {
  kind: 'ok' | 'unknown';
  behind?: number;
  ahead?: number;
  wouldConflict?: boolean;
  conflictFiles?: string[];
  upstreamRef?: string;
  parentLabel?: string;
  computedAt: string;
  asOfLastFetch?: boolean;
  /** Full SHA a pinned task (lazy clone --same-base) is held at. */
  pinnedTo?: string | null;
  reason?: string;
  line: string;
  htmlLine: string;
}

export interface TaskSyncResult {
  message: string;
  warnings?: string[];
}

export interface TaskReparentResult {
  message: string;
  warnings?: string[];
}

export interface TaskRedoResult {
  newTaskId: string;
  newDisplayId: string;
  oldDisplayId: string;
  imagePinWarning?: string | null;
}

export interface TaskLinkInput {
  ref: string;
  parent?: string;
  code?: string;
}

export interface TaskLinkResult {
  taskId: string;
  displayId: string;
  goal: string;
  branch: string;
  status: string;
  prUrl: string | null;
  warnings?: string[];
}

export interface TaskReviewInput {
  /**
   * After a successful review that filed Raises, start an auto-fix work turn
   * that injects those Raises into the agent's NOTES. Web Review dialog checkbox.
   */
  autoFix?: boolean;
}

export interface TaskReviewResult {
  turnNumber: number;
  warnings?: string[];
}

export interface TaskCloneInput {
  goal?: string;
  prompt?: string;
  code?: string;
  parent?: string;
  model?: string;
  agent?: string;
  /** Branch from the source's starting commit and pin the clone there. */
  sameBase?: boolean;
}

export interface TaskCloneResult {
  newTaskId: string;
  newDisplayId: string;
  imagePinWarning?: string | null;
}

export interface TaskSubmitPreflight {
  canSubmit: boolean;
  refusal?: string;
  targetBranch: string;
  taskCode: string | null;
  targetIsProtected: boolean | 'unknown';
  unknownReason?: string;
  existingPrUrl?: string | null;
  confirmationTier: 'plain' | 'strong' | 'none';
  forgeName: string;
}

export interface TaskSubmitResult {
  prUrl: string | null;
  displayId: string;
  warnings?: string[];
}

export interface TaskReparentTargets {
  tasks: Array<{ id: string; code: string | null; goal: string }>;
  branches: string[];
}

export interface EnsureContainerResult {
  containerName: string;
  /** True when the container was already up and nothing was launched. */
  alreadyRunning: boolean;
}
