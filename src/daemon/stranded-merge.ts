/**
 * Recovery for tasks stranded in `merging`.
 *
 * WHAT `merging` MEANS
 * --------------------
 * `merging` is a transient state owned by the accept orchestration
 * (src/daemon/task-lifecycle.ts). It is stamped in two very different
 * situations, told apart by the {@link ACCEPT_IN_FLIGHT_KEY} marker:
 *
 *  - **Local merge in flight** (marker PRESENT, carrying the status the task
 *    held before the accept, next to the persisted accept INTENT —
 *    src/daemon/accept-intent.ts). The accept process is doing the merge right
 *    now. Only that process restores the prior status, only when it fails
 *    BEFORE its merge lands, and only on a FRESH accept — a resume never
 *    restores, since the dead attempt's merge may already have landed.
 *  - **Remote merge pending** (marker ABSENT). `driver.merge()` handed the merge
 *    to the forge; the task waits there until the remote-sync reconciler sees
 *    the PR/MR merged or closed. This is a legitimate resting state and must
 *    never be swept.
 *
 * THE BUG THIS EXISTS FOR (fix-stranded-merging)
 * ----------------------------------------------
 * Nothing answered "is the owner still alive?". If the daemon died mid-accept —
 * restart, crash, OOM, `kill -9` — the marker and the `merging` status stayed on
 * disk with no process left to clear them, and every exit refused:
 * `reject`/`close` hit `Invalid status transition: 'merging' → 'abandoned'`,
 * `submit` hit its own blocked/conflict-only guard, and `reconcileTasks`
 * deliberately excluded `merging` from every sweep. One task in the field sat
 * wedged for two weeks.
 *
 * THE ANSWER
 * ----------
 * The daemon already serializes lifecycle mutations per task
 * ({@link isTaskLifecycleLocked}), and an accept holds that lock for its whole
 * orchestration. So "a `merging` task whose lifecycle lock is NOT held" is
 * exactly "a merge whose owner is gone" — no heartbeat, no timestamp guessing.
 * A dead daemon cannot hold an in-process lock, which is what makes this a
 * complete answer for the case that actually strands tasks.
 *
 * A DEAD ACCEPT IS RESUMED, NEVER RESTORED (fix-accept-resumable, 2026-09)
 * -----------------------------------------------------------------------
 * The first version of this sweep returned a marked task to its prior status.
 * In the field (2026-09-08) an accept squashed eight commits onto the parent,
 * died before finalizing the store, and one minute later this sweep said
 * `blocked`; the next accept re-ran the squash against a parent that already
 * held the content and failed with "squash merge produced no commit". The work
 * was on the parent, the store said `blocked`, and nothing could reconcile
 * them. The human had already said accept, so the sweep now RE-RUNS the accept
 * from the persisted intent: the merge is idempotent on resume (a merge that
 * would change nothing answers "already landed"), and a resume whose merge
 * landed simply finishes the transition to `complete` plus follow-through.
 * After {@link MAX_ACCEPT_RESUME_ATTEMPTS} failed resumes the daemon stops
 * trying on its own, files a system message, and the human's escape
 * (reject/close/submit/unblock) opens again so the task can never wedge.
 *
 * Unmarked `merging` with no forge able to finish it is still restored: no
 * accept intent exists there to resume.
 *
 * WHY NOT JUST ALLOW `merging` → `abandoned`
 * ------------------------------------------
 * Because a task genuinely mid-merge must NOT be abandonable — the transition
 * table is protecting a real in-flight operation there, and widening it would
 * trade a wedge for a corrupted half-merge. Recovery instead returns the task to
 * a real RESTING state and lets the ordinary transitions apply from it, so the
 * FSM keeps meaning what it says.
 */

