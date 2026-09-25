/**
 * Importing forge comments into a task: which are new, which were edited, and
 * which legacy records they correspond to.
 *
 * The one engine every import path uses — the remote-sync pass, auto-react,
 * `lazy link` and linked-PR attachment. Identity is STRUCTURED
 * ({@link Comment.external}: forge, kind, id, body hash), never text: two
 * genuinely different comments that both say "LGTM" are two comments.
 *
 * Edits: a forge comment whose body hash no longer matches the latest local
 * copy was edited on the forge. If the agent has NOT seen that local copy it
 * is updated in place (through the unseen-only edit rule); if it HAS, the edit
 * arrives as a new comment that names the one it revises — history the agent
 * acted on is never rewritten.
 *
 * Legacy records, claimed once and then stamped with real identity:
 *  - `{remote:<id>}` / `{gh:<id>}` / `{gl:<id>}` marker notes (sync imports before identity
 *    was structured). Matched by id; a `review_<id>` marker is a review body.
 *  - Unmarked `[author] body` remote notes (`lazy link` / linked-PR imports,
 *    which never recorded an id). Matched by body, ONE-TO-ONE: each legacy
 *    note absorbs at most one forge comment, so a repeated "LGTM" beyond the
 *    ones already stored is imported rather than swallowed.
 * The baseline hash of a claimed legacy note is the forge body at claim time;
 * an edit made before the claim is not re-imported (the old text carried no
 * hash to compare against).
 */

import type { ActorInput, Comment, CommentExternalRef } from '../types';
import type { Storage } from '../storage/interface';
import type { RemoteComment } from './driver';
import { externalKey, hashCommentBody } from './comment-identity';
import { editUnseenComment, CommentAlreadySeenError } from '../task/comment-edit';
import { resolveNotesCutoff } from '../task/turn-context';
import { commentIsDelivered } from '../task/show-sections';

