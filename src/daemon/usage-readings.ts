/**
 * The latest usage-limit reading per credential, made DURABLE.
 *
 * `[usage_pause]` decides on the latest reading the proxy captured for a
 * credential (src/proxy/usage-limits.ts). That reading used to live only in
 * daemon memory, re-seeded after a restart from the proxy audit log — which is
 * bounded, disposable telemetry (src/proxy/audit-log.ts). A paused credential
 * sends no traffic, so during a long (7-day) pause its last reading is exactly
 * what rotates out; the next `lazy upgrade` then found "no reading" and let
 * turns start at 97%. Losing it costs the user money, so per CLAUDE.md it
 * belongs in Storage: this module writes every reading through, and seeds the
 * tracker from Storage FIRST, then the audit log (the newer reading per
 * credential wins either way).
 *
 * WRITES NEVER TOUCH THE REQUEST. The tracker calls the listener synchronously
 * from the proxy's audit tap; the write runs behind it, throttled per
 * credential — a reading that says something new (a window crossed a whole
 * percent, changed status or reset time) is written at once; a repeat of the
 * same numbers at most once per {@link USAGE_READING_WRITE_INTERVAL_MS}, the
 * latest one when the interval ends. The daemon flushes on shutdown. A storage
 * failure is logged and dropped: the next reading writes again.
 */

import { join } from 'path';
import type { ResolvedConfig } from '../config/types';
import type { StoredUsageLimitReading } from '../storage/types';
import { UsageLimitReadingsUnreadableError } from '../storage/usage-limit-readings';
import { readAuditRecords } from '../proxy/audit-log';
import { daemonUsageLimits, usageWindows, type UsageLimitReading } from '../proxy/usage-limits';
import { logger } from '../utils/logger';

/** The two Storage methods this module needs. */
export interface UsageReadingStore {
  getUsageLimitReadings(): Promise<StoredUsageLimitReading[]>;
  saveUsageLimitReading(reading: StoredUsageLimitReading): Promise<void>;
}

/** At most one write per credential this often; the latest reading always lands. */
export const USAGE_READING_WRITE_INTERVAL_MS = 30_000;

let store: (() => Promise<UsageReadingStore>) | null = null;
let storeSeeded: Promise<void> | null = null;
let auditSeeded: Promise<void> | null = null;
/** Why the last Storage seed failed, or null once one has succeeded (see seedFromStore). */
let storeSeedError: UsageReadingsStoreError | null = null;

/** The saved readings could not be read: the path to fix (when known) and why. */
export interface UsageReadingsStoreError {
  path: string | null;
  message: string;
}

/**
 * Why the saved readings could not be read, or null when they were (or when
 * this process has no store). While this is set the launch gate FAILS CLOSED
 * (src/daemon/usage-pause.ts): with the stored reading unknown, "no reading"
 * could be a 97% reading nobody can see.
 */
export function usageReadingsStoreError(): UsageReadingsStoreError | null {
  return storeSeedError;
}

interface Slot {
  lastWrite: number;
  /** What the last written reading SAID (see `materialKey`), so a change is written at once. */
  lastKey: string | null;
  pending: StoredUsageLimitReading | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void>;
}
const slots = new Map<string, Slot>();
/** "Spent, no reading" marks waiting for the Storage seed before they are judged. */
const deferredMarks = new Set<Promise<void>>();

function toStored(r: UsageLimitReading | StoredUsageLimitReading): StoredUsageLimitReading {
  return {
    credential: r.credential, ts: r.ts, upstream: r.upstream, backend: r.backend,
    status: r.status, taskId: r.taskId, model: r.model, headers: { ...r.headers },
  };
}

/**
 * What a reading says, coarsely: each window's whole percent, status and reset.
 * Utilization moves slowly, so this changes a bounded number of times per
 * window, and a change is never throttled away.
 */
function materialKey(reading: StoredUsageLimitReading): string {
  return JSON.stringify(
    usageWindows(reading.headers, reading.ts).map((w) => [
      w.name, w.usedPercent === null ? null : Math.floor(w.usedPercent), w.status, w.resetsAt,
    ]),
  );
}

