/**
 * RemoteStorage — Storage proxy that routes all calls through the daemon.
 *
 * Implements the full Storage interface by serializing each method call
 * (name + args) and sending it to the daemon via unix socket RPC.
 * The daemon executes the call on its long-lived FileStorage/PostgresStorage
 * instance and returns the result.
 *
 * This eliminates lock contention: CLI commands never touch .storage-lock.
 * Only the daemon's internal Storage instance acquires the lock.
 */

import type { DaemonClient } from '../daemon/client';
import type { Storage, CreateTurnOptions } from './interface';
import type {
  Task,
  Session,
  Turn,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  SearchResult,
  StoredConversation,
  StatusChange,
} from './types';
import type { Actor, CommentSource, FileViolation } from '../types';

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
      throw new Error(`RemoteStorage.${method} failed: ${msg}`);
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

  async createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string): Promise<Task> {
    return this.call<Task>('createTask', { goal, parentTaskId, branchedFromSha, code, type, agentId });
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

  async updateTaskStatus(taskId: string, status: TaskStatus, actor?: Actor): Promise<void> {
    await this.call('updateTaskStatus', { taskId, status, actor });
  }

  async updateTaskGoal(taskId: string, goal: string): Promise<void> {
    await this.call('updateTaskGoal', { taskId, goal });
  }

  async updateTaskCode(taskId: string, code: string | null): Promise<void> {
    await this.call('updateTaskCode', { taskId, code });
  }

  async updateTaskParent(taskId: string, parentTaskId: string | null): Promise<void> {
    await this.call('updateTaskParent', { taskId, parentTaskId });
  }

  async updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void> {
    await this.call('updateTaskBranchedFromSha', { taskId, sha });
  }

  async updateTaskModel(taskId: string, model: string): Promise<void> {
    await this.call('updateTaskModel', { taskId, model });
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

  async closeTask(taskId: string, closeReason: string, actor?: Actor): Promise<void> {
    await this.call('closeTask', { taskId, closeReason, actor });
  }

  async reopenTask(taskId: string, actor?: Actor): Promise<void> {
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

  async updateSessionContainerName(sessionId: string, containerName: string | null): Promise<void> {
    await this.call('updateSessionContainerName', { sessionId, containerName });
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

  async recordInterrupt(sessionId: string, diagnostics: { reason: string; exit_code: number | null; logs: string | null }): Promise<void> {
    await this.call('recordInterrupt', { sessionId, diagnostics });
  }

  async resetConsecutiveInterruptions(sessionId: string): Promise<void> {
    await this.call('resetConsecutiveInterruptions', { sessionId });
  }

  async setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void> {
    await this.call('setAutoResumed', { sessionId, autoResumed });
  }

  // --- Turns ---

  async createTurn(options: CreateTurnOptions): Promise<Turn> {
    return this.call<Turn>('createTurn', { options });
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    return this.call<Turn[]>('getSessionTurns', { sessionId });
  }

  async getNextTurnSequence(sessionId: string): Promise<number> {
    return this.call<number>('getNextTurnSequence', { sessionId });
  }

  async getTurnCountByTaskId(taskId: string): Promise<number> {
    return this.call<number>('getTurnCountByTaskId', { taskId });
  }

  async updateTurnViolations(taskId: string, turnId: string, violations: FileViolation[]): Promise<void> {
    await this.call('updateTurnViolations', { taskId, turnId, violations });
  }

  // --- Commits ---

  async createCommit(sessionId: string, sha: string, message: string): Promise<Commit> {
    return this.call<Commit>('createCommit', { sessionId, sha, message });
  }

  async getSessionCommits(sessionId: string): Promise<Commit[]> {
    return this.call<Commit[]>('getSessionCommits', { sessionId });
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

  async createComment(taskId: string, content: string, actor?: Actor, source?: CommentSource): Promise<Comment> {
    return this.call<Comment>('createComment', { taskId, content, actor, source });
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    return this.call<Comment[]>('getTaskComments', { taskId });
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

  async isConversationImported(sessionId: string): Promise<boolean> {
    return this.call<boolean>('isConversationImported', { sessionId });
  }

  // --- Status History ---

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    return this.call<StatusChange[]>('getStatusHistory', { taskId });
  }

  // --- Search ---

  async search(query: string): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('search', { query });
  }
}
