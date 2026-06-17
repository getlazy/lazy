/**
 * Unit tests: builder-resume-intent storage entity.
 *
 * The builder-resume-intent is the durable cross-gap handshake that lets a
 * relaunched `lazy builder` know it was stopped by an upgrade and should resume
 * the same Claude session. See docs/spikes/builder-upgrade-resume.md §3.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import type { BuilderResumeIntent } from '../../src/storage/types';

describe('builder-resume-intent storage', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-bri-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-bri-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  const intent = (overrides: Partial<BuilderResumeIntent> = {}): BuilderResumeIntent => ({
    builderId: 'builder-1',
    projectRoot: '/proj/a',
    sessionId: 'sess-abc',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  test('save then list returns the intent', async () => {
    const i = intent();
    await storage.saveBuilderResumeIntent(i);

    const all = await storage.listBuilderResumeIntents();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(i);
  });

  test('listBuilderResumeIntents returns empty when none saved', async () => {
    expect(await storage.listBuilderResumeIntents()).toEqual([]);
  });

  // INVARIANT: take/consume clears the record — a given intent is acted on at
  // most once. The host builder wrapper consumes its intent after a successful
  // relaunch, and a second taker (or a re-run) must NOT see it again, otherwise
  // the relaunch loop could fire twice. (docs/spikes/builder-upgrade-resume.md §3)
  test('take consumes and clears the record', async () => {
    const i = intent();
    await storage.saveBuilderResumeIntent(i);

    const taken = await storage.takeBuilderResumeIntent('builder-1');
    expect(taken).toEqual(i);

    // Record is gone: a second take returns null and the list is empty.
    expect(await storage.takeBuilderResumeIntent('builder-1')).toBeNull();
    expect(await storage.listBuilderResumeIntents()).toEqual([]);
  });

  test('take returns null for an unknown builderId without touching others', async () => {
    await storage.saveBuilderResumeIntent(intent({ builderId: 'builder-1' }));

    expect(await storage.takeBuilderResumeIntent('does-not-exist')).toBeNull();
    // The unrelated intent is untouched.
    expect(await storage.listBuilderResumeIntents()).toHaveLength(1);
  });

  test('save is keyed by builderId — re-saving overwrites in place', async () => {
    await storage.saveBuilderResumeIntent(intent({ sessionId: 'old' }));
    await storage.saveBuilderResumeIntent(intent({ sessionId: 'new' }));

    const all = await storage.listBuilderResumeIntents();
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe('new');
  });

  test('multiple builders coexist; take affects only the targeted one', async () => {
    await storage.saveBuilderResumeIntent(intent({ builderId: 'builder-1', projectRoot: '/proj/a' }));
    await storage.saveBuilderResumeIntent(intent({ builderId: 'builder-2', projectRoot: '/proj/b' }));

    const taken = await storage.takeBuilderResumeIntent('builder-1');
    expect(taken?.builderId).toBe('builder-1');

    const remaining = await storage.listBuilderResumeIntents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].builderId).toBe('builder-2');
  });

  test('listBuilderResumeIntents filters by projectRoot', async () => {
    await storage.saveBuilderResumeIntent(intent({ builderId: 'builder-1', projectRoot: '/proj/a' }));
    await storage.saveBuilderResumeIntent(intent({ builderId: 'builder-2', projectRoot: '/proj/b' }));

    const aOnly = await storage.listBuilderResumeIntents('/proj/a');
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].builderId).toBe('builder-1');
  });

  test('sessionId is optional', async () => {
    const i: BuilderResumeIntent = {
      builderId: 'builder-1',
      projectRoot: '/proj/a',
      createdAt: new Date().toISOString(),
    };
    await storage.saveBuilderResumeIntent(i);

    const taken = await storage.takeBuilderResumeIntent('builder-1');
    expect(taken).toEqual(i);
    expect(taken?.sessionId).toBeUndefined();
  });
});
