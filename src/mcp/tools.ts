/**
 * MCP tool definitions and handlers for the agent.
 *
 * Tools fall into two categories:
 *   - Migrated: lazy_search, lazy_show, lazy_create, lazy_comment
 *     (replace former CLI commands that agents called via shell)
 *   - New: lazy_commit, lazy_status
 *     (new capabilities exposed only via MCP, not previously available as CLI commands)
 *
 * Agent ownership boundary: when a tool handler runs with a non-empty ctx.taskId,
 * the caller is an agent acting on its own task. EVERY task-targeting tool an
 * agent can reach enforces — server-side — that the target is the agent's OWN
 * task or a DIRECT subtask of it:
 *   - create/start subtasks (lazy_create is constrained to a direct child;
 *     lazy_start to a direct child);
 *   - review/iterate/complete a subtask (show, diff, wait, unblock, reject,
 *     close, edit, stop, submit, resume, ask, sync, reopen) — each gated
 *     via assertAgentMayTarget / gateAgentTarget (own task or direct child);
 *   - accept a subtask — gated more tightly still, via
 *     assertAgentMayTargetChildOnly: a DIRECT CHILD ONLY, never the agent's own
 *     task. Accepting a child merges the child's work into the agent's own
 *     branch (a human reviews it later, when the agent's task is accepted);
 *     accepting itself would complete the agent's task and merge it upward
 *     unreviewed.
 *   - lazy_edit additionally refuses to change a task's parent (the reparent
 *     backdoor).
 * Tools that MANUFACTURE a task whose parent the agent cannot constrain to its
 * own subtree are out of the agent surface entirely: lazy_reparent, lazy_clone
 * (clone parents under the source), and lazy_redo (replacement parents under the
 * original's parent). Agents create new work only via lazy_create.
 *
 * This is real, daemon-side friction enforced from the caller's task identity,
 * independent of prompt guidance — it keeps a well-behaved agent inside its own
 * subtree. It is NOT a cryptographic sandbox: an agent with shell access in its
 * container has other routes (that broader isolation is the runner's job, not
 * this gate's). The goal here is a clear, enforced ownership contract at the MCP
 * boundary, not airtight containment.
 */

import { join } from 'path';
import { MCP_ACTOR, AGENT_ACTOR } from '../constants';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import { readWorktreeMergeState, isMidMerge, describeMergeState } from '../git/operations';
import type { McpTool, McpToolHandler } from './types';
import { protocolDir as taskProtocolDir } from '../protocol/io';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import type { Turn } from '../types';

/**
 * Ask-mode read-only guard for write-capable MCP tools.
 *
 * When the supervisor runs an ask turn, it sets LAZY_MCP_READ_ONLY=1 on the
 * agent process so MCP write tools (lazy_commit, lazy_comment) reject any
 * attempted call. This is the last line of defense if the agent
 * ignores the system prompt and the --disallowedTools lockdown.
 *
 * The error message must be actionable — tell the agent what to do instead
 * (write the answer as text) so a competent model corrects course in the
 * same turn.
 */
function rejectIfReadOnly(toolName: string): void {
  if (process.env.LAZY_MCP_READ_ONLY === '1') {
    throw new Error(
      `${toolName} is not available in ask mode — your final message is the answer. ` +
      `Write it directly as text; do not call any tools.`,
    );
  }
}


// Re-use storage and helpers from existing CLI infrastructure
import { requireStorage, shortId, requireLazyRoot, MAX_TASK_CODE_LENGTH, getWorktreePathForRef, taskRef } from '../cli/helpers';
import { INTERNAL_GIT_TOOL_NAME, createInternalGitHandler } from './internal-git';
import type { Storage, SearchResult } from '../storage';
import type { Task, TaskTarget, TaskPriority } from '../types';
import { VALID_TASK_PRIORITIES } from '../types';
import { type RunnerType, resolveRunnerType, RUNNER_ALIAS_HINT, VALID_EFFORT_LEVELS, type EffortLevel } from '../config/types';
import { listAgents } from '../agent/registry';
import { resolveAgentForNewTask } from '../agent/task-agent';
import { createRunner } from '../runner';
import type { Runner } from '../runner';
import { computeWorkingSubstate, formatWorkingSubstate, readSupervisorStatusAsync } from '../utils/working-substate';
import { MAX_PROGRESS_MESSAGE_LENGTH } from '../protocol/progress';
import { recordProgress } from '../daemon/progress-registry';
import { formatRetrySummary } from '../utils/retry-summary';
import { parentTaskIdOf, taskTarget, branchTarget, targetBranchOf, pruneTasksToDepth } from '../task-target';
import { loadConfig } from '../config/loader';
import { resolveEdgeGateDecision, peekHumanApproval } from '../protection/edge-gate';
import { loadTaskProtectionStatus, protectionSummary, protectionToJson } from '../protection/status';
import { getAllSearchableContent, FUZZY_SEARCH_OPTIONS, isStructuredQuery, structuredSearch, buildTagHint, QueryParseError } from '../search';
import { orderQueuedTasks } from '../daemon/concurrency';
// Argument errors raised inside a handler must carry a status, or the MCP route
// reports them as 500 — see httpStatusForError in ../daemon/mcp-routes.
import { RpcError, filterToSubtree } from '../daemon/rpc-handlers';

import {
  queryWait,
  queryStartTask,
  queryUnblockTask,
  queryAskTask,
  queryAcceptTask,
  queryRejectTask,
  queryCloseTask,
  queryStopTask,
  querySubmitTask,
  querySyncTask,
  queryReparentTask,
  queryDiff,
} from '../daemon/rpc-fallback';
import { generateRedoCode } from '../cli/commands/redo';
import { sanitizeUserText } from '../utils/sanitize-text';
import { generateCode, storePending, validateCode, renderGuidance } from './confirmation';
import {
  acceptConfirmationLevel,
  rejectConfirmationLevel,
  closeConfirmationLevel,
  redoConfirmationLevel,
  reopenConfirmationLevel,
  createConfirmationLevel,
  gatherAcceptContext,
  gatherRejectContext,
  gatherCloseContext,
  gatherRedoContext,
  gatherReopenContext,
  gatherCreateParentWarningContext,
  gatherCreateParentWarningSternContext,
  type DiffStat,
} from './confirmation-context';

// Lifecycle parameter types. The lifecycle operations themselves are invoked
// through the query* RPC-fallback layer (see ../daemon/rpc-fallback), NOT by
// calling the daemon functions directly: a direct call obtains storage via
// getOrCreateStorage(), which only works inside the daemon process. Routing
// through query*/tryRpc forwards to the daemon over RPC when this handler runs
// in a builder/pairing process and falls back to the direct daemon function
// under LAZY_IS_DAEMON=1 / LAZY_TEST=1 — without spawning a lazy subprocess.
import { type StartTaskParams } from '../daemon/task-launcher';
import { turnText } from '../utils/turn-content';
import { pendingViolations, violationRecords } from '../utils/turns';
import {
  type UnblockTaskParams,
  type AskTaskParams,
  type RejectTaskParams,
  type CloseTaskParams,
  type StopTaskParams,
  type AcceptTaskParams,
  type SyncTaskParams,
  type ReparentTaskParams,
  type SubmitTaskParams,
} from '../daemon/task-lifecycle';

/**
 * Context passed to MCP tool handlers at registration time.
 * Provides the task ID and worktree path that the agent is operating on.
 *
 * For the builder, taskId may be empty — the builder operates at the project level,
 * not on a specific task. Tools that require a taskId (lazy_commit) are unavailable
 * when taskId is empty.
 *
 * The taskId is also the agent-ownership signal: a non-empty taskId means the call
 * comes from an agent acting on its OWN task. lazy_create / lazy_start / lazy_reparent
 * use this to enforce that agents may only create and start subtasks of their own
 * task, and may never reparent. See createCreateHandler / createStartHandler /
 * createReparentHandler.
 */
export interface McpToolContext {
  /** Full UUID of the current task (empty string for builder context) */
  taskId: string;
  /** Worktree path for git operations (repo root for builder context) */
  worktreePath: string;
  /**
   * Optional storage instance. When running inside the daemon process,
   * this is the daemon's long-lived storage singleton. When undefined,
   * handlers fall back to requireStorage().
   */
  storage?: import('../storage').Storage;
  /**
   * Optional phase-progress sink. Set when the call arrived over the daemon's
   * heartbeat-framed MCP route: long tools (accept) narrate their phases into
   * it and the frames travel back to the client as `notifications/progress`.
   * Undefined everywhere else — narration is strictly observational.
   */
  progress?: import('../daemon/progress').ProgressEmitter;
}

/**
 * Get storage from context or fall back to requireStorage().
 *
 * When MCP handlers run inside the daemon process, ctx.storage is the daemon's
 * long-lived singleton. When handlers run in host-process-runner mode (local
 * execution), ctx.storage is undefined and we fall back to requireStorage()
 * which creates a RemoteStorage proxy to the daemon.
 */
async function getStorage(ctx: McpToolContext): Promise<Storage> {
  if (ctx.storage) {
    return ctx.storage;
  }
  return requireStorage();
}

/**
 * Agent ownership gate for task-targeting MCP tools.
 *
 * When ctx.taskId is non-empty the caller is an agent acting on its own task; it
 * may only target its OWN task or a DIRECT child of it (a subtask it owns). Any
 * other task is rejected with an actionable message. The builder (ctx.taskId ===
 * '') is unrestricted and this is a no-op.
 *
 * Call this once the target Task has been resolved. It is the shared enforcement
 * point behind lazy_show / lazy_diff / lazy_wait / lazy_unblock / lazy_accept /
 * lazy_reject / lazy_close / lazy_edit so an agent can run its OWN subtasks
 * end-to-end (create → start → wait → review → unblock → accept) without reaching
 * outside its subtree.
 */
function assertAgentMayTarget(ctx: McpToolContext, task: Task, action: string): void {
  if (!ctx.taskId) return; // builder: unrestricted
  if (task.id === ctx.taskId) return; // the agent's own task
  if (parentTaskIdOf(task) === ctx.taskId) return; // a direct subtask of the agent's task
  throw new Error(
    `Agents may only ${action} their own task or its direct subtasks. ` +
    `Task '${shortId(task.id)}' is neither your current task nor one of its children. ` +
    `Use lazy_create to spin off a subtask of your own task instead.`,
  );
}

/**
 * Agent ownership gate for tools an agent may run ONLY on a DIRECT SUBTASK —
 * never on its own task.
 *
 * `lazy_accept` is the one such tool today. Accepting means "merge this work
 * into the parent branch and complete the task": on a subtask that lands the
 * child's work on the agent's own branch, which a human still reviews later. On
 * the agent's OWN task it would merge the agent's work into ITS parent and mark
 * the task complete — the agent grading its own homework and skipping the review
 * it exists to be subject to. That is refused server-side, not by prompt.
 *
 * `lazy_unblock` deliberately stays on the looser gate above: iterating on a
 * subtask (or being told to iterate on its own task) merges nothing and
 * completes nothing, so the review boundary is untouched. That keeps the whole
 * self-orchestration loop — create → start → wait → show/diff → unblock →
 * accept — reachable without widening what an agent can land.
 */
function assertAgentMayTargetChildOnly(ctx: McpToolContext, task: Task, action: string): void {
  if (!ctx.taskId) return; // builder: unrestricted
  if (parentTaskIdOf(task) === ctx.taskId) return; // a direct subtask of the agent's task
  if (task.id === ctx.taskId) {
    throw new Error(
      `Agents may not ${action} their own task — that is the human's (or builder's) review decision. ` +
      `You may only ${action} a direct subtask you created with lazy_create. ` +
      `Finish your work, commit it, and end your turn; your task is reviewed from outside.`,
    );
  }
  throw new Error(
    `Agents may only ${action} their own direct subtasks. ` +
    `Task '${shortId(task.id)}' is not a child of your current task. ` +
    `Use lazy_create to spin off a subtask of your own task instead.`,
  );
}

/**
 * The actor to record for a command arriving over the MCP channel.
 *
 * Same channel, two callers, told apart by scope: a non-empty ctx.taskId means a
 * TASK AGENT acting inside its own subtree (→ 'agent'); an empty one means the
 * builder driving the project (→ 'builder'). Neither is 'human' — see MCP_ACTOR.
 */
export function mcpActor(ctx: McpToolContext): typeof MCP_ACTOR | typeof AGENT_ACTOR {
  return ctx.taskId ? AGENT_ACTOR : MCP_ACTOR;
}

/**
 * Validate an `effort` argument at the MCP boundary.
 *
 * MCP is a first-class external surface, so it parses and confirms its own
 * inputs rather than relying on a downstream check. There is no downstream
 * check to rely on: `resolveAndPersistEffort` blind-casts the string and writes
 * it to task metadata, so an unvalidated `effort: "banana"` is persisted and
 * silently governs every later turn. The CLI rejects the same value at its own
 * boundary; this is the MCP counterpart, worded identically.
 */
function parseEffortArg(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !VALID_EFFORT_LEVELS.includes(value as EffortLevel)) {
    throw new Error(
      `Invalid effort '${String(value)}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`,
    );
  }
  return value as EffortLevel;
}

/**
 * Validate an `agent` argument at the MCP boundary, mirroring the CLI's
 * `--agent` check. An unknown agent id would otherwise surface much later as an
 * opaque launch failure, after a worktree and branch already exist.
 */
function parseAgentArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const validAgents = listAgents();
  if (typeof value !== 'string' || !validAgents.includes(value)) {
    throw new Error(
      `Unknown agent '${String(value)}'. Available agents: ${validAgents.join(', ')}`,
    );
  }
  return value;
}

/**
 * Resolve a task id and apply {@link assertAgentMayTarget}. For handlers that do
 * not otherwise open storage (e.g. lazy_wait, which hands straight to the daemon
 * RPC). Skips the lookup entirely for the builder.
 */
async function gateAgentTarget(ctx: McpToolContext, taskIdInput: string, action: string): Promise<void> {
  if (!ctx.taskId) return; // builder: unrestricted — avoid an unnecessary resolve
  const storage = await getStorage(ctx);
  try {
    const resolved = await storage.resolveTask(taskIdInput);
    if (!resolved.task) {
      throw new Error(`Task not found: ${taskIdInput}`);
    }
    assertAgentMayTarget(ctx, resolved.task, action);
  } finally {
    await storage.close();
  }
}

// ---------------------------------------------------------------------------
// lazy_search
// ---------------------------------------------------------------------------

