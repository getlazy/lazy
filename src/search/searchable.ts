/**
 * Shared searchable content loader.
 *
 * Loads all searchable items (tasks, prompts, turns, commits, comments,
 * follow-ups) from storage for use in fuzzy search and MCP search tools.
 */

import type { Storage } from '../storage/interface';

export interface SearchableItem {
  type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'followup';
  taskId: string;
  taskCode: string | null;
  taskGoal: string;
  content: string;
  context?: string;
}

/**
 * Load all searchable content from storage.
 * Used by both CLI search (fuzzy mode) and MCP lazy_search tool.
 */
export async function getAllSearchableContent(storage: Storage): Promise<SearchableItem[]> {
  const items: SearchableItem[] = [];
  const tasks = await storage.listTasks();

  for (const task of tasks) {
    items.push({
      type: 'task',
      taskId: task.id,
      taskCode: task.code,
      taskGoal: task.goal,
      content: task.goal,
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

    const comments = await storage.getTaskComments(task.id);
    for (const comment of comments) {
      items.push({
        type: 'comment',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: comment.content,
        context: `Comment (${comment.created_at})`,
      });
    }

    const followUps = await storage.getTaskFollowUps(task.id);
    for (const followUp of followUps) {
      items.push({
        type: 'followup',
        taskId: task.id,
        taskCode: task.code,
        taskGoal: task.goal,
        content: followUp.content,
        context: `Follow-up (${followUp.created_at})`,
      });
    }

    const session = await storage.getSessionByTaskId(task.id);
    if (session) {
      const turns = await storage.getSessionTurns(session.id);
      for (const turn of turns) {
        items.push({
          type: 'turn',
          taskId: task.id,
          taskCode: task.code,
          taskGoal: task.goal,
          content: turn.content,
          context: `Turn ${turn.sequence} (${turn.role})`,
        });
      }

      const commits = await storage.getSessionCommits(session.id);
      for (const commit of commits) {
        items.push({
          type: 'commit',
          taskId: task.id,
          taskCode: task.code,
          taskGoal: task.goal,
          content: commit.message,
          context: `Commit ${commit.sha.substring(0, 7)}`,
        });
      }
    }
  }

  return items;
}
