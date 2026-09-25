/**
 * The read-only scratch RPCs Lazy Teams renders from. Called through
 * `handleRpc`, because Teams' own tests use a stubbed daemon and cannot notice a
 * command that does not exist or a reply shape that moved.
 *
 * INVARIANT: a name-only file answers `content: null` with a `skippedReason`,
 * never an empty string — an empty body would read as "the builder wrote nothing".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('scratch RPCs', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-scratch-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    await storage.saveScratchFile(
      { path: 'review/accept-foo.md', content: 'the flaky widget\n', size: 17, session_id: 'sess-1' },
      'builder' as never,
    );
    await storage.saveScratchFile({ path: 'dump.bin', content: '', size: 5, skipped: 'binary' }, 'builder' as never);
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('scratchList groups entries without bodies, with reasons for name-only files', async () => {
    const res = await handleRpc('scratchList', root, {}) as any;
    expect(res.groups.map((g: any) => g.session_id)).toEqual(['sess-1', null]);
    expect(res.groups[0].files[0]).toMatchObject({ path: 'review/accept-foo.md', size: 17, session_id: 'sess-1' });
    expect(res.groups[0].files[0].content).toBeUndefined();
    expect(res.groups[1].files[0]).toMatchObject({ path: 'dump.bin', skipped: 'binary' });
    expect(res.groups[1].files[0].skippedReason).toContain('Binary');
  });

  test('scratchShow returns content, null for name-only, 404 for missing', async () => {
    const stored = await handleRpc('scratchShow', root, { path: 'review/accept-foo.md' }) as any;
    expect(stored.file.content).toBe('the flaky widget\n');
    const nameOnly = await handleRpc('scratchShow', root, { path: 'dump.bin' }) as any;
    expect(nameOnly.file.content).toBeNull();
    expect(nameOnly.file.skippedReason).toContain('recorded by name only');
    await expect(handleRpc('scratchShow', root, { path: 'nope.md' })).rejects.toMatchObject({ status: 404 });
  });

  test('scratchSearch finds content and refuses a blank query', async () => {
    const res = await handleRpc('scratchSearch', root, { query: 'flaky widget' }) as any;
    expect(res.hits.map((h: any) => h.path)).toEqual(['review/accept-foo.md']);
    expect(res.hits[0].match_context).toContain('flaky');
    expect(res.hits[0].file.path).toBe('review/accept-foo.md');
    await expect(handleRpc('scratchSearch', root, { query: '  ' })).rejects.toMatchObject({ status: 400 });
  });

  test('scratchMentions names captured paths the text mentions', async () => {
    const res = await handleRpc('scratchMentions', root, { text: 'Draft at $LAZY_SCRATCH_DIR/review/accept-foo.md.' }) as any;
    expect(res.paths).toEqual(['review/accept-foo.md']);
  });
});
