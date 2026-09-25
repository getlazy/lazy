/**
 * Has the supervisor handed this task back?
 *
 * ENGINEER RULE (2026-09-20): the daemon must never act on a task before the
 * supervisor has returned control. The post-turn check, the wrap-up steps and
 * everything else the supervisor runs after the agent's last message are the
 * supervisor's own work; the daemon reacts to the turn only once the supervisor
 * has handed the task back and the task has parked.
 *
 * A PARKED STATUS IS NOT BY ITSELF THAT HANDBACK, which is why this module
 * exists. Two windows sit between "the task reads as parked" and "nobody owns
 * this turn any more":
 *
 *   - the SETTLE's own tail. `handleCompletedResponses` parks the task
 *     (`parkTaskPaused`) and only then consumes `response.json` and clears
 *     `status.json`. A dispatch landing in between takes a task to `working`
 *     while its previous turn's response is still in the mailbox — and the next
 *     tick then has to decide what that response answers.
 *   - a LAUNCH in progress. Another writer that has written `command.json` but
 *     not yet flipped the status owns this task; its own settle path owns the
 *     mailbox. (Read together with liveness — see below, an unconsumed command
 *     left by a run that DIED is debris, not ownership.)
 *
 * And the plain case the rule is written for: a supervisor still inside
 * `post_turn_check` / `wrap_up` / `post_turn_sync`. That one normally shows as
 * `working` too, so the status gate usually catches it; this is the check that
 * does not depend on the status having been read at the right instant.
 *
 * Every answer is a REASON STRING or null. A caller that skips on a reason skips
 * for one tick and retries — none of these are conditions to record against a
 * task, which is the other half of the fix: a review the daemon chose not to
 * start yet is not a review that failed.
 */

import { join } from 'path';

import type { Task } from '../types';
import type { Runner, RunnerType } from '../runner/types';

import { protocolDir } from '../protocol';
import { createRunner } from '../runner';
import { taskRef, shortId } from '../task/identity';
import { pathExists } from '../utils/fs';
import { logger } from '../utils/logger';
import { ACTIVE_HARNESS_PHASES, readSupervisorStatusAsync } from '../utils/working-substate';

/**
 * Why the supervisor still owns this task's turn, or null when it has handed
 * back and the daemon is free to act.
 *
 * `session` is optional: without it the liveness probe falls back to the
 * runner's default name for the task, exactly as the reconciler does.
 */
export async function supervisorStillOwnsTurn(
  lazyRoot: string,
  task: Task,
  session?: { container_name: string | null; runner_type?: RunnerType | null } | null,
): Promise<string | null> {
  const dir = protocolDir(task.id);

  // AN UNSETTLED RESPONSE IS OWNERSHIP WITH NOBODY ALIVE, so it is the one
  // signal that does not ask about liveness. `response.json` exists exactly when
  // the supervisor has finished and (for a review, always) already exited; the
  // turn is not over until a settler has consumed it, and the settler is the
  // same tick loop the caller is standing in. Launching across it displaces an
  // answer somebody is about to record.
  if (await pathExists(join(dir, 'response.json'))) {
    return 'its last turn\'s response has not been settled yet';
  }

  // The other two signals — an unconsumed `command.json` and a recorded
  // `ACTIVE_HARNESS_PHASES` phase — mean ownership ONLY IF SOMEBODY IS ALIVE TO
  // OWN IT. Both are written by a supervisor and cleared by one, so a run that
  // died leaves them behind verbatim, and reading that debris as ownership
  // wedges every automatic launch on the task forever — strictly worse than the
  // race this module closes. Auto-resume is the sharpest case: an `interrupted`
  // task's mailbox holds the dead turn's own command, and replacing it is that
  // path's entire job.
  const pendingCommand = await pathExists(join(dir, 'command.json'));
  const status = await readSupervisorStatusAsync(dir);
  const activePhase = status && ACTIVE_HARNESS_PHASES.has(status.phase) ? status.phase : null;
  if (!pendingCommand && !activePhase) return null;

  // Probed last: it costs a docker call, and everything above is a stat.
  let runner: Runner;
  try {
    runner = await createRunner(lazyRoot, session?.runner_type ?? undefined);
  } catch (err) {
    // Cannot probe: do not manufacture ownership out of an unanswerable
    // question — the status gate and the in-flight record still stand.
    logger.debug(
      `Task ${shortId(task.id)}: no runner to probe supervisor liveness ` +
      `(${err instanceof Error ? err.message : err}); treating the turn as handed back`,
    );
    return null;
  }

  const runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
  try {
    if (!(await runner.isRunning(runName))) return null;
  } catch (err) {
    logger.debug(
      `Task ${shortId(task.id)}: supervisor liveness probe for '${runName}' failed ` +
      `(${err instanceof Error ? err.message : err}); treating the turn as handed back`,
    );
    return null;
  }

  return activePhase
    ? `its supervisor is still in '${activePhase}'`
    : 'a turn command is pending in its mailbox and its supervisor is still running';
}