export const searchTool: McpTool = {
  name: 'lazy_search',
  description:
    'Search across tasks, prompts, conversation turns, commits, comments, ' +
    'follow-ups, and shared memory records in the lazy project. Returns structured ' +
    'results with task context. ' +
    'Use this to find rationale, decisions, and context from other tasks.\n\n' +
    'Use "offset" and "limit" to paginate through results. ' +
    'Response always includes "total" count of matching results.\n\n' +
    'Result excerpts are truncated (~500 chars) on purpose: search LOCATES, ' +
    'lazy_show READS. So turn, commit, comment, and follow-up hits carry a ' +
    'locator — "index", the entity\'s 0-based position in that task\'s list of ' +
    'that kind.\n\n' +
    'For turn, commit, and comment hits that list is one lazy_show pages over, ' +
    'so pass "index" straight back as lazy_show\'s "offset" with limit=1 and ' +
    'that one section to read the entity in full, e.g. ' +
    'lazy_show(task_id, sections=["turns"], offset=<index>, limit=1) — and ' +
    'likewise sections=["commits"] / ["comments"]. Turn hits also carry ' +
    '"turnSequence" — the turn number lazy_show reports, for citing the turn ' +
    'without re-reading it.\n\n' +
    'Follow-up hits are the exception, and need no paging: there is no ' +
    '"follow_ups" section to request because lazy_show ALWAYS returns every ' +
    'follow-up in full as "follow_ups". A follow-up hit\'s "index" is just its ' +
    'position in that array. Task, prompt, conversation, and memory hits have ' +
    'no position in any per-task list and carry no "index" at all.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query. Plain text is a case-insensitive regex. Also supports a ' +
          'Lucene-style structured syntax with field filters (status:, goal:, code:, ' +
          'tag:, in:turns/commits/comments/followups/conversations/memories, has:*, created:/updated:), ' +
          'boolean operators (AND, OR, NOT), and grouping. E.g. "tag:onboarding AND status:blocked". ' +
          'Tag values are normalized on write and on query (lowercased, non-alphanumerics collapsed ' +
          'to hyphens), so tag:#Launch == tag:launch; quote a multi-word tag (tag:"My Feature Work") ' +
          'or only its first word is treated as the tag. A bare "#name" means tag:name OR the literal ' +
          'text "#name". A zero-result tag query returns a "hint" field naming the tags that do not exist.',
        minLength: 1,
      },
      fuzzy: {
        type: 'boolean',
        description: 'Use fuzzy matching instead of exact regex (typo-tolerant)',
      },
      filter: {
        type: 'string',
        description: 'Filter results to a specific type',
        enum: ['tasks', 'prompts', 'turns', 'commits', 'comments', 'followups', 'conversations', 'memories'],
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

/**
 * Render one non-fuzzy search hit.
 *
 * `index` and `turnSequence` are the locator: a search excerpt is truncated by
 * design (search LOCATES, lazy_show READS), so a hit that only named its task
 * left the caller paging through lazy_show by hand to find which turn matched.
 * `index` is the entity's 0-based position in the same list lazy_show pages
 * over, so it can be passed straight back as `offset`.
 */
function mapSearchHit(r: SearchResult): Record<string, unknown> {
  return {
    type: r.entity_type,
    taskId: shortId(r.task_id),
    taskCode: r.task_code,
    taskGoal: r.task_goal,
    content: r.content.substring(0, 500),
    context: r.match_context?.substring(0, 200),
    ...(r.entity_index !== undefined ? { index: r.entity_index } : {}),
    ...(r.turn_sequence !== undefined ? { turnSequence: r.turn_sequence } : {}),
  };
}

export function createSearchHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const query = args.query as string;
    const fuzzy = args.fuzzy as boolean | undefined;
    const filter = args.filter as string | undefined;
    // 'tasks' -> 'task'. 'memories' is irregular, so map it explicitly rather
    // than letting the plural strip produce 'memorie' (which matches nothing).
    const filterType = filter === 'memories' ? 'memory' : filter?.replace(/s$/, '');
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 20;

    const storage = await getStorage(ctx);
    try {
      if (fuzzy) {
        // Fuzzy search: load all content and use fuse.js
        const { default: Fuse } = await import('fuse.js');
        let items = await getAllSearchableContent(storage);
        if (filterType) {
          items = items.filter(i => i.type === filterType);
        }

        const fuse = new Fuse(items, FUZZY_SEARCH_OPTIONS);

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
            ...(r.item.entityIndex !== undefined ? { index: r.item.entityIndex } : {}),
            ...(r.item.turnSequence !== undefined ? { turnSequence: r.item.turnSequence } : {}),
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

          // Same trap as on the CLI: a tag that was never applied, mistyped, or
          // written unquoted returns an empty list with no way to tell which.
          const hint = results.length === 0 ? await buildTagHint(storage, query) : null;

          return {
            query,
            fuzzy: false,
            count: sliced.length,
            total: results.length,
            ...(hint ? { hint } : {}),
            results: sliced.map(mapSearchHit),
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
          results: sliced.map(mapSearchHit),
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
    'Any orthogonal follow-ups an agent recorded on the task are always included ' +
    '(as `follow_ups`) so you can triage them at review — that is why there is no ' +
    '`follow_ups` value in `sections`, and why `offset`/`limit` do not apply to them. ' +
    'When the task\'s supervisor is stuck in the retry loop, `retry_status` reports ' +
    'the attempt count, failure class, delay before the next attempt, and the ' +
    'deduplicated error log — so you can tell a retrying task from a healthy one. ' +
    'When the task sits behind a protection gate, `protection` reports it read-only ' +
    '(whether it is gated, the task/branch gate that applies, and whether a human ' +
    '`lazy approve` is already recorded and pending) so you can see the gate before ' +
    'an accept is refused. There is no MCP surface for arranging gates — that is ' +
    'deliberately human-only. ' +
    'Default response is a compact summary with counts. Use "sections" to ' +
    'drill down into specific data (turns, chunks, commits, comments, children). ' +
    'Use "offset" and "limit" to paginate within sections.\n\n' +
    'The "chunks" section groups turns by review boundary: each chunk starts at ' +
    'a human/builder turn and absorbs every following agent, supervisor, and ' +
    'system turn until the next human/builder turn. Review by chunk to avoid ' +
    'missing intermediate turns (auto-resumes, supervisor nudges) that a ' +
    '"latest turn" glance silently skips.',
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
          enum: ['turns', 'chunks', 'commits', 'comments', 'journal', 'children', 'status-history', 'tag-history'],
        },
        description: 'Sections to include in full (e.g. ["turns", "commits", "status-history"]). Without this, only counts are returned. "chunks" groups turns by human/builder review boundary (offset/limit page over chunks, not turns). "status-history" surfaces the audit trail of status transitions (from → to, actor, timestamp). "tag-history" surfaces the append-only tag/untag audit trail (tag, action, actor, timestamp). Current tags are always included in the summary as `tags`.',
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

/**
 * Map a stored turn to the shape returned by lazy_show. Includes `actor` and
 * `auto_triggered` so reviewers can tell a real human/builder turn from an
 * automation-authored one (supervisor nudge, system auto-resume) — the
 * provenance that chunk grouping relies on.
 */
function mapShowTurn(t: Turn): Record<string, unknown> {
  return {
    sequence: t.sequence,
    role: t.role,
    // Authoring actor (e.g. 'builder' for MCP-originated turns, 'supervisor'
    // for push-back). Lets the builder distinguish turns it submitted from
    // ones a human typed — consistent with the status-history actor field.
    // Always present (null when absent) so consumers can rely on the field.
    actor: t.actor ?? null,
    content: turnText(t),
    timestamp: new Date(t.timestamp).toISOString(),
    ...(t.auto_triggered ? { auto_triggered: true } : {}),
    // Per-turn launch labels. Emitted only when recorded: a pre-feature turn
    // stays label-free rather than inheriting the task's current agent/model/
    // effort, which would invent history. `agent` is the agent id the turn was
    // launched with — the task's `agent_id` can be switched mid-flight, so it
    // cannot answer this for turn N. `model` is the request-side resolution
    // (usually a tier alias); `model_id` is what the agent itself reported, and
    // its absence is the honest signal that only the alias was ever known.
    ...(t.agent !== undefined ? { agent: t.agent } : {}),
    ...(t.model !== undefined ? { model: t.model } : {}),
    ...(t.model_id !== undefined ? { model_id: t.model_id } : {}),
    ...(t.effort !== undefined ? { effort: t.effort } : {}),
    ...(t.turn_type !== undefined ? { turn_type: t.turn_type } : {}),
    ...(t.check_exit_code !== undefined ? { check_exit_code: t.check_exit_code } : {}),
    ...(t.check_output !== undefined ? { check_output: t.check_output } : {}),
  };
}

/**
 * Retry state for lazy_show, read from the supervisor checkpoint.
 *
 * Returns null unless the task is `working` and its supervisor is currently in
 * the retry loop. Shape mirrors what `lazy show` renders on the host: attempt
 * count, failure classification, when the next attempt lands, and the
 * deduplicated error log. `summary` is the same one-line phrase the watch header
 * and list substate use, so all surfaces read identically.
 */
/**
 * Mid-merge report for lazy_show / lazy_wait, read from the task's worktree.
 *
 * INVARIANT (fix-sync-silent-conflict): a task whose worktree holds an
 * unresolved merge must never be reported as a plain settled `blocked`. Over MCP
 * this is the ONLY way a builder can see it — there is no host CLI to run
 * `git status` in. Returns null when the worktree is absent or settled, so the
 * field appears only when there is something wrong.
 */
export async function buildMergeState(task: Task): Promise<Record<string, unknown> | null> {
  try {
    const lazyRoot = requireLazyRoot();
    const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));
    if (!await pathExists(worktreePath)) return null;
    const state = await readWorktreeMergeState(worktreePath);
    if (!isMidMerge(state)) return null;
    return {
      merge_in_progress: state.mergeInProgress,
      unmerged_files: state.unmergedFiles,
      summary:
        `Worktree has an unresolved merge (${describeMergeState(state)}). A sync did not finish — ` +
        `run \`lazy sync ${shortId(task.id)}\` to complete it.`,
    };
  } catch {
    // Observational only: a worktree we cannot read must never fail a show/wait.
    return null;
  }
}

export async function buildRetryStatus(task: Task): Promise<Record<string, unknown> | null> {
  if (task.status !== 'working') return null;
  const status = await readSupervisorStatusAsync(taskProtocolDir(task.id));
  if (!status || status.phase !== 'retrying') return null;

  return {
    summary: formatRetrySummary(status),
    retry_count: status.retryCount ?? 0,
    failure_class: status.retry_failure_class ?? null,
    failure_reason: status.retry_failure_reason ?? null,
    next_delay_ms: status.retry_next_delay_ms ?? null,
    errors: (status.errors ?? []).map(e => ({
      message: e.message,
      count: e.count,
      first_seen: e.firstSeen,
      last_seen: e.lastSeen,
      failure_class: e.failure_class ?? null,
    })),
  };
}

/**
 * READ-ONLY protection status for `lazy_show`, or null when this task has
 * nothing to report (the common case — protection is opt-in).
 *
 * Read-only on purpose: there is no MCP write surface for protection, because
 * arranging your own gate defeats the gate. See public-docs/surface-asymmetries.md.
 */
export async function buildProtection(
  storage: Storage,
  task: Task,
): Promise<Record<string, unknown> | null> {
  try {
    const lazyRoot = requireLazyRoot();
    const config = await loadConfig(lazyRoot);
    const status = await loadTaskProtectionStatus(storage, config, lazyRoot, task);
    if (!protectionSummary(status)) return null;
    return protectionToJson(status);
  } catch (err) {
    // Observational only: a project we cannot read protection config for must
    // never fail a show.
    logger.debug(`lazy_show: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function createShowHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const sections = args.sections as string[] | undefined;
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 20;

    const sectionsSet = new Set(sections ?? []);

    const storage = await getStorage(ctx);
    try {

      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }

      const task = resolved.task;
      // INVARIANT: an agent may only inspect its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'show');
      const session = await storage.getSessionByTaskId(task.id);

      // Always build compact summary
      const result: Record<string, unknown> = {
        id: shortId(task.id),
        code: task.code ?? null,
        goal: task.goal,
        status: task.status,
        // The task's CURRENT agent. Always populated — per-turn `agent` is what
        // answers "which agent ran turn N" after a mid-task switch.
        agent: task.agent_id,
        model: task.model ?? null,
        tags: task.tags ?? [],
        created_at: new Date(task.created_at).toISOString(),
        parent_task_id: parentTaskIdOf(task) ? shortId(parentTaskIdOf(task)!) : null,
      };

      // Present ONLY when the worktree is mid-merge — a stranded merge must not
      // hide behind a bare `blocked` (fix-sync-silent-conflict).
      const mergeState = await buildMergeState(task);
      if (mergeState) result.merge_state = mergeState;

      // Present ONLY when this task is gated (or listed while protection is
      // off). Read-only: a builder can see the gate without hitting a refusal,
      // and cannot arrange its own.
      const protection = await buildProtection(storage, task);
      if (protection) result.protection = protection;

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

        // Include latest turn in summary (untruncated) when not drilling into turns/chunks
        if (!sectionsSet.has('turns') && !sectionsSet.has('chunks') && allTurns.length > 0) {
          result.latest_turn = mapShowTurn(allTurns[allTurns.length - 1]);
        }

        // Retry state — a task stuck retrying looks identical to a healthy
        // working task over MCP unless we say so. Builders have no host CLI, so
        // without this they cannot see WHAT is being retried.
        const retryStatus = await buildRetryStatus(task);
        if (retryStatus) {
          result.retry_status = retryStatus;
        }
      } else {
        result.turn_count = 0;
        result.commit_count = 0;
      }

      // Comments, journal, follow-ups, and children counts (always included)
      const allComments = await storage.getTaskComments(task.id);
      const allJournal = await storage.getTaskJournal(task.id);
      const allFollowUps = await storage.getTaskFollowUps(task.id);
      const allChildren = await storage.getChildTasks(task.id);
      const allStatusHistory = await storage.getStatusHistory(task.id);
      const allTagHistory = await storage.getTagHistory(task.id);
      result.comment_count = allComments.length;
      result.journal_count = allJournal.length;
      result.follow_up_count = allFollowUps.length;
      result.children_count = allChildren.length;
      result.status_history_count = allStatusHistory.length;
      result.tag_history_count = allTagHistory.length;

      // Follow-ups are the builder's triage queue at review — always surface
      // their content inline when present (they're short and few), so the
      // builder never has to know to drill in to discover there are any.
      // Deliberately NOT paged by offset/limit and deliberately absent from
      // `sections`: whole is the only view there is, which is why a follow-up
      // search hit's `index` is a position to read off, not an offset to page to.
      if (allFollowUps.length > 0) {
        result.follow_ups = allFollowUps.map(f => ({
          id: shortId(f.id),
          content: f.content,
          created_at: new Date(f.created_at).toISOString(),
        }));
      }

      // Drill-down: include full section data when explicitly requested
      if (sectionsSet.has('turns') && allTurns.length > 0) {
        const sliced = allTurns.slice(offset, offset + limit);
        result.turns = sliced.map(mapShowTurn);
      }

      // Chunked view: group turns by human/builder review boundary. offset/limit
      // page over chunks (not turns) so a chunk is never split across pages.
      if (sectionsSet.has('chunks') && allTurns.length > 0) {
        const allChunks = groupTurnsIntoChunks(allTurns);
        result.chunk_count = allChunks.length;
        const sliced = allChunks.slice(offset, offset + limit);
        result.chunks = sliced.map(chunk => ({
          index: chunk.index,
          boundary: chunk.boundary ? mapShowTurn(chunk.boundary) : null,
          turns: chunk.turns.map(mapShowTurn),
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

      if (sectionsSet.has('journal') && allJournal.length > 0) {
        const sliced = allJournal.slice(offset, offset + limit);
        result.journal = sliced.map(j => ({
          content: j.content,
          actor: j.actor ?? null,
          created_at: new Date(j.created_at).toISOString(),
        }));
      }

      if (sectionsSet.has('status-history')) {
        if (allStatusHistory.length > 0) {
          const sliced = allStatusHistory.slice(offset, offset + limit);
          result.status_history = sliced.map((c, i) => ({
            // `from` is the prior entry's status; null for the very first transition.
            from: (offset + i) === 0 ? null : allStatusHistory[offset + i - 1].status,
            to: c.status,
            actor: c.actor ?? null,
            timestamp: new Date(c.timestamp).toISOString(),
          }));
        }
      }

      if (sectionsSet.has('tag-history')) {
        if (allTagHistory.length > 0) {
          const sliced = allTagHistory.slice(offset, offset + limit);
          result.tag_history = sliced.map(e => ({
            tag: e.tag,
            action: e.action,
            actor: e.actor ?? null,
            timestamp: new Date(e.timestamp).toISOString(),
          }));
        }
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
    'Use this when you identify work that should be tracked as a separate task. ' +
    'When called by an agent, the new task is always created as a subtask of your ' +
    'own current task — the `parent` argument may only point to your own task, and ' +
    'creating top-level tasks or tasks under another parent/branch is not permitted.',
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
        description: 'Model ID to use for this task (e.g., opus, sonnet, claude-opus-4-8)',

      },
      runner: {
        type: 'string',
        enum: ['host', 'docker', 'container', 'podman'],
        description: 'Runner to execute this task on, overriding the global [runner] type: "host" (host process, no container isolation), "docker"/"container", or "podman". Persists on the task. Omit to inherit the global default.',
      },
      agent: {
        type: 'string',
        description: 'Agent to run this task with (e.g. "claude-code", "cursor"). Persists on the task. Omit to inherit the parent task\'s agent for a subtask, or the lazy.toml default for a top-level task.',
      },
      type: {
        type: 'string',
        description: 'Task type',
      },
      priority: {
        type: 'string',
        description: 'Queue priority: low, normal (default), high, or urgent. Orders which queued task starts next when the concurrency cap is hit.',
        enum: ['low', 'normal', 'high', 'urgent'],
      },
      parent: {
        type: 'string',
        description: 'Either a parent task ID (creates a child task) or a raw git branch name (top-level task targeting that branch). Without this, the task targets the repo default branch; the currently checked-out branch is never silently adopted.',
      },
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. Only needed when creating under main while an active task exists.',
      },
    },
    required: ['goal'],
  },
};

export function createCreateHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const goal = args.goal as string;
    const prompt = args.prompt as string | undefined;
    const code = args.code as string | undefined;
    const model = args.model as string | undefined;
    const runnerArg = args.runner as string | undefined;
    const agentArg = args.agent as string | undefined;
    const type = args.type as string | undefined;
    const priority = args.priority as string | undefined;
    const parent = args.parent as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;

    // Validate the runner alias up front so bad input fails before any writes.
    let runnerType: RunnerType | undefined;
    if (runnerArg !== undefined) {
      const resolved = resolveRunnerType(runnerArg);
      if (!resolved) {
        throw new Error(`Invalid runner '${runnerArg}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
      }
      runnerType = resolved;
    }

    if (agentArg !== undefined && !listAgents().includes(agentArg)) {
      throw new Error(`Unknown agent '${agentArg}'. Available agents: ${listAgents().join(', ')}`);
    }

    if (priority !== undefined && !VALID_TASK_PRIORITIES.includes(priority as TaskPriority)) {
      throw new Error(`Invalid priority '${priority}'. Must be one of: ${VALID_TASK_PRIORITIES.join(', ')}`);
    }

    const storage = await getStorage(ctx);
    try {
      // INVARIANT: Agents may only create subtasks of their OWN task.
      // A non-empty ctx.taskId means an agent (acting on that task) is the
      // caller. In that case the new task is ALWAYS parented to ctx.taskId:
      // agents may not create top-level tasks, may not target a branch, and may
      // not parent under any other task. This boundary is enforced here, in the
      // daemon-side handler, so an agent cannot escape it even if it ignores the
      // prompt. The builder (ctx.taskId === '') keeps the full create surface
      // below.
      if (ctx.taskId) {
        if (parent !== undefined) {
          const resolved = await storage.resolveTask(parent);
          if (!resolved.task || resolved.task.id !== ctx.taskId) {
            throw new Error(
              'Agents may only create subtasks of their own task. ' +
              "Omit 'parent' (the new task is created as a child of your current task) " +
              'or pass your own task id. Creating a top-level task, targeting a branch, ' +
              'or parenting under another task is not permitted.',
            );
          }
        }

        // A subtask runs on its parent's agent unless the caller says otherwise
        // — an agent decomposing its own work should not have the children
        // silently retargeted to the project default.
        const ownTask = await storage.getTask(ctx.taskId);
        const subtaskAgentId = resolveAgentForNewTask({
          explicit: agentArg,
          inheritFrom: ownTask,
          configDefault: (await loadConfig(requireLazyRoot())).agent.agent_id,
        });

        const task = await storage.createTask(goal, ctx.taskId, undefined, code, type, subtaskAgentId, mcpActor(ctx)); // channel actor on the initial backlog entry: 'builder' or 'agent'
        if (prompt) {
          await storage.updateTaskPrompt(task.id, prompt);
        }
        if (model) {
          await storage.updateTaskModel(task.id, model);
        }
        // runner and priority are advertised on this tool's schema, so they are
        // applied on the agent path too. They used to be silently dropped here:
        // an agent asking for priority 'urgent' got a normal-priority task and
        // no error. Neither one widens the agent's blast radius — the parent is
        // still forced to ctx.taskId above — so accepting them is right, and
        // silent acceptance was the one unacceptable option.
        if (runnerType) {
          await storage.updateTaskRunnerType(task.id, runnerType);
        }
        if (priority) {
          await storage.updateTaskPriority(task.id, priority);
        }

        return {
          id: shortId(task.id),
          full_id: task.id,
          goal: task.goal,
          status: task.status,
          code: task.code ?? null,
          model: model ?? null,
          runner: runnerType ?? null,
          priority: priority ?? task.priority,
          parent_task_id: shortId(ctx.taskId),
        };
      }

      // Resolve --parent: a task code/short-ID (creates a child) or a raw git
      // branch (top-level task targeting that branch). Same precedence as
      // `lazy reparent` / CLI `lazy create`: try task first, then branch.
      let parentTaskId: string | undefined;
      let parentTask: Task | null = null;
      let explicitBranchTarget: string | undefined;
      if (parent) {
        const resolved = await storage.resolveTask(parent);
        if (resolved.task) {
          parentTaskId = resolved.task.id;
          parentTask = resolved.task;
        } else if (resolved.ambiguousMatches?.length) {
          throw new Error(`Ambiguous parent '${parent}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
        } else {
          // Not a task — verify as branch.
          const root = requireLazyRoot();
          const verify = await runGit(['rev-parse', '--verify', '--quiet', parent], { cwd: root });
          if (verify.exitCode !== 0) {
            throw new Error(`Parent '${parent}' is neither a known task nor a local git branch.`);
          }
          if (parent.startsWith('lazy/')) {
            throw new Error(`parent must be an integration branch, not a lazy task branch ('${parent}').`);
          }
          explicitBranchTarget = parent;
        }
      }

      // Check for parent warning: creating under main while active tasks exist.
      // Active = non-terminal and non-backlog (working, blocked, interrupted, pairing, merging, conflict).
      const effectiveParent = parent ?? 'main';

      const nonTerminalTasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
      // Filter out backlog — those aren't "active" in the sense that matters here
      const activeTasks = nonTerminalTasks.filter((t) => t.status !== 'backlog');

      // For each active task, count only non-terminal children (ongoing or backlog).
      // A task with only completed/abandoned subtasks is effectively a singleton.
      const activeTasksWithChildCounts: Array<{ task: typeof activeTasks[0]; childCount: number }> = [];
      for (const task of activeTasks) {
        const children = await storage.getChildTasks(task.id);
        const activeChildren = children.filter((c) => c.status !== 'complete' && c.status !== 'abandoned');
        activeTasksWithChildCounts.push({ task, childCount: activeChildren.length });
      }

      const level = createConfirmationLevel(
        effectiveParent === 'main' ? 'main' : undefined,
        activeTasksWithChildCounts,
      );

      // For create, we use a fixed synthetic task ID since no task exists yet.
      // The confirmation is scoped to (operation='create', taskId='_create_').
      const CREATE_CONFIRMATION_TASK_ID = '_create_';

      if (level !== 'none' && !confirmationCode) {
        // Step 1: return guidance about parent warning
        const confirmCode = generateCode('cr');
        storePending({ code: confirmCode, operation: 'create', taskId: CREATE_CONFIRMATION_TASK_ID, createdAt: Date.now() });

        let guidance: string;
        if (level === 'stern') {
          // Find the active task with the most children for the warning message
          const withChildren = activeTasksWithChildCounts
            .filter((t) => t.childCount > 0)
            .sort((a, b) => b.childCount - a.childCount);
          const topParent = withChildren[0]!;
          const context = gatherCreateParentWarningSternContext(topParent.task, topParent.childCount, confirmCode);
          guidance = renderGuidance('create-parent-warning-stern', context);
        } else {
          // Light: active tasks exist but none have children
          const context = gatherCreateParentWarningContext(activeTasks[0]!, confirmCode);
          guidance = renderGuidance('create-parent-warning', context);
        }

        throw new Error(guidance);
      }

      if (level !== 'none' && confirmationCode) {
        // Step 2: validate confirmation code
        if (!validateCode(confirmationCode, 'create', CREATE_CONFIRMATION_TASK_ID)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_create without a code to get a new one.');
        }
      }

      // Explicit agent > parent task's agent (a subtask stays on its parent's
      // agent) > project default.
      const newTaskAgentId = resolveAgentForNewTask({
        explicit: agentArg,
        inheritFrom: parentTask,
        configDefault: (await loadConfig(requireLazyRoot())).agent.agent_id,
      });

      const task = await storage.createTask(goal, parentTaskId, undefined, code, type, newTaskAgentId, mcpActor(ctx)); // channel actor on the initial backlog entry: 'builder' or 'agent'

      if (explicitBranchTarget) {
        await storage.updateTaskTarget(task.id, branchTarget(explicitBranchTarget));
      }

      if (prompt) {
        await storage.updateTaskPrompt(task.id, prompt);
      }

      if (model) {
        await storage.updateTaskModel(task.id, model);
      }

      if (runnerType) {
        await storage.updateTaskRunnerType(task.id, runnerType);
      }
      if (priority) {
        await storage.updateTaskPriority(task.id, priority);
      }

      return {
        id: shortId(task.id),
        full_id: task.id,
        goal: task.goal,
        status: task.status,
        code: task.code ?? null,
        model: model ?? null,
        runner: runnerType ?? null,
        priority: priority ?? task.priority,
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
    rejectIfReadOnly('lazy_comment');
    const message = args.message as string;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await getStorage(ctx);
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

      const comment = await storage.createComment(taskId, message, mcpActor(ctx));

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
// lazy_journal
// ---------------------------------------------------------------------------

export const journalTool: McpTool = {
  name: 'lazy_journal',
  description:
    'Append an entry to a task\'s journal — an append-only side channel for ' +
    'orchestration metadata, design rationale, decisions and the reasons behind ' +
    'them, things you stubbed or deferred, and memories meant for future runs. ' +
    'IMPORTANT: journal entries are NOT injected into any agent prompt — they are ' +
    'for the human and for your future self, never read back as task guidance. ' +
    'This is the key difference from lazy_comment: comments ARE delivered to the ' +
    'agent as guidance; journal entries are not. Use lazy_journal to *record* ' +
    '(rationale, memory); use lazy_comment to *instruct*.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to journal on (short hex prefix or code). If omitted, uses the current task.',
      },
      message: {
        type: 'string',
        description: 'Journal entry text',
        minLength: 1,
      },
    },
    required: ['message'],
  },
};

export function createJournalHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_journal');
    const message = args.message as string;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await getStorage(ctx);
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

      // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped). An
      // agent journalling on its own task must not read back as the builder's note.
      const entry = await storage.appendJournalEntry(taskId, message, mcpActor(ctx));

      return {
        id: shortId(entry.id),
        task_id: shortId(taskId),
        content: entry.content,
        created_at: new Date(entry.created_at).toISOString(),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_memory_save / lazy_memory_recall (lazy-owned shared memory)
// ---------------------------------------------------------------------------

export const memorySaveTool: McpTool = {
  name: 'lazy_memory_save',
  description:
    'Create or update a shared memory record — small, named, curated cross-task ' +
    'knowledge that is auto-injected (as a one-line index) into every future ' +
    'builder and agent launch. Saving an existing `name` supersedes that record ' +
    'and appends to an actor-attributed write history (history is never rewritten). ' +
    'Use this INSTEAD of your harness memory directory, which is per-session and ' +
    'never shared. BUILDER/HUMAN ONLY: task agents are read-only on memory and ' +
    'this tool is rejected for them. Types: user (who the human is), feedback ' +
    '(guidance they gave, with the why), project (goals/constraints not derivable ' +
    'from the code), reference (pointers to external resources).',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Record name — a short kebab-case slug (normalized). Reusing a name updates that record.',
        minLength: 1,
      },
      description: {
        type: 'string',
        description: 'One-line summary. This single line is what gets injected into future prompts, so make it self-explanatory.',
        minLength: 1,
      },
      type: {
        type: 'string',
        description: 'Record type',
        enum: ['user', 'feedback', 'project', 'reference'],
      },
      body: {
        type: 'string',
        description: 'Full record body (markdown). For feedback/project records, include why it matters and how to apply it.',
        minLength: 1,
      },
    },
    required: ['name', 'description', 'type', 'body'],
  },
};

export function createMemorySaveHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_memory_save');

    // INVARIANT (security boundary — see MemoryRecord in src/types): task agents
    // are READ-ONLY on shared memory, enforced HERE, server-side, from the
    // caller's task identity — not by prompt guidance. Memory is injected into
    // every future builder and agent launch, so an agent-writable store would be
    // a prompt-injection channel into every later session. A non-empty
    // ctx.taskId means the caller is a task agent. Do not relax this.
    if (ctx.taskId) {
      throw new Error(
        'Shared memory is read-only for task agents — lazy_memory_save is rejected. ' +
        'Memory records are injected into every future builder and agent session, so only ' +
        'the human (via `lazy memory save`) and the builder may write them. ' +
        'If you learned something worth remembering, say so in your final summary; ' +
        'for task-local rationale use lazy_journal instead.',
      );
    }

    // AUTHORING surface: the description length budget is enforced here (and in
    // `lazy memory save`), never on the import path — see
    // MAX_MEMORY_DESCRIPTION_LENGTH in src/memory/index.ts.
    const { normalizeMemoryName, normalizeAuthoredMemoryDescription, validateMemoryType } = await import('../memory');
    const name = normalizeMemoryName(args.name as string);
    const description = normalizeAuthoredMemoryDescription(args.description as string);
    const type = validateMemoryType(args.type as string);
    const body = (args.body as string).trim();
    if (!body) {
      throw new Error('A memory record needs a body — put the actual knowledge there.');
    }

    const storage = await getStorage(ctx);
    try {
      const existing = await storage.getMemory(name);
      const record = await storage.saveMemory({ name, description, type, body }, MCP_ACTOR);
      return {
        name: record.name,
        type: record.type,
        description: record.description,
        revision: record.revision,
        action: existing ? 'updated' : 'created',
        updated_at: new Date(record.updated_at).toISOString(),
        updated_by: record.updated_by,
      };
    } finally {
      await storage.close();
    }
  };
}

export const memoryRecallTool: McpTool = {
  name: 'lazy_memory_recall',
  description:
    'Recall shared memory. With no `name`, returns the index of all records ' +
    '(name, type, one-line description) — the same index injected into your ' +
    'system prompt. With a `name`, returns that record\'s full body plus who ' +
    'wrote it and when. To search inside record bodies, use ' +
    'lazy_search(query="in:memories <text>").',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Record name to read in full. Omit to list the index of all records.',
      },
    },
  },
};

export function createMemoryRecallHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const nameInput = args.name as string | undefined;
    const storage = await getStorage(ctx);
    try {
      const { normalizeMemoryName, renderMemoryIndex } = await import('../memory');

      if (!nameInput) {
        const records = await storage.listMemories();
        return {
          total: records.length,
          index: renderMemoryIndex(records) || '(no memory records yet)',
          records: records.map(r => ({
            name: r.name,
            type: r.type,
            description: r.description,
            updated_at: new Date(r.updated_at).toISOString(),
            updated_by: r.updated_by,
          })),
        };
      }

      const name = normalizeMemoryName(nameInput);
      const record = await storage.getMemory(name);
      if (!record) {
        throw new Error(
          `No memory record named '${name}'. Call lazy_memory_recall with no arguments to list all records.`,
        );
      }
      const history = await storage.getMemoryHistory(name);
      return {
        name: record.name,
        type: record.type,
        description: record.description,
        body: record.body,
        revision: record.revision,
        created_at: new Date(record.created_at).toISOString(),
        created_by: record.created_by,
        updated_at: new Date(record.updated_at).toISOString(),
        updated_by: record.updated_by,
        history: history.map(e => ({
          action: e.action,
          actor: e.actor,
          revision: e.revision,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_tag
// ---------------------------------------------------------------------------

export const tagTool: McpTool = {
  name: 'lazy_tag',
  description:
    'Add a tag to a task for lightweight, non-hierarchical grouping (e.g. group ' +
    'work into efforts like "onboarding", "launch", "infra"). A task can carry ' +
    'multiple tags. Tags are normalized to lowercase alphanumerics + hyphens. ' +
    'Idempotent — re-tagging an existing tag is a no-op. Every tag/untag is ' +
    'recorded in an append-only, actor-attributed history. Returns the task\'s ' +
    'current tags.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to tag (short hex prefix or code). If omitted, tags the current task.',
      },
      tag: {
        type: 'string',
        description: 'The tag to add (normalized to lowercase alphanumerics + hyphens).',
        minLength: 1,
      },
    },
    required: ['tag'],
  },
};

export function createTagHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_tag');
    const tag = args.tag as string;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await getStorage(ctx);
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

      // MCP channel → builder actor, or 'agent' when a task agent is the caller
      // (see MCP_ACTOR / AGENT_ACTOR / builder-actor invariant).
      const task = await storage.addTaskTag(taskId, tag, mcpActor(ctx));

      return {
        task_id: shortId(taskId),
        tags: task.tags,
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_untag
// ---------------------------------------------------------------------------

export const untagTool: McpTool = {
  name: 'lazy_untag',
  description:
    'Remove a tag from a task. Idempotent — untagging a tag the task does not ' +
    'have is a no-op. Untagging appends an \'untag\' event to the task\'s ' +
    'append-only tag history; it never erases the earlier tagging event. ' +
    'Returns the task\'s current tags.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to untag (short hex prefix or code). If omitted, untags the current task.',
      },
      tag: {
        type: 'string',
        description: 'The tag to remove (normalized to lowercase alphanumerics + hyphens).',
        minLength: 1,
      },
    },
    required: ['tag'],
  },
};

export function createUntagHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_untag');
    const tag = args.tag as string;
    const taskIdInput = args.task_id as string | undefined;

    const storage = await getStorage(ctx);
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

      // MCP channel → builder actor, or 'agent' when a task agent is the caller
      // (see MCP_ACTOR / AGENT_ACTOR / builder-actor invariant).
      const task = await storage.removeTaskTag(taskId, tag, mcpActor(ctx));

      return {
        task_id: shortId(taskId),
        tags: task.tags,
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_add_followup
// ---------------------------------------------------------------------------

export const addFollowUpTool: McpTool = {
  name: 'lazy_add_followup',
  description:
    'Record a follow-up note on the CURRENT task for genuinely ORTHOGONAL work ' +
    'you discovered — a different concern this task does not need in order to be ' +
    'correct and mergeable. Follow-ups are passive, task-level notes saved for ' +
    'the human/builder to triage at review. Recording one does NOT create a task, ' +
    'does NOT notify anyone, and does NOT trigger any further agent turn. ' +
    'Do NOT use this to defer part of THIS task\'s own work (finish that). ' +
    'Do NOT leave follow-up work as TODO comments in code or buried in prose.',
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description: 'The follow-up note — short, concrete, and actionable.',
        minLength: 1,
      },
    },
    required: ['note'],
  },
};

export function createAddFollowUpHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_add_followup');
    if (!ctx.taskId) {
      throw new Error('lazy_add_followup requires a task context. This tool is not available in builder mode.');
    }

    const note = args.note as string;

    const storage = await getStorage(ctx);
    try {
      // Capture which run surfaced this follow-up (best-effort).
      const session = await storage.getSessionByTaskId(ctx.taskId);

      // INVARIANT: createFollowUp is a passive storage append. It must NOT
      // create a comment, change status, or write any signal — recording a
      // follow-up never triggers an auto-turn/auto-resume. That non-triggering
      // property is exactly why follow-ups are not comments.
      const followUp = await storage.createFollowUp(ctx.taskId, note, session?.id ?? null);

      return {
        id: shortId(followUp.id),
        task_id: shortId(ctx.taskId),
        content: followUp.content,
        created_at: new Date(followUp.created_at).toISOString(),
      };
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_update_progress
// ---------------------------------------------------------------------------

export const updateProgressTool: McpTool = {
  name: 'lazy_update_progress',
  description:
    'Post a short, human-readable line saying what you are doing RIGHT NOW, so ' +
    'someone watching this task can see inside a long turn instead of a bare ' +
    '"working". Fire-and-forget and latest-wins: each call replaces the previous ' +
    'message, nothing is stored as task history, and the line is discarded when ' +
    'the turn ends. Call it SPARINGLY — at phase boundaries ("reproducing the ' +
    'bug", "running migration 3/7", "running the unit suite"), never on every ' +
    'tool call. Not a log, not a place for findings or rationale: use ' +
    'lazy_journal to record and lazy_comment to instruct.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'What you are doing right now — one short phrase, ideally under ' +
          `${MAX_PROGRESS_MESSAGE_LENGTH} characters. Longer messages are truncated, not rejected.`,
        minLength: 1,
      },
    },
    required: ['message'],
  },
};

export function createUpdateProgressHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    rejectIfReadOnly('lazy_update_progress');
    if (!ctx.taskId) {
      throw new Error(
        'lazy_update_progress requires a task context — it reports what a running ' +
        'TASK is doing. This tool is not available in builder mode.',
      );
    }

    // Boundary validation is strict about SHAPE (an empty or non-string message
    // is a caller mistake worth naming) and forgiving about LENGTH (truncated,
    // never rejected) — a progress post must never be able to cost a turn.
    const raw = args.message;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error("lazy_update_progress requires a non-empty 'message' string.");
    }

    // Touches no Storage at all: this is per-turn runtime state, not task
    // history. See src/protocol/progress.ts.
    const { message, truncated } = await recordProgress(ctx.taskId, raw);

    return {
      task_id: shortId(ctx.taskId),
      // Echoed back so a truncation is visible to the agent rather than silent.
      message,
      truncated,
    };
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
    rejectIfReadOnly('lazy_commit');
    if (!ctx.taskId) {
      throw new Error('lazy_commit requires a task context. This tool is not available in builder mode.');
    }

    const message = args.message as string;
    const files = args.files as string[] | undefined;

    const cwd = ctx.worktreePath;

    // Stage files
    if (files && files.length > 0) {
      const addResult = await runGit(['add', ...files], { cwd });
      if (addResult.exitCode !== 0) {
        throw new Error(`git add failed: ${addResult.stderr}`);
      }
    } else {
      const addResult = await runGit(['add', '-A'], { cwd });
      if (addResult.exitCode !== 0) {
        throw new Error(`git add failed: ${addResult.stderr}`);
      }
    }

    // Check if there's anything to commit
    const statusResult = await runGit(['diff', '--no-color', '--cached', '--stat'], { cwd });
    const diffStat = statusResult.stdout;
    if (!diffStat) {
      // A merge in progress still has to be concluded even when the resolution
      // happens to match HEAD exactly (e.g. every conflict resolved in favour of
      // our side). The agent cannot run `git commit` itself — refs are read-only
      // inside its container — so bailing out here would strand the merge.
      const mergeHead = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
      if (mergeHead.exitCode !== 0) {
        return {
          committed: false,
          message: 'Nothing to commit (no staged changes)',
        };
      }
    }

    // Commit
    const commitResult = await runGit(['commit', '-m', message], { cwd });
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr}`);
    }

    // Get the commit SHA
    const shaResult = await runGit(['rev-parse', 'HEAD'], { cwd });
    const sha = shaResult.stdout;

    // Count files changed from diffstat (last line is summary)
    const diffLines = diffStat.split('\n');
    const filesChanged = Math.max(0, diffLines.length - 1);

    // NOTE: lazy_commit deliberately does NOT signal end-of-turn. It used to
    // write a marker the supervisor read as "the turn is over", which armed a
    // kill timer — but agents commit mid-turn, and the final summary is
    // produced after every tool call, so that fuse routinely killed healthy
    // turns and discarded the summary they were writing. Turn end is now
    // observed directly from the agent's own output stream.
    // See src/supervisor/watchdog.ts.

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
    let mergeState: { merge_in_progress: boolean; unmerged_files: string[]; summary: string } | null = null;

    try {
      const branchResult = await runGit(['branch', '--show-current'], { cwd });
      branch = branchResult.exitCode === 0 ? branchResult.stdout : '';

      const statusResult = await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd });
      porcelain = statusResult.exitCode === 0 ? statusResult.stdout : '';
      changedFiles = porcelain ? porcelain.split('\n').length : 0;

      const logResult = await runGit(['log', '--oneline', '-5', '--no-color'], { cwd });
      recentCommits = logResult.exitCode === 0 ? logResult.stdout : '';

      const state = await readWorktreeMergeState(cwd);
      if (isMidMerge(state)) {
        mergeState = {
          merge_in_progress: state.mergeInProgress,
          unmerged_files: state.unmergedFiles,
          summary:
            `Worktree has an unresolved merge (${describeMergeState(state)}). ` +
            `Resolve the conflicts and commit the merge before doing other work.`,
        };
      }
    } catch {
      // Git not available (e.g., minimal builder container) — skip git info
    }

    // Task info from storage
    const storage = await getStorage(ctx);
    try {

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
          agent: task.agent_id,
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
          // An agent asking "what is the state of my worktree?" must be told
          // that it is mid-merge — otherwise it reads the conflict markers in
          // `uncommitted_changes` as ordinary edits (fix-sync-silent-conflict).
          ...(mergeState ? { merge_state: mergeState } : {}),
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

export function createConversationsHandler(ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const storage = await getStorage(ctx);
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

export function createConversationSearchHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const query = args.query as string;
    const regex = new RegExp(query, 'i');

    const storage = await getStorage(ctx);
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

export function createConversationReadHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const sessionId = args.session_id as string;

    const storage = await getStorage(ctx);
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
// lazy_conversation_ask
// ---------------------------------------------------------------------------

export const conversationAskTool: McpTool = {
  name: 'lazy_conversation_ask',
  description:
    'Ask a question about a past builder conversation and get an answer back. ' +
    'A throwaway read-only agent reads the stored transcript and answers; nothing ' +
    'is written back — the conversation is immutable history and this is a read of it. ' +
    'Synchronous: blocks until the answer is ready. Oversized transcripts are read in ' +
    'consecutive excerpts and the findings combined, so the answer may take a while. ' +
    'Prefer this over lazy_conversation_read when you want a specific fact or decision ' +
    '("what did we decide about X?") rather than the whole transcript — reading a long ' +
    'conversation in full can overflow your own context.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID of the conversation (full ID or a unique prefix)',
        minLength: 1,
      },
      question: {
        type: 'string',
        description: 'The question to ask about the conversation',
        minLength: 1,
      },
    },
    required: ['session_id', 'question'],
  },
};

export function createConversationAskHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const sessionId = args.session_id as string;
    const question = args.question as string;

    // Imported lazily: the ask module pulls in the prompt templates and the
    // one-shot agent path, which every other MCP call has no use for.
    const { resolveStoredConversation, askConversation } = await import('../conversation/ask');

    const storage = await getStorage(ctx);
    let conversation;
    try {
      const match = await resolveStoredConversation(storage, sessionId);
      if (!match) {
        throw new Error(
          `Conversation not found: ${sessionId}. List conversations with lazy_conversations.`,
        );
      }
      if ('ambiguous' in match) {
        const options = match.ambiguous
          .map(c => `  ${c.sessionId.substring(0, 8)}  ${c.summary.split('\n')[0].substring(0, 60)}`)
          .join('\n');
        throw new Error(
          `Multiple conversations match '${sessionId}'. Use a longer prefix:\n${options}`,
        );
      }
      conversation = match.conversation;
    } finally {
      await storage.close();
    }

    const config = await loadConfig(requireLazyRoot());
    // No onProgress: the MCP progress channel carries structured phase events,
    // and an ask's phases are not known until the transcript is chunked. The
    // call is synchronous — the caller gets the answer or the error.
    const result = await askConversation(conversation, question, {
      model: config.models.default,
    });

    return {
      session_id: result.sessionId,
      answer: result.answer,
      excerpts_read: result.chunks,
      excerpts_with_findings: result.relevantChunks,
      warnings: result.warnings,
      usage: result.usage,
    };
  };
}

