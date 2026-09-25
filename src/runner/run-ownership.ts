/**
 * Which of the runs a runner can see belong to THIS project's tasks.
 *
 * `discoverRunningRuns()` is global by construction on every runner — host
 * PID files live in one `~/.lazy/run` directory and container names are one
 * Docker-wide namespace — so anything that stops runs in bulk (daemon
 * shutdown, the restart reaper) has to answer "is this one mine?" first.
 *
 * The answer must come from the SAME function that named the run in the first
 * place: `runner.runNameForTask(taskRef(task))`. Deriving it any other way is
 * how the shutdown sweep shipped broken — it stripped the `lazy-` prefix and
 * looked the remainder up in a set of 8-char short ids, while a run is named
 * for the task's REF, which is the task's code for every task a human creates
 * (see deriveTaskRef). Nothing matched, so shutdown skipped every real
 * supervisor as "not owned" and leaked it. Leaked supervisors are not merely
 * untidy: one keeps answering `isRunning()` for its run name, and the next
 * task that refs the same way is never given a supervisor at all — it sits in
 * `working` forever while the reconciler logs "still running, no response yet".
 */

import type { Runner } from './types';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { taskRef, deriveTaskRef } from '../task/identity';

/** The name → task index for one runner, over this project's whole task list. */
export type OwnedRuns = Map<string, Task>;

/**
 * Index every task in this project's storage by the run name its supervisor
 * would carry on `runner`.
 *
 * Covers tasks that are not running: a name that is not in this map belongs to
 * another project (or to no task at all), which is exactly the question callers
 * ask. Built per runner because the naming differs — a Docker container name is
 * not a host PID file name.
 *
 * A task is indexed under BOTH the ref it carries (`task_ref` metadata, written
 * at first launch) and the ref it would be given if it were launched now. The
 * two agree for every launched task; indexing both means a run whose task_ref
 * write did not survive is still recognized as ours rather than leaked.
 */
export async function indexRunsByName(storage: Storage, runner: Pick<Runner, 'runNameForTask'>): Promise<OwnedRuns> {
  const owned: OwnedRuns = new Map();
  const tasks = await storage.listTasks();
  for (const task of tasks) {
    for (const ref of new Set([taskRef(task), deriveTaskRef(task, tasks)])) {
      owned.set(runner.runNameForTask(ref), task);
    }
  }
  return owned;
}
