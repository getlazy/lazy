/**
 * What lazy records when a turn's container fails to START.
 *
 * Start, unblock and resume each catch a failed `launchSupervisor` and park
 * the task `interrupted`. That park used to be written with the CALLER as its
 * actor and nothing else: on 2026-10-15 a Teams task went `working →
 * interrupted` two seconds after the member's unblock, recorded as `actor:
 * human` with no turn and no reason, which read as the member stopping it
 * themselves. The launch failure is lazy's, so the transition is the system's,
 * carries its reason, and leaves a failure notice turn — the same visible
 * record (and the same derived `failed:launch_failed` label and alert) a fatal
 * agent failure gets.
 *
 * The human's feedback is untouched: it was recorded as a turn before the
 * launch and stays `pending` (only a COMPLETED turn consumes feedback), so the
 * next unblock or resume carries it.
 */

import type { Storage } from '../storage/interface';
import type { Task, TurnFailure } from '../types';
import { systemActor } from '../identity/system-identity';
import { logger } from '../utils/logger';
import { TURN_FAILURE_LAUNCH_HEADING, turnFailureRemedy } from '../task/turn-failure';
import { createAgentTurn } from './turn-owner';
import { fileTurnFailureAlert } from './turn-failure-alert';

/** The failure notice a launch failure records. */
export function launchFailureOf(task: Pick<Task, 'agent_id'>, err: unknown): TurnFailure {
  const message = err instanceof Error ? err.message : String(err);
  const reason = `the task's container did not start: ${message}`;
  return {
    class: 'launch_failed',
    reason,
    remedy: turnFailureRemedy('launch_failed', reason),
    ...(task.agent_id ? { agent: task.agent_id } : {}),
  };
}

/**
 * Park `task` `interrupted` after its supervisor failed to launch, attributed to
 * the system with the reason, plus a failure notice turn and an alert.
 *
 * The status write is the one thing that must land (callers throw right after),
 * so it goes first; the record-keeping after it is best-effort and logged.
 */
export async function recordLaunchFailure(
  storage: Storage,
  task: Task,
  sessionId: string | null,
  err: unknown,
  projectRoot: string,
): Promise<void> {
  const failure = launchFailureOf(task, err);
  await storage.updateTaskStatus(task.id, 'interrupted', await systemActor(projectRoot), failure.reason);
  await recordLaunchFailureNotice(storage, task, sessionId, failure, projectRoot);
}

/**
 * The record half of {@link recordLaunchFailure} — failure turn, interrupt
 * reason and alert — for a caller that parks the task its own way (auto-deliver
 * parks it paused rather than `interrupted`). Best-effort; never throws.
 */
export async function recordLaunchFailureNotice(
  storage: Storage,
  task: Task,
  sessionId: string | null,
  failure: TurnFailure,
  projectRoot: string,
): Promise<void> {
  if (sessionId) await recordNoticeTurn(storage, task, sessionId, failure, projectRoot);
  // A launch failure is about this task's container, so its alert is keyed by
  // the task, not by the profile (which may be perfectly healthy).
  const { agent: _agent, ...byTask } = failure;
  await fileTurnFailureAlert(storage, task, byTask);
}

async function recordNoticeTurn(
  storage: Storage,
  task: Task,
  sessionId: string,
  failure: TurnFailure,
  projectRoot: string,
): Promise<void> {
  try {
    await storage.recordInterrupt(sessionId, { reason: failure.reason, exit_code: null, logs: null });
    await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content: [TURN_FAILURE_LAUNCH_HEADING, '', `Error: ${failure.reason}`, '', failure.remedy].join('\n'),
      ...(task.agent_id ? { agent: task.agent_id } : {}),
      failure,
      noRunnerImage: true,
    }, projectRoot);
  } catch (recordErr) {
    logger.error(
      `Task ${task.id.substring(0, 8)}: could not record its launch failure as a turn: ` +
      `${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
    );
  }
}