// ---------------------------------------------------------------------------
// Lifecycle tools: lazy_start, lazy_unblock, lazy_accept, lazy_reject, lazy_close, lazy_submit
//
// IMPORTANT: These handlers hand the lifecycle operation off through the query*
// RPC-fallback layer (src/daemon/rpc-fallback.ts) — never by spawning a lazy
// CLI subprocess. Spawning lazy from within the daemon causes deadlocks (child
// RPCs back to parent) and storage lock contention; that lazy-on-lazy spawning
// was deliberately eliminated and must not return.
//
// Why query*/tryRpc rather than calling the daemon function (launchTask,
// acceptTask, …) directly: those obtain storage via getOrCreateStorage(), which
// only works inside the daemon process (where initDaemonStorage() has run). When
// an MCP handler runs in a builder/pairing process, ctx.storage is undefined —
// reads/comments reach the daemon via RemoteStorage, but a direct lifecycle call
// has no initialized storage and throws "Daemon storage not initialized". The
// query* layer forwards to the daemon over RPC when not in-daemon and falls back
// to the direct daemon function under LAZY_IS_DAEMON=1 / LAZY_TEST=1 — an
// in-process RPC call, NOT a subprocess — so these tools work in both contexts.
// ---------------------------------------------------------------------------

/** Parse git diff --shortstat output into structured numbers. */
function parseShortstat(stdout: string): { filesChanged: number; linesAdded: number; linesRemoved: number } {
  const filesMatch = stdout.match(/(\d+) file/);
  const addMatch = stdout.match(/(\d+) insertion/);
  const delMatch = stdout.match(/(\d+) deletion/);
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    linesAdded: addMatch ? parseInt(addMatch[1], 10) : 0,
    linesRemoved: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

/**
 * Compute the git diff cwd and range for a task relative to its parent branch.
 */
async function computeDiffCwdAndRange(
  session: { git_branch: string; git_start_sha: string },
  parentBranch: string,
  storagePath: string,
  lazyRoot: string,
): Promise<{ cwd: string; diffRange: string }> {
  // Worktrees live under <projectRoot>/.lazy/worktrees/, NOT under the storage path.
  const tRef = session.git_branch.replace('lazy/', '');
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
  const cwd = (await pathExists(worktreePath)) ? worktreePath : lazyRoot;

  // Use the task's branch name explicitly instead of HEAD. When cwd falls
  // back to lazyRoot, HEAD is whatever branch the main repo is on (e.g. main),
  // not the task branch — giving an empty diff for tasks with real changes.
  const branchCheck = await runGit(['rev-parse', '--verify', parentBranch], { cwd });
  const diffRange = branchCheck.exitCode === 0
    ? `${parentBranch}...${session.git_branch}`
    : `${session.git_start_sha}..${session.git_branch}`;

  return { cwd, diffRange };
}

interface StorageForDiff {
  getSessionByTaskId(taskId: string): Promise<{ git_branch: string } | null>;
  getStoragePath(): string;
}

/**
 * Get total lines changed for a task by running git diff --shortstat.
 * Returns 0 if the diff can't be computed (e.g., worktree gone).
 */
async function getDiffLinesChanged(
  task: { id: string; target: TaskTarget },
  session: { git_branch: string; git_start_sha: string },
  storage: StorageForDiff,
): Promise<number> {
  const stat = await getDiffStat(task, session, storage);
  if (!stat) return 0;
  return stat.linesAdded + stat.linesRemoved;
}

/**
 * Get diff stat (files changed, lines added, lines removed) for a task.
 * Returns null if the diff can't be computed (git error, worktree gone, etc.).
 */
async function getDiffStat(
  task: { id: string; target: TaskTarget },
  session: { git_branch: string; git_start_sha: string },
  storage: StorageForDiff,
): Promise<DiffStat | null> {
  try {
    const lazyRoot = requireLazyRoot();
    const parentId = task.target.kind === 'task' ? task.target.parentTaskId : null;
    const parentBranch = parentId
      ? (await storage.getSessionByTaskId(parentId))?.git_branch ?? 'main'
      : 'main';

    const { cwd, diffRange } = await computeDiffCwdAndRange(session, parentBranch, storage.getStoragePath(), lazyRoot);

    const result = await runGit(['diff', '--no-color', '--shortstat', diffRange], { cwd });
    if (result.exitCode !== 0) return null;

    return parseShortstat(result.stdout);
  } catch {
    return null;
  }
}

// --- lazy_start ---

export const startTool: McpTool = {
  name: 'lazy_start',
  description:
    'Start working on an existing task. Creates a worktree, git branch, and ' +
    'launches a supervisor to run the agent. To create a new task, use lazy_create first. ' +
    'When called by an agent, you may only start your OWN subtasks (tasks whose ' +
    'parent is your current task); starting any other task is not permitted.',
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

      },
      agent: {
        type: 'string',
        description:
          'Agent to run this task with, overriding the task\'s stored agent and the ' +
          'lazy.toml default. Equivalent to the CLI `--agent` flag.',
      },
      effort: {
        type: 'string',
        enum: [...VALID_EFFORT_LEVELS],
        description:
          'Reasoning effort for this task (low, medium, high, xhigh, max). PERSISTS on ' +
          'the task, so later turns reuse it unless overridden again. Equivalent to the ' +
          'CLI `--effort` flag. Omit to inherit the task or lazy.toml default.',
      },
      runner: {
        type: 'string',
        enum: ['host', 'docker', 'container', 'podman'],
        description: 'Runner to execute this task on, overriding the global [runner] type: "host", "docker"/"container", or "podman". Persists on the task; takes effect this turn. Omit to use the task or global default.',
      },
      force_local: {
        type: 'boolean',
        description:
          'Start from the parent/integration branch\'s local HEAD when its ref cannot ' +
          'be fetched from the remote (e.g. a parent branch that was never pushed). ' +
          'Offline mode already implies this — only needed while online when the ref ' +
          'genuinely is not on the remote. Equivalent to the CLI `--force-local` flag.',
      },
    },
    required: ['task_id'],
  },
};

