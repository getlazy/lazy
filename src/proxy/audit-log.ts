/**
 * Proxy audit log — a bounded, project-local, append-only JSONL stream.
 *
 * WHY THIS IS NOT IN THE STORAGE LAYER: storage holds PERMANENT state (tasks,
 * sessions, turns, commits). The proxy audit trail is high-churn telemetry —
 * one line per model API request — and is disposable by design. It lived at the
 * store root once and grew to 677 MiB, which is how it broke a store push (a
 * single blob over the forge's 100 MiB limit) and made every `lazy doctor` run
 * slurp 677 MiB into one string. It now lives in the project-local
 * `.lazy/logs/` directory: impermanent, throwaway, and — because `lazy init`
 * has always enumerated `.lazy/logs/` in the project .gitignore — ignored in
 * every project that has ever run init, old and new, with nothing to migrate.
 *
 * BOUNDED BY CONSTRUCTION, BY SIZE AND BY AGE: the live segment rotates at
 * AUDIT_SEGMENT_MAX_BYTES, the number of rotated segments kept follows from the
 * size budget (`[proxy] audit_retention_mib`, default 128 MiB), and a rotated
 * segment whose NEWEST entry is older than `[proxy] audit_retention_days`
 * (default 7) is deleted — whichever limit is reached first. Age is pruned per
 * segment, so an entry can outlive the window by at most one segment's span.
 *
 * Why this deep (engineer's decision, 2026-10-06): the log is the only record
 * of WHICH upstream answered a request with what status, and a failure is
 * usually investigated the next morning. The old bound — one 4 MiB rotated
 * segment, ~8 MiB in all — covered a few hours on a busy day, so a 01:07 tier
 * switch 401 was already gone when it was looked for. It is still disposable
 * telemetry, never storage state; every reader is limited and reads
 * newest-first, so the deeper history costs nothing until someone asks.
 *
 * The writer is daemon-side only (`createProxyServer` is constructed solely by
 * the daemon), so a direct file writer is correct and the audit hot path makes
 * no storage round-trip at all. All I/O here is async — never block the
 * daemon's event loop.
 */

import { scrubLazyPlaceholders } from './credential-broker';
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import { hasScrubbableCredentials, redactSecretValues } from '../utils/redact';
import type { ListAuditRecordsOptions, ProxyAuditRecord } from '../storage/types';
import { DEFAULT_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_MIB } from './upstream-defaults';

/** File name of the live audit segment. */
export const AUDIT_LOG_FILENAME = 'proxy-audit.jsonl';

/**
 * Subdirectory of the project data dir the audit log lives in.
 *
 * `logs/` rather than the data dir root, because `lazy init` enumerates
 * individual paths under `.lazy/` in the project .gitignore and `.lazy/logs/`
 * is already one of them — putting the file there keeps it out of `git status`
 * for existing projects too, with no ignore-file change and no migration. It is
 * also where it belongs: nothing else prunes this directory either.
 */
export const AUDIT_LOG_SUBDIR = 'logs';

/** Rotate the live segment once it reaches this size. */
export const AUDIT_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;

export { DEFAULT_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_MIB };

/**
 * Rotated segments a size budget allows next to the live one. At least one, so
 * rotation never drops the recent window a doctor run needs.
 */
export function retainedSegmentsFor(retentionMib: number, segmentBytes = AUDIT_SEGMENT_MAX_BYTES): number {
  return Math.max(1, Math.floor((retentionMib * 1024 * 1024) / segmentBytes) - 1);
}

/**
 * Rotated segments retained by default (`proxy-audit.jsonl.1` … `.31`): the
 * 128 MiB budget in 4 MiB segments. The engineer's decision, 2026-10-06 — "keep
 * 7 days or 128 MiB, whichever comes first" — replacing a single segment that
 * held only a few hours of a busy day.
 */
export const AUDIT_RETAINED_SEGMENTS = retainedSegmentsFor(DEFAULT_AUDIT_RETENTION_MIB);

/** How often the append path checks rotated segments for age. */
const AGE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Hard ceiling on segments a reader will look for, whatever is on disk. */
const MAX_SEGMENTS_READ = 4096;

