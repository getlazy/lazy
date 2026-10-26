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
import { findToolDefinition, parseAndValidateToolCallBody } from '../mcp/tool-registry';
import { validateToolArgs, describeArgsFailure } from '../mcp/validate-args';
import { getWorktreePath } from '../task/identity';
import { logger } from '../utils/logger';
import { RpcError, getOrCreateStorage } from './rpc-handlers';
import { RpcApplicationError } from './client';
import { lookupMcpIdentity } from './mcp-tokens';
import type { ProgressEmitter } from './progress';
import { trackWait, BLOCKING_WAIT_TOOLS } from './wait-registry';
import { runAsTurnOwnerRequest, type TurnOwnerRequest } from './turn-owner';
import { assertMcpCallAuthorised, resolveMcpTurnAuthority } from './mcp-turn-authority';
import { isManagedMode } from '../config/managed-mode';
import { runWithLaunchOrigin, type LaunchOrigin } from './launch-origin';
import { displayId } from '../task/identity';
import type { Storage } from '../storage/interface';
import { realignAfterDaemonWrite } from '../utils/worktree-ownership';
import { INTERNAL_GIT_TOOL_NAME } from '../mcp/types';
import { runWithGitAuthor } from '../identity/git-author';
import { assertMemberPairTool, type MemberPairIdentity } from './member-pair-mcp';
import { isReadOnlyTool } from '../mcp/tool-access';

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
 * Turn a POST /mcp/:taskId/:toolName request body into validated tool arguments.
 *
 * INVARIANT — this route is an EXTERNAL SURFACE and validates its own inputs.
 * It is reachable by anything holding a session's MCP token, including an agent
 * hand-rolling the documented HTTP fallback, and the well-behaved MCP client
 * plumbing is not the only caller. A body missing the `{"arguments": {...}}`
 * envelope, or arguments that violate the tool's declared inputSchema, must be
 * a 400 that names the field — NOT a dispatch with silently-empty arguments.
 *
 * This is the fix for the commit whose message was the literal string
 * "undefined": `{"message": "..."}` posted without the envelope made
 * `args.message` undefined, and lazy_commit ran `git commit -m undefined`. A
 * corrupt write is strictly worse than a rejected call.
 *
 * @throws RpcError 400 with the offending field and the expected envelope shape
 */
