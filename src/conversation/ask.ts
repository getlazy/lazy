/**
 * Ask-style Q&A against a stored conversation.
 *
 * Claude Code's own retention ages old sessions out of `/resume`, but lazy's
 * conversation store keeps them forever. Reading one back (`lazy show <id>`,
 * `lazy_conversation_read`) has always worked; this module is the missing verb —
 * asking one a question.
 *
 * Shape, and why it is not the task ask:
 *
 *   A task ask (`launchAskTask`) resumes the agent's LIVE session in its
 *   worktree: there is a session to resume, a worktree to look at, and a task
 *   status to restore afterwards. A stored conversation has none of those. It
 *   is immutable text in lazy's store, and the machine that produced it is
 *   long gone. So the conversation ask is a throwaway one-shot instead: render
 *   the stored transcript, hand it to a fresh read-only agent along with the
 *   question, print the answer, keep nothing.
 *
 * Persistence: NOTHING is written. The conversation is immutable history and an
 * ask is a read of it. The one-shot prompt is stamped as a machine one-shot
 * (see src/import/machine-oneshot.ts), so the ask's own Claude Code session is
 * never captured back into the conversation store — asking a conversation a
 * question does not create another conversation.
 *
 * Oversized transcripts map-reduce rather than fail (same shape as `lazy
 * report`): consecutive excerpts are read in parallel, each reporting only what
 * bears on the question, and a reduce pass writes the single answer. Every
 * degradation — an excerpt that failed, a single message too large to pass
 * whole — comes back as a warning rather than being silently absorbed.
 *
 * That map-reduce is not spelled here: it lives in src/oneshot/ask-engine.ts,
 * shared with the task-record ask (src/task/record-ask.ts). This module owns
 * only what is specific to a conversation — how a stored message renders, and
 * the three prompt templates.
 */

import { chunkParts, runAskEngine, TRANSCRIPT_CHARS_PER_CALL as ENGINE_BUDGET, type AskChunk } from '../oneshot/ask-engine';
import type { StoredConversation, StoredMessage } from '../storage/types';
import type { TokenUsage } from '../types';

import singleTemplate from '../prompts/conversation-ask-single.md' with { type: 'text' };
import mapTemplate from '../prompts/conversation-ask-map.md' with { type: 'text' };
import reduceTemplate from '../prompts/conversation-ask-reduce.md' with { type: 'text' };

/**
 * How many characters of rendered transcript may go into ONE prompt.
 *
 * Re-exported from the shared engine, where the argv reasoning behind the
 * number lives, so existing callers and tests keep one import site.
 */
export const TRANSCRIPT_CHARS_PER_CALL = ENGINE_BUDGET;

export interface ConversationAskOptions {
  /**
   * Progress sink for the human-facing surfaces. Called with one short line per
   * milestone (chunking decision, each excerpt, reduce). The CLI routes these
   * to stderr; the MCP handler passes nothing.
   */
  onProgress?: (message: string) => void;
}

export interface ConversationAskResult {
  /** Session ID of the conversation that was asked. */
  sessionId: string;
  /** The answer, as plain text. */
  answer: string;
  /** How many excerpts the transcript was split into. 1 = single pass. */
  chunks: number;
  /** How many excerpts had anything bearing on the question (0 when chunks === 1). */
  relevantChunks: number;
  /** Summed usage across every pass. */
  usage: TokenUsage;
  /** Degradations the caller must surface: failed excerpts, elided message text. */
  warnings: string[];
}

/** Render one stored message the way the transcript surfaces do. */
function renderMessage(msg: StoredMessage): string {
  const role = msg.role === 'user' ? 'human' : 'assistant';
  const time = msg.timestamp ? ` (${msg.timestamp.replace('T', ' ').substring(0, 19)})` : '';
  return `--- ${role}${time} ---\n${msg.text}`;
}

/**
 * The conversation's own identifying facts, so the agent can date and place
 * what it is reading ("this was before the daemon rewrite").
 */