/** Directory the audit segments live in, for a project data dir. */
export function auditLogDir(dataDir: string): string {
  return join(dataDir, AUDIT_LOG_SUBDIR);
}

/** Absolute path of the live audit segment for a project data dir. */
export function auditLogPath(dataDir: string): string {
  return join(auditLogDir(dataDir), AUDIT_LOG_FILENAME);
}

function parseRecords(raw: string): ProxyAuditRecord[] {
  const records: ProxyAuditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ProxyAuditRecord);
    } catch {
      // A single corrupt line (e.g. a partial write interrupted by a crash)
      // must not make the whole audit log unreadable — skip it. The append
      // path writes whole lines, so this is rare and self-limiting.
    }
  }
  return records;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Failed to stat proxy audit segment at ${path}: ${(err as Error).message}`);
  }
}

/** Timestamp of the first parseable entry of a segment, reading at most 64 KiB. */
async function firstEntryTs(path: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to open proxy audit segment at ${path}: ${(err as Error).message}`);
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf-8').split('\n')) {
      try {
        const ts = (JSON.parse(line) as ProxyAuditRecord).ts;
        if (typeof ts === 'number') return ts;
      } catch {
        // A partial or corrupt line (the 64 KiB cut, or a crash mid-write): try the next.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function readSegment(path: string): Promise<ProxyAuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read proxy audit log at ${path}: ${(err as Error).message}`);
  }
  return parseRecords(raw);
}

/**
 * Scrub live credential values out of the free-text fields of an audit record.
 *
 * Contains no redaction logic of its own — it only routes named fields through
 * `redactSecretValues` (src/utils/redact.ts), which owns the rules and the
 * short-value threshold. It lives here rather than in that module so the
 * generic helper stays free of storage types.
 *
 * WHY THESE FIELDS: most of a ProxyAuditRecord is structured metadata (model,
 * status, token counts) that cannot carry a secret. Five fields carry free text
 * that can:
 *
 *  - `toolUses[].command` — the raw Bash command string. An agent running `env`,
 *    `echo $ANTHROPIC_API_KEY`, or an export lands the LIVE value here. This is
 *    the real path, not a hypothetical one.
 *  - `toolUses[].inputPreview` — a JSON snippet of the same tool input, so it
 *    carries the same content by another route.
 *  - `toolResults[].contentPreview` — the result of a prior action; the spike
 *    that motivated this record type proved unguessable file contents cross
 *    here, and a credentials file read is exactly that.
 *  - `error` — an upstream fetch error message, which can embed a URL with
 *    userinfo. Insurance: no observed path today.
 *  - `upstream` — a configured base URL, which a user could write with
 *    credentials in it. Insurance likewise.
 *
 * WHY AT APPEND, NOT AT RENDER: one write, many reads. `lazy audit <id>` prints
 * these fields to a terminal a human pastes into a bug report, but so would any
 * future reader; scrubbing on the way in covers all of them and keeps the cost
 * off the proxy's request path (appends are chained behind the response).
 *
 * Returns the input unchanged — the same object, not a copy — when nothing was
 * scrubbed, which is every request on a setup with no long credential in env.
 */
export function redactAuditRecordContent(record: ProxyAuditRecord): ProxyAuditRecord {
  // Lazy's own PLACEHOLDERS are scrubbed always, not only when the environment
  // holds a real credential: this log sits in the project, which every task
  // container mounts, and a placeholder echoed into one task's tool output
  // could otherwise be read and spent from a sibling container while its
  // owner's turn is live.
  const realSecrets = hasScrubbableCredentials();

  let changed = false;
  const scrub = <T extends string | null>(value: T): T => {
    if (value === null || value === '') return value;
    const out = scrubLazyPlaceholders(realSecrets ? redactSecretValues(value) : value) as T;
    if (out !== value) changed = true;
    return out;
  };

  const toolUses = record.toolUses.map((use) => ({
    ...use,
    command: scrub(use.command),
    inputPreview: scrub(use.inputPreview),
  }));
  const toolResults = record.toolResults.map((result) => ({
    ...result,
    contentPreview: scrub(result.contentPreview),
  }));
  const error = scrub(record.error);
  const upstream = scrub(record.upstream);

  if (!changed) return record;
  return { ...record, toolUses, toolResults, error, upstream };
}

