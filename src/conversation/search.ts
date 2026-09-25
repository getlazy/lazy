/**
 * Keyword search across stored builder conversations.
 *
 * Shared by the MCP `lazy_conversation_search` handler, the
 * `lazy conversations search` CLI, and the daemon web page at
 * `/conversations?q=` — one implementation so excerpt windows, per-conversation
 * match limits, and the regex bound cannot drift.
 *
 * The query is a case-insensitive JS regex. JS has no Regexp.timeout (Teams'
 * Ruby side sets one globally), and a catastrophically-backtracking pattern
 * would otherwise run to completion on the caller's thread. The daemon serves
 * RPC, MCP, and the dashboard on a single event loop, so that hang is a
 * one-request outage. Matching therefore runs in a Worker with a deadline;
 * an over-time pattern takes the same "unusable pattern" path as a
 * syntactically invalid one. See {@link searchConversations}.
 */

import type { StoredConversation } from '../storage/types';
import { runRegexWorker, SEARCH_REGEX_DEADLINE_MS } from '../search/regex-worker';

export interface ConversationSearchMatch {
  role: string;
  excerpt: string;
}

export interface ConversationSearchHit {
  sessionId: string;
  startedAt: string | null;
  summary: string;
  matches: ConversationSearchMatch[];
}

export interface ConversationSearchOptions {
  /** Cap on conversations returned (default 10). */
  maxResults?: number;
  /** Cap on excerpt rows per conversation (default 5). */
  maxMatchesPerConversation?: number;
}

/**
 * How long one search may spend evaluating the user regex — the shared search
 * deadline, so conversation search and store search refuse a pattern on the
 * same budget. See {@link SEARCH_REGEX_DEADLINE_MS}.
 */
export const CONVERSATION_SEARCH_REGEX_DEADLINE_MS = SEARCH_REGEX_DEADLINE_MS;

/** Build a case-insensitive RegExp from a user-supplied pattern. */
export function conversationSearchRegex(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch (err) {
    throw new Error(`Invalid search pattern '${query}': ${(err as Error).message}`);
  }
}

/**
 * The matching loop. A function *declaration* on purpose: the Worker source is
 * this function's `toString()` plus {@link conversationSearchRegex}'s, so the
 * bound path and the unbounded path cannot drift. Do not turn these into
 * arrows or close over module-scope values — `toString()` does not capture
 * closures, and a `const fn = …` stringifies without its binding name.
 */
function searchConversationsUnbound(
  conversations: StoredConversation[],
  query: string,
  options: ConversationSearchOptions = {},
): ConversationSearchHit[] {
  const maxResults = options.maxResults ?? 10;
  const maxMatchesPerConversation = options.maxMatchesPerConversation ?? 5;
  const regex = conversationSearchRegex(query);

  const hits: ConversationSearchHit[] = [];

  for (const conv of conversations) {
    const matchingMessages: ConversationSearchMatch[] = [];
    for (const msg of conv.messages) {
      if (!regex.test(msg.text)) continue;

      const idx = msg.text.search(regex);
      const start = Math.max(0, idx - 100);
      const end = Math.min(msg.text.length, idx + 300);
      matchingMessages.push({
        role: msg.role,
        excerpt:
          (start > 0 ? '...' : '') +
          msg.text.substring(start, end) +
          (end < msg.text.length ? '...' : ''),
      });
    }

    if (matchingMessages.length > 0) {
      hits.push({
        sessionId: conv.sessionId,
        startedAt: conv.startedAt,
        summary: conv.summary.substring(0, 200),
        matches: matchingMessages.slice(0, maxMatchesPerConversation),
      });
    }
  }

  return hits.slice(0, maxResults);
}

/**
 * Worker body: the two function declarations above, plus a message handler.
 * The Blob-URL plumbing, deadline, and refusal shape live in
 * {@link runRegexWorker}, shared with store search.
 */
function conversationSearchWorkerSource(): string {
  return `${conversationSearchRegex.toString()}
${searchConversationsUnbound.toString()}
self.onmessage = function (event) {
  try {
    var data = event.data;
    var hits = searchConversationsUnbound(data.conversations, data.query, data.options);
    self.postMessage({ ok: true, result: hits });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
`;
}

/** Run {@link searchConversationsUnbound} off the caller's thread, bounded. */
async function searchConversationsBounded(
  conversations: StoredConversation[],
  query: string,
  options: ConversationSearchOptions,
): Promise<ConversationSearchHit[]> {
  return await runRegexWorker<
    { conversations: StoredConversation[]; query: string; options: ConversationSearchOptions },
    ConversationSearchHit[]
  >({
    id: 'conversation-search',
    source: conversationSearchWorkerSource,
    payload: { conversations, query, options },
    query,
  });
}

/**
 * Search conversation message bodies for `query` (treated as a regex pattern).
 * `conversations` should already be sorted most-recent-first if callers care
 * about presentation order; this function preserves input order.
 *
 * Syntax errors throw immediately (no Worker). Matching runs in a Worker with
 * {@link CONVERSATION_SEARCH_REGEX_DEADLINE_MS}; a pattern that has not
 * finished by then throws the same `Invalid search pattern` error the
 * surfaces already render for a typo.
 */
export async function searchConversations(
  conversations: StoredConversation[],
  query: string,
  options: ConversationSearchOptions = {},
): Promise<ConversationSearchHit[]> {
  // Compile on this thread first so a typo (`[unclosed`) fails instantly with
  // the engine's own message, matching the pre-bound behavior and skipping
  // Worker startup. An empty store has nothing to match; still compile so
  // `searchConversations([], '(unclosed')` keeps rejecting.
  conversationSearchRegex(query);
  if (conversations.length === 0) return [];
  return await searchConversationsBounded(conversations, query, options);
}
