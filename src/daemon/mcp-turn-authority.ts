/**
 * WHICH TURN A TASK'S MCP TOKEN IS ACTING FOR — and whether it may act at all.
 *
 * A task MCP token is minted per task and lives as long as the task. The
 * processes holding it do not: the agent of the current turn, but also anything
 * an earlier turn left running in the container, and the project's Start
 * services command, which any member may set and which runs in the TASK's
 * container across turns and member sessions. So "this token is valid" says
 * nothing about WHOSE turn a call belongs to, and the daemon used to answer
 * that from the task's current session on every call — a stray process could
 * launch subtasks billed to whoever owned the task's last turn (raised item
 * 36a893f4, which widened from attribution to spend on 2026-10-06).
 *
 * The rule here: authority comes from a LIVE TURN, and the person from that
 * turn's own record.
 *
 *   - A live ask/review CLAIM (`task.in_flight_turn`) is a read-only turn. The
 *     person is the one the claim captured at launch; the tools allowed are the
 *     same allowlist the read-only toolset OFFERS (`isToolAllowedOnToolset`) —
 *     a harness whose shell works inside the container (Codex) can POST to the
 *     route directly, so what was offered is not a boundary on its own.
 *   - A `working` task with no claim is running a work turn (or a sync). The
 *     person is the session's owner, which that turn's launch wrote and which no
 *     other launch can rewrite while it runs: every other launch on a task
 *     refuses `working`, and the agent's own self-sync runs as this same person.
 *     While its supervisor reports the low-high SELF-REVIEW phase, the turn is
 *     read-only too, and so is a REFLECTIVE (plan-mode) unblock, by the marker
 *     its launch wrote (../task/read-only-turn.ts).
 *     EXCEPT while the accept gate holds `working` (./accept-gate-marker.ts):
 *     no agent runs then, so there is no turn.
 *   - A `pairing` task is a person's interactive session — unchanged.
 *   - Anything else has NO live turn: only read tools answer. Reads are neither
 *     attributed nor billed, and a process looking at the task harms nobody.
 *
 * THE LIMIT, stated so nobody mistakes this for more: during a live turn the
 * token cannot tell the turn's agent from another process in the same
 * container, so a leftover process acting DURING a later turn acts as that
 * turn's owner. That is the per-task-token half of the placeholder-credential
 * question this module does not close (see the raised item on the task that
 * introduced it). The self-review phase is read from the supervisor's
 * `status.json`, which lives in a directory the container can write; it can
 * only ever RESTRICT, never widen, what a call may do.
 */

import type { Task, TurnOwner } from '../types';
import type { Storage } from '../storage/interface';
import { isInFlightLive } from './in-flight-turn';
import { taskTurnOwner, turnOwnerOfClaim } from './turn-owner';
import { isReadOnlyWorkTurn } from '../task/read-only-turn';
import { isReadOnlyTool, isToolAllowedOnToolset, type McpToolset } from '../mcp/tool-access';
import { readSupervisorStatusAsync } from '../utils/working-substate';
import { protocolDir } from '../protocol/io';
import { displayId } from '../task/identity';
import { RpcError } from './rpc-handlers';
import { isAcceptGateRunning } from './accept-gate-marker';

/** What a call on a task's MCP token may do, and as whom. */
export type McpTurnAuthority =
  | { kind: 'none'; status: Task['status'] }
  | { kind: 'turn'; toolset: McpToolset; owner: TurnOwner | null; turnLabel: string };

/** Resolve the live turn (if any) a call on `task`'s token acts for. */
export async function resolveMcpTurnAuthority(storage: Storage, task: Task): Promise<McpTurnAuthority> {
  const claim = task.in_flight_turn ?? null;
  if (claim && !claim.outcome && isInFlightLive(claim) && (claim.owner === 'ask' || claim.owner === 'review')) {
    return {
      kind: 'turn',
      toolset: claim.owner === 'review' ? 'review' : 'read',
      owner: turnOwnerOfClaim(claim),
      turnLabel: `${claim.owner} turn`,
    };
  }

  // The accept gate holds `working` with no agent: no turn (./accept-gate-marker.ts).
  if (task.status === 'working' && isAcceptGateRunning(task.id)) {
    return { kind: 'none', status: task.status };
  }

  if (task.status === 'working') {
    const owner = await taskTurnOwner(storage, task.id);
    // A reflective (plan-mode) unblock: read-only for its whole length, by the
    // marker its launch wrote (src/task/read-only-turn.ts).
    if (await isReadOnlyWorkTurn(storage, task, await storage.getSessionByTaskId(task.id))) {
      return { kind: 'turn', toolset: 'read', owner, turnLabel: 'reflective turn' };
    }
    const status = await readSupervisorStatusAsync(protocolDir(task.id));
    if (status?.phase === 'low_high_review') {
      return { kind: 'turn', toolset: 'read', owner, turnLabel: 'self-review phase' };
    }
    return { kind: 'turn', toolset: 'full', owner, turnLabel: 'work turn' };
  }

  if (task.status === 'pairing') {
    return { kind: 'turn', toolset: 'full', owner: await taskTurnOwner(storage, task.id), turnLabel: 'pairing session' };
  }

  return { kind: 'none', status: task.status };
}

/**
 * Refuse a call the live turn does not authorise (403), or return normally.
 *
 * Read tools always pass. An unclassified tool name (the supervisor's internal
 * git hatch, `lazy_image_build`) is treated as a write: fail closed.
 */
export function assertMcpCallAuthorised(task: Task, toolName: string, authority: McpTurnAuthority): void {
  if (isReadOnlyTool(toolName)) return;
  if (authority.kind === 'none') {
    throw new RpcError(
      403,
      `Refused: ${toolName} on task ${displayId(task)}'s MCP token, but the task has no turn running ` +
      `(it is '${authority.status}'). A task's token acts only for the turn that is running — a launch ` +
      `or a write made outside one would be attributed to, and billed to, a person who did not ask for it. ` +
      `Read-only tools still answer. To act, run a turn: unblock the task (lazy unblock ${displayId(task)}).`,
    );
  }
  if (authority.toolset !== 'full' && !isToolAllowedOnToolset(toolName, authority.toolset)) {
    throw new RpcError(
      403,
      `Refused: ${toolName} during task ${displayId(task)}'s ${authority.turnLabel}, which is read-only. ` +
      `Only the tools that turn was offered may be called on its token.`,
    );
  }
}
