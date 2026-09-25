/**
 * RemoteStorage — Storage proxy that routes all calls through the daemon.
 *
 * Implements the full Storage interface by serializing each method call
 * (name + args) and sending it to the daemon via RPC over its TCP port.
 * The daemon executes the call on its long-lived FileStorage
 * instance and returns the result.
 *
 * This eliminates lock contention: CLI commands never touch .storage-lock.
 * Only the daemon's internal Storage instance acquires the lock.
 */

import { RpcApplicationError, type DaemonClient } from '../daemon/client';
import { CommentAlreadySeenError } from '../task/comment-edit';
import type { Storage, CreateTurnOptions } from './interface';
import { normalizeTurnContent, normalizeRecordContent } from '../utils/turn-content';
import type { SpanRecord } from '../tracing/types';
import type { WaitIntervalStart, WaitIntervalFilter } from './wait-intervals';
import type { OverlayActor, RegionCover, RegionOverlay } from '../regions';
import type { WaitInterval, WaitOutcome } from '../types';
import type {
  Task,
  Session,
  Turn,
  ReviewReport,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  JournalEntry,
  RaisedItem,
  RaisedItemInput,
  RaisedItemResolveAction,
  TurnOwner,
  TurnReport,
  TurnReportInput,
  FileDecision,
  FileDecisionInput,
  TaskArtifact,
  TaskArtifactContent,
  TaskArtifactInput,
  TaskToolStatsRecord,
  StoredUsageLimitReading,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
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
} from './types';
import type { Actor, ActorInput, CommentSource, CommentCreateOptions, CommentUpdate, FileViolation, HunkApproval, HunkApprovalLineage, ReviewComment, ReviewCommentInput, ReviewCommentUpdate, ReviewDraftPatch, ReviewDraftState, ReviewSession, ReviewSessionMessage, ReviewSessionMessageInput, ReviewSessionMessageUpdate, ReviewSessionUpdate, TaskTarget } from '../types';
import type { RunnerType } from '../config/types';

export class RemoteStorage implements Storage {
  constructor(
    private client: DaemonClient,
    private projectRoot: string,
    private storagePath: string,
  ) {}

