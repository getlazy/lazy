/**
 * Concurrency limit for interactive builder containers.
 *
 * One configurable cap (lazy.toml `[limits]`, default 8):
 *  - `max_concurrent_builders` — concurrent interactive builder containers.
 *
 * Agent tasks are deliberately UNCAPPED: the old `max_concurrent_agents` cap,
 * its backlog→queued machinery, and the idle-container reaper were removed
 * (remove-reaper-cap-sweep) — their DX cost outweighed the rare Docker
 * launch-storm incidents they prevented. `lazy start` always launches
 * immediately, and a blocked task's container lives until the task reaches a
 * terminal state.
 *
 * Runtime override: the daemon holds an in-memory override that
 * `lazy daemon config set` mutates over RPC. Overrides are EPHEMERAL — they live
 * only in the running daemon process and are lost on restart, which reverts to
 * lazy.toml. Nothing here writes lazy.toml.
 *
 * Builder enforcement lives in the daemon, even though the builder container is
 * spawned by the client rather than by the daemon. The daemon owns the count
 * (live `lazy-builder-*` containers for this project, plus in-flight
 * reservations) and owns the decision (`tryAdmitBuilderSlot`, over the
 * `builderSlot` RPC). A launcher that only asks — the CLI today, a web UI
 * tomorrow — gets one race-free answer instead of reimplementing the comparison
 * per surface, which is how the cap came to be enforceable only from the CLI.
 * The client keeps a friendly pre-check for UX, but it is not the authority.
 *
 * The daemon cannot physically stop a process that spawns a container without
 * asking; that is a property of client-side spawning, not of this module. What
 * it can guarantee — and does — is that the count and the verdict have exactly
 * one implementation, and that two launches racing for the last slot cannot both
 * win.
 *
 * Builder admission is fail-FAST, never queued: an interactive session a human
 * is waiting on must not be silently parked behind other builders.
 */

import type { ResolvedConfig } from '../config/types';

/** The configurable concurrency caps, keyed by their lazy.toml name. */
export type LimitKey = 'max_concurrent_builders';

export const LIMIT_KEYS: readonly LimitKey[] = ['max_concurrent_builders'] as const;

// --- Ephemeral overrides (daemon-process memory only) ---

let builderLimitOverride: number | undefined;

/** Set (or clear, with `undefined`) the ephemeral override for a cap. */
export function setLimitOverride(_key: LimitKey, value: number | undefined): void {
  builderLimitOverride = value;
}

/** The current ephemeral override for a cap, or undefined when none is set. */
export function getLimitOverride(_key: LimitKey): number | undefined {
  return builderLimitOverride;
}

/** Effective builder cap: ephemeral override if set, else the lazy.toml value. */
export function effectiveBuilderLimit(config: ResolvedConfig): number {
  return builderLimitOverride ?? config.limits.max_concurrent_builders;
}

/** Test-only: clear all ephemeral overrides and reservations. */
export function resetConcurrencyStateForTest(): void {
  builderLimitOverride = undefined;
  builderReservations.clear();
}

/** Serialize the count→decide→reserve critical section (daemon is single-process). */
let lockTail: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lockTail.then(fn, fn);
  // Keep the chain alive regardless of outcome so a rejection never wedges it.
  lockTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface SlotDecision {
  /** True if the builder may launch now. */
  admitted: boolean;
  /** Slots in use AFTER this decision (a newly-admitted builder is counted). */
  running: number;
  /** The effective cap this decision was made against. */
  limit: number;
}

// --- Builder slot accounting ---

/**
 * How long an in-flight builder reservation survives without being released.
 *
 * A builder holds a slot for as long as its container is alive, and the live set
 * is read back from the runner — so a reservation only has to cover the window
 * between "the daemon admitted this launch" and "the container is visible to
 * `docker ps`". A client that dies inside that window (Ctrl-C between admit and
 * spawn, SIGKILL, a crashed web request) never releases, so the reservation must
 * expire on its own or a slot would leak for the daemon's lifetime. Generous
 * relative to a container start, short relative to a human noticing.
 */
