/**
 * Which tiers of a TIERED agent profile served a turn.
 *
 * The proxy picks a tier per request (src/proxy/tier-select.ts), so the model a
 * turn was LAUNCHED with (`Turn.model`, tier 0's) says nothing about where its
 * requests actually went. The daemon accumulates every tier that served the
 * RUNNING turn here, in task metadata. When the turn's agent WORK row is
 * written, FileStorage stamps the list onto it as `Turn.tiers_served` and clears
 * the record in the same write, so the next turn starts empty. No turn
 * sequence is stored: rows recorded mid-turn (a self-sync, an ask, a review)
 * move the sequence, and a guessed one would orphan the record.
 *
 * Zero imports beyond types on purpose: both the daemon and FileStorage read it.
 */

import type { TierServed } from '../types';

/** Task metadata key holding the running turn's served tiers. */
export const TIERS_SERVED_KEY = 'tiers_served_turn';

/** Parse the stored list; empty when absent or unreadable (never throws). */
export function readTiersServed(raw: string | undefined): TierServed[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TierServed[]) : [];
  } catch {
    // Unreadable metadata only costs the label; the turn itself is unaffected.
    return [];
  }
}

/** The list after `tier` served the running turn, or null when it is already there. */
export function addTierServed(raw: string | undefined, tier: TierServed): string | null {
  const tiers = readTiersServed(raw);
  if (tiers.some((t) => sameTier(t, tier))) return null;
  return JSON.stringify([...tiers, tier]);
}

export function sameTier(a: TierServed, b: TierServed): boolean {
  return a.index === b.index && a.endpoint === b.endpoint && a.model === b.model;
}

/** `tier 2: lunaroute/glm-5.3` — 1-based, as every tier surface counts them. */
export function formatTierServed(t: TierServed): string {
  return `tier ${t.index + 1}: ${t.endpoint}/${t.model}`;
}