  /**
   * Send a storage RPC call to the daemon.
   * Throws on failure with context about which method failed.
   */
  private async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.client.rpc('storage', this.projectRoot, { method, args }) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // `cause` keeps the original's CLASS: a caller telling a Teams refusal
      // (TeamsCommandRefusedError) from a real failure must not match on text.
      throw new Error(`RemoteStorage.${method} failed: ${msg}`, { cause: err });
    }
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    // No-op: the daemon's Storage instance is already initialized.
  }

  async close(): Promise<void> {
    // No-op: the daemon owns the Storage lifecycle.
  }

  // --- Path accessors ---

  getStoragePath(): string {
    return this.storagePath;
  }

  getTaskDir(taskId: string): string {
    return `${this.storagePath}/tasks/${taskId}`;
  }

  // --- Tasks ---

  async createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string, actor?: ActorInput): Promise<Task> {
    return this.call<Task>('createTask', { goal, parentTaskId, branchedFromSha, code, type, agentId, actor });
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.call<Task | null>('getTask', { taskId });
  }

  async resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }> {
    return this.call('resolveTask', { input });
  }

  async listTasks(): Promise<Task[]> {
    return this.call<Task[]>('listTasks');
  }

  async listTasksWithOptions(options: ListTasksOptions): Promise<Task[]> {
    return this.call<Task[]>('listTasksWithOptions', { options });
  }

  async listTaskCodes(): Promise<TaskCodeEntry[]> {
    return this.call<TaskCodeEntry[]>('listTaskCodes');
  }

  async countDescendants(taskIds: string[]): Promise<Record<string, number>> {
    return this.call<Record<string, number>>('countDescendants', { taskIds });
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, actor?: ActorInput): Promise<void> {
    await this.call('updateTaskStatus', { taskId, status, actor });
  }

  async updateTaskGoal(taskId: string, goal: string): Promise<void> {
    await this.call('updateTaskGoal', { taskId, goal });
  }

  async updateTaskCode(taskId: string, code: string | null): Promise<void> {
    await this.call('updateTaskCode', { taskId, code });
  }

  async updateTaskTarget(taskId: string, target: TaskTarget): Promise<void> {
    await this.call('updateTaskTarget', { taskId, target });
  }

  async updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void> {
    await this.call('updateTaskBranchedFromSha', { taskId, sha });
  }

  async updateTaskModel(taskId: string, model: string): Promise<void> {
    await this.call('updateTaskModel', { taskId, model });
  }

  async updateTaskRunnerType(taskId: string, runnerType: RunnerType | null): Promise<void> {
    await this.call('updateTaskRunnerType', { taskId, runnerType });
  }

  async updateTaskAgent(taskId: string, agentId: string): Promise<void> {
    await this.call('updateTaskAgent', { taskId, agentId });
  }

  async updateTaskType(taskId: string, type: string): Promise<void> {
    await this.call('updateTaskType', { taskId, type });
  }

  async resetTaskPendingSync(taskId: string): Promise<void> {
    await this.call('resetTaskPendingSync', { taskId });
  }

  async incrementTaskPendingSync(taskId: string): Promise<void> {
    await this.call('incrementTaskPendingSync', { taskId });
  }

  async abandonTask(taskId: string, reason: string, actor?: ActorInput): Promise<void> {
    await this.call('abandonTask', { taskId, reason, actor });
  }

  async reopenTask(taskId: string, actor?: ActorInput): Promise<void> {
    await this.call('reopenTask', { taskId, actor });
  }

  async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
    await this.call('updateTaskMetadata', { taskId, key, value });
  }

  async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
    return this.call<string | null>('getTaskMetadata', { taskId, key });
  }

  async updateTaskPrompt(taskId: string, content: string, sessionId?: string): Promise<TaskPromptVersion> {
    return this.call<TaskPromptVersion>('updateTaskPrompt', { taskId, content, sessionId });
  }

  async getPromptHistory(taskId: string): Promise<TaskPromptVersion[]> {
    return this.call<TaskPromptVersion[]>('getPromptHistory', { taskId });
  }

  async getPromptVersion(taskId: string, version: number): Promise<TaskPromptVersion | null> {
    return this.call<TaskPromptVersion | null>('getPromptVersion', { taskId, version });
  }

  // --- Sessions ---

  async createSession(taskId: string, agentId: string, gitBranch: string, gitStartSha: string, claudeSessionId?: string): Promise<Session> {
    return this.call<Session>('createSession', { taskId, agentId, gitBranch, gitStartSha, claudeSessionId });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.call<Session | null>('getSession', { sessionId });
  }

  async getSessionByTaskId(taskId: string): Promise<Session | null> {
    return this.call<Session | null>('getSessionByTaskId', { taskId });
  }

  async listSessions(taskId?: string, activeOnly?: boolean): Promise<Session[]> {
    return this.call<Session[]>('listSessions', { taskId, activeOnly });
  }

  async endSession(sessionId: string, outcome: SessionOutcome): Promise<void> {
    await this.call('endSession', { sessionId, outcome });
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.call('resetSession', { sessionId });
  }

  async updateSessionClaudeId(sessionId: string, claudeSessionId: string): Promise<void> {
    await this.call('updateSessionClaudeId', { sessionId, claudeSessionId });
  }

  async updateSessionContainerName(
    sessionId: string,
    containerName: string | null,
    containerAgentId?: string | null,
  ): Promise<void> {
    await this.call('updateSessionContainerName', { sessionId, containerName, containerAgentId });
  }

  async updateSessionRunnerType(sessionId: string, runnerType: RunnerType | null): Promise<void> {
    await this.call('updateSessionRunnerType', { sessionId, runnerType });
  }

  async updateSessionAgent(sessionId: string, agentId: string, resetAgentSession: boolean): Promise<void> {
    await this.call('updateSessionAgent', { sessionId, agentId, resetAgentSession });
  }

  async updateSessionInteraction(sessionId: string, durationMs: number): Promise<void> {
    await this.call('updateSessionInteraction', { sessionId, durationMs });
  }

  async updateSessionUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    await this.call('updateSessionUsage', { sessionId, usage });
  }

  async updateSessionUpstreamMergeSha(sessionId: string, sha: string): Promise<void> {
    await this.call('updateSessionUpstreamMergeSha', { sessionId, sha });
  }

  async markNotesDelivered(sessionId: string, timestamp: number): Promise<void> {
    await this.call('markNotesDelivered', { sessionId, timestamp });
  }

  /**
   * Deliberately NOT forwarded, for the same reason the review drafts below are
   * not: the turn owner is the daemon's own answer to "who asked for this
   * turn", derived from the caller's token or from the daemon's git config.
   * Proxying it would put a person's identity on the wire as a request field,
   * which is exactly how attribution stops meaning anything. The launch path
   * runs inside the daemon and reaches FileStorage directly.
   *
   * A THROW rather than a silent no-op, and that choice is load-bearing now
   * that it can be reached. `recordSessionTurnOwner` treats the two directions
   * differently: a failure to write a PERSON degrades to "this turn's rows name
   * nobody" (a warning), while a failure to CLEAR one refuses the launch, after
   * reading the session back to check. A no-op would report success for a clear
   * that never happened, which is the one outcome neither layer could detect —
   * the previous human's address would stay on the session and be stamped on
   * work they did not ask for. Refusing loudly leaves the caller able to tell.
   */
  async setSessionTurnOwner(
    _sessionId: string,
    _owner: TurnOwner | null,
    _systemInitiated?: boolean,
  ): Promise<void> {
    throw new Error(
      'RemoteStorage does not proxy setSessionTurnOwner: a turn\'s owner is derived from the ' +
        'caller\'s identity inside the daemon, never sent by a client. It is recorded by the turn ' +
        'launch path (src/daemon/turn-owner.ts), which runs there.',
    );
  }

  async recordInterrupt(sessionId: string, diagnostics: { reason: string; exit_code: number | null; logs: string | null }): Promise<void> {
    await this.call('recordInterrupt', { sessionId, diagnostics });
  }

  async resetConsecutiveInterruptions(sessionId: string): Promise<void> {
    await this.call('resetConsecutiveInterruptions', { sessionId });
  }

  async setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void> {
    await this.call('setAutoResumed', { sessionId, autoResumed });
  }

  async setUserStopped(sessionId: string, userStopped: boolean): Promise<void> {
    await this.call('setUserStopped', { sessionId, userStopped });
  }

  // --- Turns ---

  async createTurn(options: CreateTurnOptions): Promise<Turn> {
    // Normalize BEFORE the wire hop: JSON.stringify drops an undefined key, so
    // the daemon would receive options with no `content` at all and could only
    // report a stack pointing at its own RPC handler. Warning here names the
    // real caller. See src/utils/turn-content.ts.
    const content = normalizeTurnContent(options.content, 'remote-storage');
    return this.call<Turn>('createTurn', { options: { ...options, content } });
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    return this.call<Turn[]>('getSessionTurns', { sessionId });
  }

  async getNextTurnSequence(sessionId: string): Promise<number> {
    return this.call<number>('getNextTurnSequence', { sessionId });
  }

  async reserveTurnSequences(sessionId: string, count: number): Promise<number> {
    return this.call<number>('reserveTurnSequences', { sessionId, count });
  }

  async beginInFlightTurn(taskId: string, turn: InFlightTurn): Promise<boolean> {
    return this.call<boolean>('beginInFlightTurn', { taskId, turn });
  }

  async stampInFlightTurnRun(
    taskId: string,
    turnSequence: number,
    run: { runName: string; runnerType?: RunnerType },
  ): Promise<boolean> {
    return this.call<boolean>('stampInFlightTurnRun', { taskId, turnSequence, run });
  }

  async settleInFlightTurn(taskId: string, turnSequence: number, outcome: InFlightTurnOutcome): Promise<boolean> {
    return this.call<boolean>('settleInFlightTurn', { taskId, turnSequence, outcome });
  }

  async clearInFlightTurn(taskId: string, turnSequence?: number): Promise<void> {
    return this.call<void>('clearInFlightTurn', { taskId, turnSequence });
  }

  async getTurnCountByTaskId(taskId: string): Promise<number> {
    return this.call<number>('getTurnCountByTaskId', { taskId });
  }

  async updateTurnViolations(taskId: string, turnId: string, violations: FileViolation[]): Promise<void> {
    await this.call('updateTurnViolations', { taskId, turnId, violations });
  }

  async updateTurnWrapUpSteps(taskId: string, turnId: string, wrapUpSteps: string[]): Promise<void> {
    await this.call('updateTurnWrapUpSteps', { taskId, turnId, wrapUpSteps });
  }

  async updateTurnReview(taskId: string, turnId: string, review: ReviewReport): Promise<void> {
    await this.call('updateTurnReview', { taskId, turnId, review });
  }

  async markFeedbackConsumed(sessionId: string): Promise<void> {
    await this.call('markFeedbackConsumed', { sessionId });
  }

  // --- Commits ---

  async createCommit(sessionId: string, sha: string, message: string): Promise<Commit> {
    return this.call<Commit>('createCommit', { sessionId, sha, message });
  }

  async getSessionCommits(sessionId: string): Promise<Commit[]> {
    return this.call<Commit[]>('getSessionCommits', { sessionId });
  }

  async deleteSessionCommits(sessionId: string, shas: string[]): Promise<number> {
    return this.call<number>('deleteSessionCommits', { sessionId, shas });
  }

  // --- Reviews ---

  async createReview(commitId: string, verdict: ReviewVerdict, rationale: string, reviewer: string): Promise<Review> {
    return this.call<Review>('createReview', { commitId, verdict, rationale, reviewer });
  }

  async getCommitReviews(commitId: string): Promise<Review[]> {
    return this.call<Review[]>('getCommitReviews', { commitId });
  }

  // --- Worktree Snapshots ---

  async createWorktreeSnapshot(sessionId: string, turnSequence: number, uncommittedDiff: string, gitStatus: string): Promise<WorktreeSnapshot> {
    return this.call<WorktreeSnapshot>('createWorktreeSnapshot', { sessionId, turnSequence, uncommittedDiff, gitStatus });
  }

  async getLatestWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null> {
    return this.call<WorktreeSnapshot | null>('getLatestWorktreeSnapshot', { sessionId });
  }

  async getWorktreeSnapshotForTurn(sessionId: string, turnSequence: number): Promise<WorktreeSnapshot | null> {
    return this.call<WorktreeSnapshot | null>('getWorktreeSnapshotForTurn', { sessionId, turnSequence });
  }

  // --- Task Tree Operations ---

  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    return this.call<Task[]>('getChildTasks', { parentTaskId });
  }

  async getRootTask(taskId: string): Promise<Task | null> {
    return this.call<Task | null>('getRootTask', { taskId });
  }

  async getTaskAncestry(taskId: string): Promise<Task[]> {
    return this.call<Task[]>('getTaskAncestry', { taskId });
  }

  async getTaskTree(rootTaskId: string): Promise<TaskTreeNode | null> {
    return this.call<TaskTreeNode | null>('getTaskTree', { rootTaskId });
  }

  // --- Comments ---

  async createComment(taskId: string, content: string, actor?: ActorInput, source?: CommentSource, options?: CommentCreateOptions): Promise<Comment> {
    // Same reason as createTurn: normalize before the wire hop so the warning
    // names the real caller, not the daemon's RPC handler.
    const safe = normalizeRecordContent(content, 'remote-storage', 'createComment', 'Comment.content');
    return this.call<Comment>('createComment', { taskId, content: safe, actor, source, options });
  }

  async updateComment(taskId: string, commentId: string, update: CommentUpdate, actor?: ActorInput): Promise<Comment> {
    const rest = update;
    const safe = rest.content === undefined
      ? rest
      : { ...rest, content: normalizeRecordContent(rest.content, 'remote-storage', 'updateComment', 'Comment.content') };
    // The editor rides as the top-level `actor`, where the daemon pins it from
    // a per-user token like every other attributed write.
    try {
      return await this.client.rpc('storage', this.projectRoot, {
        method: 'updateComment',
        args: { taskId, commentId, update: safe, actor },
      }) as Comment;
    } catch (err) {
      // A 409 is the unseen-only rule refusing: surface it as the same typed
      // error the in-process path throws, so callers (the forge re-import's
      // fallback to a revision) behave identically on either storage.
      if (err instanceof RpcApplicationError && err.status === 409) throw new CommentAlreadySeenError(commentId);
      throw new Error(`RemoteStorage.updateComment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    return this.call<Comment[]>('getTaskComments', { taskId });
  }

  // --- Journal ---

  async appendJournalEntry(taskId: string, content: string, actor?: ActorInput): Promise<JournalEntry> {
    const safe = normalizeRecordContent(content, 'remote-storage', 'appendJournalEntry', 'JournalEntry.content');
    return this.call<JournalEntry>('appendJournalEntry', { taskId, content: safe, actor });
  }

  async getTaskJournal(taskId: string): Promise<JournalEntry[]> {
    return this.call<JournalEntry[]>('getTaskJournal', { taskId });
  }

  // --- Raised items (everything an agent surfaces for human eyes) ---
  async createRaisedItem(taskId: string, input: RaisedItemInput): Promise<RaisedItem> {
    const safe = {
      ...input,
      content: normalizeRecordContent(
        input.content,
        'remote-storage',
        'createRaisedItem',
        'RaisedItem.content',
      ),
    };
    return this.call<RaisedItem>('createRaisedItem', { taskId, input: safe });
  }

  async getTaskRaisedItems(taskId: string): Promise<RaisedItem[]> {
    return this.call<RaisedItem[]>('getTaskRaisedItems', { taskId });
  }

  async addRaisedItemComment(
    taskId: string,
    itemId: string,
    input: {
      content: string;
      actor: ActorInput;
      session_id?: string | null;
      turn_sequence?: number | null;
    },
  ): Promise<RaisedItem> {
    const content = normalizeRecordContent(
      input.content,
      'remote-storage',
      'addRaisedItemComment',
      'RaisedItemComment.content',
    );
    // Actor is a top-level RPC arg so applyCallerActor can reach it (same as
    // createComment) — not buried in an `input` bag. Being top-level is
    // necessary but NOT sufficient: the path is declared in
    // PERSON_ATTRIBUTED_STORAGE_ACTORS, and both the daemon's stamping and a
    // user token's pinning write only at a declared path. Without the entry
    // this arrived as a bare role and the reply named nobody.
    return this.call<RaisedItem>('addRaisedItemComment', {
      taskId,
      itemId,
      content,
      actor: input.actor,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
    });
  }

  async resolveRaisedItem(
    taskId: string,
    itemId: string,
    resolution: {
      action: RaisedItemResolveAction;
      actor: ActorInput;
      response?: string | null;
      pending_comment?: string | null;
    },
  ): Promise<RaisedItem> {
    return this.call<RaisedItem>('resolveRaisedItem', { taskId, itemId, resolution });
  }

  async unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput): Promise<RaisedItem> {
    return this.call<RaisedItem>('unresolveRaisedItem', { taskId, itemId, actor });
  }

  async markRaisedItemCommentDelivered(
    taskId: string,
    itemId: string,
    extras?: {
      promoted_task_id?: string | null;
      promoted_task_code?: string | null;
      pending_comment?: string | null;
      delivered_turn?: number | null;
    },
  ): Promise<RaisedItem> {
    return this.call<RaisedItem>('markRaisedItemCommentDelivered', { taskId, itemId, extras });
  }

  async setRaisedItemBlocking(
    taskId: string,
    itemId: string,
    blocking: boolean,
    actor: ActorInput,
  ): Promise<RaisedItem> {
    return this.call<RaisedItem>('setRaisedItemBlocking', { taskId, itemId, blocking, actor });
  }

  async promoteRaisedItem(
    taskId: string,
    itemId: string,
    options: {
      goal?: string;
      prompt?: string;
      code?: string;
      parent?: string;
      relation?: 'peer' | 'subtask';
      actor: ActorInput;
    },
  ): Promise<import('../types').PromoteRaisedItemResult> {
    return this.call<import('../types').PromoteRaisedItemResult>('promoteRaisedItem', {
      taskId,
      itemId,
      options,
    });
  }

  async promoteConversation(
    sessionId: string,
    options: {
      from?: number;
      to?: number;
      goal?: string;
      prompt?: string;
      code?: string;
      parent?: string;
      actor: Actor;
    },
  ): Promise<import('../types').PromoteConversationResult> {
    return this.call<import('../types').PromoteConversationResult>('promoteConversation', {
      sessionId,
      options,
    });
  }

  async migrateFollowUpsToRaisedItems(): Promise<import('../types').FollowUpMigrationResult> {
    return this.call<import('../types').FollowUpMigrationResult>('migrateFollowUpsToRaisedItems', {});
  }

  async migrateActorIdentity(): Promise<import('../types').ActorIdentityMigrationResult> {
    return this.call<import('../types').ActorIdentityMigrationResult>('migrateActorIdentity', {});
  }

  // --- Turn reports / file decisions (structured-turn-report) ---

  async upsertTurnReport(taskId: string, input: TurnReportInput): Promise<TurnReport> {
    return this.call<TurnReport>('upsertTurnReport', { taskId, input });
  }

  async getTaskTurnReports(taskId: string): Promise<TurnReport[]> {
    return this.call<TurnReport[]>('getTaskTurnReports', { taskId });
  }

  async getTurnReportBySession(taskId: string, sessionId: string): Promise<TurnReport | null> {
    return this.call<TurnReport | null>('getTurnReportBySession', { taskId, sessionId });
  }

  async stampTurnReportSequence(
    taskId: string,
    sessionId: string,
    turnSequence: number,
  ): Promise<void> {
    await this.call('stampTurnReportSequence', { taskId, sessionId, turnSequence });
  }

  async upsertFileDecision(taskId: string, input: FileDecisionInput): Promise<FileDecision> {
    return this.call<FileDecision>('upsertFileDecision', { taskId, input });
  }

  async getTaskFileDecisions(taskId: string): Promise<FileDecision[]> {
    return this.call<FileDecision[]>('getTaskFileDecisions', { taskId });
  }

  async listRaisedItems(options?: import('../raised').ListRaisedItemsOptions): Promise<import('../raised').ListRaisedItemsResult> {
    return this.call('listRaisedItems', { options });
  }

  // --- Task artifacts (named files attached to a task) ---
  //
  // Content travels as base64 in the JSON-RPC body, so a binary artifact needs
  // no separate transport. The per-file bound (1 MiB) is what keeps that
  // honest — it is enforced daemon-side by the real backend these forward to.

  async createTaskArtifact(taskId: string, input: TaskArtifactInput, actor?: Actor): Promise<TaskArtifact> {
    return this.call<TaskArtifact>('createTaskArtifact', { taskId, input, actor });
  }

  async listTaskArtifacts(taskId: string): Promise<TaskArtifact[]> {
    return this.call<TaskArtifact[]>('listTaskArtifacts', { taskId });
  }

  async getTaskArtifact(taskId: string, name: string): Promise<TaskArtifactContent | null> {
    return this.call<TaskArtifactContent | null>('getTaskArtifact', { taskId, name });
  }

  async deleteTaskArtifact(taskId: string, name: string): Promise<boolean> {
    return this.call<boolean>('deleteTaskArtifact', { taskId, name });
  }

  // --- Review regions ---

  async getRegionCover(taskId: string): Promise<RegionCover | null> {
    return this.call<RegionCover | null>('getRegionCover', { taskId });
  }

  async saveRegionCover(taskId: string, cover: RegionCover): Promise<void> {
    await this.call<void>('saveRegionCover', { taskId, cover });
  }

  async getRegionOverlays(taskId: string): Promise<RegionOverlay[]> {
    return this.call<RegionOverlay[]>('getRegionOverlays', { taskId });
  }

  async setRegionOverlay(
    taskId: string,
    unitId: string,
    patch: {
      name?: string;
      owner?: string | null;
      signed_off_sha?: string | null;
      actor?: OverlayActor;
    },
  ): Promise<RegionOverlay> {
    return this.call<RegionOverlay>('setRegionOverlay', { taskId, unitId, patch });
  }

  // --- Hunk Approvals ---

  async listHunkApprovals(taskId: string): Promise<HunkApproval[]> {
    return this.call<HunkApproval[]>('listHunkApprovals', { taskId });
  }

  async createHunkApproval(
    taskId: string,
    hunkHash: string,
    actor?: Actor,
    lineage?: HunkApprovalLineage,
  ): Promise<HunkApproval> {
    return this.call<HunkApproval>('createHunkApproval', { taskId, hunkHash, actor, lineage });
  }

  // --- Review Comments ---

  async createReviewComment(taskId: string, input: ReviewCommentInput): Promise<ReviewComment> {
    return this.call<ReviewComment>('createReviewComment', { taskId, input });
  }

  async getTaskReviewComments(taskId: string): Promise<ReviewComment[]> {
    return this.call<ReviewComment[]>('getTaskReviewComments', { taskId });
  }

  async updateReviewComment(
    taskId: string,
    commentId: string,
    update: ReviewCommentUpdate,
  ): Promise<ReviewComment> {
    return this.call<ReviewComment>('updateReviewComment', { taskId, commentId, update });
  }

  // --- Review Drafts ---
  //
  // Deliberately NOT forwarded to the generic `storage` RPC command. That
  // command carries no caller identity, so forwarding would put the reviewer
  // key on the wire as a request field — and a draft is a person's unsent
  // words, so a caller-named key lets any authenticated actor read or
  // overwrite someone else's. Drafts travel over `reviewGetDraft` /
  // `reviewSaveDraft`, where the daemon derives the key from the token.

  private refuseDraftPassthrough(method: string): never {
    throw new Error(
      `RemoteStorage does not proxy ${method}: a review draft is keyed on the authenticated caller, ` +
        `not on a request field. Use the reviewGetDraft / reviewSaveDraft RPC verbs (or the ReviewActions port).`,
    );
  }

  async getReviewDraft(_taskId: string, _reviewer: string): Promise<ReviewDraftState | null> {
    this.refuseDraftPassthrough('getReviewDraft');
  }

  async saveReviewDraft(
    _taskId: string,
    _reviewer: string,
    _patch: ReviewDraftPatch,
  ): Promise<ReviewDraftState> {
    this.refuseDraftPassthrough('saveReviewDraft');
  }

  async deleteReviewDraft(_taskId: string, _reviewer: string): Promise<boolean> {
    this.refuseDraftPassthrough('deleteReviewDraft');
  }

  // --- Review Sessions ---

  async createReviewSession(taskId: string): Promise<ReviewSession> {
    return this.call<ReviewSession>('createReviewSession', { taskId });
  }

  async getReviewSessionByTaskId(taskId: string): Promise<ReviewSession | null> {
    return this.call<ReviewSession | null>('getReviewSessionByTaskId', { taskId });
  }

  async updateReviewSession(sessionId: string, patch: ReviewSessionUpdate): Promise<ReviewSession> {
    return this.call<ReviewSession>('updateReviewSession', { sessionId, patch });
  }

  async appendReviewSessionMessage(
    sessionId: string,
    message: ReviewSessionMessageInput,
  ): Promise<ReviewSessionMessage> {
    return this.call<ReviewSessionMessage>('appendReviewSessionMessage', { sessionId, message });
  }

  async updateReviewSessionMessage(
    sessionId: string,
    messageId: string,
    patch: ReviewSessionMessageUpdate,
  ): Promise<ReviewSessionMessage> {
    return this.call<ReviewSessionMessage>('updateReviewSessionMessage', { sessionId, messageId, patch });
  }

  async listReviewSessionMessages(sessionId: string): Promise<ReviewSessionMessage[]> {
    return this.call<ReviewSessionMessage[]>('listReviewSessionMessages', { sessionId });
  }

  // --- Conversations ---

  async saveConversation(conversation: StoredConversation): Promise<void> {
    await this.call('saveConversation', { conversation });
  }

  async loadConversation(sessionId: string): Promise<StoredConversation | null> {
    return this.call<StoredConversation | null>('loadConversation', { sessionId });
  }

  async listConversations(): Promise<StoredConversation[]> {
    return this.call<StoredConversation[]>('listConversations');
  }

  async listConversationSummaries(): Promise<ConversationSummary[]> {
    return this.call<ConversationSummary[]>('listConversationSummaries');
  }

  async isConversationImported(sessionId: string): Promise<boolean> {
    return this.call<boolean>('isConversationImported', { sessionId });
  }

  async deleteConversation(sessionId: string): Promise<boolean> {
    return this.call<boolean>('deleteConversation', { sessionId });
  }

  // --- Agent Session Logs ---

  async saveAgentSessionLog(taskId: string, sessionId: string, content: string): Promise<void> {
    await this.call('saveAgentSessionLog', { taskId, sessionId, content });
  }

  async getAgentSessionLog(taskId: string): Promise<AgentSessionLog | null> {
    return this.call<AgentSessionLog | null>('getAgentSessionLog', { taskId });
  }

  // --- Builder Resume Intents (durable upgrade↔builder handshake) ---

  async getProjectSettings(): Promise<ProjectSettings | null> {
    return this.call<ProjectSettings | null>('getProjectSettings', {});
  }

  async saveProjectSettings(settings: ProjectSettings): Promise<void> {
    await this.call('saveProjectSettings', { settings });
  }

  async saveBuilderResumeIntent(intent: BuilderResumeIntent): Promise<void> {
    await this.call('saveBuilderResumeIntent', { intent });
  }

  async takeBuilderResumeIntent(builderId: string): Promise<BuilderResumeIntent | null> {
    return this.call<BuilderResumeIntent | null>('takeBuilderResumeIntent', { builderId });
  }

  async listBuilderResumeIntents(projectRoot?: string): Promise<BuilderResumeIntent[]> {
    return this.call<BuilderResumeIntent[]>('listBuilderResumeIntents', { projectRoot });
  }

  async createBuilderSession(session: BuilderSession): Promise<BuilderSession> {
    return this.call<BuilderSession>('createBuilderSession', { session });
  }

  async getBuilderSession(id: string): Promise<BuilderSession | null> {
    return this.call<BuilderSession | null>('getBuilderSession', { id });
  }

  async getActiveBuilderSessionForMember(
    projectRoot: string,
    memberEmail: string | null,
  ): Promise<BuilderSession | null> {
    return this.call<BuilderSession | null>('getActiveBuilderSessionForMember', { projectRoot, memberEmail });
  }

  async listBuilderSessions(projectRoot?: string): Promise<BuilderSession[]> {
    return this.call<BuilderSession[]>('listBuilderSessions', { projectRoot });
  }

  async updateBuilderSession(
    id: string,
    patch: BuilderSessionUpdate,
    expectedState?: BuilderSession['state'],
    expectedBuilderId?: string,
  ): Promise<BuilderSession> {
    // expectedState rides to the daemon, where the FileStorage guard decides
    // inside its lock. The typed refusal does NOT survive the hop — call()
    // folds RPC errors into a generic Error carrying the message — so a
    // RemoteStorage client cannot match on BuilderSessionStateConflictError
    // (same reachability shape as BuilderSessionActiveError).
    return this.call<BuilderSession>('updateBuilderSession', { id, patch, expectedState, expectedBuilderId });
  }

  // --- Tags ---

  async addTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task> {
    return this.call<Task>('addTaskTag', { taskId, tag, actor });
  }

  async removeTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task> {
    return this.call<Task>('removeTaskTag', { taskId, tag, actor });
  }

  async getTagHistory(taskId: string): Promise<TagEvent[]> {
    return this.call<TagEvent[]>('getTagHistory', { taskId });
  }

  // --- Builder scratch sandbox ---

  async saveScratchFile(input: ScratchFileInput, actor: Actor): Promise<ScratchFile> {
    return this.call<ScratchFile>('saveScratchFile', { input, actor });
  }

  async getScratchFile(path: string): Promise<ScratchFile | null> {
    return this.call<ScratchFile | null>('getScratchFile', { path });
  }

  async listScratchFiles(): Promise<ScratchFile[]> {
    return this.call<ScratchFile[]>('listScratchFiles', {});
  }

  async deleteScratchFile(path: string): Promise<boolean> {
    return this.call<boolean>('deleteScratchFile', { path });
  }

  // --- Memory (lazy-owned shared knowledge) ---

  async saveMemory(input: MemoryWriteInput, actor: ActorInput): Promise<MemoryRecord> {
    return this.call<MemoryRecord>('saveMemory', { input, actor });
  }

  async getMemory(name: string): Promise<MemoryRecord | null> {
    return this.call<MemoryRecord | null>('getMemory', { name });
  }

  async listMemories(options?: { includeDeleted?: boolean }): Promise<MemoryRecord[]> {
    return this.call<MemoryRecord[]>('listMemories', { options });
  }

  async deleteMemory(name: string, actor: ActorInput): Promise<MemoryRecord | null> {
    return this.call<MemoryRecord | null>('deleteMemory', { name, actor });
  }

  async getMemoryHistory(name?: string): Promise<MemoryEvent[]> {
    return this.call<MemoryEvent[]>('getMemoryHistory', { name });
  }

  // --- Memory compact (derived) ---

  async saveMemoryCompact(input: MemoryCompactInput, actor: ActorInput): Promise<MemoryCompact> {
    return this.call<MemoryCompact>('saveMemoryCompact', { input, actor });
  }

  async getMemoryCompact(): Promise<MemoryCompact | null> {
    return this.call<MemoryCompact | null>('getMemoryCompact', {});
  }

  async clearMemoryCompact(): Promise<boolean> {
    return this.call<boolean>('clearMemoryCompact', {});
  }

  // --- System messages (proactive system-to-human reports) ---

  async createSystemMessage(input: SystemMessageInput): Promise<SystemMessage> {
    return this.call<SystemMessage>('createSystemMessage', { input });
  }

  async listSystemMessages(options?: { includeDismissed?: boolean }): Promise<SystemMessage[]> {
    return this.call<SystemMessage[]>('listSystemMessages', { options });
  }

  async getSystemMessage(id: string): Promise<SystemMessage | null> {
    return this.call<SystemMessage | null>('getSystemMessage', { id });
  }

  async markSystemMessageRead(id: string): Promise<SystemMessage> {
    return this.call<SystemMessage>('markSystemMessageRead', { id });
  }

  async dismissSystemMessage(id: string, actor: Actor): Promise<SystemMessage> {
    return this.call<SystemMessage>('dismissSystemMessage', { id, actor });
  }

  // --- Status History ---

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    return this.call<StatusChange[]>('getStatusHistory', { taskId });
  }

  // --- Per-task tool stats ---

  async getToolStats(taskId: string): Promise<TaskToolStatsRecord | null> {
    return this.call<TaskToolStatsRecord | null>('getToolStats', { taskId });
  }

  async saveToolStats(record: TaskToolStatsRecord): Promise<void> {
    await this.call<void>('saveToolStats', { record });
  }

  // --- Usage-limit readings ---
  //
  // Daemon-local by design: only the daemon's own recorder reads and writes
  // them, in process, and the storage proxy does not carry them (a caller that
  // could write a reading could lift a pause). Refused here rather than sent.

  async getUsageLimitReadings(): Promise<StoredUsageLimitReading[]> {
    throw new Error(daemonLocalReadings('getUsageLimitReadings'));
  }

  async saveUsageLimitReading(_reading: StoredUsageLimitReading): Promise<void> {
    throw new Error(daemonLocalReadings('saveUsageLimitReading'));
  }

  // --- Search ---

  async search(query: string): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('search', { query });
  }

  // --- Tracing ---

  async appendTraceSpans(spans: SpanRecord[]): Promise<void> {
    await this.call<void>('appendTraceSpans', { spans });
  }

  async readTraceSpans(sinceMs?: number): Promise<SpanRecord[]> {
    return this.call<SpanRecord[]>('readTraceSpans', { sinceMs });
  }

  // --- Wait intervals ---

  async recordWaitStart(start: WaitIntervalStart): Promise<void> {
    await this.call<void>('recordWaitStart', { start });
  }

  async recordWaitEnd(id: string, endedAt: string, outcome: WaitOutcome): Promise<void> {
    await this.call<void>('recordWaitEnd', { id, endedAt, outcome });
  }

  async readWaitIntervals(filter?: WaitIntervalFilter): Promise<WaitInterval[]> {
    return this.call<WaitInterval[]>('readWaitIntervals', { filter });
  }
}

function daemonLocalReadings(method: string): string {
  return (
    `${method} is not available over the daemon's storage RPC: usage-limit readings are kept by the ` +
    `daemon itself. Read them with \`lazy stats limits\` or \`lazy daemon config get\`.`
  );
}
