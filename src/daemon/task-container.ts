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

import { deliverTaskFilesForLaunch } from './task-files';
import { RunnerImageNotReadyError } from '../capture/custom-image-gate';
import { describeRunnerImage } from './runner-image';
import { setupSandbox } from '../utils/sandbox';
import { createRunner } from '../runner';
import { probeContainerGitPointers } from '../git/container-pointers';
import { removeTaskRun } from '../runner/session-launch';
import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { hasDaemonContext } from './context';
import { writeDaemonMcpConfig } from './task-launcher';
import { setRunnerAgentForTask } from './task-harness';
import { loadConfig } from '../config/loader';
import { protocolDir as getProtocolDir, ensureProtocolDir } from '../protocol';
import { displayId, taskRef, getWorktreePathForRef } from '../task/identity';
import { ensureTaskWorktree } from './task-worktree';
import { pathExists } from '../utils/fs';
import { launchImagePin } from '../docker/worktree-image';
import type { PhaseNotify } from './progress';
import { logger } from '../utils/logger';
import { mustRecreateForTaskEnv } from './task-env';
import {
  recordRecreation,
  REASON_CHECKOUT_MISSING,
  REASON_GIT_POINTERS_BROKEN,
  REASON_RESTART_REQUESTED,
  REASON_TASK_ENV_CHANGED,
} from '../task/environment-replaced';
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
  /**
   * Narration sink for RESTORING TASK FILES only — handed to the worktree
   * restore as its notify, so a caller can show the restore as a phase of its
   * own and the restore can feed it its own progress lines. Called only when
   * the files are actually being restored; its first call is the restore
   * starting. Falls back to `notify` when unset.
   */
  restoreProgress?: PhaseNotify;
  /** Called once, just before a container is launched — never when the running one is kept. */
  onLaunching?: () => void;
  /**
   * Keep only a container that is already running as it is: never launch,
   * recreate or restore anything, and refuse (409) when that is what it would
   * take. For work done on behalf of a turn that already ended, where a new
   * container would be one nobody asked for.
   */
  neverLaunch?: boolean;
}

export interface EnsureTaskContainerDeps {
  getStorage?: typeof getOrCreateStorage;
  createRunner?: typeof createRunner;
  setupSandbox?: typeof setupSandbox;
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
  deps: EnsureTaskContainerDeps = {},
): Promise<EnsureTaskContainerResult> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  // Allowed while a member is inside (engineer, 2026-10-05): the container
  // holds the task's SHARED services, and a member's entry no longer stops it
  // (./member-entry.ts). No lifecycle lock is held across the bring-up, which
  // can spend minutes building an image, so turn launches, accepts and syncs
  // on this task are not queued behind a docker build.
  return ensureTaskContainerClaimed(projectRoot, params, storage, task, deps);
}

async function ensureTaskContainerClaimed(
  projectRoot: string,
  params: EnsureTaskContainerParams,
  storage: Storage,
  task: Task,
  deps: EnsureTaskContainerDeps,
): Promise<EnsureTaskContainerResult> {
  const sess = await storage.getSessionByTaskId(task.id);
  const runner = await (deps.createRunner ?? createRunner)(projectRoot, sess?.runner_type ?? task.runner_type ?? undefined);

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

  const worktreeMissing = !await pathExists(worktreePath);
  let containerRunning = await runner.isRunning(containerName);
  if (params.neverLaunch && (!containerRunning || worktreeMissing)) {
    throw new RpcError(409, `Task ${displayId(task)}'s container is not running any more, and bringing one up was not asked for. Run services starts it.`);
  }

  if (worktreeMissing && containerRunning) {
    if (task.status === 'working') {
      throw new RpcError(409, `Task ${displayId(task)} is working — recreating its container would kill the turn. Wait for the turn to finish.`);
    }
    params.notify?.('Recreating container: its task checkout is missing.');
    if (!await runner.stopRun(containerName) || await runner.isRunning(containerName)) {
      throw new RpcError(503, `Cannot stop the outdated environment for ${displayId(task)}. Task files left untouched.`);
    }
    // Told on the task, for the person and the agent's next work turn: whatever
    // ran or was built in the container went with it (src/task/environment-replaced.ts).
    // Only once the stop succeeded — a refused stop replaced nothing.
    await recordRecreation(storage, task.id, REASON_CHECKOUT_MISSING);
    containerRunning = false;
  }

  await ensureTaskWorktree(projectRoot, task, sess?.git_branch, params.restoreProgress ?? params.notify);

  if (containerRunning) {
    const pointers = await probeContainerGitPointers(projectRoot, worktreePath, runner, containerName);
    if (pointers.kind === 'unavailable') {
      throw new RpcError(503, `Cannot check mounted git pointers for ${displayId(task)}: ${pointers.reason} Container left untouched.`);
    }
    // Env is fixed when a container is created, so a running container whose
    // task env changed since (Lazy Teams pushes a task's selection, `lazy env
    // set`) must be replaced for Run services / Start container to see it. A
    // working task keeps its container: replacing it would kill the turn, and
    // its own next launch recreates it.
    const envStale = await mustRecreateForTaskEnv(projectRoot, task.id, containerName);
    const recreateForEnv = envStale && task.status !== 'working';
    if (!params.restart && pointers.kind === 'healthy' && !recreateForEnv) {
      return { containerName, worktreePath, runnerType: runner.type, alreadyRunning: true };
    }
    if (recreateForEnv && pointers.kind === 'healthy') params.notify?.("Recreating container: the task's environment variables changed since it was created.");
    if (params.neverLaunch) {
      throw new RpcError(409, `Task ${displayId(task)}'s container has to be replaced before it can run services, and replacing it was not asked for. Run services replaces it.`);
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
    if (pointers.kind === 'broken') params.notify?.('Recreating container: mounted git pointers or checkout do not match the validated host environment.');
    const reasons = [
      ...(params.restart ? [REASON_RESTART_REQUESTED] : []),
      ...(recreateForEnv ? [REASON_TASK_ENV_CHANGED] : []),
      ...(pointers.kind === 'broken' ? [REASON_GIT_POINTERS_BROKEN] : []),
    ];
    const stopped = await runner.stopRun(containerName);
    // Recorded only for a stop that happened (as above).
    if (stopped && reasons.length > 0) await recordRecreation(storage, task.id, reasons.join('; '));
  }

  params.onLaunching?.();
  const sandbox = await (deps.setupSandbox ?? setupSandbox)(worktreePath, { storage, taskId: task.id });
  // Per-task secret files (src/daemon/task-files.ts): services started here
  // must see the task's current set, as every turn launch does.
  await deliverTaskFilesForLaunch(projectRoot, task.id, worktreePath, params.notify);
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
      launchImagePin(task),
      params.notify,
    );
  } catch (err) {
    // The project's runner image is still building (or failed): this opens once
    // it is ready. Not a crash, and not something a click here can change.
    if (err instanceof RunnerImageNotReadyError) {
      throw new RpcError(409,
        `${displayId(task)}'s environment opens once the project's runner image is ready. ${describeRunnerImage()}`);
    }
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
