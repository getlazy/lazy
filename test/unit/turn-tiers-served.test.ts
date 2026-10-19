/**
 * A tiered profile's turn records which tiers ACTUALLY served it.
 *
 * Field report 2026-10-06: a turn that died with a 401 after switching to tier
 * 2 was recorded as `claude-opus-5-5` — tier 1's launch model — with no trace
 * that its last requests went to a different endpoint. The proxy now reports
 * every served tier, the daemon accumulates them on the task per running turn,
 * and storage stamps them onto the turn's agent row.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { createTierServedRecorder } from '../../src/daemon/tier-switch-record';
import { addTierServed, readTiersServed } from '../../src/task/tiers-served';
import { formatTurnLaunchLabels } from '../../src/utils/turn-labels';

const tier1 = { index: 0, endpoint: 'anthropic-subscription', model: 'claude-opus-5-5', upstream: 'https://api.anthropic.com' };
const tier2 = { index: 1, endpoint: 'lunaroute', model: 'glm-5.3', upstream: 'https://gw.lunaroute.com' };

describe('tiers served by a turn', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-tiers-served-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a repeat tier is a no-op; a new one is appended in first-served order', () => {
    const one = addTierServed(undefined, tier1)!;
    expect(addTierServed(one, tier1)).toBeNull();
    expect(readTiersServed(addTierServed(one, tier2)!)).toEqual([tier1, tier2]);
  });

  // INVARIANT: the agent row of a tiered turn names every tier that served it,
  // in first-served order — including a switch mid-turn — and a later turn
  // never inherits an earlier turn's tiers.
  test('the agent row carries the tiers that served it, and only its own', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });

    const record = createTierServedRecorder(async () => storage, { recheckMs: 0 });
    await Promise.all([record({ taskId: task.id, tier: tier1 }), record({ taskId: task.id, tier: tier1 })]);
    await record({ taskId: task.id, tier: tier2 });
    // A row recorded MID-turn (a self-sync) must neither take nor lose the record.
    await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'merged', turnType: 'sync' });
    await record({ taskId: task.id, tier: tier2 });

    const agent = await storage.createTurn({ sessionId: sess.id, sequence: 3, role: 'agent', content: 'Invalid or revoked API key', model: 'claude-opus-5-5' });
    expect(agent.tiers_served).toEqual([tier1, tier2]);
    expect(formatTurnLaunchLabels({ ...agent, agent: 'claude-code' }))
      .toContain('ran on tier 1: anthropic-subscription/claude-opus-5-5, tier 2: lunaroute/glm-5.3');

    await storage.createTurn({ sessionId: sess.id, sequence: 4, role: 'human', content: 'again' });
    const next = await storage.createTurn({ sessionId: sess.id, sequence: 5, role: 'agent', content: 'ok' });
    expect(next.tiers_served).toBeUndefined();
  });
});