export const BUILDER_RESERVATION_TTL_MS = 60_000;

/** builderId → epoch ms the reservation stops counting. */
const builderReservations = new Map<string, number>();

/**
 * Container name prefix for builders. `discoverProjectBuilderRuns` returns full
 * `lazy-builder-<id>` names; reservations are keyed by the bare `<id>` the
 * launcher generated, so one is mapped onto the other before they are unioned.
 */
const BUILDER_RUN_PREFIX = 'lazy-builder-';

/** Bare builder id from a discovered run name (unprefixed names pass through). */
export function builderIdFromRunName(name: string): string {
  return name.startsWith(BUILDER_RUN_PREFIX) ? name.slice(BUILDER_RUN_PREFIX.length) : name;
}

/** Drop reservations that have outlived {@link BUILDER_RESERVATION_TTL_MS}. */
function pruneBuilderReservations(nowMs: number): void {
  for (const [id, expiresAt] of builderReservations) {
    if (expiresAt <= nowMs) builderReservations.delete(id);
  }
}

/**
 * Count builder slots in use: distinct builder ids that either have a live
 * container right now or are reserved mid-launch.
 *
 * Deduplicated by id on purpose — a reservation and the container it produced
 * are the same builder, and the overlap between "container is up" and "the
 * reservation has not expired yet" is the normal case, not an edge case. Double
 * counting there would make every launch consume two slots for a minute.
 *
 * @param discoverRunNames Returns live builder container names for the project.
 *                         Injected so this stays free of runner/Docker imports
 *                         and testable without a container engine.
 */
export async function countActiveBuilders(
  discoverRunNames: () => Promise<string[]>,
  nowMs: number = Date.now(),
): Promise<number> {
  pruneBuilderReservations(nowMs);
  const ids = new Set<string>();
  for (const name of await discoverRunNames()) ids.add(builderIdFromRunName(name));
  for (const id of builderReservations.keys()) ids.add(id);
  return ids.size;
}

/**
 * Pure builder slot decision — exported for unit tests.
 *
 * There is no "already running" case: a builder id is minted per launch, so an
 * admit request is always for a NEW builder. A relaunch after `lazy upgrade`
 * stopped the container is deliberately not re-admitted by the caller — see the
 * launch site in `lazy builder`.
 */
export function decideBuilderSlot(running: number, limit: number): SlotDecision {
  if (running >= limit) return { admitted: false, running, limit };
  return { admitted: true, running: running + 1, limit };
}

/**
 * Atomically decide whether a builder may launch now and, if so, reserve its
 * slot. The count→decide→reserve critical section runs under a process-global
 * mutex — both sections are short, and the daemon is single-process — so it can
 * never interleave with another.
 *
 * Re-admitting an id that already holds a reservation refreshes it rather than
 * consuming a second slot, so a retried request is idempotent.
 */
export async function tryAdmitBuilderSlot(
  discoverRunNames: () => Promise<string[]>,
  builderId: string,
  limit: number,
  nowMs: number = Date.now(),
): Promise<SlotDecision> {
  return withLock(async () => {
    const already = builderReservations.has(builderId);
    const running = await countActiveBuilders(discoverRunNames, nowMs);
    // An id that is already counted must not be charged for a second slot.
    const decision = already
      ? { admitted: true, running, limit }
      : decideBuilderSlot(running, limit);
    if (decision.admitted) {
      builderReservations.set(builderId, nowMs + BUILDER_RESERVATION_TTL_MS);
    }
    return decision;
  });
}

/** Release a reservation taken by {@link tryAdmitBuilderSlot}. Idempotent. */
export function releaseBuilderSlot(builderId: string): void {
  builderReservations.delete(builderId);
}
