/**
 * A member entering a task's environment on a shared daemon — the half of the
 * mutual exclusion between member terminals and turns that the MEMBER's side
 * runs.
 *
 * A member's terminals run in a container of their own
 * (./member-container.ts), never in the task's, so nothing of a turn — its
 * processes, its placeholder, its MCP token — is ever within their reach, and
 * nothing of theirs within a turn's. What the two still share is the
 * worktree's files. So they take turns with it:
 *
 *   - a member cannot get in while a turn runs on the task — checked here,
 *     under the task's lifecycle lock;
 *   - a turn cannot start while a member is in — every launch path checks the
 *     hold (`refuseLaunchWhileMemberInside`, ./turn-credentials.ts) under the
 *     same lock.
 *
 * Getting in is recorded on the in-memory hold (../server/member-terminals.ts)
 * INSIDE the lock, so whichever of the two takes the lock second sees the
 * other.
 *
 * And no process of a turn runs beside a member, either. Between turns the
 * task's container stays up (a dev server, a watcher, anything a turn left
 * behind in it keeps running), and those processes can write the worktree —
 * including its git pointers, after the member's launch checked them. So the
 * entry STOPS the task's container, in the same lock, before the member's own
 * container is started ({@link stopTaskContainerForMember}); and nothing
 * brings it back while the member is inside: every turn launch refuses, and so
 * does the container-only bring-up (./task-container.ts).
 */

import type { Storage } from '../storage';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { getTaskSessionBinding, type SessionCredentialBinding } from './session-credentials';
import { markMemberTerminalEntered, memberInsideTask, memberInsideSyncMessage, memberInsideEnvironmentMessage } from '../server/member-terminals';
import { RpcError } from './rpc-error';
import { isTerminalStatus } from '../task-state-machine';
import { createRunner } from '../runner';
import { taskRef } from '../task/identity';
import type { Session, Task } from '../types';
import { logger } from '../utils/logger';
import { supervisorStillOwnsTurn } from './supervisor-handback';
import { checkPairingLock } from '../utils/pairing-lock';
import { readLock, lockHeldHere } from '../utils/lock';
import { readProcessIdentity, looksLikeLazyProcess } from '../utils/process-identity';
import { getWorktreePath } from '../task/identity';

/**
 * Tasks whose worktree something other than a turn is about to change — a
 * reject or close tearing it down, or a child's accept merging into it — with
 * how many such claims are open. A member's entry is refused while a task has
 * one, so nothing can get in between the claim's member check and the change.
 * Counted, because two claims can overlap (two children accepted into one
 * parent) and the first to finish must not let members back in under the
 * other.
 */
const worktreeClaims = new Map<string, number>();

/**
 * Claim a task's worktree for a change a member must not be working under:
 * refuse (409, naming them) while a member has a terminal open on it, and
 * otherwise keep members out until `release` is called (once; later calls do
 * nothing). Under the task's lifecycle lock, like the entry it excludes.
 *
 * Used by reject and close on the task itself, and by a child's accept on its
 * PARENT, whose worktree the merge lands in. An accept on the task itself
 * needs none of this: it runs entirely under that task's lock and checks
 * `memberInsideTask` before its merge phase.
 */
