/**
 * The daemon-startup sweep of what a previous daemon's member terminals left
 * behind: their containers, then their homes (./member-container.ts).
 *
 * A member's ENVIRONMENT survives a restart even though their terminal
 * sockets do not: every running or stopped member container whose credential can
 * be kept is RE-ADOPTED (./member-container.ts, `readoptMemberContainer`) —
 * its hold rebuilt (../server/member-terminals.ts, `adoptMemberTerminal`),
 * its credential binding left live and re-pinned, its home kept — so the
 * member's terminals reconnect to the same tmux sessions, regardless of how
 * long they have been idle. The caller keeps those credentials out
 * of its startup revoke (the keys this sweep returns).
 *
 * Every other member container is removed — with whatever the member left
 * running in it — and every home's conversation is handed back before the
 * home is deleted. Until a container is gone, its task is HELD
 * (../server/member-terminals.ts, `holdLeftoverMemberContainer`): the task's
 * worktree is not removed, since a process in it could still be writing into
 * it.
 *
 * The runtime may not be reachable yet when the daemon starts (Docker Desktop
 * still starting, a socket not up). Then nothing can be listed, let alone
 * removed, and nothing is known about which containers exist. What IS known is
 * the homes on disk: every leftover container had one, named after it. So each
 * task a leftover home names is held, and the hold's retry — on the hold's own
 * backoff — runs the whole sweep again until it succeeds; one sweep at a time,
 * however many tasks are waiting on it.
 */

import { memberTerminalProfile, revokeLeftoverMemberTerminalCredentials } from '../server/member-exec-credential';
import { memberInventoryRead } from './member-recovery';
import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Storage } from '../storage';
import { logger } from '../utils/logger';
import { isTerminalStatus } from '../task-state-machine';
import {
  MEMBER_CONTAINER_PREFIX,
  readoptMemberContainer,
  type LeftoverMemberContainer,
  handBackMemberHome,
  memberHomesDir,
  removeLeftoverMemberContainers,
  removeLeftoverMemberHomes,
  removeMemberContainer,
} from './member-container';
import { adoptMemberTerminal, holdLeftoverMemberContainer, heldMemberContainerName } from '../server/member-terminals';

export interface LeftoverSweepDeps {
  /** Seam for tests; defaults to `removeLeftoverMemberContainers`. */
  removeContainers?: (
    ...args: Parameters<typeof removeLeftoverMemberContainers>
  ) => Promise<Omit<Awaited<ReturnType<typeof removeLeftoverMemberContainers>>, 'readopted'> & { readopted?: string[] }>;
  /** Seam for tests; defaults to `removeMemberContainer`. */
  removeContainer?: typeof removeMemberContainer;
  /** Seam for tests; defaults to `holdLeftoverMemberContainer`. */
  hold?: typeof holdLeftoverMemberContainer;
  /** Seam for tests; defaults to `readoptMemberContainer`. */
  readopt?: typeof readoptMemberContainer;
  /** Seam for tests; defaults to `adoptMemberTerminal`. */
  adopt?: typeof adoptMemberTerminal;
}

/** The credentials of the containers a sweep re-adopted — to be left live. */
export interface ReadoptedCredentials {
  bindingKeys: Set<string>;
  grantLabels: Set<string>;
  /** Unknown inventory is never evidence that the remaining credentials are orphaned. */
  pending?: boolean;
}

type SweepStorage = Pick<Storage, 'listTasks' | 'listTasksStrict' | 'createSystemMessage'>;

/** The sweep in flight, shared by every task waiting on it. */
let inFlight: Promise<void> | null = null;
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Run the sweep once and return the credentials of what it re-adopted. When
 * the runtime cannot list its containers, hold every task a leftover home
 * names, each retrying the sweep. The incomplete result suppresses startup's
 * bulk revoke: bindings remain blocked by member-recovery until validated.
 */
export async function sweepLeftoverMemberEnvironments(
  projectRoot: string,
  binary: string,
  storage: SweepStorage,
  deps: LeftoverSweepDeps = {},
): Promise<ReadoptedCredentials> {
  try {
    return await completeSweep(projectRoot, binary, storage, deps);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    let tasks: string[] = [];
    try {
      tasks = await tasksWithLeftoverHomes(projectRoot, storage);
    } catch (homeError) {
      logger.warn(`Could not identify tasks with pending member recovery: ${homeError instanceof Error ? homeError.message : String(homeError)}. Retrying project recovery without removing homes.`);
    }
    logger.error(
      `Could not remove member terminal environments left by the previous daemon: ${why}. ` +
      (tasks.length > 0
        ? `${tasks.length} task(s) with one stay held until it succeeds; retrying.`
        : 'No task could be held; project recovery will be retried.'),
    );
    for (const taskId of tasks) {
      (deps.hold ?? holdLeftoverMemberContainer)(taskId, () => sharedSweep(projectRoot, binary, storage, deps));
    }
    if (tasks.length === 0) scheduleRetry(projectRoot, binary, storage, deps);
    return { bindingKeys: new Set(), grantLabels: new Set(), pending: true };
  }
}

