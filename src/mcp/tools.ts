/**
 * MCP tool definitions and handlers for the agent.
 *
 * Tools fall into two categories:
 *   - Migrated: lazy_search, lazy_show, lazy_create, lazy_comment, lazy_propose
 *     (replace former CLI commands that agents called via shell)
 *   - New: lazy_commit, lazy_status
 *     (new capabilities exposed only via MCP, not previously available as CLI commands)
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';
import type { McpTool, McpToolHandler } from './types';
import type { ModelName } from '../types';

// Re-use storage and helpers from existing CLI infrastructure
import { requireStorage, shortId, requireLazyRoot, MAX_TASK_CODE_LENGTH } from '../cli/helpers';
import type { Proposal } from '../cli/commands/propose';
import { getAllSearchableContent, isStructuredQuery, structuredSearch, QueryParseError } from '../search';
import { reconcileTasks } from '../utils/reconcile';
import { queryWait } from '../daemon/rpc-fallback';
import { generateRedoCode } from '../cli/commands/redo';

/**
 * Context passed to MCP tool handlers at registration time.
 * Provides the task ID and worktree path that the agent is operating on.
 *
 * For the builder, taskId may be empty — the builder operates at the project level,
 * not on a specific task. Tools that require a taskId (lazy_commit, lazy_status,
 * lazy_propose) are unavailable when taskId is empty.
 */
export interface McpToolContext {
  /** Full UUID of the current task (empty string for builder context) */
  taskId: string;
  /** Worktree path for git operations (repo root for builder context) */
  worktreePath: string;
}

// ---------------------------------------------------------------------------
// lazy_search
// ---------------------------------------------------------------------------

export const searchTool: McpTool = {
  name: 'lazy_search',
  description:
    'Search across tasks, prompts, conversation turns, commits, and comments ' +
    'in the lazy project. Returns structured results with task context. ' +
    'Use this to find rationale, decisions, and context from other tasks.\n\n' +
    'Use "offset" and "limit" to paginate through results. ' +
    'Response always includes "total" count of matching results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (regex pattern, case-insensitive)',
        minLength: 1,
      },
      fuzzy: {
        type: 'boolean',
        description: 'Use fuzzy matching instead of exact regex (typo-tolerant)',
      },
      filter: {
        type: 'string',
        description: 'Filter results to a specific type',
        enum: ['tasks', 'prompts', 'turns', 'commits', 'comments'],
      },
      offset: {
        type: 'number',
        description: 'Skip first N results (default: 0)',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 20)',
      },
    },
    required: ['query'],
  },
};

export function createSearchHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const query = args.query as string;
    const fuzzy = args.fuzzy as boolean | undefined;
    const filter = args.filter as string | undefined;
    const filterType = filter?.replace(/s$/, ''); // 'tasks' -> 'task'
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 20;

    const storage = await requireStorage();
    try {
      if (fuzzy) {
        // Fuzzy search: load all content and use fuse.js
        const { default: Fuse } = await import('fuse.js');
        let items = await getAllSearchableContent(storage);
        if (filterType) {
          items = items.filter(i => i.type === filterType);
        }

        const fuse = new Fuse(items, {
          keys: ['content'],
          threshold: 0.4,
          includeScore: true,
          includeMatches: true,
          ignoreLocation: true,
          minMatchCharLength: 2,
        });

        const allResults = fuse.search(query);
        const sliced = allResults.slice(offset, offset + limit);
        return {
          query,
          fuzzy: true,
          count: sliced.length,
          total: allResults.length,
          results: sliced.map(r => ({
            type: r.item.type,
            taskId: shortId(r.item.taskId),
            taskCode: r.item.taskCode,
            taskGoal: r.item.taskGoal,
            content: r.item.content.substring(0, 500),
            score: r.score,
          })),
        };
      } else if (isStructuredQuery(query)) {
        // Structured query: parse and evaluate against task data
        try {
          let results = await structuredSearch(storage, query);
          if (filterType) {
            results = results.filter(r => r.entity_type === filterType);
          }
          const sliced = results.slice(offset, offset + limit);

          return {
            query,
            fuzzy: false,
            count: sliced.length,
            total: results.length,
            results: sliced.map(r => ({
              type: r.entity_type,
              taskId: shortId(r.task_id),
              taskCode: r.task_code,
              taskGoal: r.task_goal,
              content: r.content.substring(0, 500),
              context: r.match_context?.substring(0, 200),
            })),
          };
        } catch (err) {
          if (err instanceof QueryParseError) {
            return { error: `Query parse error: ${err.message}` };
          }
          throw err;
        }
      } else {
        // Simple text/regex search via storage
        let results = await storage.search(query);
        if (filterType) {
          results = results.filter(r => r.entity_type === filterType);
        }
        const sliced = results.slice(offset, offset + limit);

        return {
          query,
          fuzzy: false,
          count: sliced.length,
          total: results.length,
          results: sliced.map(r => ({
            type: r.entity_type,
            taskId: shortId(r.task_id),
            taskCode: r.task_code,
            taskGoal: r.task_goal,
            content: r.content.substring(0, 500),
            context: r.match_context?.substring(0, 200),
          })),
        };
      }
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_show
// ---------------------------------------------------------------------------

export const showTool: McpTool = {
  name: 'lazy_show',
  description:
    'Show detailed information about a task including its goal, status, ' +
    'session details, conversation turns, commits, comments, and child tasks. ' +
    'Use this to understand context and decisions from other tasks.\n\n' +
    'Default response is a compact summary with counts. Use "sections" to ' +
    'drill down into specific data (turns, commits, comments, children). ' +
    'Use "offset" and "limit" to paginate within sections.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      sections: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['turns', 'commits', 'comments', 'children'],
        },
        description: 'Sections to include in full (e.g. ["turns", "commits"]). Without this, only counts are returned.',
      },
      offset: {
        type: 'number',
        description: 'Skip first N items in requested sections (default: 0)',
      },
      limit: {
        type: 'number',
        description: 'Max items to return per section (default: 20)',
      },
    },
    required: ['task_id'],
  },
};