export async function beginWorktreeTeardown(taskId: string): Promise<() => void> {
  return withTaskLifecycleLock(taskId, async () => {
    const holder = memberInsideTask(taskId);
    if (holder) throw new RpcError(409, memberInsideSyncMessage(holder));
    worktreeClaims.set(taskId, (worktreeClaims.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (worktreeClaims.get(taskId) ?? 1) - 1;
      if (left > 0) worktreeClaims.set(taskId, left);
      else worktreeClaims.delete(taskId);
    };
  });
}

/**
 * Tasks whose own container is being brought up without a turn right now
 * (`ensureTaskContainer`, ./task-container.ts), with how many bring-ups are
 * in flight. A member's entry refuses while a task has one: the entry stops
 * that container, and the bring-up would start it again beside the member.
 */
const containerBringUps = new Map<string, number>();

/**
 * Claim a task for a container bring-up: refuse (409) while a member is
 * inside, otherwise keep members out until `release` is called (once).
 * Only the check and the claim run under the task's lifecycle lock; the
 * bring-up itself, which can build an image for minutes, runs outside it.
 */
export async function beginTaskContainerBringUp(taskId: string): Promise<() => void> {
  return withTaskLifecycleLock(taskId, async () => {
    const holder = memberInsideTask(taskId);
    if (holder) throw new RpcError(409, memberInsideEnvironmentMessage(holder));
    containerBringUps.set(taskId, (containerBringUps.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (containerBringUps.get(taskId) ?? 1) - 1;
      if (left > 0) containerBringUps.set(taskId, left);
      else containerBringUps.delete(taskId);
    };
  });
}

/**
 * Is a turn running on this task — its status is `working`, or its credential
 * binding is live (a launch has bound it, whether or not the status has
 * flipped yet)?
 */
export async function taskTurnRunning(
  projectRoot: string,
  storage: Pick<Storage, 'getTask'>,
  taskId: string,
  bindingFor: (taskId: string) => Promise<Pick<SessionCredentialBinding, 'revokedAt'> | null> = (id) => getTaskSessionBinding(projectRoot, id),
): Promise<boolean> {
  const task = await storage.getTask(taskId);
  if (task?.status === 'working') return true;
  const binding = await bindingFor(taskId);
  return !!binding && binding.revokedAt === null;
}

/**
 * Stop the task's own container (or host run), if it is running, and confirm
 * it has stopped. Throws when it could not be stopped.
 *
 * STOPPED, not removed. The next turn recovers exactly as it does after any
 * container that died between turns: every launch path sees the run is not
 * running, removes it and records that (`removeTaskRun`), and creates a fresh
 * one. What a resume needs is not in the container — the agent's session id is
 * on the session record (written when the turn finalized, which it has: no
 * turn is running, checked just before) and its transcripts are in the task's
 * sandbox on the host, mounted in. The supervisor keeps nothing else there
 * between turns. Stopping leaves one thing removing would not: the dead
 * container's logs, readable until that next launch, when a turn left
 * something behind that someone wants to look at.
 */
export async function stopTaskContainerForMember(projectRoot: string, task: Task, session: Session): Promise<void> {
  const runner = await createRunner(projectRoot, session.runner_type ?? task.runner_type ?? undefined);
  const name = session.container_name ?? runner.runNameForTask(taskRef(task));
  if (!(await runner.isRunning(name))) return;
  const stopped = await runner.stopRun(name);
  if (!stopped || (await runner.isRunning(name))) {
    throw new Error(`the task's own environment (${name}) could not be stopped`);
  }
  logger.info(`[${task.id.substring(0, 8)}] Stopped the task's environment (${name}) so a member can work in the task alone.`);
}

/** Is the task being paired on, and whose web Pair (if any) holds it? */
async function pairingState(projectRoot: string, task: Task): Promise<{ pairing: boolean; webPairEmail: string | null }> {
  // Imported here: ../server/shell-pair.ts imports this module.
  const { webPairHolderEmail } = await import('../server/shell-pair');
  const webPairEmail = webPairHolderEmail(task.id);
  const locked = !!checkPairingLock(getWorktreePath(projectRoot, task));
  return { pairing: task.status === 'pairing' || locked || webPairEmail !== null, webPairEmail };
}

/** Whose web Chat holds the task, if any, and what holds its worktree lock. */
/**
 * What the refusal may say about each operation this daemon takes a worktree
 * lock for — fixed wording, never the lock's own text.
 */
const DAEMON_LOCK_WORDING: Record<string, string> = {
  'lazy chat (web)': 'a Chat with the agent',
  'lazy accept (acceptance gate)': "an accept's checks",
  'lazy sync': 'a sync',
  'lazy sync (self)': 'a sync',
  'lazy start': 'a turn starting',
  'lazy unblock': 'a turn starting',
  'lazy resume': 'a turn starting',
  'lazy auto-resume': 'a turn starting',
  'lazy auto-deliver': 'a turn starting',
  'lazy ask': 'a question to the agent',
  'lazy review': 'a review',
};

/**
 * Whose web Chat holds the task, if any, and whether something holds its
 * worktree lock — and, if so, how the refusal may describe it.
 *
 * The lock FILE is in the worktree, which the task's agent can write, so
 * nothing in it is shown and it is not believed on its own word:
 *
 *   - a lock THIS daemon holds is known from memory (`lockHeldHere`), and
 *     described by fixed wording for the operation that took it;
 *   - a lock naming another live process counts only when the OS says that
 *     process is lazy (`looksLikeLazyProcess` on its real command line), and
 *     is described as "another operation";
 *   - anything else — a file naming this daemon's pid that this daemon did not
 *     write, a non-lazy process, a dead one — is ignored for the entry: the
 *     other checks here (turn running, pairing, the handback) still stand.
 */
async function worktreeHolders(projectRoot: string, task: Task): Promise<{ webChat: { held: boolean; email: string | null }; lock: { what: string } | null }> {
  // Imported here: ../server/shell-pair.ts imports this module.
  const { webChatHolder } = await import('../server/shell-pair');
  const webChat = webChatHolder(task.id);
  const worktree = getWorktreePath(projectRoot, task);
  const own = lockHeldHere(worktree);
  if (own) return { webChat, lock: { what: DAEMON_LOCK_WORDING[own] ?? 'another operation' } };
  // readLock drops a stale file (holder gone) as it reads.
  const file = await readLock(worktree);
  if (file && file.pid !== process.pid) {
    const identity = await readProcessIdentity(file.pid);
    if (identity?.command && looksLikeLazyProcess(identity.command)) return { webChat, lock: { what: 'another operation' } };
  }
  return { webChat, lock: null };
}

export interface EnterTaskDeps {
  bindingFor?: (taskId: string) => Promise<Pick<SessionCredentialBinding, 'revokedAt'> | null>;
  /**
   * Seam for tests: whether the task is being paired on, and whose web Pair it
   * is (null for `lazy pair` or an owner's dashboard Pair, which name nobody).
   */
  pairing?: (task: Task) => Promise<{ pairing: boolean; webPairEmail: string | null }>;
  /**
   * Seam for tests: whether a web Chat holds the task (and whose), and which
   * operation holds its worktree lock, if any.
   */
  worktreeHolders?: (task: Task) => Promise<{ webChat: { held: boolean; email: string | null }; lock: { what: string } | null }>;
  /** Seam for tests; defaults to `supervisorStillOwnsTurn` (./supervisor-handback.ts). */
  supervisorOwnsTurn?: (task: Task, session: Session) => Promise<string | null>;
  /** Seam for tests; defaults to {@link stopTaskContainerForMember}. */
  stopTaskContainer?: (task: Task, session: Session) => Promise<void>;
  /** Seam for tests; defaults to marking the in-memory hold. */
  markEntered?: (taskId: string, email: string) => void;
}

/**
 * Let a member in, under the task's lifecycle lock, or say why not. The caller
 * has already CLAIMED the task for this member (../server/member-terminals.ts);
 * this is the check a turn launch cannot interleave with:
 *
 *   1. No turn is running (re-checked here, authoritatively — the resolver's
 *      check ran before the lock). Every launch path decides and flips to
 *      `working` under this lock (test/unit/launch-under-lifecycle-lock.test.ts).
 *   2. The task has run a turn: before that it has no environment of its own
 *      to open, and its worktree may still be being set up.
 *   3. The supervisor has handed the task back: no unsettled response, and no
 *      live supervisor still in a post-turn phase or holding a command. A
 *      parked status is not that handback (./supervisor-handback.ts) — an
 *      `interrupted` task whose supervisor survived a restart, or a turn
 *      whose response is still in the mailbox, reads as parked — and the stop
 *      below would kill the supervisor's own work. Refused, retryably.
 *   4. The task's own container is stopped, so nothing a turn left running
 *      is beside the member (see the header). A stop that fails refuses.
 *   5. The hold is marked entered, still inside the lock — from here every
 *      launch refuses until the member's session ends.
 */
export async function enterTaskAsMember(opts: {
  projectRoot: string;
  storage: Pick<Storage, 'getTask' | 'getSessionByTaskId' | 'getSessionTurns'>;
  taskId: string;
  email: string;
  deps?: EnterTaskDeps;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const { projectRoot, storage, taskId, email } = opts;
  const deps = opts.deps ?? {};
  return withTaskLifecycleLock(taskId, async () => {
    if (await taskTurnRunning(projectRoot, storage, taskId, deps.bindingFor)) {
      return { ok: false, status: 409, message: `A turn is running on this task. Wait for it to end, then open the terminal again.` };
    }
    const task = await storage.getTask(taskId);
    if (!task || task.status === 'backlog') {
      return { ok: false, status: 409, message: `This task has not started yet. Start it, then open the terminal.` };
    }
    // A task being accepted (`merging`), finished, or being torn down by a
    // reject or close: its worktree is about to be merged or removed.
    if (task.status === 'merging' || isTerminalStatus(task.status) || worktreeClaims.has(taskId)) {
      return { ok: false, status: 409, message: `This task is being merged or closed, so its files cannot be opened now.` };
    }
    if (containerBringUps.has(taskId)) {
      return { ok: false, status: 409, message: `The agent's environment for this task is being started. Open the terminal again in a moment.` };
    }
    // A LINKED task sits `blocked` with a session before its first start.
    const session = await storage.getSessionByTaskId(taskId);
    if (!session || (await storage.getSessionTurns(session.id)).length === 0) {
      return { ok: false, status: 409, message: `This task has not run a turn yet. Start it, then open the terminal.` };
    }
    // A pairing session runs the agent in the TASK's container — `lazy pair`,
    // or a Pair from the dashboard on a daemon that is not managed — and the
    // stop below would end it mid-session. Only this member's OWN web Pair,
    // under the hold they already hold, is no obstacle: it runs in their own
    // container, and this is their next terminal joining it.
    const pairing = await (deps.pairing ?? ((t) => pairingState(projectRoot, t)))(task);
    if (pairing.pairing && !(pairing.webPairEmail === email && memberInsideTask(taskId) === email)) {
      return {
        ok: false,
        status: 409,
        message: `Somebody is pairing on this task${pairing.webPairEmail ? ` (${pairing.webPairEmail})` : ''}. Open the terminal once their pairing session has ended.`,
      };
    }
    // A Chat, or anything else holding the worktree lock, is at work in the
    // task too: an owner's dashboard Chat on a daemon that is not managed runs
    // in the TASK's container with the task still `blocked` and no pairing
    // lock, and the stop below would end it mid-conversation. Only this
    // member's OWN web Chat, under the hold they already hold, is no obstacle —
    // it runs in their own container, and the worktree lock is its own.
    const holders = await (deps.worktreeHolders ?? ((t) => worktreeHolders(projectRoot, t)))(task);
    const ownChat = holders.webChat.held && holders.webChat.email === email && memberInsideTask(taskId) === email;
    if (holders.webChat.held && !ownChat) {
      return {
        ok: false,
        status: 409,
        message: `Somebody is chatting with the agent on this task${holders.webChat.email ? ` (${holders.webChat.email})` : ''}. Open the terminal once their chat has ended.`,
      };
    }
    if (holders.lock && !ownChat) {
      return {
        ok: false,
        status: 409,
        message: `This task is busy with ${holders.lock.what}. Open the terminal once that has finished.`,
      };
    }
    // ENGINEER RULE: the daemon never acts on a task before the supervisor has
    // returned control — and stopping its container is acting on it.
    const owns = await (deps.supervisorOwnsTurn ?? ((t, sess) => supervisorStillOwnsTurn(projectRoot, t, sess)))(task, session);
    if (owns) {
      // The reason names lazy's internals (a supervisor phase, the command
      // mailbox) — for the log, not for the member.
      logger.info(`[${taskId.substring(0, 8)}] Refused ${email}'s terminal: the supervisor has not handed the task back (${owns}).`);
      return {
        ok: false,
        status: 409,
        message: 'The agent is still finishing its last turn. Open the terminal again in a moment.',
      };
    }
    try {
      await (deps.stopTaskContainer ?? ((t, s) => stopTaskContainerForMember(projectRoot, t, s)))(task, session);
    } catch (err) {
      logger.warn(`[${taskId.substring(0, 8)}] Refused ${email}'s terminal: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        status: 503,
        message: `The agent's environment for this task could not be stopped, so a terminal of your own cannot be opened beside it. Try again in a moment.`,
      };
    }
    (deps.markEntered ?? markMemberTerminalEntered)(taskId, email);
    return { ok: true };
  });
}
