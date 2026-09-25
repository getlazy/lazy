/**
 * The port through which the web inbox MUTATES a system message.
 *
 * Same shape and same reason as `ReviewActions` (./review-actions.ts): reads in
 * the web layer go through the `Storage` instance it was handed, but every
 * WRITE goes through this port, which is implemented in the daemon
 * (src/daemon/message-service.ts). The web handler never marks a message read
 * or dismissed itself, and never takes the storage lock.
 *
 * There are only two verbs here because the store has only two state changes —
 * read and dismissal are separate states on the message, never deletions (see
 * `SystemMessage` in src/types). This port cannot express deleting a message,
 * deliberately: nothing may, and a UI that offered it would be lying about
 * what the store does.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests), the inbox still RENDERS — reading is a plain storage read — but the
 * two mutating routes answer 503 rather than half-working.
 */

import type { SystemMessage } from '../types';

export interface MessageActions {
  /**
   * Record that the human has seen this message. Idempotent — the first read
   * wins and its timestamp never moves.
   *
   * `id` may be a full id or a unique prefix; resolution (and the refusal on an
   * ambiguous prefix) belongs to the implementation, not the caller.
   */
  markRead(id: string): Promise<SystemMessage>;
  /**
   * File the message away: it leaves the default inbox and the builder's launch
   * context, and the record stays forever. Idempotent.
   */
  dismiss(id: string): Promise<SystemMessage>;
}

/**
 * Validate an id at the web boundary, exactly as `lazy messages` does at the
 * CLI boundary: ids are hex UUIDs or a prefix of one, so anything else is a
 * typo (or a probe) and is rejected here rather than reaching a store lookup —
 * where a stray `%` would act as a wildcard on the Postgres backend.
 */
export function isValidMessageId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[0-9a-fA-F-]+$/.test(id);
}
