/**
 * Search data layer — shared between CLI direct mode and daemon RPC handlers.
 *
 * Extracted from search.ts to avoid importing CLI rendering/theme code
 * in the daemon process.
 */

import type { SearchResult } from '../../storage';
import type { Storage } from '../../storage/interface';
import Fuse from 'fuse.js';

export interface SearchableItem {
  type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'followup' | 'conversation';
  taskId: string;
  taskCode: string | null;
  taskGoal: string;
  content: string;
  context?: string;
}

function getMatchContext(content: string, matchStart: number, matchLength: number): string {
  const contextChars = 40;
  const start = Math.max(0, matchStart - contextChars);
  const end = Math.min(content.length, matchStart + matchLength + contextChars);

  let result = content.substring(start, end);
  result = result.replace(/\s+/g, ' ').trim();

  if (start > 0) result = '...' + result;
  if (end < content.length) result = result + '...';

  return result;
}

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

export async function getAllSearchableContent(storage: Storage): Promise<SearchableItem[]> {
  const items: SearchableItem[] = [];
  const tasks = await storage.listTasks();

  for (const task of tasks) {
    const taskContent = task.code ? `${task.code} ${task.goal}` : task.goal;
    items.push({
      type: 'task',
      taskId: task.id,
      taskCode: task.code,
      taskGoal: task.goal,
      content: taskContent,
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

  return items;
}

export function fuzzySearch(items: SearchableItem[], query: string): SearchResult[] {
  const fuse = new Fuse(items, {
    keys: ['content'],
    includeScore: true,
    includeMatches: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  const fuseResults = fuse.search(query);

  return fuseResults.map(result => {
    const item = result.item;
    const matchInfo = result.matches?.[0];

    let matchedContent = item.content;
    if (matchInfo && matchInfo.indices.length > 0) {
      const [start, end] = matchInfo.indices[0];
      matchedContent = getMatchContext(item.content, start, end - start + 1);
    } else {
      matchedContent = truncate(item.content, 100);
    }

    return {
      entity_type: item.type,
      entity_id: item.taskId,
      task_id: item.taskId,
      task_code: item.taskCode,
      task_goal: item.taskGoal,
      content: item.content,
      match_context: matchedContent,
    };
  });
}
