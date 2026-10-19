/**
 * The alert lazy files ITSELF when a turn fails in a way only a person can fix.
 *
 * Before this, the only alert a broken credential ever produced was one an
 * AGENT wrote with `lazy_message_post` — and when the credential is broken, no
 * agent runs. A system message is what every surface shows (Teams' messages
 * page, `lazy messages`, the dashboard, the builder's launch context), so it is
 * the channel that keeps a dead credential from looking like a quiet review
 * park.
 *
 * ONE MESSAGE PER PROBLEM, NOT PER TURN. The title names the agent profile and
 * the failure class — the credential problem — and is filed with
 * `collapseRepeats`, so while it is OPEN every further failure of that profile
 * (any task, any turn) bumps its repeat count instead of adding a message,
 * and replaces its body so it always names the latest cause.
 * Once a person DISMISSES it, the next failure files a fresh one: a dismissal
 * means "handled", and a failure after that is news. A failure with no known
 * profile is keyed by the task instead.
 */

import type { Storage } from '../storage/interface';
import type { SystemMessage, Task, TurnFailure } from '../types';
import { displayId } from '../task/identity';
import { turnFailureRetryNote } from '../task/turn-failure';
import { logger } from '../utils/logger';

export const TURN_FAILURE_ALERT_SOURCE = 'turn-failure';

/** The title that identifies one credential/config problem. */
export function turnFailureAlertTitle(task: Task, failure: TurnFailure, payer?: string): string {
  if (!failure.agent) return `Turns on task ${displayId(task)} are failing (${failure.class})`;
  // With per-member billing every member pays with their OWN connection, so one
  // member's broken credential is a different problem from another's.
  return payer
    ? `Turns on agent profile "${failure.agent}" paid by ${payer} are failing (${failure.class})`
    : `Turns on agent profile "${failure.agent}" are failing (${failure.class})`;
}

/**
 * File (or bump) the alert for a failed turn. Never throws: the park this
 * follows must land whatever happens here, so a failure to file is logged
 * loudly and the task's own failure label still shows it.
 */
export async function fileTurnFailureAlert(
  storage: Pick<Storage, 'createSystemMessage'>,
  task: Task,
  failure: TurnFailure,
  /**
   * Whose connection the turn spent, when members each pay with their own
   * (team mode): keys the alert per member and scopes its claim to them.
   */
  payer?: string,
): Promise<SystemMessage | null> {
  const id = displayId(task);
  const body = [
    `Task ${id}: its turn failed with ${failure.class}. ${turnFailureRetryNote(failure.class)}`,
    '',
    `What failed: ${failure.reason}`,
    '',
    `What to do: ${failure.remedy}`,
    '',
    failure.agent
      ? `Every task on agent profile "${failure.agent}"${payer ? ` that ${payer} pays for` : ''} fails the same way until then; each shows failed:${failure.class} in the task list. This message counts repeats rather than filing one per turn.`
      : `This message counts repeats rather than filing one per turn.`,
  ].join('\n');
  try {
    return await storage.createSystemMessage(
      { source: TURN_FAILURE_ALERT_SOURCE, kind: 'alert', title: turnFailureAlertTitle(task, failure, payer), body },
      // The title names the problem; the body names its LATEST cause, so a new
      // cause under the same profile and class is what the open alert shows.
      { collapseRepeats: true, refreshBody: true },
    );
  } catch (err) {
    logger.error(
      `Task ${id}: could not file the alert for its ${failure.class} failure: ` +
      `${err instanceof Error ? err.message : String(err)} — the task still shows failed:${failure.class}`,
    );
    return null;
  }
}