import type { Storage } from '../storage';
import type { ActorInput, Task, TaskStatus } from '../types';
import { createDriver } from '../remote';
import { loadConfig } from '../config/loader';
import { pausedStatusFor } from '../utils/paused-status';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';
import { isTaskLifecycleLocked, tryWithTaskLifecycleLock } from './task-lifecycle-lock';
import { RpcError } from './rpc-error';
import {
  ACCEPT_FOLLOWTHROUGH_KEY,
  ACCEPT_RESUME_ATTEMPTS_KEY,
  ACCEPT_INTENT_KEY,
  FOLLOWTHROUGH_MESSAGE_AFTER_ATTEMPTS,
  MAX_ACCEPT_RESUME_ATTEMPTS,
  readAcceptIntent,
  readFollowThrough,
  readResumeAttempts,
  readResumeNextAt,
  ACCEPT_RESUME_NEXT_AT_KEY,
  followThroughBackoffMs,
} from './accept-intent';
import { AcceptRefusedError } from './accept-refusal';

/**
 * Task metadata key marking a LOCAL merge phase that is in flight, carrying the
 * status the task held before the accept began.
 *
 * WHY: `merging` means two different things. On the remote path it means "the
 * forge has the merge, we are waiting" — a durable state a later accept
 * re-enters to ask the forge what happened. Stamping `merging` at the START of
 * the local merge phase (which is what makes status honest during the minutes
 * the merge actually takes) would make a CRASHED local merge look exactly like
 * that, sending the next accept down the remote re-entry path for a merge no
 * forge ever heard of. This marker distinguishes them, and doubles as the record
 * of what to restore to.
 */
export const ACCEPT_IN_FLIGHT_KEY = 'accept_in_flight_from';

/** The status a stranded merge was returned to, and how it was classified. */
export interface StrandedMergeRecovery {
  /** Status the task now holds. */
  status: TaskStatus;
  /** Prior status recorded by the in-flight marker, when there was one. */
  recordedPriorStatus: TaskStatus | null;
}

/**
 * Is an accept actively merging this task in this process right now?
 *
 * The one question recovery must get right: a live merge is untouchable, a dead
 * one is wreckage.
 */
export function mergeOwnerIsLive(taskId: string): boolean {
  return isTaskLifecycleLocked(taskId);
}

/**
 * The resting status a stranded merge belongs in.
 *
 * INVARIANT (violations-are-the-source-of-truth): pending file-permission
 * violations mean `conflict`, always — the label is DERIVED from the set, never
 * asserted independently of it (see src/utils/paused-status.ts and the
 * fix-ask-nukes-violations incident, where the two falling out of sync silently
 * destroyed committed agent work).
 *
 * INVARIANT (restore the TRUE prior status): with nothing owed, a task that was
 * `submitted` before the accept goes back to `submitted` — it has an open PR
 * awaiting review, and rewriting that to `blocked` loses a real signal. Any
 * other recorded prior status rests at `blocked`.
 */
export function strandedMergeRestingStatus(
  turns: Parameters<typeof pausedStatusFor>[0],
  recordedPriorStatus: TaskStatus | null,
): TaskStatus {
  const paused = pausedStatusFor(turns);
  if (paused === 'conflict') return 'conflict';
  return recordedPriorStatus === 'submitted' ? 'submitted' : 'blocked';
}

/**
 * Return a task stranded in `merging` to a real resting state.
 *
 * Callers MUST have established that no accept owns the merge — either by
 * holding the task's lifecycle lock, or via {@link mergeOwnerIsLive}. This
 * function does not re-check, because the only safe way to check is to hold the
 * lock while acting.
 *
 * `note` is recorded as a task comment so the recovery is visible in history
 * rather than being a silent status rewrite.
 */
