/**
 * The marker that makes a REFLECTIVE (plan-mode) unblock a read-only turn at the
 * daemon's MCP route.
 *
 * An ask or review is read-only by its in-flight claim, which the route already
 * reads (src/daemon/mcp-turn-authority.ts). A reflective unblock has no claim:
 * it is a work turn launched with `permission_mode: 'plan'`, and nothing durable
 * said so. The toolset it is OFFERED is read-only, but a harness with a working
 * shell in the container (Codex) can POST to the route directly, so a
 * prompt-injected reflective turn could still call write tools.
 *
 * THE MARKER NAMES ITS OWN TURN, as `sync_restore_status` does
 * (./sync-restore-status.ts): it carries the launch's command id, its session,
 * and the sequence of the human turn that launch recorded. A reader honours it
 * only while that human turn is still the session's latest WORK turn, so a
 * marker nobody cleared is inert the moment the next turn launches. No other
 * launch path has to remember to clear it. The park of the turn it names also
 * clears it (matched by command id), so a stale value does not linger.
 *
 * It is written after the launch records its human turn and before the status
 * flip that makes the turn live, so it only ever names a sequence a real turn
 * holds — a later launch can never reuse it. Failing to WRITE it refuses the
 * launch. A reflective turn without its marker
 * would be a read-only turn the daemon lets write.
 */

import type { CommandId } from '../protocol';
import type { Storage } from '../storage';
import type { Session, Task, Turn } from '../types';
import { logger } from '../utils/logger';

export const READ_ONLY_TURN_KEY = 'read_only_turn';

interface ReadOnlyTurnMarker {
  command_id: CommandId;
  session_id: string;
  human_turn_sequence: number;
}

function parseMarker(raw: string | null | undefined): ReadOnlyTurnMarker | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`Ignoring an unreadable ${READ_ONLY_TURN_KEY} marker: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { command_id, session_id, human_turn_sequence } = parsed as Record<string, unknown>;
  if (typeof command_id !== 'string' || !command_id) return null;
  if (typeof session_id !== 'string' || !session_id) return null;
  if (typeof human_turn_sequence !== 'number') return null;
  return { command_id, session_id, human_turn_sequence };
}

/** Record that the reflective turn about to launch is read-only. Throws on failure. */
export async function markReadOnlyTurn(storage: Storage, taskId: string, marker: ReadOnlyTurnMarker): Promise<void> {
  await storage.updateTaskMetadata(taskId, READ_ONLY_TURN_KEY, JSON.stringify(marker));
}

/** Clear the marker when the turn it names (by command id) parks. A mismatch changes nothing. */
export async function clearReadOnlyTurnFor(storage: Storage, taskId: string, commandId: CommandId | undefined): Promise<void> {
  if (!commandId) return;
  try {
    const task = await storage.getTask(taskId);
    const marker = parseMarker(task?.metadata?.[READ_ONLY_TURN_KEY]);
    if (marker?.command_id === commandId) await storage.updateTaskMetadata(taskId, READ_ONLY_TURN_KEY, '');
  } catch (err) {
    // Harmless to leave: the marker goes inert as soon as the next turn launches.
    logger.warn(`Task ${taskId.substring(0, 8)}: could not clear the read-only turn marker: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The human turn that STARTED a work turn (the same rule the cluster watermark uses). */
function startsAWorkTurn(turn: Turn): boolean {
  if (turn.role !== 'human') return false;
  if (turn.feedback_withheld === true) return false;
  return !turn.turn_type || turn.turn_type === 'work';
}

/** Is the task's running work turn the reflective turn a marker names? */
export async function isReadOnlyWorkTurn(storage: Storage, task: Task, session: Session | null): Promise<boolean> {
  const marker = parseMarker(task.metadata?.[READ_ONLY_TURN_KEY]);
  if (!marker || !session || session.id !== marker.session_id) return false;
  const turns = await storage.getSessionTurns(session.id);
  let latest: Turn | undefined;
  for (const t of turns) {
    if (startsAWorkTurn(t) && (!latest || t.sequence > latest.sequence)) latest = t;
  }
  return latest?.sequence === marker.human_turn_sequence;
}
