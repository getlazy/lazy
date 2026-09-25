/**
 * Daemon-side "make sure this task's container is up" — without starting a turn.
 *
 * `lazy shell --container` and `lazy url` want the task ENVIRONMENT, not the
 * agent: an engineer exec'ing in to set a project up and start a dev server is
 * not asking anyone to do a turn. This launches the supervisor container with no
 * command written, so it comes up and waits, exactly as it does between turns.
 *
 * It lives in the daemon rather than the CLI for one reason: the container's MCP
 * config file carries a per-container token that only the daemon can mint
 * (`writeDaemonMcpConfig`). A CLI-side `docker run` would either skip it — giving
 * the agent inside no `lazy_*` tools on its next turn — or forge it.
 */

import { setupSandbox } from '../utils/sandbox';
import { createRunner } from '../runner';
import { removeTaskRun } from '../runner/session-launch';
import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { hasDaemonContext } from './context';
import { writeDaemonMcpConfig } from './task-launcher';
import { setRunnerAgentForTask } from './task-harness';
import { loadConfig } from '../config/loader';
import { protocolDir as getProtocolDir, ensureProtocolDir } from '../protocol';
import { displayId, taskRef, getWorktreePathForRef } from '../task/identity';
import { pathExists } from '../utils/fs';
import { pinnedCustomImage } from '../docker/worktree-image';
import type { PhaseNotify } from './progress';
import { logger } from '../utils/logger';
import { beginTaskContainerBringUp } from './member-entry';
import type { Storage } from '../storage';
import type { Task } from '../types';

export interface EnsureTaskContainerParams {
  taskId: string;
  /**
   * Narration sink for the launch. Bringing a container up is usually seconds,
   * but resolving the image can spend MINUTES in `docker build`, and a caller
   * that cannot say so (the dashboard's Start container button) is
   * indistinguishable from one that has hung.
   */
  notify?: PhaseNotify;
  /**
   * Recreate the container even if it is already running. Published ports are
   * fixed at create time, so this is the only way a `[serve]` change reaches a
   * live task. Refused while the agent is mid-turn — that would kill its work.
   */
  restart?: boolean;
}

export interface EnsureTaskContainerResult {
  containerName: string;
  worktreePath: string;
  runnerType: string;
  /** True when the container was already up and nothing was launched. */
  alreadyRunning: boolean;
}

/**
 * Ensure the task's container is running, creating it if necessary.
 *
 * Deliberately does NOT write a protocol command: the container comes up and
 * waits for one. Nothing reaps an idle container (the idle reaper was removed),
 * so a container brought up this way simply stays — which is the whole point of
 * a dev server that outlives the turn that started it.
 *
 * A container it CREATES is created with the project's current `[serve]` ports,
 * because it goes through the same launch path as any other. A container that
 * was already running keeps whatever it was created with — docker cannot add a
 * published port to a live container.
 */
export async function ensureTaskContainer(
  projectRoot: string,
  params: EnsureTaskContainerParams,
): Promise<EnsureTaskContainerResult> {
  const storage = await getOrCreateStorage();

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  // A member's entry stops this container so nothing of a turn runs beside
  // them (./member-entry.ts); bringing it back up while they are inside would
  // undo exactly that. The member check and a claim that makes their entry
  // refuse run under the lock the entry takes; the bring-up itself — which
  // can spend minutes building an image — runs outside it, so turn launches,
  // accepts and syncs on this task are not queued behind a docker build.
  const release = await beginTaskContainerBringUp(task.id);
  try {
    return await ensureTaskContainerClaimed(projectRoot, params, storage, task);
  } finally {
    release();
  }
}

async function ensureTaskContainerClaimed(
  projectRoot: string,
  params: EnsureTaskContainerParams,
  storage: Storage,
  task: Task,
): Promise<EnsureTaskContainerResult> {
  const sess = await storage.getSessionByTaskId(task.id);
  const runner = await createRunner(projectRoot, sess?.runner_type ?? task.runner_type ?? undefined);

  const tRef = taskRef(task);
  const containerName = sess?.container_name ?? runner.runNameForTask(tRef);
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);

  if (!runner.usesSandbox()) {
    throw new RpcError(
      400,
      `Task ${displayId(task)} runs on the ${runner.type} runner, which has no container. ` +
      `Its work already happens on this machine, in ${worktreePath}.`,
    );
  }

  if (!(await pathExists(worktreePath))) {
    throw new RpcError(
      404,
      `Task ${displayId(task)} has no worktree at ${worktreePath}. ` +
      `Run \`lazy start ${tRef}\` to create it.`,
    );
  }

  if (await runner.isRunning(containerName)) {
    if (!params.restart) {
      return { containerName, worktreePath, runnerType: runner.type, alreadyRunning: true };
    }
    // Recreating a container kills whatever runs in it, including a supervisor
    // in the middle of a turn. Refuse rather than destroy an agent's work.
    if (task.status === 'working') {
      throw new RpcError(
        409,
        `Task ${displayId(task)} is working — recreating its container would kill the turn. ` +
        `Run \`lazy stop ${tRef}\` first, or wait for the turn to finish.`,
      );
    }
    await runner.stopRun(containerName);
  }

  const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });
  const protoDir = getProtocolDir(task.id);
  ensureProtocolDir(protoDir);

  // Per-container MCP token — the reason this runs in the daemon at all.
  let daemonConfigPath: string | null = null;
  if (hasDaemonContext()) {
    daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, {
      kind: 'task',
      taskId: task.id,
    });
  }

  // A stopped container of the same name would make `docker run --name` fail,
  // and would in any case carry the OLD published ports.
  await removeTaskRun(runner, storage, sess, containerName);

  // INVARIANT: set the task's agent profile on the runner before launch.
  // ensureTaskContainer used to launch with no agent set, so launchSupervisorAsync
  // fell back to the default `claude-code` profile. It then stamped
  // container_agent_id to the task's real agent (e.g. cursor), so the next
  // unblock/resume reused a container that had never received CURSOR_API_KEY.
  const config = await loadConfig(projectRoot);
  setRunnerAgentForTask(runner, config, task);

  try {
    await runner.launchSupervisor(
      sandbox,
      containerName,
      protoDir,
      false,
      daemonConfigPath ?? undefined,
      tRef,
      task.id,
      // A task the human pinned an image on must come up on THAT image here too:
      // every other launch path passes it, and falling back to the root image
      // would quietly give the container a different environment than its turns.
      pinnedCustomImage(task),
      params.notify,
    );
  } catch (err) {
    throw new RpcError(
      500,
      `Failed to launch container for ${displayId(task)}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (sess) {
    await storage.updateSessionContainerName(sess.id, containerName, task.agent_id);
    sess.container_agent_id = task.agent_id;
  }

  logger.debug(`Ensured container ${containerName} for task ${displayId(task)}`);
  return { containerName, worktreePath, runnerType: runner.type, alreadyRunning: false };
}
