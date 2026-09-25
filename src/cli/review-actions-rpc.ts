/**
 * A `ReviewActions` implementation backed by the daemon's review RPC commands.
 *
 * The counterpart of src/daemon/rpc-review.ts. Together they make the review
 * port reachable by a client that is NOT the daemon: the web handler is handed
 * one of these instead of `createReviewActions()`, renders identically, and
 * every mutation lands in review-service.ts on the daemon side exactly as it
 * does for the daemon's own dashboard.
 *
 * It lives in src/cli/ because it needs `DaemonClient` from src/daemon/ and the
 * `ReviewActions` type from src/server/, and src/server/ must not import
 * src/daemon/ (the daemon already imports the server; that edge would be a
 * cycle). src/cli/ may import both — this is where RemoteStorage is assembled
 * for the same reason.
 *
 * There is no local fallback and no "act directly if the daemon is down" path.
 * A client of the daemon either reaches it or fails saying so; anything else
 * would make the same click mutate a store on one machine and no-op on another.
 */

import type { DaemonClient } from '../daemon/client';
import type {
  ReviewActions,
  ReviewQueueEntry,
  PostReviewCommentInput,
  PromoteDiscussionResult,
  PromoteConversationResult,
  UnblockResult,
  AcceptResult,
  SyncResult,
  FileLinesQuery,
  FileLinesResult,
} from '../server/review-actions';
import type { ActorInput, FileViolation, ReviewComment, RaisedItem, RaisedItemResolution, RaisedItemResolveAction, PromoteRaisedItemResult, ReviewDraftState, ReviewDraftPatch } from '../types';
import { isTaskLevelReviewAnchor } from '../review/task-level-anchor';