export function createShowHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const sections = args.sections as string[] | undefined;
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 20;

    const sectionsSet = new Set(sections ?? []);

    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }

      const task = resolved.task;
      const session = await storage.getSessionByTaskId(task.id);

      // Always build compact summary
      const result: Record<string, unknown> = {
        id: shortId(task.id),
        code: task.code ?? null,
        goal: task.goal,
        status: task.status,
        model: task.model ?? null,
        created_at: new Date(task.created_at).toISOString(),
        parent_task_id: task.parent_task_id ? shortId(task.parent_task_id) : null,
      };

      // Include full prompt (bounded by design)
      const promptHistory = await storage.getPromptHistory(task.id);
      if (promptHistory.length > 0) {
        const latestPrompt = promptHistory[promptHistory.length - 1];
        result.prompt = latestPrompt.content;
      }

      // Session metadata + counts (always included when session exists)
      let allTurns: Awaited<ReturnType<typeof storage.getSessionTurns>> = [];
      let allCommits: Awaited<ReturnType<typeof storage.getSessionCommits>> = [];
      if (session) {
        allTurns = await storage.getSessionTurns(session.id);
        allCommits = await storage.getSessionCommits(session.id);

        result.turn_count = allTurns.length;
        result.commit_count = allCommits.length;
        result.session = {
          outcome: session.outcome,
          git_branch: session.git_branch,
          started_at: session.started_at ? new Date(session.started_at).toISOString() : null,
        };

        // Include latest turn in summary (untruncated) when not drilling into turns
        if (!sectionsSet.has('turns') && allTurns.length > 0) {
          const latest = allTurns[allTurns.length - 1];
          result.latest_turn = {
            sequence: latest.sequence,
            role: latest.role,
            content: latest.content,
            timestamp: new Date(latest.timestamp).toISOString(),
          };
        }
      } else {
        result.turn_count = 0;
        result.commit_count = 0;
      }

      // Comments and children counts (always included)
      const allComments = await storage.getTaskComments(task.id);
      const allChildren = await storage.getChildTasks(task.id);
      result.comment_count = allComments.length;
      result.children_count = allChildren.length;

      // Drill-down: include full section data when explicitly requested
      if (sectionsSet.has('turns') && allTurns.length > 0) {
        const sliced = allTurns.slice(offset, offset + limit);
        result.turns = sliced.map(t => ({
          sequence: t.sequence,
          role: t.role,
          content: t.content,
          timestamp: new Date(t.timestamp).toISOString(),
        }));
      }

      if (sectionsSet.has('commits') && allCommits.length > 0) {
        const sliced = allCommits.slice(offset, offset + limit);
        result.commits = sliced.map(c => ({
          sha: c.sha.substring(0, 7),
          message: c.message,
          status: c.status,
        }));
      }

      if (sectionsSet.has('comments') && allComments.length > 0) {
        const sliced = allComments.slice(offset, offset + limit);
        result.comments = sliced.map(c => ({
          content: c.content,
          created_at: new Date(c.created_at).toISOString(),
        }));
      }

      if (sectionsSet.has('children') && allChildren.length > 0) {
        const sliced = allChildren.slice(offset, offset + limit);
        result.children = sliced.map(c => ({
          id: shortId(c.id),
          code: c.code ?? null,
          goal: c.goal,
          status: c.status,
        }));
      }

      return result;
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_create
// ---------------------------------------------------------------------------

export const createTool: McpTool = {
  name: 'lazy_create',
  description:
    'Create a new task in the lazy project. Returns the created task ID. ' +
    'Use this when you identify work that should be tracked as a separate task.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Short description of the task goal',
        minLength: 1,
      },
      prompt: {
        type: 'string',
        description: 'Detailed task prompt/specification (optional)',
      },
      code: {
        type: 'string',
        description: `Human-readable task code (kebab-case with optional dots, 2-${MAX_TASK_CODE_LENGTH} chars, optional)`,
        pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$',
        minLength: 2,
        maxLength: MAX_TASK_CODE_LENGTH,
      },
      model: {
        type: 'string',
        description: 'Model to use for this task',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
      type: {
        type: 'string',
        description: 'Task type',
      },
      parent: {
        type: 'string',
        description: 'Parent task ID to create this as a child/variant task',
      },
    },
    required: ['goal'],
  },
};

export function createCreateHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const goal = args.goal as string;
    const prompt = args.prompt as string | undefined;
    const code = args.code as string | undefined;
    const model = args.model as string | undefined;
    const type = args.type as string | undefined;
    const parent = args.parent as string | undefined;

    const storage = await requireStorage();
    try {
      // Resolve parent task if specified
      let parentTaskId: string | undefined;
      if (parent) {
        const resolved = await storage.resolveTask(parent);
        if (!resolved.task) {
          throw new Error(`Parent task not found: ${parent}`);
        }
        parentTaskId = resolved.task.id;
      }

      const task = await storage.createTask(goal, parentTaskId, undefined, code, type);

      if (prompt) {
        await storage.updateTaskPrompt(task.id, prompt);
      }

      if (model) {
        await storage.updateTaskModel(task.id, model as ModelName);
      }

      return {
        id: shortId(task.id),
        full_id: task.id,
        goal: task.goal,
        status: task.status,
        code: task.code ?? null,
        model: model ?? null,
        parent_task_id: parentTaskId ? shortId(parentTaskId) : null,
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_comment
// ---------------------------------------------------------------------------

export const commentTool: McpTool = {
  name: 'lazy_comment',
  description:
    'Add a comment/annotation to a task. Comments are human-readable notes ' +
    'for context that does not fit in turns or prompts. Use this to leave ' +
    'observations or context about the work.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to comment on (short hex prefix or code). If omitted, comments on the current task.',
      },
      message: {
        type: 'string',
        description: 'Comment text',
        minLength: 1,
      },
    },
    required: ['message'],
  },
};