/**
 * The bounded audit log for one project.
 *
 * Appends are expected to be serialised by the caller (AuditQueue chains them),
 * which is what makes the in-memory size counter and the rotate-after-append
 * sequence safe without a lock.
 */
export class ProxyAuditLog {
  private readonly dataDir: string;
  private readonly maxBytes: number;
  private readonly retained: number;
  /** Rotated segments whose newest entry is older than this (ms) are deleted; null = no age limit. */
  private readonly retentionMs: number | null;
  private readonly now: () => number;
  /** Size of the live segment; null until read back from disk on first append. */
  private liveBytes: number | null = null;
  private lastAgePrune = 0;

  /**
   * `retentionMib` / `retentionDays` are the `[proxy]` keys; `retainedSegments`
   * overrides the count derived from the size budget (tests). A WRITER should
   * pass the configured values; a reader needs none — `list` reads whatever
   * segments exist.
   */
  constructor(
    dataDir: string,
    options?: {
      maxBytes?: number;
      retainedSegments?: number;
      retentionMib?: number;
      retentionDays?: number;
      now?: () => number;
    },
  ) {
    this.dataDir = dataDir;
    this.maxBytes = options?.maxBytes ?? AUDIT_SEGMENT_MAX_BYTES;
    this.retained = options?.retainedSegments
      ?? retainedSegmentsFor(options?.retentionMib ?? DEFAULT_AUDIT_RETENTION_MIB, this.maxBytes);
    const days = options?.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
    this.retentionMs = days > 0 ? days * 24 * 60 * 60 * 1000 : null;
    this.now = options?.now ?? Date.now;
  }

  /** Path of the live segment. */
  get path(): string {
    return auditLogPath(this.dataDir);
  }

  /** Path of rotated segment `n` (1 = most recently rotated). */
  private segmentPath(n: number): string {
    return `${this.path}.${n}`;
  }

