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
import { RpcApplicationError } from './client';
import { lookupMcpIdentity } from './mcp-tokens';
import type { ProgressEmitter } from './progress';

/**
 * HTTP status a daemon route should answer with for a handler error.
 *
 * INVARIANT: a status carried by the error is preserved end to end. A tool
 * handler that rejects its arguments raises RpcError(400); a handler that
 * relayed the failure of another daemon call raises RpcApplicationError with
 * the status that daemon returned. Flattening either to 500 makes an argument
 * mistake indistinguishable from a daemon crash — the operator then debugs the
 * daemon instead of their call, and error classification downstream (see
 * src/daemon/mcp-proxy.ts) is mis-trained on the same lie.
 *
 * 500 is the answer only for errors that genuinely carry no status.
 */
export function httpStatusForError(err: unknown): number {
  if (err instanceof RpcError) return err.status;
  if (err instanceof RpcApplicationError) return err.status;
  return 500;
}

/**
 * Longest task code the CLI accepts (`lazy create --code`), and the ceiling for
 * a task id (a UUID is 36 chars). Anything longer is not a task reference.
 */
const MAX_TASK_SEGMENT_LENGTH = 80;

/** Task ids (UUID), short ids (hex prefix) and codes all fit this shape. */
const TASK_SEGMENT_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A daemon bearer token: 32 random bytes, hex-encoded (see generateToken). */
const DAEMON_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Validate the `:taskId` path segment of POST /mcp/:taskId/:toolName.
 *
 * Returns an error message when the segment cannot be a task reference, or
 * null when it should be handed to task resolution.
 *
 * WHY: a hand-rolled call that put the daemon bearer token in the path
 * (`POST /mcp/<token>/lazy_wait`) got `Task not found: <token>` — the route fed
 * the token straight into task resolution, so a malformed path reported a
 * missing task and hid the real mistake. Builder/project-wide calls use the
 * literal `_` segment; the token belongs in the Authorization header.
 */
export function validateMcpTaskSegment(segment: string, daemonToken?: string): string | null {
  if (segment === '_') return null; // builder / project-wide

  const pathHint =
    'Builder/project-wide calls use POST /mcp/_/<toolName>; task-scoped calls use the task id or code.';

  if (daemonToken && segment === daemonToken) {
    return `The :taskId path segment is the daemon auth token, not a task id. ${pathHint} ` +
      'The token goes in the Authorization: Bearer header.';
  }
  if (DAEMON_TOKEN_SHAPE.test(segment)) {
    return `The :taskId path segment looks like a daemon auth token (64 hex chars), not a task id. ${pathHint}`;
  }
  if (segment.length > MAX_TASK_SEGMENT_LENGTH) {
    return `Invalid :taskId path segment: ${segment.length} characters exceeds the ${MAX_TASK_SEGMENT_LENGTH}-character maximum for a task id or code. ${pathHint}`;
  }
  if (!TASK_SEGMENT_SHAPE.test(segment)) {
    return `Invalid :taskId path segment '${segment}': a task id or code contains only letters, digits, '.', '-' and '_'. ${pathHint}`;
  }
  return null;
}

/**
 * Resolve the caller's identity from the bearer token it presented, and check
 * it against the task id claimed in the URL.
 *
 * INVARIANT — this is the anti-impersonation boundary. The `:taskId` segment is
 * claimed by the caller and proves nothing; the token does. Each task session
 * and each builder session holds its OWN token (see src/daemon/mcp-tokens.ts),
 * so the daemon can derive who is calling instead of believing them.
 *
 * On a mismatch we REFUSE (403) rather than silently substituting the token's
 * identity for the claim: a caller that believes it is acting on task A while
 * the daemon acts on task B is a worse failure than a hard error, and a silent
 * override would hide a real impersonation attempt from the operator.
 *
 * @returns the task id to execute against ('' for the builder surface)
 * @throws RpcError 401 (unknown/revoked token), 400 (malformed segment),
 *         403 (identity/claim mismatch)
 */
export async function authorizeMcpCall(
  projectRoot: string,
  claimedSegment: string,
  presentedToken: string | null,
): Promise<string> {
  const identity = await lookupMcpIdentity(projectRoot, presentedToken);
  if (!identity) {
    throw new RpcError(
      401,
      'Unauthorized: the presented bearer token is not a valid daemon MCP token. ' +
      'MCP tokens are minted per task session (and per builder session) and are revoked when the ' +
      'session ends — restart the task or relaunch the builder to obtain a fresh token.',
    );
  }

  // Malformed path is still a 400: the caller authenticated, they just built
  // the URL wrong. Checked after auth so an unauthenticated prober learns
  // nothing about path shapes.
  const segmentError = validateMcpTaskSegment(claimedSegment);
  if (segmentError) throw new RpcError(400, segmentError);

  const claimsBuilder = claimedSegment === '_';

  if (identity.kind === 'builder') {
    if (!claimsBuilder) {
      throw new RpcError(
        403,
        `Identity mismatch: this token is a BUILDER token, but the request claims task '${claimedSegment}' ` +
        `in the URL. Builder calls must use POST /mcp/_/<toolName>.`,
      );
    }
    return '';
  }

  if (claimsBuilder) {
    throw new RpcError(
      403,
      `Identity mismatch: this token belongs to task ${identity.taskId}, but the request claims the ` +
      `builder/project-wide surface (/mcp/_/). A task agent may only act as itself.`,
    );
  }

  if (claimedSegment === identity.taskId) return identity.taskId;

  // The claim may be a short id or a code for the SAME task — resolve before
  // refusing, so a legitimate caller isn't rejected on spelling.
  const storage = await getOrCreateStorage();
  const { task } = await storage.resolveTask(claimedSegment);
  if (task && task.id === identity.taskId) return identity.taskId;

  throw new RpcError(
    403,
    `Identity mismatch: this token belongs to task ${identity.taskId}, but the request claims task ` +
    `'${claimedSegment}'. A task agent may only act as itself — refusing rather than silently ` +
    `retargeting the call.`,
  );
}

/**
 * Execute an MCP tool call on behalf of an agent.
 *
 * @param projectRoot - The project root path
 * @param taskId - The task ID (empty string for builder/project-wide mode)
 * @param toolName - The MCP tool name (e.g., 'lazy_search')
 * @param args - Tool arguments
 * @param progress - Optional phase-progress sink supplied by the heartbeat
 *   envelope. Tools that run for minutes (accept) narrate their phases through
 *   it so the MCP client sees the same phase output the CLI does.
 * @returns The tool result
 */
export async function handleMcpToolCall(
  projectRoot: string,
  taskId: string,
  toolName: string,
  args: Record<string, unknown>,
  progress?: ProgressEmitter,
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
    progress,
  };

  const handlers = createAllHandlers(ctx);
  const handler = handlers.get(toolName);

  if (!handler) {
    throw new RpcError(404, `Unknown tool: ${toolName}`);
  }

  logger.debug(`MCP tool call: ${toolName} (task=${taskId || 'builder'}, worktree=${worktreePath})`);

  return handler(args);
}