export function createStartHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const model = args.model as string | undefined;
    const runnerArg = args.runner as string | undefined;

    // Validate at the boundary, before any worktree/branch/supervisor exists.
    const agentId = parseAgentArg(args.agent);
    const effortOverride = parseEffortArg(args.effort);

    let runnerOverride: RunnerType | undefined;
    if (runnerArg !== undefined) {
      const resolved = resolveRunnerType(runnerArg);
      if (!resolved) {
        throw new Error(`Invalid runner '${runnerArg}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
      }
      runnerOverride = resolved;
    }

    const forceLocal = args.force_local === true;

    // INVARIANT: Agents may only start their OWN subtasks. A non-empty
    // ctx.taskId means an agent (acting on that task) is the caller; it may
    // only start tasks whose parent is its own task. This is enforced here,
    // server-side, before any worktree/branch/supervisor is created — an agent
    // cannot start arbitrary tasks even if it ignores the prompt. The builder
    // (ctx.taskId === '') may start any task.
    if (ctx.taskId) {
      const storage = await getStorage(ctx);
      try {
        const resolved = await storage.resolveTask(taskId);
        if (!resolved.task) {
          throw new Error(`Task not found: ${taskId}`);
        }
        if (parentTaskIdOf(resolved.task) !== ctx.taskId) {
          throw new Error(
            `Agents may only start their own subtasks. Task '${taskId}' is not a child ` +
            'of your current task. Use lazy_create to create a subtask of your own task, ' +
            'then start that.',
          );
        }
      } finally {
        await storage.close();
      }
    }

    const params: StartTaskParams = {
      taskId,
      modelOverride: model,
      agentId,
      effortOverride,
      runnerOverride,
      forceLocal,
      retargetOrphan: true, // Builder doesn't prompt, auto-accept orphan retargeting
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    // Route through queryStartTask (the RPC layer) rather than calling
    // launchTask() directly. launchTask uses getOrCreateStorage(), which only
    // works inside the daemon process (where initDaemonStorage() has run). When
    // this handler executes in a builder/pairing process — ctx.storage is
    // undefined and other tools reach the daemon via RemoteStorage — a direct
    // launchTask() throws "Daemon storage not initialized". queryStartTask works
    // in both contexts: it forwards to the daemon via RPC when not in-daemon,
    // and falls back to the direct handler under LAZY_IS_DAEMON=1 / LAZY_TEST=1.
    const result = await queryStartTask(params);

    // Queued at the concurrency cap — the daemon will launch it automatically
    // when an agent slot frees up. Report it plainly (not an error).
    if (result.queued) {
      return {
        output:
          `Task queued (${result.queueRunning}/${result.queueLimit} agents running). ` +
          `It will start automatically when an agent slot frees up (a running task finishes or a blocked one is reviewed). ` +
          `Raise the cap for this daemon session with: lazy daemon config set max_concurrent_agents <N>`,
        queued: true,
        running: result.queueRunning,
        limit: result.queueLimit,
      };
    }

    return {
      output: `Started task ${result.sessionId} on branch ${result.branchName}`,
      sessionId: result.sessionId,
      containerName: result.containerName,
      worktreePath: result.worktreePath,
      branchName: result.branchName,
    };
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

      },
      agent: {
        type: 'string',
        description:
          'Switch to a different agent for this task (e.g. claude-code, cursor). ' +
          'Persists on the task for future turns. When switching agents, the ' +
          'session is reset (cannot resume across agents).',
      },
      approved_files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Conflict tasks ONLY (file permission violations), and REQUIRED for them — there is no default. ' +
          'List the violated files to approve; any PENDING violation you leave out is reverted to its base commit. ' +
          'Pass [] to revert all pending ones explicitly. Omitting the parameter on a conflict task is an error. ' +
          'A file you already approved on an earlier unblock STAYS approved whether or not you name it again, ' +
          'and re-naming it is always accepted — so a later unblock never has to re-assert past decisions ' +
          'to keep them. There is no un-approve value: to reverse an approval, the human un-approves it on ' +
          'the web review page (that record returns to PENDING and the next unblock decides it again), or you ' +
          'ask the agent to revert the file in the feedback text. ' +
          'Do not pass it when the task has never violated a protected file. ' +
          'Approving in the feedback text does nothing — this parameter is the only channel that is read. ' +
          '(lazy_accept\'s approved_files is different: there every pending violation must be listed or the accept is refused.)',
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
    const agent = args.agent as string | undefined;
    const approvedFiles = args.approved_files as string[] | undefined;

    // Validate agent if provided
    if (agent !== undefined) {
      const validAgents = listAgents();
      if (!validAgents.includes(agent)) {
        throw new Error(`Unknown agent '${agent}'. Available agents: ${validAgents.join(', ')}`);
      }
    }

    // --- Guard: validate approved_files parameter ---
    // The approved_files parameter is only meaningful when there are actual
    // file permission violations. Require explicit intent for both approve and revert.
    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only unblock its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'unblock');

      // INVARIANT (violations-are-the-source-of-truth — fix-ask-nukes-violations):
      // read the pending set REGARDLESS of task.status. `conflict` is a derived
      // label, and a side-channel turn (an ask, a sync, a pairing session) can
      // leave a task labelled `blocked` while a set is still pending. Gating on
      // the label made the correct call unexpressible: this guard refused
      // approved_files ("no file permission violations") while the daemon read
      // the set and reverted the unapproved files anyway.
      //
      // INVARIANT (approval-is-re-assertable — fix-violation-approval-sticky):
      // the two questions are asked of DIFFERENT sets. "Must a decision be
      // supplied?" is about the PENDING set. "May one be supplied at all?" is
      // about every record on the violation turn, decided or not — re-naming an
      // already-approved file is a legitimate no-op re-assertion, and refusing
      // it is what left the reviewer with no call to make but the destructive
      // one.
      let violations: Array<{ file: string; status: string }> = [];
      let records: Array<{ file: string; status: string }> = [];
      const sess = await storage.getSessionByTaskId(task.id);
      if (sess) {
        const turns = await storage.getSessionTurns(sess.id);
        // Must match what the daemon reverts against — see the
        // violations-come-from-the-violation-turn invariant in utils/turns.ts.
        violations = pendingViolations(turns);
        records = violationRecords(turns);
      }

      const hasViolations = violations.length > 0;

      // Error: approved_files passed when the task never violated anything
      if (records.length === 0 && approvedFiles !== undefined) {
        throw new Error(
          `Task ${taskId} has no file permission violations. ` +
          `The "approved_files" parameter is only meaningful for tasks that violated protected-file patterns. ` +
          `Do not pass it when there are no violations.`
        );
      }

      // Error: conflict task but approved_files not passed
      if (hasViolations && approvedFiles === undefined) {
        const fileList = violations.map(v => `  - ${v.file}`).join('\n');
        throw new Error(
          `Task ${taskId} has ${violations.length} file permission violation(s):\n${fileList}\n\n` +
          `To unblock, pass the "approved_files" parameter:\n` +
          `  - To approve all: approved_files: ${JSON.stringify(violations.map(v => v.file))}\n` +
          `  - To approve specific files: approved_files: ["file1.ts", "file2.ts"]\n` +
          `  - To revert all (explicit): approved_files: []\n\n` +
          `Note: approved_files: [] means revert all files. ` +
          `Omitting the parameter entirely is an error (no implicit default). ` +
          `Approving these files in the feedback text has no effect — approved_files is the only channel that is read.`
        );
      }
    } finally {
      await storage.close();
    }

    const params: UnblockTaskParams = {
      taskId,
      message: feedback,
      modelOverride: model,
      agentOverride: agent,
      approvedFiles,
      retargetOrphan: true, // Builder doesn't prompt, auto-accept orphan retargeting
      notesInEditor: false,
      // MCP boundary → 'builder' (project-wide caller) or 'agent' (a task agent
      // unblocking its own subtask). INVARIANT: actor = who submitted (the
      // channel), NOT who authored — feedback the builder relays from a human is
      // still 'builder' here. Content provenance is preserved separately; see
      // MCP_ACTOR / AGENT_ACTOR.
      actor: mcpActor(ctx),
    };

    const result = await queryUnblockTask(params);

    // INVARIANT (reverting committed work is never silent —
    // fix-ask-nukes-violations): the daemon reports every reverted and approved
    // protected file in `warnings`. Dropping them here is what let a revert of
    // an agent's committed work read as a plain success to the reviewer.
    const warnings = result.warnings ?? [];
    const output = [
      `Unblocked task ${result.sessionId} on branch ${result.branchName}`,
      ...warnings.map(w => `WARNING: ${w}`),
    ].join('\n');

    return {
      output,
      sessionId: result.sessionId,
      containerName: result.containerName,
      turnNumber: result.turnNumber,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
}

// --- lazy_ask ---

export const askTool: McpTool = {
  name: 'lazy_ask',
  description:
    'Ask a paused task\'s agent a free-form question and get its answer back. ' +
    'Read-only: resumes the agent\'s session in plan mode — does NOT unblock the task, ' +
    'commit, or modify the worktree. Synchronous: blocks until the agent responds. ' +
    'The task must be in \'blocked\' or \'conflict\' status and have an existing agent session. ' +
    'Uses the same mechanism as `lazy review -i`\'s ask (`a`) action. ' +
    'Prefer this over re-reading the diff when you need the agent\'s intent or reasoning rather than facts.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      message: {
        type: 'string',
        description: 'The question to ask the agent',
        minLength: 1,
      },
      effort: {
        type: 'string',
        enum: [...VALID_EFFORT_LEVELS],
        description: 'Reasoning effort override for this turn (low, medium, high, xhigh, max)',
      },
    },
    required: ['task_id', 'message'],
  },
};

export function createAskHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const message = args.message as string;
    const effort = parseEffortArg(args.effort);

    // Pre-flight: resolve task + session via the MCP storage so callers get
    // clean, actionable errors before we hand off to the daemon-only path.
    // (launchAskTask performs the same checks and is authoritative, but its
    // storage handle requires the daemon process — mirroring lazy_unblock,
    // we surface the obvious failures up front.)
    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only ask its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'ask');
      const sess = await storage.getSessionByTaskId(task.id);
      if (!sess) {
        throw new Error(
          `Task ${shortId(task.id)} has no session. Start it first with: lazy start ${shortId(task.id)}`,
        );
      }
      if (sess.ended_at) {
        throw new Error(
          `Task ${shortId(task.id)} session has ended. Create a variant with: lazy branch ${shortId(task.id)}`,
        );
      }
      if (!sess.agent_session_id) {
        throw new Error(
          `Task ${shortId(task.id)} has no agent session to resume — cannot ask until the agent has run at least once.`,
        );
      }
      if (task.status !== 'blocked' && task.status !== 'conflict') {
        throw new Error(
          `Task ${shortId(task.id)} is '${task.status}', not 'blocked' or 'conflict'. ` +
          `Ask only runs against a blocked or conflict task — wait until the agent is paused for review.`,
        );
      }
    } finally {
      await storage.close();
    }

    const params: AskTaskParams = {
      taskId,
      message,
      effortOverride: effort,
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    const result = await queryAskTask(params);

    return {
      answer: result.answer,
      sessionId: result.sessionId,
      turnNumber: result.turnNumber,
      usage: result.usage,
      warnings: result.warnings,
      timings: result.timings,
    };
  };
}

// --- lazy_accept ---

export const acceptTool: McpTool = {
  name: 'lazy_accept',
  description:
    'Accept a task\'s work and merge it into the parent branch. The task ' +
    'must be in blocked or conflict status with at least one commit. ' +
    'For conflict tasks, all violated files must be approved via approved_files. ' +
    'Accept also refuses when the merge would re-add a file the target branch deleted; ' +
    'those paths must be approved the same way.',
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
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing (unless the diff is tiny).',
      },
      approved_files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Files to approve on the way in: violated files on a conflict task, and/or files the merge would re-add ' +
          'after the target branch deleted them (accept names them when it refuses). ' +
          'Accept is all-or-nothing — every pending violation must be listed here or the accept is refused; ' +
          'it never reverts anything. ' +
          '(lazy_unblock\'s approved_files is different: there anything you leave out is REVERTED, and [] means revert all.)',
      },
    },
    required: ['task_id'],
  },
};

async function executeAccept(
  ctx: McpToolContext,
  taskId: string,
  reason: string | undefined,
  approvedFiles: string[] | undefined,
): Promise<{ output: string; status: string; prUrl?: string; warnings: string[] }> {
  const params: AcceptTaskParams = {
    taskId,
    reason,
    approvedFiles,
    acceptDirtyWorktree: false,
    actor: mcpActor(ctx),
    // The agent's own task id, when an agent is the caller. The daemon uses it
    // to recognise "the merge destination is the caller's own branch" — the one
    // case where merging into a `working` parent is intentional rather than a
    // race. Empty for the builder, which never gets that exemption.
    callerTaskId: ctx.taskId || undefined,
  };

  const result = await queryAcceptTask(params, ctx.progress);

  const statusMsg = result.status === 'merged'
    ? `Task ${result.displayId} accepted and merged`
    : `Task ${result.displayId} approved — merge pending: ${result.reason}`;

  return {
    output: statusMsg,
    status: result.status,
    prUrl: result.prUrl,
    warnings: result.warnings,
  };
}

export function createAcceptHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;
    const approvedFiles = args.approved_files as string[] | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may accept ONLY a DIRECT SUBTASK — never its own
      // task. Accepting a subtask does the existing subtask→parent local merge:
      // child work lands on the agent's OWN task branch, which a human still
      // reviews when the agent's own task is accepted. Accepting its own task
      // would let the agent complete itself and merge upward unreviewed, so
      // that is refused here rather than left to prompt guidance.
      assertAgentMayTargetChildOnly(ctx, task, 'accept');

      // --- Branch-protection (edge-gate) check (P0.2d) ---
      // INVARIANT: on a merge into a protected branch, the two-step
      // confirmation is NOT authorization — the builder generates and echoes
      // the code itself. When the merge is protected and no human approval is
      // pending, refuse up front and never issue a code. The daemon's acceptTask
      // gate is the authoritative enforcement; this check exists so the
      // builder gets the honest story instead of a code that cannot work.
      // 'merging'/'complete' are exempt: their merge was already authorized.
      if (task.status !== 'merging' && task.status !== 'complete') {
        const gateSession = await storage.getSessionByTaskId(task.id);
        if (gateSession) {
          const lazyRoot = requireLazyRoot();
          const config = await loadConfig(lazyRoot);
          const gatePid = parentTaskIdOf(task);
          const gateTargetBranch = gatePid
            ? (await storage.getSessionByTaskId(gatePid))?.git_branch ?? 'main'
            : targetBranchOf(task) ?? 'main';
          const decision = await resolveEdgeGateDecision(
            { sourceBranch: gateSession.git_branch, targetBranch: gateTargetBranch },
            config,
            lazyRoot,
            storage,
          );
          if (decision.gated && !(await peekHumanApproval(storage, task.id))) {
            throw new Error(renderGuidance('accept-gated', {
              task_code: task.code ?? shortId(task.id),
              task_id: task.id,
              source_branch: gateSession.git_branch,
              target_branch: gateTargetBranch,
              gate_reason: decision.reason,
            }));
          }
        }
      }

      // Step 2: validate confirmation code and execute
      if (confirmationCode) {
        if (!validateCode(confirmationCode, 'accept', task.id)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_accept without a code to get a new one.');
        }

        // Idempotency: if the merge has already landed (either by a prior
        // accept call that succeeded after a race, or by the remote-sync
        // reconciler), return a clear "already merged" response instead of
        // letting acceptTask's preflight throw an opaque "already accepted"
        // error or its state-machine throw "Invalid status transition".
        const existingSession = await storage.getSessionByTaskId(task.id);
        if (task.status === 'complete' && existingSession?.outcome === 'accepted') {
          return {
            output: `Task ${task.code ?? task.id.substring(0, 8)} was already accepted and merged (idempotent no-op).`,
            status: 'merged',
            warnings: [],
          };
        }

        return await executeAccept(ctx, taskId, reason, approvedFiles);
      }

      // INVARIANT: The preview call (no confirmation_code) must not mutate
      // task status, session outcome, branch refs, or merge state. The
      // confirmation code is the user's authorization gate; anything that
      // fires before the user types it is a bug. Only in-memory pending-
      // confirmation tracking is acceptable here.

      // Step 1: evaluate confirmation level based on diff size
      const session = await storage.getSessionByTaskId(task.id);
      let diffStat: DiffStat | null = null;
      let commitCount = 0;
      if (session) {
        diffStat = await getDiffStat(task, session, storage);
        const commits = await storage.getSessionCommits(session.id);
        commitCount = commits.length;
      }

      // If diff stat couldn't be computed (git error, worktree gone, etc.),
      // treat as unknown risk and require stern confirmation. Defaults must be safe.
      const level = diffStat ? acceptConfirmationLevel(diffStat) : 'stern';

      // If level is none (tiny diff with successful stat), execute directly
      if (level === 'none') {
        return await executeAccept(ctx, taskId, reason, approvedFiles);
      }

      const pid = parentTaskIdOf(task);
      const parentBranch = pid
        ? (await storage.getSessionByTaskId(pid))?.git_branch ?? 'main'
        : 'main';

      const code = generateCode('ac');
      storePending({ code, operation: 'accept', taskId: task.id, createdAt: Date.now() });

      const resolvedDiffStat = diffStat ?? { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
      const context = gatherAcceptContext(task, resolvedDiffStat, commitCount, parentBranch, code);

      // When diff stats are unavailable, override the zeroed values so the
      // guidance message doesn't misleadingly say "0 files, 0 additions".
      if (!diffStat) {
        (context as Record<string, unknown>).files_changed = 'unknown';
        (context as Record<string, unknown>).lines_added = 'unknown';
        (context as Record<string, unknown>).lines_removed = 'unknown';
      }

      const templateName = `accept-${level}` as const;
      const guidance = renderGuidance(templateName, context);

      throw new Error(guidance);
    } finally {
      await storage.close();
    }
  };
}

// --- lazy_reject ---

export const rejectTool: McpTool = {
  name: 'lazy_reject',
  description:
    'Reject a task\'s work and close its PR with a reject review. The task\'s session ends with outcome \'rejected\', ' +
    'the worktree is cleaned up, and the branch is preserved. ' +
    'Requires an active session — for closing a task that hasn\'t been worked on, use lazy_close.',
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
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing.',
      },
      accept_dirty_worktree: {
        type: 'boolean',
        description: 'Allow rejecting even if worktree has uncommitted changes. Use when you are certain you want to discard uncommitted work.',
      },
    },
    required: ['task_id'],
  },
};

export function createRejectHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;
    const acceptDirtyWorktree = args.accept_dirty_worktree as boolean | undefined;

    // Resolve task to get full ID for confirmation scoping
    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only reject its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'reject');

      // Step 2: validate confirmation code and execute
      if (confirmationCode) {
        if (!validateCode(confirmationCode, 'reject', task.id)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_reject without a code to get a new one.');
        }

        const params: RejectTaskParams = {
          taskId,
          reason: reason || '',
          acceptDirtyWorktree,
          actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
        };

        const result = await queryRejectTask(params);

        return {
          output: `Rejected task ${result.displayId} (${result.branchName})`,
          taskId: result.taskId,
          displayId: result.displayId,
          branchName: result.branchName,
        };
      }

      // Step 1: evaluate confirmation level and return guidance
      const level = rejectConfirmationLevel(); // always stern

      // Gather context for template
      const session = await storage.getSessionByTaskId(task.id);
      let commitCount = 0;
      let linesChanged = 0;
      if (session) {
        const commits = await storage.getSessionCommits(session.id);
        commitCount = commits.length;
        // Approximate lines changed from diff stat
        linesChanged = await getDiffLinesChanged(task, session, storage);
      }

      const code = generateCode('rj');
      storePending({ code, operation: 'reject', taskId: task.id, createdAt: Date.now() });

      const context = gatherRejectContext(task, commitCount, linesChanged, code);
      const guidance = renderGuidance('reject', context);

      throw new Error(guidance);
    } finally {
      await storage.close();
    }
  };
}

// --- lazy_close ---

export const closeTool: McpTool = {
  name: 'lazy_close',
  description:
    'Close a task — stop work and mark it as abandoned. Worktree is cleaned up but the branch is preserved. ' +
    'A reason is required. Does not require an active session — works on backlog tasks. ' +
    'For closing a task whose work you\'ve reviewed and want to reject (with PR cleanup), use lazy_reject.',
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
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing.',
      },
      accept_dirty_worktree: {
        type: 'boolean',
        description: 'Allow closing even if worktree has uncommitted changes. Use when you are certain you want to discard uncommitted work.',
      },
    },
    required: ['task_id', 'reason'],
  },
};

export function createCloseHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;
    const acceptDirtyWorktree = args.accept_dirty_worktree as boolean | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only close its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'close');

      // Step 2: validate confirmation code and execute
      if (confirmationCode) {
        if (!validateCode(confirmationCode, 'close', task.id)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_close without a code to get a new one.');
        }

        const params: CloseTaskParams = {
          taskId,
          reason: reason || '',
          acceptDirtyWorktree,
          actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
        };

        const result = await queryCloseTask(params);

        return {
          output: `Closed task ${result.displayId} (${result.branchName})`,
          taskId: result.taskId,
          displayId: result.displayId,
          branchName: result.branchName,
        };
      }

      // Step 1: evaluate confirmation level
      const session = await storage.getSessionByTaskId(task.id);
      let commitCount = 0;
      let linesChanged = 0;
      if (session) {
        const commits = await storage.getSessionCommits(session.id);
        commitCount = commits.length;
        linesChanged = await getDiffLinesChanged(task, session, storage);
      }

      const level = closeConfirmationLevel(task, commitCount);

      const code = generateCode('cl');
      storePending({ code, operation: 'close', taskId: task.id, createdAt: Date.now() });

      const context = gatherCloseContext(task, commitCount, linesChanged, code);
      const templateName = `close-${level}` as const;
      const guidance = renderGuidance(templateName, context);

      throw new Error(guidance);
    } finally {
      await storage.close();
    }
  };
}

// --- lazy_stop ---

export const stopTool: McpTool = {
  name: 'lazy_stop',
  description:
    'Halt a running task without auto-resume. The task transitions to ' +
    '\'blocked\', a human turn note records the stop reason, and a user-stopped ' +
    'flag prevents the reconciler from auto-resuming. Only \'working\' tasks can be ' +
    'stopped — use lazy_close or lazy_unblock for other statuses. ' +
    'To re-arm auto-resume and continue, call lazy_unblock. ' +
    'Use only when the agent is on the wrong path and you need time to think before redirecting; for routine pause, let it block naturally.',
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
        description: 'Why the task is being stopped (required, non-empty). Recorded as a human turn and surfaced in lazy_show.',
        minLength: 1,
      },
    },
    required: ['task_id', 'reason'],
  },
};

export function createStopHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;

    if (!reason || !reason.trim()) {
      throw new Error('lazy_stop requires a non-empty `reason`.');
    }

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      // INVARIANT: an agent may only stop its own task or a direct subtask.
      assertAgentMayTarget(ctx, resolved.task, 'stop');
    } finally {
      await storage.close();
    }

    const params: StopTaskParams = { taskId, reason: reason.trim(), actor: mcpActor(ctx) };
    const result = await queryStopTask(params);

    return {
      output: `Stopped task ${result.displayId}: ${result.reason}`,
      taskId: result.taskId,
      displayId: result.displayId,
      reason: result.reason,
    };
  };
}

// --- lazy_submit ---

export const submitTool: McpTool = {
  name: 'lazy_submit',
  description:
    'Submit a task for human review by creating a pull request. The task must be ' +
    'in blocked or conflict status with at least one commit. Transitions the task ' +
    'to submitted status. Only submitted tasks receive PR comment auto-react.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
    },
    required: ['task_id'],
  },
};

export function createSubmitHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;

    // INVARIANT: an agent may only submit its own task or a direct subtask.
    await gateAgentTarget(ctx, taskId, 'submit');

    const params: SubmitTaskParams = {
      taskId,
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    const result = await querySubmitTask(params);

    return {
      output: `Submitted task ${result.displayId}`,
      taskId: result.taskId,
      displayId: result.displayId,
      prUrl: result.prUrl,
    };
  };
}

// --- lazy_resume ---

export const resumeTool: McpTool = {
  name: 'lazy_resume',
  description:
    'Resume a blocked or interrupted task WITHOUT new feedback — the agent is ' +
    'relaunched with its existing prompt and context, and the turn is recorded ' +
    'as "[Resumed after interruption]". ' +
    'Use lazy_unblock instead whenever you actually have guidance to give: its ' +
    '"feedback" is required and must be non-empty (the CLI rejects empty ' +
    'feedback too), so lazy_unblock cannot express a no-feedback resume — this ' +
    'tool is the only call that does.',
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

      },
    },
    required: ['task_id'],
  },
};

export function createResumeHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const model = args.model as string | undefined;

    // INVARIANT: an agent may only resume its own task or a direct subtask.
    await gateAgentTarget(ctx, taskId, 'resume');

    // INVARIANT (an unblock can never revert a file the caller was refused
    // permission to approve — fix-ask-nukes-violations): resume routes through
    // unblock, which reverts unapproved file-permission violations, but
    // lazy_resume has no `approved_files` channel to express a decision. Refuse
    // on the pending SET (not on `task.status`, which a side-channel turn can
    // have relabelled) and point at the tool that CAN express the decision.
    const resumeStorage = await getStorage(ctx);
    try {
      const resolved = await resumeStorage.resolveTask(taskId);
      if (resolved.task) {
        const sess = await resumeStorage.getSessionByTaskId(resolved.task.id);
        const pending = sess ? pendingViolations(await resumeStorage.getSessionTurns(sess.id)) : [];
        if (pending.length > 0) {
          throw new Error(
            `Task ${taskId} has ${pending.length} pending file permission violation(s):\n` +
            pending.map(v => `  - ${v.file}`).join('\n') + '\n\n' +
            `lazy_resume cannot express an approve/revert decision, and resuming without one would ` +
            `revert the agent's committed changes to those files. Use lazy_unblock with "approved_files" instead ` +
            `(pass [] to revert all explicitly).`
          );
        }
      }
    } finally {
      await resumeStorage.close();
    }

    // Resume is like unblock but for interrupted tasks, without a feedback message.
    // Use unblock with a standard resume message.
    const params: UnblockTaskParams = {
      taskId,
      message: '[Resumed after interruption]',
      modelOverride: model,
      retargetOrphan: true,
      notesInEditor: false,
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    const result = await queryUnblockTask(params);

    // Same never-silent rule as lazy_unblock: surface whatever the daemon warned about.
    const resumeWarnings = result.warnings ?? [];
    return {
      output: [
        `Resumed task ${result.sessionId} on branch ${result.branchName}`,
        ...resumeWarnings.map(w => `WARNING: ${w}`),
      ].join('\n'),
      sessionId: result.sessionId,
      containerName: result.containerName,
      turnNumber: result.turnNumber,
      ...(resumeWarnings.length > 0 ? { warnings: resumeWarnings } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Working-substate decoration (shared by lazy_list / lazy_active)
// ---------------------------------------------------------------------------

/**
 * Derive the working-substate label (e.g. `agent`, `agent:answering`,
 * `waiting on fix-foo (2m10s)`, `harness:post_turn_check (3m00s)`,
 * `not-alive`) for a task, matching how the
 * CLI (`lazy list`/`active`/`status`) renders substates via the shared
 * derivation in `working-substate.ts`. Returns null for non-`working` tasks,
 * tasks without a session, or when no substate can be derived. Never throws —
 * a failed liveness probe degrades to no substate rather than failing the whole
 * listing.
 *
 * `runner` is created once per handler call and shared across the batch so we
 * don't spin up a runner per task.
 */
async function deriveTaskSubstateLabel(
  storage: Storage,
  runner: Runner,
  task: Task,
): Promise<string | null> {
  if (task.status !== 'working') return null;
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return null;

  let isAlive = false;
  try {
    const cn = session.container_name ?? runner.runNameForTask(taskRef(task));
    const info = await runner.getRunInfo(cn);
    isAlive = info?.running === true;
  } catch (err) {
    // Liveness probe is best-effort — degrade to no substate so one unreachable
    // runner never fails the whole listing.
    logger.debug(`lazy MCP: liveness probe failed for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
  }

  const substate = await computeWorkingSubstate(taskProtocolDir(task.id), isAlive);
  return substate ? formatWorkingSubstate(substate) : null;
}

/** Drain position of a queued task, for MCP list output. */
export interface QueueInfo {
  position: number;
  total: number;
}

/**
 * Attach a `substate` label and (for queued tasks) a `queue` drain position to
 * each task for MCP list output. Creates the runner once for the whole batch,
 * and only when at least one task is `working` (substate is null for everything
 * else), so listings with no working tasks skip runner setup entirely. Queue
 * positions are computed once against ALL queued tasks in the project so
 * "#N of M" is globally correct regardless of the filtered view.
 */
async function withSubstate<T extends { id: string; status: string }>(
  storage: Storage,
  tasks: Task[],
  shape: (task: Task, substate: string | null, queue: QueueInfo | null) => T,
): Promise<T[]> {
  const anyWorking = tasks.some(t => t.status === 'working');
  const runner = anyWorking ? await createRunner(requireLazyRoot()) : null;

  const queuePos = new Map<string, QueueInfo>();
  if (tasks.some(t => t.status === 'queued')) {
    const ordered = orderQueuedTasks(await storage.listTasksWithOptions({ queuedOnly: true }));
    ordered.forEach((t, i) => queuePos.set(t.id, { position: i + 1, total: ordered.length }));
  }

  return Promise.all(
    tasks.map(async t =>
      shape(
        t,
        runner ? await deriveTaskSubstateLabel(storage, runner, t) : null,
        t.status === 'queued' ? queuePos.get(t.id) ?? null : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Depth scoping (shared by lazy_list / lazy_active)
// ---------------------------------------------------------------------------

/** Schema fragment for the `levels` depth limit, identical on both listing tools. */
const LEVELS_PROPERTY = {
  type: 'integer' as const,
  description:
    'Show only the first N levels of the hierarchy (1-based: 1 = top-level tasks ' +
    'only, 2 = those plus their children). Levels are counted from the tasks this ' +
    'listing returns, so with "task_id" that task is level 1. Composes with ' +
    '"task_id" — both apply. Tasks omitted by the limit are reported as ' +
    '"hidden_descendants" on the deepest task returned, and totalled as ' +
    '"hidden_count", so a depth-limited listing never looks complete when it is not.',
};

/** Validate the MCP `levels` argument (absent → no limit). */
function parseLevelsArg(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `'levels' must be a positive integer (1 = top-level tasks only), got '${String(raw)}'.`,
    );
  }
  return value;
}

/**
 * Apply a depth limit to a flat task list for MCP output, returning both the
 * surviving tasks and the elision bookkeeping the response must carry.
 */
function applyLevels(
  tasks: Task[],
  levels: number | undefined,
): { tasks: Task[]; hidden: Map<string, number>; hiddenTotal: number } {
  if (levels === undefined) return { tasks, hidden: new Map(), hiddenTotal: 0 };
  const pruned = pruneTasksToDepth(tasks, levels);
  return { tasks: pruned.kept, hidden: pruned.hidden, hiddenTotal: pruned.hiddenTotal };
}

/**
 * Attach `hidden_descendants` to each task of a depth-limited listing. Absent
 * entirely when no limit was asked for, so an unlimited listing's shape is
 * exactly what it always was.
 */
function withHiddenCounts<T extends { id: string }>(
  rows: T[],
  hidden: Map<string, number>,
  levels: number | undefined,
): T[] {
  if (levels === undefined) return rows;
  // `hidden` is keyed by full task id; rows carry the short id.
  const byShortId = new Map([...hidden].map(([id, n]) => [shortId(id), n]));
  return rows.map(row => ({ ...row, hidden_descendants: byShortId.get(row.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// lazy_list
// ---------------------------------------------------------------------------

export const listTool: McpTool = {
  name: 'lazy_list',
  description:
    'List tasks in the lazy project. By default shows non-terminal tasks. ' +
    'Use "all" to include completed/closed tasks. Use "task_id" to narrow the ' +
    "listing to one task's subtree — that task plus ALL its descendants " +
    '(children, grandchildren, ...), the same scope `lazy list <id>` uses. ' +
    'Each task includes its status and, for working ' +
    'tasks, a derived substate (e.g. "agent:answering", "waiting on fix-foo" when ' +
    'the agent is blocked on a subtask, "harness:post_turn_check", ' +
    '"not-alive"). When the agent has posted a progress line via ' +
    'lazy_update_progress, it is appended to the substate ' +
    '("agent: running migration 3/7").',
  inputSchema: {
    type: 'object',
    properties: {
      all: {
        type: 'boolean',
        description: 'Include terminal tasks (complete, abandoned, closed). Honored with or without task_id.',
      },
      task_id: {
        type: 'string',
        description:
          "Filter to this task's subtree: the task itself and all its descendants " +
          '(short hex prefix or code)',
      },
      levels: LEVELS_PROPERTY,
    },
  },
};

export function createListHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const showAll = args.all as boolean | undefined;
    const taskIdInput = args.task_id as string | undefined;
    const levels = parseLevelsArg(args.levels);

    const storage = await getStorage(ctx);
    try {
      // Same scope rules as `lazy list [<id>]` (daemon handleList): `all`
      // decides WHICH tasks are in play, `task_id` narrows them to a SUBTREE.
      // The two are independent — `all` used to be ignored whenever task_id was
      // present, so an agent asking for a subtree's completed subtasks got a
      // silently non-terminal-only answer.
      let tasks = showAll
        ? await storage.listTasks()
        : await storage.listTasksWithOptions({ nonTerminalOnly: true });

      if (taskIdInput) {
        tasks = await filterToSubtree(storage, tasks, taskIdInput);
      }

      // Depth limit applies AFTER the subtree filter, so both scopings compose
      // (`task_id` + `levels: 1` = that task alone) instead of one winning.
      const pruned = applyLevels(tasks, levels);
      tasks = pruned.tasks;

      return {
        count: tasks.length,
        ...(levels === undefined ? {} : { hidden_count: pruned.hiddenTotal }),
        tasks: withHiddenCounts(await withSubstate(storage, tasks, (t, substate, queue) => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          status: t.status,
          // Working-substate (e.g. `agent:answering`, `waiting on fix-foo`) so a `working` task's
          // actual activity is visible; null for non-working tasks.
          substate,
          priority: t.priority,
          // Drain position for a `queued` task ({position,total}); null otherwise.
          queue,
          agent: t.agent_id,
          model: t.model ?? null,
          parent_task_id: parentTaskIdOf(t) ? shortId(parentTaskIdOf(t)!) : null,
        })), pruned.hidden, levels),
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

export function createBlockedHandler(ctx: McpToolContext): McpToolHandler {
  return async (_args) => {
    const storage = await getStorage(ctx);
    try {

      const tasks = await storage.listTasksWithOptions({ blockedOnly: true });

      return {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          agent: t.agent_id,
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
    'List all non-terminal tasks (working, blocked, interrupted, conflict, etc.) ' +
    'with active sessions. These are tasks currently being worked on or awaiting input. ' +
    'Each task includes its status and, for working tasks, a derived substate ' +
    '(e.g. "agent:answering" while an ask is in flight, "agent:pre-accept" during ' +
    'an accept\'s validation turn, "waiting on fix-foo" while the agent is blocked ' +
    'in lazy_wait on a subtask, "harness:post_turn_check", ' +
    '"not-alive") so you can see what each active task is actually doing — ' +
    "with the agent's own latest progress line appended when it posted one " +
    '("agent: running migration 3/7"). ' +
    'Pass "task_id" to narrow the listing to one task\'s subtree — that task plus ' +
    'ALL its descendants (children, grandchildren, ...), the same scope ' +
    'lazy_list\'s "task_id" uses. Pass "levels" to cap how deep the listing goes ' +
    '— "levels": 1 shows only top-level tasks, which is how you observe a busy ' +
    'project without every descendant of every release hub.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          "Filter to this task's subtree: the task itself and all its descendants " +
          '(short hex prefix or code)',
      },
      levels: LEVELS_PROPERTY,
    },
  },
};

export function createActiveHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string | undefined;
    const levels = parseLevelsArg(args.levels);
    const storage = await getStorage(ctx);
    try {

      const active = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
      // Queued tasks have no session yet (gated before session creation), so
      // `withSessionsOnly` misses them — but a task waiting for a slot is
      // in-flight and MUST be visible in `active` with its queue position.
      const queued = await storage.listTasksWithOptions({ queuedOnly: true });
      const seen = new Set(active.map(t => t.id));
      let tasks = [...active, ...queued.filter(t => !seen.has(t.id))];

      if (taskIdInput) {
        // Subtree closure is computed against ALL tasks, not just the active
        // ones: a terminal task in the middle of the hierarchy must not hide
        // its still-active descendants. Shared with lazy_list and the daemon's
        // list/active handlers so "subtree" means one thing everywhere.
        tasks = await filterToSubtree(storage, tasks, taskIdInput);
      }

      // Depth limit applies AFTER the subtree filter so the two compose (see
      // createListHandler and the daemon's handleActive).
      const pruned = applyLevels(tasks, levels);
      tasks = pruned.tasks;

      return {
        count: tasks.length,
        ...(levels === undefined ? {} : { hidden_count: pruned.hiddenTotal }),
        tasks: withHiddenCounts(await withSubstate(storage, tasks, (t, substate, queue) => ({
          id: shortId(t.id),
          code: t.code ?? null,
          goal: t.goal,
          status: t.status,
          // Working-substate (e.g. `agent:answering`, `waiting on fix-foo`) so an active task's actual
          // activity is visible; null for non-working tasks.
          substate,
          priority: t.priority,
          // Drain position for a `queued` task ({position,total}); null otherwise.
          queue,
          agent: t.agent_id,
          model: t.model ?? null,
          // Parent link so a subtree listing can be reassembled into a hierarchy.
          parent_task_id: parentTaskIdOf(t) ? shortId(parentTaskIdOf(t)!) : null,
        })), pruned.hidden, levels),
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
    'Show changes made by a task, against the same base ref `lazy diff` uses. ' +
    'Returns a diff stat summary by default, ' +
    'or the full diff with "full" flag. Use "files" to filter to specific ' +
    'paths, "offset" to skip lines, and "max_lines" to truncate output. ' +
    'Combine offset and max_lines to paginate through large diffs. ' +
    'Comments added since the last agent turn appear as a trailing ' +
    '"diff --lazy a/comments b/comments" section.',
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
      offset: {
        type: 'number',
        description: 'Skip first N lines of diff output before applying max_lines (default: 0)',
      },
      max_lines: {
        type: 'number',
        description: 'Truncate diff output to N lines. Response includes truncated flag and total_lines.',
      },
    },
    required: ['task_id'],
  },
};

/**
 * Apply lazy_diff's offset / max_lines pagination to a rendered diff.
 *
 * Exported so the unit suite tests the REAL slicing rather than a copy of it
 * (a copy passes happily while the handler drifts away from it).
 */
function applyDiffPagination(
  diffOutput: string,
  offset: number,
  maxLines: number | undefined,
): { diff: string; total_lines?: number; truncated?: boolean; offset?: number } {
  const result: Record<string, unknown> = {};

  if (offset > 0 || (maxLines !== undefined && maxLines > 0)) {
    const lines = diffOutput.split('\n');
    result.total_lines = lines.length;

    // Skip first N lines
    const remaining = lines.slice(Math.min(offset, lines.length));

    // Then apply max_lines cap
    if (maxLines !== undefined && maxLines > 0 && remaining.length > maxLines) {
      diffOutput = remaining.slice(0, maxLines).join('\n');
      result.truncated = true;
    } else {
      diffOutput = remaining.join('\n');
      result.truncated = false;
    }

    if (offset > 0) {
      result.offset = offset;
    }
  }

  result.diff = diffOutput;
  return result as { diff: string; total_lines?: number; truncated?: boolean; offset?: number };
}

/**
 * lazy_diff — the diff itself is computed by the daemon's handleDiff, the SAME
 * code path `lazy diff` uses.
 *
 * There used to be a second implementation here that derived its own base ref
 * and fell back to the literal branch name 'main' for any top-level task or any
 * task whose parent session was missing. On a repo whose default branch is not
 * `main`, or a task targeting a release branch, that silently diffed against
 * the wrong ref — and it also skipped worktree recovery and never showed
 * comments. Routing through the RPC removes the whole class: base-ref
 * resolution, worktree recovery and the comments section live in one place.
 *
 * What stays here is what is genuinely MCP's: the agent-ownership gate (which
 * the CLI deliberately does not have) and offset/max_lines pagination of the
 * rendered output.
 */
export function createDiffHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const full = args.full as boolean | undefined;
    const files = args.files as string[] | undefined;
    const offset = (args.offset as number | undefined) ?? 0;
    const maxLines = args.max_lines as number | undefined;

    // INVARIANT: an agent may only diff its own task or a direct subtask.
    // Resolve-and-gate before the diff runs; the builder skips the lookup.
    await gateAgentTarget(ctx, taskIdInput, 'diff');

    const { output, diffRange, taskId } = await queryDiff({
      taskId: taskIdInput,
      full,
      files,
      // An agent cannot always shell out — point it at the tool call.
      surface: 'mcp',
    });

    return {
      task_id: taskId,
      diff_range: diffRange,
      full: !!full,
      ...applyDiffPagination(output, offset, maxLines),
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_wait
// ---------------------------------------------------------------------------

export const waitTool: McpTool = {
  name: 'lazy_wait',
  description:
    'Wait for a task to finish its current turn. Polls until the task ' +
    'leaves "working" status or timeout is reached. Pass an ARRAY of task IDs ' +
    'to race several tasks at once — the call returns as soon as the FIRST one ' +
    'finishes and tells you which task that was, so you never sit blocked on a ' +
    'slow task while a faster one is already ready for review. The other tasks ' +
    'keep running; wait on them again afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        // A single string is the original shape and still works — existing
        // callers and prompts must not break.
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'Task ID (short hex prefix or code), or an array of task IDs to race. ' +
          'With an array, the call returns when the first of them finishes.',
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

export function createWaitHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const raw = args.task_id;
    const taskIdInputs = (Array.isArray(raw) ? raw : [raw]).map(v => {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new RpcError(400, 'taskId is required: task_id must be a task reference or an array of task references');
      }
      return v.trim();
    });
    if (taskIdInputs.length === 0) {
      throw new RpcError(400, 'taskId is required: task_id must name at least one task');
    }
    const timeoutSecs = Math.min((args.timeout as number | undefined) ?? 600, 600);

    // INVARIANT: an agent may only wait on its own task or a direct subtask.
    // Every reference is gated — racing a set must not be a way to observe a
    // task outside the agent's subtree.
    for (const input of taskIdInputs) {
      await gateAgentTarget(ctx, input, 'wait on');
    }

    const result = await queryWait(
      taskIdInputs.length === 1
        ? { taskId: taskIdInputs[0], timeout: timeoutSecs }
        : { taskIds: taskIdInputs, timeout: timeoutSecs },
    );

    const shorten = (t: { task_id: string; display_id: string; code: string | null; status: string }) => ({
      task_id: shortId(t.task_id),
      display_id: t.display_id,
      status: t.status,
    });

    // INVARIANT (fix-sync-silent-conflict): a wait that settles on a task whose
    // worktree is mid-merge says so. This is the exact surface that reported the
    // stranded release hub as a normal `blocked` — the caller then went straight
    // to accept and hit a misleading "uncommitted changes" refusal instead. The
    // daemon computes it (one source of truth for CLI and MCP alike).
    const mergeState = result.merge_state ?? null;

    return {
      task_id: shortId(result.task_id),
      display_id: result.display_id,
      status: result.status,
      timed_out: result.timed_out,
      ...(mergeState ? { merge_state: mergeState } : {}),
      // Which tasks are still running — so the caller can wait on them next.
      tasks: (result.tasks ?? []).map(shorten),
      pending: (result.pending ?? []).map(shorten),
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_edit
// ---------------------------------------------------------------------------

export const editTool: McpTool = {
  name: 'lazy_edit',
  description:
    'Edit a task\'s goal, prompt, model, effort, type, code, parent, or agent. ' +
    'Goal/prompt/type/code/parent edits only work on tasks that have not been ' +
    'started by an agent (no turns); model, effort, and agent edits are also ' +
    'allowed on started tasks. When switching agents mid-task, the session is ' +
    'reset (cannot resume across agents), but the task\'s conversation history ' +
    'is preserved.',
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

      },
      effort: {
        type: 'string',
        description:
          'New reasoning effort for the next turn. PERSISTS on the task. ' +
          'Editable on started tasks, like model.',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
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
      agent: {
        type: 'string',
        description:
          'New agent to use for this task (e.g. claude-code, cursor). ' +
          'Editable on started tasks. When switching agents mid-task, the ' +
          'session is reset (cannot resume across agents).',
      },
    },
    required: ['task_id'],
  },
};

export function createEditHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const goal = args.goal as string | undefined;
    const prompt = args.prompt as string | undefined;
    const model = args.model as string | undefined;
    const type = args.type as string | undefined;
    const code = args.code as string | undefined;
    const parent = args.parent as string | undefined;
    const effort = args.effort as string | undefined;
    const agent = args.agent as string | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only edit its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'edit');
      // INVARIANT: agents may not reparent via lazy_edit — that is the
      // lazy_reparent backdoor. Changing a task's parent is a builder/human
      // operation. (Agents may still refine a subtask's goal/prompt/etc.)
      if (ctx.taskId && parent !== undefined) {
        throw new Error(
          'Agents cannot change a task\'s parent. Reparenting is a builder/human ' +
          'operation. Create subtasks with lazy_create (they are parented to your ' +
          'own task automatically).',
        );
      }

      // Check terminal status
      const terminalStatuses = new Set(['complete', 'abandoned']);
      if (terminalStatuses.has(task.status)) {
        throw new Error(`Cannot edit task in ${task.status} status`);
      }

      // Validate agent if provided
      if (agent !== undefined) {
        const validAgents = listAgents();
        if (!validAgents.includes(agent)) {
          throw new Error(`Unknown agent '${agent}'. Available agents: ${validAgents.join(', ')}`);
        }
      }

      // Check no turns (agent hasn't started working). Exception: model,
      // effort, and agent edits are safe mid-flight — they are per-turn dials
      // that take effect on the next turn without changing the task's work
      // definition. Same relaxation as the `lazy edit` CLI.
      const turnCount = await storage.getTurnCountByTaskId(task.id);
      const isMidFlightSafeEdit = (model !== undefined || effort !== undefined || agent !== undefined)
        && goal === undefined && prompt === undefined
        && type === undefined && code === undefined && parent === undefined;
      if (turnCount > 0 && !isMidFlightSafeEdit) {
        throw new Error('Cannot edit task after agent has started working (has turns); only model and effort can be changed on a started task (agent too, but only on its own — not combined with a goal/prompt/type/code/parent edit)');
      }

      if (effort !== undefined && !VALID_EFFORT_LEVELS.includes(effort as EffortLevel)) {
        throw new Error(`Invalid effort '${effort}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
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

      if (effort !== undefined) {
        // Same metadata slot resolveAndPersistEffort writes on every launch.
        await storage.updateTaskMetadata(task.id, 'effort', effort);
        changes.push('effort');
      }

      if (agent !== undefined) {
        // Update task agent
        await storage.updateTaskAgent(task.id, agent);
        // If a session exists, update it too (clears agent_session_id)
        const sess = await storage.getSessionByTaskId(task.id);
        if (sess) {
          await storage.updateSessionAgent(sess.id, agent);
        }
        changes.push('agent');
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
          // Clear parent → top-level, integrating into main.
          await storage.updateTaskTarget(task.id, branchTarget('main'));
        } else {
          const parentResolved = await storage.resolveTask(parent);
          if (!parentResolved.task) {
            throw new Error(`Parent task not found: ${parent}`);
          }
          await storage.updateTaskTarget(task.id, taskTarget(parentResolved.task.id));
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

      },
    },
    required: ['task_id'],
  },
};

export function createCloneHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    // INVARIANT: lazy_clone is NOT available to agents. A clone is created as a
    // child of the SOURCE task — so cloning a direct subtask would manufacture a
    // grandchild, which is outside the "agents create only direct children of
    // their own task" boundary, and cloning the agent's own task is just a
    // worse lazy_create. There is no parameter by which the agent constrains the
    // clone's parent, so (like lazy_reparent) it stays a builder/human tool.
    // Agents spin off new work with lazy_create instead.
    if (ctx.taskId) {
      throw new Error(
        'Agents cannot clone tasks. Cloning creates a task whose parent is the ' +
        'source task, which can fall outside your subtree. Use lazy_create to ' +
        'spin off a subtask of your own task instead.',
      );
    }

    const taskIdInput = args.task_id as string;
    const goalOverride = args.goal as string | undefined;
    const promptOverride = args.prompt as string | undefined;
    const code = args.code as string | undefined;
    const model = args.model as string | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const parent = resolved.task;

      const goal = goalOverride ?? `${parent.goal} (variant)`;

      // Create child task. It is a variant of the parent's work, so it runs on
      // the parent's agent rather than the project default.
      const childAgentId = resolveAgentForNewTask({
        inheritFrom: parent,
        configDefault: (await loadConfig(requireLazyRoot())).agent.agent_id,
      });
      const child = await storage.createTask(goal, parent.id, undefined, code, undefined, childAgentId, mcpActor(ctx)); // channel actor on the initial backlog entry: 'builder' or 'agent'

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
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing.',
      },
    },
    required: ['task_id'],
  },
};

