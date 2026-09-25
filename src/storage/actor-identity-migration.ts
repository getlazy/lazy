/**
 * The one-time rewrite of stored attribution from a control plane's opaque user
 * id to the way git names a person: an email.
 *
 * WHY THIS EXISTS: `actor_user_id` held whatever the control plane in front of
 * the daemon called somebody — `user-12` on the one install that has any. The
 * field it becomes, `actor_email`, PROMISES an address, and carrying `user-12`
 * into it would make every surface render a person who does not exist. So a
 * value that cannot be read as an email is cleared, the row keeps its actor
 * ROLE (which is what a pre-identity row always carried), and the count is
 * REPORTED — see docs/design/actor-identity-and-remote-clients.md §3.8.
 *
 * The recovery path for a cleared id is deliberately NOT in lazy: the control
 * plane is the only thing that knows who `user-12` was, so it rewrites those
 * values to emails with its own one-off task BEFORE the upgraded daemon runs
 * this (lazy-teams/lib/tasks/actor_identity.rake). That is also why the report
 * names the distinct ids it cleared — an operator who ran them in the other
 * order can still map them by hand.
 *
 * This module is PURE: it rewrites parsed JSON in place and tallies what it
 * did. FileStorage owns the walk, the locking and the atomic writes.
 */

import { isPersonEmail } from '../actor-ref';

/** Running counts, shared across every file of every task in one run. */
export interface MigrationTally {
  carried: number;
  cleared: number;
  /** Distinct uninterpretable ids, so the report can name them. */
  clearedIds: Set<string>;
}

export function emptyTally(): MigrationTally {
  return { carried: 0, cleared: 0, clearedIds: new Set() };
}

/**
 * Every file a task directory keeps attributed rows in, and the key each one
 * wraps its row array in.
 *
 * This list is only HALF the scope, and the other half is what actually went
 * wrong: within these files the migration is per KEY — {@link RENAMES} for the
 * scalar pairs, {@link OVERLAY_ACTOR_KEYS} for the nested actor objects — so a
 * file being listed here does not mean every person it stores is migrated. A
 * new attributed file needs an entry here AND its keys in the right list; a new
 * attributed KEY on a file already listed needs only the latter, and is the
 * easier one to forget.
 */
const ROW_ARRAY_KEY: Record<string, string> = {
  'turns.json': 'turns',
  'comments.json': 'comments',
  'status-changelog.json': 'changes',
  'tag-history.json': 'events',
  'raised-items.json': 'raised_items',
  'region-overlays.json': 'overlays',
};

export const ATTRIBUTED_TASK_FILES: readonly string[] = Object.keys(ROW_ARRAY_KEY);

/**
 * Legacy key → the key it becomes. The actor pair is on turns, comments, status
 * changes, tag events and raised-item comments; the decision trio is on a
 * raised item itself.
 */
const RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['actor_user_id', 'actor_email'],
  ['resolved_by_user_id', 'resolved_by_email'],
  ['unresolved_by_user_id', 'unresolved_by_email'],
  ['flagged_by_user_id', 'flagged_by_email'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a stored field CLAIMS a person is, as a string to judge and to report.
 * Anything that is not a scalar claims nobody legibly.
 */
function readPerson(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Settle who one attributed field names, across BOTH spellings of it.
 *
 * The legacy key is always removed: leaving it behind would mean a store that
 * reads as migrated on every surface while still carrying the old spelling for
 * the next reader to rediscover.
 *
 * The CURRENT key is judged too, not just carried — §3.8 says the migration
 * clears any value it cannot interpret as an email, and says nothing about
 * which key it was under. That is what makes this converge instead of being a
 * one-shot: until the mint takes an `(email, name)` pair by name, `pinActor`
 * keeps stamping the token's `userId` straight into `actor_email`, so a
 * still-running producer can put a `user-12` under the NEW key the day after
 * this migration ran. Each start cleans up after it, for one predicate.
 *
 * Whichever half is an address wins; when neither is, both go and every
 * distinct id that claimed to name somebody is counted once.
 */
function rewriteAttribution(
  row: Record<string, unknown>,
  legacy: string,
  current: string,
  tally: MigrationTally,
): boolean {
  const hadLegacy = legacy in row;
  const hadCurrent = current in row;
  if (!hadLegacy && !hadCurrent) return false;

  const legacyValue = readPerson(row[legacy]);
  const currentValue = readPerson(row[current]);
  if (hadLegacy) delete row[legacy];

  // The current key is preferred: a newer write has since named the person, and
  // a stale legacy id must not overwrite it.
  const winner = isPersonEmail(currentValue) ? currentValue
    : isPersonEmail(legacyValue) ? legacyValue
    : '';

  if (winner) {
    if (row[current] !== winner) {
      row[current] = winner;
      tally.carried++;
      return true;
    }
    // The row already named the right person; only the legacy key moved.
    return hadLegacy;
  }

  // Nothing here names a person. Count the distinct ids that claimed to — one
  // attribution lost, however many keys were spelling it — and clear the field.
  for (const id of new Set([legacyValue, currentValue].filter(Boolean))) {
    tally.cleared++;
    tally.clearedIds.add(id);
  }
  if (hadCurrent) delete row[current];
  return true;
}

/** Apply every attributed field on one row. True when the row changed. */
function rewriteRow(row: Record<string, unknown>, tally: MigrationTally): boolean {
  let changed = false;
  for (const [legacy, current] of RENAMES) {
    if (rewriteAttribution(row, legacy, current, tally)) changed = true;
  }
  return changed;
}

/**
 * A region overlay's attribution is PER FIELD — who named the region's owner and
 * who signed it off are two separate people (src/regions/types.ts) — and each is
 * a whole actor OBJECT rather than a pair of scalar keys: `{ user_id, label }`
 * becomes `{ email, name }`.
 *
 * Both keys are listed in {@link OVERLAY_ACTOR_KEYS} and both are rewritten. A
 * key left off that list is the one silent loss this migration can still have:
 * its rows are neither carried nor cleared nor counted, so they keep the old
 * shape forever with nobody told. `owner_set_by` was exactly that, once.
 *
 * When the id is not an email the whole actor goes, not just its id — a name
 * alone names nobody reachable, and a stored `{ name: 'Ada' }` would render a
 * person the store cannot identify.
 */
const OVERLAY_ACTOR_KEYS = ['owner_set_by', 'signed_off_by'] as const;

function rewriteOverlayActor(
  container: Record<string, unknown>,
  key: string,
  tally: MigrationTally,
): boolean {
  const actor = container[key];
  if (!isRecord(actor)) return false;

  const hadLegacy = 'user_id' in actor || 'label' in actor;
  const legacyId = readPerson(actor.user_id);
  const label = readPerson(actor.label);
  delete actor.user_id;
  delete actor.label;

  const existing = readPerson(actor.email);
  // Judged, not just kept — an overlay written by a user token carries the
  // token's id in `email` for the same reason a turn does, so the current key
  // converges here exactly as it does on a scalar row.
  if (isPersonEmail(existing)) return hadLegacy;

  if (isPersonEmail(legacyId)) {
    actor.email = legacyId;
    // The label was a token's free-text name. Kept as the display name only
    // when it says something the address does not — Lazy Teams minted the
    // label AS the email, and `ada@example.com <ada@example.com>` is noise.
    if (label && label !== legacyId) actor.name = label;
    tally.carried++;
    return true;
  }

  for (const id of new Set([legacyId, existing].filter(Boolean))) {
    tally.cleared++;
    tally.clearedIds.add(id);
  }
  delete container[key];
  return true;
}

/**
 * Rewrite one task file's parsed contents in place.
 *
 * Returns true when anything changed — the caller writes only then, so a
 * second run over a migrated store rewrites nothing and a re-run is free.
 */
export function rewriteAttributedFile(
  fileName: string,
  data: unknown,
  tally: MigrationTally,
): boolean {
  const arrayKey = ROW_ARRAY_KEY[fileName];
  if (!arrayKey || !isRecord(data)) return false;
  const rows = data[arrayKey];
  if (!Array.isArray(rows)) return false;

  let changed = false;
  for (const row of rows) {
    if (!isRecord(row)) continue;

    if (fileName === 'region-overlays.json') {
      for (const key of OVERLAY_ACTOR_KEYS) {
        if (rewriteOverlayActor(row, key, tally)) changed = true;
      }
      continue;
    }

    if (rewriteRow(row, tally)) changed = true;

    // A raised item nests its own comment rows, each attributed the same way.
    if (fileName === 'raised-items.json' && Array.isArray(row.comments)) {
      for (const comment of row.comments) {
        if (isRecord(comment) && rewriteRow(comment, tally)) changed = true;
      }
    }
  }
  return changed;
}

/** How many distinct cleared ids the report names before truncating. */
export const CLEARED_ID_REPORT_CAP = 20;
