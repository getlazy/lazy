import type { Task } from '../types';
import { shortId } from './identity';
import { logger } from '../utils/logger';

/** Written atomically at creation, from the authenticated member connection. */
export const MEMBER_PAIR_CREATION_KEY = 'created_from_member_pair';

/** The slice of Storage the creator check needs. */
export interface StatusHistoryStorage {
  getStatusHistory(taskId: string): Promise<Array<{ timestamp: number; actor?: string }>>;
}

/**
 * Was this child created by its parent's own agent?
 *
 * The creating actor is the actor on the task's first status-changelog entry.
 * The `agent` channel also includes a member's Pair assistant. Its creations
 * carry separate provenance: the channel and person alone cannot distinguish
 * it from a supervised turn that belongs to that same member.
 *
 * Unreadable history is not proof of anything: the child is treated as added
 * from outside, since a spurious notice is a far smaller failure than a parent
 * that never hears about a task somebody else gave it.
 */
export async function createdByOwnAgent(storage: StatusHistoryStorage, child: Task): Promise<boolean> {
  if (child.metadata?.[MEMBER_PAIR_CREATION_KEY] === 'true') return false;
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
