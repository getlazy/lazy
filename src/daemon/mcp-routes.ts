/**
 * Daemon MCP route handler — executes MCP tool calls on behalf of agents.
 *
 * Agents in containers call POST /mcp/:taskId/:toolName on the daemon.
 * The daemon creates a McpToolContext scoped to the task's worktree and
 * executes the tool handler with full host access.
 *
 * Security: The daemon enforces that agents can only access their own
 * worktree by scoping the McpToolContext to the task's worktree path.
 * For builder mode (taskId=''), the worktree is the project root.
 */

import { existsSync } from 'fs';
import { createAllHandlers, type McpToolContext } from '../mcp/tools';
import { getWorktreePath } from '../cli/helpers';
import { logger } from '../utils/logger';
import { RpcError, getOrCreateStorage } from './rpc-handlers';

/**
 * Execute an MCP tool call on behalf of an agent.
 *
 * @param projectRoot - The project root path
 * @param taskId - The task ID (empty string for builder/project-wide mode)
 * @param toolName - The MCP tool name (e.g., 'lazy_search')
 * @param args - Tool arguments
 * @returns The tool result
 */
export async function handleMcpToolCall(
  projectRoot: string,
  taskId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!existsSync(projectRoot)) {
    throw new RpcError(400, `Project root does not exist: ${projectRoot}`);
  }

  // Get the daemon's long-lived storage singleton
  const storage = await getOrCreateStorage();

  // Determine worktree path based on task ID
  let worktreePath: string;
  if (taskId) {
    // Task-scoped: resolve the task's worktree path
    const task = await storage.getTask(taskId);
    if (!task) {
      throw new RpcError(404, `Task not found: ${taskId}`);
    }
    worktreePath = getWorktreePath(projectRoot, task);
  } else {
    // Builder/project-wide mode: use project root
    worktreePath = projectRoot;
  }

  // Create tool context scoped to this task's worktree.
  // Pass the daemon's storage singleton so handlers can access it without
  // needing to create their own (which would fail with LAZY_IS_DAEMON=1).
  const ctx: McpToolContext = {
    taskId,
    worktreePath,
    storage,
  };

  const handlers = createAllHandlers(ctx);
  const handler = handlers.get(toolName);

  if (!handler) {
    throw new RpcError(404, `Unknown tool: ${toolName}`);
  }

  logger.debug(`MCP tool call: ${toolName} (task=${taskId || 'builder'}, worktree=${worktreePath})`);

  return handler(args);
}
