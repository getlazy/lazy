/**
 * ONE rule for what may still be edited on a task.
 *
 * The daemon ENFORCES it (src/daemon/edit-task.ts, behind `lazy edit`,
 * `lazy_edit` and the `editTask` RPC). The web UI has to render the same answer
 * *before* the human types — a form that offers a prompt box the daemon will
 * then refuse is exactly the "raw RPC error" failure this surface exists to
 * avoid. Both import this module rather than each keeping a copy: two copies of
 * this predicate drift into a UI that promises what the daemon refuses.
 *
 * Deliberately split in two: {@link taskEditability} is the predicate, and
 * {@link lockedFieldsReason} is the human-facing sentence. The daemon keeps its
 * own refusal wording (it is right for a CLI, and names every locked field); the
 * UI needs product language that says what IS still possible.
 */

import { isTerminalStatus } from './types';
import type { TaskStatus } from './types';

/** Fields an agent may already have acted on — locked once a turn has run. */
export const LOCKED_ONCE_STARTED = ['goal', 'prompt', 'type', 'code', 'parent'] as const;

/** Fields that only shape the NEXT turn — changeable while a task is alive. */
export const MID_FLIGHT_EDITABLE = ['model', 'effort', 'runner', 'agent'] as const;

export interface TaskEditability {
  /** Terminal tasks (complete, abandoned) cannot be edited at all. */
  terminal: boolean;
  /** At least one turn has run, so an agent has read the goal and prompt. */
  started: boolean;
  /** goal / prompt / type / code / parent */
  canEditLockedFields: boolean;
  /** model / effort / runner / agent */
  canEditMidFlightFields: boolean;
}

export function taskEditability(status: TaskStatus, turnCount: number): TaskEditability {
  const terminal = isTerminalStatus(status);
  const started = turnCount > 0;
  return {
    terminal,
    started,
    canEditLockedFields: !terminal && !started,
    canEditMidFlightFields: !terminal,
  };
}

/**
 * Why the goal and prompt cannot be edited, in product language, or null when
 * they can. Says what is still possible — a refusal that only closes doors
 * leaves the human with nowhere to go.
 */
export function lockedFieldsReason(status: TaskStatus, turnCount: number): string | null {
  const editability = taskEditability(status, turnCount);
  if (editability.terminal) {
    return `This task is ${status} — it can no longer be edited.`;
  }
  if (!editability.started) return null;
  const turns = turnCount === 1 ? '1 turn' : `${turnCount} turns`;
  return (
    `This task has already run ${turns}, so its goal and prompt are locked — an agent has ` +
    `read them and acted on them. You can still change the model, effort and agent; those ` +
    `take effect on the next turn.`
  );
}
