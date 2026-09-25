/**
 * Editing a comment: allowed while the agent has NOT seen it, refused once it
 * has.
 *
 * A comment the agent has been shown is history it may have acted on;
 * rewriting it would make the record disagree with what the agent actually
 * read. An unseen comment is still just queued input, so fixing it is no
 * different from fixing a draft.
 *
 * "Seen" is the one answer every surface uses — {@link commentIsDelivered}
 * against {@link resolveNotesCutoff} — so the edit gate can never disagree
 * with the `delivered` flag `lazy show` / the web page / Teams display.
 *
 * Every content edit goes through {@link editUnseenComment}: the human
 * surfaces (CLI, dashboard, Teams via RPC) and the forge re-import alike.
 */

import type { Storage } from '../storage/interface';
import type { ActorInput, Comment, CommentExternalRef } from '../types';
import { resolveNotesCutoff } from './turn-context';
import { commentIsDelivered } from './show-sections';
import { sanitizeUserText } from '../utils/sanitize-text';

/** The agent has been shown this comment; the edit was refused. */
export class CommentAlreadySeenError extends Error {
  constructor(public readonly commentId: string) {
    super(
      `Comment ${commentId.substring(0, 8)} has already been delivered to the agent, so it can no longer be edited: ` +
      'the agent may have acted on what it said, and rewriting it would make the record disagree with what the agent read. ' +
      'Add a new comment with the correction instead — it rides the next turn.',
    );
    this.name = 'CommentAlreadySeenError';
  }
}

export class CommentNotFoundError extends Error {
  constructor(taskId: string, commentId: string) {
    super(`No comment matching '${commentId}' on task ${taskId.substring(0, 8)}.`);
    this.name = 'CommentNotFoundError';
  }
}

/** Has the agent been shown this comment? One answer, from the delivery cutoff. */
export async function isCommentSeen(storage: Storage, taskId: string, comment: Comment): Promise<boolean> {
  const session = await storage.getSessionByTaskId(taskId);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  return commentIsDelivered(comment, resolveNotesCutoff(session, turns));
}

/** Resolve a full or prefix comment id. Ambiguous prefixes are refused. */
export async function findComment(storage: Storage, taskId: string, commentId: string): Promise<Comment> {
  const comments = await storage.getTaskComments(taskId);
  const exact = comments.find(c => c.id === commentId);
  if (exact) return exact;
  const matches = comments.filter(c => c.id.startsWith(commentId));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Comment id '${commentId}' is ambiguous on task ${taskId.substring(0, 8)}: ${matches.map(c => c.id.substring(0, 12)).join(', ')}`);
  }
  throw new CommentNotFoundError(taskId, commentId);
}

/**
 * Replace an unseen comment's content. Throws {@link CommentAlreadySeenError}
 * when the agent has seen it. `external` optionally re-stamps forge identity
 * in the same write (forge re-import records the new body hash).
 */
export async function editUnseenComment(
  storage: Storage,
  taskId: string,
  commentId: string,
  content: string,
  options: { external?: CommentExternalRef; editor?: ActorInput } = {},
): Promise<Comment> {
  const clean = sanitizeUserText(content).trim();
  if (!clean) throw new Error('A comment cannot be edited to be empty.');
  const comment = await findComment(storage, taskId, commentId);
  if (await isCommentSeen(storage, taskId, comment)) {
    throw new CommentAlreadySeenError(comment.id);
  }
  return storage.updateComment(taskId, comment.id, {
    content: clean,
    ...(options.external ? { external: options.external } : {}),
  }, options.editor);
}
