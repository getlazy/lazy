/**
 * `lazy prioritize <task> <level>` — set a task's queue priority.
 *
 * Priority orders the concurrency-limit queue: when an agent slot frees, the
 * daemon drains the highest-priority queued task first (ties break FIFO). It is
 * a plain, durable task edit (like `lazy edit --model`), NOT a scheduler.
 */

import { requireStorage, parseFlags, displayId, resolveTaskOrExit } from '../helpers';
import { theme } from '../theme';
import { VALID_TASK_PRIORITIES, type TaskPriority } from '../../types';

export async function commandPrioritize(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'prioritize');

  const taskId = parsed.positional[0];
  const level = parsed.positional[1];
  if (!taskId || !level) {
    prioritizeUsage();
    process.exit(1);
  }

  if (!VALID_TASK_PRIORITIES.includes(level as TaskPriority)) {
    console.error(`Invalid priority '${level}'. Must be one of: ${VALID_TASK_PRIORITIES.join(', ')}`);
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);
    await storage.updateTaskPriority(task.id, level);
    console.log(theme.success(`${displayId(task)} priority set to ${level}.`));
    if (task.status === 'queued') {
      console.log('It will be reconsidered for the next free agent slot at its new priority.');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await storage.close();
  }
}

export function prioritizeUsage(): void {
  console.log(`Usage: lazy prioritize <task_id> <level>

Set a task's queue priority. When the concurrency cap is hit, new starts queue;
as agent slots free up the daemon launches the highest-priority queued task
first (ties break FIFO — oldest queued first).

Arguments:
  <task_id>   Task code or short ID
  <level>     Priority: ${VALID_TASK_PRIORITIES.join(', ')} (default: normal)

Notes:
  - This is a durable task edit (persists like --model), not a one-off.
  - Terminal tasks (complete/abandoned) cannot be edited.
  - Priority is shown wherever queued state is (lazy active / lazy list).

Examples:
  lazy prioritize add-auth high
  lazy prioritize abc12345 urgent
  lazy prioritize fix-bug low`);
}
