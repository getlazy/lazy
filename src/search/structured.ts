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
import { levenshteinDistance } from '../utils/levenshtein';

/** Substring match, tolerant of a missing haystack (see evaluator.ts). */
function textContains(haystack: unknown, needle: string): boolean {
  if (typeof haystack !== 'string') return false;
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
 * Extract `in:memories` search terms from a query AST.
 * Memory records are project-level entities (like conversations), so they are
 * searched separately from the per-task evaluation.
 */
function extractMemoryTerms(node: QueryNode): string[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return [...extractMemoryTerms(node.left), ...extractMemoryTerms(node.right)];
    case 'not':
      return [];
    case 'in':
      if (node.scope === 'memories') return [node.value];
      return [];
    default:
      return [];
  }
}

/**
 * Extract the tag values a query filters on.
 *
 * NOT branches are skipped: `NOT tag:x` returning nothing says nothing about
 * whether `x` exists, so it must not drive a "no task is tagged #x" hint.
 */
function extractTagTerms(node: QueryNode): string[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return [...extractTagTerms(node.left), ...extractTagTerms(node.right)];
    case 'not':
      return [];
    case 'field':
      return node.field === 'tag' ? [node.value] : [];
    default:
      return [];
  }
}

/** Tags close enough to an unmatched query tag to be worth suggesting. */
function suggestTags(queried: string, known: string[]): string[] {
  return known
    .map(tag => {
      // A prefix/substring relation is a stronger signal than raw edit
      // distance: it is what an unquoted multi-word tag produces
      // (`tag:My Feature Work` queries "my", the real tag is "my-feature-work").
      const related = tag.startsWith(queried) || tag.includes(queried) || queried.includes(tag);
      const distance = levenshteinDistance(queried, tag);
      return { tag, related, distance };
    })
    .filter(c => c.related || c.distance <= 2)
    .sort((a, b) => Number(b.related) - Number(a.related) || a.distance - b.distance)
    .slice(0, 3)
    .map(c => c.tag);
}

const MAX_KNOWN_TAGS_SHOWN = 15;

/**
 * Explain a zero-result search that filtered on tags.
 *
 * Tag search is silently unforgiving: tags are normalized on write, so a typo,
 * a tag that was never applied, or an unquoted multi-word value all produce the
 * same bare "No matches found." Returns a hint naming the tags that do not
 * exist, or null when there is nothing tag-specific to explain.
 */
export async function buildTagHint(storage: Storage, query: string): Promise<string | null> {
  let ast: QueryNode;
  try {
    ast = parseQuery(query);
  } catch {
    // An unparseable query is reported to the user as a parse error by the
    // caller; there is no tag hint to add on top of that.
    return null;
  }

  const queried = [...new Set(extractTagTerms(ast))];
  if (queried.length === 0) return null;

  const tasks = await storage.listTasks();
  const known = [...new Set(tasks.flatMap(t => t.tags ?? []))].sort();

  // Every queried tag exists, so the empty result came from the rest of the
  // query (a status, a date range, a text term) — not from the tag.
  const unknown = queried.filter(tag => !known.includes(tag));
  if (unknown.length === 0) return null;

  const lines: string[] = [];
  for (const tag of unknown) {
    const suggestions = suggestTags(tag, known);
    lines.push(
      suggestions.length > 0
        ? `No task is tagged #${tag} — did you mean ${suggestions.map(s => `#${s}`).join(', ')}?`
        : `No task is tagged #${tag}.`
    );
  }

  if (known.length === 0) {
    lines.push('This project has no tags yet. Add one with: lazy tag <task> <tag>');
  } else {
    const shown = known.slice(0, MAX_KNOWN_TAGS_SHOWN).map(t => `#${t}`).join(' ');
    const more = known.length > MAX_KNOWN_TAGS_SHOWN
      ? ` (+${known.length - MAX_KNOWN_TAGS_SHOWN} more)`
      : '';
    lines.push(`Known tags: ${shown}${more}`);
  }

  lines.push(
    'Tags are normalized to lowercase alphanumerics and hyphens. ' +
    'Quote a multi-word tag: tag:"My Feature Work"'
  );

  return lines.join('\n');
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

  // --- Memory evaluation ---
  // Only live records are searchable: a tombstoned record is not part of the
  // project's current knowledge (its content stays in the write history).
  const memoryTerms = extractMemoryTerms(ast);
  if (memoryTerms.length > 0) {
    const memories = await storage.listMemories();
    const seen = new Set<string>();

    for (const memory of memories) {
      for (const term of memoryTerms) {
        const haystack = `${memory.name}\n${memory.description}\n${memory.body}`;
        if (!textContains(haystack, term)) continue;
        const key = `${memory.name}:${term}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push({
          entity_type: 'memory',
          entity_id: memory.name,
          task_id: memory.name,
          task_code: null,
          task_goal: `memory: ${memory.name}`,
          content: memory.body,
          match_context: extractSearchContext(haystack, term),
        });
      }
    }
  }

  return allResults;
}