export async function recoverStrandedMerge(
  storage: Storage,
  task: Task,
  actor: ActorInput,
  note: string,
): Promise<StrandedMergeRecovery> {
  const recorded = (task.metadata?.[ACCEPT_IN_FLIGHT_KEY] || null) as TaskStatus | null;

  let turns: Awaited<ReturnType<Storage['getSessionTurns']>> = [];
  try {
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess) turns = await storage.getSessionTurns(sess.id);
  } catch (err) {
    // Same posture as parkTaskPaused: failing to read the violation set is not
    // fatal — we fall back to `blocked`, and the pending set (if any) is still
    // enforced at unblock. Recovering the task matters more than the label.
    logger.warn(
      `Task ${displayId(task)}: could not read violations while recovering a stranded merge — ` +
      `resting as 'blocked'. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const status = strandedMergeRestingStatus(turns, recorded);
  await storage.updateTaskStatus(task.id, status, actor);
  // Clear the marker only AFTER the status write lands: the marker is what a
  // later accept (or another recovery) reads to know a local merge died, so it
  // must outlive any failure of the restore itself.
  await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, '');
  // Every resume key goes with the marker: a leftover exhausted attempt count
  // would stop the sweep from ever resuming a LATER accept of this task, and a
  // stale intent could be read as that accept's decision.
  await storage.updateTaskMetadata(task.id, ACCEPT_INTENT_KEY, '');
  await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_ATTEMPTS_KEY, '');
  await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_NEXT_AT_KEY, '');
  await storage.createComment(task.id, note, actor);

  return { status, recordedPriorStatus: recorded };
}

/**
 * Should the automatic sweep recover this `merging` task?
 *
 * The sweep is deliberately narrower than the on-demand escape a human gets from
 * reject/close/submit. A human asking to close a task has decided; the sweep is
 * acting on its own, so it only moves tasks that provably have no owner AND
 * nothing that could ever finish them:
 *
 *  - marker present → an accept died. Resume it (never restore).
 *  - marker absent, no remote driver → nobody handed this to a forge and no
 *    forge can complete it. It cannot be a legitimate remote-pending merge, so
 *    something stamped `merging` and died. Recover.
 *  - marker absent, remote driver configured → the forge owns the merge and
 *    remote-sync polls it. Leave it alone; `lazy doctor` reports it if it sits
 *    there, and the human can still escape it explicitly.
 */
export function shouldSweepStrandedMerge(opts: {
  hasInFlightMarker: boolean;
  remoteDriverCanFinishMerge: boolean;
}): boolean {
  return opts.hasInFlightMarker || !opts.remoteDriverCanFinishMerge;
}

/**
 * Finish tasks stranded in `merging`: RESUME a dead accept (marker present),
 * and return a markerless `merging` task no forge can finish to a resting state.
 *
 * Runs on every reconcile tick, which means it also runs shortly after daemon
 * startup — the moment that matters most, since a daemon restart is the likeliest
 * way to kill an accept mid-merge.
 */
export async function sweepStrandedMerging(storage: Storage, lazyRoot: string): Promise<void> {
  const merging = await storage.listTasksWithOptions({ mergingOnly: true });
  if (merging.length === 0) return;

  let remoteDriverCanFinishMerge = false;
  try {
    const config = await loadConfig(lazyRoot);
    remoteDriverCanFinishMerge = createDriver(config).needsSync;
  } catch (err) {
    // Unreadable config or an unconstructable driver is not evidence that no
    // forge owns these merges. Assume one might, so the sweep only acts on
    // tasks carrying the in-flight marker.
    remoteDriverCanFinishMerge = true;
    logger.debug(`Stranded-merge sweep: could not resolve the remote driver: ${err instanceof Error ? err.message : err}`);
  }

  for (const task of merging) {
    try {
      // A live accept owns this merge — never touch it.
      if (mergeOwnerIsLive(task.id)) continue;

      const hasInFlightMarker = !!task.metadata?.[ACCEPT_IN_FLIGHT_KEY];
      if (!shouldSweepStrandedMerge({ hasInFlightMarker, remoteDriverCanFinishMerge })) continue;

      // INVARIANT (a dead accept never restores): a marked task is an accept the
      // human authorized whose process died — resume it. Restoring put merged
      // work on a `blocked` task nothing could reconcile (see file header).
      if (hasInFlightMarker) {
        if (readResumeAttempts(task) >= MAX_ACCEPT_RESUME_ATTEMPTS) continue; // the human's now
        if (resumesInFlight.has(task.id)) continue;
        // Backoff: the sweep runs every few seconds, and without it three attempts
        // would burn in seconds on a transient refusal.
        if (readResumeNextAt(task) > Date.now()) continue;
        // Not awaited: an accept can take minutes (description synthesis, the
        // merge itself) and must not stall the reconcile tick. The task's
        // lifecycle lock — taken by the accept — keeps the next tick off it.
        // resumeDeadAccept never rejects (it records its own failures).
        resumesInFlight.set(
          task.id,
          resumeDeadAccept(storage, lazyRoot, task).finally(() => resumesInFlight.delete(task.id)),
        );
        continue;
      }

      const recovery = await recoverStrandedMerge(
        storage,
        task,
        'system',
        `[Recovered] The accept that put this task in 'merging' is no longer running, so nothing could ` +
        `finish or undo the merge. Returned to '${await previewRestingStatus(storage, task)}' — accept, ` +
        `unblock, submit, reject or close it as usual.`,
      );
      logger.warn(
        `Task ${displayId(task)}: recovered from a stranded 'merging' state to '${recovery.status}' ` +
        `(no accept in flight${recovery.recordedPriorStatus ? `; local merge died from '${recovery.recordedPriorStatus}'` : '; no merge was handed to a forge'}).`,
      );
    } catch (err) {
      logger.warn(`Stranded-merge recovery failed for ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** The status {@link recoverStrandedMerge} will pick, for use in its own comment text. */
async function previewRestingStatus(storage: Storage, task: Task): Promise<TaskStatus> {
  try {
    const sess = await storage.getSessionByTaskId(task.id);
    const turns = sess ? await storage.getSessionTurns(sess.id) : [];
    return strandedMergeRestingStatus(turns, (task.metadata?.[ACCEPT_IN_FLIGHT_KEY] || null) as TaskStatus | null);
  } catch {
    // Only used to phrase a comment; the authoritative pick happens in
    // recoverStrandedMerge, which logs its own fallback.
    return 'blocked';
  }
}

/**
 * On-demand escape from `merging` for a human-initiated operation
 * (reject / close / submit / unblock).
 *
 * Returns the task unchanged when it is not `merging`. Otherwise:
 *
 *  - a live accept owns the merge → refuse with an actionable 409. Interrupting
 *    a real merge is the one outcome worse than the wedge.
 *  - nothing owns it → recover to a resting state and return the refreshed task,
 *    so the caller's ordinary transition applies from a state the FSM allows.
 *
 * Unlike {@link sweepStrandedMerging} this does NOT exempt a forge-pending merge:
 * the human has explicitly asked to close/reject/submit THIS task and is entitled
 * to act on it. The automatic sweep is the cautious one; a direct instruction is
 * not second-guessed.
 */
export async function escapeMergingForOperation(
  storage: Storage,
  task: Task,
  actor: ActorInput,
  operation: string,
  projectRoot: string,
): Promise<Task> {
  if (task.status !== 'merging') return task;

  let landedOn = '';
  const attempt = await tryWithTaskLifecycleLock(task.id, async () => {
    // Re-read under the lock: an accept may have finished (or aborted) between
    // the caller's read and our acquisition, in which case there is nothing to
    // recover and the caller should act on the real current status.
    const fresh = (await storage.getTask(task.id)) ?? task;
    if (fresh.status !== 'merging') return fresh;

    // INVARIANT (a dead accept never restores): a marked merge belongs to an
    // accept the human already authorized; the daemon is resuming it. Only once
    // its automatic resumes are exhausted does the human's escape open, so the
    // task can never wedge the way it did before fix-stranded-merging.
    if (fresh.metadata?.[ACCEPT_IN_FLIGHT_KEY] && readResumeAttempts(fresh) < MAX_ACCEPT_RESUME_ATTEMPTS) {
      return RESUME_IN_PROGRESS;
    }

    // INVARIANT (never restore over landed work — the 2026-09-08 incident):
    // with resumes exhausted the escape reopens so the task cannot wedge, but
    // it asks the TREES first. If the dead accept's work is already on the
    // target, restoring would put merged work on a `blocked` task that no later
    // accept can reconcile ("squash merge produced no commit"). Refuse and send
    // the human to `lazy accept`, which finishes it.
    if (fresh.metadata?.[ACCEPT_IN_FLIGHT_KEY]) {
      const { acceptWorkLanded } = await import('./task-lifecycle');
      const config = await loadConfig(projectRoot);
      const landed = await acceptWorkLanded(storage, projectRoot, fresh, config);
      if (landed) {
        landedOn = landed.where === 'remote' ? `${config.remote.git_remote}/${landed.target}` : landed.target;
        return WORK_LANDED;
      }
    }

    await recoverStrandedMerge(
      storage,
      fresh,
      actor,
      `[Recovered] \`lazy ${operation}\` found this task stranded in 'merging' with no accept running. ` +
      `The merge that stamped it is gone, so the task was returned to a resting state and ${operation} proceeded.`,
    );
    return (await storage.getTask(task.id)) ?? fresh;
  });

  if (attempt.ran && attempt.value === WORK_LANDED) {
    throw new RpcError(
      409,
      `Task ${displayId(task)}'s accept died, but its work is already on ${landedOn} — the merge landed. ` +
      `${operation} would put merged work back on a task that no later accept can finish. ` +
      `Run \`lazy accept ${displayId(task)}\` to finish the accept.`,
    );
  }
  if (attempt.ran && attempt.value === RESUME_IN_PROGRESS) {
    throw new RpcError(
      409,
      `Task ${displayId(task)} was accepted, and that accept is being resumed by the daemon — the process ` +
      `running it died, and the human's decision to accept stands. ${operation} would undo an accept that ` +
      `may already have merged. Wait for the resume (\`lazy show ${displayId(task)}\`), or run ` +
      `\`lazy accept ${displayId(task)}\` to resume it now and see any error.`,
    );
  }
  if (!attempt.ran) {
    throw new RpcError(
      409,
      `Task ${displayId(task)} is merging right now — an accept is actively merging it in this daemon, ` +
      `so ${operation} would interrupt a merge in progress. Wait for the accept to finish ` +
      `(\`lazy show ${displayId(task)}\` reports the resulting status), then run ${operation} again.`,
    );
  }
  return attempt.value as Task;
}

const RESUME_IN_PROGRESS = Symbol('resume-in-progress');
const WORK_LANDED = Symbol('work-landed');

/** Resumes launched by the sweep and not yet settled (this process only). */
const resumesInFlight = new Map<string, Promise<void>>();

/**
 * Wait for every accept resume the sweep launched in this process. For one-shot
 * reconcile passes (tests, tooling) that exit after the pass — the daemon never
 * needs it, since it outlives the resumes.
 */
export async function settleAcceptResumes(): Promise<void> {
  await Promise.all([...resumesInFlight.values(), ...followThroughsInFlight.values()]);
}

/** Follow-through retries launched by Sweep 9b and not yet settled (this process only). */
const followThroughsInFlight = new Map<string, Promise<void>>();

/**
 * Re-run a dead accept from its persisted intent.
 *
 * Never restores the task. A failure is counted, recorded on the task as a
 * comment, and — once {@link MAX_ACCEPT_RESUME_ATTEMPTS} is reached with the
 * task still marked — filed as a system message for the human.
 */
export async function resumeDeadAccept(storage: Storage, lazyRoot: string, task: Task): Promise<void> {
  const attempt = readResumeAttempts(task) + 1;
  const intent = readAcceptIntent(task);
  try {
    await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_ATTEMPTS_KEY, String(attempt));
    if (!intent) {
      logger.warn(`Task ${displayId(task)}: resuming a dead accept with no persisted intent (written before intents existed) — the [Accepted] comment will say so.`);
    }
    logger.warn(`Task ${displayId(task)}: resuming an accept that died mid-flight (attempt ${attempt}/${MAX_ACCEPT_RESUME_ATTEMPTS}).`);
    const { acceptTask } = await import('./task-lifecycle');
    await acceptTask(lazyRoot, {
      taskId: task.id,
      reason: intent?.reason ?? 'Accept resumed by the daemon after the accepting process died (original reason was not recorded).',
      actor: intent?.actor ?? 'system',
      ...(intent?.approvedFiles ? { approvedFiles: intent.approvedFiles } : {}),
      ...(intent?.acceptDirtyWorktree ? { acceptDirtyWorktree: true } : {}),
      ...(intent?.allowBroken ? { allowBroken: true } : {}),
      ...(intent?.allowReviewIssues ? { allowReviewIssues: true } : {}),
      // No callerTaskId, ever: see AcceptIntent. A resume into an active parent
      // is refused (parent-active) and rescheduled until the parent is quiet.
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Somebody else (a human re-accept, or remote-sync) finished this accept
    // while the resume waited for the lock: that is success, not a failure —
    // no attempt spent, no alarming comment.
    const finished = err instanceof AcceptRefusedError && err.remedy?.reason === 'already-accepted';
    const now = await storage.getTask(task.id).catch(() => null);
    if (finished || (now && !(now.status === 'merging' && now.metadata?.[ACCEPT_IN_FLIGHT_KEY]))) {
      logger.info(`Task ${displayId(task)}: the dead accept was finished elsewhere (${now?.status ?? 'unknown'}); nothing to resume.`);
      return;
    }
    // A parent that is busy (its agent working again after the restart that
    // killed this accept) is a "not yet", not a failure: reschedule without
    // spending an attempt. Merging into a working parent's worktree is exactly
    // what the parent-active refusal exists to prevent.
    if (err instanceof AcceptRefusedError && err.remedy?.reason === 'parent-active') {
      try {
        await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_ATTEMPTS_KEY, String(attempt - 1));
        await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_NEXT_AT_KEY, String(Date.now() + followThroughBackoffMs(1)));
      } catch (recordErr) {
        logger.warn(`Task ${displayId(task)}: could not reschedule the accept resume: ${recordErr instanceof Error ? recordErr.message : recordErr}`);
      }
      logger.info(`Task ${displayId(task)}: accept resume waits — ${msg}`);
      return;
    }
    try {
      await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_NEXT_AT_KEY, String(Date.now() + followThroughBackoffMs(attempt)));
    } catch (recordErr) {
      logger.warn(`Task ${displayId(task)}: could not record the resume backoff: ${recordErr instanceof Error ? recordErr.message : recordErr}`);
    }
    logger.warn(`Task ${displayId(task)}: resuming the dead accept failed (attempt ${attempt}/${MAX_ACCEPT_RESUME_ATTEMPTS}): ${msg}`);
    try {
      const fresh = await storage.getTask(task.id);
      const stillMarked = fresh?.status === 'merging' && !!fresh.metadata?.[ACCEPT_IN_FLIGHT_KEY];
      await storage.createComment(
        task.id,
        `[Accept resume failed] Attempt ${attempt}/${MAX_ACCEPT_RESUME_ATTEMPTS} to finish this task's accept failed: ${msg}` +
        (stillMarked ? '' : `\nThe accept stopped before its merge and returned the task to '${fresh?.status}'.`),
        'system',
      );
      if (stillMarked && attempt >= MAX_ACCEPT_RESUME_ATTEMPTS) {
        await storage.createSystemMessage({
          source: 'daemon',
          kind: 'alert',
          title: `Accept of ${displayId(task)} could not be finished`,
          body:
            `An accept of **${displayId(task)}** died mid-flight and the daemon failed to resume it ${attempt} times. ` +
            `The last error was:\n\n\`\`\`\n${msg}\n\`\`\`\n\n` +
            `The daemon has stopped retrying. Run \`lazy accept ${displayId(task)}\` to resume it and see the error, ` +
            `or reject/close the task if the work should not land.`,
        });
      }
    } catch (recordErr) {
      logger.warn(`Task ${displayId(task)}: could not record the failed accept resume: ${recordErr instanceof Error ? recordErr.message : recordErr}`);
    }
  }
}