export function createCommentHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const message = args.message as string;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await requireStorage();
    try {
      let taskId: string;
      if (taskIdInput) {
        const resolved = await storage.resolveTask(taskIdInput);
        if (!resolved.task) {
          throw new Error(`Task not found: ${taskIdInput}`);
        }
        taskId = resolved.task.id;
      } else if (ctx.taskId) {
        taskId = ctx.taskId;
      } else {
        throw new Error('No task_id provided and no current task context. Specify a task_id explicitly.');
      }

      const comment = await storage.createComment(taskId, message, 'builder');

      return {
        id: shortId(comment.id),
        task_id: shortId(taskId),
        content: comment.content,
        created_at: new Date(comment.created_at).toISOString(),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_propose
// ---------------------------------------------------------------------------

export const proposeTool: McpTool = {
  name: 'lazy_propose',
  description:
    'Propose a follow-up task. Use this when you identify work that is out of ' +
    'scope for the current task but should be done later. Proposals are reviewed ' +
    'by the human during task review — they are NOT tasks yet. ' +
    'Do NOT just mention follow-up work in prose — use this tool instead.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Short description of the proposed task',
        minLength: 1,
      },
      code: {
        type: 'string',
        description: `Suggested task code (kebab-case identifier with optional dots, 2-${MAX_TASK_CODE_LENGTH} chars, optional)`,
        pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$',
        minLength: 2,
        maxLength: MAX_TASK_CODE_LENGTH,
      },
      prompt: {
        type: 'string',
        description: 'Detailed description/instructions for the proposed task (optional)',
      },
    },
    required: ['goal'],
  },
};

export function createProposeHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    if (!ctx.taskId) {
      throw new Error('lazy_propose requires a task context. This tool is not available in builder mode.');
    }

    const goal = args.goal as string;
    const code = args.code as string | undefined;
    const prompt = args.prompt as string | undefined;

    const storage = await requireStorage();
    try {
      // Create proposals directory using storage driver path
      const dir = join(storage.getTaskDir(ctx.taskId), 'proposals');
      mkdirSync(dir, { recursive: true });

      const proposal: Proposal = {
        id: randomUUID(),
        goal,
        code: code ?? '',
        prompt: prompt ?? '',
        created_at: Date.now(),
        source_turn: null,
        status: 'pending',
      };

      const filePath = join(dir, `${proposal.id}.json`);
      writeFileSync(filePath, JSON.stringify(proposal, null, 2) + '\n');

      return {
        proposal_id: shortId(proposal.id),
        task_id: shortId(ctx.taskId),
        goal: proposal.goal,
        code: proposal.code || null,
        status: 'pending',
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_commit
// ---------------------------------------------------------------------------

export const commitTool: McpTool = {
  name: 'lazy_commit',
  description:
    'Stage and commit changes in the worktree. Stages specified files (or all ' +
    'changes if no files specified) and creates a git commit with the given message. ' +
    'Returns the commit SHA and summary.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message',
        minLength: 1,
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of files to stage (default: all changed files)',
      },
    },
    required: ['message'],
  },
};

