/**
 * Unit tests for the project-local, bounded proxy audit log.
 *
 * Covers the three things the old storage-backed implementation got wrong:
 * unbounded growth (now: rotation at the cap), tail reads that slurped the
 * whole file (now: capped segments, honest `limit`), and the leftover file at
 * the old store-root path (now: pruned, loudly).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readdir, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ProxyAuditLog,
  auditLogDir,
  auditLogPath,
  readAuditRecords,
  legacyAuditLogInfo,
  pruneLegacyAuditLog,
  formatSize,
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_SUBDIR,
} from '../../src/proxy/audit-log';
import type { ProxyAuditRecord } from '../../src/storage/types';

function makeRecord(seq: number, overrides?: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: `id-${seq}`,
    seq,
    ts: 1000000 + seq,
    role: 'agent',
    taskId: null,
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-sonnet-4-6',
    tier: 'sonnet',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: null,
    error: null,
    durationMs: 42,
    reroute: null,
    ...overrides,
  };
}

describe('ProxyAuditLog', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'lazy-proxy-audit-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test('list returns empty when no records', async () => {
    expect(await new ProxyAuditLog(dataDir).list()).toEqual([]);
  });

  test('append and list round-trip in insertion order', async () => {
    const log = new ProxyAuditLog(dataDir);
    await log.append(makeRecord(1));
    await log.append(makeRecord(2));
    await log.append(makeRecord(3));

    const records = await log.list();
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  // INVARIANT: the log lives under `<dataDir>/logs/`, not the data dir root.
  // `lazy init` enumerates individual ignore paths under `.lazy/` and
  // `.lazy/logs/` is already one of them, so this placement keeps the file out
  // of `git status` in EXISTING projects too — no .gitignore edit, no migration.
  test('writes under the data dir logs/ subdir, creating it if absent', async () => {
    const nested = join(dataDir, 'does', 'not', 'exist');
    const log = new ProxyAuditLog(nested);
    await log.append(makeRecord(1));
    expect(log.path).toBe(join(nested, AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME));
    expect((await stat(log.path)).isFile()).toBe(true);
  });

  test('limit option returns the most recent N records', async () => {
    const log = new ProxyAuditLog(dataDir);
    for (let i = 1; i <= 5; i++) await log.append(makeRecord(i));
    const records = await log.list({ limit: 3 });
    expect(records.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  test('limit: 0 returns empty', async () => {
    const log = new ProxyAuditLog(dataDir);
    await log.append(makeRecord(1));
    expect(await log.list({ limit: 0 })).toHaveLength(0);
  });

  test('limit larger than the record count returns everything', async () => {
    const log = new ProxyAuditLog(dataDir);
    for (let i = 1; i <= 3; i++) await log.append(makeRecord(i));
    expect((await log.list({ limit: 100 })).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test('preserves all fields including tool_use and tool_result', async () => {
    const log = new ProxyAuditLog(dataDir);
    await log.append(makeRecord(1, {
      role: 'builder',
      taskId: 'task-abc',
      toolUses: [{ id: 'tu1', name: 'Read', path: '/etc/hosts', command: null, target: null, connector: false, inputPreview: '{"path":"/etc/hosts"}' }],
      toolResults: [{ toolUseId: 'tu1', isError: false, contentPreview: '127.0.0.1 localhost', contentLen: 19 }],
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: null, cacheReadInputTokens: 10 },
      stopReason: 'end_turn',
    }));
    const [loaded] = await log.list();
    expect(loaded.role).toBe('builder');
    expect(loaded.taskId).toBe('task-abc');
    expect(loaded.toolUses[0].path).toBe('/etc/hosts');
    expect(loaded.toolResults[0].contentPreview).toBe('127.0.0.1 localhost');
    expect(loaded.usage?.inputTokens).toBe(100);
    expect(loaded.stopReason).toBe('end_turn');
  });

  test('a corrupt line does not make the log unreadable', async () => {
    const log = new ProxyAuditLog(dataDir);
    await log.append(makeRecord(1));
    await writeFile(log.path, `${JSON.stringify(makeRecord(1))}\n{ not json\n${JSON.stringify(makeRecord(2))}\n`);
    expect((await log.list()).map((r) => r.seq)).toEqual([1, 2]);
  });

  // INVARIANT: the log is BOUNDED. Uncapped growth is the defect this module
  // exists to fix — it reached 677 MiB in a real store and broke a store push.
  // The live segment must roll over at the cap, not keep growing.
  test('rotates the live segment once it reaches the cap', async () => {
    const lineBytes = JSON.stringify(makeRecord(1)).length + 1;
    // Cap sized so records 1..3 fill the segment exactly: rotation fires on 3.
    const log = new ProxyAuditLog(dataDir, { maxBytes: lineBytes * 3, retainedSegments: 1 });

    await log.append(makeRecord(1));
    await log.append(makeRecord(2));
    expect(await readdir(auditLogDir(dataDir))).toEqual([AUDIT_LOG_FILENAME]);

    await log.append(makeRecord(3)); // hits the cap -> rotate
    expect(await readdir(auditLogDir(dataDir))).toContain(`${AUDIT_LOG_FILENAME}.1`);

    // Live segment starts fresh; the rotated one still holds the first three.
    await log.append(makeRecord(4));
    expect((await log.list()).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  // INVARIANT: total size is bounded by (retained + 1) segments. A second
  // rotation must DROP the oldest segment rather than accumulate segments.
  test('keeps only the configured number of rotated segments', async () => {
    const lineBytes = JSON.stringify(makeRecord(1)).length + 1;
    const log = new ProxyAuditLog(dataDir, { maxBytes: lineBytes * 2, retainedSegments: 1 });

    for (let i = 1; i <= 6; i++) await log.append(makeRecord(i));

    // Exactly one rotated segment survives (the live one is recreated on the
    // next append), so no third segment ever accumulates.
    const files = (await readdir(auditLogDir(dataDir))).sort();
    expect(files).toEqual([`${AUDIT_LOG_FILENAME}.1`]);
    // Three rotations happened; everything older than the last rotated segment
    // is gone — that is the bound.
    expect((await log.list()).map((r) => r.seq)).toEqual([5, 6]);
  });

  test('rotation boundary: a limited read spans the rotated segment', async () => {
    const lineBytes = JSON.stringify(makeRecord(1)).length + 1;
    const log = new ProxyAuditLog(dataDir, { maxBytes: lineBytes * 2, retainedSegments: 1 });
    for (let i = 1; i <= 3; i++) await log.append(makeRecord(i));
    // Segments hold [1,2] (rotated) and [3] (live); a limit of 3 must reach back.
    expect((await log.list({ limit: 3 })).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await log.list({ limit: 2 })).map((r) => r.seq)).toEqual([2, 3]);
  });

  test('picks up the existing segment size when a new instance appends', async () => {
    const lineBytes = JSON.stringify(makeRecord(1)).length + 1;
    const opts = { maxBytes: lineBytes * 2, retainedSegments: 1 };
    await new ProxyAuditLog(dataDir, opts).append(makeRecord(1));
    // A restarted daemon must not treat the live segment as empty, or the cap
    // would never be reached after enough restarts.
    await new ProxyAuditLog(dataDir, opts).append(makeRecord(2));
    expect(await readdir(auditLogDir(dataDir))).toContain(`${AUDIT_LOG_FILENAME}.1`);
  });

  test('readAuditRecords reads the same log without an instance', async () => {
    await new ProxyAuditLog(dataDir).append(makeRecord(7));
    expect((await readAuditRecords(dataDir)).map((r) => r.seq)).toEqual([7]);
    expect(auditLogPath(dataDir)).toBe(join(dataDir, AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME));
  });
});

// INVARIANT: the audit plane does NOT live in the Storage interface. Storage is
// for permanent state; this is high-churn disposable telemetry. If someone
// re-adds an audit method to Storage, these fail.
describe('audit records never touch Storage', () => {
  test('storage implementations expose no audit methods', async () => {
    const { FileStorage } = await import('../../src/storage/file-storage');
    const tmp = await mkdtemp(join(tmpdir(), 'lazy-proxy-audit-store-'));
    try {
      const storage = new FileStorage(tmp) as unknown as Record<string, unknown>;
      expect(storage.appendAuditRecord).toBeUndefined();
      expect(storage.listAuditRecords).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a queued audit write lands in the local log with no storage round-trip', async () => {
    // The AuditQueue writes to an AuditSink — the bounded local log. This is
    // the seam that used to be a Storage call (and, on remote/postgres
    // backends, a proxied RPC on every audited request).
    const { AuditQueue } = await import('../../src/proxy/audit');
    const dir = await mkdtemp(join(tmpdir(), 'lazy-proxy-audit-queue-'));
    try {
      const queue = new AuditQueue(new ProxyAuditLog(dir));
      queue.enqueue(makeRecord(1));
      queue.enqueue(makeRecord(2));
      await queue.flush();
      expect((await readAuditRecords(dir)).map((r) => r.seq)).toEqual([1, 2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy store-root audit log migration', () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = await mkdtemp(join(tmpdir(), 'lazy-proxy-audit-legacy-'));
  });

  afterEach(async () => {
    await rm(storePath, { recursive: true, force: true });
  });

  test('reports nothing when the old path is clean', async () => {
    expect(await legacyAuditLogInfo(storePath)).toBeNull();
    expect(await pruneLegacyAuditLog(storePath)).toBeNull();
  });

  // The engineer's own store was in exactly this state: a 677 MiB blob at the
  // store root. Upgrading must clear it, and the caller must be able to say how
  // much went away (no silent data disappearance).
  test('detects and removes an oversized legacy log, reporting its size', async () => {
    const legacyPath = join(storePath, AUDIT_LOG_FILENAME);
    const oversized = 'x'.repeat(5 * 1024 * 1024);
    await writeFile(legacyPath, oversized);

    const info = await legacyAuditLogInfo(storePath);
    expect(info?.path).toBe(legacyPath);
    expect(info?.bytes).toBe(oversized.length);

    const pruned = await pruneLegacyAuditLog(storePath);
    expect(pruned?.bytes).toBe(oversized.length);
    expect(await legacyAuditLogInfo(storePath)).toBeNull();

    // Idempotent: a second daemon start finds nothing to do.
    expect(await pruneLegacyAuditLog(storePath)).toBeNull();
  });

  test('pruning the store root leaves the project-local log alone', async () => {
    await writeFile(join(storePath, AUDIT_LOG_FILENAME), 'legacy\n');
    const dataDir = join(storePath, 'project-data');
    await mkdir(dataDir, { recursive: true });
    const log = new ProxyAuditLog(dataDir);
    await log.append(makeRecord(1));

    await pruneLegacyAuditLog(storePath);
    expect((await log.list()).map((r) => r.seq)).toEqual([1]);
  });

  test('formatSize renders large sizes readably', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(710 * 1024 * 1024)).toBe('710.0 MiB');
  });
});
