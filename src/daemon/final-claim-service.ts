/**
 * Pencils down — the business rules behind `lazy_final`.
 *
 * Lives in the daemon, not at the MCP boundary, for the ordinary reason: the
 * ONE refusal and the shape of what gets written are business rules, and the
 * MCP layer is a client (CLAUDE.md — "The daemon owns business logic").
 *
 * What declaring does, and deliberately does not do:
 *   - It records a CLAIM ABOUT A SHA. It is NOT a turn-end signal: the turn
 *     still ends when the agent's process ends, and an agent that declares and
 *     then keeps working simply has a final whose head has moved (§2.3).
 *   - It changes no status, starts no turn, and merges nothing.
 *   - It writes the protocol-dir marker the supervisor reads when the
 *     invocation ends (src/protocol/final-marker.ts). The DURABLE record is
 *     `Turn.final`, stamped by the reconciler off the response the supervisor
 *     carries home; the marker is the signal that gets it there.
 *
 * INVARIANT (final-turn design §2.1/§13.4): the refusals are about WHEN a
 * declaration can be made, never about what the work contains. There are two,
 * and both name what they are:
 *
 *   - an open BLOCKING raise on the task, because that is the OTHER turn
 *     ending and the agent has already chosen it;
 *   - the invocation IS the presentation step AND the turn did not declare
 *     (reviews 0fc553f4, c6b6cdde), because that step does not decide how the
 *     turn ended and the supervisor drops a claim made there (`carriedFinal`
 *     in src/supervisor/wrap-up.ts). Answering "recorded" and discarding it
 *     left the agent reporting a hand-over that no surface showed. A turn that
 *     HAD declared is answered rather than refused: its claim stands, and
 *     telling it otherwise would be the same disagreeing-records failure
 *     pointing the other way.
 *
 * There is NO refusal on the CONTENT of the presentation — no "declare only
 * once you have filed a walkthrough". The walkthrough is authored by a wrap-up
 * step that runs AFTER the work invocation ends, so such a refusal could never
 * be satisfied on a first attempt. Do not add one.
 *
 * The refusal also MARKS THE TURN needs-input, and journals why it parked. A
 * refused final is not silence: the agent said where it was and the daemon told
 * it which ending that is, and a human opening the task afterwards is owed that
 * fact on a channel that does not steer the agent.
 */

import type { Storage } from '../storage';
import { normalizeFinalNote } from '../protocol/final-marker';
import { recordFinalClaim, recordNeedsInput } from './turn-ending-registry';
import { getCurrentSha } from '../git/operations';
import { openRaisedItems } from './raised-items';
import { raisedTitle } from '../raised/title';
import { shortId } from '../task/identity';
import { protocolDir as taskProtocolDir } from '../protocol/io';
import { readSupervisorStatusAsync } from '../utils/working-substate';
import { logger } from '../utils/logger';

export interface DeclareFinalParams {
  storage: Storage;
  taskId: string;
  /** The task's worktree — where HEAD is read from. */
  worktreePath: string;
  /** The agent's one-line note, if it wrote one. */
  note?: string;
}

export interface DeclareFinalResult {
  /** HEAD the claim was made at. */
  sha: string;
  /** When it was recorded (epoch ms). */
  at: number;
  note?: string;
  /**
   * This call recorded NOTHING because the claim was already standing — the
   * walkthrough step re-declaring what the work invocation declared. The
   * boundary says so rather than reporting a fresh declaration that did not
   * happen.
   */
  alreadyDeclared?: boolean;
}

/**
 * Thrown for the one refusal, so the MCP boundary can surface it verbatim
 * rather than inventing its own wording.
 */
export class FinalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalRefusedError';
  }
}

/**
 * Record a pencils-down declaration for a task.
 *
 * Refuses — and only refuses — while a blocking raise is open, naming it.
 */
