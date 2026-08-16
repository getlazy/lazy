import { requireStorage, requireLazyRoot, displayId, parseFlags, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { followContainer } from './shared';
import { isBlockedStatus } from '../../types';
import type { Task, TaskStatus } from '../../types';
import type { Storage } from '../../storage';
import { queryWait, type WaitResult } from '../../daemon/rpc-fallback';

/**
 * Wait for one or more tasks to transition from 'working' to another status.
 *
 * Modes:
 * - `lazy wait <id>` — wait for a single task (supports --follow)
 * - `lazy wait <id1> <id2> ...` — race: return as soon as the FIRST one finishes
 * - `lazy wait --next` — wait for any currently working task to finish
 *
 * Every non-`--follow` mode goes through ONE daemon wait RPC that races the
 * whole set internally — see src/daemon/wait-race.ts for why the race belongs
 * on the daemon side rather than as N parallel client requests.
 */
export async function commandWait(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'follow', takesValue: false },
    { name: 'next', takesValue: false },
    { name: 'json', takesValue: false },
  ], 'wait');

  const isNext = parsed.flags.get('next') === true;
  const follow = parsed.flags.get('follow') === true;
  const json = parsed.flags.get('json') === true;

  if (!isNext && parsed.positional.length === 0) {
    waitUsage();
    process.exit(1);
  }

  if (isNext && parsed.positional.length > 0) {
    console.error('--next does not accept task IDs. It waits for any working task.');
    process.exit(1);
  }

  if (follow && parsed.positional.length > 1) {
    console.error('--follow is only supported when waiting for a single task.');
    process.exit(1);
  }

  if (follow && json) {
    console.error('--follow streams container output and cannot be combined with --json.');
    process.exit(1);
  }

  // Resolve which task references to wait on. Only --next and --follow need
  // local storage; a plain wait hands the references straight to the daemon,
  // which resolves them itself.
  let refs = parsed.positional;

  if (isNext || follow) {
    const storage = await requireStorage();
    try {
      let tasks: Task[];

      if (isNext) {
        // --next: find all currently working tasks
        tasks = await storage.listTasksWithOptions({ workingOnly: true });
        if (tasks.length === 0) {
          if (json) {
            console.log(JSON.stringify({ timed_out: false, tasks: [], pending: [] }, null, 2));
          } else {
            console.log('No working tasks to wait for.');
          }
          process.exit(0);
        }
      } else {
        tasks = [await resolveTaskOrExit(storage, parsed.positional[0])];
      }

      if (follow) {
        if (tasks.length > 1) {
          console.error('--follow is only supported when waiting for a single task.');
          process.exit(1);
        }
        // Streams until the container exits — never returns.
        await waitFollowingContainer(storage, tasks[0]);
        return;
      }

      refs = tasks.map(t => displayId(t));
    } finally {
      await storage.close();
    }
  }

  await raceViaDaemon(refs, json);
}

/**
 * Race a set of task references through the daemon's wait RPC and report which
 * one fired. One reference or many — same call, same completion semantics.
 */
async function raceViaDaemon(refs: string[], json: boolean): Promise<void> {
  if (!json) {
    if (refs.length === 1) {
      console.log(`Waiting for task ${refs[0]} to complete...`);
    } else {
      console.log(`Waiting for the first of ${refs.length} tasks to finish: ${refs.join(', ')}`);
    }
  }

  let result: WaitResult;
  try {
    result = await queryWait(refs.length === 1 ? { taskId: refs[0] } : { taskIds: refs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.timed_out) {
    console.log(`Timed out waiting for ${describeSet(result)} (still working)`);
  } else {
    console.log(`Task ${winnerRef(result)} is now ${result.status}`);
    // A settled-looking status over a half-merged worktree is the lie this
    // guards against — say it right under the status (fix-sync-silent-conflict).
    if (result.merge_state) {
      console.log(result.merge_state.summary);
    }
    // The other tasks' statuses are useful context when racing a set.
    const others = (result.tasks ?? []).filter(t => t.task_id !== result.task_id);
    if (others.length > 0) {
      console.log(`Still pending: ${others.map(t => `${t.display_id} (${t.status})`).join(', ')}`);
    }
  }

  if (result.timed_out) process.exit(1);
  process.exit(isBlockedStatus(result.status as TaskStatus) ? 0 : 1);
}

function winnerRef(result: WaitResult): string {
  return result.display_id ?? result.task_id.substring(0, 8);
}

function describeSet(result: WaitResult): string {
  const tasks = result.tasks ?? [];
  if (tasks.length > 1) return `${tasks.length} tasks: ${tasks.map(t => t.display_id).join(', ')}`;
  return `task ${winnerRef(result)}`;
}

/**
 * Wait for a single task with --follow: stream the container's output and exit
 * with the container's exit code.
 */
async function waitFollowingContainer(storage: Storage, task: Task): Promise<void> {
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    console.error(`Task ${displayId(task)} has no session.`);
    console.error(`Start it with: lazy start ${displayId(task)}`);
    process.exit(1);
  }

  // If task is already not working, exit immediately
  if (task.status !== 'working') {
    console.log(`Task ${displayId(task)} is already ${task.status}`);
    process.exit(isBlockedStatus(task.status) ? 0 : 1);
  }

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

export function waitUsage(): void {
  console.log(`Usage: lazy wait [<task_id>...] [--follow] [--next] [--json]

Block until a task transitions from 'working' to another status (blocked, complete, interrupted).

Modes:
  lazy wait <task_id>              Wait for a specific task
  lazy wait <id1> <id2> ...        Race several tasks: returns as soon as the FIRST
                                   one finishes, naming which task fired
  lazy wait --next                 Wait for any currently working task to finish

With --follow (single task only), streams the container's stdout/stderr in real-time.

Options:
  --follow     Stream container output in real-time while waiting (single task only)
  --next       Wait for any working task to finish (no task IDs needed)
  --json       Emit the winning task plus every waited-on task as JSON

Exit Codes:
  0            Task became blocked (normal completion awaiting review)
  1            Task was interrupted, errored, or the wait timed out (600s cap)

Examples:
  lazy wait abc12345                    # Poll until task completes
  lazy wait abc1 --follow               # Stream output while waiting
  lazy wait abc1 def2 ghi3              # Return when the first of three finishes
  lazy wait abc1 def2 --json            # Machine-readable winner + still-pending set
  lazy wait --next                      # Wait for any working task
  lazy wait abc1 && lazy unblock abc1   # Chain commands: wait then review`);
}
