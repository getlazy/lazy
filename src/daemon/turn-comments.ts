/**
 * Comments that arrived WHILE a work turn was running — handed to that turn
 * before it ends, instead of waiting for the next `lazy unblock`.
 *
 * Without this, a turn that finished (with or without the supervisor's nudges)
 * parked the task even when somebody had commented in the meantime, and the
 * comment sat until a person unblocked. The supervisor now asks this route,
 * at the end of the agent's work and before the wrap-up, whether notes are
 * queued; if so it resumes the SAME session with the very block an unblock
 * would have carried (`buildNotesContext`), and asks again afterwards.
 *
 * Why this does not break "A lazy comment never starts a turn" (AGENTS.md):
 * no turn is started. The turn that receives the notes is already running and
 * the task stays `working` throughout, so there is no launch to race a
 * person's own unblock — the failure that rule exists to prevent. Delivery
 * uses the same cutoff and the same mark as an unblock (`resolveNotesCutoff`,
 * `selectNotesForDelivery`, `markNotesDelivered`), so a note is delivered once,
 * by whichever reaches it first.
 *
 * BOUNDED by `[limits] max_turns_without_human`: every hand-off counts as one
 * turn without a human, on the same counter builder/agent unblocks use. Two
 * things could otherwise keep a turn alive forever — a task that keeps
 * commenting on itself (refused at the MCP door: an agent may only comment on
 * a direct subtask, and journals for itself) and anything else that comments
 * all the time. Once the budget is spent the notes stay queued, the turn ends
 * normally, and the next human unblock both delivers them and resets the
 * count. Every comment counts, a person's included: a person who wants the
 * agent to keep going past the cap unblocks it. Lazy's own system notices and
 * forge-imported comments never trigger a hand-off on their own (see below).
 *
 * TWO STEPS, so feedback is never lost: claiming counts the budget step and
 * returns the notes with the mark they reach (`through`) WITHOUT marking them;
 * the supervisor acknowledges only after the agent's invocation succeeded. An
 * invocation that fails leaves the notes queued for the next unblock.
 */

import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { loadConfig } from '../config/loader';
import { buildNotesContext, resolveNotesCutoff, selectNotesForDelivery } from '../task/turn-context';
import { checkTurnBudget, getNonHumanTurnCount, incrementNonHumanTurnCount } from './turn-budget';
import { resolveMcpTurnAuthority } from './mcp-turn-authority';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-handlers';
import { verifyNotesSecret } from '../protocol/notes-secret';

/**
 * The outstanding hand-off: task metadata naming the claim's nonce, the mark
 * it reaches and the session it was issued for. An acknowledgement must
 * present that nonce, once. The task token is reachable by the agent and by
 * any process in its container, so without it anything holding the token could
 * mark human comments delivered that no agent ever received — hiding them from
 * the next unblock and from accept's undelivered-feedback gate.
 */
export const PENDING_NOTES_CLAIM_KEY = 'pending_notes_claim';

interface OutstandingClaim { claim_id: string; through: number; session_id: string }

