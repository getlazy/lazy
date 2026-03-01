/**
 * Orphan branch storage implementation
 *
 * Stores all data on a git orphan branch (default: 'lazy-state') using a
 * dedicated worktree. This keeps storage state completely separate from the
 * code branch — no .lazy/tasks/ files appear in the working tree.
 *
 * Implementation strategy:
 * - Delegates all file I/O to a FileStorage instance pointed at the worktree
 * - After every write operation, auto-commits changes to the orphan branch
 * - Reads are fast filesystem reads from the checked-out worktree
 * - Does NOT auto-push; that's a separate concern
 */

import { join } from 'path';
import { resolve } from 'path';
import { FileStorage } from './file-storage';
import type { Storage, CreateTurnOptions } from './interface';
import type {
  Task,
  Session,
  Turn,
  MergeConflict,
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
} from './types';
import {
  orphanBranchExists,
  createOrphanBranch,
  ensureWorktree,
  commitChanges,
  removeWorktree,
} from '../git/orphan-branch';
import { getDataDir } from '../cli/init';

const DEFAULT_BRANCH_NAME = 'lazy-state';
const WORKTREE_DIR = '.state-worktree';

export interface OrphanBranchStorageOptions {
  /** Name of the orphan branch (default: 'lazy-state') */
  branchName?: string;
}

export class OrphanBranchStorage implements Storage {
  private readonly lazyRoot: string;
  private readonly branchName: string;
  private readonly worktreePath: string;
  private inner: FileStorage | null = null;

  constructor(lazyRoot: string, options?: OrphanBranchStorageOptions) {
    this.lazyRoot = resolve(lazyRoot);
    this.branchName = options?.branchName ?? DEFAULT_BRANCH_NAME;
    // Place worktree inside the data dir so it's alongside other lazy artifacts
    const dataDir = getDataDir(lazyRoot);
    this.worktreePath = join(this.lazyRoot, dataDir, WORKTREE_DIR);
  }

  /**
   * Auto-commit after a write operation. Swallows errors from git since
   * the data is already written to the worktree filesystem.
   */
  private autoCommit(message: string): void {
    try {
      commitChanges(this.worktreePath, message);
    } catch {
      // Best-effort: data is on disk in the worktree even if commit fails.
      // A subsequent write will pick up uncommitted changes.
    }
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    // Ensure the orphan branch exists
    if (!orphanBranchExists(this.branchName, this.lazyRoot)) {
      createOrphanBranch(this.branchName, this.lazyRoot);
    }

    // Ensure the worktree is checked out
    ensureWorktree(this.worktreePath, this.branchName, this.lazyRoot);

    // Create the inner FileStorage pointed at the worktree
    this.inner = new FileStorage(this.lazyRoot, { basePath: this.worktreePath });
    await this.inner.initialize();

    // Commit initialization artifacts (version.json, tasks/ dir)
    this.autoCommit('Initialize storage');
  }

  async close(): Promise<void> {
    if (this.inner) {
      await this.inner.close();
    }
  }

  private requireInner(): FileStorage {
    if (!this.inner) {
      throw new Error('OrphanBranchStorage not initialized. Call initialize() first.');
    }
    return this.inner;
  }

  // --- Path accessors ---

  getStoragePath(): string {
    return this.worktreePath;
  }

  getTaskDir(taskId: string): string {
    return this.requireInner().getTaskDir(taskId);
  }

  // --- Tasks ---

