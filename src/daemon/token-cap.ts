/**
 * A task's own token cap (`lazy edit --token-cap`, task metadata `token_cap`):
 * what it has spent, whether it is at the cap, and the one refusal a launch of
 * a capped task gets. The running-turn stop (src/daemon/running-turn-stop.ts)
 * and the launch gates (src/daemon/usage-pause.ts) both read it here.
 */

import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { displayId } from '../task/identity';
import { formatTokenCount, tokenCapOf } from '../usage-pause/running-stop';

/** A task's token spend so far, from the proxy's durable per-task record. */
export async function taskTokenSpend(storage: Storage, taskId: string): Promise<number> {
  const stats = await storage.getToolStats(taskId);
  if (!stats) return 0;
  const u = stats.proxy_usage;
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/** Is `task` at or past its own token cap? The cap and spend when it is. */
export async function tokenCapReached(storage: Storage, task: Task): Promise<{ cap: number; spent: number } | null> {
  const cap = tokenCapOf(task);
  if (cap === null) return null;
  const spent = await taskTokenSpend(storage, task.id);
  return spent >= cap ? { cap, spent } : null;
}

/** The refusal a launch of a task at its cap gets — the same words everywhere. */
export function tokenCapRefusalText(task: Task, reached: { cap: number; spent: number }): string {
  return (
    `Task ${displayId(task)} has reached its token cap: ${formatTokenCount(reached.spent)} spent of ` +
    `${formatTokenCount(reached.cap)}. Raise the cap (\`lazy edit ${displayId(task)} --token-cap <count>\`, ` +
    `or "Token cap" on the task page) or clear it (\`--token-cap none\`), then run it again — or let just its next ` +
    `turn through (\`--override-usage-pause\`, or "Let its next turn through" on the task page).`
  );
}

