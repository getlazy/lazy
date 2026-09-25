/**
 * The reviewer key a review draft is stored under, and the empty draft every
 * surface renders before anything has been typed.
 *
 * ONE definition, because two would silently split a reviewer's own draft in
 * half: the page that WRITES the feedback box and the page that READS it back
 * after a reload must agree on the key, and so must the route that clears it
 * when the unblock succeeds. A mismatch does not error — it just shows an
 * empty textarea over words that are still on disk, which is the failure mode
 * this whole record exists to prevent.
 */

import { actorEmail } from './actor-ref';
import type { ActorInput, ReviewDraftPatch, ReviewDraftState } from './types';

/**
 * The key for the single-IC case: no signed-in person, so the CLI and the
 * daemon's own review page (which has no login) share one draft — which is the
 * point. Lazy is single-IC today; see the `tasks-not-branches-philosophy` note.
 */
export const LOCAL_REVIEWER = 'local';

/**
 * Anything the daemon can identify a caller by: the actor an RPC resolved, or
 * a token identity (`{ kind: 'user', email }` / `{ kind: 'control' }`). Both
 * are matched here structurally, so this module stays transport-neutral — the
 * web layer imports it too, and must not pull in `src/daemon/`.
 */
export type ReviewerSource = ActorInput | { kind: string; email?: string };

/**
 * Which reviewer a draft belongs to — the ONE definition, used by the RPC
 * verbs, the daemon's own web routes, and the lifecycle clear.
 *
 * The person when the daemon could attribute the caller to one — a per-user
 * actor token, as Lazy Teams sends, where the identity is imposed by the
 * daemon and never read from the request (see `applyCallerActor`) — and
 * `local` otherwise.
 *
 * There is deliberately no `reviewer` parameter on any surface that reaches
 * this. A draft is a person's unsent words; if a caller could name the key,
 * any user-kind token could read the feedback another reviewer is still
 * writing, or overwrite it. Identity is imposed by the daemon at the boundary,
 * the same posture as `applyCallerActor`.
 *
 * A caller the daemon cannot attribute to a person — its own review page, the
 * CLI, a local single-IC install with nobody signed in — is `local`: one
 * shared draft, which is the point on a single-IC machine. This is NOT a
 * multi-user model; it is one key, so two signed-in reviewers of the same task
 * do not overwrite each other's words.
 */
export function reviewerKey(source?: ReviewerSource): string {
  if (typeof source === 'object' && source !== null && !('role' in source)) {
    // A token identity: an `email` only on the user kind, absent for control.
    return source.email || LOCAL_REVIEWER;
  }
  return actorEmail(source as ActorInput | undefined) ?? LOCAL_REVIEWER;
}

/** A draft record with nothing in it — what every surface renders on a first visit. */
export function emptyReviewDraft(taskId: string, reviewer: string): ReviewDraftState {
  return {
    task_id: taskId,
    reviewer,
    feedback: '',
    accept_reason: '',
    session_message: '',
    viewed_files: {},
    line_drafts: {},
    updated_at: 0,
  };
}

/**
 * Longest a single draft text field may be.
 *
 * Generous on purpose: this is a reviewer's unsent words, and a cap that a
 * person could plausibly hit would turn "your draft is saved" into "your draft
 * is silently not saved" — the exact failure this record exists to prevent. It
 * is here only so a hand-rolled caller cannot park unbounded text on a task.
 */
export const MAX_DRAFT_FIELD_CHARS = 256_000;

/** Most files one draft may carry a viewed tick for. */
export const MAX_VIEWED_FILES = 10_000;

/** Longest a tick's file path may be — a repository path, not free text. */
export const MAX_VIEWED_PATH_CHARS = 4_096;

/** Longest a tick's content hash may be — a hex digest, not free text. */
export const MAX_VIEWED_HASH_CHARS = 256;

/**
 * Most half-typed line comments one draft may hold at once.
 *
 * A reviewer works through a change with a handful of boxes open, not
 * thousands; the cap only stops a hand-rolled caller parking unbounded text on
 * a task. Each value is bounded by {@link MAX_DRAFT_FIELD_CHARS} like every
 * other draft text, and each key by {@link MAX_LINE_DRAFT_KEY_CHARS}.
 */
export const MAX_LINE_DRAFTS = 500;

/** Longest an anchor key may be: side, line, thread id and a repository path. */
export const MAX_LINE_DRAFT_KEY_CHARS = 4_096;

/*
 * REMOVED (move-file-approval-to-accept): MAX_VIOLATION_DECISIONS,
 * VIOLATION_DECISIONS and ViolationDecision.
 *
 * A draft held the reviewer's unsent keep/revert answer per violated file,
 * because unblock asked that question and reverted anything left out. Unblock
 * asks nothing now and reverts nothing, so there is no question to remember —
 * and a validated, persisted external input with no reader is the shape from
 * which someone rebuilds the implicit revert. The decision lives at accept;
 * a ✅ on the review page is stored on the violation record itself, not in a
 * draft. Drafts written before 2026-09-13 may still carry a
 * `violation_decisions` key on disk; nothing reads it and it is dropped the
 * next time the draft is rewritten.
 */

