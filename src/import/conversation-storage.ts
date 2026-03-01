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