export function createCommitHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    if (!ctx.taskId) {
      throw new Error('lazy_commit requires a task context. This tool is not available in builder mode.');
    }

    const message = args.message as string;
    const files = args.files as string[] | undefined;

    const cwd = ctx.worktreePath;

    // Stage files
    if (files && files.length > 0) {
      const addResult = runGit(['add', ...files], { cwd });
      if (addResult.exitCode !== 0) {
        throw new Error(`git add failed: ${addResult.stderr}`);
      }
    } else {
      const addResult = runGit(['add', '-A'], { cwd });
      if (addResult.exitCode !== 0) {
        throw new Error(`git add failed: ${addResult.stderr}`);
      }
    }

    // Check if there's anything to commit
    const statusResult = runGit(['diff', '--cached', '--stat'], { cwd });
    const diffStat = statusResult.stdout;
    if (!diffStat) {
      return {
        committed: false,
        message: 'Nothing to commit (no staged changes)',
      };
    }

    // Commit
    const commitResult = runGit(['commit', '-m', message], { cwd });
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr}`);
    }

    // Get the commit SHA
    const shaResult = runGit(['rev-parse', 'HEAD'], { cwd });
    const sha = shaResult.stdout;

    // Count files changed from diffstat (last line is summary)
    const diffLines = diffStat.split('\n');
    const filesChanged = Math.max(0, diffLines.length - 1);

    return {
      committed: true,
      sha: sha.substring(0, 7),
      full_sha: sha,
      message,
      files_changed: filesChanged,
      diff_stat: diffStat,
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_status
// ---------------------------------------------------------------------------

export const statusTool: McpTool = {
  name: 'lazy_status',
  description:
    'Check the current status of the task and worktree. Returns task metadata, ' +
    'git status (branch, uncommitted changes, recent commits), and session info. ' +
    'Use this to understand the current state before making decisions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function createStatusHandler(ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const cwd = ctx.worktreePath;

    // Git status (may fail in builder container where git is not installed)
    let branch = '';
    let porcelain = '';
    let changedFiles = 0;
    let recentCommits = '';

    try {
      const branchResult = runGit(['branch', '--show-current'], { cwd });
      branch = branchResult.exitCode === 0 ? branchResult.stdout : '';

      const statusResult = runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd });
      porcelain = statusResult.exitCode === 0 ? statusResult.stdout : '';
      changedFiles = porcelain ? porcelain.split('\n').length : 0;

      const logResult = runGit(['log', '--oneline', '-5', '--no-color'], { cwd });
      recentCommits = logResult.exitCode === 0 ? logResult.stdout : '';
    } catch {
      // Git not available (e.g., minimal builder container) — skip git info
    }

    // Task info from storage
    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      const task = ctx.taskId ? await storage.getTask(ctx.taskId) : null;
      const session = task ? await storage.getSessionByTaskId(task.id) : null;
      let turnCount = 0;
      let commitCount = 0;
      if (session) {
        const turns = await storage.getSessionTurns(session.id);
        const commits = await storage.getSessionCommits(session.id);
        turnCount = turns.length;
        commitCount = commits.length;
      }

      return {
        task: task ? {
          id: shortId(task.id),
          code: task.code ?? null,
          goal: task.goal,
          status: task.status,
          model: task.model ?? null,
        } : null,
        session: session ? {
          turn_count: turnCount,
          commit_count: commitCount,
          git_branch: session.git_branch,
        } : null,
        worktree: {
          path: cwd,
          branch: branch || null,
          changed_files: changedFiles,
          uncommitted_changes: porcelain || null,
          recent_commits: recentCommits || null,
        },
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_conversations
// ---------------------------------------------------------------------------

export const conversationsTool: McpTool = {
  name: 'lazy_conversations',
  description:
    'List past builder conversations with timestamps and summaries. ' +
    'Use this to find previous builder sessions and their content.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function createConversationsHandler(_ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const storage = await requireStorage();
    try {
      const conversations = await storage.listConversations();

      return {
        count: conversations.length,
        conversations: conversations.map(c => ({
          session_id: c.sessionId,
          started_at: c.startedAt,
          ended_at: c.endedAt,
          summary: c.summary.substring(0, 200),
          user_messages: c.stats.userMessageCount,
          assistant_messages: c.stats.assistantMessageCount,
          total_tokens: c.stats.totalTokens,
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_conversation_search
// ---------------------------------------------------------------------------

export const conversationSearchTool: McpTool = {
  name: 'lazy_conversation_search',
  description:
    'Keyword search across past builder conversations. Returns matching ' +
    'excerpts with conversation IDs so you can read the full conversation ' +
    'with lazy_conversation_read.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (keyword or regex pattern)',
        minLength: 1,
      },
    },
    required: ['query'],
  },
};

export function createConversationSearchHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const query = args.query as string;
    const regex = new RegExp(query, 'i');

    const storage = await requireStorage();
    try {
      const conversations = await storage.listConversations();
      const hits: Array<{
        session_id: string;
        started_at: string | null;
        summary: string;
        matches: Array<{ role: string; excerpt: string }>;
      }> = [];

      for (const conv of conversations) {
        const matchingMessages: Array<{ role: string; excerpt: string }> = [];
        for (const msg of conv.messages) {
          if (regex.test(msg.text)) {
            // Extract a window around the match
            const idx = msg.text.search(regex);
            const start = Math.max(0, idx - 100);
            const end = Math.min(msg.text.length, idx + 300);
            matchingMessages.push({
              role: msg.role,
              excerpt: (start > 0 ? '...' : '') + msg.text.substring(start, end) + (end < msg.text.length ? '...' : ''),
            });
          }
        }

        if (matchingMessages.length > 0) {
          hits.push({
            session_id: conv.sessionId,
            started_at: conv.startedAt,
            summary: conv.summary.substring(0, 200),
            matches: matchingMessages.slice(0, 5), // limit matches per conversation
          });
        }
      }

      return {
        query,
        count: hits.length,
        results: hits.slice(0, 10),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_conversation_read
// ---------------------------------------------------------------------------

export const conversationReadTool: McpTool = {
  name: 'lazy_conversation_read',
  description:
    'Read a full past builder conversation by session ID. Returns all ' +
    'messages in the conversation. Use lazy_conversations to find session IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID of the conversation to read',
        minLength: 1,
      },
    },
    required: ['session_id'],
  },
};

export function createConversationReadHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const sessionId = args.session_id as string;

    const storage = await requireStorage();
    try {
      const conversation = await storage.loadConversation(sessionId);
      if (!conversation) {
        throw new Error(`Conversation not found: ${sessionId}`);
      }

      return {
        session_id: conversation.sessionId,
        started_at: conversation.startedAt,
        ended_at: conversation.endedAt,
        summary: conversation.summary,
        stats: conversation.stats,
        messages: conversation.messages.map(m => ({
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          model: m.model,
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Lifecycle tools: lazy_start, lazy_unblock, lazy_accept, lazy_reject, lazy_close
//
// These invoke the lazy CLI as a subprocess so all the complex orchestration
// logic (worktree creation, supervisor launch, merge, etc.) is reused.
//
// On the host: handlers execute locally via runLazyCliCommand.
// In the container: these handlers are never called — the proxy MCP server
// forwards tool calls to the host HTTP server which runs these handlers.
// ---------------------------------------------------------------------------

/**
 * Run a lazy CLI command and return the result.
 *
 * These handlers only run on the host side. In production, process.execPath
 * IS the compiled lazy binary. In dev mode, it's bun and we need to prepend
 * 'run' + the entry point.
 */
async function runLazyCliCommand(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const execPath = process.execPath;
  const execName = execPath.split('/').pop() ?? '';

  let cmd: string[];
  // HACK: In dev mode, process.execPath is bun, not the compiled lazy binary.
  // Detect this and prepend the entry point. Remove when we stop using bun run.
  if (execName === 'bun' || execName === 'bun.exe') {
    const entryPoint = join(import.meta.dir, '..', '..', 'src', 'index.ts');
    cmd = [execPath, 'run', entryPoint, ...args];
  } else {
    cmd = [execPath, ...args];
  }

  const proc = spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin ? new Blob([stdin]) : undefined,
    env: { ...process.env, LAZY_ACTOR: 'builder' },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

// --- lazy_start ---

export const startTool: McpTool = {
  name: 'lazy_start',
  description:
    'Start working on a task. Creates a worktree, git branch, and launches ' +
    'a supervisor to run the agent. The task must be in backlog or blocked status.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      model: {
        type: 'string',
        description: 'Model override for this run (optional)',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
    },
    required: ['task_id'],
  },
};

export function createStartHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const model = args.model as string | undefined;

    const cliArgs = ['start', taskId, '--yes'];
    if (model) {
      cliArgs.push('--model', model);
    }

    const result = await runLazyCliCommand(cliArgs, ctx.worktreePath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// --- lazy_unblock ---

export const unblockTool: McpTool = {
  name: 'lazy_unblock',
  description:
    'Give feedback to a blocked task and resume its agent. The feedback is ' +
    'injected into the agent\'s next prompt as human guidance.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      feedback: {
        type: 'string',
        description: 'Feedback message for the agent',
        minLength: 1,
      },
      model: {
        type: 'string',
        description: 'Model override for this turn (optional)',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
    },
    required: ['task_id', 'feedback'],
  },
};

export function createUnblockHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const feedback = args.feedback as string;
    const model = args.model as string | undefined;

    const cliArgs = ['unblock', taskId];
    if (model) {
      cliArgs.push('--model', model);
    }

    // Pipe feedback via stdin
    const result = await runLazyCliCommand(
      cliArgs,
      ctx.worktreePath,
      feedback,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to unblock task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// --- lazy_accept ---

export const acceptTool: McpTool = {
  name: 'lazy_accept',
  description:
    'Accept a task\'s work and merge it into the parent branch. The task ' +
    'must be in blocked status with at least one commit.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      reason: {
        type: 'string',
        description: 'Reason for accepting (optional)',
      },
    },
    required: ['task_id'],
  },
};

export function createAcceptHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;

    const cliArgs = ['accept', taskId, '--yes'];
    if (reason) {
      cliArgs.push('--reason', reason);
    }

    const result = await runLazyCliCommand(cliArgs, ctx.worktreePath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to accept task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// --- lazy_reject ---

export const rejectTool: McpTool = {
  name: 'lazy_reject',
  description:
    'Reject a task\'s work and send it back for rework. Optionally provide ' +
    'a reason that will be shown to the agent on the next turn.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      reason: {
        type: 'string',
        description: 'Reason for rejecting (feedback for the agent)',
      },
    },
    required: ['task_id'],
  },
};

export function createRejectHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;

    const cliArgs = ['reject', taskId, '--yes'];
    if (reason) {
      cliArgs.push('--reason', reason);
    }

    const result = await runLazyCliCommand(cliArgs, ctx.worktreePath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to reject task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// --- lazy_close ---

export const closeTool: McpTool = {
  name: 'lazy_close',
  description:
    'Close (abandon) a task. The task\'s branch and worktree are cleaned up. ' +
    'A reason is required to explain why the task is being closed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      reason: {
        type: 'string',
        description: 'Reason for closing (required)',
        minLength: 1,
      },
    },
    required: ['task_id', 'reason'],
  },
};

export function createCloseHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;

    const cliArgs = ['close', taskId, '--yes'];
    if (reason) {
      cliArgs.push('--reason', reason);
    }

    const result = await runLazyCliCommand(cliArgs, ctx.worktreePath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to close task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// --- lazy_resume ---

export const resumeTool: McpTool = {
  name: 'lazy_resume',
  description:
    'Resume a blocked task without providing new feedback. Re-launches the ' +
    'agent with the existing prompt and context.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      model: {
        type: 'string',
        description: 'Model override for this run (optional)',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
    },
    required: ['task_id'],
  },
};

export function createResumeHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const model = args.model as string | undefined;

    const cliArgs = ['resume', taskId];
    if (model) {
      cliArgs.push('--model', model);
    }

    const result = await runLazyCliCommand(
      cliArgs,
      ctx.worktreePath,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to resume task: ${(result.stderr || result.stdout).trim()}`);
    }

    return { output: result.stdout.trim() };
  };
}

