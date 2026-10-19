/**
 * Comments that arrived while the agent worked — the supervisor's half.
 *
 * Before a work turn's wrap-up, the supervisor asks the daemon whether notes
 * were queued on the task during the turn (src/daemon/turn-comments.ts). If
 * they were, it resumes the SAME session with the notes block an unblock would
 * have carried, and asks again once that invocation is over — until nothing is
 * queued or the daemon says `[limits] max_turns_without_human` is spent, at
 * which point the notes stay queued for the next person to unblock.
 *
 * Feedback is never lost: notes are acknowledged (marked delivered) only after
 * the invocation carrying them succeeded. A failed invocation, or a daemon that
 * cannot be reached, ends the loop with the notes still queued.
 */

import { readDaemonMcpConfigMinimal } from '../builder/launch-env';
import { tryRpc } from '../daemon/client';
import pendingNotesTemplate from '../prompts/pending-notes-followup.md' with { type: 'text' };
import { lazyFold } from '../task/wrapper-fold';

/** The route is bounded (local reads only); its client gives up first anyway. */
const PENDING_NOTES_TIMEOUT_MS = 30_000;

export type PendingNotesClaim =
  | { kind: 'none' }
  | { kind: 'notes'; notes: string; count: number; through: number; claim_id: string; budget: { count: number; max: number } }
  | { kind: 'budget_exhausted'; count: number; reason: string }
  | { kind: 'no_work_turn'; reason: string };

/**
 * Two transports, chosen the way the launch-env refresh chooses
 * (./launch-env.ts): a supervisor the daemon gave a config (every container)
 * calls the task-token route; a host-process supervisor, which holds no task
 * token, calls the control-only `claimTurnNotes` RPC through the daemon's own
 * port and token files.
 */
async function postPendingNotes(taskId: string, body: Record<string, unknown>): Promise<unknown> {
  const configPath = process.env.LAZY_DAEMON_CONFIG;
  if (!configPath) {
    const answer = await tryRpc<unknown>('claimTurnNotes', { taskId, ...body });
    if (answer === null) throw new Error('no lazy daemon is reachable from this supervisor');
    return answer;
  }
  const cfg = await readDaemonMcpConfigMinimal(configPath);
  const resp = await fetch(`${cfg.target.replace(/\/$/, '')}/agent/pending-notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-Lazy-Project': cfg.projectRoot,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PENDING_NOTES_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`the daemon refused /agent/pending-notes at ${cfg.target} (${resp.status}): ${text.slice(0, 300) || resp.statusText}`);
  }
  return resp.json();
}

/** Ask for notes queued during this turn. Counts one turn without a human when it returns notes. */
export interface NotesAuth { command_id?: string; notes_secret?: string }

function notesAuthFields(auth: NotesAuth): Record<string, unknown> {
  return { command_id: auth.command_id, notes_secret: auth.notes_secret };
}

export async function claimPendingNotes(taskId: string, auth: NotesAuth): Promise<PendingNotesClaim> {
  return await postPendingNotes(taskId, notesAuthFields(auth)) as PendingNotesClaim;
}

/** Mark notes delivered up to `through`, presenting the claim's one-time `claimId`, once the agent got them. */
export async function acknowledgePendingNotes(taskId: string, through: number, claimId: string, auth: NotesAuth): Promise<void> {
  const answer = await postPendingNotes(taskId, { ...notesAuthFields(auth), ack_through: through, claim_id: claimId }) as { kind?: string; reason?: string };
  if (answer?.kind !== 'acknowledged') {
    throw new Error(answer?.reason ?? `unexpected answer ${JSON.stringify(answer)}`);
  }
}

/** The follow-up prompt: the unblock's own notes block, plus what to do with it now. */
export function renderPendingNotesPrompt(notes: string): string {
  // The notes block arrives already marked (buildNotesContext); the instruction
  // after it is lazy's and is marked too, so review surfaces fold it.
  const instruction = pendingNotesTemplate.replace('{{notes}}', '').trim();
  return `${notes}${lazyFold('pending-notes', instruction)}\n`;
}
