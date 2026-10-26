import type { Task, Session } from '../types';
import { createRunner } from '../runner';
import { containerCliOf } from '../runner/container-cli';
import { displayId, taskRef } from '../task/identity';
import { isTerminalStatus } from '../task-state-machine';
import { logger } from '../utils/logger';

/** The environment's actual layout, never inferred from whether a data volume exists. */
export async function taskDataView(projectRoot: string, task: Task, session: Session | null) {
  const { TASK_DATA_MOUNT, TASK_DATA_ENV, OLD_TASK_ENVIRONMENT_NOTICE, taskDataVolumeName, listTaskDataVolumeNames, measureTaskDataBytes } = await import('../runner/task-data');
  const runner = await createRunner(projectRoot, session?.runner_type ?? task.runner_type ?? undefined);
  const base = { taskId: task.id, displayId: displayId(task), path: TASK_DATA_MOUNT, env: TASK_DATA_ENV };
  if (runner.type !== 'docker' && runner.type !== 'podman' && runner.type !== 'smolvm') {
    return { ...base, supported: false, exists: false, bytes: null, volume: null,
      restartAvailable: false, notice: null, finished: isTerminalStatus(task.status) };
  }
  const binary = containerCliOf(runner);
  const volume = taskDataVolumeName(task.id);
  // Bounded: a page reads this (Teams' Services tab), so no whole-engine
  // inventory — a name listing, then `du` inside the running container.
  let exists: boolean | null;
  try {
    exists = (await listTaskDataVolumeNames(binary)).has(volume);
  } catch (err) {
    logger.warn(`Could not list task data volumes for ${displayId(task)}: ${err instanceof Error ? err.message : String(err)}`);
    exists = null;
  }
  const runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
  const restartAvailable = !isTerminalStatus(task.status) && !!(await runner.lacksCurrentLayout?.(runName));
  const bytes = exists && !restartAvailable ? await measureTaskDataBytes(binary, runName) : null;
  return { ...base, supported: true, volume, exists, bytes, finished: isTerminalStatus(task.status),
    restartAvailable, notice: restartAvailable ? OLD_TASK_ENVIRONMENT_NOTICE : null };
}
