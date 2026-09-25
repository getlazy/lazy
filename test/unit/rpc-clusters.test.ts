/**
 * The `clusters` RPC, and the cluster progress the `show` RPC carries.
 *
 * WHY THESE EXIST AS RPCs AT ALL. A cluster's k-of-n, its running child and its
 * deferred ones are DERIVED from the children (`clusterProgressOf`), and CLAUDE.md
 * says that derivation has exactly one home because a stored or re-derived
 * counter drifts the first time a child is closed, reparented away, or accepted
 * by a human. A remote client (Lazy Teams) showing cluster progress therefore
 * cannot be given the ingredients — it has to be given the ANSWER.
 *
 * INVARIANT: the denominator counts every child, including terminal ones.
 * Accepted children are what k counts, so a payload built from a non-terminal
 * listing would report 0-of-something for a cluster that had landed work.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleClusters,
  handleShow,
  handleRpc,
} from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('clusters RPC', () => {
  let root: string;
  let unpinConfig: () => void;
  let clusterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-clusters-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    const storage = await getOrCreateStorage();
    const cluster = await storage.createTask('Drive the release', undefined, undefined, 'release-cluster', 'cluster');
    clusterId = cluster.id;

    // One accepted, one running, one deferred, one closed — every part of the
    // progress line, so the payload is asserted against a real mix.
    const landed = await storage.createTask('Landed work', cluster.id, undefined, 'child-landed');
    await storage.updateTaskStatus(landed.id, 'working');
    await storage.updateTaskStatus(landed.id, 'blocked');
    await storage.updateTaskStatus(landed.id, 'merging');
    await storage.updateTaskStatus(landed.id, 'complete');
    const running = await storage.createTask('Running work', cluster.id, undefined, 'child-running');
    await storage.updateTaskStatus(running.id, 'working');
    const deferred = await storage.createTask('Set aside', cluster.id, undefined, 'child-deferred');
    const tagged = await storage.addTaskTag(deferred.id, 'deferred-by-release-cluster');
    expect(tagged.tags).toContain('deferred-by-release-cluster');
    const closed = await storage.createTask('Not wanted', cluster.id, undefined, 'child-closed');
    await storage.updateTaskStatus(closed.id, 'abandoned');

    // A plain task with a child of its own: it must not appear in the listing,
    // and its `show` must carry a null progress rather than a 0/1.
    const plain = await storage.createTask('Ordinary task', undefined, undefined, 'plain-task');
    await storage.createTask('Ordinary child', plain.id, undefined, 'plain-child');
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('lists only cluster tasks, with derived progress and flagged children', async () => {
    const result = await handleClusters() as any;

    // `clusters`, and only `clusters`: the canonical call carries no legacy
    // spelling, so nothing new can start reading the retired key.
    expect(result.clusters).toHaveLength(1);
    expect(result.loops).toBeUndefined();
    expect(result.openCount).toBe(1);

    const entry = result.clusters[0];
    expect(entry.task.code).toBe('release-cluster');
    expect(entry.task.type).toBe('cluster');

    // 1 accepted of 3 still expected: the abandoned child is reported as
    // `closed` and left out of the denominator, so a finished cluster does not
    // read as permanently incomplete.
    expect(entry.progress.accepted).toBe(1);
    expect(entry.progress.total).toBe(3);
    expect(entry.progress.closed).toBe(1);
    expect(entry.progress.running.map((t: any) => t.code)).toEqual(['child-running']);
    expect(entry.progress.deferred.map((t: any) => t.code)).toEqual(['child-deferred']);
    // A child ref is enough to name it and link to it.
    expect(entry.progress.running[0]).toMatchObject({
      code: 'child-running',
      goal: 'Running work',
      status: 'working',
    });
    expect(typeof entry.progress.running[0].id).toBe('string');

    // Every child, oldest first, each saying whether THIS cluster set it aside.
    expect(entry.children.map((c: any) => c.code)).toEqual([
      'child-landed', 'child-running', 'child-deferred', 'child-closed',
    ]);
    expect(entry.children.map((c: any) => c.deferred)).toEqual([false, false, true, false]);
  });

  test('show carries the same derived progress, and null for a non-cluster task', async () => {
    const clusterShow = await handleShow(root, { taskId: clusterId }) as any;
    expect(clusterShow.clusterProgress).toMatchObject({ accepted: 1, total: 3, closed: 1 });
    expect(clusterShow.clusterProgress.running.map((t: any) => t.code)).toEqual(['child-running']);

    // INVARIANT: progress comes from the FULL child list, never the paged
    // `children` section — a k-of-n taken from one page is not a k-of-n.
    const paged = await handleShow(root, { taskId: clusterId, sections: ['children'], limit: 1 }) as any;
    expect(paged.children).toHaveLength(1);
    expect(paged.clusterProgress).toMatchObject({ accepted: 1, total: 3 });

    const plain = await handleShow(root, { taskId: 'plain-task' }) as any;
    expect(plain.clusterProgress).toBeNull();
  });

  // INVARIANT: the retired `loops` call answers with the retired KEY as well as
  // the new one, for the one release it survives. A client old enough to call
  // `loops` reads `payload["loops"]`; answering it with only `clusters` would
  // hand it an empty list and render "no cluster tasks" for a project that has
  // some — a silent wrong answer, which is worse than the hard failure the
  // alias exists to avoid. Delete this test with the alias.
  test('the deprecated `loops` call carries both the new and the legacy key', async () => {
    const legacy = await handleClusters({ legacyKey: true }) as any;

    expect(legacy.clusters).toHaveLength(1);
    expect(legacy.loops).toEqual(legacy.clusters);
    expect(legacy.openCount).toBe(1);
  });

  // INVARIANT: both names are reachable THROUGH THE DISPATCH TABLE, each with
  // its own shape. The two tests above call `handleClusters` directly, which
  // says nothing about whether either `case` arm exists or passes `legacyKey` —
  // delete an arm and they both stay green while a deployed old client gets a
  // 404 or an empty list. These drive the same entry point the daemon serves.
  //
  // Delete the `loops` half with the alias; keep the `clusters` half forever.
  describe('through the dispatch table', () => {
    test('`clusters` is a served method, and carries no legacy key', async () => {
      const served = await handleRpc('clusters', root, {}) as any;

      expect(served.clusters).toHaveLength(1);
      expect(served.clusters[0].task.code).toBe('release-cluster');
      expect(served.loops).toBeUndefined();
      expect(served.openCount).toBe(1);
    });

    test('the deprecated `loops` method is still served, with both keys', async () => {
      const served = await handleRpc('loops', root, {}) as any;

      expect(served.clusters).toHaveLength(1);
      expect(served.loops).toEqual(served.clusters);
      expect(served.openCount).toBe(1);
    });
  });
});
