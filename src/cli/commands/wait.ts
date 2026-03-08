import { requireStorage, requireLazyRoot, displayId, parseFlags, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { followContainer } from './shared';
import type { Task, TaskStatus } from '../../types';
import type { Storage } from '../../storage';
import { queryWait } from '../../daemon/rpc-fallback';

const POLL_INTERVAL_MS = 1500;

/**
 * Wait for one or more tasks to transition from 'working' to another status.
 *
 * Modes:
 * - `lazy wait <id>` — wait for a single task (supports --follow)
 * - `lazy wait <id1> <id2> ...` — wait for first of multiple tasks to finish
 * - `lazy wait --next` — wait for any currently working task to finish
 */
export async function commandWait(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'follow', takesValue: false },
    { name: 'next', takesValue: false },
  ], 'wait');

  const isNext = parsed.flags.get('next') === true;
  const follow = parsed.flags.get('follow') === true;

  if (!isNext && parsed.positional.length === 0) {
    waitUsage();
    process.exit(1);
  }

  if (isNext && parsed.positional.length > 0) {
    console.error('--next does not accept task IDs. It waits for any working task.');
    process.exit(1);
  }

  // Single task, no --follow, no --next: use queryWait (daemon → direct fallback)
  if (!isNext && !follow && parsed.positional.length === 1) {
    const taskId = parsed.positional[0];
    console.log(`Waiting for task ${taskId} to complete...`);

    const result = await queryWait({ taskId });
    if (result.timed_out) {
      console.log(`Timed out waiting for task ${result.task_id.substring(0, 8)} (still ${result.status})`);
      process.exit(1);
    }
    console.log(`Task ${result.task_id.substring(0, 8)} is now ${result.status}`);
    process.exit(result.status === 'blocked' ? 0 : 1);
  }

  // --follow and multi-task modes need local storage access
  const storage = await requireStorage();

  try {
    let tasks: Task[];

    if (isNext) {
      // --next: find all currently working tasks
      tasks = await storage.listTasksWithOptions({ workingOnly: true });
      if (tasks.length === 0) {
        console.log('No working tasks to wait for.');
        process.exit(0);
      }
    } else {
      // Resolve specified task IDs
      tasks = [];
      for (const id of parsed.positional) {
        const task = await resolveTaskOrExit(storage, id);
        tasks.push(task);
      }
    }

    // Single task mode: supports --follow
    if (tasks.length === 1) {
      await waitSingleTask(storage, tasks[0], follow);
      return;
    }

    // Multi-task mode: --follow not supported
    if (follow) {
      console.error('--follow is only supported when waiting for a single task.');
      process.exit(1);
    }

    await waitMultipleTasks(storage, tasks);
  } finally {
    await storage.close();
  }
}

/**
 * Wait for a single task to transition out of 'working'.
 * Supports --follow for streaming container output.
 */
async function waitSingleTask(storage: Storage, task: Task, follow: boolean): Promise<void> {
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    console.error(`Task ${displayId(task)} has no session.`);
    console.error(`Start it with: lazy start ${displayId(task)}`);
    process.exit(1);
  }

  // If task is already not working, exit immediately
  if (task.status !== 'working') {
    console.log(`Task ${displayId(task)} is already ${task.status}`);
    process.exit(task.status === 'blocked' ? 0 : 1);
  }

  // If --follow is specified, stream container logs and wait for exit
  if (follow) {
    if (!session.container_name) {
      console.error(`Task ${displayId(task)} has no container name.`);
      process.exit(1);
    }

    const lazyRoot = requireLazyRoot();
    const worktreePath = getWorktreePath(lazyRoot, task);

    const exitCode = await followContainer(session.container_name, storage, lazyRoot, worktreePath);
    await storage.close();
    process.exit(exitCode);
  }

  // Otherwise, poll task status until it changes
  console.log(`Waiting for task ${displayId(task)} to complete...`);

  let lastStatus: TaskStatus = task.status;
  while (lastStatus === 'working') {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const updatedTask = await storage.getTask(task.id);
    if (!updatedTask) {
      console.error(`Task ${displayId(task)} disappeared.`);
      process.exit(1);
    }

    lastStatus = updatedTask.status;
  }

  console.log(`Task ${displayId(task)} is now ${lastStatus}`);

  // Exit with code 0 if blocked (normal completion), 1 otherwise
  process.exit(lastStatus === 'blocked' ? 0 : 1);
}

/**
 * Wait for the first of multiple tasks to transition out of 'working'.
 * Returns as soon as any one task changes status.
 */
async function waitMultipleTasks(storage: Storage, tasks: Task[]): Promise<void> {
  // Filter to only working tasks; report non-working ones immediately
  const workingTasks: Task[] = [];
  for (const task of tasks) {
    if (task.status !== 'working') {
      console.log(`Task ${displayId(task)} is already ${task.status}`);
      // If any task is already done, exit immediately with its status
      process.exit(task.status === 'blocked' ? 0 : 1);
    }
    workingTasks.push(task);
  }

  if (workingTasks.length === 0) {
    console.log('No working tasks to wait for.');
    process.exit(0);
  }

  const taskNames = workingTasks.map(t => displayId(t)).join(', ');
  console.log(`Waiting for first of ${workingTasks.length} tasks to finish: ${taskNames}`);

  // Poll all tasks until one changes status
  while (true) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    for (const task of workingTasks) {
      const updatedTask = await storage.getTask(task.id);
      if (!updatedTask) {
        console.error(`Task ${displayId(task)} disappeared.`);
        process.exit(1);
      }

      if (updatedTask.status !== 'working') {
        console.log(`Task ${displayId(updatedTask)} is now ${updatedTask.status}`);
        process.exit(updatedTask.status === 'blocked' ? 0 : 1);
      }
    }
  }
}

export function waitUsage(): void {
  console.log(`Usage: lazy wait [<task_id>...] [--follow] [--next]

Block until a task transitions from 'working' to another status (blocked, complete, interrupted).

Modes:
  lazy wait <task_id>              Wait for a specific task
  lazy wait <id1> <id2> ...        Wait for the first of multiple tasks to finish
  lazy wait --next                 Wait for any currently working task to finish

With --follow (single task only), streams the container's stdout/stderr in real-time.

Options:
  --follow     Stream container output in real-time while waiting (single task only)
  --next       Wait for any working task to finish (no task IDs needed)

Exit Codes:
  0            Task became blocked (normal completion awaiting review)
  1            Task was interrupted or encountered an error

Examples:
  lazy wait abc12345                    # Poll until task completes
  lazy wait abc1 --follow               # Stream output while waiting
  lazy wait abc1 def2 ghi3              # Wait for first of three tasks
  lazy wait --next                      # Wait for any working task
  lazy wait abc1 && lazy unblock abc1   # Chain commands: wait then review`);
}