function sharedSweep(
  projectRoot: string,
  binary: string,
  storage: SweepStorage,
  deps: LeftoverSweepDeps,
): Promise<void> {
  if (!inFlight) {
    inFlight = completeSweep(projectRoot, binary, storage, deps).then(() => undefined).finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function completeSweep(projectRoot: string, binary: string, storage: SweepStorage, deps: LeftoverSweepDeps): Promise<ReadoptedCredentials> {
  const kept = await sweepOnce(projectRoot, binary, storage, deps);
  // Only complete inventory can safely retire credentials with no container.
  // Keep entry blocked until this finishes, so a fresh launch cannot have its
  // credential mistaken for a leftover. Registry I/O errors retry the sweep too.
  const revoked = await revokeLeftoverMemberTerminalCredentials(projectRoot, kept);
  if (revoked.bindings + revoked.grants > 0) {
    logger.info(`Revoked ${revoked.bindings} member-terminal binding(s) and ${revoked.grants} grant(s) left by the previous daemon.`);
  }
  memberInventoryRead(projectRoot);
  return kept;
}

function scheduleRetry(projectRoot: string, binary: string, storage: SweepStorage, deps: LeftoverSweepDeps): void {
  if (retryTimers.has(projectRoot)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(projectRoot);
    void sharedSweep(projectRoot, binary, storage, deps).catch((err) => {
      logger.warn(`Member environment recovery is still pending: ${err instanceof Error ? err.message : String(err)}. Retrying.`);
      scheduleRetry(projectRoot, binary, storage, deps);
    });
  }, 5_000);
  timer.unref?.();
  retryTimers.set(projectRoot, timer);
}

/**
 * List the leftover containers, re-adopt those that can be and remove the
 * rest, then hand back the removed ones' homes. Throws when the containers
 * cannot be listed. A container that will not go holds its own task, retried
 * by itself (its home is handed back once it is gone).
 */
async function sweepOnce(
  projectRoot: string,
  binary: string,
  storage: SweepStorage,
  deps: LeftoverSweepDeps,
): Promise<ReadoptedCredentials> {
  const kept: ReadoptedCredentials = { bindingKeys: new Set(), grantLabels: new Set() };
  // Never interpret an unreadable task record as a deleted task.
  const tasks = await storage.listTasksStrict();
  const readopt = async (leftover: LeftoverMemberContainer): Promise<boolean> => {
    try {
      const task = tasks.find((t) => t.id === leftover.taskId);
      let reason: string | null = null;
      if (!task) reason = 'its task no longer exists';
      else if (isTerminalStatus(task.status)) reason = `its task is ${task.status}`;
      if (!reason) {
        const r = await (deps.readopt ?? readoptMemberContainer)({ projectRoot, binary, leftover, storage, profile: await memberTerminalProfile(projectRoot, task!.agent_id) });
        if (r.ok) {
          if (await heldMemberContainerName(leftover.taskId, r.email) === leftover.name ||
              (deps.adopt ?? adoptMemberTerminal)(leftover.taskId, r.email, r.container, undefined, { waitForAttach: r.waitForAttach })) {
            kept.bindingKeys.add(r.bindingKey);
            kept.grantLabels.add(r.grantLabel);
            logger.info(`[${leftover.taskId.substring(0, 8)}] Kept ${r.email}'s terminal environment (${leftover.name}) across the restart.`);
            return true;
          }
          if (!(await heldMemberContainerName(leftover.taskId, r.email))) {
            // The WebSocket claims before checking the inventory entry gate.
            // That in-flight, soon-refused claim is not another environment.
            throw new Error('the member has a terminal claim in progress; recovery will retry');
          }
          reason = 'the member already has another environment on this task';
        } else {
          reason = r.reason;
        }
      }
      logger.info(`Removing the member terminal environment ${leftover.name} left by the previous daemon: ${reason}.`);
    } catch (err) {
      // Only a positive ownership/credential refusal authorizes deletion.
      // An operational failure leaves inventory incomplete: keep the home,
      // container and durable credential, block access, and retry the sweep.
      throw new Error(`Could not recover the member terminal environment ${leftover.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  };
  const { removed, readopted = [], failed } = await (deps.removeContainers ?? removeLeftoverMemberContainers)(projectRoot, binary, { readopt });
  if (removed > 0) logger.info(`Removed ${removed} member terminal environment(s) left by the previous daemon.`);
  for (const f of failed) {
    logger.error(`Could not remove the member terminal environment ${f.name} left by the previous daemon: ${f.error}. Its task stays held until it is gone.`);
    if (f.taskId) {
      (deps.hold ?? holdLeftoverMemberContainer)(f.taskId, async () => {
        await (deps.removeContainer ?? removeMemberContainer)(binary, f.name);
        // Only once the container that mounts it is gone.
        await handBackMemberHome(projectRoot, join(memberHomesDir(projectRoot), f.name), storage);
      });
    }
  }
  // Their homes: the conversation in each is handed back to its task (or
  // kept, and reported) before anything is deleted.
  // A re-adopted container's home is in use, exactly like one that would not go.
  const homes = await removeLeftoverMemberHomes(projectRoot, new Set([...failed.map((f) => f.name), ...readopted]), storage);
  if (homes.removed + homes.kept > 0) {
    logger.info(`Handed back ${homes.removed} member terminal conversation(s) left by the previous daemon${homes.kept ? `; kept ${homes.kept} that could not be` : ''}.`);
  }
  return kept;
}

/**
 * The tasks a leftover home names. A home is named after its container,
 * `lazymember-<first 8 of the task id>-<random>`, so it names a task by prefix;
 * every task matching it is held — holding one too many for a moment is
 * harmless, missing one is not.
 */
async function tasksWithLeftoverHomes(projectRoot: string, storage: Pick<Storage, 'listTasks'>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(memberHomesDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const prefixes = new Set(
    names
      .filter((n) => n.startsWith(MEMBER_CONTAINER_PREFIX))
      .map((n) => n.slice(MEMBER_CONTAINER_PREFIX.length).split('-')[0]!)
      .filter((p) => p.length > 0),
  );
  if (prefixes.size === 0) return [];
  const tasks = await storage.listTasks();
  return tasks.filter((t) => prefixes.has(t.id.substring(0, 8))).map((t) => t.id);
}

/** Test seam. */
export function resetLeftoverSweepForTests(): void {
  inFlight = null;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}
