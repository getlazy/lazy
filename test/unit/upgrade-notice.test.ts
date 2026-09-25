/**
 * The daemon upgrade notice — the built-in system-message producer.
 *
 * INVARIANT: the last-seen version marker lives in the DAEMON's per-project
 * state dir (with the pidfile/token/log), NEVER in the repo's `.lazy/` — user
 * projects may commit parts of `.lazy/`, and an unignored marker there dirtied
 * every worktree a daemon start touched (broke `lazy_commit`'s clean-worktree
 * behavior in the wild). The marker-location assertion below is load-bearing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { maybePostUpgradeNotice } from '../../src/daemon/upgrade-notice';
import { getDaemonDir } from '../../src/daemon/paths';
import { VERSION } from '../../src/version';

describe('daemon upgrade notice', () => {
  let testDir: string;
  let baseDir: string;
  let storage: Storage;
  let savedBaseDir: string | undefined;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-upgrade-notice-'));
    baseDir = mkdtempSync(join(tmpdir(), 'lazy-upgrade-notice-daemon-'));
    savedBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;

    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
  });

  afterEach(async () => {
    if (savedBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = savedBaseDir;
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  const markerPath = () => join(getDaemonDir(testDir), 'daemon-last-version.json');

  test('first start records the version silently — no message', async () => {
    await maybePostUpgradeNotice(testDir, async () => storage);

    expect(await storage.listSystemMessages()).toHaveLength(0);
    expect(existsSync(markerPath())).toBe(true);
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8')).version).toBe(VERSION);
  });

  test('a version change files ONE notice and updates the marker', async () => {
    mkdirSync(getDaemonDir(testDir), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ version: '0.0.1-previous' }));

    await maybePostUpgradeNotice(testDir, async () => storage);

    const messages = await storage.listSystemMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].source).toBe('daemon');
    expect(messages[0].kind).toBe('notice');
    expect(messages[0].title).toContain('0.0.1-previous');
    expect(messages[0].title).toContain(VERSION);
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8')).version).toBe(VERSION);

    // A second start with the SAME version is quiet — one upgrade, one notice.
    await maybePostUpgradeNotice(testDir, async () => storage);
    expect(await storage.listSystemMessages()).toHaveLength(1);
  });

  test('a corrupt marker is treated as first start — re-record, no fabricated notice', async () => {
    mkdirSync(getDaemonDir(testDir), { recursive: true });
    writeFileSync(markerPath(), 'not json at all');

    await maybePostUpgradeNotice(testDir, async () => storage);

    expect(await storage.listSystemMessages()).toHaveLength(0);
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8')).version).toBe(VERSION);
  });

  // The load-bearing location assertion — see the header comment.
  test('the marker is NOT written into the repo .lazy/', async () => {
    await maybePostUpgradeNotice(testDir, async () => storage);
    expect(existsSync(join(testDir, '.lazy', 'daemon-last-version.json'))).toBe(false);
  });
});
