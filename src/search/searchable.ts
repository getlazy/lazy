/**
 * Shared searchable content loader — the ONE owner of this shape.
 *
 * Loads all searchable items (tasks, prompts, turns, commits, comments,
 * raised items, conversations, memories) from storage for fuzzy search.
 *
 * Both fuzzy call sites live on this module: the MCP `lazy_search` tool
 * (`src/mcp/tools.ts`, via `src/search/index.ts`) and the CLI/daemon-RPC path
 * (`src/search/fuzzy.ts`, which re-exports it). It used to be two
 * near-identical copies, and they drifted in ways nothing caught: the MCP copy
 * never loaded conversations at all, and indexed a task's goal without its
 * code. Adding a field meant adding it twice — only a type error caught the
 * miss when the search locator fields went in. Keep it one implementation.
 */

import type { Storage } from '../storage/interface';
import { turnText } from '../utils/turn-content';
import { entityTimeFromIso } from './ranking';

export interface SearchableItem {
  type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'raised' | 'conversation' | 'memory' | 'scratch';
  taskId: string;
  taskCode: string | null;
  taskGoal: string;
  content: string;
  context?: string;
  /**
   * 0-based position within the task's own turns/commits/comments/raised-items
   * list — the same order `show` pages over, so it doubles as an `offset`.
   * Absent for entities that have no such position (task, prompt,
   * conversation, memory).
   */
  entityIndex?: number;
  /** The turn's own sequence number (`Turn #12` in show output). Turns only. */
  turnSequence?: number;
  /**
   * When the entity last changed, epoch ms — the recency signal ranking sorts
   * by within a tier. Same convention as the other producers: tasks and
   * prompts the task's completed_at ?? created_at, turns and commits their
   * timestamp, comments and raised items their created_at, conversation
   * messages their parsed timestamp, memories their updated_at.
   */
  entityTime?: number;
}

/**
 * fuse.js options for fuzzy content search.
 *
 * Shared for the same reason the loader is: two copies of these numbers would
 * mean the same query scoring differently depending on which surface asked.
 */
export const FUZZY_SEARCH_OPTIONS = {
  keys: ['content'],
  includeScore: true,
  includeMatches: true,
  threshold: 0.4,
  ignoreLocation: true,
  minMatchCharLength: 2,
};

/**
 * Load all searchable content from storage.
 * Used by both CLI search (fuzzy mode) and the MCP lazy_search tool.
 */
export async function getAllSearchableContent(storage: Storage): Promise<SearchableItem[]> {
  const items: SearchableItem[] = [];
  const tasks = await storage.listTasks();

  for (const task of tasks) {
    // The task's own "last change", the way the `updated:` filter reads it —
    // carried on both task-level items as the recency signal ranking sorts by.
    const taskTime = task.completed_at ?? task.created_at;
    // Index the code alongside the goal so a fuzzy query can find a task by
    // the name humans actually type.
    items.push({
      type: 'task',
      taskId: task.id,
      taskCode: task.code,
      taskGoal: task.goal,
      content: task.code ? `${task.code} ${task.goal}` : task.goal,
      entityTime: taskTime,
    });

    if (task.prompt) {
      items.push({
        type: 'prompt',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: task.prompt,
        entityTime: taskTime,
      });
    }

    // The array index of each entity below is its locator: these are the very
    // lists `show` pages over, so the index doubles as a ready-made `offset`.
    const comments = await storage.getTaskComments(task.id);
    for (const [index, comment] of comments.entries()) {
      items.push({
        type: 'comment',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: comment.content,
        context: `Comment (${comment.created_at})`,
        entityIndex: index,
        entityTime: comment.created_at,
      });
    }

    // Raised items are task-level, indexed for fuzzy search so `in:raised` /
    // `--raised` and free-text can find agent questions and proposals.
    const raisedItems = await storage.getTaskRaisedItems(task.id);
    for (const [index, item] of raisedItems.entries()) {
      items.push({
        type: 'raised',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: item.content,
        context: `Raised (${item.status}, ${item.created_at})`,
        entityIndex: index,
        entityTime: item.created_at,
      });
    }

    const session = await storage.getSessionByTaskId(task.id);
    if (session) {
      const turns = await storage.getSessionTurns(session.id);
      for (const [index, turn] of turns.entries()) {
        items.push({
          type: 'turn',
          taskId: task.id,
          taskCode: task.code,
          taskGoal: task.goal,
          content: turnText(turn),
          context: `Turn ${turn.sequence} (${turn.role})`,
          entityIndex: index,
          turnSequence: turn.sequence,
          entityTime: turn.timestamp,
        });
      }

      const commits = await storage.getSessionCommits(session.id);
      for (const [index, commit] of commits.entries()) {
        items.push({
          type: 'commit',
          taskId: task.id,
          taskCode: task.code,
          taskGoal: task.goal,
          content: commit.message,
          context: `Commit ${commit.sha.substring(0, 7)}`,
          entityIndex: index,
          entityTime: commit.timestamp,
        });
      }
    }
  }

  // Conversations are standalone entities, not attached to any task, so
  // taskId/taskGoal carry the conversation's own identity.
  const conversations = await storage.listConversations();
  for (const conv of conversations) {
    // A summary item speaks for the whole conversation; its recency is the
    // conversation's end, falling back to import time when no end was recorded.
    const summaryTime = entityTimeFromIso(conv.endedAt) ?? conv.importedAt;
    if (conv.summary) {
      items.push({
        type: 'conversation',
        taskId: conv.sessionId,
        taskCode: null,
        taskGoal: conv.summary,
        content: conv.summary,
        context: `Conversation summary`,
        entityTime: summaryTime,
      });
    }

    for (const msg of conv.messages) {
      if (msg.text) {
        items.push({
          type: 'conversation',
          taskId: conv.sessionId,
          taskCode: null,
          taskGoal: conv.summary || '(conversation)',
          content: msg.text,
          context: `Conversation (${msg.role})`,
          entityTime: entityTimeFromIso(msg.timestamp),
        });
      }
    }
  }

  // Memory records are project-level, not per-task: taskId/taskGoal carry the
  // record's own identity so results still render a useful line.
  const memories = await storage.listMemories();
  for (const memory of memories) {
    items.push({
      type: 'memory',
      taskId: memory.name,
      taskCode: null,
      taskGoal: `memory: ${memory.name}`,
      content: `${memory.name}\n${memory.description}\n${memory.body}`,
      context: `Memory (${memory.type}, updated by ${memory.updated_by})`,
      entityTime: memory.updated_at,
    });
  }

  // Captured builder scratch files — project-level like memories. Path is part
  // of the indexed content so a metadata-only record is still findable by name.
  const scratchFiles = await storage.listScratchFiles();
  for (const file of scratchFiles) {
    items.push({
      type: 'scratch',
      taskId: file.path,
      taskCode: null,
      taskGoal: `scratch: ${file.path}`,
      content: `${file.path}\n${file.content}`,
      context: file.skipped
        ? `Builder scratch (${file.skipped}, content not stored)`
        : `Builder scratch (updated by ${file.updated_by})`,
      entityTime: file.updated_at,
    });
  }

  return items;
}
