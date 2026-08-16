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
  UnblockResult,
  AcceptResult,
} from '../server/review-actions';
import type { FileViolation, ReviewComment } from '../types';

export function createRpcReviewActions(client: DaemonClient, projectRoot: string): ReviewActions {
  const call = (command: string, params: Record<string, unknown> = {}) =>
    client.rpc(command, projectRoot, params);

  return {
    async listQueue(): Promise<ReviewQueueEntry[]> {
      const { queue } = (await call('reviewQueue')) as { queue: ReviewQueueEntry[] };
      return queue;
    },

    async getDiff(taskId: string): Promise<string> {
      const { diff } = (await call('reviewDiff', { taskId })) as { diff: string };
      return diff ?? '';
    },

    async listComments(taskId: string): Promise<ReviewComment[]> {
      const { comments } = (await call('reviewComments', { taskId })) as { comments: ReviewComment[] };
      return comments;
    },

    async postComment(taskId: string, input: PostReviewCommentInput): Promise<ReviewComment> {
      const { comment } = (await call('reviewPostComment', {
        taskId,
        threadId: input.threadId,
        file: input.file,
        line: input.line,
        side: input.side,
        content: input.content,
        intent: input.intent,
        anchorSnippet: input.anchorSnippet,
      })) as { comment: ReviewComment };
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

    async unblock(taskId: string, message: string): Promise<UnblockResult> {
      return (await call('reviewUnblock', { taskId, message })) as UnblockResult;
    },

    async accept(taskId: string, reason?: string): Promise<AcceptResult> {
      return (await call('reviewAccept', { taskId, reason })) as AcceptResult;
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
  };
}