// ---------------------------------------------------------------------------
// lazy_list
// ---------------------------------------------------------------------------

export const listTool: McpTool = {
  name: 'lazy_list',
  description:
    'List tasks in the lazy project. By default shows non-terminal tasks. ' +
    'Use "all" to include completed/closed tasks. Use "task_id" to filter ' +
    'children of a specific task.',
  inputSchema: {
    type: 'object',
    properties: {
      all: {
        type: 'boolean',
        description: 'Include terminal tasks (complete, abandoned, closed)',
      },
      task_id: {
        type: 'string',
        description: 'Filter to children of this task (short hex prefix or code)',
      },
    },
  },
};

export function createListHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const showAll = args.all as boolean | undefined;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      let tasks;
      if (taskIdInput) {
        const resolved = await storage.resolveTask(taskIdInput);
        if (!resolved.task) {
          throw new Error(`Task not found: ${taskIdInput}`);
        }
        tasks = await storage.getChildTasks(resolved.task.id);
      } else if (showAll) {
        tasks = await storage.listTasks();
      } else {
        tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
      }

      return {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          status: t.status,
          model: t.model ?? null,
          parent_task_id: t.parent_task_id ? shortId(t.parent_task_id) : null,
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_blocked
// ---------------------------------------------------------------------------

export const blockedTool: McpTool = {
  name: 'lazy_blocked',
  description:
    'List blocked tasks ready for review. These are tasks waiting for ' +
    'human feedback before they can continue.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function createBlockedHandler(_ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      const tasks = await storage.listTasksWithOptions({ blockedOnly: true });

      return {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          model: t.model ?? null,
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_active
// ---------------------------------------------------------------------------

export const activeTool: McpTool = {
  name: 'lazy_active',
  description:
    'List tasks with running sessions (status: working). These are tasks ' +
    'currently being worked on by agents.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function createActiveHandler(_ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      const tasks = await storage.listTasksWithOptions({ workingOnly: true });

      return {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          model: t.model ?? null,
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_diff
// ---------------------------------------------------------------------------

export const diffTool: McpTool = {
  name: 'lazy_diff',
  description:
    'Show changes made by a task. Returns a diff stat summary by default, ' +
    'or the full diff with "full" flag. Use "files" to filter to specific ' +
    'paths and "max_lines" to truncate output.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or code)',
        minLength: 1,
      },
      full: {
        type: 'boolean',
        description: 'Show full diff instead of just stat summary',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter diff to specific file paths only',
      },
      max_lines: {
        type: 'number',
        description: 'Truncate diff output to N lines. Response includes truncated flag and total_lines.',
      },
    },
    required: ['task_id'],
  },
};

export function createDiffHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const full = args.full as boolean | undefined;
    const files = args.files as string[] | undefined;
    const maxLines = args.max_lines as number | undefined;

    const storage = await requireStorage();
    try {
      // Reconcile tasks before reading state to ensure current status
      const lazyRoot = requireLazyRoot();
      await reconcileTasks(storage, lazyRoot);

      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const task = resolved.task;

      const session = await storage.getSessionByTaskId(task.id);
      if (!session) {
        throw new Error(`Task ${taskIdInput} has no session (not started yet)`);
      }

      // Find the task's worktree by convention; fall back to main repo if worktree is gone
      const storagePath = storage.getStoragePath();
      const worktreePath = join(storagePath, 'worktrees', session.git_branch.replace('lazy/', ''));
      const worktreeExists = existsSync(worktreePath);
      const diffCwd = worktreeExists ? worktreePath : lazyRoot;
      if (!worktreeExists) {
        logger.warn(`lazy_diff: worktree gone for task ${taskIdInput}, falling back to main repo`);
      }

      // Determine the diff range.
      // Prefer three-dot diff against parent branch — this automatically finds the
      // merge-base and shows only what the task itself changed, excluding upstream
      // merges. Fall back to two-dot from upstream_merge_sha or git_start_sha when
      // the parent branch ref is unavailable (e.g., deleted after accept).
      const parentBranch = task.parent_task_id
        ? (await storage.getSessionByTaskId(task.parent_task_id))?.git_branch ?? 'main'
        : 'main';

      let diffRange: string;
      if (worktreeExists) {
        const branchCheck = runGit(
          ['rev-parse', '--verify', parentBranch],
          { cwd: diffCwd },
        );
        if (branchCheck.exitCode === 0) {
          // Parent branch exists — three-dot diff (most reliable)
          diffRange = `${parentBranch}...HEAD`;
        } else if (session.upstream_merge_sha) {
          // Parent branch gone but we have the upstream SHA — two-dot diff
          diffRange = `${session.upstream_merge_sha}..HEAD`;
        } else {
          // Last resort: two-dot from session start
          diffRange = `${session.git_start_sha}..HEAD`;
        }
      } else {
        // No worktree — use branch ref directly against parent in main repo
        const branchRef = session.git_branch;
        const branchCheck = runGit(
          ['rev-parse', '--verify', branchRef],
          { cwd: diffCwd },
        );
        if (branchCheck.exitCode !== 0) {
          logger.warn(`lazy_diff: branch '${branchRef}' not found in main repo for task ${taskIdInput}`);
          throw new Error(`Worktree is gone and branch '${branchRef}' not found in main repo`);
        }
        diffRange = `${parentBranch}...${branchRef}`;
      }

      const diffArgs = full
        ? ['diff', diffRange]
        : ['diff', '--stat', diffRange];

      // Append file pathspecs after a -- separator
      if (files && files.length > 0) {
        diffArgs.push('--', ...files);
      }

      const diffResult = runGit(diffArgs, {
        cwd: diffCwd,
      });

      if (diffResult.exitCode !== 0) {
        throw new Error(`git diff failed: ${diffResult.stderr}`);
      }

      let diffOutput = diffResult.stdout;
      const result: Record<string, unknown> = {
        task_id: shortId(task.id),
        diff_range: diffRange,
        full: !!full,
      };

      // Apply max_lines truncation
      if (maxLines !== undefined && maxLines > 0) {
        const lines = diffOutput.split('\n');
        result.total_lines = lines.length;
        if (lines.length > maxLines) {
          diffOutput = lines.slice(0, maxLines).join('\n');
          result.truncated = true;
        } else {
          result.truncated = false;
        }
      }

      result.diff = diffOutput;
      return result;
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_wait
// ---------------------------------------------------------------------------

export const waitTool: McpTool = {
  name: 'lazy_wait',
  description:
    'Wait for a task to finish its current turn. Polls until the task ' +
    'leaves "working" status or timeout is reached.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or code)',
        minLength: 1,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 600, max: 600)',
      },
    },
    required: ['task_id'],
  },
};

