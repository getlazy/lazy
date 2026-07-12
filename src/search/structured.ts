/**
 * Structured search engine.
 *
 * Evaluates Lucene-style queries against all tasks and conversations.
 * Used by both CLI search command and MCP lazy_search tool.
 */

import type { Storage } from '../storage/interface';
import type { SearchResult } from '../storage/types';
import type { Turn, Commit } from '../types';
import { parseQuery, type QueryNode } from './parser';
import { evaluateQuery, buildSearchResults, type TaskData } from './evaluator';

function textContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function extractSearchContext(text: string, term: string, contextChars: number = 40): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.substring(0, 80);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + term.length + contextChars);

  let result = text.substring(start, end).replace(/\s+/g, ' ').trim();

  if (start > 0) result = '...' + result;
  if (end < text.length) result = result + '...';

  return result;
}

/**
 * Extract `in:conversations` search terms from a query AST.
 * Returns the text values that should be searched in conversations.
 */
function extractConversationTerms(node: QueryNode): string[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return [...extractConversationTerms(node.left), ...extractConversationTerms(node.right)];
    case 'not':
      return [];
    case 'in':
      if (node.scope === 'conversations') return [node.value];
      return [];
    default:
      return [];
  }
}

/**
 * Execute a structured query (Lucene-style) against all tasks and conversations.
 * Loads all task data and evaluates the AST against each task.
 * Also searches conversations for any `in:conversations` terms.
 */
export async function structuredSearch(storage: Storage, query: string): Promise<SearchResult[]> {
  const ast = parseQuery(query);
  const allResults: SearchResult[] = [];

  // --- Task evaluation ---
  const tasks = await storage.listTasks();
  for (const task of tasks) {
    const comments = await storage.getTaskComments(task.id);
    const followUps = await storage.getTaskFollowUps(task.id);
    const session = await storage.getSessionByTaskId(task.id);

    let turns: Turn[] = [];
    let commits: Commit[] = [];
    if (session) {
      turns = await storage.getSessionTurns(session.id);
      commits = await storage.getSessionCommits(session.id);
    }

    const data: TaskData = { task, turns, commits, comments, followUps };

    if (evaluateQuery(ast, data)) {
      const results = buildSearchResults(ast, data);
      allResults.push(...results);
    }
  }

  // --- Conversation evaluation ---
  const convTerms = extractConversationTerms(ast);
  if (convTerms.length > 0) {
    const conversations = await storage.listConversations();
    const seen = new Set<string>();

    for (const conv of conversations) {
      for (const term of convTerms) {
        for (const msg of conv.messages) {
          if (textContains(msg.text, term)) {
            const key = `${conv.sessionId}:${term}`;
            if (!seen.has(key)) {
              seen.add(key);
              allResults.push({
                entity_type: 'conversation',
                entity_id: conv.sessionId,
                task_id: conv.sessionId,
                task_code: null,
                task_goal: conv.summary || '(conversation)',
                content: msg.text,
                match_context: extractSearchContext(msg.text, term),
              });
            }
            break;
          }
        }

        if (conv.summary && textContains(conv.summary, term)) {
          const key = `${conv.sessionId}:summary:${term}`;
          if (!seen.has(key)) {
            seen.add(key);
            allResults.push({
              entity_type: 'conversation',
              entity_id: conv.sessionId,
              task_id: conv.sessionId,
              task_code: null,
              task_goal: conv.summary,
              content: conv.summary,
              match_context: conv.summary,
            });
          }
        }
      }
    }
  }

  return allResults;
}