export function createReopenHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskIdInput = args.task_id as string;
    const reason = args.reason as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const task = resolved.task;
      // INVARIANT: an agent may only reopen its own task or a direct subtask.
      assertAgentMayTarget(ctx, task, 'reopen');

      const terminalStatuses = new Set(['complete', 'abandoned']);
      if (!terminalStatuses.has(task.status)) {
        throw new Error(`Task is in ${task.status} status — can only reopen terminal tasks`);
      }

      // Step 2: validate confirmation code and execute
      if (confirmationCode) {
        if (!validateCode(confirmationCode, 'reopen', task.id)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_reopen without a code to get a new one.');
        }

        if (task.status === 'complete' && !reason) {
          throw new Error('A reason is required to reopen a completed task');
        }

        if (reason) {
          await storage.createComment(task.id, `[Reopened] ${reason}`, mcpActor(ctx));
        }

        await storage.reopenTask(task.id, mcpActor(ctx));

        const session = await storage.getSessionByTaskId(task.id);
        const newStatus = session ? 'blocked' : 'backlog';
        await storage.updateTaskStatus(task.id, newStatus, mcpActor(ctx));

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
      }

      // Step 1: evaluate confirmation level
      const level = reopenConfirmationLevel(task);

      // Reopen is always at least light, so always require confirmation
      const code = generateCode('ro');
      storePending({ code, operation: 'reopen', taskId: task.id, createdAt: Date.now() });

      const context = gatherReopenContext(task, code);
      // Light level uses no specific template — use a simple inline guidance
      // Standard level (reopening completed task) uses reopen-standard template
      const templateName = level === 'standard' ? 'reopen-standard' : null;

      let guidance: string;
      if (templateName) {
        guidance = renderGuidance(templateName, context);
      } else {
        guidance = `Reopening task \`${context.task_code}\`. To proceed, call \`lazy_reopen\` again with confirmation_code: "${code}"`;
      }

      throw new Error(guidance);
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
    'Close a stale task and create a fresh replacement of it. The replacement ' +
    'is created under the SAME parent as the old task — a redo of a release-hub ' +
    'child lands under that same hub, NOT on main — and its base ref is only ' +
    'resolved when it starts, so it branches from that parent\'s current HEAD. ' +
    'Carries over goal and prompt. Does NOT auto-start, deliberately: that gap ' +
    'is where you fix anything the replacement should not inherit. If the work ' +
    'belongs somewhere else now, move it BEFORE calling lazy_start — once the ' +
    'task starts its branch is cut from whatever parent it had. Use ' +
    'lazy_reparent to point it at another task or a raw branch such as main, ' +
    'or lazy_edit with parent="" to make it top-level.',
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

      },
      confirmation_code: {
        type: 'string',
        description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing.',
      },
    },
    required: ['task_id'],
  },
};

