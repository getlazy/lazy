/**
 * Unit tests: builder supervisor stamps the detected Claude sessionId onto its
 * builder-resume-intent on exit.
 *
 * In docker mode the host runner returns `sessionId: null` — only the
 * in-container supervisor detects the Claude sessionId (by diffing JSONL). The
 * host relaunch loop reads the sessionId back off the resume intent (written by
 * `lazy upgrade` before it stops the builder). This test verifies the stamp
 * lands exactly where the loop expects it (`takeBuilderResumeIntent`), and that
 * a stamp NEVER creates an intent out of thin air — otherwise the relaunch loop
 * would fire on a normal quit. See docs/spikes/builder-upgrade-resume.md §1.2/§3.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import type { Storage } from '../../src/storage/interface';
import type { BuilderResumeIntent } from '../../src/storage/types';
import { stampSessionIdOntoResumeIntent } from '../../src/supervisor/builder';

describe('builder supervisor sessionId stamp', () => {
  let lazyRoot: string;
  let basePath: string;
  // Each call gets a fresh FileStorage on the same backing dir — mirrors the
  // supervisor opening its own storage; the helper closes whatever it opens.
  const factory = async (root: string): Promise<Storage> => {
    const s = new FileStorage(root, { basePath });
    await s.initialize();
    return s;
  };

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-stamp-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-stamp-store-'));
    // Initialize the store once so the backing files exist.
    const s = new FileStorage(lazyRoot, { basePath });
    await s.initialize();
    await s.close();
  });

  afterEach(async () => {
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  const read = async (builderId: string): Promise<BuilderResumeIntent | null> => {
    const s = await factory(lazyRoot);
    try {
      return await s.takeBuilderResumeIntent(builderId);
    } finally {
      await s.close();
    }
  };

  test('stamps the sessionId onto an existing resume intent', async () => {
    // `lazy upgrade` writes the intent before stopping the builder — sessionId
    // unknown to the host at that point.
    const s = await factory(lazyRoot);
    await s.saveBuilderResumeIntent({
      builderId: 'b1',
      projectRoot: lazyRoot,
      createdAt: '2026-05-31T00:00:00.000Z',
    });
    await s.close();

    await stampSessionIdOntoResumeIntent('b1', lazyRoot, 'sess-xyz', factory);

    // The relaunch loop reads the sessionId back off the intent.
    const taken = await read('b1');
    expect(taken?.sessionId).toBe('sess-xyz');
    // createdAt and projectRoot are preserved — only sessionId is added.
    expect(taken?.createdAt).toBe('2026-05-31T00:00:00.000Z');
    expect(taken?.projectRoot).toBe(lazyRoot);
  });

  // INVARIANT: the stamp must NEVER create an intent. An intent means "an
  // upgrade stopped me, resume in place"; on a normal quit there is no intent,
  // and fabricating one would make the host relaunch loop fire spuriously.
  // (docs/spikes/builder-upgrade-resume.md §3 — loop only on an explicit intent.)
  test('does NOT create an intent when none exists (normal quit)', async () => {
    await stampSessionIdOntoResumeIntent('b1', lazyRoot, 'sess-xyz', factory);

    const s = await factory(lazyRoot);
    try {
      expect(await s.listBuilderResumeIntents()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test('only stamps the matching builder, leaving others untouched', async () => {
    const s = await factory(lazyRoot);
    await s.saveBuilderResumeIntent({ builderId: 'b1', projectRoot: lazyRoot, createdAt: 't1' });
    await s.saveBuilderResumeIntent({ builderId: 'b2', projectRoot: lazyRoot, createdAt: 't2' });
    await s.close();

    await stampSessionIdOntoResumeIntent('b1', lazyRoot, 'sess-1', factory);

    const s2 = await factory(lazyRoot);
    try {
      const intents = await s2.listBuilderResumeIntents();
      const b1 = intents.find(i => i.builderId === 'b1');
      const b2 = intents.find(i => i.builderId === 'b2');
      expect(b1?.sessionId).toBe('sess-1');
      expect(b2?.sessionId).toBeUndefined();
    } finally {
      await s2.close();
    }
  });

  test('is idempotent — re-stamping the same id is a no-op', async () => {
    const s = await factory(lazyRoot);
    await s.saveBuilderResumeIntent({ builderId: 'b1', projectRoot: lazyRoot, createdAt: 't1', sessionId: 'sess-1' });
    await s.close();

    await stampSessionIdOntoResumeIntent('b1', lazyRoot, 'sess-1', factory);

    const taken = await read('b1');
    expect(taken?.sessionId).toBe('sess-1');
  });
});
