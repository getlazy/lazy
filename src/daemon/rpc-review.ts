/**
 * RPC transport for the review surface.
 *
 * WHY THIS EXISTS
 * `ReviewActions` (src/server/review-actions.ts) is the port every mutation of
 * the review loop goes through, and it was reachable only IN-PROCESS: the
 * daemon injected `createReviewActions()` into its own web handler and that was
 * the entire surface. Any other client — a web UI served from source, a remote
 * client talking to a daemon on another host — had no way to review at all.
 *
 * These handlers are the missing transport, and nothing more. Every one of them
 * is a thin adapter: validate the params, call the SAME `createReviewActions()`
 * implementation the daemon's own handler calls, return its result. The review
 * logic stays in review-service.ts, which is what keeps CLAUDE.md's "never lose
 * human feedback" ordering — persist the comment through Storage BEFORE any
 * dispatch is attempted — in one place with one copy.
 *
 * This is a general daemon capability, not a dev-server feature. The dev server
 * is simply the first client of it.
 *
 * Every parameter is parsed by src/daemon/rpc-params.ts rather than cast: this
 * is an external surface, and `POST /rpc/reviewPostComment` is reachable by any
 * hand-rolled caller with a token.
 *
 * MODULE CYCLE, deliberately: rpc-handlers imports this module for its dispatch
 * switch, this module imports review-service, and review-service imports
 * rpc-handlers for `getOrCreateStorage`/`handleDiff`. Every edge resolves to a
 * hoisted function declaration and no module in the loop runs anything at
 * import time that reaches another, so evaluation order cannot matter. Keep it
 * that way: do not add top-level code here that CALLS into review-service.
 */

import { createReviewActions } from './review-service';
import {
  requireString,
  requireNonBlankString,
  requireNumber,
  requireBoolean,
  requireEnum,
  optionalString,
  optionalEnum,
} from './rpc-params';
import type { ReviewCommentSide, ReviewCommentIntent } from '../types';

const SIDES: readonly ReviewCommentSide[] = ['old', 'new'];
const INTENTS: readonly ReviewCommentIntent[] = ['ask', 'comment'];

export async function handleReviewQueue(projectRoot: string) {
  return { queue: await createReviewActions(projectRoot).listQueue() };
}

export async function handleReviewDiff(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  return { diff: await createReviewActions(projectRoot).getDiff(taskId) };
}

export async function handleReviewComments(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  return { comments: await createReviewActions(projectRoot).listComments(taskId) };
}

export async function handleReviewPostComment(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const comment = await createReviewActions(projectRoot).postComment(taskId, {
    threadId: optionalString(params, 'threadId'),
    file: requireNonBlankString(params, 'file'),
    // Not optionalNumber: an unanchored comment renders detached from the code
    // it is about, which is a silently useless comment rather than a rejected one.
    line: requireNumber(params, 'line'),
    side: requireEnum(params, 'side', SIDES),
    content: requireNonBlankString(params, 'content'),
    intent: optionalEnum(params, 'intent', INTENTS),
    anchorSnippet: optionalString(params, 'anchorSnippet'),
  });
  return { comment };
}

export async function handleReviewRetryAsk(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const commentId = requireString(params, 'commentId');
  return { comment: await createReviewActions(projectRoot).retryAsk(taskId, commentId) };
}

export async function handleReviewWithdrawComment(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const commentId = requireString(params, 'commentId');
  return { comment: await createReviewActions(projectRoot).withdrawComment(taskId, commentId) };
}

export async function handleReviewUnblock(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  // Non-blank, matching `lazy unblock`: an empty feedback message is the one
  // input that would launch a work turn saying nothing at all.
  const message = requireNonBlankString(params, 'message');
  return await createReviewActions(projectRoot).unblock(taskId, message);
}

export async function handleReviewAccept(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const reason = optionalString(params, 'reason');
  // Optional, and never logged anywhere on the way through: present only when
  // the reviewer is clearing a protection gate from the page.
  const passphrase = optionalString(params, 'passphrase');
  return await createReviewActions(projectRoot).accept(taskId, reason, passphrase);
}

export async function handleReviewSync(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  return await createReviewActions(projectRoot).sync(taskId);
}

export async function handleReviewViolationDecision(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const file = requireNonBlankString(params, 'file');
  const approved = requireBoolean(params, 'approved');
  const violations = await createReviewActions(projectRoot).setViolationDecision(
    taskId,
    file,
    approved,
  );
  return { violations };
}
