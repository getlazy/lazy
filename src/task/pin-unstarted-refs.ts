/**
 * Give every never-started task its branch name now.
 *
 * A task's ref (and so its branch name) is fixed when it is CREATED
 * (FileStorage.createTask). Tasks created before that rule carry no ref until
 * they start, and until then `taskRef()` answers their short id — a branch a
 * coded task will never have, so a child reparented under one chases a branch
 * that does not exist. This assigns those tasks the ref `lazy start` would
 * derive for them, with the same `deriveTaskRef` rules, so the name they are
 * seen under before start is the name they start with.
 *
 * Only tasks still in `backlog` with no session are touched: a task that ever
 * launched already cut a branch under whatever its ref was, and that name must
 * not move. Idempotent — a pinned store is walked and writes nothing.
 */

import type { Storage } from '../storage';
import { deriveTaskRef } from './identity';

export async function pinUnstartedTaskRefs(storage: Storage): Promise<number> {
  const all = await storage.listTasks();
  let pinned = 0;
  for (const task of all) {
    if (task.metadata?.task_ref || task.status !== 'backlog') continue;
    if (await storage.getSessionByTaskId(task.id)) continue;
    const ref = deriveTaskRef(task, all);
    await storage.updateTaskMetadata(task.id, 'task_ref', ref);
    task.metadata = { ...(task.metadata ?? {}), task_ref: ref };
    pinned++;
  }
  return pinned;
}
