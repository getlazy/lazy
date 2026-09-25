/**
 * Unit tests for src/daemon/concurrency.ts — the builder concurrency cap.
 *
 * INVARIANT (remove-reaper-cap-sweep): only the BUILDER cap exists. The agent
 * concurrency cap, its backlog→queued machinery, the priority-ordered drain,
 * and the idle-container reaper were all removed by explicit engineer decision
 * (2026-08-14): agent starts always launch immediately, and a blocked task's
 * container lives until the task reaches a terminal state. This suite pins the
 * removal — the module must not grow agent-cap machinery back.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as concurrency from '../../src/daemon/concurrency';
import {
  effectiveBuilderLimit,
  setLimitOverride,
  getLimitOverride,
  resetConcurrencyStateForTest,
  LIMIT_KEYS,
  decideBuilderSlot,
  countActiveBuilders,
  tryAdmitBuilderSlot,
  releaseBuilderSlot,
  builderIdFromRunName,
  BUILDER_RESERVATION_TTL_MS,
} from '../../src/daemon/concurrency';
import type { ResolvedConfig } from '../../src/config/types';

afterEach(() => {
  resetConcurrencyStateForTest();
});

function configWithBuilderLimit(builders: number): ResolvedConfig {
  return { limits: { max_concurrent_builders: builders } } as ResolvedConfig;
}

describe('builder limit & ephemeral override', () => {
  test('effective limit is the configured value when no override is set', () => {
    expect(effectiveBuilderLimit(configWithBuilderLimit(8))).toBe(8);
  });

  test('override changes the effective limit but leaves configured untouched', () => {
    const config = configWithBuilderLimit(8);
    setLimitOverride('max_concurrent_builders', 2);
    expect(effectiveBuilderLimit(config)).toBe(2);
    expect(getLimitOverride('max_concurrent_builders')).toBe(2);
    expect(config.limits.max_concurrent_builders).toBe(8); // config never mutated
  });

  test('clearing the override reverts to the configured value', () => {
    const config = configWithBuilderLimit(8);
    setLimitOverride('max_concurrent_builders', 2);
    expect(effectiveBuilderLimit(config)).toBe(2);
    setLimitOverride('max_concurrent_builders', undefined);
    expect(effectiveBuilderLimit(config)).toBe(8);
    expect(getLimitOverride('max_concurrent_builders')).toBeUndefined();
  });
});

/**
 * INVARIANT: builder slots are counted from the LIVE container set plus in-flight
 * reservations, deduplicated by builder id — the container `lazy-builder-<id>`
 * and the reservation for `<id>` are the same builder, and their overlap is the
 * normal case (the reservation outlives the container's appearance).
 *
 * INVARIANT: a reservation expires on its own. A launcher killed between
 * "admitted" and "container up" never releases, and a slot leaked for the
 * daemon's lifetime would be unrecoverable without a daemon restart.
 */
describe('builder slots', () => {
  /** A discoverer returning full `lazy-builder-<id>` container names. */
  const runs = (...ids: string[]) => async () => ids.map((id) => `lazy-builder-${id}`);
  const none = async () => [];

  test('decideBuilderSlot admits below the cap and denies at it', () => {
    expect(decideBuilderSlot(2, 4)).toEqual({ admitted: true, running: 3, limit: 4 });
    expect(decideBuilderSlot(4, 4)).toEqual({ admitted: false, running: 4, limit: 4 });
    expect(decideBuilderSlot(5, 4)).toEqual({ admitted: false, running: 5, limit: 4 });
  });

  test('builderIdFromRunName strips the container prefix and passes bare ids through', () => {
    expect(builderIdFromRunName('lazy-builder-abc123')).toBe('abc123');
    expect(builderIdFromRunName('abc123')).toBe('abc123');
  });

  test('counts live containers and reservations, deduplicated by builder id', async () => {
    expect(await countActiveBuilders(runs('a', 'b'))).toBe(2);

    // 'a' is reserved AND already has a container — one builder, one slot.
    await tryAdmitBuilderSlot(runs('a', 'b'), 'a', 8);
    expect(await countActiveBuilders(runs('a', 'b'))).toBe(2);

    // 'c' is reserved but its container is not up yet — it still holds a slot.
    await tryAdmitBuilderSlot(runs('a', 'b'), 'c', 8);
    expect(await countActiveBuilders(runs('a', 'b'))).toBe(3);
  });

  test('denies a launch at the cap and admits again once a slot is released', async () => {
    const first = await tryAdmitBuilderSlot(none, 'a', 1);
    expect(first).toEqual({ admitted: true, running: 1, limit: 1 });

    const second = await tryAdmitBuilderSlot(none, 'b', 1);
    expect(second).toEqual({ admitted: false, running: 1, limit: 1 });

    releaseBuilderSlot('a');
    expect(await tryAdmitBuilderSlot(none, 'b', 1)).toEqual({ admitted: true, running: 1, limit: 1 });
  });

  test('a live container fills the cap even with no reservations (a rogue launcher counts)', async () => {
    expect(await tryAdmitBuilderSlot(runs('someone-else'), 'mine', 1)).toEqual({
      admitted: false, running: 1, limit: 1,
    });
  });

  test('re-admitting a reserved id is idempotent — it never charges a second slot', async () => {
    await tryAdmitBuilderSlot(none, 'a', 1);
    const again = await tryAdmitBuilderSlot(none, 'a', 1);
    expect(again.admitted).toBe(true);
    expect(again.running).toBe(1);
  });

  // Two launches racing for the last slot: the count→decide→reserve section is
  // serialized, so exactly one wins. Started without awaiting in between.
  test('two concurrent admits cannot both take the last slot', async () => {
    const [a, b] = await Promise.all([
      tryAdmitBuilderSlot(none, 'a', 1),
      tryAdmitBuilderSlot(none, 'b', 1),
    ]);
    expect([a.admitted, b.admitted].filter(Boolean)).toHaveLength(1);
  });

  test('a reservation stops counting after its TTL, so a dead launcher leaks no slot', async () => {
    const t0 = 1_000_000;
    await tryAdmitBuilderSlot(none, 'a', 1, t0);
    expect(await countActiveBuilders(none, t0 + 1)).toBe(1);

    const later = t0 + BUILDER_RESERVATION_TTL_MS;
    expect(await countActiveBuilders(none, later)).toBe(0);
    expect(await tryAdmitBuilderSlot(none, 'b', 1, later)).toEqual({ admitted: true, running: 1, limit: 1 });
  });
});

describe('agent cap removal is pinned', () => {
  // INVARIANT: the only configurable limit key is the builder cap. If
  // max_concurrent_agents (or any agent-slot machinery) reappears here, that is
  // a reversal of the remove-reaper-cap-sweep decision and needs explicit
  // human approval, not a quiet re-introduction.
  test('LIMIT_KEYS contains exactly the builder cap', () => {
    expect([...LIMIT_KEYS]).toEqual(['max_concurrent_builders']);
  });

  test('the agent slot/queue/reap machinery is not exported', () => {
    const removed = [
      'tryAdmitAgentSlot',
      'releaseAgentSlot',
      'countActiveAgents',
      'decideAgentSlot',
      'effectiveAgentLimit',
      'orderQueuedTasks',
      'queuePosition',
      'selectContainersToReap',
    ];
    for (const name of removed) {
      expect((concurrency as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
