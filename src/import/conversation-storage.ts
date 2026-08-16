/**
 * Conversation storage helpers
 *
 * Provides conversion utilities for building StoredConversation objects
 * from parsed Claude Code logs. The actual storage operations are now
 * part of the Storage interface — this module handles the transformation
 * from import format to storage format.
 */

import type { ParsedConversation } from './claude-code-logs';
import type { StoredConversation, ConversationStats } from '../storage/types';
import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';

// Re-export types for backward compatibility
export type { StoredConversation, StoredMessage, StoredSubagent, ConversationStats } from '../storage/types';

/**
 * Convert a parsed conversation + metadata into a StoredConversation
 * ready for persistence via storage.saveConversation().
 */
export function toStoredConversation(
  conversation: ParsedConversation,
  summary: string,
  stats: ConversationStats
): StoredConversation {
  return {
    sessionId: conversation.sessionId,
    projectPath: conversation.projectPath,
    cwd: conversation.cwd,
    version: conversation.version,
    gitBranch: conversation.gitBranch,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    importedAt: Date.now(),
    summary,
    stats,
    totalUsage: conversation.totalUsage,
    messages: conversation.messages.map((m) => ({
      uuid: m.uuid,
      parentUuid: m.parentUuid,
      timestamp: m.timestamp,
      role: m.role,
      text: m.text,
      model: m.model,
      usage: m.usage,
    })),
    subagents: conversation.subagents.map((s) => ({
      agentId: s.agentId,
      messages: s.messages.map((m) => ({
        uuid: m.uuid,
        parentUuid: m.parentUuid,
        timestamp: m.timestamp,
        role: m.role,
        text: m.text,
        model: m.model,
        usage: m.usage,
      })),
    })),
  };
}

/**
 * Is `incoming` a strict PREFIX of `stored` — the same conversation, but cut short?
 *
 * A Claude session is append-only: message uuids never change and new turns are
 * only ever added at the end. So when every message in `incoming` matches `stored`
 * position-for-position by uuid and `stored` has more, `incoming` is an older
 * snapshot of the same line. It is never a legitimate update.
 *
 * A conversation that DIVERGES (same session id, different uuids at some position)
 * is NOT a prefix — that is a genuine rewrite and is allowed through, because the
 * safe thing there is to reflect what is actually on disk.
 */
export function isStrictPrefixConversation(
  incoming: StoredConversation,
  stored: StoredConversation,
): boolean {
  if (incoming.messages.length >= stored.messages.length) return false;
  for (let i = 0; i < incoming.messages.length; i++) {
    if (incoming.messages[i].uuid !== stored.messages[i].uuid) return false;
  }
  return true;
}

/** What a no-regression save actually did, so callers can report it. */
export type ConversationSaveOutcome = 'saved' | 'skipped-regression';

/**
 * Persist a captured conversation, refusing to replace a strictly LONGER stored
 * copy with a strict prefix of itself.
 *
 * INVARIANT: capture never shortens a stored conversation. Every capture surface
 * re-parses whatever JSONL it found and blind-writes the result, so a single stale
 * copy of a session — one frozen at an earlier point and then merely touched — is
 * enough to overwrite hours of conversation the user could otherwise still read via
 * `lazy view`. That is not hypothetical: it happened, alongside the resume-side bug
 * this guard ships with (see src/builder/projects-isolation.ts). Storing the longer
 * transcript is always at least as correct as storing its prefix.
 *
 * Enforced HERE, on the daemon side of every capture path, so no client — the
 * in-container builder monitor, the CLI, or the daemon's own sweep — has to
 * remember it. Deliberately narrow: only a provable prefix is refused.
 */
export async function saveConversationWithoutRegression(
  storage: Storage,
  conversation: StoredConversation,
): Promise<ConversationSaveOutcome> {
  const existing = await storage.loadConversation(conversation.sessionId);
  if (existing && isStrictPrefixConversation(conversation, existing)) {
    logger.warn(
      `Ignoring a capture of conversation ${conversation.sessionId} that would have shortened it ` +
      `(${existing.messages.length} messages stored, ${conversation.messages.length} offered). ` +
      `The incoming copy is an earlier snapshot of the same session.`,
    );
    return 'skipped-regression';
  }
  await storage.saveConversation(conversation);
  return 'saved';
}
