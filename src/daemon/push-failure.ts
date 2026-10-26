/**
 * The latest FAILED push of a task's branch — the push after each turn and
 * sync's branch export — recorded on the task so a surface can say why work
 * is not on the forge, with the forge's own words, instead of a daemon log
 * line nobody reads.
 *
 * One record per task, cleared by the next push that succeeds. After
 * {@link PUSH_FAILURE_MESSAGE_AFTER_ATTEMPTS} failures in a row one system
 * message is filed (the project-level surface: Messages, its unread count),
 * once per failure episode.
 */

import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { isTerminalStatus } from '../task-state-machine';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';

/** Task metadata key: the latest failed branch push (JSON {@link PushFailure}). */
export const PUSH_FAILURE_KEY = 'push_failure';

export const PUSH_FAILURE_MESSAGE_AFTER_ATTEMPTS = 3;

export interface PushFailure {
  branch: string;
  /** What git / the forge said, as the driver reported it. */
  error: string;
  firstFailedAt: string;
  lastFailedAt: string;
  attempts: number;
  /** A system message has been filed for this episode. */
  messaged?: boolean;
}

export function readPushFailure(task: Pick<Task, 'metadata'>): PushFailure | null {
  const raw = task.metadata?.[PUSH_FAILURE_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PushFailure;
  } catch {
    // A corrupt record is treated as absent: the next failure rewrites it,
    // the next success clears it. Losing it costs one banner, never work.
    return null;
  }
}

/**
 * The push failure a surface should SHOW for this task: the stored record,
 * minus its bookkeeping, or null once the task has left the statuses whose
 * branch is pushed — accepted (`complete`), or closed/rejected (`abandoned`).
 * Nothing pushes a finished task's branch again, so nothing would ever clear
 * the record; leaving it showing put "not on GitHub yet" on work that was
 * merged. The record itself is kept: a reopened task shows it again until its
 * next push succeeds.
 */
export function shownPushFailure(task: Pick<Task, 'metadata' | 'status'>): Omit<PushFailure, 'messaged'> | null {
  if (isTerminalStatus(task.status)) return null;
  const failure = readPushFailure(task);
  if (!failure) return null;
  const { messaged: _messaged, ...shown } = failure;
  return shown;
}

/**
 * Record how a push of `branch` for `taskId` went: `error` null for success.
 * Never throws — recording an outcome must not turn into a second failure in
 * the push loop that called it.
 */
export async function recordPushOutcome(
  storage: Storage,
  taskId: string,
  branch: string,
  rawError: string | null,
): Promise<void> {
  try {
    const task = await storage.getTask(taskId);
    if (!task) return;
    const previous = readPushFailure(task);
    if (rawError === null) {
      if (previous) await storage.updateTaskMetadata(taskId, PUSH_FAILURE_KEY, '');
      return;
    }
    const error = maskUrlCredentials(rawError);
    // The same failure again, already counted and messaged: nothing new to
    // record. The after-turn queue retries every reconcile tick, and a refused
    // push answers identically each time — writing the task on every tick would
    // be a store write per minute per broken branch for no new information.
    if (previous && previous.messaged && previous.branch === branch && previous.error === error) return;
    const now = new Date().toISOString();
    const record: PushFailure = {
      branch,
      error,
      firstFailedAt: previous?.firstFailedAt ?? now,
      lastFailedAt: now,
      attempts: (previous?.attempts ?? 0) + 1,
      ...(previous?.messaged ? { messaged: true } : {}),
    };
    if (record.attempts >= PUSH_FAILURE_MESSAGE_AFTER_ATTEMPTS && !record.messaged) {
      await storage.createSystemMessage({
        source: 'daemon',
        kind: 'alert',
        title: `Pushing ${displayId(task)} to the forge keeps failing`,
        body:
          `The branch \`${branch}\` of **${displayId(task)}** could not be pushed ${record.attempts} times ` +
          `since ${record.firstFailedAt}. The forge said:\n\n\`${error}\`\n\n` +
          `The daemon keeps retrying. If this is an authentication or permission error, check the project's ` +
          `forge credential (Check push access on the project page, or \`lazy doctor\`).`,
      });
      record.messaged = true;
    }
    await storage.updateTaskMetadata(taskId, PUSH_FAILURE_KEY, JSON.stringify(record));
  } catch (err) {
    logger.warn(`Could not record the push outcome of ${branch}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * A git error can carry a remote URL with credentials in it
 * (`https://user:token@host/…`); the stored record and the message never do.
 */
export function maskUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
}