export function createRedoHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    // INVARIANT: lazy_redo is NOT available to agents. Redo abandons a task and
    // creates a replacement parented at the SAME parent as the original — so
    // redoing the agent's own task would manufacture a replacement under the
    // agent's parent (outside its subtree). There is no parameter by which the
    // agent constrains the replacement's parent, so (like lazy_reparent /
    // lazy_clone) it stays a builder/human tool. To restart a subtask's work,
    // an agent can lazy_close it and lazy_create a fresh one.
    if (ctx.taskId) {
      throw new Error(
        'Agents cannot redo tasks. Redo creates a replacement task parented ' +
        'outside your subtree. To restart, close the subtask and lazy_create a ' +
        'new one under your own task instead.',
      );
    }

    const taskIdInput = args.task_id as string;
    const promptOverride = args.prompt as string | undefined;
    const model = args.model as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskIdInput);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskIdInput}`);
      }
      const oldTask = resolved.task;

      // Cannot redo completed (merged) tasks
      if (oldTask.status === 'complete') {
        throw new Error('Cannot redo a completed (merged) task');
      }

      // Step 2: validate confirmation code and execute
      if (confirmationCode) {
        if (!validateCode(confirmationCode, 'redo', oldTask.id)) {
          throw new Error('Invalid or expired confirmation code. Call lazy_redo without a code to get a new one.');
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

        // Create new task. A redo is a second attempt at the SAME work, so it
        // carries the original's agent over rather than the project default.
        const newTask = await storage.createTask(
          oldTask.goal,
          parentTaskIdOf(oldTask) ?? undefined,
          undefined,
          redoCode || undefined,
          undefined,
          resolveAgentForNewTask({
            inheritFrom: oldTask,
            configDefault: (await loadConfig(requireLazyRoot())).agent.agent_id,
          }),
          // channel actor on the initial backlog entry: 'builder' or 'agent'
          mcpActor(ctx),
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

        // Abandon the old task
        await storage.abandonTask(oldTask.id, `Redone as ${shortId(newTask.id)}`, MCP_ACTOR);

        return {
          old_task_id: shortId(oldTask.id),
          new_task_id: shortId(newTask.id),
          new_task_code: newTask.code ?? null,
          goal: newTask.goal,
          status: newTask.status,
          message: 'New task created. Call lazy_start to begin work.',
        };
      }

      // Step 1: evaluate confirmation level based on commit count
      const session = await storage.getSessionByTaskId(oldTask.id);
      let commitCount = 0;
      if (session) {
        const commits = await storage.getSessionCommits(session.id);
        commitCount = commits.length;
      }

      const level = redoConfirmationLevel(commitCount);

      const code = generateCode('rd');
      storePending({ code, operation: 'redo', taskId: oldTask.id, createdAt: Date.now() });

      const context = gatherRedoContext(oldTask, commitCount, code);
      const templateName = level === 'stern' ? 'redo-stern' : 'redo-standard';
      const guidance = renderGuidance(templateName, context);

      throw new Error(guidance);
    } finally {
      await storage.close();
    }
  };
}

// ---------------------------------------------------------------------------
// lazy_sync
// ---------------------------------------------------------------------------

export const syncTool: McpTool = {
  name: 'lazy_sync',
  description:
    'Sync a task\'s worktree with its upstream (parent) branch. Merges ' +
    'upstream changes without running an agent work phase. Task must be ' +
    'blocked, conflict, or interrupted (not working).',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
    },
    required: ['task_id'],
  },
};

export function createSyncHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;

    // INVARIANT: an agent may only sync its own task or a direct subtask.
    await gateAgentTarget(ctx, taskId, 'sync');

    const params: SyncTaskParams = {
      taskId,
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    const result = await querySyncTask(params);

    return {
      output: result.message,
      taskId: result.taskId,
      displayId: result.displayId,
      status: result.status,
      warnings: result.warnings,
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_reparent
// ---------------------------------------------------------------------------

export const reparentTool: McpTool = {
  name: 'lazy_reparent',
  description:
    'Repoint a task to a new parent and merge that parent into the task\'s ' +
    'branch. Use this when a task was created on the wrong parent (e.g. ' +
    'branched from main when it should have been on a release branch). ' +
    'Reparent KEEPS the task — same session, turns, commits, and branch — and ' +
    'only changes its parent pointer, then runs a sync so the task\'s own ' +
    'agent merges the new parent in (resolving conflicts in place). The task ' +
    'must not be currently working; terminal tasks must be reopened first.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code) to reparent',
        minLength: 1,
      },
      parent: {
        type: 'string',
        description: 'New parent: a task code, short ID, or a raw branch name (e.g. "main")',
        minLength: 1,
      },
    },
    required: ['task_id', 'parent'],
  },
};

export function createReparentHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    // INVARIANT: Agents may NOT reparent any task. Reparenting can move a task
    // out from under (or onto) any parent, which would let an agent escape the
    // "subtasks of my own task only" boundary that lazy_create / lazy_start
    // enforce. A non-empty ctx.taskId means an agent is the caller — reject.
    // Reparent stays a builder/human operation (ctx.taskId === '').
    if (ctx.taskId) {
      throw new Error(
        'Agents cannot reparent tasks. Reparenting is a builder/human operation. ' +
        'Agents may only create and start subtasks of their own task.',
      );
    }

    const taskId = args.task_id as string;
    const parent = args.parent as string;

    const params: ReparentTaskParams = {
      taskId,
      parent,
      actor: mcpActor(ctx), // MCP boundary → 'builder' (project-wide) or 'agent' (task-scoped)
    };

    const result = await queryReparentTask(params);

    return {
      output: result.message,
      taskId: result.taskId,
      displayId: result.displayId,
      status: result.status,
      syncStatus: result.syncStatus,
      newParent: result.newParent,
      warnings: result.warnings,
    };
  };
}

// ---------------------------------------------------------------------------
// lazy_prioritize
// ---------------------------------------------------------------------------

export const prioritizeTool: McpTool = {
  name: 'lazy_prioritize',
  description:
    "Set a task's queue priority. When the concurrency cap is hit, new starts " +
    'queue; as agent slots free up the daemon launches the highest-priority ' +
    'queued task first (ties break FIFO — oldest queued first). This is a ' +
    'durable task edit, not a scheduler. Terminal tasks cannot be edited.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID (short hex prefix or task code)',
        minLength: 1,
      },
      priority: {
        type: 'string',
        description: 'Queue priority',
        enum: ['low', 'normal', 'high', 'urgent'],
      },
    },
    required: ['task_id', 'priority'],
  },
};

export function createPrioritizeHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const priority = args.priority as string;

    if (!VALID_TASK_PRIORITIES.includes(priority as TaskPriority)) {
      throw new Error(`Invalid priority '${priority}'. Must be one of: ${VALID_TASK_PRIORITIES.join(', ')}`);
    }

    const storage = await getStorage(ctx);
    try {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      await storage.updateTaskPriority(resolved.task.id, priority);
      const label = resolved.task.code ?? shortId(resolved.task.id);
      return {
        output: `${label} priority set to ${priority}.`,
        taskId: shortId(resolved.task.id),
        priority,
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
  tagTool,
  untagTool,
  journalTool,
  memorySaveTool,
  memoryRecallTool,
  addFollowUpTool,
  updateProgressTool,
  commitTool,
  statusTool,
  conversationsTool,
  conversationSearchTool,
  conversationReadTool,
  conversationAskTool,
  startTool,
  unblockTool,
  askTool,
  acceptTool,
  rejectTool,
  closeTool,
  stopTool,
  submitTool,
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
  syncTool,
  reparentTool,
  prioritizeTool,
];

/**
 * Free-text MCP arguments that get rendered into an agent prompt or shown to a
 * human as prose. These are annotated when sanitized, so the substitution is
 * visible rather than a silent rewrite of what the caller wrote.
 */
const ANNOTATED_TEXT_ARGS = new Set([
  'feedback', 'message', 'prompt', 'note', 'reason', 'question', 'goal_context',
]);

/**
 * INTAKE BOUNDARY for every MCP tool call.
 *
 * MCP travels as JSON, and a JSON `\u0000` escape decodes to a real NUL. Any NUL that
 * reaches a prompt ends up as argv[2] of `claude -p`, where it kills the spawn
 * instantly — crash-looping the turn and (because auto-resume restarts with a
 * generic prompt) silently losing the feedback. Escape at the door instead.
 *
 * Sanitize-and-deliver, never reject: rejecting here would throw away a
 * builder's feedback at the moment it was written. See
 * src/utils/sanitize-text.ts for the full rationale.
 *
 * Applied to every handler uniformly so a newly added tool is covered by
 * default rather than by remembering to opt in.
 *
 * Nested values are covered too: several tools take string arrays (`files`,
 * `approved_files`) whose elements become git argv, so a NUL inside an array
 * element is just as fatal as one at the top level. Nested strings are never
 * annotated — they are identifiers and paths, not prose, and appending a
 * paragraph of explanation to a file path would corrupt it.
 */
function sanitizeNested(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUserText(value, { annotate: false });
  if (Array.isArray(value)) return value.map(sanitizeNested);
  // Plain objects only — leave class instances and null alone rather than
  // reconstructing something we don't understand.
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) nested[k] = sanitizeNested(v);
    return nested;
  }
  return value;
}

function sanitizeMcpArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string'
      ? sanitizeUserText(value, { annotate: ANNOTATED_TEXT_ARGS.has(key) })
      : sanitizeNested(value);
  }
  return out;
}

/** Wrap a handler so its arguments are sanitized before it ever runs. */
function withSanitizedArgs(handler: McpToolHandler): McpToolHandler {
  return (args: Record<string, unknown>) => handler(sanitizeMcpArgs(args ?? {}));
}

/**
 * Create all tool handlers with the given context.
 *
 * Every handler is wrapped with `withSanitizedArgs` — see `sanitizeMcpArgs`.
 */
export function createAllHandlers(ctx: McpToolContext): Map<string, McpToolHandler> {
  const raw = new Map<string, McpToolHandler>();
  const handlers = {
    set(name: string, handler: McpToolHandler) {
      raw.set(name, withSanitizedArgs(handler));
      return this;
    },
  };
  handlers.set('lazy_search', createSearchHandler(ctx));
  handlers.set('lazy_show', createShowHandler(ctx));
  handlers.set('lazy_create', createCreateHandler(ctx));
  handlers.set('lazy_comment', createCommentHandler(ctx));
  handlers.set('lazy_tag', createTagHandler(ctx));
  handlers.set('lazy_untag', createUntagHandler(ctx));
  handlers.set('lazy_journal', createJournalHandler(ctx));
  handlers.set('lazy_memory_save', createMemorySaveHandler(ctx));
  handlers.set('lazy_memory_recall', createMemoryRecallHandler(ctx));
  handlers.set('lazy_add_followup', createAddFollowUpHandler(ctx));
  handlers.set('lazy_update_progress', createUpdateProgressHandler(ctx));
  handlers.set('lazy_commit', createCommitHandler(ctx));
  handlers.set('lazy_status', createStatusHandler(ctx));
  handlers.set('lazy_conversations', createConversationsHandler(ctx));
  handlers.set('lazy_conversation_search', createConversationSearchHandler(ctx));
  handlers.set('lazy_conversation_read', createConversationReadHandler(ctx));
  handlers.set('lazy_conversation_ask', createConversationAskHandler(ctx));
  handlers.set('lazy_start', createStartHandler(ctx));
  handlers.set('lazy_unblock', createUnblockHandler(ctx));
  handlers.set('lazy_ask', createAskHandler(ctx));
  handlers.set('lazy_accept', createAcceptHandler(ctx));
  handlers.set('lazy_reject', createRejectHandler(ctx));
  handlers.set('lazy_close', createCloseHandler(ctx));
  handlers.set('lazy_stop', createStopHandler(ctx));
  handlers.set('lazy_submit', createSubmitHandler(ctx));
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
  handlers.set('lazy_sync', createSyncHandler(ctx));
  handlers.set('lazy_reparent', createReparentHandler(ctx));
  handlers.set('lazy_prioritize', createPrioritizeHandler(ctx));
  // INVARIANT: lazy_internal_git is registered here but deliberately absent
  // from `allTools` — it must never be advertised to, or pre-approved for, an
  // agent. It exists so the SUPERVISOR can ask the daemon to perform the few
  // ref-writing git operations its sync phase needs, now that the container
  // mounts the git common dir read-only. See src/mcp/internal-git.ts.
  handlers.set(INTERNAL_GIT_TOOL_NAME, createInternalGitHandler(ctx));
  return raw;
}