function write(credential: string, reading: StoredUsageLimitReading): void {
  const slot = slots.get(credential)!;
  slot.lastWrite = Date.now();
  slot.lastKey = materialKey(reading);
  slot.pending = null;
  const resolve = store;
  if (!resolve) return;
  slot.inFlight = slot.inFlight
    // Never before the Storage seed (see seedFromStore).
    .then(() => seedFromStore())
    .then(async () => (await resolve()).saveUsageLimitReading(reading))
    .catch((err) => {
      logger.warn(
        `usage pause: could not save the usage reading for ${credential} ` +
          `(the next reading tries again): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

function record(reading: StoredUsageLimitReading): void {
  let slot = slots.get(reading.credential);
  if (!slot) {
    slot = { lastWrite: 0, lastKey: null, pending: null, timer: null, inFlight: Promise.resolve() };
    slots.set(reading.credential, slot);
  }
  const wait = slot.lastWrite + USAGE_READING_WRITE_INTERVAL_MS - Date.now();
  // A reading that SAYS something new — a window crossed a whole percent,
  // changed status or reset time — is written at once, throttle or not: the
  // reading that trips a pause is exactly the one a restart must not lose, and
  // it may be the last this credential sees for days.
  if ((wait <= 0 && !slot.timer) || materialKey(reading) !== slot.lastKey) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    write(reading.credential, reading);
    return;
  }
  // Keep only the newest; the timer writes it when the interval ends.
  if (!slot.pending || slot.pending.ts <= reading.ts) slot.pending = reading;
  if (!slot.timer) {
    const s = slot;
    s.timer = setTimeout(() => {
      s.timer = null;
      if (s.pending) write(reading.credential, s.pending);
    }, Math.max(wait, 0));
    // A pending write must never hold the daemon open on shutdown.
    (s.timer as { unref?: () => void }).unref?.();
  }
}

/**
 * Seed the tracker from Storage, once per process (retried until it succeeds).
 *
 * INVARIANT: the Storage seed FINISHES before anything else touches this
 * credential state — before the audit log is folded in, before a "spent, no
 * reading" mark is judged, and before any write reaches the store. Otherwise a
 * fresh daemon, whose memory is still empty, saw the first header-less request
 * as "no reading" and wrote a spend mark over the stored 97% reading.
 */
function seedFromStore(): Promise<void> {
  const resolve = store;
  if (!resolve) return Promise.resolve();
  if (!storeSeeded) {
    storeSeeded = (async () => {
      daemonUsageLimits.seed(await (await resolve()).getUsageLimitReadings());
      if (storeSeedError) logger.info('usage pause: the saved usage readings are readable again');
      storeSeedError = null;
    })().catch((err) => {
      storeSeeded = null;
      // Kept as STATE, not only logged: every surface shows it, and the gate
      // refuses launches while it stands. Cleared by the first seed that works.
      const message = err instanceof Error ? err.message : String(err);
      // Retried on every check while it stands, so logged once per distinct error.
      if (storeSeedError?.message !== message) {
        logger.warn(`usage pause: could not read the saved usage readings — launches are refused until it can: ${message}`);
      }
      storeSeedError = {
        path: err instanceof UsageLimitReadingsUnreadableError ? err.path : null,
        message,
      };
    });
  }
  return storeSeeded;
}

/**
 * Wire the daemon's tracker to Storage: every reading it takes, and every
 * credential it first sees spend without one, is written through. Called once
 * at daemon start, before the proxy serves; the Storage seed starts at once and
 * every write waits for it. `resolve` is not awaited here, so proxy start
 * never waits on storage init.
 */
export function installUsageReadingStore(resolve: () => Promise<UsageReadingStore>): void {
  store = resolve;
  void seedFromStore();
  daemonUsageLimits.setListener({
    reading: (r) => record(toStored(r)),
    seen: (credential, ts, rec) => {
      // Judged only once the stored readings are in: a credential with a
      // reading needs no "spent, no reading" mark (and the store would not let
      // one replace the reading anyway).
      const judged = seedFromStore().then(() => {
        if (daemonUsageLimits.readings().some((r) => r.credential === credential)) return;
        record({
          credential, ts, upstream: rec.upstream, backend: rec.backend,
          status: rec.status, taskId: rec.taskId, model: rec.model, headers: {},
        });
      });
      deferredMarks.add(judged);
      void judged.finally(() => deferredMarks.delete(judged));
    },
  });
}

/**
 * Seed the daemon's tracker once per process: from Storage (when this process
 * has a store — the daemon) FIRST, then from the audit log. Each source is
 * retried on the next call until it succeeds; a failure is logged and never
 * fatal, since the live view still has whatever the proxy fed it since start.
 */
export async function seedUsageReadings(projectRoot: string, config: ResolvedConfig): Promise<void> {
  await seedFromStore();
  if (!auditSeeded) {
    auditSeeded = (async () => {
      const records = await readAuditRecords(join(projectRoot, config.data.path));
      // Folded quietly — a log of thousands of requests would otherwise queue a
      // write for every reading that moved — and then the RESULT is written
      // once per credential, which carries a reading that exists only in the
      // log (an install from before readings were stored) into Storage.
      const before = new Map(daemonUsageLimits.readings().map((r) => [r.credential, r.ts]));
      const spentBefore = daemonUsageLimits.spentCredentials();
      daemonUsageLimits.quietly(() => {
        for (const r of records) daemonUsageLimits.observe(r);
      });
      if (store) {
        // Only what the log CHANGED: a reading it made newer, or a spend it added.
        const read = new Set<string>();
        for (const r of daemonUsageLimits.readings()) {
          read.add(r.credential);
          if ((before.get(r.credential) ?? -1) < r.ts) record(toStored(r));
        }
        for (const [credential, ts] of daemonUsageLimits.spentCredentials()) {
          if (read.has(credential) || spentBefore.has(credential)) continue;
          record({
            credential, ts, upstream: daemonUsageLimits.spentUpstreams(credential)[0] ?? '', backend: '',
            status: null, taskId: null, model: null, headers: {},
          });
        }
      }
    })().catch((err) => {
      auditSeeded = null;
      logger.debug(
        `usage pause: could not seed readings from the audit log: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  await auditSeeded;
}

/** Wait for every queued write (tests, and a clean shutdown). */
export async function flushUsageReadingWrites(): Promise<void> {
  await Promise.all([...deferredMarks]);
  for (const [credential, slot] of slots) {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
      if (slot.pending) write(credential, slot.pending);
    }
  }
  await Promise.all([...slots.values()].map((s) => s.inFlight));
}

/** Test-only: a daemon restart — forget the readings, the store, the seeding and the queued writes. */
export function resetUsageReadingsForTest(): void {
  daemonUsageLimits.resetForTest();
  for (const slot of slots.values()) if (slot.timer) clearTimeout(slot.timer);
  slots.clear();
  deferredMarks.clear();
  store = null;
  storeSeeded = null;
  storeSeedError = null;
  auditSeeded = null;
  daemonUsageLimits.setListener(null);
}
