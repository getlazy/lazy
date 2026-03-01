/**
 * LocalDriver — the default RepositoryDriver implementation.
 *
 * Performs squash merges locally. All remote-oriented methods (push, comments,
 * turn summaries, cleanup) are no-ops since there is no remote to talk to.
 */

import type {
  RepositoryDriver,
  DriverContext,
  MergeOptions,
  MergeResult,
  ChecksResult,
  ChecksStatusResult,
  PublishResult,
  RemoteComment,
  PRState,
  HealthCheck,
  DriverConfigOptions,
} from './driver';
import type { Task } from '../types';
import { checkMergeConflicts, checkMergeConflictsIntoTarget, squashMergeTaskBranch } from '../git/operations';

export class LocalDriver implements RepositoryDriver {
  needsSync = false;
  private driverContext?: DriverContext;

  constructor(context?: DriverContext) {
    this.driverContext = context;
  }

  async merge(opts: MergeOptions): Promise<MergeResult> {
    const { sourceBranch, targetBranch, task, taskShortId, root } = opts;

    // Check for merge conflicts
    // Use the appropriate check based on whether we're merging to main (HEAD) or a specific target
    const isMainMerge = targetBranch === 'main';
    const hasConflicts = isMainMerge
      ? checkMergeConflicts(sourceBranch, root)
      : checkMergeConflictsIntoTarget(sourceBranch, targetBranch, root);

    if (hasConflicts) {
      return {
        status: 'failed',
        isConflict: true,
        error: `Session branch has conflicts with ${targetBranch}.`,
      };
    }

    // Perform the squash merge — local merges are always immediate, never pending
    try {
      squashMergeTaskBranch(sourceBranch, targetBranch, taskShortId, task.goal, root);
    } catch (err) {
      return {
        status: 'failed',
        error: `Merge failed: ${err instanceof Error ? err.message : err}`,
      };
    }

    return { status: 'merged' };
  }

  async getChecksStatus(_task: Task): Promise<ChecksStatusResult> {
    // No remote checks
    return { status: 'passed' };
  }

  async waitForChecks(_task: Task): Promise<ChecksResult> {
    // No remote checks to wait for
    return { passed: true };
  }

  async pushBranch(_branch: string): Promise<void> {
    // No-op for local driver
  }

  async fetchBranch(_branch: string, _worktreePath: string): Promise<boolean> {
    // No-op for local driver — no remote to fetch from
    return false;
  }

  async fastForwardLocal(_targetBranch: string, _root: string): Promise<{ success: boolean; warning?: string }> {
    // No-op for local driver — no remote to sync from
    return { success: true };
  }

  async resolveUpstreamRef(parentBranch: string, _worktreePath: string): Promise<string> {
    // No remote — use the local branch as-is
    return parentBranch;
  }

  async publishBranch(_opts: { branch: string; targetBranch: string; task: Task }): Promise<PublishResult> {
    // No-op for local driver — no remote to publish to
    return {};
  }

  async markReadyForReview(_task: Task): Promise<{ metadata?: Record<string, string> }> {
    // No-op for local driver
    return {};
  }

  async syncComments(_task: Task, _since: string): Promise<RemoteComment[]> {
    return [];
  }

  async getPRState(_task: Task): Promise<PRState | null> {
    return null;
  }

  async postTurnSummary(_task: Task, _content: string): Promise<void> {
    // No-op for local driver
  }

  async postAcceptReview(_task: Task, _reason: string): Promise<string | null> {
    // No-op for local driver — no remote to post reviews to
    return null;
  }

  async postRejectReview(_task: Task, _reason: string): Promise<string | null> {
    // No-op for local driver — no remote to post reviews to
    return null;
  }

  async cleanup(_branch: string): Promise<void> {
    // No-op for local driver
  }

  async checkHealth(): Promise<HealthCheck[]> {
    return [{ state: 'ok', what: 'Local driver (no remote)' }];
  }

  getConfigOptions(): DriverConfigOptions {
    return { valid: [], deprecated: [] };
  }

  async getTaskUrl(_task: Task): Promise<string | null> {
    // Local driver has no remote URLs
    return null;
  }

  hasRemoteRef(_task: Task): boolean {
    return false;
  }

  getRemoteRefUrl(_task: Task): string | null {
    return null;
  }

  getRemoteRefState(_task: Task): string | null {
    return null;
  }

  validateAccept(_task: Task): string | null {
    // Local driver can always accept — no remote preconditions
    return null;
  }

  async fetchRemoteState(_root: string, _branchesToUpdate?: string[]): Promise<void> {
    throw new Error('Sync requires a remote driver. Configure it with: lazy init');
  }

  getLastCommentSyncedAt(_task: Task): string | undefined {
    return undefined;
  }

  commentSyncedAtKey(): string {
    return 'remote_last_comment_synced_at';
  }

  getLastPostedTurnSeq(_task: Task): number {
    return -1;
  }

  postedTurnSeqKey(): string {
    return 'remote_last_posted_turn_seq';
  }

  getLastPostedNoteAt(_task: Task): string | undefined {
    return undefined;
  }

  postedNoteAtKey(): string {
    return 'remote_last_posted_note_at';
  }

  formatImportedComment(_comment: RemoteComment, _task: Task): string {
    return '';
  }

  isImportedComment(_noteContent: string): boolean {
    return false;
  }
}