export function parseMcpToolCallBody(toolName: string, body: unknown): Record<string, unknown> {
  const parsed = parseAndValidateToolCallBody(toolName, body);
  if (!parsed.ok) throw new RpcError(400, parsed.error);
  return parsed.args;
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
  /** The builder surface's MCP token label, resolved by the route from the token. */
  builderTokenLabel?: string | null,
  /** Collects effects to run once the answer reached a connected caller. */
  afterDelivery?: (effect: () => Promise<void>) => void,
  /** Resolved from the authenticated token by the HTTP route, never the body. */
  memberPair?: MemberPairIdentity | null,
): Promise<unknown> {
  if (!existsSync(projectRoot)) {
    throw new RpcError(400, `Project root does not exist: ${projectRoot}`);
  }

  // Schema check before ANY side effect — before storage, before the worktree
  // is resolved, before a handler runs. Defence in depth: the route already
  // validated (parseMcpToolCallBody), but this function is the shared entry
  // point for tool dispatch, so it must not depend on its caller having done
  // it. An unknown tool name falls through to the 404 below.
  const definition = findToolDefinition(toolName);
  if (definition) {
    const failure = validateToolArgs(definition.inputSchema, args);
    if (failure) {
      throw new RpcError(400, describeArgsFailure(toolName, definition.inputSchema, failure));
    }
  }

  // Get the daemon's long-lived storage singleton
  const storage = await getOrCreateStorage();

  // Determine worktree path based on task ID
  let worktreePath: string;
  let actorPerson: { email: string; name?: string } | undefined;
  let authority: Awaited<ReturnType<typeof resolveMcpTurnAuthority>> | null = null;
  let callerTask: Awaited<ReturnType<typeof storage.getTask>> = null;
  if (taskId) {
    // Task-scoped: resolve the task's worktree path
    const task = await storage.getTask(taskId);
    if (!task) {
      throw new RpcError(404, `Task not found: ${taskId}`);
    }
    worktreePath = getWorktreePath(projectRoot, task);

    // AUTHORITY COMES FROM A LIVE TURN (./mcp-turn-authority.ts). The token is
    // per task and outlives every turn — services and leftover processes in the
    // task's container hold it too — so a launch or attributed write is accepted
    // only while a turn is running, a read-only turn (ask, review, the low-high
    // self-review) gets only the tools it was offered, and WHOSE WORK THIS IS
    // comes from that turn's own record: the claim's captured owner for an
    // ask/review, the session owner its launch wrote for a work turn. Never sent
    // by the caller — an identity a request could carry is one an agent could
    // choose. No recorded owner means the turn was system-initiated, and the
    // rows record the channel and nobody, as they always have.
    //
    // This closed raised item `36a893f4`: the person used to be read from the
    // task's CURRENT session on every call, whatever was calling, and since
    // 2026-10-06 the same lookup decides BILLING (agentLaunchOwnerRequest), so a
    // process outside any turn could launch subtasks billed to whoever owned the
    // task's last turn.
    //
    // DELIBERATELY NOT the configured system identity the TURN rows of such a
    // turn carry (§3.3 case 3, src/identity/system-identity.ts). That identity
    // comes with the role `system`, and `actor` on this door is read as the
    // CHANNEL by code that decides behaviour, not only by surfaces: a loop task
    // asks whether a new child's creating actor was `agent` to tell its own
    // agent's subtasks from ones a human added, and a loop whose turn the
    // reconciler had resumed would have started answering "somebody else" to its
    // own children — and woken itself forever. Widening these rows means giving
    // each such reader the distinction first.
    if (memberPair) {
      if (memberPair.taskId !== task.id) throw new RpcError(403, 'Member pairing task mismatch.');
      assertMemberPairTool(memberPair, toolName);
      // Still the agent CHANNEL, but not the supervised task agent: ctx below
      // carries the authenticated connection's provenance separately so child
      // creation can wake the cluster and interrupt its wait.
      actorPerson = memberPair.member;
    } else {
      authority = await resolveMcpTurnAuthority(storage, task);
    }
    callerTask = task;
    if (!memberPair) actorPerson = authority?.kind === 'turn' ? authority.owner ?? undefined : undefined;
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
    projectRoot,
    ...(taskId ? {} : { builderTokenLabel: builderTokenLabel ?? null }),
    storage,
    progress,
    ...(afterDelivery ? { afterDelivery } : {}),
    ...(taskId ? { actorPerson } : {}),
    ...(memberPair ? { memberPair: true } : {}),
  };

  const handlers = createAllHandlers(ctx);
  const handler = handlers.get(toolName);

  if (!handler) {
    throw new RpcError(404, `Unknown tool: ${toolName}`);
  }
  // After the 404, so an unknown name is reported as unknown, not as refused.
  if (callerTask && authority) assertMcpCallAuthorised(callerTask, toolName, authority);

  logger.debug(`MCP tool call: ${toolName} (task=${taskId || 'builder'}, worktree=${worktreePath})`);

  // A commit this call makes (lazy_commit, a self-sync's merges, an accept)
  // is authored by the person who asked for the turn — for a builder session,
  // the member it belongs to; a turn nobody asked for falls through to the
  // configured system identity (src/identity/git-author.ts).
  //
  // Inside that, a turn this call LAUNCHES runs as whoever asked for it (see
  // launchScope below): the caller task's turn owner, or the member a builder
  // session belongs to.
  const launch = await launchScope(storage, projectRoot, taskId, toolName, args, ctx.actorPerson ?? null, builderTokenLabel ?? null);
  // A builder call has no task, so no actorPerson; its member scopes the
  // inner call (a null scope is a pass-through, so exactly one applies).
  // A read writes no commit, so it needs no lookup.
  const builderMember = taskId || isReadOnlyTool(toolName) ? null : await builderSessionMember(storage, projectRoot, builderTokenLabel ?? null);
  return runWithGitAuthor(ctx.actorPerson ?? null, () => runWithGitAuthor(builderMember, () =>
    launch(() => dispatchMcpHandler(storage, taskId, toolName, worktreePath, handler, args, !!memberPair))));
}

/**
 * The scope a turn-launching MCP call runs in: as its owner's request when it
 * has one, otherwise with its ORIGIN recorded so an ownerless launch's
 * service-holder refusal can name the real trigger (./launch-origin.ts).
 * Every other call runs unchanged.
 */
