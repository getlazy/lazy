/**
 * Structured forge identity on a comment ({@link Comment.external}).
 *
 * Which external item a comment corresponds to is metadata, not text: the
 * `{remote:<id>}` marker older imports embedded in the content is read only
 * to recognise legacy records (see imported-comments.ts), never written.
 */

import { createHash } from 'crypto';
import type { CommentExternalKind, CommentExternalRef, CommentForge } from '../types';

export const COMMENT_FORGES: readonly CommentForge[] = ['github', 'gitlab'];
export const COMMENT_EXTERNAL_KINDS: readonly CommentExternalKind[] = [
  'issue_comment', 'line_comment', 'review_body', 'mr_note',
];

/** sha256 (hex) of a forge body, exactly as the forge returned it. */
export function hashCommentBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The dedup key: one forge item, whatever its current body. */
export function externalKey(ref: Pick<CommentExternalRef, 'forge' | 'kind' | 'id'>): string {
  return `${ref.forge}:${ref.kind}:${ref.id}`;
}

/**
 * Parse an external ref arriving over a boundary (RPC). Throws naming the bad
 * field; `undefined`/`null` means "none".
 */
export function parseCommentExternalRef(value: unknown, field = 'external'): CommentExternalRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object with forge, kind, id and body_hash`);
  }
  const v = value as Record<string, unknown>;
  if (!COMMENT_FORGES.includes(v.forge as CommentForge)) {
    throw new Error(`${field}.forge must be one of ${COMMENT_FORGES.join(', ')} (got ${JSON.stringify(v.forge)})`);
  }
  if (!COMMENT_EXTERNAL_KINDS.includes(v.kind as CommentExternalKind)) {
    throw new Error(`${field}.kind must be one of ${COMMENT_EXTERNAL_KINDS.join(', ')} (got ${JSON.stringify(v.kind)})`);
  }
  if (typeof v.id !== 'string' || v.id === '') {
    throw new Error(`${field}.id must be a non-empty string`);
  }
  if (typeof v.body_hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.body_hash)) {
    throw new Error(`${field}.body_hash must be a sha256 hex digest`);
  }
  return { forge: v.forge as CommentForge, kind: v.kind as CommentExternalKind, id: v.id, body_hash: v.body_hash };
}
