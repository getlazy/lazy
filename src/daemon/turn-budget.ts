/**
 * Turn budget — caps how many consecutive work turns a task may run without a
 * human in the loop.
 *
 * Only builder (MCP) and agent-driven turns count. System/supervisor-initiated
 * turns (auto-resume after crash, watchdog restarts, sync turns, auto-react
 * turns) are deliberately NOT counted here — they already have their own
 * budgets (daemon.max_auto_turns, the auto-react daily budget, the
 * interruption circuit breaker), so counting them again here would be a
 * double gate.
 *
 * Counter is stored as task metadata, following the same pattern as the
 * consecutive-auto-turns counter in auto-react-budget.ts.
 */

import type { Storage } from '../storage';

/** Metadata key for the consecutive non-human-turn count. */
const NON_HUMAN_TURN_COUNT_KEY = 'non_human_turn_count';

/**
 * Get the consecutive non-human-turn count for a task.
 */
export async function getNonHumanTurnCount(storage: Storage, taskId: string): Promise<number> {
  const value = await storage.getTaskMetadata(taskId, NON_HUMAN_TURN_COUNT_KEY);
  return value ? parseInt(value, 10) || 0 : 0;
}

/**
 * Increment the consecutive non-human-turn count for a task.
 * Returns the new count.
 */
export async function incrementNonHumanTurnCount(storage: Storage, taskId: string): Promise<number> {
  const current = await getNonHumanTurnCount(storage, taskId);
  const newCount = current + 1;
  await storage.updateTaskMetadata(taskId, NON_HUMAN_TURN_COUNT_KEY, String(newCount));
  return newCount;
}

/**
 * Reset the consecutive non-human-turn count for a task.
 * Called only when a human unblocks/resumes the task — an autonomous
 * builder/agent action must never reset its own budget.
 */
export async function resetNonHumanTurnCount(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, NON_HUMAN_TURN_COUNT_KEY, '');
}

export interface TurnBudgetDecision {
  allowed: boolean;
  reason?: string;
  count: number;
}

/**
 * Check whether another builder/agent-initiated turn is allowed for a task.
 * `maxTurnsWithoutHuman` of 0 means unlimited.
 */
export function checkTurnBudget(count: number, maxTurnsWithoutHuman: number): TurnBudgetDecision {
  if (maxTurnsWithoutHuman <= 0) return { allowed: true, count };
  if (count >= maxTurnsWithoutHuman) {
    return {
      allowed: false,
      reason:
        `Task has run ${count}/${maxTurnsWithoutHuman} consecutive turns without a human in the loop ` +
        `(limits.max_turns_without_human). A human must run 'lazy unblock' or 'lazy resume' to continue.`,
      count,
    };
  }
  return { allowed: true, count };
}
