/**
 * The daemon-startup sweep of what a previous daemon's member terminals left
 * behind: their containers, then their homes (./member-container.ts).
 *
 * No member terminal survives a restart (its socket dies with the process that
 * held it), so every member container still there is removed — with whatever
 * the member left running in it — and every home's conversation is handed back
 * before the home is deleted. Until a container is gone, its task is HELD
 * (../server/member-terminals.ts, `holdLeftoverMemberContainer`): no turn and
 * no other member, since a process in it could still be writing into that
 * task's worktree.
 *
 * The runtime may not be reachable yet when the daemon starts (Docker Desktop
 * still starting, a socket not up). Then nothing can be listed, let alone
 * removed, and nothing is known about which containers exist. What IS known is
 * the homes on disk: every leftover container had one, named after it. So each
 * task a leftover home names is held, and the hold's retry — on the hold's own
 * backoff — runs the whole sweep again until it succeeds; one sweep at a time,
 * however many tasks are waiting on it.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Storage } from '../storage';
import { logger } from '../utils/logger';
import {
  MEMBER_CONTAINER_PREFIX,
  handBackMemberHome,
  memberHomesDir,
  removeLeftoverMemberContainers,
  removeLeftoverMemberHomes,
  removeMemberContainer,
} from './member-container';
import { holdLeftoverMemberContainer } from '../server/member-terminals';

export interface LeftoverSweepDeps {
  /** Seam for tests; defaults to `removeLeftoverMemberContainers`. */
  removeContainers?: typeof removeLeftoverMemberContainers;
  /** Seam for tests; defaults to `removeMemberContainer`. */
  removeContainer?: typeof removeMemberContainer;
  /** Seam for tests; defaults to `holdLeftoverMemberContainer`. */
  hold?: typeof holdLeftoverMemberContainer;
}

/** The sweep in flight, shared by every task waiting on it. */
let inFlight: Promise<void> | null = null;

/**
 * Run the sweep once. When the runtime cannot list its containers, hold every
 * task a leftover home names, each retrying the sweep, and resolve — the
 * daemon's start does not wait for the runtime.
 */
export async function sweepLeftoverMemberEnvironments(
  projectRoot: string,
  binary: string,
  storage: Pick<Storage, 'listTasks' | 'createSystemMessage'>,
  deps: LeftoverSweepDeps = {},
): Promise<void> {
  try {
    await sweepOnce(projectRoot, binary, storage, deps);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const tasks = await tasksWithLeftoverHomes(projectRoot, storage);
    logger.error(
      `Could not remove member terminal environments left by the previous daemon: ${why}. ` +
      (tasks.length > 0
        ? `${tasks.length} task(s) with one stay held until it succeeds; retrying.`
        : 'No member terminal home was left, so no task is held.'),
    );
    for (const taskId of tasks) {
      (deps.hold ?? holdLeftoverMemberContainer)(taskId, () => sharedSweep(projectRoot, binary, storage, deps));
    }
  }
}

function sharedSweep(
  projectRoot: string,
  binary: string,
  storage: Pick<Storage, 'listTasks' | 'createSystemMessage'>,
  deps: LeftoverSweepDeps,
): Promise<void> {
  if (!inFlight) {
    inFlight = sweepOnce(projectRoot, binary, storage, deps).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * List and remove the leftover containers, then hand back their homes. Throws
 * when the containers cannot be listed. A container that will not go holds its
 * own task, retried by itself (its home is handed back once it is gone).
 */
async function sweepOnce(
  projectRoot: string,
  binary: string,
  storage: Pick<Storage, 'createSystemMessage'>,
  deps: LeftoverSweepDeps,
): Promise<void> {
  const { removed, failed } = await (deps.removeContainers ?? removeLeftoverMemberContainers)(projectRoot, binary);
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
  const homes = await removeLeftoverMemberHomes(projectRoot, new Set(failed.map((f) => f.name)), storage);
  if (homes.removed + homes.kept > 0) {
    logger.info(`Handed back ${homes.removed} member terminal conversation(s) left by the previous daemon${homes.kept ? `; kept ${homes.kept} that could not be` : ''}.`);
  }
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
}
