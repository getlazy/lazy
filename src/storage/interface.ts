/**
 * Storage interface
 *
 * This defines the contract for all storage operations. The rest of the application
 * should only interact with storage through this interface, never directly with
 * the file system or database.
 */

import type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  SearchResult,
  StoredConversation,
  StatusChange,
  ModelName,
  Actor,
} from './types';

/**
 * Options for creating a new turn
 */
export interface CreateTurnOptions {
  sessionId: string;
  sequence: number;
  role: TurnRole;
  content: string;
  usage?: TokenUsage;
  startSha?: string;
  endSha?: string;
  startShaWork?: string;
  endShaWork?: string;
  mergeConflicts?: MergeConflict[];
  violations?: FileViolation[];
  model?: ModelName;
  prompt?: string;
  /** Who created this turn: human (CLI) or builder (MCP). Only meaningful for role='human' turns. */
  actor?: Actor;
}

export interface Storage {
  // --- Lifecycle ---

  /**
   * Initialize storage (create directories, run migrations, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close storage and release resources
   */
  close(): Promise<void>;

  // --- Path accessors ---

  /**
   * Get the base path where task data is stored.
   * For external storage: the configured external path
   *
   * Use this instead of constructing paths with getDataDir() when
   * the data should follow the storage backend.
   */
  getStoragePath(): string;

  /**
   * Get the directory path for a specific task's data.
   * Returns <storagePath>/tasks/<taskId>/
   */
  getTaskDir(taskId: string): string;

  // --- Tasks ---