async function launchScope(
  storage: Storage,
  projectRoot: string,
  taskId: string,
  toolName: string,
  args: Record<string, unknown>,
  actorPerson: { email: string; name?: string } | null,
  builderTokenLabel: string | null,
): Promise<<T>(fn: () => Promise<T>) => Promise<T>> {
  if (!AGENT_TURN_LAUNCHING_TOOLS.has(toolName)) return (fn) => fn();
  const request = taskId
    ? await agentLaunchOwnerRequest(storage, taskId, toolName, args, actorPerson)
    : await builderLaunchOwnerRequest(storage, projectRoot, toolName, args, builderTokenLabel);
  if (request) return (fn) => runAsTurnOwnerRequest(request, fn);
  const caller = taskId ? await storage.getTask(taskId) : null;
  const origin: LaunchOrigin = caller ? { kind: 'agent', parentTask: displayId(caller) } : { kind: 'builder' };
  return (fn) => runWithLaunchOrigin(origin, fn);
}

/**
 * The member a builder session belongs to, found through the label of the MCP
 * token the daemon authenticated (`builder-<builderId>`) — the same binding
 * {@link builderLaunchOwnerRequest} relies on, and trusted for the same
 * reasons. Managed mode only: on a laptop the builder is the daemon's own git
 * identity already. Null for an unknown label, an ended session, or a session
 * with no member.
 */