export function createRpcReviewActions(client: DaemonClient, projectRoot: string): ReviewActions {
  const call = (
    command: string,
    params: Record<string, unknown> = {},
    observers?: import('../daemon/client').RpcObservers,
  ) =>
    client.rpc(command, projectRoot, params, observers);

  return {
    async listQueue(): Promise<ReviewQueueEntry[]> {
      const { queue } = (await call('reviewQueue')) as { queue: ReviewQueueEntry[] };
      return queue;
    },

    async getDiff(taskId: string, opts?: { region?: string }): Promise<string> {
      const { diff } = (await call('reviewDiff', { taskId, region: opts?.region })) as { diff: string };
      return diff ?? '';
    },

    async listRegions(taskId: string) {
      const result = (await call('reviewRegions', { taskId })) as {
        regions?: import('../regions').RegionSummary[];
        notes?: string[];
      };
      return {
        regions: result.regions ?? [],
        notes: result.notes ?? [],
      };
    },

    async lineAttribution(taskId: string, paths: readonly string[]) {
      const result = (await call('reviewLineAttribution', { taskId, paths: [...paths] })) as {
        files?: import('../regions').FileLineAttribution[];
      };
      // Sent as an array over the wire and rebuilt as a Map here: JSON has no
      // Map, and every caller wants it keyed by path.
      return new Map((result.files ?? []).map((f) => [f.path, f]));
    },

    async getFileLines(taskId: string, input: FileLinesQuery): Promise<FileLinesResult> {
      return (await call('reviewFileLines', { taskId, ...input })) as FileLinesResult;
    },

    async listComments(taskId: string): Promise<ReviewComment[]> {
      const { comments } = (await call('reviewComments', { taskId })) as { comments: ReviewComment[] };
      return comments;
    },

    async postComment(taskId: string, input: PostReviewCommentInput): Promise<ReviewComment> {
      // A question is its own RPC (`reviewAsk`) so the daemon's turn-launching
      // set can stay a command-name list: `reviewPostComment` launches nothing
      // and must not force a per-user token. Absent intent is an ask — same
      // default as the in-process ReviewActions. The comment RPC is
      // comment-only: it refuses `intent: 'ask'` and does not take one.
      const asking = input.intent !== 'comment';
      const command = asking ? 'reviewAsk' : 'reviewPostComment';
      const params: Record<string, unknown> = {
        taskId,
        threadId: input.threadId,
        content: input.content,
      };
      // Task-level asks omit file/line so reviewAsk uses the sentinel anchor.
      // Line-anchored asks (and all comments) include the full anchor.
      if (!asking || !isTaskLevelReviewAnchor(input.file, input.line)) {
        params.file = input.file;
        params.line = input.line;
        params.side = input.side;
        params.anchorSnippet = input.anchorSnippet;
      }
      const { comment } = (await call(command, params)) as { comment: ReviewComment };
      return comment;
    },

    async retryAsk(taskId: string, commentId: string): Promise<ReviewComment> {
      const { comment } = (await call('reviewRetryAsk', { taskId, commentId })) as {
        comment: ReviewComment;
      };
      return comment;
    },

    async withdrawComment(taskId: string, commentId: string): Promise<ReviewComment> {
      const { comment } = (await call('reviewWithdrawComment', { taskId, commentId })) as {
        comment: ReviewComment;
      };
      return comment;
    },

    async unblock(
      taskId: string,
      message: string,
      raisedResolutions?: RaisedItemResolution[],
      onProgress?: import('../daemon/progress').ProgressEmitter,
      options?: { keepFeedbackDraft?: boolean },
    ): Promise<UnblockResult> {
      return (await call('reviewUnblock', {
        taskId,
        message,
        ...(options?.keepFeedbackDraft ? { keepFeedbackDraft: true } : {}),
        ...(raisedResolutions && raisedResolutions.length > 0 ? { raisedResolutions } : {}),
      }, onProgress ? { onProgress } : undefined)) as UnblockResult;
    },

    async accept(
      taskId: string,
      reason?: string,
      passphrase?: string,
      raisedResolutions?: RaisedItemResolution[],
      onProgress?: import('../daemon/progress').ProgressEmitter,
      approvedFiles?: string[],
      options?: { allowQueuedComments?: boolean },
    ): Promise<AcceptResult> {
      // The passphrase rides this one call and nothing else: it is not cached,
      // not retried, and not part of any URL.
      return (await call('reviewAccept', {
        taskId,
        reason,
        passphrase,
        ...(raisedResolutions && raisedResolutions.length > 0 ? { raisedResolutions } : {}),
        ...(approvedFiles && approvedFiles.length > 0 ? { approvedFiles } : {}),
        ...(options?.allowQueuedComments ? { allowQueuedComments: true } : {}),
      }, onProgress ? { onProgress } : undefined)) as AcceptResult;
    },

    async sync(
      taskId: string,
      onProgress?: import('../daemon/progress').ProgressEmitter,
    ): Promise<SyncResult> {
      return (await call('reviewSync', { taskId }, onProgress ? { onProgress } : undefined)) as SyncResult;
    },

    async setViolationDecision(
      taskId: string,
      file: string,
      approved: boolean,
    ): Promise<FileViolation[]> {
      const { violations } = (await call('reviewViolationDecision', {
        taskId,
        file,
        approved,
      })) as { violations: FileViolation[] };
      return violations;
    },

    async resolveRaisedItem(
      taskId: string,
      itemId: string,
      resolution: { action: RaisedItemResolveAction; response?: string | null },
      actor?: ActorInput,
    ): Promise<RaisedItem> {
      const { item } = (await call('reviewResolveRaised', {
        taskId,
        itemId,
        action: resolution.action,
        ...(resolution.response != null ? { response: resolution.response } : {}),
        ...(actor !== undefined ? { actor } : {}),
      })) as { item: RaisedItem };
      return item;
    },

    async unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput): Promise<RaisedItem> {
      const { item } = (await call('reviewUnresolveRaised', {
        taskId,
        itemId,
        ...(actor !== undefined ? { actor } : {}),
      })) as { item: RaisedItem };
      return item;
    },

    async setRaisedItemBlocking(
      taskId: string,
      itemId: string,
      blocking: boolean,
      actor?: ActorInput,
    ): Promise<RaisedItem> {
      const { item } = (await call('reviewFlagRaised', {
        taskId,
        itemId,
        blocking,
        ...(actor !== undefined ? { actor } : {}),
      })) as { item: RaisedItem };
      return item;
    },

    async promoteRaisedItem(
      taskId: string,
      itemId: string,
      options: { goal?: string; code?: string; relation?: 'peer' | 'subtask'; actor?: ActorInput },
    ): Promise<PromoteRaisedItemResult> {
      return (await call('reviewPromoteRaised', {
        taskId,
        itemId,
        ...(options.goal != null ? { goal: options.goal } : {}),
        ...(options.code != null ? { code: options.code } : {}),
        relation: options.relation ?? 'peer',
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      })) as PromoteRaisedItemResult;
    },

    async promoteDiscussion(
      taskId: string,
      threadId: string,
      options: { goal?: string; prompt?: string; code?: string; relation?: 'peer' | 'subtask' },
    ): Promise<PromoteDiscussionResult> {
      return (await call('reviewPromoteDiscussion', {
        taskId,
        threadId,
        ...(options.goal != null ? { goal: options.goal } : {}),
        ...(options.prompt != null ? { prompt: options.prompt } : {}),
        ...(options.code != null ? { code: options.code } : {}),
        relation: options.relation ?? 'subtask',
      })) as PromoteDiscussionResult;
    },

    async promoteConversation(
      sessionId: string,
      options: { from?: number; to?: number; goal?: string; prompt?: string; code?: string; parent?: string },
    ): Promise<PromoteConversationResult> {
      return (await call('conversationPromote', {
        sessionId,
        ...(options.from != null ? { from: options.from } : {}),
        ...(options.to != null ? { to: options.to } : {}),
        ...(options.goal != null ? { goal: options.goal } : {}),
        ...(options.prompt != null ? { prompt: options.prompt } : {}),
        ...(options.code != null ? { code: options.code } : {}),
        ...(options.parent != null ? { parent: options.parent } : {}),
      })) as PromoteConversationResult;
    },


    // The `reviewer` argument is deliberately NOT sent: over the wire the
    // daemon derives whose draft this is from the caller's own token
    // (reviewerKey in src/review-draft.ts), so a request field
    // naming somebody else's key would be exactly the hole that closes. A
    // token-less local client resolves to the same `local` key it passes here.
    async getDraft(taskId: string, _reviewer: string): Promise<ReviewDraftState> {
      const { draft } = (await call('reviewGetDraft', { taskId })) as { draft: ReviewDraftState };
      return draft;
    },

    async saveDraft(
      taskId: string,
      _reviewer: string,
      patch: ReviewDraftPatch,
    ): Promise<ReviewDraftState> {
      const { draft } = (await call('reviewSaveDraft', { taskId, patch })) as {
        draft: ReviewDraftState;
      };
      return draft;
    },
  };
}