/**
 * Retry post-accept follow-through the daemon still owes (Sweep 9b).
 *
 * A `complete` task carrying {@link ACCEPT_FOLLOWTHROUGH_KEY} merged and was
 * accepted, but some step after the transition (fast-forward, parent push, tag,
 * reparent, cleanup) failed. Retried with backoff until done; after
 * {@link FOLLOWTHROUGH_MESSAGE_AFTER_ATTEMPTS} failures a system message says
 * what is failing. Never changes status.
 */
export async function sweepAcceptFollowThrough(storage: Storage, lazyRoot: string): Promise<void> {
  const tasks = await storage.listTasks();
  const owed = tasks.filter((t) => t.status === 'complete' && !!t.metadata?.[ACCEPT_FOLLOWTHROUGH_KEY]);
  for (const task of owed) {
    const record = readFollowThrough(task);
    if (record?.nextAttemptAt && record.nextAttemptAt > Date.now()) continue;
    if (followThroughsInFlight.has(task.id)) continue;
    // Not awaited: follow-through pushes over the network, synthesizes the
    // parent's description and removes containers — minutes, which must not
    // stall every other sweep on the tick.
    followThroughsInFlight.set(
      task.id,
      retryFollowThrough(storage, lazyRoot, task).finally(() => followThroughsInFlight.delete(task.id)),
    );
  }
}

