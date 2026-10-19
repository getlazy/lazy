import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { clearMemberEndpointUsage, flushUsageReadingWrites, installUsageReadingStore, resetUsageReadingsForTest, seedUsageReadings, type UsageReadingStore } from '../../src/daemon/usage-readings';
import { daemonUsageLimits, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import type { StoredUsageLimitReading, ProxyAuditRecord } from '../../src/storage/types';
import { mergeUsageLimitReading } from '../../src/storage/usage-limit-readings';
import { ProxyAuditLog } from '../../src/proxy/audit-log';
import { pinConfig } from '../helpers/pin-config';

let root: string;
let undo: (() => void) | undefined;
afterEach(async () => { resetUsageReadingsForTest(); undo?.(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'lazy-endpoint-readings-'));
  await writeFile(join(root, 'lazy.toml'), '');
  undo = pinConfig(root);
  resetUsageReadingsForTest();
  const rows = new Map<string, StoredUsageLimitReading>();
  let failDelete = false;
  const store: UsageReadingStore = {
    async getUsageLimitReadings() { return [...rows.values()]; },
    async saveUsageLimitReading(reading) { const merged = mergeUsageLimitReading(rows.get(reading.credential), reading); if (merged) rows.set(reading.credential, merged); },
    async deleteUsageLimitReading(key) { if (failDelete) throw new Error('disk unavailable'); rows.delete(key); },
  };
  installUsageReadingStore(async () => store);
  const config = await loadConfig(root);
  await seedUsageReadings(root, config);
  return { rows, store, config, setFailDelete: (value: boolean) => { failDelete = value; } };
}

function reading(key: string, used = '0.97'): StoredUsageLimitReading {
  return { credential: key, ts: Date.now(), upstream: 'https://provider.example', backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': used } };
}

// INVARIANT: replacement clears durable and in-memory usage after pending writes, and old audit history cannot resurrect it after restart. A new account starts with unknown usage.
test('clear drains pending writes and stays cleared after a restart with an old audit copy', async () => {
  const { rows, store, config } = await setup();
  const key = memberEndpointUsageKey('member', 'endpoint');
  const other = memberEndpointUsageKey('member', 'other');
  daemonUsageLimits.observeReading(reading(key));
  daemonUsageLimits.observeReading(reading(other));
  await flushUsageReadingWrites();
  daemonUsageLimits.observeReading(reading(key)); // same window: queued behind the throttle
  const log = new ProxyAuditLog(join(root, config.data.path));
  const oldAudit: ProxyAuditRecord = {
    id: 'old', seq: 1, ts: Date.now(), role: 'agent', taskId: null, backend: 'proxy', upstream: 'https://provider.example',
    method: 'POST', path: '/v1/messages', endpoint: 'messages', model: null, tier: null, stream: null,
    requestShape: null, toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null,
    error: null, durationMs: 1, reroute: null, enforcement: null, credential: key, usageLimitHeaders: reading(key).headers,
  };
  await log.append(oldAudit);
  await clearMemberEndpointUsage(root, 'member', 'endpoint');
  await flushUsageReadingWrites();
  expect(rows.has(key)).toBe(false);
  expect(daemonUsageLimits.reading(key)).toBeNull();
  expect(rows.has(other)).toBe(true);
  resetUsageReadingsForTest();
  installUsageReadingStore(async () => store);
  await seedUsageReadings(root, config);
  expect(daemonUsageLimits.reading(key)).toBeNull();
  expect(daemonUsageLimits.reading(other)).not.toBeNull();
  daemonUsageLimits.observeReading(reading(key, '0.12'));
  await flushUsageReadingWrites();
  expect(rows.get(key)?.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.12');
});

// INVARIANT: failing to clear a connection refuses its replacement, retaining the old reading and allowing an explicit retry. It never silently turns a full account into unknown usage.
test('a failed durable clear propagates and does not poison the next retry', async () => {
  const { rows, setFailDelete } = await setup();
  const key = memberEndpointUsageKey('member', 'endpoint');
  daemonUsageLimits.observeReading(reading(key));
  await flushUsageReadingWrites();
  setFailDelete(true);
  await expect(clearMemberEndpointUsage(root, 'member', 'endpoint')).rejects.toThrow('disk unavailable');
  expect(daemonUsageLimits.reading(key)).not.toBeNull();
  expect(rows.has(key)).toBe(true);
  setFailDelete(false);
  await clearMemberEndpointUsage(root, 'member', 'endpoint');
  expect(rows.has(key)).toBe(false);
});
