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
  ActorIdentityMigrationResult,
  FollowUpMigrationResult,
  RaisedItem,
  RaisedItemInput,
  RaisedItemResolveAction,
  TurnReport,
  TurnReportInput,
  FileDecision,
  FileDecisionInput,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnOwner,
  TurnRole,
  TurnType,
  InFlightTurn,
  InFlightTurnOutcome,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  TaskCodeEntry,
  SearchResult,
  StoredConversation,
  ConversationSummary,
  AgentSessionLog,
  BuilderResumeIntent,
  BuilderSession,
  BuilderSessionUpdate,
  ProjectSettings,
  StatusChange,
  Actor,
  ActorInput,
  TagEvent,
  MemoryRecord,
  MemoryEvent,
  MemoryWriteInput,
  MemoryCompact,
  MemoryCompactInput,
  ScratchFile,
  ScratchFileInput,
  SystemMessage,
  SystemMessageInput,
  CommentSource,
  CommentCreateOptions,
  CommentUpdate,
  HunkApproval,
  HunkApprovalLineage,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewSession,
  ReviewSessionMessage,
  ReviewSessionMessageInput,
  ReviewSessionMessageUpdate,
  ReviewSessionUpdate,
  ReviewDraftState,
  ReviewDraftPatch,
  TaskArtifact,
  TaskArtifactContent,
  TaskArtifactInput,
  TaskToolStatsRecord,
  StoredUsageLimitReading,
} from './types';
import type { SpanRecord } from '../tracing/types';
import type { RunnerType } from '../config/types';
import type { FinalClaim, ReviewReport, WaitInterval, WaitOutcome } from '../types';
import type { WaitIntervalStart, WaitIntervalFilter } from './wait-intervals';

/**
 * The typed refusal of `createBuilderSession`: a rival active session exists
 * for the same member on the same PROJECT (§5.7). Lives beside the contract
 * it documents, not inside one backend — every Storage implementation throws
 * it for the same condition, and callers match on the class rather than on
 * one backend's import. The check and the insert run in the same locked
 * critical section, so the claim row a start writes before launching its
 * container is also what excludes a rival — two concurrent starts cannot both
 * register for the same member, and a start racing a raw storage-proxy call
 * is refused the same way. `rivalId` names the row that won; callers that
 * want it as a session re-read `getActiveBuilderSessionForMember` (the loser
 * of a start returns it).
 */
export class BuilderSessionActiveError extends Error {
  constructor(readonly rivalId: string, state: string) {
    super(
      `Builder session ${rivalId} is still active for this member (state '${state}') — ` +
      `one session per member per project; resume or end it before starting another.`,
    );
    this.name = 'BuilderSessionActiveError';
  }
}

/**
 * The typed refusal of `updateBuilderSession(id, patch, expectedState)`: the
 * row's state at WRITE time — read in the same locked critical section as
 * the write — was not the state the caller expected. Someone moved the row
 * first (§5.7: typically the member's own explicit end racing a launch that
 * was already in flight). `expectedState` is what the caller required;
 * `actualState` is what the row said when the write ran. The guard never
 * rewrites the row and never reverts the member's decision: the refused
 * caller re-reads `getBuilderSession` and defers to the row's current state.
 */