  private async liveSize(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new Error(`Failed to stat proxy audit log at ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Append one record, rotating once the live segment reaches the cap. */
  async append(record: ProxyAuditRecord): Promise<void> {
    // mkdir is cheap and idempotent; it guards against a brand-new project
    // whose data dir (or logs dir) does not exist yet.
    await mkdir(auditLogDir(this.dataDir), { recursive: true });
    if (this.liveBytes === null) this.liveBytes = await this.liveSize();
    // A quiet log rotates rarely, so age is also checked on a clock — BEFORE
    // this append, so a stale live segment is rotated out without the new
    // entry riding along with it.
    if (this.now() - this.lastAgePrune >= AGE_PRUNE_INTERVAL_MS) await this.pruneByAge();

    // Scrub on the way in, so no reader of this file — `lazy audit`, a doctor
    // run, or a human with `cat` — can surface a credential the agent echoed.
    const line = JSON.stringify(redactAuditRecordContent(record)) + '\n';
    await appendFile(this.path, line, 'utf-8');
    this.liveBytes += Buffer.byteLength(line, 'utf-8');

    if (this.liveBytes >= this.maxBytes) {
      await this.rotate();
      await this.pruneByAge();
    }
  }

  /**
   * Delete rotated segments whose newest entry (the file's last write) is older
   * than the retention window, walking the numbered segments up to the first
   * gap. Deleting an old high-numbered segment leaves no gap below it, because
   * a higher number is always older.
   */
  async pruneByAge(): Promise<void> {
    this.lastAgePrune = this.now();
    if (this.retentionMs === null) return;
    const cutoff = this.now() - this.retentionMs;
    // A quiet log's LIVE segment may never reach the size cap, so it would hold
    // entries indefinitely: once its first entry is past the window, rotate it,
    // and it ages out below like any other segment.
    const liveFirst = await firstEntryTs(this.path);
    if (liveFirst !== null && liveFirst < cutoff) {
      if (this.liveBytes === null) this.liveBytes = await this.liveSize();
      await this.rotate();
    }
    for (let n = 1; n <= MAX_SEGMENTS_READ; n++) {
      const path = this.segmentPath(n);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw new Error(`Failed to stat proxy audit segment at ${path}: ${(err as Error).message}`);
      }
      if (mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  /**
   * The oldest entry the log still reaches back to (its timestamp, ms), or
   * null for an empty log. Reads only the first line of the oldest segment.
   */
  async oldestEntryTs(): Promise<number | null> {
    let highest = 0;
    while (highest < MAX_SEGMENTS_READ && (await exists(this.segmentPath(highest + 1)))) highest++;
    for (let n = highest; n >= 0; n--) {
      const ts = await firstEntryTs(n === 0 ? this.path : this.segmentPath(n));
      if (ts !== null) return ts;
    }
    return null;
  }

  /**
   * Shift segments down one slot and start a fresh live segment. The oldest
   * retained segment is dropped — that is the bound. With retained = 0 the
   * live segment is simply truncated away.
   */
  private async rotate(): Promise<void> {
    if (this.retained <= 0) {
      await rm(this.path, { force: true });
      this.liveBytes = 0;
      return;
    }
    // Drop what would fall off the end — every segment numbered `retained` or
    // higher, so a LOWERED size budget takes effect at the next rotation rather
    // than when the extra segments age out — then shift the rest down.
    for (let n = this.retained; n <= MAX_SEGMENTS_READ; n++) {
      if (!(await exists(this.segmentPath(n)))) break;
      await rm(this.segmentPath(n), { force: true });
    }
    for (let n = this.retained - 1; n >= 1; n--) {
      try {
        await rename(this.segmentPath(n), this.segmentPath(n + 1));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // That segment does not exist yet (log younger than the retention
        // depth) — nothing to shift.
      }
    }
    await rename(this.path, this.segmentPath(1));
    this.liveBytes = 0;
  }

  /**
   * Records in insertion order (oldest first). `limit` returns the most recent
   * N — segments are read newest-first and reading stops as soon as the limit
   * is satisfied, so a limited read never touches more than it must. Every
   * segment is capped, so no read here can be unbounded.
   */
  async list(options?: ListAuditRecordsOptions): Promise<ProxyAuditRecord[]> {
    const limit = options?.limit;
    const bounded = limit !== undefined && limit >= 0;
    if (bounded && limit === 0) return [];

    const collected: ProxyAuditRecord[][] = [];
    let count = 0;
    // Walk whatever segments exist (a reader need not know the configured
    // retention), stopping at the first gap; MAX_SEGMENTS_READ is the backstop.
    for (let n = 0; n <= MAX_SEGMENTS_READ; n++) {
      const path = n === 0 ? this.path : this.segmentPath(n);
      if (n > 0 && !(await exists(path))) break;
      const records = await readSegment(path);
      if (records.length) {
        collected.unshift(records);
        count += records.length;
      }
      if (bounded && count >= limit!) break;
    }

    const all = collected.flat();
    if (bounded && all.length > limit!) return all.slice(all.length - limit!);
    return all;
  }
}

/** Read audit records without holding on to a log instance. */
export function readAuditRecords(
  dataDir: string,
  options?: ListAuditRecordsOptions,
): Promise<ProxyAuditRecord[]> {
  return new ProxyAuditLog(dataDir).list(options);
}

/** Size in bytes of a stale pre-move audit log at the store root, if present. */
export async function legacyAuditLogInfo(
  storePath: string,
): Promise<{ path: string; bytes: number } | null> {
  const path = join(storePath, AUDIT_LOG_FILENAME);
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return { path, bytes: s.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to stat legacy proxy audit log at ${path}: ${(err as Error).message}`);
  }
}

/**
 * Delete a stale pre-move audit log from the store root, returning what was
 * removed (or null if there was nothing there).
 *
 * The audit stream is disposable telemetry, so deleting it loses nothing that
 * matters — but the caller MUST say so on stdout. Data vanishing silently would
 * violate the no-hidden-side-effects rule.
 */
export async function pruneLegacyAuditLog(
  storePath: string,
): Promise<{ path: string; bytes: number } | null> {
  const info = await legacyAuditLogInfo(storePath);
  if (!info) return null;
  await rm(info.path, { force: true });
  return info;
}

/** Human-readable byte size for the migration notice. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
