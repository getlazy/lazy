import type { Task } from '../types';
import { shortId } from './identity';
import { logger } from '../utils/logger';

/** The slice of Storage the creator check needs. */
export interface StatusHistoryStorage {
  getStatusHistory(taskId: string): Promise<Array<{ timestamp: number; actor?: string }>>;
}

/**
 * Was this child created by its parent's own agent?
 *
 * The creating actor is the actor on the task's first status-changelog entry.
 * An `agent` actor under a parent can only be the parent's own agent:
 * `lazy_create` refuses to create anywhere but under the caller's own task.
 *
 * Unreadable history is not proof of anything: the child is treated as added
 * from outside, since a spurious notice is a far smaller failure than a parent
 * that never hears about a task somebody else gave it.
 */
export async function createdByOwnAgent(storage: StatusHistoryStorage, child: Task): Promise<boolean> {
  try {
    const history = await storage.getStatusHistory(child.id);
    const first = history.reduce<{ timestamp: number; actor?: string } | null>(
      (oldest, entry) => (!oldest || entry.timestamp < oldest.timestamp ? entry : oldest),
      null,
    );
    return first?.actor === 'agent';
  } catch (err) {
    logger.debug(
      `created-by-own-agent: could not read status history for ${shortId(child.id)}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