// Only directly after the imported-note prefix: a human comment that merely
// quotes `{remote:5}` must not absorb forge comment 5. `gl` is GitLab's old
// spelling, still accepted by its driver.
const MARKER = /^\[(?:PR #|MR !)[^\]]*\] \{(?:remote|gh|gl):(\w+)\}/;
const LINK_PREFIX = /^\[[^\]]+\] /;

export function externalRefOf(comment: RemoteComment): CommentExternalRef {
  return { forge: comment.forge, kind: comment.kind, id: comment.id, body_hash: hashCommentBody(comment.body) };
}

/** The id a pre-identity marker would have carried for this forge item. */
function legacyMarkerId(comment: RemoteComment): string {
  return comment.kind === 'review_body' ? `review_${comment.id}` : comment.id;
}

/**
 * Take the legacy marker note for this forge item. Markers carried no kind, and
 * a GitHub issue comment and line comment can share a numeric id; a legacy
 * line-comment note is the one ending in `(on file: …)`, so prefer the note
 * whose shape matches the item's kind.
 */
function takeMarkerNote(pool: Comment[] | undefined, r: RemoteComment): Comment | undefined {
  if (!pool || pool.length === 0) return undefined;
  const wantsFile = r.kind === 'line_comment';
  const idx = pool.findIndex(n => /\n\(on file: /.test(n.content) === wantsFile);
  return pool.splice(idx === -1 ? 0 : idx, 1)[0];
}

export interface ForgeImportPlan {
  /** Forge items with no local record at all. */
  create: RemoteComment[];
  /** Legacy local records to stamp with identity (content untouched). */
  claim: Array<{ local: Comment; remote: RemoteComment }>;
  /** Edited on the forge; the local copy is unseen → update in place. */
  editInPlace: Array<{ local: Comment; remote: RemoteComment }>;
  /** Edited on the forge; the agent saw the local copy → new revision. */
  revise: Array<{ local: Comment; remote: RemoteComment }>;
}

/**
 * Decide what an import pass does. Pure: `isSeen` answers whether the agent
 * has been shown a local comment (the delivery cutoff, resolved once).
 */
export function planForgeImport(
  existing: Comment[],
  remote: RemoteComment[],
  isSeen: (comment: Comment) => boolean,
): ForgeImportPlan {
  const plan: ForgeImportPlan = { create: [], claim: [], editInPlace: [], revise: [] };

  // Latest local record per forge item (a revised comment has several).
  const latest = new Map<string, Comment>();
  const markerPool = new Map<string, Comment[]>();
  const bodyPool = new Map<string, Comment[]>();
  const sorted = [...existing].sort((a, b) => a.created_at - b.created_at);
  for (const note of sorted) {
    if (note.external) {
      latest.set(externalKey(note.external), note);
      continue;
    }
    const marker = note.content.match(MARKER);
    if (marker) {
      const pool = markerPool.get(marker[1]) ?? [];
      pool.push(note);
      markerPool.set(marker[1], pool);
    } else if (note.source === 'remote' && LINK_PREFIX.test(note.content)) {
      // Matched by body alone — GraphQL and REST spell bot logins differently
      // (`github-actions` vs `github-actions[bot]`), so the author cannot be.
      const body = note.content.replace(LINK_PREFIX, '');
      const pool = bodyPool.get(body) ?? [];
      pool.push(note);
      bodyPool.set(body, pool);
    }
  }

  for (const r of remote) {
    const key = externalKey(r);
    const local = latest.get(key);
    if (local) {
      if (local.external!.body_hash === hashCommentBody(r.body)) continue;
      (isSeen(local) ? plan.revise : plan.editInPlace).push({ local, remote: r });
      // A duplicate of this item later in the same list is already handled.
      latest.set(key, { ...local, external: externalRefOf(r) });
      continue;
    }
    const legacy = takeMarkerNote(markerPool.get(legacyMarkerId(r)), r) ?? bodyPool.get(r.body)?.shift();
    if (legacy) {
      plan.claim.push({ local: legacy, remote: r });
      latest.set(key, { ...legacy, external: externalRefOf(r) });
      continue;
    }
    plan.create.push(r);
    latest.set(key, { id: '', task_id: '', content: '', created_at: Number.MAX_SAFE_INTEGER, external: externalRefOf(r) });
  }
  return plan;
}

export interface ForgeImportResult {
  created: Comment[];
  revised: Comment[];
  updatedInPlace: Comment[];
  claimed: number;
}

/** How a forge comment reads once imported. Driver-formatted, so `[PR #N @x]`/`[MR !N @x]`. */
export type FormatImported = (comment: RemoteComment) => string;

/**
 * Carry out a plan. `format` renders a forge comment as note content.
 * An in-place edit that loses a race with delivery (the agent was shown the
 * comment between planning and writing) falls back to a revision.
 */
export async function applyForgeImport(
  storage: Storage,
  taskId: string,
  plan: ForgeImportPlan,
  format: FormatImported,
  actor: ActorInput,
): Promise<ForgeImportResult> {
  const result: ForgeImportResult = { created: [], revised: [], updatedInPlace: [], claimed: 0 };

  for (const { local, remote } of plan.claim) {
    await storage.updateComment(taskId, local.id, { external: externalRefOf(remote) });
    result.claimed++;
  }

  for (const remote of plan.create) {
    result.created.push(await storage.createComment(taskId, format(remote), actor, 'remote', { external: externalRefOf(remote) }));
  }

  const revise = [...plan.revise];
  for (const edit of plan.editInPlace) {
    try {
      // An unseen REVISION keeps saying what it replaces, or the agent would
      // read the new text as unrelated to the comment it already acted on.
      const text = edit.local.revises_comment_id
        ? revisionContent(edit.local.revises_comment_id, format(edit.remote))
        : format(edit.remote);
      result.updatedInPlace.push(await editUnseenComment(storage, taskId, edit.local.id, text, { external: externalRefOf(edit.remote), editor: actor }));
    } catch (err) {
      if (!(err instanceof CommentAlreadySeenError)) throw err;
      revise.push(edit);
    }
  }

  for (const { local, remote } of revise) {
    result.revised.push(await storage.createComment(taskId, revisionContent(local.id, format(remote)), actor, 'remote', {
      external: externalRefOf(remote),
      revises_comment_id: local.id,
    }));
  }

  return result;
}

/** A forge edit of a comment the agent already saw, naming that comment. */
function revisionContent(originalId: string, formatted: string): string {
  return `(Edited on the forge — this replaces comment ${originalId.substring(0, 8)}, which you already saw.)\n${formatted}`;
}

/**
 * Plan and apply in one step, resolving "seen" from the task's delivery
 * cutoff. The convenience every import path without a budget gate uses.
 */
export async function importForgeComments(
  storage: Storage,
  taskId: string,
  remote: RemoteComment[],
  format: FormatImported,
  actor: ActorInput,
): Promise<ForgeImportResult> {
  const plan = planForgeImport(await storage.getTaskComments(taskId), remote, await seenPredicate(storage, taskId));
  return applyForgeImport(storage, taskId, plan, format, actor);
}

/** The delivery cutoff for a task, as a predicate. */
export async function seenPredicate(storage: Storage, taskId: string): Promise<(c: Comment) => boolean> {
  const session = await storage.getSessionByTaskId(taskId);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const cutoff = resolveNotesCutoff(session, turns);
  return (c: Comment) => commentIsDelivered(c, cutoff);
}
