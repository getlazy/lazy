/**
 * The durable record of a tiered profile's tier SWITCH.
 *
 * The proxy picks a tier per request (src/proxy/tier-select.ts) and reports a
 * switch once, when the tier changes. It lands in the task's JOURNAL: durable,
 * shown by `lazy show` and the task page, and — unlike a comment — never
 * injected into the agent's prompt and never a reason to start a turn. No system
 * message: a switch is routine, and one per switch would be noise.
 *
 * The turn it belongs to is the one running: the count of recorded turns plus
 * one, because a turn's own row is written when it ends.
 */

import type { Storage } from '../storage/interface';
import type { TierSwitchEvent } from '../proxy/tier-select';
import { logger } from '../utils/logger';
import type { TierServed } from '../types';
import { addTierServed, TIERS_SERVED_KEY } from '../task/tiers-served';

/** The journal entry text for one switch. Exported for tests. */
export function tierSwitchJournalText(event: TierSwitchEvent, turnSequence: number | null): string {
  const from = event.from
    ? `tier ${event.from.index + 1} — endpoint \`${event.from.endpoint}\`, model \`${event.from.model}\``
    : 'an unknown tier (no earlier request on record since the daemon started)';
  const during = turnSequence !== null ? ` during turn ${turnSequence}` : '';
  if (event.to === null) {
    const reset = event.retryAt ? new Date(event.retryAt).toISOString() : 'not stated by any full window';
    return [
      `**Every tier full** on agent profile \`${event.profile}\`${during}`,
      '',
      `- From: ${from}`,
      '- To: no tier — the proxy answers this task\'s requests with HTTP 429 until a window resets',
      `- Earliest reset: ${reset}`,
      `- At: ${new Date(event.ts).toISOString()}`,
      `- Why: ${event.reason}`,
    ].join('\n');
  }
  const to = `tier ${event.to.index + 1} — endpoint \`${event.to.endpoint}\`, model \`${event.to.model}\``;
  return [
    `**Tier switch** on agent profile \`${event.profile}\`${during}`,
    '',
    `- From: ${from}`,
    `- To: ${to}`,
    `- At: ${new Date(event.ts).toISOString()}`,
    `- Why: ${event.reason}`,
    ...(event.thinkingDisabled
      ? ['- Extended thinking was turned off for this request: after the switch between providers, the last assistant message of the open tool-use loop has no thinking block. It turns back on with the next new user message.']
      : []),
  ].join('\n');
}

export async function recordTierSwitch(storage: Storage, event: TierSwitchEvent): Promise<void> {
  if (!event.taskId) return;
  let turnSequence: number | null = null;
  try {
    turnSequence = (await storage.getTurnCountByTaskId(event.taskId)) + 1;
  } catch (err) {
    logger.warn(
      `[tiers] cannot read the turn count of task ${event.taskId} for a tier switch record: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (event.crossed) {
    // Written BEFORE the journal entry: it is what keeps the next request
    // safe after a restart; the entry is only the record.
    await storage.updateTaskMetadata(event.taskId, TIERED_HISTORY_CROSSED_KEY, 'true');
  }
  await storage.appendJournalEntry(event.taskId, tierSwitchJournalText(event, turnSequence), 'system');
}

/**
 * Task metadata recording that a task's tiered session has been served by more
 * than one provider. Durable so the proxy's thinking-history handling survives
 * a daemon restart (src/proxy/tier-history.ts).
 */
export const TIERED_HISTORY_CROSSED_KEY = 'tiered_history_crossed';

export async function tieredHistoryCrossed(storage: Storage, taskId: string): Promise<boolean> {
  const task = await storage.getTask(taskId);
  return task?.metadata?.[TIERED_HISTORY_CROSSED_KEY] === 'true';
}

/**
 * Records which tiers serve each turn (src/task/tiers-served.ts).
 *
 * The proxy reports every served request. Deduped IN MEMORY first, so the
 * steady state touches no storage: a (task, tier) pair is checked against the
 * store at most once per `recheckMs` — enough to notice that the turn ended and
 * its record was cleared, so the next turn's first use of the tier is recorded
 * again. Bounded: oldest entries dropped past `maxEntries`.
 */
export function createTierServedRecorder(
  getStorage: () => Promise<Storage>,
  { recheckMs = 30_000, maxEntries = 2000 }: { recheckMs?: number; maxEntries?: number } = {},
) {
  const checkedAt = new Map<string, number>();
  // Per-task chain so two requests on one task cannot race the read-modify-write.
  const chains = new Map<string, Promise<void>>();
  return (event: { taskId: string; tier: TierServed }): Promise<void> => {
    const key = `${event.taskId}:${event.tier.index}:${event.tier.endpoint}:${event.tier.model}`;
    const last = checkedAt.get(key);
    if (last !== undefined && Date.now() - last < recheckMs) return Promise.resolve();
    checkedAt.delete(key);
    checkedAt.set(key, Date.now());
    while (checkedAt.size > maxEntries) checkedAt.delete(checkedAt.keys().next().value!);
    const prev = chains.get(event.taskId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const storage = await getStorage();
      const task = await storage.getTask(event.taskId);
      const updated = addTierServed(task?.metadata?.[TIERS_SERVED_KEY], event.tier);
      if (updated) await storage.updateTaskMetadata(event.taskId, TIERS_SERVED_KEY, updated);
    }).catch((err) => {
      checkedAt.delete(key);
      logger.warn(
        `[tiers] could not record which tier served task ${event.taskId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    });
    chains.set(event.taskId, next);
    void next.finally(() => { if (chains.get(event.taskId) === next) chains.delete(event.taskId); });
    return next;
  };
}
