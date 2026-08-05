/**
 * Unit tests for FileStorage proxy audit persistence.
 * Verifies appendAuditRecord and listAuditRecords work end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
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

describe('FileStorage proxy audit', () => {
  let tmpDir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-proxy-test-'));
    storage = new FileStorage(tmpDir);
  });

  afterEach(async () => {
    await storage.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('listAuditRecords returns empty when no records', async () => {
    const records = await storage.listAuditRecords();
    expect(records).toEqual([]);
  });

  test('appendAuditRecord and listAuditRecords round-trip', async () => {
    await storage.appendAuditRecord(makeRecord(1));
    await storage.appendAuditRecord(makeRecord(2));
    await storage.appendAuditRecord(makeRecord(3));

    const records = await storage.listAuditRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test('limit option returns most recent N records', async () => {
    for (let i = 1; i <= 5; i++) await storage.appendAuditRecord(makeRecord(i));
    const records = await storage.listAuditRecords({ limit: 3 });
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  test('limit: 0 returns empty', async () => {
    await storage.appendAuditRecord(makeRecord(1));
    const records = await storage.listAuditRecords({ limit: 0 });
    expect(records).toHaveLength(0);
  });

  test('preserves all fields including tool_use and tool_result', async () => {
    const record = makeRecord(1, {
      role: 'builder',
      taskId: 'task-abc',
      toolUses: [{ id: 'tu1', name: 'Read', path: '/etc/hosts', command: null, target: null, connector: false, inputPreview: '{"path":"/etc/hosts"}' }],
      toolResults: [{ toolUseId: 'tu1', isError: false, contentPreview: '127.0.0.1 localhost', contentLen: 19 }],
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: null, cacheReadInputTokens: 10 },
      stopReason: 'end_turn',
    });
    await storage.appendAuditRecord(record);
    const [loaded] = await storage.listAuditRecords();
    expect(loaded.role).toBe('builder');
    expect(loaded.taskId).toBe('task-abc');
    expect(loaded.toolUses).toHaveLength(1);
    expect(loaded.toolUses[0].path).toBe('/etc/hosts');
    expect(loaded.toolResults[0].contentPreview).toBe('127.0.0.1 localhost');
    expect(loaded.usage?.inputTokens).toBe(100);
    expect(loaded.stopReason).toBe('end_turn');
  });
});
