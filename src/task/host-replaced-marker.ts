/**
 * Turning "the machine this project ran on was replaced" into the one-shot
 * environment-replaced notice every open task's next work turn opens with.
 *
 * Lazy Teams on the microVM backend upgrades a project by recreating its VM on
 * the new daemon image. The clone and every worktree are carried across
 * byte-for-byte, but nothing else in the VM is: tools an agent installed, the
 * guest's docker images and task containers. The supervisor doing that lives
 * outside the VM and cannot write the store, so it drops a marker file in the
 * daemon base directory (a host mount that survives the VM) and the NEW daemon
 * consumes it at startup: one {@link recordEnvironmentReplaced} per open task,
 * then the marker is deleted. A daemon that dies before the delete records the
 * same reason again on the next start, which is idempotent.
 */

import { readFile, unlink } from 'fs/promises';
import { join } from 'path';

import type { Storage } from '../storage';
import { isTerminalStatus } from '../task-state-machine';
import { recordEnvironmentReplaced } from './environment-replaced';

/** File name, in the daemon base directory. Lazy Teams writes it; keep in sync with SmolvmSupervisor. */
export const HOST_REPLACED_MARKER = 'environment-replaced';

/** Reason used when the marker file carries no text of its own. */
export const REASON_HOST_REPLACED = "this project's machine was replaced to upgrade lazy";

/**
 * Consume the marker in `baseDir` if there is one. Returns how many tasks were
 * told, or null when there was no marker.
 */
export async function consumeHostReplacedMarker(
  storage: Pick<Storage, 'listTasks' | 'getTaskMetadata' | 'updateTaskMetadata'>,
  baseDir: string,
): Promise<number | null> {
  const path = join(baseDir, HOST_REPLACED_MARKER);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : err}`);
  }
  // One line of plain words; the notice is a single sentence, so no newlines
  // and no "; " (the pending-reasons separator) may survive into it.
  const reason = raw.replace(/\s+/g, ' ').replace(/;/g, ',').trim() || REASON_HOST_REPLACED;

  let told = 0;
  for (const task of await storage.listTasks()) {
    // Finished tasks run no more turns; a backlog task has never run one, so
    // it has nothing on the old machine to lose (the rule environment-replaced.ts
    // states for a first turn).
    if (isTerminalStatus(task.status) || task.status === 'backlog') continue;
    await recordEnvironmentReplaced(storage, task.id, reason);
    told++;
  }
  await unlink(path);
  return told;
}