async function readOutstandingClaim(storage: Storage, taskId: string): Promise<OutstandingClaim | null> {
  const raw = await storage.getTaskMetadata(taskId, PENDING_NOTES_CLAIM_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as OutstandingClaim;
    return typeof v?.claim_id === 'string' && typeof v.through === 'number' && typeof v.session_id === 'string' ? v : null;
  } catch (err) {
    logger.warn(`Task ${taskId}: unreadable ${PENDING_NOTES_CLAIM_KEY} metadata ignored: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** What the running turn gets back. */
export type PendingNotesAnswer =
  /** Nothing queued. */
  | { kind: 'none' }
  /** Notes to deliver — `notes` is the same block an unblock prompt carries. */
  | { kind: 'notes'; notes: string; count: number; through: number; claim_id: string; budget: { count: number; max: number } }
  /** Notes are queued but the turn budget is spent; they wait for a person. */
  | { kind: 'budget_exhausted'; count: number; reason: string }
  /** No live WRITING work turn on this task — nothing may consume its notes. */
  | { kind: 'no_work_turn'; reason: string };

/**
 * Claim the notes queued on `task` for its running work turn, counting one
 * turn without a human. Nothing is marked delivered here — see
 * {@link acknowledgePendingNotes}. Read-only turns (ask,
 * review, a reflective unblock, the self-review phase) never consume notes —
 * the same rule as `lazy ask`, which must not eat queued feedback.
 */
export async function claimPendingNotesForRunningTurn(
  storage: Storage,
  projectRoot: string,
  task: Task,
): Promise<PendingNotesAnswer> {
  const refusal = await noWritingWorkTurn(storage, task);
  if (refusal) return refusal;

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) return { kind: 'no_work_turn', reason: `Task ${displayId(task)} has no session.` };

  const allNotes = await storage.getTaskComments(task.id);
  if (allNotes.length === 0) return { kind: 'none' };
  const turns = await storage.getSessionTurns(sess.id);
  const { newNotes, deliveredThrough } = selectNotesForDelivery(allNotes, resolveNotesCutoff(sess, turns));
  if (newNotes.length === 0 || deliveredThrough === null) return { kind: 'none' };
  // Lazy's own notices (`[Subtask accepted]`, `[Subtask added]`, …) never
  // keep a turn going by themselves: a cluster driver that accepts its own
  // child gets one for every accept, which is the task talking to itself by
  // another route. They ride along when somebody else's note triggers a
  // hand-off, and otherwise wait for the next turn as before.
  // Forge/CI comments (`source: 'remote'`) have their own auto-react delivery,
  // which would deliver them a second time after the park; they ride along too.
  if (!newNotes.some(n => n.actor !== 'system' && n.actor !== 'supervisor' && n.source !== 'remote')) {
    return { kind: 'none' };
  }

  const max = (await loadConfig(projectRoot)).limits.max_turns_without_human;
  const count = await getNonHumanTurnCount(storage, task.id);
  // The same batch claimed again (the first claimer never acknowledged) is the
  // SAME hand-off: re-issued, never counted twice. Repeated claims therefore
  // cannot burn max_turns_without_human — only new comments can.
  const outstanding = await readOutstandingClaim(storage, task.id);
  if (outstanding && outstanding.session_id === sess.id && outstanding.through === deliveredThrough) {
    return {
      kind: 'notes',
      notes: buildNotesContext(newNotes),
      count: newNotes.length,
      through: deliveredThrough,
      claim_id: outstanding.claim_id,
      budget: { count, max },
    };
  }
  const decision = checkTurnBudget(count, max);
  if (!decision.allowed) {
    logger.info(
      `Task ${displayId(task)}: ${newNotes.length} comment(s) queued during the turn stay queued — ${decision.reason}`,
    );
    return { kind: 'budget_exhausted', count, reason: decision.reason! };
  }

  // A failed count throws: notes are never handed out uncounted.
  const newCount = await incrementNonHumanTurnCount(storage, task.id);
  const claimId = crypto.randomUUID();
  await storage.updateTaskMetadata(task.id, PENDING_NOTES_CLAIM_KEY, JSON.stringify({ claim_id: claimId, through: deliveredThrough, session_id: sess.id } satisfies OutstandingClaim));
  logger.info(
    `Task ${displayId(task)}: handing ${newNotes.length} comment(s) to the running turn ` +
    `(turn without a human ${newCount}${max > 0 ? `/${max}` : ''})`,
  );
  return {
    kind: 'notes',
    notes: buildNotesContext(newNotes),
    count: newNotes.length,
    through: deliveredThrough,
    claim_id: claimId,
    budget: { count: newCount, max },
  };
}

/**
 * Record that the running turn's agent received the notes up to `through`
 * (the value its claim returned), presenting the claim's `claimId`. Accepted
 * ONCE per claim: the outstanding record is consumed, so a replayed or forged
 * acknowledgement is refused and moves nothing. The mark is monotonic in
 * storage, so nothing is ever re-queued either.
 */
export async function acknowledgePendingNotes(
  storage: Storage,
  task: Task,
  through: unknown,
  claimId: unknown,
): Promise<{ kind: 'acknowledged' } | { kind: 'no_work_turn'; reason: string }> {
  if (typeof through !== 'number' || !Number.isFinite(through) || through <= 0) {
    throw new RpcError(400, `'through' must be the positive timestamp a claim returned, got ${JSON.stringify(through)}.`);
  }
  const refusal = await noWritingWorkTurn(storage, task);
  if (refusal) return refusal;
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) return { kind: 'no_work_turn', reason: `Task ${displayId(task)} has no session.` };
  // The mark never moves back, so a value past the newest comment would hide
  // every comment written later. Only a mark a claim could have returned is
  // accepted.
  const newest = Math.max(0, ...(await storage.getTaskComments(task.id)).map(c => c.created_at));
  if (through > newest) {
    throw new RpcError(400, `'through' (${through}) is past the newest comment on task ${displayId(task)} (${newest}); acknowledge only what a claim returned.`);
  }
  const outstanding = await readOutstandingClaim(storage, task.id);
  if (typeof claimId !== 'string' || !outstanding || outstanding.claim_id !== claimId
      || outstanding.session_id !== sess.id || outstanding.through !== through) {
    throw new RpcError(409, `No outstanding hand-off on task ${displayId(task)} matches this acknowledgement; only the claim that carried the notes may acknowledge them, once.`);
  }
  // Mark first, consume second: a failed mark leaves the claim standing, so the
  // retry is the same hand-off and is not counted against the budget again.
  // A repeated mark is harmless — it only moves forward.
  await storage.markNotesDelivered(sess.id, through);
  await storage.updateTaskMetadata(task.id, PENDING_NOTES_CLAIM_KEY, '');
  return { kind: 'acknowledged' };
}

/** Only a live WRITING work turn may take a task's notes. */
async function noWritingWorkTurn(storage: Storage, task: Task): Promise<{ kind: 'no_work_turn'; reason: string } | null> {
  const authority = await resolveMcpTurnAuthority(storage, task);
  if (task.status === 'working' && authority.kind === 'turn' && authority.toolset === 'full') return null;
  return {
    kind: 'no_work_turn',
    reason: `Task ${displayId(task)} has no running work turn that may take its comments (status ${task.status}).`,
  };
}

/**
 * Refuse anyone but the turn's own supervisor. The task token is held by the
 * agent and every process in its container, so it names the task and nothing
 * more; the supervisor additionally presents the secret its command carried
 * (src/protocol/notes-secret.ts) — never in its environment, never given to the
 * agent. Without it a token holder could claim and acknowledge comments no
 * agent received.
 */
export function requireSupervisorCredential(task: Task, body: { command_id?: unknown; notes_secret?: unknown }): void {
  if (!verifyNotesSecret(task.id, body.command_id, body.notes_secret)) {
    throw new RpcError(403, `Only the supervisor of task ${displayId(task)}'s running turn may claim or acknowledge its comments; the presented credential does not match.`);
  }
}