/** A draft patch that did not parse. Each surface renders this as its own 400. */
export class ReviewDraftPatchError extends Error {}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function draftText(obj: Record<string, unknown>, name: string, label: string): string | undefined {
  const value = obj[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ReviewDraftPatchError(`${label}.${name} must be a string, got ${typeNameOf(value)}`);
  }
  if (value.length > MAX_DRAFT_FIELD_CHARS) {
    throw new ReviewDraftPatchError(
      `${label}.${name} is ${value.length} characters, over the ${MAX_DRAFT_FIELD_CHARS} limit for a draft field`,
    );
  }
  return value;
}

/**
 * Parse the patch half of a review draft: only the fields the caller is changing.
 *
 * PATCH, not replace — the feedback box autosaving must not blank the accept
 * reason someone typed in another tab, so an absent key means "leave it alone"
 * and an empty string means "the reviewer cleared it". That distinction is the
 * whole reason this is parsed rather than cast. An explicit `null` is treated
 * as OMITTED, not as a clear — JSON encoders that spell an unset field as
 * `null` must not blank a field the reviewer never touched; a clear is `""`.
 *
 * It lives here, not in the RPC parameter helpers, because a draft arrives on
 * TWO external surfaces — the RPC verb a Teams client calls and the daemon's
 * own web route the review page posts to. Neither may rely on the other being
 * the one that validates.
 */
export function parseReviewDraftPatch(value: unknown, label = 'patch'): ReviewDraftPatch {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewDraftPatchError(`${label} must be an object, got ${typeNameOf(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const feedback = draftText(obj, 'feedback', label);
  const acceptReason = draftText(obj, 'acceptReason', label);
  const sessionMessage = draftText(obj, 'sessionMessage', label);

  let viewedFiles: Record<string, string> | undefined;
  const rawViewed = obj.viewedFiles;
  if (rawViewed !== undefined && rawViewed !== null) {
    if (typeof rawViewed !== 'object' || Array.isArray(rawViewed)) {
      throw new ReviewDraftPatchError(
        `${label}.viewedFiles must be an object, got ${typeNameOf(rawViewed)}`,
      );
    }
    const entries = Object.entries(rawViewed as Record<string, unknown>);
    if (entries.length > MAX_VIEWED_FILES) {
      throw new ReviewDraftPatchError(
        `${label}.viewedFiles has ${entries.length} entries, over the ${MAX_VIEWED_FILES} limit`,
      );
    }
    viewedFiles = {};
    for (const [file, hash] of entries) {
      // A tick is a CONTENT HASH, never a bare boolean: that is what makes a
      // file whose content changed come back unviewed.
      if (typeof hash !== 'string') {
        throw new ReviewDraftPatchError(
          `${label}.viewedFiles["${file}"] must be a content-hash string, got ${typeNameOf(hash)}`,
        );
      }
      // Both halves of the map are bounded, not just its entry count: without
      // this, 10k entries of unbounded key and value are still unbounded text
      // parked on a task by a hand-rolled caller.
      if (file.length > MAX_VIEWED_PATH_CHARS) {
        throw new ReviewDraftPatchError(
          `${label}.viewedFiles has a ${file.length}-character path, over the ${MAX_VIEWED_PATH_CHARS} limit`,
        );
      }
      if (hash.length > MAX_VIEWED_HASH_CHARS) {
        throw new ReviewDraftPatchError(
          `${label}.viewedFiles["${file}"] is ${hash.length} characters, over the ${MAX_VIEWED_HASH_CHARS} limit for a content hash`,
        );
      }
      viewedFiles[file] = hash;
    }
  }

  let lineDrafts: Record<string, string> | undefined;
  const rawLineDrafts = obj.lineDrafts;
  if (rawLineDrafts !== undefined && rawLineDrafts !== null) {
    if (typeof rawLineDrafts !== 'object' || Array.isArray(rawLineDrafts)) {
      throw new ReviewDraftPatchError(
        `${label}.lineDrafts must be an object, got ${typeNameOf(rawLineDrafts)}`,
      );
    }
    const entries = Object.entries(rawLineDrafts as Record<string, unknown>);
    if (entries.length > MAX_LINE_DRAFTS) {
      throw new ReviewDraftPatchError(
        `${label}.lineDrafts has ${entries.length} entries, over the ${MAX_LINE_DRAFTS} limit`,
      );
    }
    lineDrafts = {};
    for (const [anchor, text] of entries) {
      if (typeof text !== 'string') {
        throw new ReviewDraftPatchError(
          `${label}.lineDrafts["${anchor}"] must be a string, got ${typeNameOf(text)}`,
        );
      }
      if (anchor.length > MAX_LINE_DRAFT_KEY_CHARS) {
        throw new ReviewDraftPatchError(
          `${label}.lineDrafts has a ${anchor.length}-character anchor key, over the ${MAX_LINE_DRAFT_KEY_CHARS} limit`,
        );
      }
      if (text.length > MAX_DRAFT_FIELD_CHARS) {
        throw new ReviewDraftPatchError(
          `${label}.lineDrafts["${anchor}"] is ${text.length} characters, over the ${MAX_DRAFT_FIELD_CHARS} limit for a draft field`,
        );
      }
      lineDrafts[anchor] = text;
    }
  }

  return {
    ...(feedback !== undefined ? { feedback } : {}),
    ...(acceptReason !== undefined ? { acceptReason } : {}),
    ...(sessionMessage !== undefined ? { sessionMessage } : {}),
    ...(viewedFiles !== undefined ? { viewedFiles } : {}),
    ...(lineDrafts !== undefined ? { lineDrafts } : {}),
  };
}
