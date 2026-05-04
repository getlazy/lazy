import type { Task } from '../types';
import type { Storage } from '../storage';
import type { EffortLevel } from '../config/types';

/**
 * Resolve the effort level for a task launch and persist it on task metadata.
 *
 * Precedence: CLI `--effort` override > task metadata > config default.
 *
 * Any of the three launch paths (launchTask, launchUnblockTask, resumeTask)
 * can be the first to run for a given task — for example, a task created
 * before the effort feature landed may hit launchUnblockTask first with no
 * metadata set. Whichever path runs first MUST persist the resolved value
 * so later turns don't re-read config mid-task and observe a changed default.
 *
 * Mutates `task.metadata.effort` in place so the caller's local view matches
 * what was just written to storage.
 */
export async function resolveAndPersistEffort(
  task: Task,
  override: string | undefined,
  configDefault: EffortLevel,
  storage: Storage,
): Promise<EffortLevel> {
  const resolved = (override ?? task.metadata?.effort ?? configDefault) as EffortLevel;

  if (task.metadata?.effort !== resolved) {
    await storage.updateTaskMetadata(task.id, 'effort', resolved);
    if (!task.metadata) task.metadata = {};
    task.metadata.effort = resolved;
  }

  return resolved;
}