export async function declareFinal(params: DeclareFinalParams): Promise<DeclareFinalResult> {
  const { storage, taskId, worktreePath } = params;

  // THE WALKTHROUGH STEP, which answers one of two ways.
  //
  // Checked FIRST, and neither answer records anything: this is not a statement
  // about how the turn ended but about which invocation is asking, and that is
  // true whatever else is open. The other wrap-up steps deliberately do not
  // reach here at all — they run only on a turn that already declared, so a
  // claim made in one is redundant and true. The presentation step is the only
  // one that also runs on a PARK, which is the whole reason this case exists.
  //
  // The supervisor's status is the seam: it writes `present` before the
  // invocation and `present_done` after it, so a call from inside the
  // walkthrough sees `present` and nothing else can — and it writes
  // `declared_final` alongside, because how the turn ended is the other half
  // of the answer and the daemon cannot see it (the marker was read and
  // cleared before this step ran).
  const step = await presentationStepContext(taskId);
  if (step.isPresentationStep) {
    // ALREADY DECLARED (review c6b6cdde). The claim stands, was made by the
    // work invocation, and a review will dispatch on it. Telling this agent
    // "not the place to declare — do it in your next WORK turn" would be false
    // in the one way this refusal exists to prevent: the agent writes a summary
    // saying it could not hand the work over, next to a task showing a standing
    // final, and nothing says which record is right. So: answered, not refused,
    // and idempotent — the standing claim is returned unchanged rather than
    // re-recorded at a head this step may have moved.
    if (step.declaredFinal) {
      return {
        sha: step.declaredFinal.sha,
        at: Date.parse(step.declaredFinal.declared_at) || Date.now(),
        alreadyDeclared: true,
      };
    }
    // NOT DECLARED. Here the claim really would be dropped — the supervisor
    // carries a claim home only from a turn that had already declared
    // (`carriedFinal`, src/supervisor/wrap-up.ts) — so saying so is the honest
    // answer, and the wording says nothing about a declaration that does exist.
    throw new FinalRefusedError(
      `This is the walkthrough step, and it does not decide how the turn ended: this turn ` +
      `ended WITHOUT a final, and a claim made here is dropped rather than recorded. ` +
      `Write the walkthrough you were asked for. If the work is in fact finished, declare ` +
      `it in your next WORK turn — the walkthrough is re-authored then anyway, because the ` +
      `head will have moved.`,
    );
  }

  const items = await storage.getTaskRaisedItems(taskId);
  const blocking = openRaisedItems(items);
  if (blocking.length > 0) {
    // Name every open one: an agent told about a single item resolves it and
    // calls again, only to be refused by the next — three round trips for one
    // fact the daemon already had.
    const named = blocking
      .map((item) => `${shortId(item.id)} ("${raisedTitle(item.title ?? item.content)}")`)
      .join(', ');

    // THE REFUSAL IS ITSELF A DECLARATION. The agent said "done"; the daemon
    // answered "no, you already chose needs-input". Marking it is how the
    // supervisor — which cannot read lazy state — learns this invocation
    // reached the daemon; best-effort, exactly as when a blocking raise sets
    // it, because losing the mark must never cost the agent its call.
    await recordNeedsInput(taskId);
    // And the same fact for a human opening the task afterwards, on the one
    // channel that reaches them without inventing a status or a UI surface.
    await journalRefusedFinal(storage, taskId, blocking.map((item) => shortId(item.id)));

    throw new FinalRefusedError(
      `This turn is needs-input, not final: ${blocking.length} blocking raise` +
      `${blocking.length === 1 ? ' is' : 's are'} open on this task — ${named}. ` +
      `A blocking raise and a final are the two ENDINGS of a turn and you have already ` +
      `chosen the first: the task will park for a human decision. Answer or withdraw ` +
      `${blocking.length === 1 ? 'it' : 'them'} first if the work is in fact done.`,
    );
  }

  const sha = await getCurrentSha(worktreePath);
  const at = Date.now();
  const note = normalizeFinalNote(params.note);

  await recordFinalClaim(taskId, {
    sha,
    declared_at: new Date(at).toISOString(),
    ...(note ? { note } : {}),
  });

  // A final that SUCCEEDS ends the refusal episode, so the next one — if the
  // same item is ever reopened — is journalled again rather than deduped away.
  try {
    await storage.updateTaskMetadata(taskId, REFUSED_FINAL_KEY, '');
  } catch (err) {
    logger.debug(
      `Task ${shortId(taskId)}: could not clear the refused-final marker — ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logger.info(
    `Task ${shortId(taskId)}: agent declared final at ${sha.substring(0, 8)}` +
    `${note ? ` — ${note}` : ''}`,
  );

  return { sha, at, ...(note ? { note } : {}) };
}

/**
 * Whether the invocation calling us IS the wrap-up's presentation step, and if
 * so whether the turn had already declared before that step started.
 *
 * Read off the supervisor's own status checkpoint rather than passed in: the
 * MCP boundary cannot know which invocation it is serving, and a parameter it
 * had to set would be a rule living in a client (CLAUDE.md — "the daemon owns
 * business logic").
 *
 * Best-effort, and DELIBERATELY fails open. An unreadable status must never
 * cost an agent a declaration it is entitled to make; the supervisor-side drop
 * is the backstop, so the worst case of a missed refusal is exactly today's
 * behaviour, not a wrong record.
 */
async function presentationStepContext(taskId: string): Promise<{
  isPresentationStep: boolean;
  declaredFinal?: { sha: string; declared_at: string };
}> {
  try {
    const status = await readSupervisorStatusAsync(taskProtocolDir(taskId));
    if (status?.phase !== 'present') return { isPresentationStep: false };
    return {
      isPresentationStep: true,
      ...(status.declared_final ? { declaredFinal: status.declared_final } : {}),
    };
  } catch (err) {
    logger.debug(
      `Task ${shortId(taskId)}: could not read the supervisor status for the ` +
      `walkthrough-step answer — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { isPresentationStep: false };
  }
}

/**
 * Record, once per open set, that a `lazy_final` was refused and why.
 *
 * The journal rather than a comment or a status: a journal entry never enters
 * any prompt and never starts a turn, so it tells the human what parked the
 * task without steering the agent. There is deliberately no new status and no
 * new UI surface here — "blocked is blocked even if nothing was explicitly
 * raised", and a real reviewable/needs-input status belongs to the
 * task-statechart work, not to this pass.
 *
 * The task is NOT stuck because of this: accept works from a needs-input park
 * as from any other, with the blocking items resolved in the accept call. The
 * entry explains the park; it does not describe a wall.
 *
 * DEDUPED on the id set. An agent that calls `lazy_final` three times against
 * the same open raise should leave one note, not three; a different open set is
 * a different fact and gets its own.
 *
 * Best-effort at every step: the refusal itself is what the agent must receive,
 * and a journal failure may not turn it into a different error.
 */
async function journalRefusedFinal(
  storage: Storage,
  taskId: string,
  ids: string[],
): Promise<void> {
  const key = ids.join(',');
  try {
    if ((await storage.getTaskMetadata(taskId, REFUSED_FINAL_KEY)) === key) return;
    await storage.appendJournalEntry(
      taskId,
      `## Final refused — parked for a decision\n\n` +
      `The agent declared the work done, but ${ids.length} blocking raise` +
      `${ids.length === 1 ? ' is' : 's are'} still open: ` +
      `${ids.map((id) => `\`${id}\``).join(', ')}. A blocking raise and a final are the two ` +
      `ENDINGS of a turn, so the task parks for a decision. Answer or withdraw the ` +
      `item(s) and the agent can declare final — or resolve them in a \`lazy accept\` ` +
      `and merge the work as it stands.`,
      'system',
    );
    // INVARIANT: the dedupe marker is written LAST, after the entry it
    // suppresses has landed. Written first, one failed journal write silenced
    // the note permanently for that set of ids, and the human would be left
    // with a task parked for no visible reason. A duplicate entry on the next
    // refusal is the cheaper failure.
    await storage.updateTaskMetadata(taskId, REFUSED_FINAL_KEY, key);
  } catch (err) {
    logger.debug(
      `Task ${shortId(taskId)}: could not journal the refused final — ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `The next refusal will try again.`,
    );
  }
}

/** Metadata key holding the open-raise id set the last refusal was journalled for. */
const REFUSED_FINAL_KEY = 'final_refused_raise_ids';