export function createWaitHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const timeoutSecs = Math.min((args.timeout as number | undefined) ?? 600, 600);

    const result = await queryWait({ taskId: taskIdInput, timeout: timeoutSecs });

    return {
      task_id: shortId(result.task_id),
      status: result.status,
      timed_out: result.timed_out,
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_edit
// ---------------------------------------------------------------------------

export const editTool: McpTool = {
  name: 'lazy_edit',
  description:
    'Edit a task\'s goal, prompt, model, type, code, or parent. ' +
    'Only works on tasks that have not been started by an agent (no turns).',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or code)',
        minLength: 1,
      },
      goal: {
        type: 'string',
        description: 'New goal text',
      },
      prompt: {
        type: 'string',
        description: 'New prompt text',
      },
      model: {
        type: 'string',
        description: 'New model',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
      type: {
        type: 'string',
        description: 'New task type',
      },
      code: {
        type: 'string',
        description: 'New task code (pass empty string to clear)',
      },
      parent: {
        type: 'string',
        description: 'New parent task ID (pass empty string to clear)',
      },
    },
    required: ['task_id'],
  },
};

export function createEditHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const goal = args.goal as string | undefined;
    const prompt = args.prompt as string | undefined;
    const model = args.model as string | undefined;
    const type = args.type as string | undefined;
    const code = args.code as string | undefined;
    const parent = args.parent as string | undefined;

    const storage = await requireStorage();
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const task = resolved.task;

      // Check terminal status
      const terminalStatuses = new Set(['complete', 'abandoned', 'closed']);
      if (terminalStatuses.has(task.status)) {
        throw new Error(`Cannot edit task in ${task.status} status`);
      }

      // Check no turns (agent hasn't started working)
      const turnCount = await storage.getTurnCountByTaskId(task.id);
      if (turnCount > 0) {
        throw new Error('Cannot edit task after agent has started working (has turns)');
      }

      const changes: string[] = [];

      if (goal !== undefined) {
        await storage.updateTaskGoal(task.id, goal);
        changes.push('goal');
      }

      if (prompt !== undefined) {
        await storage.updateTaskPrompt(task.id, prompt);
        changes.push('prompt');
      }

      if (model !== undefined) {
        await storage.updateTaskModel(task.id, model);
        changes.push('model');
      }

      if (type !== undefined) {
        await storage.updateTaskType(task.id, type);
        changes.push('type');
      }

      if (code !== undefined) {
        await storage.updateTaskCode(task.id, code || null);
        changes.push('code');
      }

      if (parent !== undefined) {
        if (parent === '') {
          await storage.updateTaskParent(task.id, null);
        } else {
          const parentResolved = await storage.resolveTask(parent);
          if (!parentResolved.task) {
            throw new Error(`Parent task not found: ${parent}`);
          }
          await storage.updateTaskParent(task.id, parentResolved.task.id);
        }
        changes.push('parent');
      }

      if (changes.length === 0) {
        return { task_id: shortId(task.id), changes: [], message: 'No changes specified' };
      }

      return {
        task_id: shortId(task.id),
        changes,
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_clone
// ---------------------------------------------------------------------------

export const cloneTool: McpTool = {
  name: 'lazy_clone',
  description:
    'Create a variant (child) of an existing task. The new task inherits ' +
    'the parent\'s goal and prompt. Does NOT auto-start — call lazy_start ' +
    'separately to begin work on the variant.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Parent task ID (short hex prefix or code)',
        minLength: 1,
      },
      goal: {
        type: 'string',
        description: 'Override goal for the variant (default: parent goal + " (variant)")',
      },
      prompt: {
        type: 'string',
        description: 'Override prompt for the variant (default: inherit parent prompt)',
      },
      code: {
        type: 'string',
        description: 'Human-readable code for the variant',
      },
      model: {
        type: 'string',
        description: 'Override model',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
    },
    required: ['task_id'],
  },
};

