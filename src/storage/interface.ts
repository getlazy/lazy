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
  JournalEntry,
  FollowUp,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnRole,
  TurnType,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  SearchResult,
  StoredConversation,
  AgentSessionLog,
  BuilderResumeIntent,
  StatusChange,
  Actor,
  TagEvent,
  MemoryRecord,
  MemoryEvent,
  MemoryWriteInput,
  MemoryCompact,
  MemoryCompactInput,
  CommentSource,
  HunkApproval,
  HunkApprovalLineage,
  ProxyAuditRecord,
  ListAuditRecordsOptions,
} from './types';
import type { SpanRecord } from '../tracing/types';
import type { RunnerType } from '../config/types';

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
  model?: string;
  prompt?: string;
  /** Who created this turn: human (CLI) or builder (MCP). Only meaningful for role='human' turns. */
  actor?: Actor;
  /** Exit code of the post-turn check command */
  checkExitCode?: number;
  /** Captured output from the post-turn check command */
  checkOutput?: string;
  /** Whether this turn was auto-triggered (CI failure, comment, upstream sync, crash) vs human-triggered */
  autoTriggered?: boolean;
  /**
   * Turn category. Defaults to 'work' (substantive task-advancing turn) when
   * omitted. Use 'ask' for read-only Q&A exchanges (e.g. `lazy review -i`).
   */
  turnType?: TurnType;
  /**
   * Mark this turn as carrying human/builder feedback that the agent has not
   * consumed yet (persisted as `feedback_delivery: 'pending'`).
   *
   * INVARIANT (CLAUDE.md — never lose human feedback): set this on every turn
   * whose content is real feedback destined for the agent (unblock, ask,
   * initial task prompt, auto-delivered comments/CI). Do NOT set it on
   * synthetic system notices, supervisor sync/nudge turns, or stop reasons —
   * those must never trigger redelivery. See `findPendingFeedback()`.
   */
  carriesFeedback?: boolean;
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
   *
   * For code-based lookups with multiple matches:
   * - If one non-terminal task and any terminal tasks exist → returns the non-terminal task
   * - If multiple non-terminal tasks exist → returns ambiguousMatches (genuinely ambiguous)
   * - If only terminal tasks exist → returns the most recently created task
   *
   * Returns the task and any resolution errors (e.g., ambiguous hex prefix, multiple active tasks).
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
   * Set a task's canonical integration target (see {@link TaskTarget}).
   * Replaces the old updateTaskParent + updateTaskMetadata('remote_target_branch')
   * pair — callers construct a single discriminated union, so a parent task and
   * a target branch can never be set independently or left contradictory.
   */
  updateTaskTarget(taskId: string, target: TaskTarget): Promise<void>;

  /**
   * Update the SHA that a child task was branched from
   */
  updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void>;

  /**
   * Update task model
   */
  updateTaskModel(taskId: string, model: string): Promise<void>;

  /**
   * Update a task's per-task runner override. Pass null to clear it (inherit
   * the global `[runner] type`). Unlike model/goal/prompt, this is allowed at
   * any time — including after work has begun — and takes effect on the next
   * launch (see {@link Task.runner_type}).
   */
  updateTaskRunnerType(taskId: string, runnerType: RunnerType | null): Promise<void>;

  /**
   * Update task type
   */
  updateTaskType(taskId: string, type: string): Promise<void>;

  /**
   * Update task queue priority (orders the concurrency drain sweep).
   */
  updateTaskPriority(taskId: string, priority: string): Promise<void>;

  /**
   * Reset the pending_sync counter to 0 (called when sync launches).
   */
  resetTaskPendingSync(taskId: string): Promise<void>;

  /**
   * Increment the pending_sync counter by 1 (called when a new sync signal arrives).
   */
  incrementTaskPendingSync(taskId: string): Promise<void>;

  /**
   * Abandon a task with a reason. Sets status to 'abandoned' and records the reason.
   */
  abandonTask(taskId: string, reason: string, actor?: Actor): Promise<void>;

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
   * Stamp the runner that actually launched this session. Recorded at launch as
   * the resolved `task.runner_type ?? config.runner.type` and read by monitoring
   * to discover/stop the run on the correct runner (see {@link Session.runner_type}).
   */
  updateSessionRunnerType(sessionId: string, runnerType: RunnerType | null): Promise<void>;

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

  /**
   * Set the user_stopped flag on a session.
   * When true, the reconciler will not auto-resume the interrupted task —
   * a manual resume/unblock is required. Cleared by resetConsecutiveInterruptions.
   */
  setUserStopped(sessionId: string, userStopped: boolean): Promise<void>;

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

  /**
   * Mark every `feedback_delivery: 'pending'` turn in a session as 'consumed'.
   *
   * Called when an agent response completes normally (the agent turn is
   * recorded) — at that point the agent has seen everything queued before it,
   * so the whole pending backlog clears at once and ordering can't be lost.
   *
   * Idempotent: a session with no pending feedback is a no-op. Must NOT be
   * called when recording an agent *error* turn — a crashed turn consumed
   * nothing, and that is precisely the case redelivery exists for.
   */
  markFeedbackConsumed(sessionId: string): Promise<void>;

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
   * Create a comment on a task.
   * @param source - 'remote' for comments synced from PR/MR, 'local' (default) for locally-created.
   */
  createComment(taskId: string, content: string, actor?: Actor, source?: CommentSource): Promise<Comment>;

  /**
   * Get all comments for a task
   */
  getTaskComments(taskId: string): Promise<Comment[]>;

  // --- Journal ---
  //
  // The task journal is an append-only, prompt-immune side channel for
  // orchestration metadata, decision rationale, and cross-run agent memories.
  //
  // INVARIANT: journal entries must NEVER be injected into the agent/LLM
  // prompt. They are a separate entity from comments precisely so there is no
  // shared code path that could leak them into a prompt. Do not add methods
  // here that feed the journal into prompt-assembly, auto-react, or remote PR
  // sync — those are comment behaviors, not journal behaviors.

  /**
   * Append an entry to a task's journal. Append-only: there is no update or
   * delete counterpart by design.
   */
  appendJournalEntry(taskId: string, content: string, actor?: Actor): Promise<JournalEntry>;

  /**
   * Get all journal entries for a task, in chronological order.
   */
  getTaskJournal(taskId: string): Promise<JournalEntry[]>;

  // --- Follow-ups (task-level orthogonal-work discoveries) ---

  /**
   * Append a follow-up note to a task.
   *
   * INVARIANT: This is a PASSIVE write — recording a follow-up MUST NOT trigger
   * any auto-turn, auto-resume, or auto-react. That non-triggering property is
   * exactly why follow-ups are a distinct store and NOT comments (comments feed
   * the comment auto-react loop, which would spuriously kick the agent into a
   * new turn — the "lost turn" failure follow-ups exist to avoid). See CLAUDE.md.
   * @param sessionId - the agent run that surfaced this follow-up, if known.
   */
  createFollowUp(taskId: string, content: string, sessionId?: string | null): Promise<FollowUp>;

  /**
   * Get all follow-ups for a task, oldest first.
   */
  getTaskFollowUps(taskId: string): Promise<FollowUp[]>;

  // --- Hunk Approvals (per-hunk "reviewed" state for `lazy review -i`) ---

  /**
   * List all hunk approvals for a task. The reviewer loads these at
   * startup to seed which hunks should be skipped in n/p navigation.
   */
  listHunkApprovals(taskId: string): Promise<HunkApproval[]>;

  /**
   * Persist a hunk approval. Idempotent on (task_id, hunk_hash) — if
   * the same hunk is approved twice, returns the existing record.
   */
  createHunkApproval(
    taskId: string,
    hunkHash: string,
    actor?: Actor,
    lineage?: HunkApprovalLineage,
  ): Promise<HunkApproval>;

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

  /**
   * Delete a stored conversation. Returns true if a conversation was deleted,
   * false if none existed under that session ID — so the operation is
   * idempotent and callers can report "already gone" without a pre-check race.
   *
   * The only caller today is `lazy doctor --purge-housekeeping-conversations`,
   * the one-time cleanup of machine-generated one-shots captured before they
   * were excluded at the source. Deleting a conversation is not recoverable
   * from lazy alone (Claude Code prunes the raw JSONL on disk over time), so
   * any new caller must be explicitly human-confirmed.
   */
  deleteConversation(sessionId: string): Promise<boolean>;

  // --- Agent Session Logs (raw Claude Code JSONL) ---

  /**
   * Save (create or overwrite) the raw agent session JSONL for a task.
   * Stored byte-for-byte and keyed by task so it survives worktree cleanup
   * and can later be rehydrated for `claude --resume <sessionId>`.
   */
  saveAgentSessionLog(taskId: string, sessionId: string, content: string): Promise<void>;

  /**
   * Load the raw agent session log previously captured for a task, or null
   * if none has been captured (e.g. the task never ran an agent turn).
   */
  getAgentSessionLog(taskId: string): Promise<AgentSessionLog | null>;

  // --- Proxy Audit (Tier-1 passive audit plane) ---

  /**
   * Append one proxy audit record. Append-only: records are never updated or
   * deleted. Written asynchronously by the passthrough proxy's audit queue
   * (src/proxy/audit.ts) — must not block the proxy hot path, so keep this
   * cheap and serial.
   */
  appendAuditRecord(record: ProxyAuditRecord): Promise<void>;

  /**
   * List proxy audit records in insertion order (oldest first). `limit` returns
   * the most recent N. Used by tooling and a later model-economics / routing
   * layer to query captured traffic.
   */
  listAuditRecords(options?: ListAuditRecordsOptions): Promise<ProxyAuditRecord[]>;

  // --- Builder Resume Intents (durable upgrade↔builder handshake) ---

  /**
   * Save (create or overwrite) a builder resume intent. Keyed by builderId —
   * writing an intent for a builderId that already has one overwrites it.
   * Written by `lazy upgrade` before it stops a builder container.
   */
  saveBuilderResumeIntent(intent: BuilderResumeIntent): Promise<void>;

  /**
   * Atomically consume the resume intent for a builderId: return it (or null if
   * none exists) and clear it in the same operation, so a given intent is acted
   * on at most once. Called by the host builder wrapper after a successful
   * relaunch.
   */
  takeBuilderResumeIntent(builderId: string): Promise<BuilderResumeIntent | null>;

  /**
   * List all outstanding builder resume intents, optionally filtered to a
   * single project root.
   */
  listBuilderResumeIntents(projectRoot?: string): Promise<BuilderResumeIntent[]>;

  // --- Tags ---
  //
  // Tags are lightweight, non-hierarchical grouping labels. The current set
  // lives on Task.tags; every add/remove is also appended to an immutable
  // tag-history audit trail (see getTagHistory). History is never rewritten —
  // untagging appends an 'untag' event, it does not erase the 'tag' event.

  /**
   * Add a tag to a task. The tag is normalized (lowercase, alphanumeric +
   * hyphens) before storage. Idempotent: if the task already carries the
   * normalized tag, this is a no-op and appends no history event. Otherwise the
   * tag is added to Task.tags and a 'tag' event (with actor) is appended to the
   * history. Returns the updated task.
   */
  addTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task>;

  /**
   * Remove a tag from a task. The tag is normalized before lookup. Idempotent:
   * if the task does not carry the tag, this is a no-op and appends no history
   * event. Otherwise the tag is removed from Task.tags and an 'untag' event
   * (with actor) is appended to the history. Returns the updated task.
   */
  removeTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task>;

  /**
   * Get the append-only tag-history for a task, in chronological order.
   * Every tag/untag ever performed, attributed to its actor. Returns [] for
   * tasks that have never been tagged.
   */
  getTagHistory(taskId: string): Promise<TagEvent[]>;

  // --- Memory (lazy-owned shared knowledge) ---
  //
  // Many small named records of curated, cross-task knowledge, plus an
  // append-only, actor-attributed write history (who wrote/updated/removed what
  // when — the same audit shape as tag history).
  //
  // INVARIANT: history is NEVER rewritten. An update supersedes the record by
  // name and appends an event; a delete tombstones the record and appends an
  // event. Neither erases what came before.
  //
  // INVARIANT (security boundary): task agents are read-only on memory. This
  // interface does not encode that — the gate lives at the MCP boundary
  // (`lazy_memory_save` rejects a non-empty ctx.taskId), because that is where
  // caller identity exists. Do not add an agent-reachable write path.

  /**
   * Create or update a memory record, keyed by `name` (already normalized by
   * the caller via `normalizeMemoryName`). Creating sets revision 1; updating
   * supersedes the body/description/type and increments the revision. Saving a
   * tombstoned name revives it as a new revision. Appends a history event.
   */
  saveMemory(input: MemoryWriteInput, actor: Actor): Promise<MemoryRecord>;

  /**
   * Get a live memory record by name, or null if it does not exist or has been
   * tombstoned. Tombstoned records remain visible through getMemoryHistory.
   */
  getMemory(name: string): Promise<MemoryRecord | null>;

  /**
   * List memory records, newest-updated first. Tombstoned records are excluded
   * unless `includeDeleted` is set.
   */
  listMemories(options?: { includeDeleted?: boolean }): Promise<MemoryRecord[]>;

  /**
   * Tombstone a memory record: it stops being listed, recalled, and injected,
   * but its history is preserved. Returns the tombstoned record, or null if no
   * live record with that name exists (idempotent).
   */
  deleteMemory(name: string, actor: Actor): Promise<MemoryRecord | null>;

  /**
   * Get the append-only memory write history in chronological order, for one
   * record (when `name` is given) or for every record.
   */
  getMemoryHistory(name?: string): Promise<MemoryEvent[]>;

  // --- Memory compact (derived, at most one per project) ---
  //
  // INVARIANT: the compact is DERIVED state. Records are never modified by
  // compaction, a recompact is always generated from the live records (never
  // from the previous compact), and losing the compact is harmless — injection
  // falls back to the full index. That is why it is a single overwritable slot
  // with no history: unlike records, nothing here is a source of truth.

  /**
   * Store (overwriting) the project's memory compact. Whatever compact existed
   * before is replaced — a compact is regenerated from the records, so old
   * versions carry no information worth keeping.
   */
  saveMemoryCompact(input: MemoryCompactInput, actor: Actor): Promise<MemoryCompact>;

  /** Get the project's memory compact, or null if none has been generated. */
  getMemoryCompact(): Promise<MemoryCompact | null>;

  /**
   * Delete the memory compact. Injection reverts to the full one-line-per-record
   * index. Idempotent: returns false when there was nothing to delete.
   */
  clearMemoryCompact(): Promise<boolean>;

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

  // --- Tracing ---

  /**
   * Append finished trace spans to durable storage (JSONL). Called by the
   * tracing span exporter — spans are persisted through Storage rather than
   * written to `.lazy/` directly, per the storage-abstraction invariant.
   */
  appendTraceSpans(spans: SpanRecord[]): Promise<void>;

  /**
   * Read persisted trace spans, optionally filtered to those starting at or
   * after `sinceMs` (epoch ms). Powers the `lazy timings` readout.
   */
  readTraceSpans(sinceMs?: number): Promise<SpanRecord[]>;
}
