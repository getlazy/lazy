/**
 * Start-or-recreate: the ONE decision every turn launch makes about a task's
 * container before it either hands the command to a running supervisor or
 * creates a new container.
 *
 * A task's container holds state nobody can see in the worktree — packages a
 * turn installed, a build cache under $HOME, the services in its tmux
 * sessions — so it is never recreated casually. The order is:
 *
 *   1. a recreate predicate fired (agent profile, task env, runner image,
 *      credential plan — each launch site names its reason): recreate;
 *   2. it is running: reuse it (the supervisor picks up the command);
 *   3. it exists but stopped (a host reboot, a dockerd restart, an OOM, a
 *      crashed supervisor, `lazy stop`): `docker start` it again, with
 *      everything in it, and reuse it;
 *   4. otherwise — no container, one created by a lazy that predates kept
 *      containers, or one that would not start: recreate.
 *
 * Steps 2 and 3 are this helper; step 1 and the recreate itself stay with the
 * caller, which owns its launch's error handling. A `null` answer means
 * "recreate", exactly as the old `isRunning ? reuse : remove + run` did.
 */

import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';

export type KeptRun = 'reused' | 'started';

export async function reuseOrStartTaskRun(
  runner: {
    isRunning(runName: string): Promise<boolean>;
    startStoppedRun?(runName: string): Promise<boolean>;
    lacksCurrentLayout?(runName: string): Promise<boolean>;
  },
  storage: Pick<Storage, 'updateSessionContainerName'>,
  session: { id: string; container_name: string | null; container_agent_id?: string | null } | null | undefined,
  runName: string,
  recreate: boolean,
  /**
   * The agent the task runs on now. Recorded as the container's stamp only
   * when the session has NONE (a record written before stamps were kept on
   * every path): no recreate predicate fired, so the container is being kept
   * for this agent, and from here on a switch is detected. An existing stamp
   * is never overwritten here.
   */
  agentId: string,
): Promise<KeptRun | null> {
  if (recreate) return null;
  if (await runner.isRunning(runName)) {
    if (session && !session.container_agent_id) {
      await storage.updateSessionContainerName(session.id, runName, agentId);
      session.container_name = runName;
      session.container_agent_id = agentId;
    }
    return 'reused';
  }
  if (!runner.startStoppedRun || !(await runner.startStoppedRun(runName))) return null;
  // A started container's published ports are assigned afresh. The stored
  // name is the durable trace of "ports may have changed" (removeTaskRun's
  // reasoning): clearing and re-recording it is a change, which the event tap
  // turns into `ports.changed`. It is re-recorded with the container's
  // ORIGINAL agent stamp — the agent it was created for, which the recreate
  // decision above was made against — never the task's current agent (which
  // is recorded only when the session has no stamp at all; see `agentId`).
  if (session) {
    const stamp = session.container_agent_id || agentId;
    await storage.updateSessionContainerName(session.id, null);
    await storage.updateSessionContainerName(session.id, runName, stamp);
    session.container_name = runName;
    session.container_agent_id = stamp;
  }
  logger.info(`Started the stopped container ${runName} again, keeping what was in it.`);
  return 'started';
}

/** The launch narration for a kept run. */
export function keptRunNote(kept: KeptRun, runName: string): string {
  return kept === 'reused'
    ? `reusing running container ${runName}`
    : `started the stopped container ${runName} again (its files and installed tools are kept)`;
}
