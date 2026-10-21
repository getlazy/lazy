/**
 * The task-scoped MCP credential a HOST pairing session hands its agent.
 *
 * `lazy pair <task>` in the container gets its lazy_* tools from the task's
 * daemon MCP config, minted at container launch and bind-mounted in
 * (`writeDaemonMcpConfig`). `lazy pair <task> --host` runs Claude Code on the
 * human's machine, where no container mounts anything, so the host CLI asks
 * the daemon for the same credential instead: THE TASK'S OWN TOKEN, bound to
 * the task identity in the token registry, exactly the one the container
 * holds. Nothing new is minted per session (task tokens are keyed by task, not
 * label — src/daemon/actor-tokens.ts), so the agent on the host acts with the
 * same scope and under the same turn-authority rules as the agent in the
 * container (src/daemon/mcp-turn-authority.ts): full tools while the task is
 * `pairing`, reads only otherwise.
 *
 * Refused unless the task IS `pairing`. The host CLI moves the task there
 * before it asks, and nothing else has a reason to want the token: a task that
 * is not being paired has no session for it to belong to.
 *
 * The answer carries the token, not a file path. The daemon's config files live
 * in its own state dir and are rewritten to the CONTAINER address
 * (`host.docker.internal`) on every daemon start (`refreshDaemonMcpConfigs`), so
 * a host session cannot use one; the CLI writes its own private copy with the
 * loopback address it already reaches the daemon on, and removes it when the
 * session ends.
 *
 * Control-plane only, and identity-gated like `getDaemonMcpConfig`
 * (src/daemon/rpc-command-kinds.ts): it exists to put an agent in front of the
 * store.
 */

import type { Storage } from '../storage/interface';
import { mintMcpToken } from './mcp-tokens';
import { RpcError } from './rpc-error';
import { requireString } from './rpc-params';
import { displayId, shortId } from '../task/identity';

export interface TaskMcpConfigResult {
  /** The task's own MCP bearer token. */
  token: string;
  /** Full task id the token is bound to. */
  taskId: string;
  /** Project root the daemon serves. */
  projectRoot: string;
}

export async function handleGetTaskMcpConfig(
  projectRoot: string,
  storage: Storage,
  params: Record<string, unknown>,
): Promise<TaskMcpConfigResult> {
  const requested = requireString(params, 'taskId');
  const task = await storage.getTask(requested);
  if (!task) throw new RpcError(404, `Task ${shortId(requested)} not found.`);
  if (task.status !== 'pairing') {
    throw new RpcError(
      409,
      `Task ${displayId(task)} is '${task.status}', not 'pairing': its MCP tools are handed only to the ` +
      `pairing session that holds it. Start one with: lazy pair ${displayId(task)} --host`,
    );
  }
  // The label only names a record that does not exist yet; an existing task
  // token (the container's) is reused whatever label it was minted under.
  const token = await mintMcpToken(projectRoot, { kind: 'task', taskId: task.id }, `host-pair-${shortId(task.id)}`);
  return { token, taskId: task.id, projectRoot };
}
