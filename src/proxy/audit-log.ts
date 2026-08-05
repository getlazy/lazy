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
 * BOUNDED BY CONSTRUCTION: the live segment rotates at
 * AUDIT_SEGMENT_MAX_BYTES and exactly AUDIT_RETAINED_SEGMENTS older segments
 * are kept, so the whole log can never exceed
 * (AUDIT_RETAINED_SEGMENTS + 1) * AUDIT_SEGMENT_MAX_BYTES. Retention is
 * deliberately small: the only reader is the recent-history auth verdict
 * (`lazy doctor`). This stream is not an analytics archive — anything that
 * wants statistics should tap the stream as it flows, not re-read the file.
 *
 * The writer is daemon-side only (`createProxyServer` is constructed solely by
 * the daemon), so a direct file writer is correct and the audit hot path makes
 * no storage round-trip at all. All I/O here is async — never block the
 * daemon's event loop.
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import type { ListAuditRecordsOptions, ProxyAuditRecord } from '../storage/types';

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

/**
 * Rotated segments retained alongside the live one (`proxy-audit.jsonl.1`, …).
 * One is enough: rotation must not drop the recent window a doctor run needs,
 * and nothing reads deeper than that.
 */
export const AUDIT_RETAINED_SEGMENTS = 1;

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
  /** Size of the live segment; null until read back from disk on first append. */
  private liveBytes: number | null = null;

  constructor(
    dataDir: string,
    options?: { maxBytes?: number; retainedSegments?: number },
  ) {
    this.dataDir = dataDir;
    this.maxBytes = options?.maxBytes ?? AUDIT_SEGMENT_MAX_BYTES;
    this.retained = options?.retainedSegments ?? AUDIT_RETAINED_SEGMENTS;
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

    const line = JSON.stringify(record) + '\n';
    await appendFile(this.path, line, 'utf-8');
    this.liveBytes += Buffer.byteLength(line, 'utf-8');

    if (this.liveBytes >= this.maxBytes) await this.rotate();
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
    // Drop what would fall off the end, then shift the rest down: .n -> .n+1.
    await rm(this.segmentPath(this.retained), { force: true });
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
    for (let n = 0; n <= this.retained; n++) {
      const records = await readSegment(n === 0 ? this.path : this.segmentPath(n));
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