  async createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string): Promise<Task> {
    const result = await this.requireInner().createTask(goal, parentTaskId, branchedFromSha, code, type);
    this.autoCommit(`Create task: ${goal.substring(0, 50)}`);
    return result;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.requireInner().getTask(taskId);
  }

  async listTasks(): Promise<Task[]> {
    return this.requireInner().listTasks();
  }

  async listTasksWithOptions(options: ListTasksOptions): Promise<Task[]> {
    return this.requireInner().listTasksWithOptions(options);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.requireInner().updateTaskStatus(taskId, status);
    this.autoCommit(`Update task status: ${status}`);
  }

  async updateTaskGoal(taskId: string, goal: string): Promise<void> {
    await this.requireInner().updateTaskGoal(taskId, goal);
    this.autoCommit(`Update task goal`);
  }

  async updateTaskModel(taskId: string, model: string): Promise<void> {
    await this.requireInner().updateTaskModel(taskId, model);
    this.autoCommit(`Update task model: ${model}`);
  }

  async updateTaskType(taskId: string, type: string): Promise<void> {
    await this.requireInner().updateTaskType(taskId, type);
    this.autoCommit(`Update task type: ${type}`);
  }

  async closeTask(taskId: string, closeReason: string): Promise<void> {
    await this.requireInner().closeTask(taskId, closeReason);
    this.autoCommit(`Close task`);
  }

  async reopenTask(taskId: string): Promise<void> {
    await this.requireInner().reopenTask(taskId);
    this.autoCommit(`Reopen task`);
  }

  async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
    await this.requireInner().updateTaskMetadata(taskId, key, value);
    this.autoCommit(`Update task metadata: ${key}`);
  }

  async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
    return this.requireInner().getTaskMetadata(taskId, key);
  }

  async updateTaskPrompt(taskId: string, content: string, sessionId?: string): Promise<TaskPromptVersion> {
    const result = await this.requireInner().updateTaskPrompt(taskId, content, sessionId);
    this.autoCommit(`Update task prompt`);
    return result;
  }

  async resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }> {
    return this.requireInner().resolveTask(input);
  }

  async updateTaskCode(taskId: string, code: string | null): Promise<void> {
    await this.requireInner().updateTaskCode(taskId, code);
    this.autoCommit(`Update task code`);
  }

  async updateTaskParent(taskId: string, parentTaskId: string | null): Promise<void> {
    await this.requireInner().updateTaskParent(taskId, parentTaskId);
    this.autoCommit(`Update task parent`);
  }

  async updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void> {
    await this.requireInner().updateTaskBranchedFromSha(taskId, sha);
    this.autoCommit(`Update task branched_from_sha`);
  }

  async getPromptHistory(taskId: string): Promise<TaskPromptVersion[]> {
    return this.requireInner().getPromptHistory(taskId);
  }

  async getPromptVersion(taskId: string, version: number): Promise<TaskPromptVersion | null> {
    return this.requireInner().getPromptVersion(taskId, version);
  }

  // --- Sessions ---

  async createSession(
    taskId: string,
    agentId: string,
    gitBranch: string,
    gitStartSha: string,
    claudeSessionId?: string
  ): Promise<Session> {
    const result = await this.requireInner().createSession(taskId, agentId, gitBranch, gitStartSha, claudeSessionId);
    this.autoCommit(`Create session`);
    return result;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.requireInner().getSession(sessionId);
  }

  async getSessionByTaskId(taskId: string): Promise<Session | null> {
    return this.requireInner().getSessionByTaskId(taskId);
  }

  async listSessions(taskId?: string, activeOnly?: boolean): Promise<Session[]> {
    return this.requireInner().listSessions(taskId, activeOnly);
  }

  async endSession(sessionId: string, outcome: SessionOutcome): Promise<void> {
    await this.requireInner().endSession(sessionId, outcome);
    this.autoCommit(`End session: ${outcome}`);
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.requireInner().resetSession(sessionId);
    this.autoCommit(`Reset session`);
  }

  async updateSessionClaudeId(sessionId: string, claudeSessionId: string): Promise<void> {
    await this.requireInner().updateSessionClaudeId(sessionId, claudeSessionId);
    this.autoCommit(`Update session Claude ID`);
  }

  async updateSessionContainerName(sessionId: string, containerName: string | null): Promise<void> {
    await this.requireInner().updateSessionContainerName(sessionId, containerName);
    this.autoCommit(`Update session container`);
  }

  async updateSessionInteraction(sessionId: string, durationMs: number): Promise<void> {
    await this.requireInner().updateSessionInteraction(sessionId, durationMs);
    this.autoCommit(`Update session interaction`);
  }

  async updateSessionUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    await this.requireInner().updateSessionUsage(sessionId, usage);
    this.autoCommit(`Update session usage`);
  }

  async updateSessionUpstreamMergeSha(sessionId: string, sha: string): Promise<void> {
    await this.requireInner().updateSessionUpstreamMergeSha(sessionId, sha);
    this.autoCommit(`Update session upstream merge SHA`);
  }

  async recordInterrupt(sessionId: string, diagnostics: { reason: string; exit_code: number | null; logs: string | null }): Promise<void> {
    await this.requireInner().recordInterrupt(sessionId, diagnostics);
    this.autoCommit(`Record interrupt`);
  }

  async resetConsecutiveInterruptions(sessionId: string): Promise<void> {
    await this.requireInner().resetConsecutiveInterruptions(sessionId);
    this.autoCommit(`Reset consecutive interruptions`);
  }

  async setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void> {
    await this.requireInner().setAutoResumed(sessionId, autoResumed);
    this.autoCommit(`Set auto-resumed: ${autoResumed}`);
  }

  // --- Turns ---

  async createTurn(options: CreateTurnOptions): Promise<Turn> {
    const result = await this.requireInner().createTurn(options);
    this.autoCommit(`Create turn ${options.sequence}`);
    return result;
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    return this.requireInner().getSessionTurns(sessionId);
  }

  async getNextTurnSequence(sessionId: string): Promise<number> {
    return this.requireInner().getNextTurnSequence(sessionId);
  }

  async getTurnCountByTaskId(taskId: string): Promise<number> {
    return this.requireInner().getTurnCountByTaskId(taskId);
  }

  // --- Commits ---

  async createCommit(sessionId: string, sha: string, message: string): Promise<Commit> {
    const result = await this.requireInner().createCommit(sessionId, sha, message);
    this.autoCommit(`Record commit ${sha.substring(0, 8)}`);
    return result;
  }

  async getSessionCommits(sessionId: string): Promise<Commit[]> {
    return this.requireInner().getSessionCommits(sessionId);
  }

  // --- Reviews ---

  async createReview(commitId: string, verdict: ReviewVerdict, rationale: string, reviewer: string): Promise<Review> {
    const result = await this.requireInner().createReview(commitId, verdict, rationale, reviewer);
    this.autoCommit(`Create review: ${verdict}`);
    return result;
  }

  async getCommitReviews(commitId: string): Promise<Review[]> {
    return this.requireInner().getCommitReviews(commitId);
  }

  // --- Worktree Snapshots ---

  async createWorktreeSnapshot(
    sessionId: string,
    turnSequence: number,
    uncommittedDiff: string,
    gitStatus: string
  ): Promise<WorktreeSnapshot> {
    const result = await this.requireInner().createWorktreeSnapshot(sessionId, turnSequence, uncommittedDiff, gitStatus);
    this.autoCommit(`Create worktree snapshot`);
    return result;
  }

  async getLatestWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null> {
    return this.requireInner().getLatestWorktreeSnapshot(sessionId);
  }

  async getWorktreeSnapshotForTurn(sessionId: string, turnSequence: number): Promise<WorktreeSnapshot | null> {
    return this.requireInner().getWorktreeSnapshotForTurn(sessionId, turnSequence);
  }

  // --- Task Tree Operations ---

  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    return this.requireInner().getChildTasks(parentTaskId);
  }

  async getRootTask(taskId: string): Promise<Task | null> {
    return this.requireInner().getRootTask(taskId);
  }

  async getTaskAncestry(taskId: string): Promise<Task[]> {
    return this.requireInner().getTaskAncestry(taskId);
  }

  async getTaskTree(rootTaskId: string): Promise<TaskTreeNode | null> {
    return this.requireInner().getTaskTree(rootTaskId);
  }

  // --- Comments ---

  async createComment(taskId: string, content: string): Promise<Comment> {
    const result = await this.requireInner().createComment(taskId, content);
    this.autoCommit(`Create comment`);
    return result;
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    return this.requireInner().getTaskComments(taskId);
  }

  // --- Conversations ---

  async saveConversation(conversation: StoredConversation): Promise<void> {
    await this.requireInner().saveConversation(conversation);
    this.autoCommit(`Save conversation ${conversation.sessionId.substring(0, 8)}`);
  }

  async loadConversation(sessionId: string): Promise<StoredConversation | null> {
    return this.requireInner().loadConversation(sessionId);
  }

  async listConversations(): Promise<StoredConversation[]> {
    return this.requireInner().listConversations();
  }

  async isConversationImported(sessionId: string): Promise<boolean> {
    return this.requireInner().isConversationImported(sessionId);
  }

  // --- Status History ---

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    return this.requireInner().getStatusHistory(taskId);
  }

  // --- Search ---

  async search(query: string): Promise<SearchResult[]> {
    return this.requireInner().search(query);
  }
}
