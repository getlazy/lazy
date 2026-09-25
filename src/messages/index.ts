/**
 * System messages — proactive system-to-human reports.
 *
 * Rendering and injection helpers for the system-messages store (see
 * `SystemMessage` in src/types). The store itself lives behind the Storage
 * interface; this module only shapes it for surfaces:
 *
 *   - the builder's launch prompt gets a compact section of UNREAD messages
 *     (title + attribution one-liners; bodies stay on demand via
 *     `lazy_messages` — same shape as the memory index injection);
 *   - `lazy messages` renders the same one-liners in its listing;
 *   - the web inbox (src/server/messages.ts) renders the same state and kind
 *     vocabulary defined below.
 *
 * ONE VOCABULARY: the state words (`unread`/`read`/`dismissed`), what each one
 * MEANS, and what each kind means are defined here and nowhere else. Every
 * surface renders these; none coins its own synonym, so the CLI and the web
 * inbox can never describe the same message differently.
 *
 * Boundary (doctor-single-warning-surface): system messages are NOT a warning
 * channel. Config/health diagnosis belongs to `lazy doctor`; this store carries
 * proactive reports and analyses the system wrote FOR the human.
 */

import type { Storage } from '../storage';
import type { SystemMessage, SystemMessageKind } from '../types';
import { logger } from '../utils/logger';

// Embedded at build/compile time — changes require rebuild
import systemMessagesBuilderTemplate from '../prompts/system-messages-builder.md' with { type: 'text' };

/** Short display id — first 8 chars of the UUID, same as task short ids. */
export function shortMessageId(id: string): string {
  return id.slice(0, 8);
}

/**
 * One index line per message: short id, kind, source, age-free ISO date, title.
 * Kept to a single line on purpose — compact surfaces (builder launch, list)
 * render only this; the body is read on demand.
 */
export function renderSystemMessageLine(message: SystemMessage): string {
  const date = new Date(message.created_at).toISOString().slice(0, 10);
  return `- \`${shortMessageId(message.id)}\` [${message.kind}] ${message.title} — from ${message.source}, ${date}`;
}

/** A message is unread when the human has neither read nor dismissed it. */
export function isUnreadSystemMessage(message: SystemMessage): boolean {
  return !message.read_at && !message.dismissed_at;
}

/**
 * The three lifecycle states a surface ever shows, in the words every surface
 * uses. Dismissal outranks reading: a message dismissed without ever being read
 * reads as `dismissed`, because that is the decision the human made about it.
 */
export type SystemMessageState = 'unread' | 'read' | 'dismissed';

export function systemMessageState(message: SystemMessage): SystemMessageState {
  if (message.dismissed_at) return 'dismissed';
  if (message.read_at) return 'read';
  return 'unread';
}

/**
 * What each state MEANS, in one sentence, for surfaces that can afford to say
 * it (the web inbox renders these as the states' tooltips/legend). The
 * distinction that matters to the human is what still reaches the builder:
 * only unread messages do.
 */
export const SYSTEM_MESSAGE_STATE_MEANING: Record<SystemMessageState, string> = {
  unread: 'You have not seen this yet — it is in the builder\'s launch context until you read or dismiss it.',
  read: 'You have seen it. It stays in the inbox but no longer reaches the builder\'s launch context.',
  dismissed: 'Handled and filed away. Hidden from the default inbox, never deleted — the all view still has it.',
};

/**
 * What each kind means — the same wording `lazy_message_post` documents for
 * producers, so the human reads back the definition the producer chose from.
 */
export const SYSTEM_MESSAGE_KIND_MEANING: Record<SystemMessageKind, string> = {
  report: 'a produced analysis',
  notice: 'a system event worth knowing',
  alert: 'needs your attention soon',
};

/**
 * Build the "unread system messages" section for the builder's launch prompt.
 * Returns '' when there is nothing unread — nothing is injected until the
 * system actually has something to say.
 *
 * INVARIANT: a broken store must not block the builder's launch. Any storage
 * failure is logged loudly (never swallowed — see CLAUDE.md) and the launch
 * proceeds without the section; the builder can still list messages on demand
 * with `lazy_messages`.
 */
export async function buildSystemMessagesSection(storage: Storage): Promise<string> {
  try {
    const messages = await storage.listSystemMessages();
    const unread = messages.filter(isUnreadSystemMessage);
    if (unread.length === 0) return '';
    const lines = unread.map(renderSystemMessageLine).join('\n');
    return systemMessagesBuilderTemplate.replace('{{MESSAGES}}', lines).trimEnd();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to read system messages for the builder prompt: ${message}. ` +
      'Launching without the section — the builder can still list them with lazy_messages.',
    );
    return '';
  }
}
