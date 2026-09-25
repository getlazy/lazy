import type { TaskType } from '../types';
import type { ResolvedConfig } from '../config/types';
import type { ProjectSettings } from '../storage/types';
import type { Storage } from '../storage/interface';
import { resolveProjectAgent } from '../daemon/project-settings';

/** Where a newly created task's agent id came from. */
export type AgentResolutionSource = 'explicit' | 'inherit' | 'by_type' | 'default';

export interface AgentResolution {
  agentId: string;
  source: AgentResolutionSource;
  /** Present when `source` is `by_type`. */
  taskType?: TaskType;
}

/**
 * Which agent should a NEWLY CREATED task run on?
 *
 * This exists because the storage layer is not a safe place to decide it.
 * `Storage.createTask()` stamps `agent_id: agentId ?? 'claude-code'` (see
 * `file-storage.ts`), so a caller that passes nothing
 * does not leave the field open for the project default to fill in later — it
 * silently pins the new task to Claude Code, forever. Storage cannot fix that
 * itself: resolving the default requires lazy.toml, and a storage backend has
 * no business loading project config.
 *
 * So every creation path has to decide explicitly, and this is the one place
 * that decision lives. Call it wherever a task is created.
 *
 * Precedence, highest first:
 *   1. `explicit`     — the user said so (`--agent`, or the MCP `agent` field).
 *   2. `inheritFrom`  — the task this one is DERIVED from (clone source, redo
 *                       original, parent of a subtask). A clone of a Cursor
 *                       task is still a Cursor task; the project default must
 *                       not quietly retarget it.
 *   3. `byType`       — `[agent.by_type]` for the task's type (when set).
 *   4. `configDefault`— the project default: overlay `defaultAgent` when set,
 *                       else `[agent] agent_id` in lazy.toml.
 */
export function resolveAgentForNewTask(opts: {
  /** An explicit user choice, if one was given. Already validated by the caller. */
  explicit?: string | null;
  /** The task this one is derived from, for clone/redo/subtask. */
  inheritFrom?: { agent_id?: string | null } | null;
  /** Task type being created. Defaults to `task` when omitted. */
  taskType?: TaskType | null;
  /** Resolved `[agent.by_type]` from lazy.toml. */
  byType?: Partial<Record<TaskType, string>>;
  /** The project's configured default (`config.agent.agent_id`). */
  configDefault: string;
}): AgentResolution {
  if (opts.explicit) {
    return { agentId: opts.explicit, source: 'explicit' };
  }
  if (opts.inheritFrom?.agent_id) {
    return { agentId: opts.inheritFrom.agent_id, source: 'inherit' };
  }
  const type = opts.taskType ?? 'task';
  const mapped = opts.byType?.[type];
  if (mapped) {
    return { agentId: mapped, source: 'by_type', taskType: type };
  }
  return { agentId: opts.configDefault, source: 'default' };
}

/** Convenience wrapper that reads `agent_id` and `by_type` from resolved config. */
export function resolveAgentForNewTaskFromConfig(
  opts: {
    explicit?: string | null;
    inheritFrom?: { agent_id?: string | null } | null;
    taskType?: TaskType | null;
  },
  agentConfig: Pick<ResolvedConfig['agent'], 'agent_id' | 'by_type'>,
  projectSettings?: ProjectSettings | null,
): AgentResolution {
  return resolveAgentForNewTask({
    ...opts,
    byType: agentConfig.by_type,
    configDefault: resolveProjectAgent(
      projectSettings ?? null,
      { agent: agentConfig } as ResolvedConfig,
    ),
  });
}

/**
 * Resolve the agent for a storage `createTask` RPC when the caller omitted
 * `agentId`. The daemon owns this decision — storage must not silently default
 * to claude-code and bypass the project overlay.
 */
export async function resolveAgentIdForStorageCreateTask(
  storage: Storage,
  args: {
    agentId?: unknown;
    parentTaskId?: unknown;
    type?: unknown;
  },
  config: ResolvedConfig,
  projectSettings: ProjectSettings | null,
): Promise<string> {
  const explicit =
    typeof args.agentId === 'string' && args.agentId.trim() !== ''
      ? args.agentId.trim()
      : undefined;

  let inheritFrom: { agent_id?: string | null } | null = null;
  const parentTaskId =
    typeof args.parentTaskId === 'string' && args.parentTaskId.trim() !== ''
      ? args.parentTaskId.trim()
      : undefined;
  if (parentTaskId) {
    inheritFrom = await storage.getTask(parentTaskId);
  }

  const taskType =
    typeof args.type === 'string' && args.type.trim() !== ''
      ? (args.type.trim() as TaskType)
      : undefined;

  return resolveAgentForNewTask({
    explicit,
    inheritFrom,
    taskType,
    byType: config.agent.by_type,
    configDefault: resolveProjectAgent(projectSettings, config),
  }).agentId;
}

/**
 * One-line agent label for task-creation CLI output. Surfaces `[agent.by_type]`
 * when that table chose the agent, so humans never wonder why a fix task ran
 * Cursor. Matches the existing rule: omit the line when the result is the
 * stock default with no type mapping.
 */
export function formatAgentResolutionLine(resolution: AgentResolution): string | null {
  const { agentId, source } = resolution;
  if (source === 'by_type') {
    return `  Agent:  ${agentId} (task type ${resolution.taskType} → [agent.by_type])`;
  }
  if (agentId !== 'claude-code') {
    return `  Agent:  ${agentId}`;
  }
  return null;
}