export async function builderSessionMember(
  storage: Storage,
  projectRoot: string,
  builderTokenLabel: string | null,
): Promise<{ email: string } | null> {
  if (!isManagedMode() || !builderTokenLabel?.startsWith('builder-')) return null;
  const builderId = builderTokenLabel.slice('builder-'.length);
  if (!builderId) return null;
  try {
    const session = (await storage.listBuilderSessions(projectRoot))
      .find((s) => s.builderId === builderId && s.state !== 'ended');
    return session?.memberEmail ? { email: session.memberEmail } : null;
  } catch (err) {
    logger.debug(`Could not resolve the member behind builder ${builderId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * WHO ASKED for a turn a BUILDER session launches: the member the session
 * belongs to. A Teams builder session is a person's conversation (§3.3 case 1),
 * so a task it starts or unblocks is that person's turn, billed to them.
 *
 * The member is resolved from the session's own authenticated binding — the
 * daemon looked the MCP token up and found its label (`builder-<builderId>`),
 * which names a daemon-owned builder session record carrying `memberEmail` —
 * never from a request field. What keeps this honest is not who may mint a
 * label (`getDaemonMcpConfig` takes a caller-supplied name and does not refuse
 * user tokens) but two other facts: the minted token's secret is written only
 * into a daemon-side config file and never returned to the caller (the RPC
 * answers with a path), so a token labelled `builder-<id>` is held only by the
 * builder the daemon launched; and builder-session rows are written by the
 * daemon alone — user-kind callers are refused every write
 * (`BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS`), and on a managed host the
 * control token is refused them too — so nobody can plant a row naming another
 * member. Managed mode only: on a laptop a builder's
 * launches keep running on the daemon's own credential, as they always have.
 * An ended session, an unknown label, or a session with no member yields null:
 * the launch stays ownerless (the service holder pays or it is refused).
 */
export async function builderLaunchOwnerRequest(
  storage: Storage,
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  builderTokenLabel: string | null,
): Promise<TurnOwnerRequest | null> {
  if (!AGENT_TURN_LAUNCHING_TOOLS.has(toolName)) return null;
  const ref = typeof args.task_id === 'string' ? args.task_id : '';
  if (!ref) return null;
  const member = await builderSessionMember(storage, projectRoot, builderTokenLabel);
  if (!member) return null;
  try {
    const resolved = await storage.resolveTask(ref);
    if (!resolved.task) return null;
    return { taskId: resolved.task.id, owner: { email: member.email, spendable: true } };
  } catch (err) {
    logger.debug(`Could not resolve '${ref}' to name the builder's turn owner: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * MCP tools through which a task's agent launches a turn — on a subtask, or on
 * itself for `lazy_sync`. The agent-reachable half of the RPC layer's
 * TURN_LAUNCHING_COMMANDS.
 */
export const AGENT_TURN_LAUNCHING_TOOLS = new Set([
  'lazy_start', 'lazy_unblock', 'lazy_resume', 'lazy_ask', 'lazy_review', 'lazy_sync', 'lazy_accept',
]);

/**
 * WHO ASKED for a turn a task's agent launches: whoever asked for the agent's
 * OWN current turn. A subtask started (unblocked, resumed, asked, reviewed) by
 * an agent is part of that agent's turn, so it is owned by — and billed to —
 * the parent turn's owner — the person the caller's LIVE turn records
 * (`actorPerson`, resolved by ./mcp-turn-authority.ts: an ask/review claim's
 * captured owner, or the session owner a work turn's launch wrote),
 * never from a request field. Without this every agent-launched turn ran with
 * no owner and, on a managed host, was billed to the project's service holder:
 * a member's own task starting a subtask was refused for want of a service
 * credential (field report 2026-10-06).
 *
 * A parent turn nobody asked for yields null: its subtasks are system turns
 * too. `spendable` mirrors how the parent's owner was derived — in managed
 * mode only a member's user token ever names an owner; on a laptop the owner is
 * the git identity, which is never spent.
 */
export async function agentLaunchOwnerRequest(
  storage: Storage,
  callerTaskId: string,
  toolName: string,
  args: Record<string, unknown>,
  owner: { email: string; name?: string } | null,
): Promise<TurnOwnerRequest | null> {
  if (!callerTaskId || !owner || !AGENT_TURN_LAUNCHING_TOOLS.has(toolName)) return null;
  const ref = typeof args.task_id === 'string' && args.task_id ? args.task_id : callerTaskId;
  try {
    const resolved = await storage.resolveTask(ref);
    if (!resolved.task) return null;
    return { taskId: resolved.task.id, owner: { ...owner, spendable: isManagedMode() } };
  } catch (err) {
    // The handler about to run produces the real "not found" for the caller.
    logger.debug(`Could not resolve '${ref}' to name the turn owner: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function dispatchMcpHandler(
  storage: Awaited<ReturnType<typeof getOrCreateStorage>>,
  taskId: string,
  toolName: string,
  worktreePath: string,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown>,
  memberPair = false,
): Promise<unknown> {
  // A task agent making a BLOCKING call is parked, not working. Record it for
  // the duration so read surfaces can say `working(waiting on <task>)` and so
  // the waited time is subtractable from the turn's wall-clock. Builder calls
  // (taskId === '') have no task to attribute anything to.
  if (!taskId || memberPair || !BLOCKING_WAIT_TOOLS.has(toolName)) {
    if (taskId && WORKTREE_WRITING_TOOLS.has(toolName)) {
      try {
        return await handler(args);
      } finally {
        await realignAfterDaemonWrite(worktreePath);
      }
    }
    return handler(args);
  }

  return trackWait(
    {
      storage,
      taskId,
      tool: toolName,
      targets: await resolveWaitTargets(storage, args),
    },
    () => handler(args),
  );
}

/**
 * Resolve the `task_id` argument of a blocking tool into ids plus display
 * labels. Best-effort: an unresolvable reference is carried through verbatim as
 * its own label, because a wait on a mistyped id is still a wait.
 */
async function resolveWaitTargets(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<{ id: string; label: string }[]> {
  const raw = args.task_id;
  const inputs = (Array.isArray(raw) ? raw : [raw]).filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );

  const out: { id: string; label: string }[] = [];
  for (const input of inputs) {
    const ref = input.trim();
    try {
      const { task } = await storage.resolveTask(ref);
      if (task) {
        out.push({ id: task.id, label: task.code || task.id.slice(0, 8) });
        continue;
      }
    } catch (err) {
      logger.debug(`wait targets: could not resolve '${ref}': ${(err as Error).message}`);
    }
    out.push({ id: ref, label: ref });
  }
  return out;
}

/**
 * Tools whose daemon-side handler writes into the calling task's own worktree
 * or git dirs. A root daemon hands what they created back to the container
 * user afterwards (src/utils/worktree-ownership.ts), or the agent cannot edit
 * a file a merge just rewrote, nor stage into an objects dir a commit created.
 */
const WORKTREE_WRITING_TOOLS = new Set<string>(['lazy_commit', 'lazy_sync', 'lazy_accept', INTERNAL_GIT_TOOL_NAME]);
