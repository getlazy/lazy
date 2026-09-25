/**
 * Message service — the daemon-side implementation of the web inbox's writes.
 *
 * The web layer (src/server/) must not import src/daemon/ (the daemon already
 * imports the server, so the reverse edge would be a cycle). It declares the
 * narrow `MessageActions` port instead, and this is what the daemon injects —
 * the same arrangement, and the same reason, as review-service.ts: every
 * mutation the dashboard performs happens in the daemon, so the web handler
 * never becomes a second writer of the store.
 *
 * There is no business logic to re-implement here, and that is the point: read
 * and dismissal are the store's own two state changes (`markSystemMessageRead`,
 * `dismissSystemMessage`), already idempotent, already append-only, already
 * shared with `lazy messages` and the `lazy_message_*` MCP tools. This adapter
 * only supplies the two things the web layer cannot: the daemon's Storage
 * instance, and the actor.
 *
 * ACTOR: a dismissal from the dashboard is recorded as `human`. The dashboard
 * is a loopback surface a person is sitting in front of — the same person the
 * CLI records as `human` — and dismissal is a human/builder decision by design
 * (the MCP tool refuses it for task agents). Nothing about the web channel
 * makes it a different kind of actor.
 */

import { getOrCreateStorage } from './rpc-handlers';
import type { MessageActions } from '../server/message-actions';
import type { Storage } from '../storage';
import type { SystemMessage } from '../types';

/**
 * A `MessageActions` over any Storage.
 *
 * Two callers, both of which are the daemon acting: the daemon's own dashboard
 * passes its in-process Storage, and the from-source dev server passes a
 * `RemoteStorage`, whose writes are the daemon's storage RPC. Neither opens a
 * store the daemon does not own.
 */
export function createStorageMessageActions(getStorage: () => Promise<Storage>): MessageActions {
  return {
    async markRead(id: string): Promise<SystemMessage> {
      return (await getStorage()).markSystemMessageRead(id);
    },
    async dismiss(id: string): Promise<SystemMessage> {
      return (await getStorage()).dismissSystemMessage(id, 'human');
    },
  };
}

/** The daemon's own implementation, bound to its single long-lived Storage. */
export function createMessageActions(): MessageActions {
  return createStorageMessageActions(getOrCreateStorage);
}