export class BuilderSessionStateConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expectedState: BuilderSession['state'],
    readonly actualState: BuilderSession['state'],
    readonly expectedBuilderId?: string,
    readonly actualBuilderId?: string,
  ) {
    super(
      (expectedBuilderId !== undefined && expectedBuilderId !== actualBuilderId
        ? `Builder session ${id} was relaunched (builder id '${actualBuilderId}', not the expected '${expectedBuilderId}') — `
        : `Builder session ${id} is in state '${actualState}', not the expected '${expectedState}' — `) +
      `the row moved on before this update could land; re-read it and defer to its current state.`,
    );
    this.name = 'BuilderSessionStateConflictError';
  }
}

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
  /**
   * Paths left uncommitted in the worktree when this turn ended. Pass only a
   * NON-EMPTY set — see `Turn.uncommitted` for why an empty one is not the
   * same statement as an absent one.
   */
  uncommitted?: string[];
  /**
   * Agent id this turn was launched with (e.g. `claude-code`, `cursor`). Omit
   * when it is not known — absent means "unknown", never "the task's current
   * agent" and never the configured default. See `Turn.agent`.
   */
  agent?: string;
  /** Model this turn was launched with (request side — usually a tier alias). */
  model?: string;
  /**
   * Concrete model id the agent self-reported for this turn (agent turns only).
   * Omit when the agent reported none — never fall back to the alias here, or
   * the alias-vs-concrete distinction becomes unrecoverable.
   */
  modelId?: string;
  /** Reasoning effort in force for this turn, as resolved at launch. */
  effort?: string;
  /**
   * What the agent reported about its own lazy MCP tools at session start
   * (`lazy=<status> tools=<n>`). Omit when the agent reported nothing — absent
   * means "unknown", never "had none". See `Turn.mcp_tools`.
   */
  mcpTools?: string;
  prompt?: string;
  /**
   * Who created this turn: human (CLI) or builder (MCP). Only meaningful for
   * role='human' turns. Pass an {@link ActorRef} to also record WHICH person
   * acted — daemon-imposed from the caller's user actor token, never client-set.
   */
  actor?: ActorInput;
  /** Exit code of the post-turn check command */
  checkExitCode?: number;
  /** Captured output from the post-turn check command */
  checkOutput?: string;
  /** Exit code of the pre-turn setup hook, when it failed before this turn */
  preTurnExitCode?: number;
  /** Captured output of the failed pre-turn setup hook */
  preTurnOutput?: string;
  /** Whether this turn was auto-triggered (CI failure, comment, upstream sync, crash) vs human-triggered */
  autoTriggered?: boolean;
  /**
   * Turn category. Defaults to 'work' (substantive task-advancing turn) when
   * omitted. Use 'ask' for read-only Q&A exchanges (e.g. `lazy browse -i`).
   * Use 'review' for an agent review turn (`lazy review`).
   */
  turnType?: TurnType;
  /**
   * Structured findings from an agent review. Only meaningful on the agent
   * turn of a `turnType: 'review'` exchange. See {@link ReviewReport}.
   */
  review?: ReviewReport;
  /**
   * HOW this review was started: 'auto' (the daemon dispatched it after a
   * final) or 'manual' (a human's `lazy review`, a driver's `lazy_review`).
   *
   * The accept gate reads it: under the default gate only a `separate` task's
   * dispatched review holds a merge, while a review somebody ASKED for holds
   * one whatever mode the task is in. Absent is read as 'manual' — the gating
   * direction, and what every turn recorded before this field already did.
   */
  reviewDispatch?: 'auto' | 'self' | 'manual';
  /**
   * This review's findings were ALREADY ACTED ON by the same exchange that
   * produced it — the `low_high` revise pass, which runs straight after the
   * self-review and applies its instructions.
   *
   * The recorded report is the PRE-fix state (that is what the reviewer wrote),
   * and the revise phase is a supervised `nudge` turn, so `hasWorkAgentTurnAfter`
   * never clears it: without this, `gate = "always"` holds a merge forever on
   * findings that were fixed seconds later, and a project on that setting could
   * not land a task whose self-review worked.
   */
  reviewAddressed?: boolean;
  /**
   * Pencils down: the declaration that this turn's agent (or a human) made that
   * the task's work is finished. See {@link FinalClaim}.
   *
   * INVARIANT (final-turn design §13.1): the claim is recorded on the turn that
   * MADE it and nowhere else — never as a field on the task. Whether the task
   * is final NOW is `resolveFinalState`'s answer over these records.
   */
  final?: FinalClaim;
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
  /**
   * True when the error turn provably had no effect on the branch (no commits,
   * clean worktree). See `Turn.agent_had_no_effect` for semantics.
   */
  agent_had_no_effect?: boolean;
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
   * Create a new task.
   *
   * `actor` records the CHANNEL the creation came through (MCP → 'builder' or
   * 'agent', CLI → omitted, which reads as human). It is stamped on the initial
   * 'backlog' status-changelog entry so "who created this task" is auditable.
   */
  createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string, actor?: ActorInput): Promise<Task>;

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
   * Every task's id and code — identity only, no task bodies.
   *
   * For callers that want to map codes to tasks (autolinking prose, resolving a
   * code a human typed) and would otherwise materialise the whole store to read
   * one field off each task. Ordering is unspecified: this is a lookup table,
   * not a listing.
   */
  listTaskCodes(): Promise<TaskCodeEntry[]>;

  /**
   * How many descendants — children, grandchildren, … — each of `taskIds` has.
   *
   * Same numbers as `descendantCounts()` over the full task set, without
   * materialising it. Keyed by the ids passed in; an id the store does not know
   * maps to 0. A plain object rather than a Map because this crosses the daemon
   * RPC boundary.
   */
  countDescendants(taskIds: string[]): Promise<Record<string, number>>;

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: TaskStatus, actor?: ActorInput): Promise<void>;

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
   * Update the agent to use for this task. Allowed at any time while the task
   * is live (not in terminal status). The change takes effect on the next turn.
   * NOTE: When switching agents mid-task, the caller must also clear the
   * session's agent_session_id since sessions cannot be resumed across agents.
   */
  updateTaskAgent(taskId: string, agentId: string): Promise<void>;

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
  abandonTask(taskId: string, reason: string, actor?: ActorInput): Promise<void>;

  /**
   * Reopen an abandoned task: reset status to 'blocked' and clear completed_at
   */
  reopenTask(taskId: string, actor?: ActorInput): Promise<void>;

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
   * Get prompt version history for a task. This is for HISTORY — for the
   * CURRENT prompt use `currentPromptOf(task)` (`src/task-prompt.ts`), never
   * an index into this array.
   *
   * WARNING: the ORDER of this array is backend-dependent and unspecified.
   * FileStorage returns it newest-first, PostgresStorage oldest-first. Five
   * callers each independently read `history[history.length - 1]` as "the
   * current prompt", which on the default file backend is the ORIGINAL one:
   * `lazy_show` reported a prompt the agent never received, and `clone`/`redo`
   * seeded new tasks with superseded text that then got executed.
   *
   * Sort by `version` yourself if order matters to you. (Making the two
   * backends agree would be the better fix, but it changes an assertion in an
   * invariant test — `test/unit/storage-concurrent-writes.test.ts` — so it
   * needs human approval rather than a passing agent's judgment.)
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
   * Update session's container name for async tracking.
   *
   * When `containerName` is null the container is gone — also clears
   * `container_agent_id` (the stamp describes the container we just dropped).
   * When setting a name, pass `containerAgentId` to stamp which profile the
   * (re)created container was launched for; omit it to leave the stamp alone
   * (legacy clear-only callers).
   */
  updateSessionContainerName(
    sessionId: string,
    containerName: string | null,
    containerAgentId?: string | null,
  ): Promise<void>;

  /**
   * Stamp the runner that actually launched this session. Recorded at launch as
   * the resolved `task.runner_type ?? config.runner.type` and read by monitoring
   * to discover/stop the run on the correct runner (see {@link Session.runner_type}).
   */
  updateSessionRunnerType(sessionId: string, runnerType: RunnerType | null): Promise<void>;

  /**
   * Update a session's agent when switching agents mid-task, and — when
   * `resetAgentSession` — clear its agent_session_id so the next turn starts a
   * fresh agent session.
   *
   * `agentId` is a PROFILE name; the reset is a HARNESS decision. A session id
   * is only meaningful to the agent binary that issued it, so it survives a
   * switch between two profiles of the same harness (e.g. two claude-code
   * profiles on different upstreams) and must not survive a switch to a
   * different one. The caller knows which case it is — hence the explicit
   * argument rather than an inference from the id here.
   */
  updateSessionAgent(sessionId: string, agentId: string, resetAgentSession: boolean): Promise<void>;

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
   * Record that every comment created at or before `timestamp` has been
   * delivered to the agent in a prompt. Monotonic — never moves backwards.
   * See {@link Session.notes_delivered_through}.
   */
  markNotesDelivered(sessionId: string, timestamp: number): Promise<void>;

  /**
   * Record who asked for the turn this session is about to run, or `null` when
   * nobody did. See {@link Session.turn_owner_email}.
   *
   * `systemInitiated` says the daemon started the turn ITSELF, and is written
   * in the SAME operation so the two can never disagree: a launch that records
   * a person clears the mark, and one that clears the owner sets it. A caller
   * that passes neither records "no asker, and we are not claiming the daemon
   * did it" — which is what a failed write must degrade to
   * ({@link Session.turn_system_initiated}).
   *
   * DAEMON-ONLY, and not proxied by RemoteStorage: the owner is derived from
   * the caller's token (or, on a laptop, from the daemon's own git config), so
   * accepting it over the wire would make attribution a request field — the one
   * thing the whole identity design refuses. It is written by the launch path
   * (src/daemon/turn-owner.ts) and read by everything that attributes an
   * agent's work.
   */
  setSessionTurnOwner(
    sessionId: string,
    owner: TurnOwner | null,
    systemInitiated?: boolean,
  ): Promise<void>;

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
   * Get the next turn sequence number for a session.
   *
   * Accounts for sequences handed out by {@link reserveTurnSequences} as well
   * as the turns that already exist, so a reserved slot is never re-used by an
   * unrelated writer.
   */
  getNextTurnSequence(sessionId: string): Promise<number>;

  /**
   * Reserve `count` consecutive turn sequences and return the FIRST of them.
   *
   * `getNextTurnSequence` allocates from what exists; it does not reserve. A
   * caller that has to recognize its own answer later ("the agent turn at
   * sequence N is mine") needs the numbers held, not merely observed — see
   * {@link Session.reserved_turn_sequence}.
   */
  reserveTurnSequences(sessionId: string, count: number): Promise<number>;

  // --- In-flight turns ---

  /**
   * Claim the task's in-flight turn slot. Returns false when a LIVE (unexpired)
   * record is already there — the claim is a compare-and-set, so two waiters
   * can never both believe they own the channel.
   *
   * An expired record is overwritten: an in-flight turn is bounded by its
   * deadline, never by the liveness of whoever started it.
   */
  beginInFlightTurn(taskId: string, turn: InFlightTurn): Promise<boolean>;

  /**
   * Stamp the run/container the in-flight turn at `turnSequence` is executing
   * in, once its launch has succeeded. Returns false when no record with that
   * sequence is present.
   *
   * This is what makes an ASYNCHRONOUS ask/review probeable and stoppable: with
   * no RPC caller holding the answer, "is the reviewer still alive?" and "which
   * container does `lazy stop` kill?" are both answered from here. Stamped
   * AFTER the launch on purpose — its absence is the startup grace, so a
   * reconcile tick landing between the claim and the launch cannot mistake a
   * run that has not started yet for one that died.
   */
  stampInFlightTurnRun(
    taskId: string,
    turnSequence: number,
    run: { runName: string; runnerType?: RunnerType },
  ): Promise<boolean>;

  /**
   * Record how the in-flight turn at `turnSequence` ended. Returns false when
   * no record with that sequence is present, so a settler that raced a clear
   * (or a stale settler) writes nothing.
   */
  settleInFlightTurn(taskId: string, turnSequence: number, outcome: InFlightTurnOutcome): Promise<boolean>;

  /**
   * Clear the task's in-flight turn record. When `turnSequence` is given, only
   * a record with that sequence is cleared — a waiter must never clear a record
   * belonging to a later turn.
   */
  clearInFlightTurn(taskId: string, turnSequence?: number): Promise<void>;

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
   * Fill the wrap-up audit record (final-turn design §13.3) on a turn's final
   * claim with the wrap-up steps that actually ran. Called by the settle/work
   * paths right after the turns are recorded; best-effort on the caller side.
   * Throws when the turn no longer exists.
   */
  updateTurnWrapUpSteps(taskId: string, turnId: string, wrapUpSteps: string[]): Promise<void>;

  /**
   * Replace the structured review record on a turn.
   *
   * Used after a review turn is persisted, once forge comments have been
   * posted, so a remote failure can never lose the review itself.
   */
  updateTurnReview(taskId: string, turnId: string, review: ReviewReport): Promise<void>;

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

  /**
   * Remove commit records by SHA and return how many were removed.
   *
   * The one way a commit record is ever deleted, and it exists for a single
   * caller: the explicit `lazy system repair-commits` repair of lists that a
   * historical range bug over-recorded (see src/task/session-commits.ts).
   * Recording paths only ever ADD — nothing removes a record implicitly.
   */
  deleteSessionCommits(sessionId: string, shas: string[]): Promise<number>;

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
   * @param options - structured forge identity ({@link Comment.external}) and,
   *   for the revision of a seen comment, the comment it revises.
   */
  createComment(taskId: string, content: string, actor?: ActorInput, source?: CommentSource, options?: CommentCreateOptions): Promise<Comment>;

  /**
   * Change an existing comment's content and/or forge identity. A content
   * change stamps `edited_at`; `created_at` never moves, so the comment keeps
   * its place in the delivery order.
   *
   * This is the RAW write and enforces no policy. Whether a comment may be
   * edited at all (only while the agent has not seen it) is a business rule
   * that lives in `src/task/comment-edit.ts`; every caller that edits content
   * goes through it. Stamping identity onto a seen comment is fine — it
   * changes nothing the agent read.
   * @param actor - who is editing the content, stamped as edited_by /
   *   edited_by_email / edited_by_name. Ignored for an identity-only update.
   */
  updateComment(taskId: string, commentId: string, update: CommentUpdate, actor?: ActorInput): Promise<Comment>;

  /**
   * Get all comments for a task
   */
  getTaskComments(taskId: string): Promise<Comment[]>;

  // --- Journal ---
  //
  // The task journal is an append-only, pull-based side channel for
  // orchestration metadata, decision rationale, and cross-run agent memories.
  //
  // INVARIANT: appending an entry must never trigger a turn, and entry CONTENT
  // must never be injected into the agent/LLM prompt. Prompt assembly may read
  // the journal for exactly one purpose — counting entries new since the last
  // agent turn, to render the count-only notice (`buildJournalNotice`). Entries
  // are a separate entity from comments precisely so no shared code path can
  // leak a body into a prompt. Do not add methods here that feed journal text
  // into prompt-assembly, auto-react, or remote PR sync — those are comment
  // behaviors, not journal behaviors.

  /**
   * Append an entry to a task's journal. Append-only: there is no update or
   * delete counterpart by design.
   */
  appendJournalEntry(taskId: string, content: string, actor?: ActorInput): Promise<JournalEntry>;

  /**
   * Get all journal entries for a task, in chronological order.
   */
  getTaskJournal(taskId: string): Promise<JournalEntry[]>;

  // --- Raised items (everything an agent surfaces for human eyes) ---
  //
  // ONE entity with ONE flag: `blocking: true` gates accept (a question or
  // decision about this task's own scope or diff), `blocking: false` never does
  // (orthogonal proposals, FYIs — the former follow-ups).
  //
  // INVARIANT: creating or resolving a raised item is a PASSIVE write — it must
  // NOT create a comment, change task status, or trigger an auto-turn. That
  // non-triggering property is exactly why this is a distinct store and NOT
  // comments (comments feed the auto-react loop, which would spuriously kick the
  // agent into a new turn). The pending comment is stored on the item;
  // unblock/accept materializes it. Accept refuses while BLOCKING items are
  // open; that is the only lifecycle coupling. Close / reject / abandon leave
  // open items as historical `open`. See docs/design/raised-items-unified.md.

  /**
   * Append a raised item to a task.
   *
   * `input.blocking` is REQUIRED — every caller decides whether the item gates
   * accept. Non-triggering, per the invariant above.
   */
  createRaisedItem(taskId: string, input: RaisedItemInput): Promise<RaisedItem>;

  /**
   * Get all raised items for a task, oldest first.
   */
  getTaskRaisedItems(taskId: string): Promise<RaisedItem[]>;

  /**
   * Append a note on a raised item (agent reply after review, disagreement,
   * "fixed in commit …", etc.). Does NOT change status or clear accept gates.
   * Passive — no signal, no auto-turn.
   *
   * The actor is an `ActorInput` because this row NAMES A PERSON: a raised item
   * is what gates an accept, and its conversation is the human-written record a
   * reviewer reads beside an attributed resolution. It is declared in
   * PERSON_ATTRIBUTED_STORAGE_ACTORS (src/daemon/rpc-command-kinds.ts), which is
   * what makes both the daemon's stamping and a user token's pinning reach it.
   */
  addRaisedItemComment(
    taskId: string,
    itemId: string,
    input: {
      content: string;
      actor: ActorInput;
      session_id?: string | null;
      turn_sequence?: number | null;
    },
  ): Promise<RaisedItem>;

  /**
   * Resolve a raised item (respond / promote_subtask / promote_peer / dismiss).
   * Stores a pending comment; does not write a real comment.
   * Overwrites an existing resolution when the comment has not been delivered.
   * Refuses a change after comment_delivered_at is set (except same-status idempotent).
   */
  resolveRaisedItem(
    taskId: string,
    itemId: string,
    resolution: {
      action: RaisedItemResolveAction;
      /**
       * Who decided. An {@link ActorRef} additionally stamps
       * `resolved_by_email` / `resolved_by_name` — a raised-item decision gates
       * a merge, so a team
       * must be able to see which member made it, not just that "a human" did.
       */
      actor: ActorInput;
      response?: string | null;
      pending_comment?: string | null;
    },
  ): Promise<RaisedItem>;

  /**
   * Clear a resolution that has not been delivered yet (item returns to open).
   * Refuses after comment_delivered_at — comments are append-only.
   *
   * `actor` is recorded as `unresolved_by` (plus the person, for a ref): the
   * decision is gone, so who UNDID it is the only attribution left to keep.
   */
  unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput): Promise<RaisedItem>;

  /**
   * Stamp that the pending comment was written as a real comment.
   * Optionally records a promote_peer task id created at materialize time,
   * and — once the carrying turn is known — the turn number it rode in on
   * (`delivered_turn`). A second call on an already-delivered item may add
   * `delivered_turn` but never resets `comment_delivered_at`.
   */
  markRaisedItemCommentDelivered(
    taskId: string,
    itemId: string,
    extras?: {
      promoted_task_id?: string | null;
      promoted_task_code?: string | null;
      pending_comment?: string | null;
      delivered_turn?: number | null;
    },
  ): Promise<RaisedItem>;

  /**
   * Flip whether an item gates accept. The agent chooses the flag at raise
   * time; the builder/human may correct it at review (CLI, MCP, web).
   *
   * Idempotent. Allowed on resolved items too — a reviewer re-flagging a
   * resolved item changes nothing about the gate, and refusing would make the
   * listing's toggle fail unpredictably.
   */
  setRaisedItemBlocking(
    taskId: string,
    itemId: string,
    blocking: boolean,
    actor: ActorInput,
  ): Promise<RaisedItem>;

  /**
   * Promote a raised item into a backlog task and mark it promoted.
   *
   * Works for either flavour. `proposed_code` / `proposed_prompt` on the item
   * supply the new task's code and prompt when the caller does not override.
   *
   * INVARIANT: creates BACKLOG only — never auto-starts. Re-promote is refused.
   * A deliberate human/builder act (same posture as MCP create for vetting).
   */
  promoteRaisedItem(
    taskId: string,
    itemId: string,
    options: {
      goal?: string;
      prompt?: string;
      code?: string;
      parent?: string;
      /** `peer` (default, the former follow-up behavior) or `subtask`. */
      relation?: 'peer' | 'subtask';
      /** Who promoted it — stamped on the item's resolution and the new task. */
      actor: ActorInput;
    },
  ): Promise<import('../types').PromoteRaisedItemResult>;

  /**
   * Seed a BACKLOG task from a consecutive range of a stored conversation's
   * messages, resolving `sessionId` by exact id or unique prefix.
   *
   * Same posture as {@link promoteRaisedItem}: the shared seeding path creates
   * the task, nothing is started, and the durable link back is written on the
   * TASK (`metadata.promoted_from_conversation`) — never on the conversation
   * record, which capture rewrites wholesale every time the session grows.
   *
   * An EXACT repeat of a range already promoted is refused; an overlapping one
   * is allowed and reported, because a long conversation legitimately yields
   * several tasks.
   */
  promoteConversation(
    sessionId: string,
    options: {
      /** 1-based inclusive message numbers; `to` defaults to `from`. */
      from?: number;
      to?: number;
      goal?: string;
      prompt?: string;
      code?: string;
      /** Task id/code to parent the new task under; absent = top level. */
      parent?: string;
      actor: Actor;
    },
  ): Promise<import('../types').PromoteConversationResult>;

  /**
   * Convert every pre-unification follow-up record into a raised item with
   * `blocking: false`. Run once at daemon start.
   *
   * INVARIANT: idempotent and loud. A record that cannot be converted is left
   * in place, its task's follow-up file is NOT retired, and the failure is
   * reported — never dropped. Nothing is deleted; the source file is renamed,
   * not removed. See docs/design/raised-items-unified.md.
   */
  migrateFollowUpsToRaisedItems(): Promise<FollowUpMigrationResult>;

  /**
   * Rewrite stored attribution off the control plane's `actor_user_id` and onto
   * the `actor_email` the store now names people by. Run once at daemon start.
   *
   * INVARIANT: idempotent and loud. An id that cannot be read as an email is
   * CLEARED — carrying `user-12` into a field that promises an address would
   * render a person who does not exist — and both the count and the distinct
   * ids come back so the daemon can report them. Silently dropping attribution
   * is the one thing this migration must not do. See
   * docs/design/actor-identity-and-remote-clients.md §3.8.
   */
  migrateActorIdentity(): Promise<ActorIdentityMigrationResult>;

  // --- Turn reports (structured end-of-turn summaries via lazy_report) ---
  //
  // INVARIANT: upserting a turn report is a PASSIVE write — no status change,
  // no auto-turn, no turn-end/liveness signal. Latest-wins per session_id.
  // Agent-chosen section order is the presentation contract.

  /**
   * Replace-or-create the structured report for this task+session (latest-wins).
   * Non-triggering — same posture as createFollowUp / createRaisedItem.
   */
  upsertTurnReport(taskId: string, input: TurnReportInput): Promise<TurnReport>;

  /** All turn reports for a task, oldest first. */
  getTaskTurnReports(taskId: string): Promise<TurnReport[]>;

  /** Report for a session, if any. */
  getTurnReportBySession(taskId: string, sessionId: string): Promise<TurnReport | null>;

  /**
   * Best-effort stamp of turn_sequence onto the session's report.
   * No-op if no report exists. Callers (reconciler) must catch errors so a
   * stamp failure never fails the turn.
   */
  stampTurnReportSequence(taskId: string, sessionId: string, turnSequence: number): Promise<void>;

  // --- File decisions (protected/maintain keep justifications) ---
  //
  // INVARIANT: passive write; justification never auto-approves a protected file.

  /**
   * Upsert a keep justification. Latest-wins per (session_id, scope, target)
   * when session_id is set; otherwise per (scope, target) task-wide.
   */
  upsertFileDecision(taskId: string, input: FileDecisionInput): Promise<FileDecision>;

  /** All file decisions for a task, oldest first. */
  getTaskFileDecisions(taskId: string): Promise<FileDecision[]>;

  /**
   * List every raised item in the project with originating-task context,
   * mechanical recurrence grouping, and promotion hints derived from task prompts.
   * Filterable by `blocking`.
   */
  listRaisedItems(options?: import('../raised').ListRaisedItemsOptions): Promise<import('../raised').ListRaisedItemsResult>;

  // --- Task artifacts (named files attached to a task) ---
  //
  // An artifact is a file handed TO a task (design assets, a spec, a fixture) or
  // PUBLISHED BY it (a report, a rendered image, a data dump). It replaces the
  // pre-artifact smuggle of pasting file content into a comment.
  //
  // INVARIANT: attaching an artifact is a PASSIVE write. It must never create a
  // comment, change task status, or trigger an auto-turn/auto-resume — the same
  // non-triggering property as follow-ups, and for the same reason. Artifact
  // CONTENT is never injected into an agent prompt: the launch path materializes
  // the files into the worktree and the prompt carries a count-and-location
  // notice only. Do not add methods here that feed artifact bytes into prompt
  // assembly — that is comment behavior, not artifact behavior.
  //
  // INVARIANT: bounded by construction. Implementations MUST enforce
  // `assertArtifactWithinLimits` (src/artifacts/limits.ts) before persisting.
  // Unbounded per-task growth inside the store is the failure mode that broke a
  // real store once (see the proxy audit log carve-out in CLAUDE.md); artifacts
  // must not become the second instance.

  /**
   * Attach an artifact to a task, or REPLACE the existing artifact of the same
   * name. There is deliberately no versioning: one name, one artifact.
   *
   * Throws `ArtifactLimitError` when the per-file, per-task-total or per-task
   * count bound would be breached, and `ArtifactNameError` for a name that is
   * absolute or escapes the artifact root.
   */
  createTaskArtifact(taskId: string, input: TaskArtifactInput, actor?: Actor): Promise<TaskArtifact>;

  /**
   * List a task's artifacts (METADATA ONLY), oldest first. Content is fetched
   * per-artifact so that listing a task with a megabyte of attachments costs a
   * few hundred bytes.
   */
  listTaskArtifacts(taskId: string): Promise<TaskArtifact[]>;

  /**
   * Read one artifact by name, content included, or null when the task or the
   * name does not exist.
   */
  getTaskArtifact(taskId: string, name: string): Promise<TaskArtifactContent | null>;

  /** Remove an artifact by name. Returns false when there was nothing to remove. */
  deleteTaskArtifact(taskId: string, name: string): Promise<boolean>;

  // --- Review regions (the carved cover of a task's review range) ---
  //
  // A region cover is a persistent domain object on the task, so it lives here
  // like everything else — there is no `.lazy/cache` carve-out for it. It is
  // derived from git, but it is not disposable in the way the proxy audit log
  // is: a reviewer's overlay hangs off its unit ids, and losing the cover
  // loses the sign-offs with it.
  //
  // INVARIANT: the cover is REPLACED wholesale by a refresh and the overlay is
  // NOT. Region identity is the unit id (a task code, a chunk index, a commit
  // sha), never a position in a slicing, which is what lets the daemon
  // recompute at the end of every turn without anything shifting under a
  // reviewer mid-review. Do not merge overlay fields into the stored cover —
  // the next refresh would drop them.

  /**
   * The task's stored region cover, or null when none has been computed yet
   * (a task whose first turn has not finished, or an older task).
   *
   * The human overlay is NOT merged in here — callers that render regions
   * apply it with `applyRegionOverlays`, because the daemon is also a caller
   * and must write back a cover with no overlay in it.
   */
  getRegionCover(taskId: string): Promise<import('../regions').RegionCover | null>;

  /** Replace the task's region cover. Overlays are untouched. */
  saveRegionCover(taskId: string, cover: import('../regions').RegionCover): Promise<void>;

  /** The task's human region overlays, keyed by unit id. */
  getRegionOverlays(taskId: string): Promise<import('../regions').RegionOverlay[]>;

  /**
   * Set or update one region's overlay, merged field-by-field over any
   * existing one so naming a region does not clear its sign-off.
   *
   * Accepts a unit id that is not (or not yet) in the cover: an overlay
   * outlives the cover it was written against by design.
   *
   * `actor` is WHO is making this write, derived by the daemon from the calling
   * token and never from a request field. It is recorded against the fields
   * this patch actually changes — the owner, the sign-off, or both — so a later
   * rename cannot make one person's annotation look like another's. Absent
   * means the caller could not be attributed to a person (the CLI, the daemon's
   * own review page, a control-plane token); the attribution on the fields
   * being written is then REMOVED rather than left pointing at whoever wrote
   * them last.
   */
  setRegionOverlay(
    taskId: string,
    unitId: string,
    patch: {
      name?: string;
      owner?: string | null;
      signed_off_sha?: string | null;
      actor?: import('../regions').OverlayActor;
    },
  ): Promise<import('../regions').RegionOverlay>;

  // --- Hunk Approvals (per-hunk "reviewed" state for `lazy browse -i`) ---

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

  // --- Review Comments (anchored, threaded diff comments) ---

  /**
   * Persist an anchored review comment (file + line + diff side) or a reply in
   * an existing thread.
   *
   * INVARIANT: Human feedback is saved FIRST, before any failable dispatch
   * (ask launch, agent resume, network). A comment that never reaches the agent
   * MUST still exist and be visible. See CLAUDE.md "Never Lose Human Feedback".
   *
   * INVARIANT: This is a PASSIVE write, like follow-ups — it MUST NOT feed the
   * comment auto-react loop. Review comments reach the agent only through an
   * explicit, read-only `ask` turn, or batched into an unblock work turn; they
   * are NOT `Comment` records and never start a turn by themselves.
   */
  createReviewComment(taskId: string, input: ReviewCommentInput): Promise<ReviewComment>;

  /**
   * Get all review comments for a task, oldest first.
   */
  getTaskReviewComments(taskId: string): Promise<ReviewComment[]>;

  /**
   * Update the delivery bookkeeping on a review comment: ask state (pending →
   * answered/failed) for 'ask' intent, delivery state (pending_delivery →
   * delivered) for 'comment' intent.
   *
   * The comment body, its anchor, and its intent are immutable — only delivery
   * state may change, so a failed ask degrades to a visible error and an
   * unblock that never launched leaves its comments pending for the next
   * attempt, rather than either losing the human's words.
   *
   * `withdrawnAt` is the one deliberate exception, and it is not an edit: it
   * records that the reviewer retracted their OWN message before it reached the
   * agent. The record and its thread survive; the message is simply excluded
   * from the queue and from any future unblock. It is one-way — implementations
   * must set it, never clear it.
   */
  updateReviewComment(
    taskId: string,
    commentId: string,
    update: ReviewCommentUpdate,
  ): Promise<ReviewComment>;

  // --- Review Sessions (task-scoped builder review conversations) ---

  /**
   * Create an empty review session for a task. The lazy-minted id exists before
   * any agent runs. v1: one session per task — rejects if one already exists.
   */
  createReviewSession(taskId: string): Promise<ReviewSession>;

  /** Primary read in v1 — at most one session per task. */
  getReviewSessionByTaskId(taskId: string): Promise<ReviewSession | null>;

  /** Update session status and/or the Claude --resume target. */
  updateReviewSession(sessionId: string, patch: ReviewSessionUpdate): Promise<ReviewSession>;

  /**
   * Append a transcript message. Human messages default to delivery `pending`
   * and MUST be persisted before any failable builder launch.
   */
  appendReviewSessionMessage(
    sessionId: string,
    message: ReviewSessionMessageInput,
  ): Promise<ReviewSessionMessage>;

  /** Advance launch delivery bookkeeping on an existing message. */
  updateReviewSessionMessage(
    sessionId: string,
    messageId: string,
    patch: ReviewSessionMessageUpdate,
  ): Promise<ReviewSessionMessage>;

  /** Messages for a session, oldest first (embedded on get in v1). */
  listReviewSessionMessages(sessionId: string): Promise<ReviewSessionMessage[]>;

  // --- Review drafts (a review in progress: unsent words + viewed ticks) ---

  /**
   * Read the reviewer's in-progress review state for a task, or null when
   * there is none.
   *
   * `reviewer` is the key from {@link ReviewDraftState.reviewer} — the actor's
   * user id where the daemon could attribute the caller to a person, else
   * `local`. Callers should not compose it by hand; use `reviewerKey()` in
   * src/review-draft.ts.
   */
  getReviewDraft(taskId: string, reviewer: string): Promise<ReviewDraftState | null>;

  /**
   * Write part of a review draft, creating the record on first write.
   *
   * INVARIANT (CLAUDE.md "Never Lose Human Feedback"): this is a PATCH, not a
   * replace. An omitted key is left as it was, so the feedback box autosaving
   * mid-sentence can never blank the accept reason a reviewer typed in another
   * tab. Clearing is explicit: write `''`.
   *
   * INVARIANT: this is a PASSIVE write, like follow-ups and review comments —
   * it never starts a turn and never reaches the agent. A draft is by
   * definition something the reviewer has NOT sent.
   */
  saveReviewDraft(
    taskId: string,
    reviewer: string,
    patch: ReviewDraftPatch,
  ): Promise<ReviewDraftState>;

  /**
   * Drop a reviewer's whole draft record for a task. Idempotent: returns false
   * when there was nothing to delete.
   */
  deleteReviewDraft(taskId: string, reviewer: string): Promise<boolean>;

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
   * List conversation metadata only — no transcripts — sorted by startedAt DESC,
   * the same order as {@link listConversations}.
   *
   * Listing surfaces (the web `/conversations` page, `/api/conversations`,
   * `lazy conversations list`, `lazy builder list`) must use this instead of
   * `listConversations()`, which parses every full transcript. Search and a
   * single-conversation read still go through `listConversations` /
   * `loadConversation`.
   */
  listConversationSummaries(): Promise<ConversationSummary[]>;

  /**
   * Check if a conversation has been imported
   */
  isConversationImported(sessionId: string): Promise<boolean>;

  /**
   * Delete a stored conversation. Returns true if a conversation was deleted,
   * false if none existed under that session ID — so the operation is
   * idempotent and callers can report "already gone" without a pre-check race.
   *
   * Two callers today, both one-time cleanups behind an explicit flag:
   * `lazy doctor --purge-housekeeping-conversations` (machine-generated
   * one-shots captured before they were excluded at the source) and
   * `lazy doctor --clean-local-command-conversations
   * --delete-empty-local-command-conversations` (rows holding nothing but
   * Claude Code scaffolding). Deleting a conversation is not recoverable
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

  // NOTE: the proxy audit plane deliberately does NOT live here. Storage holds
  // permanent state; the audit stream is high-churn, disposable telemetry and
  // lives in the impermanent project-local `.lazy/` dir, size-capped — see
  // src/proxy/audit-log.ts.

  // --- Project settings overlay ---
  //
  // The deployment's operational overrides, layered over the repository's
  // lazy.toml (docs/design/lazy-teams.md §11). Deliberately in Storage and not
  // in a file: it must survive a VM rebuild and travel with the project.

  /**
   * Read the project's settings overlay, or null when nothing has ever been
   * set. Null means "no overrides" — every effective value comes from
   * lazy.toml. Callers must not treat null as an error.
   */
  getProjectSettings(): Promise<ProjectSettings | null>;

  /**
   * Replace the project's settings overlay wholesale. The caller passes the
   * complete desired overlay; a key absent from `settings` is an override that
   * is being CLEARED, not one left untouched. Whole-record replace rather than
   * per-key patch because a settings form submits the whole form, and a patch
   * API makes "unset this back to the repository default" inexpressible.
   */
  saveProjectSettings(settings: ProjectSettings): Promise<void>;

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

  // --- Builder Sessions (daemon-owned interactive builder registry) ---

  /**
   * Register a new builder session. The caller has not necessarily launched
   * the container yet — `state: 'starting'` is the expected initial value,
   * moved to `'running'` once the container is confirmed up.
   *
   * Refuses (BuilderSessionActiveError) when the same member already has an
   * active (non-`ended`) session on the same project — the write-side of the
   * "one session per member per project" rule (§5.7). The check and the
   * insert run inside one storage lock, so a start's claim row is both the
   * record that prevents an orphaned container and the exclusion that keeps
   * a rival start out. `getActiveBuilderSessionForMember` is the read-side.
   */
  createBuilderSession(session: BuilderSession): Promise<BuilderSession>;

  /** A session by id, or null. */
  getBuilderSession(id: string): Promise<BuilderSession | null>;

  /**
   * The live (non-`ended`) session for a given project + member, or null.
   * This is what `startBuilderSession` consults for the "one session per
   * member per project" rule (§5.7) — a second start for the same member
   * finds and resumes/reattaches this row rather than registering a second one.
   */
  getActiveBuilderSessionForMember(
    projectRoot: string,
    memberEmail: string | null,
  ): Promise<BuilderSession | null>;

  /** All sessions, optionally filtered to a project. */
  listBuilderSessions(projectRoot?: string): Promise<BuilderSession[]>;

  /**
   * Patch a session's mutable fields. Always stamps `updatedAt`. Throws if the
   * session does not exist — a patch to a session nobody registered is a bug at
   * the call site, not a silent no-op.
   *
   * `expectedState` (optional) turns the patch into an expected-state (CAS)
   * write: the patch lands only while the row's CURRENT state is exactly
   * `expectedState`, read and decided in the SAME locked critical section as
   * the write — a refusal is the serialization point, not an advisory check
   * the patch can outrun. The property it exists for (§5.7): a session the
   * member explicitly ended must never be resurrected by a launch that was
   * already in flight — a claim or reconcile whose row moved on underneath it
   * is refused with BuilderSessionStateConflictError (carrying both states)
   * instead of overwriting the member's decision; the loser re-reads
   * `getBuilderSession` and defers. Callers that pass no expected state get
   * today's unconditional patch — the guard is opt-in per call, not a
   * parameter every call site has to think about.
   *
   * Reachability note, same shape as BuilderSessionActiveError: the typed
   * refusal is stable against FileStorage (the daemon's own storage). A
   * RemoteStorage client receives the refusal as a generic Error carrying
   * this message — no client-side code may match on the class across a
   * remote hop.
   *
   * `expectedBuilderId` narrows the guard to one LAUNCH: state alone cannot
   * tell a row from the same row relaunched (running → stopped → starting →
   * running, under a new builder id), so a caller acting on the launch it
   * read passes that launch's builder id too. A mismatch refuses the same way.
   */
  updateBuilderSession(
    id: string,
    patch: BuilderSessionUpdate,
    expectedState?: BuilderSession['state'],
    expectedBuilderId?: string,
  ): Promise<BuilderSession>;

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
  addTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task>;

  /**
   * Remove a tag from a task. The tag is normalized before lookup. Idempotent:
   * if the task does not carry the tag, this is a no-op and appends no history
   * event. Otherwise the tag is removed from Task.tags and an 'untag' event
   * (with actor) is appended to the history. Returns the updated task.
   */
  removeTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task>;

  /**
   * Get the append-only tag-history for a task, in chronological order.
   * Every tag/untag ever performed, attributed to its actor. Returns [] for
   * tasks that have never been tagged.
   */
  getTagHistory(taskId: string): Promise<TagEvent[]>;

  // --- Builder scratch sandbox ---
  //
  // The project's builder scratch sandbox, captured from the live
  // `$LAZY_SCRATCH_DIR` (see src/builder/scratch.ts) so the artifacts a builder
  // leaves for the engineer survive the host they were written on, are visible
  // to later builders, and are reachable through `in:scratch` search.
  //
  // The live directory stays the working area — that is where builders write,
  // and it keeps the identical-path convention that makes a printed path
  // pasteable. Storage is the DURABLE COPY, refreshed by the builder
  // supervisor's capture monitor (src/builder/scratch-sync.ts).
  //
  // INVARIANT: content is stored whole or not at all. Over-cap and binary files
  // get a metadata-only record carrying `skipped`, never a truncated body — a
  // half a document read as whole is worse than a document known to be absent.
  //
  // INVARIANT: capture never deletes. A file vanishing from the live directory
  // does not remove its stored record; the store outliving the host dir is the
  // whole point. Removal is explicit (`lazy scratch rm`).

  /**
   * Create or update a scratch file, keyed by its sandbox-relative `path`.
   * Re-saving the same path supersedes the previous content; `created_at` is
   * preserved from the first capture.
   *
   * Throws if `input.content` exceeds the per-file cap — callers that capture
   * from disk must classify oversize files as `skipped` rather than passing
   * them through (see `src/builder/scratch-sync.ts`).
   */
  saveScratchFile(input: ScratchFileInput, actor: Actor): Promise<ScratchFile>;

  /** Get one scratch file by sandbox-relative path, or null if not captured. */
  getScratchFile(path: string): Promise<ScratchFile | null>;

  /** List every captured scratch file, newest-updated first. */
  listScratchFiles(): Promise<ScratchFile[]>;

  /**
   * Delete a captured scratch file. Returns true if one was removed, false if
   * that path was never captured — idempotent, so callers need no pre-check.
   */
  deleteScratchFile(path: string): Promise<boolean>;

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
  saveMemory(input: MemoryWriteInput, actor: ActorInput): Promise<MemoryRecord>;

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
  deleteMemory(name: string, actor: ActorInput): Promise<MemoryRecord | null>;

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
  saveMemoryCompact(input: MemoryCompactInput, actor: ActorInput): Promise<MemoryCompact>;

  /** Get the project's memory compact, or null if none has been generated. */
  getMemoryCompact(): Promise<MemoryCompact | null>;

  /**
   * Delete the memory compact. Injection reverts to the full one-line-per-record
   * index. Idempotent: returns false when there was nothing to delete.
   */
  clearMemoryCompact(): Promise<boolean>;

  // --- System messages (proactive system-to-human reports) ---
  //
  // Project-scoped inbox of messages the SYSTEM writes FOR the human: scheduled
  // report tasks, the daemon (e.g. upgrade notices), or the builder. The
  // builder injects unread messages compactly on launch; the CLI and any UI can
  // always list them.
  //
  // INVARIANT: append-only. Messages are never deleted or edited — reading and
  // dismissal are narrow state changes (`read_at`, `dismissed_at`), so the
  // record of what the system told the human is permanent.
  //
  // INVARIANT (boundary): dismissal is a human/builder decision. This interface
  // does not encode that — the gate lives at the MCP boundary
  // (`lazy_message_dismiss` rejects a non-empty ctx.taskId), because that is
  // where caller identity exists. Creation is deliberately open to task agents:
  // report tasks run as agents and must be able to file their report. Unlike
  // memory, a system message is never injected into agent prompts as guidance —
  // it is attributed data shown to the human — so agent creation is safe.

  /** Create a system message. Append-only; returns the stored message. */
  createSystemMessage(input: SystemMessageInput): Promise<SystemMessage>;

  /**
   * List system messages, newest first. Dismissed messages are excluded unless
   * `includeDismissed` is set.
   */
  listSystemMessages(options?: { includeDismissed?: boolean }): Promise<SystemMessage[]>;

  /**
   * Get one system message by id or unique id prefix. Returns null when no
   * message matches; throws when the prefix is ambiguous.
   */
  getSystemMessage(id: string): Promise<SystemMessage | null>;

  /**
   * Mark a system message read (sets `read_at` once; idempotent — a second
   * call keeps the original timestamp). Accepts an id or unique prefix; throws
   * when the message does not exist.
   */
  markSystemMessageRead(id: string): Promise<SystemMessage>;

  /**
   * Dismiss a system message (sets `dismissed_at`/`dismissed_by` once;
   * idempotent). Accepts an id or unique prefix; throws when the message does
   * not exist. Dismissal hides the message from default surfaces — it never
   * deletes it.
   */
  dismissSystemMessage(id: string, actor: Actor): Promise<SystemMessage>;

  // --- Status History ---

  /**
   * Get the status changelog for a task.
   * Returns an array of {status, timestamp} entries in chronological order.
   * If no changelog exists yet, lazily reconstructs one from task/session data.
   */
  getStatusHistory(taskId: string): Promise<StatusChange[]>;

  // --- Per-task tool stats ---

  /**
   * A task's durable per-tool statistics, or null when none were ever recorded
   * (the task ran before the proxy kept them, or its traffic never went through
   * the lazy proxy). Null is a real answer the surfaces state plainly — it is
   * never rendered as "this task used no tools".
   */
  getToolStats(taskId: string): Promise<TaskToolStatsRecord | null>;

  /**
   * Write a task's tool-stats record. Written only by the proxy's recorder
   * (src/proxy/tool-stats.ts), which folds each forwarded request into it —
   * nothing recomputes this from the bounded audit log.
   */
  saveToolStats(record: TaskToolStatsRecord): Promise<void>;

  // --- Usage-limit readings ([usage_pause]) ---
  //
  // DAEMON-LOCAL: the storage RPC does not carry these and RemoteStorage refuses
  // them. A reading decides whether turns may spend a credential, so only the
  // daemon's own recorder writes one (src/daemon/usage-readings.ts), and the
  // merge rule every backend applies is src/storage/usage-limit-readings.ts.

  /**
   * The latest usage-limit reading per credential, as last saved — what the
   * daemon seeds `[usage_pause]` from after a restart, so a pause survives the
   * bounded audit log rotating its reading away. Empty when none was saved.
   */
  getUsageLimitReadings(): Promise<StoredUsageLimitReading[]>;

  /**
   * Record the latest reading for `reading.credential` by the shared merge rule
   * (`mergeUsageLimitReading`): a header-less spend mark never replaces a
   * reading (it only moves `spentAt`), and a late write never rolls a
   * credential back. The record is validated first (shape, no future `ts`).
   * Written only by the daemon's reading recorder (src/daemon/usage-readings.ts).
   */
  saveUsageLimitReading(reading: StoredUsageLimitReading): Promise<void>;

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
   * after `sinceMs` (epoch ms). Powers the `lazy stats timings` readout.
   */
  readTraceSpans(sinceMs?: number): Promise<SpanRecord[]>;

  // --- Wait intervals ---

  /**
   * Record that a task's agent has BLOCKED on another task (an in-flight
   * `lazy_wait`/`lazy_ask`). Written by the daemon at the moment the blocking
   * MCP call starts — see src/daemon/wait-registry.ts.
   *
   * Persisted so duration/economics reports can subtract waited time from an
   * agent's wall-clock; without it, decomposing work into subtasks makes an
   * agent look arbitrarily slower than one that did everything inline.
   */
  recordWaitStart(start: WaitIntervalStart): Promise<void>;

  /**
   * Close a previously started wait interval. An interval that never gets this
   * call (the turn or the daemon died mid-wait) stays readable with
   * `ended_at: null` — that is a documented state, not corruption.
   */
  recordWaitEnd(id: string, endedAt: string, outcome: WaitOutcome): Promise<void>;

  /**
   * Read wait intervals in start order, optionally filtered by task or session.
   * Consumers attribute an interval to a turn via `turn_sequence` (best-effort)
   * or by time overlap with the turn's window.
   */
  readWaitIntervals(filter?: WaitIntervalFilter): Promise<WaitInterval[]>;
}