export function createCloneHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const goalOverride = args.goal as string | undefined;
    const promptOverride = args.prompt as string | undefined;
    const code = args.code as string | undefined;
    const model = args.model as string | undefined;

    const storage = await requireStorage();
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const parent = resolved.task;

      const goal = goalOverride ?? `${parent.goal} (variant)`;

      // Create child task
      const child = await storage.createTask(goal, parent.id, undefined, code);

      // Set prompt (inherit from parent or use override)
      if (promptOverride) {
        await storage.updateTaskPrompt(child.id, promptOverride);
      } else {
        const parentPromptHistory = await storage.getPromptHistory(parent.id);
        if (parentPromptHistory.length > 0) {
          const latestPrompt = parentPromptHistory[parentPromptHistory.length - 1];
          await storage.updateTaskPrompt(child.id, latestPrompt.content);
        }
      }

      if (model) {
        await storage.updateTaskModel(child.id, model);
      } else if (parent.model) {
        await storage.updateTaskModel(child.id, parent.model);
      }

      return {
        id: shortId(child.id),
        parent_id: shortId(parent.id),
        goal: child.goal,
        code: child.code ?? null,
        status: child.status,
        message: 'Variant created. Call lazy_start to begin work.',
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_reopen
// ---------------------------------------------------------------------------

export const reopenTool: McpTool = {
  name: 'lazy_reopen',
  description:
    'Reopen a previously rejected, closed, or completed task. Restores ' +
    'the task to blocked (if it had a session) or backlog status. ' +
    'Does NOT recreate worktrees — call lazy_start to set up the worktree.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or code)',
        minLength: 1,
      },
      reason: {
        type: 'string',
        description: 'Reason for reopening (required for completed tasks)',
      },
    },
    required: ['task_id'],
  },
};

