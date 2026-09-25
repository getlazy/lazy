/**
 * The rules for storing the latest usage-limit reading per credential
 * ([usage_pause]) — shared by every Storage backend so they cannot disagree.
 *
 * Two kinds of record share one slot per credential: a READING (usage headers)
 * and a SPEND mark (empty headers — lazy billed traffic to the credential and
 * got no usage headers back). Only a reading can pause anything, so:
 *
 * INVARIANT: a spend mark never replaces a reading, however much newer it is.
 * It only moves `spentAt`. A header-less request after a 97% reading (a
 * count_tokens call, a provider that sends headers on some responses only, the
 * "seen" mark a fresh daemon writes before it has seeded) used to overwrite the
 * reading, and the next restart found "no reading" and let turns start.
 *
 * Between two readings, or two spend marks, the newer wins (a late write never
 * rolls a credential back).
 */

import type { StoredUsageLimitReading } from './types';

/**
 * The saved readings file exists but cannot be read, parsed or understood.
 * Carries the path, so every surface can name the file a person must fix.
 */
export class UsageLimitReadingsUnreadableError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'UsageLimitReadingsUnreadableError';
  }
}

/** How far in the future a record's `ts` may be (clock skew between processes). */
export const USAGE_READING_MAX_FUTURE_SKEW_MS = 5 * 60_000;

function hasHeaders(r: StoredUsageLimitReading): boolean {
  return Object.keys(r.headers).length > 0;
}

function lastSpend(r: StoredUsageLimitReading): number {
  return Math.max(r.ts, r.spentAt ?? 0);
}

/**
 * The record to store for `incoming`'s credential, given what is stored, or
 * null to leave the store unchanged.
 */
export function mergeUsageLimitReading(
  existing: StoredUsageLimitReading | undefined,
  incoming: StoredUsageLimitReading,
): StoredUsageLimitReading | null {
  const fresh = { ...incoming, headers: { ...incoming.headers } };
  if (!existing) return fresh;
  const spentAt = Math.max(lastSpend(existing), lastSpend(incoming));
  if (hasHeaders(existing) && !hasHeaders(incoming)) {
    // A spend mark: the reading stays, only the spend time moves.
    return spentAt > lastSpend(existing) ? { ...existing, spentAt } : null;
  }
  if (!hasHeaders(existing) && hasHeaders(incoming)) {
    // Any reading beats a spend mark.
    return { ...fresh, ...(spentAt > fresh.ts ? { spentAt } : {}) };
  }
  // Like for like: the newer wins.
  if (existing.ts > incoming.ts) {
    return spentAt > lastSpend(existing) ? { ...existing, spentAt } : null;
  }
  return { ...fresh, ...(spentAt > fresh.ts ? { spentAt } : {}) };
}

/**
 * A STORED record, read back: validated, except that a `ts` / `spentAt` in the
 * future is CLAMPED to now instead of refused (`clamped` says so).
 *
 * INVARIANT: a saved reading is never dropped for being dated in the future.
 * Only the daemon writes these records, so a future date on read means the
 * clock moved (a VM resumed, the store moved between hosts), not a forged
 * record. Dropping it lost a valid 97% reading together with its spend mark:
 * after a restart the credential had no reading, nothing paused, nothing said
 * "armed, NO READING", and the next header-less request wrote a spend mark over
 * it for good. A record that fails validation for any OTHER reason throws —
 * the caller treats the whole store as unreadable (fail closed, never
 * overwritten), see FileStorage.
 */
export function readStoredUsageLimitReading(
  value: unknown,
  now: number = Date.now(),
): { record: StoredUsageLimitReading; clamped: boolean } {
  let clamped = false;
  let candidate = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = { ...(value as Record<string, unknown>) };
    for (const field of ['ts', 'spentAt'] as const) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v) && v > now + USAGE_READING_MAX_FUTURE_SKEW_MS) {
        r[field] = now;
        clamped = true;
      }
    }
    candidate = r;
  }
  return { record: validateStoredUsageLimitReading(candidate, now), clamped };
}

/**
 * Validate a record before it is stored: the shape, and a `ts` not in the
 * future — the store keeps the NEWER record per credential, so a record dated
 * next year would pin a credential's state until then. Throws, naming the field.
 */
export function validateStoredUsageLimitReading(
  value: unknown,
  now: number = Date.now(),
): StoredUsageLimitReading {
  const fail = (why: string): never => {
    throw new Error(`Invalid usage-limit reading: ${why}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  const r = value as Record<string, unknown>;
  // Any non-empty remainder after the prefix: a credential LABEL is free text
  // lazy chose itself, and some contain spaces (`credential:ChatGPT subscription`
  // — the Codex subscription). Only control characters are refused.
  // eslint-disable-next-line no-control-regex
  if (typeof r.credential !== 'string' || !/^(user|credential|upstream):[^\u0000-\u001f\u007f]+$/.test(r.credential)) {
    fail(`credential must be a user:/credential:/upstream: key, got ${JSON.stringify(r.credential)}`);
  }
  for (const field of ['ts', 'spentAt'] as const) {
    const v = r[field];
    if (field === 'spentAt' && v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`${field} must be a unix-ms number`);
    if ((v as number) > now + USAGE_READING_MAX_FUTURE_SKEW_MS) {
      fail(`${field} ${new Date(v as number).toISOString()} is in the future`);
    }
  }
  for (const field of ['upstream', 'backend'] as const) {
    if (typeof r[field] !== 'string') fail(`${field} must be a string`);
  }
  if (r.status !== null && typeof r.status !== 'number') fail('status must be a number or null');
  for (const field of ['taskId', 'model'] as const) {
    if (r[field] !== null && typeof r[field] !== 'string') fail(`${field} must be a string or null`);
  }
  const headers = r.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('headers must be an object');
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v !== 'string') fail(`header ${k} must be a string`);
  }
  return r as unknown as StoredUsageLimitReading;
}