function renderMetadata(conv: StoredConversation): string {
  const lines = [
    `- Session: ${conv.sessionId}`,
    `- Summary: ${conv.summary}`,
  ];
  if (conv.gitBranch) lines.push(`- Branch: ${conv.gitBranch}`);
  if (conv.startedAt) lines.push(`- Started: ${conv.startedAt}`);
  if (conv.endedAt) lines.push(`- Ended: ${conv.endedAt}`);
  lines.push(
    `- Messages: ${conv.stats.messageCount} ` +
    `(${conv.stats.userMessageCount} human, ${conv.stats.assistantMessageCount} assistant)`,
  );
  return lines.join('\n');
}

/** Re-exported so callers keep one name for the engine's chunk shape. */
export type TranscriptChunk = AskChunk;

/**
 * Split a conversation into consecutive chunks, each under the per-call budget.
 *
 * Messages are never split across chunks — an answer assembled from half of a
 * message on either side of a boundary is worse than one assembled from whole
 * messages. The exception is a SINGLE message that alone exceeds the budget:
 * that one is truncated in place, with a visible marker in the text and a
 * warning for the caller, because the alternative is failing the whole ask over
 * one long paste.
 *
 * Exported for unit tests: the boundary behaviour is the part of this module
 * most likely to regress silently.
 */
export function chunkTranscript(
  messages: StoredMessage[],
  budget: number = TRANSCRIPT_CHARS_PER_CALL,
): TranscriptChunk[] {
  return chunkParts(
    messages.map(msg => ({
      text: renderMessage(msg),
      noun: 'message',
      warningSubject:
        `One ${msg.role === 'user' ? 'human' : 'assistant'} message` +
        (msg.timestamp ? ` at ${msg.timestamp}` : ''),
    })),
    budget,
  );
}

/**
 * Ask a stored conversation a question and return the answer.
 *
 * Throws when the ask cannot produce an answer at all (no messages, every
 * excerpt failed, the single pass failed). Partial failures come back as
 * warnings on the result — the caller decides how loudly to say so, but is
 * never handed a confident answer built from silently-dropped input.
 */
export async function askConversation(
  conv: StoredConversation,
  question: string,
  opts: ConversationAskOptions = {},
): Promise<ConversationAskResult> {
  const chunks = chunkTranscript(conv.messages);
  const result = await runAskEngine({
    subject: `conversation ${conv.sessionId.substring(0, 8)}`,
    sizeLabel: `${conv.messages.length} messages`,
    metadata: renderMetadata(conv),
    question,
    chunks,
    templates: { single: singleTemplate, map: mapTemplate, reduce: reduceTemplate },
    onProgress: opts.onProgress,
  });
  return { sessionId: conv.sessionId, ...result };
}

/**
 * Resolve a conversation by exact session ID or unique prefix.
 *
 * Same rule as `lazy show` (src/cli/commands/show.ts): an exact match wins, a
 * unique prefix is accepted, and an ambiguous prefix is an ERROR rather than a
 * silent pick of the first hit. Shared so the CLI and the MCP tool cannot drift
 * into resolving the same string differently.
 */
export async function resolveStoredConversation(
  storage: { listConversations(): Promise<StoredConversation[]>; loadConversation(id: string): Promise<StoredConversation | null> },
  idOrPrefix: string,
): Promise<{ conversation: StoredConversation } | { ambiguous: StoredConversation[] } | null> {
  const conversations = await storage.listConversations();
  const exact = conversations.find(c => c.sessionId === idOrPrefix);
  const prefixMatches = conversations.filter(c => c.sessionId.startsWith(idOrPrefix));
  const match = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);

  if (!match) {
    if (prefixMatches.length > 1) return { ambiguous: prefixMatches };
    return null;
  }

  // listConversations may hand back a lighter shape than the store holds;
  // load the authoritative copy so the transcript is never half-rendered.
  const full = await storage.loadConversation(match.sessionId);
  if (!full) {
    throw new Error(`Conversation ${match.sessionId} is listed but could not be loaded from the store.`);
  }
  return { conversation: full };
}
