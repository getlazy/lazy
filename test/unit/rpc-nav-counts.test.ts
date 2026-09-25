/**
 * The `navCounts` RPC — the nav badges for a client that renders its own nav
 * (Lazy Teams).
 *
 * INVARIANT: the RPC answers from the SAME computation as the dashboard's
 * `/api/nav-counts`. A Teams badge that counted a second way would disagree with
 * the daemon dashboard's badge for the same store, and neither would notice.
 * Tested THROUGH handleRpc so the dispatch arm is part of what is proven.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleRpc,
} from '../../src/daemon/rpc-handlers';
import { computeNavCounts } from '../../src/server/nav-counts';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('navCounts RPC', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-nav-counts-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    const storage = await getOrCreateStorage();
    const cluster = await storage.createTask('Drive the release', undefined, undefined, 'release-cluster', 'cluster');
    await storage.updateTaskStatus(cluster.id, 'working');
    const waiting = await storage.createTask('Waiting on a human', undefined, undefined, 'waiting-task');
    await storage.updateTaskStatus(waiting.id, 'working');
    await storage.updateTaskStatus(waiting.id, 'blocked');
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: the review count comes through the review port -- the same queue
  // `reviewQueue` answers -- so the badge and the page it points at agree.
  test('counts the review queue exactly as reviewQueue lists it', async () => {
    const result = await handleRpc('navCounts', root, {}) as Record<string, unknown>;
    const { queue } = await handleRpc('reviewQueue', root, {}) as { queue: unknown[] };
    expect(queue.length).toBeGreaterThan(0);
    expect(result.review).toBe(queue.length);
  });

  test('answers the same counts as the dashboard computation', async () => {
    const result = await handleRpc('navCounts', root, {}) as Record<string, unknown>;
    expect(result.clusters).toBe(1);
    expect(result.unread).toBe(0);
    expect(result.raisedBlocking).toBe(0);

    const storage = await getOrCreateStorage();
    const direct = await computeNavCounts(storage, undefined, 0);
    // Everything but the review queue (which needs the action port the RPC
    // supplies and a Storage-only call does not) is the same answer.
    expect({ ...result, review: null }).toEqual({ ...direct, review: null });
  });
});
