/**
 * Find entities by their id.
 *
 * The builder and agents cite short hex ids all day — a raised item
 * `f7c33f91`, a message `fc83af1e`, a commit SHA — and text search never
 * matched them. A query that LOOKS like an id (hex, optionally with the dashes
 * of a uuid) additionally looks every id-bearing entity up by prefix; the text
 * search still runs, so a hex-shaped word loses nothing.
 *
 * Cost: an ordinary query never reaches the scan (the shape test is a regex),
 * and an id-shaped one reads each task's comments/raised items/artifacts/review
 * comments and each session's turns/commits through the Storage interface with
 * bounded concurrency. Ambiguous prefixes return every match.
 */

import type { Storage } from '../storage/interface';
import type { SearchResult } from '../storage/types';

/** Shortest id-shaped query. Below this a hex word ("face", "dead") is a word. */
export const MIN_ID_QUERY_LENGTH = 6;

const ID_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]*)*$/i;

/** The id a query denotes, lowercased, or null when it is not id-shaped. */
export function idQueryOf(query: string): string | null {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  if (q.replace(/-/g, '').length < MIN_ID_QUERY_LENGTH) return null;
  return ID_SHAPE.test(q) ? q : null;
}

function idMatches(id: string | null | undefined, q: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  if (lower.startsWith(q)) return true;
  // A prefix typed without the uuid's dashes ("f7c33f91ab") still names it.
  return !q.includes('-') && lower.replace(/-/g, '').startsWith(q);
}

const SCAN_CONCURRENCY = 16;

async function mapPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
}

/** Every entity whose id starts with the query. Empty for a non-id query. */
export async function searchById(storage: Storage, query: string): Promise<SearchResult[]> {
  const q = idQueryOf(query);
  if (!q) return [];

  const results: SearchResult[] = [];
  const tasks = await storage.listTasks();
  const taskById = new Map(tasks.map(t => [t.id, t]));

  const base = (task: { id: string; code: string | null; goal: string }) => ({
    task_id: task.id,
    task_code: task.code,
    task_goal: task.goal,
    matched_id: true as const,
  });

  for (const task of tasks) {
    if (idMatches(task.id, q)) {
      results.push({
        ...base(task), entity_type: 'task', entity_id: task.id,
        content: `id: ${task.id}`, match_context: task.id,
        entity_time: task.completed_at ?? task.created_at,
      });
    }
  }

  await mapPool(tasks, async task => {
    const found: SearchResult[] = [];
    const [comments, raised, reviewComments, artifacts, journal] = await Promise.all([
      storage.getTaskComments(task.id),
      storage.getTaskRaisedItems(task.id),
      storage.getTaskReviewComments(task.id),
      storage.listTaskArtifacts(task.id),
      storage.getTaskJournal(task.id),
    ]);
    for (const j of journal) {
      if (idMatches(j.id, q)) found.push({ ...base(task), entity_type: 'journal', entity_id: j.id, content: j.content, match_context: excerpt(j.content), entity_time: j.created_at });
    }
    for (const [index, c] of comments.entries()) {
      if (idMatches(c.id, q)) found.push({ ...base(task), entity_type: 'comment', entity_id: c.id, content: c.content, match_context: excerpt(c.content), entity_index: index, entity_time: c.created_at });
    }
    for (const [index, r] of raised.entries()) {
      if (idMatches(r.id, q)) found.push({ ...base(task), entity_type: 'raised', entity_id: r.id, content: r.content, match_context: excerpt(r.content), entity_index: index, entity_time: r.created_at });
    }
    for (const rc of reviewComments) {
      if (idMatches(rc.id, q)) found.push({ ...base(task), entity_type: 'review_comment', entity_id: rc.id, content: rc.content, match_context: excerpt(`${rc.file}:${rc.line} ${rc.content}`), entity_time: rc.created_at });
    }
    for (const a of artifacts) {
      if (idMatches(a.id, q)) found.push({ ...base(task), entity_type: 'artifact', entity_id: a.id, content: a.name, match_context: a.name, entity_time: a.created_at });
    }
    results.push(...found);
  });

  const sessions = await storage.listSessions(undefined, false);
  await mapPool(sessions, async session => {
    const task = taskById.get(session.task_id);
    if (!task) return;
    const [turns, commits] = await Promise.all([
      storage.getSessionTurns(session.id),
      storage.getSessionCommits(session.id),
    ]);
    for (const [index, t] of turns.entries()) {
      if (idMatches(t.id, q)) results.push({ ...base(task), entity_type: 'turn', entity_id: t.id, content: t.content, match_context: excerpt(t.content), entity_index: index, turn_sequence: t.sequence, entity_time: t.timestamp });
    }
    for (const [index, c] of commits.entries()) {
      if (idMatches(c.id, q) || idMatches(c.sha, q)) results.push({ ...base(task), entity_type: 'commit', entity_id: c.id, content: c.message, match_context: excerpt(`${c.sha.slice(0, 12)} ${c.message}`), entity_index: index, entity_time: c.timestamp });
    }
  });

  const empty = { task_id: '', task_code: null, task_goal: '', matched_id: true as const };
  for (const m of await storage.listSystemMessages({ includeDismissed: true })) {
    if (idMatches(m.id, q)) results.push({ ...empty, entity_type: 'message', entity_id: m.id, task_goal: m.title, content: m.body, match_context: excerpt(m.body), entity_time: m.created_at });
  }
  for (const conv of await storage.listConversationSummaries()) {
    if (idMatches(conv.sessionId, q)) results.push({ ...empty, entity_type: 'conversation', entity_id: conv.sessionId, task_goal: conv.summary, content: conv.summary, match_context: excerpt(conv.summary) });
  }
  return results;
}