  /**
   * Create a new task
   */
  createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string): Promise<Task>;

  /**
   * Get a task by ID (supports prefix matching and code lookup)
   */
  getTask(taskId: string): Promise<Task | null>;

  /**
   * Resolve a task identifier (hex ID, UUID, or code) to a task.
   * Returns the task and any resolution errors (e.g., ambiguous code).
   */
  resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }>;

  /**
   * List all tasks
   */
  listTasks(): Promise<Task[]>;

  /**
   * List tasks with filtering options
   */
  listTasksWithOptions(options: ListTasksOptions): Promise<Task[]>;

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: TaskStatus, actor?: Actor): Promise<void>;

  /**
   * Update task goal
   */
  updateTaskGoal(taskId: string, goal: string): Promise<void>;

  /**
   * Update task code
   */
  updateTaskCode(taskId: string, code: string | null): Promise<void>;

  /**
   * Update task parent (set or clear parent_task_id)
   */
  updateTaskParent(taskId: string, parentTaskId: string | null): Promise<void>;

  /**
   * Update the SHA that a child task was branched from
   */
  updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void>;

  /**
   * Update task model
   */
  updateTaskModel(taskId: string, model: string): Promise<void>;

  /**
   * Update task type
   */
  updateTaskType(taskId: string, type: string): Promise<void>;

  /**
   * Close a task with a reason
   */
  closeTask(taskId: string, closeReason: string, actor?: Actor): Promise<void>;

  /**
   * Reopen an abandoned task: reset status to 'blocked' and clear completed_at
   */
  reopenTask(taskId: string, actor?: Actor): Promise<void>;

  /**
   * Set a metadata key-value pair on a task
   */
  updateTaskMetadata(taskId: string, key: string, value: string): Promise<void>;

  /**
   * Get a metadata value by key from a task
   */
  getTaskMetadata(taskId: string, key: string): Promise<string | null>;

  /**
   * Update task prompt (creates a new version)
   */
  updateTaskPrompt(taskId: string, content: string, sessionId?: string): Promise<TaskPromptVersion>;

  /**
   * Get prompt version history for a task
   */
  getPromptHistory(taskId: string): Promise<TaskPromptVersion[]>;

  /**
   * Get a specific prompt version
   */
  getPromptVersion(taskId: string, version: number): Promise<TaskPromptVersion | null>;

  // --- Sessions ---

  /**
   * Create a new session for a task
   */
  createSession(
    taskId: string,
    agentId: string,
    gitBranch: string,
    gitStartSha: string,
    claudeSessionId?: string
  ): Promise<Session>;

  /**
   * Get a session by ID (supports prefix matching)
   */
  getSession(sessionId: string): Promise<Session | null>;

  /**
   * Get the session for a task (1:1 relationship)
   */
  getSessionByTaskId(taskId: string): Promise<Session | null>;

  /**
   * List sessions, optionally filtered by task
   */
  listSessions(taskId?: string, activeOnly?: boolean): Promise<Session[]>;

  /**
   * End a session with an outcome
   */
  endSession(sessionId: string, outcome: SessionOutcome): Promise<void>;

  /**
   * Reset a session's ended_at and outcome (for reopening rejected tasks)
   */
  resetSession(sessionId: string): Promise<void>;

  /**
   * Update session's Claude session ID
   */
  updateSessionClaudeId(sessionId: string, claudeSessionId: string): Promise<void>;

  /**
   * Update session's container name for async tracking
   */
  updateSessionContainerName(sessionId: string, containerName: string | null): Promise<void>;

  /**
   * Update session interaction tracking
   */
  updateSessionInteraction(sessionId: string, durationMs: number): Promise<void>;

  /**
   * Accumulate token usage for a session
   */
  updateSessionUsage(sessionId: string, usage: TokenUsage): Promise<void>;

  /**
   * Update the upstream merge SHA (for accurate diff scope)
   */
  updateSessionUpstreamMergeSha(sessionId: string, sha: string): Promise<void>;

  /**
   * Record interrupt diagnostics on a session
   */
  recordInterrupt(sessionId: string, diagnostics: {
    reason: string;
    exit_code: number | null;
    logs: string | null;
  }): Promise<void>;

  /**
   * Reset consecutive interruptions counter (on successful turn or manual resume)
   */
  resetConsecutiveInterruptions(sessionId: string): Promise<void>;

  /**
   * Set the auto_resumed flag on a session
   */
  setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void>;

  // --- Turns ---

  /**
   * Create a new turn in a session
   */
  createTurn(options: CreateTurnOptions): Promise<Turn>;

  /**
   * Get all turns for a session
   */
  getSessionTurns(sessionId: string): Promise<Turn[]>;

  /**
   * Get the next turn sequence number for a session
   */
  getNextTurnSequence(sessionId: string): Promise<number>;

  /**
   * Get the number of turns for a task (without loading full turn content)
   */
  getTurnCountByTaskId(taskId: string): Promise<number>;

  /**
   * Update violation statuses on a specific turn.
   * Used when a human approves or rejects file violations during unblock.
   */
  updateTurnViolations(taskId: string, turnId: string, violations: FileViolation[]): Promise<void>;

  // --- Commits ---

  /**
   * Record a commit made during a session
   */
  createCommit(sessionId: string, sha: string, message: string): Promise<Commit>;

  /**
   * Get all commits for a session
   */
  getSessionCommits(sessionId: string): Promise<Commit[]>;

  // --- Reviews ---

  /**
   * Create a review for a commit
   */
  createReview(commitId: string, verdict: ReviewVerdict, rationale: string, reviewer: string): Promise<Review>;

  /**
   * Get all reviews for a commit
   */
  getCommitReviews(commitId: string): Promise<Review[]>;

  // --- Worktree Snapshots ---

  /**
   * Create a snapshot of uncommitted changes
   */
  createWorktreeSnapshot(
    sessionId: string,
    turnSequence: number,
    uncommittedDiff: string,
    gitStatus: string
  ): Promise<WorktreeSnapshot>;

  /**
   * Get the latest snapshot for a session
   */
  getLatestWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null>;

  /**
   * Get snapshot for a specific turn
   */
  getWorktreeSnapshotForTurn(sessionId: string, turnSequence: number): Promise<WorktreeSnapshot | null>;

  // --- Task Tree Operations ---

  /**
   * Get all child tasks of a parent
   */
  getChildTasks(parentTaskId: string): Promise<Task[]>;

  /**
   * Get the root task in a task tree
   */
  getRootTask(taskId: string): Promise<Task | null>;

  /**
   * Get task ancestry (path from root to this task)
   */
  getTaskAncestry(taskId: string): Promise<Task[]>;

  /**
   * Get full task tree starting from a root task
   */
  getTaskTree(rootTaskId: string): Promise<TaskTreeNode | null>;

  // --- Comments ---

  /**
   * Create a comment on a task
   */
  createComment(taskId: string, content: string, actor?: Actor): Promise<Comment>;

  /**
   * Get all comments for a task
   */
  getTaskComments(taskId: string): Promise<Comment[]>;

  // --- Conversations ---

  /**
   * Save (create or overwrite) a conversation
   */
  saveConversation(conversation: StoredConversation): Promise<void>;

  /**
   * Load a conversation by session ID
   */
  loadConversation(sessionId: string): Promise<StoredConversation | null>;

  /**
   * List all stored conversations, sorted by startedAt DESC
   */
  listConversations(): Promise<StoredConversation[]>;

  /**
   * Check if a conversation has been imported
   */
  isConversationImported(sessionId: string): Promise<boolean>;

  // --- Status History ---

  /**
   * Get the status changelog for a task.
   * Returns an array of {status, timestamp} entries in chronological order.
   * If no changelog exists yet, lazily reconstructs one from task/session data.
   */
  getStatusHistory(taskId: string): Promise<StatusChange[]>;

  // --- Search ---

  /**
   * Full-text search across tasks, turns, commits, and conversations
   */
  search(query: string): Promise<SearchResult[]>;
}