/** One Sweep 9b retry. Never rejects — failures are logged and recorded. */
export async function retryFollowThrough(storage: Storage, lazyRoot: string, task: Task): Promise<void> {
  {
    try {
      const attempt = await tryWithTaskLifecycleLock(task.id, async () => {
        const { runAcceptFollowThrough } = await import('./task-lifecycle');
        return runAcceptFollowThrough(lazyRoot, task.id);
      });
      if (!attempt.ran || attempt.value.pending.length === 0) return;
      const after = readFollowThrough((await storage.getTask(task.id)) ?? task);
      if (after && after.attempts >= FOLLOWTHROUGH_MESSAGE_AFTER_ATTEMPTS && !after.messaged) {
        await storage.createSystemMessage({
          source: 'daemon',
          kind: 'alert',
          title: `Post-accept follow-through keeps failing for ${displayId(task)}`,
          body:
            `**${displayId(task)}** is accepted and its merge landed, but finishing the accept has failed ` +
            `${after.attempts} times.\n\nFailing step: \`${after.lastError}\`\n\n` +
            `Still pending: ${attempt.value.pending.join(', ')}.\n\n` +
            `The daemon keeps retrying with backoff. If the failure is a push, check that \`${after.targetBranch}\` ` +
            `can be pushed (credentials, network, branch protection) — until it is, the local branch is ahead of the remote.`,
        });
        after.messaged = true;
        await storage.updateTaskMetadata(task.id, ACCEPT_FOLLOWTHROUGH_KEY, JSON.stringify(after));
      }
    } catch (err) {
      logger.warn(`Post-accept follow-through retry failed for ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