export function createReopenHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const reason = args.reason as string | undefined;

    const storage = await requireStorage();
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const task = resolved.task;

      const terminalStatuses = new Set(['complete', 'abandoned', 'closed']);
      if (!terminalStatuses.has(task.status)) {
        throw new Error(`Task is in ${task.status} status — can only reopen terminal tasks`);
      }

      if (task.status === 'complete' && !reason) {
        throw new Error('A reason is required to reopen a completed task');
      }

      // Record reason as a comment if provided
      if (reason) {
        await storage.createComment(task.id, `[Reopened] ${reason}`, 'builder');
      }

      await storage.reopenTask(task.id, 'builder');

      // Determine new status: blocked if task had a session, backlog otherwise
      const session = await storage.getSessionByTaskId(task.id);
      const newStatus = session ? 'blocked' : 'backlog';
      await storage.updateTaskStatus(task.id, newStatus, 'builder');

      // Reset session if one exists
      if (session) {
        await storage.resetSession(session.id);
      }

      return {
        task_id: shortId(task.id),
        previous_status: task.status,
        new_status: newStatus,
        message: session
          ? 'Task reopened. Call lazy_start to set up the worktree and resume.'
          : 'Task reopened in backlog. Call lazy_start to begin work.',
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_redo
// ---------------------------------------------------------------------------

export const redoTool: McpTool = {
  name: 'lazy_redo',
  description:
    'Close a stale task and create a fresh replacement starting from current ' +
    'main. Carries over goal and prompt. Does NOT auto-start — call lazy_start ' +
    'on the new task to begin work.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID of the stale task to redo (short hex prefix or code)',
        minLength: 1,
      },
      prompt: {
        type: 'string',
        description: 'Override prompt for the new task (default: inherit from old task)',
      },
      model: {
        type: 'string',
        description: 'Override model for the new task',
        enum: ['apprentice', 'journeyman', 'master', 'sonnet', 'opus', 'haiku'],
      },
    },
    required: ['task_id'],
  },
};

export function createRedoHandler(_ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const promptOverride = args.prompt as string | undefined;
    const model = args.model as string | undefined;

    const storage = await requireStorage();
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const oldTask = resolved.task;

      // Cannot redo completed (merged) or closed tasks
      if (oldTask.status === 'complete') {
        throw new Error('Cannot redo a completed (merged) task');
      }
      if (oldTask.status === 'closed') {
        throw new Error('Cannot redo a closed task');
      }

      // Generate a redo code using the old task's code (or fall back to task ID)
      const baseCode = oldTask.code ?? shortId(oldTask.id);
      const redoCode = await generateRedoCode(baseCode, storage);

      // Get old prompt
      let prompt = promptOverride;
      if (!prompt) {
        const promptHistory = await storage.getPromptHistory(oldTask.id);
        if (promptHistory.length > 0) {
          prompt = promptHistory[promptHistory.length - 1].content;
        }
      }

      // Create new task
      const newTask = await storage.createTask(
        oldTask.goal,
        oldTask.parent_task_id ?? undefined,
        undefined,
        redoCode || undefined,
      );

      if (prompt) {
        await storage.updateTaskPrompt(newTask.id, prompt);
      }

      const taskModel = model ?? oldTask.model;
      if (taskModel) {
        await storage.updateTaskModel(newTask.id, taskModel);
      }

      // Link new task to old via metadata
      await storage.updateTaskMetadata(newTask.id, 'redo_of', shortId(oldTask.id));

      // Close the old task
      await storage.closeTask(oldTask.id, `Redone as ${shortId(newTask.id)}`, 'builder');
      await storage.updateTaskStatus(oldTask.id, 'closed', 'builder');

      return {
        old_task_id: shortId(oldTask.id),
        new_task_id: shortId(newTask.id),
        new_task_code: newTask.code ?? null,
        goal: newTask.goal,
        status: newTask.status,
        message: 'New task created. Call lazy_start to begin work.',
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * All tool definitions for registration.
 */
export const allTools: McpTool[] = [
  searchTool,
  showTool,
  createTool,
  commentTool,
  proposeTool,
  commitTool,
  statusTool,
  conversationsTool,
  conversationSearchTool,
  conversationReadTool,
  startTool,
  unblockTool,
  acceptTool,
  rejectTool,
  closeTool,
  resumeTool,
  listTool,
  blockedTool,
  activeTool,
  diffTool,
  waitTool,
  editTool,
  cloneTool,
  reopenTool,
  redoTool,
];

/**
 * Create all tool handlers with the given context.
 */
export function createAllHandlers(ctx: McpToolContext): Map<string, McpToolHandler> {
  const handlers = new Map<string, McpToolHandler>();
  handlers.set('lazy_search', createSearchHandler(ctx));
  handlers.set('lazy_show', createShowHandler(ctx));
  handlers.set('lazy_create', createCreateHandler(ctx));
  handlers.set('lazy_comment', createCommentHandler(ctx));
  handlers.set('lazy_propose', createProposeHandler(ctx));
  handlers.set('lazy_commit', createCommitHandler(ctx));
  handlers.set('lazy_status', createStatusHandler(ctx));
  handlers.set('lazy_conversations', createConversationsHandler(ctx));
  handlers.set('lazy_conversation_search', createConversationSearchHandler(ctx));
  handlers.set('lazy_conversation_read', createConversationReadHandler(ctx));
  handlers.set('lazy_start', createStartHandler(ctx));
  handlers.set('lazy_unblock', createUnblockHandler(ctx));
  handlers.set('lazy_accept', createAcceptHandler(ctx));
  handlers.set('lazy_reject', createRejectHandler(ctx));
  handlers.set('lazy_close', createCloseHandler(ctx));
  handlers.set('lazy_resume', createResumeHandler(ctx));
  handlers.set('lazy_list', createListHandler(ctx));
  handlers.set('lazy_blocked', createBlockedHandler(ctx));
  handlers.set('lazy_active', createActiveHandler(ctx));
  handlers.set('lazy_diff', createDiffHandler(ctx));
  handlers.set('lazy_wait', createWaitHandler(ctx));
  handlers.set('lazy_edit', createEditHandler(ctx));
  handlers.set('lazy_clone', createCloneHandler(ctx));
  handlers.set('lazy_reopen', createReopenHandler(ctx));
  handlers.set('lazy_redo', createRedoHandler(ctx));
  return handlers;
}
