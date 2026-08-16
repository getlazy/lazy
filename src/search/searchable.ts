/**
 * Shared searchable content loader — the ONE owner of this shape.
 *
 * Loads all searchable items (tasks, prompts, turns, commits, comments,
 * follow-ups, conversations, memories) from storage for fuzzy search.
 *
 * Both fuzzy call sites live on this module: the MCP `lazy_search` tool
 * (`src/mcp/tools.ts`, via `src/search/index.ts`) and the CLI/daemon-RPC path
 * (`src/cli/commands/search-data.ts`, which re-exports it). It used to be two
 * near-identical copies, and they drifted in ways nothing caught: the MCP copy
 * never loaded conversations at all, and indexed a task's goal without its
 * code. Adding a field meant adding it twice — only a type error caught the
 * miss when the search locator fields went in. Keep it one implementation.
 */

import type { Storage } from '../storage/interface';
import { turnText } from '../utils/turn-content';

export interface SearchableItem {
  type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'followup' | 'conversation' | 'memory';
  taskId: string;
  taskCode: string | null;
  taskGoal: string;
  content: string;
  context?: string;
  /**
   * 0-based position within the task's own turns/commits/comments/follow-ups
   * list — the same order `show` pages over, so it doubles as an `offset`.
   * Absent for entities that have no such position (task, prompt,
   * conversation, memory).
   */
  entityIndex?: number;
  /** The turn's own sequence number (`Turn #12` in show output). Turns only. */
  turnSequence?: number;
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
    // Index the code alongside the goal so a fuzzy query can find a task by
    // the name humans actually type.
    items.push({
      type: 'task',
      taskId: task.id,
      taskCode: task.code,
      taskGoal: task.goal,
      content: task.code ? `${task.code} ${task.goal}` : task.goal,
    });

    if (task.prompt) {
      items.push({
        type: 'prompt',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: task.prompt,
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
      });
    }

    const followUps = await storage.getTaskFollowUps(task.id);
    for (const [index, followUp] of followUps.entries()) {
      items.push({
        type: 'followup',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: followUp.content,
        context: `Follow-up (${followUp.created_at})`,
        entityIndex: index,
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
        });
      }
    }
  }

  // Conversations are standalone entities, not attached to any task, so
  // taskId/taskGoal carry the conversation's own identity.
  const conversations = await storage.listConversations();
  for (const conv of conversations) {
    if (conv.summary) {
      items.push({
        type: 'conversation',
        taskId: conv.sessionId,
        taskCode: null,
        taskGoal: conv.summary,
        content: conv.summary,
        context: `Conversation summary`,
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
    });
  }

  return items;
}
