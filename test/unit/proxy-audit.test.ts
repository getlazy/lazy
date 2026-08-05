/**
 * Unit tests for the AuditQueue.
 * Verifies that audit records are written serially and errors don't block the queue.
 */

import { describe, test, expect, mock } from 'bun:test';
import { AuditQueue, type AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

function makeRecord(seq: number): ProxyAuditRecord {
  return {
    id: `id-${seq}`,
    seq,
    ts: Date.now(),
    role: 'agent',
    taskId: 'task-1',
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
    durationMs: 100,
    reroute: null,
  };
}

describe('AuditQueue', () => {
  test('appends records to the sink in order', async () => {
    const written: ProxyAuditRecord[] = [];
    const sink: AuditSink = {
      append: async (r: ProxyAuditRecord) => { written.push(r); },
    };

    const queue = new AuditQueue(sink);
    queue.enqueue(makeRecord(1));
    queue.enqueue(makeRecord(2));
    queue.enqueue(makeRecord(3));
    await queue.flush();

    expect(written.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test('continues after a failed append', async () => {
    const written: number[] = [];
    let callCount = 0;
    const sink: AuditSink = {
      append: async (r: ProxyAuditRecord) => {
        callCount++;
        if (callCount === 2) throw new Error('disk full');
        written.push(r.seq);
      },
    };

    const queue = new AuditQueue(sink);
    queue.enqueue(makeRecord(1));
    queue.enqueue(makeRecord(2)); // will throw
    queue.enqueue(makeRecord(3));
    await queue.flush();

    // Records 1 and 3 succeed; record 2 fails but doesn't block 3
    expect(written).toEqual([1, 3]);
    expect(callCount).toBe(3);
  });

  test('flush returns after all enqueued writes complete', async () => {
    let resolveWrite!: () => void;
    const writePromise = new Promise<void>((res) => { resolveWrite = res; });
    const sink: AuditSink = {
      append: async () => { await writePromise; },
    };

    const queue = new AuditQueue(sink);
    queue.enqueue(makeRecord(1));
    let flushed = false;
    const flushPromise = queue.flush().then(() => { flushed = true; });

    // Not yet flushed — writePromise is pending
    expect(flushed).toBe(false);
    resolveWrite();
    await flushPromise;
    expect(flushed).toBe(true);
  });
});
