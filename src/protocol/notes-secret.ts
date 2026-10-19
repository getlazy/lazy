/**
 * The supervisor's credential for claiming and acknowledging comments queued
 * during a running turn (src/daemon/turn-comments.ts).
 *
 * The per-task MCP token is not enough to name the supervisor: the agent, its
 * MCP server and every process in the task container hold it. Anything holding
 * it could claim and acknowledge a human's comments, marking them delivered
 * without any agent receiving them — hiding them from the next unblock and from
 * accept's undelivered-feedback gate.
 *
 * So the daemon mints a per-COMMAND secret — HMAC(daemon-process key,
 * task id + command id) — and writes it into `command.json`, which the
 * supervisor consumes (deletes) before it spawns the agent. It is not put in
 * an environment variable or in the daemon config the container mounts, and the
 * supervisor does not pass it on to the agent. The key lives only in the
 * daemon's memory, so nothing on disk can be used to forge one, and a daemon
 * restart simply invalidates outstanding secrets: claims are then refused and
 * the notes stay queued for the next unblock (fail safe — nothing is lost).
 *
 * On disk the secret exists only in `command.json`, which the supervisor
 * deletes the moment it has read it (before any phase or the agent starts), so
 * nothing stays on disk for the turn. Residual limit, stated plainly: until
 * the supervisor picks the file up, and in the supervisor's memory afterwards,
 * any process in the same container that can read the protocol dir or the
 * supervisor can obtain it. During a live turn the credential cannot tell the
 * supervisor from such a process — the same limit as the MCP turn authority
 * (src/daemon/mcp-turn-authority.ts). It closes the supervisor route to a
 * task-token or config-file holder and any stale secret, not a hostile process
 * inside the container. One task-token route remains BY DESIGN: `lazy_wait`
 * claims and acknowledges the waiting task's own comments with the task token
 * alone (handleWait / handleAckWaitComments), bounded by the live-turn rule —
 * the agent IS the reader there, and the ack waits for a delivered answer.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const KEY = randomBytes(32);

/**
 * The newest command this process wrote for each task. A secret is only good
 * for THAT command: a secret from an earlier command (leaked from a stale
 * command.json, or read back out of an old process) is refused once the next
 * command has been written. Every launch writes its command through
 * `writeCommand`, and a task runs one turn at a time, so "newest command
 * written" is the command of the live turn. In memory like the key: a daemon
 * restart forgets both, which only ever refuses.
 */
const latestCommand = new Map<string, string>();

function mac(taskId: string, commandId: string): Buffer {
  return createHmac('sha256', KEY).update(`pending-notes\0${taskId}\0${commandId}`).digest();
}

/** The secret a supervisor must present to claim notes for the turn run by `commandId`. */
export function mintNotesSecret(taskId: string, commandId: string): string {
  latestCommand.set(taskId, commandId);
  return mac(taskId, commandId).toString('hex');
}

/** True only for a secret this daemon process minted for exactly this task and command. */
export function verifyNotesSecret(taskId: string, commandId: unknown, presented: unknown): boolean {
  if (typeof commandId !== 'string' || typeof presented !== 'string') return false;
  if (latestCommand.get(taskId) !== commandId) return false;
  const expected = mac(taskId, commandId);
  let got: Buffer;
  try {
    got = Buffer.from(presented, 'hex');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}
