import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isOfflineMode,
  setOfflineMode,
  getOfflineStatus,
  resolveOfflineStatus,
  formatOfflineExpiry,
} from '../../src/utils/offline';
import { nextLocalMidnight } from '../../src/utils/local-day';

describe('offline mode utils', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'lazy-offline-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const offlineFile = () => join(dataDir, 'offline.json');
  async function fileExists(p: string): Promise<boolean> {
    try { await access(p); return true; } catch { return false; }
  }

  test('no file means online', async () => {
    expect(await isOfflineMode(dataDir)).toBe(false);
  });

  test('enabling records an expiry at the next local midnight', async () => {
    await setOfflineMode(dataDir, true, 'github');
    const state = JSON.parse(await readFile(offlineFile(), 'utf-8'));
    expect(state.enabled).toBe(true);
    expect(state.configured_driver).toBe('github');
    // INVARIANT: `lazy system offline` is temporary — it must always stamp an
    // expiry equal to the next local midnight so it cannot strand the user
    // offline indefinitely.
    expect(state.expires_at).toBe(nextLocalMidnight().toISOString());
    expect(await isOfflineMode(dataDir)).toBe(true);
  });

  // INVARIANT: An expired temporary offline auto-recovers — isOfflineMode must
  // report ONLINE once the expiry passes, with no manual `lazy system online`.
  // This is the core fix for "I forgot to go back online".
  test('expired offline auto-recovers (reports online) and cleans up the file', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(offlineFile(), JSON.stringify({
      enabled: true,
      enabled_at: new Date(Date.now() - 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1s in the past
    }));

    expect(await isOfflineMode(dataDir)).toBe(false);
    // Stale file is cleaned up so we stop re-reading it.
    expect(await fileExists(offlineFile())).toBe(false);
  });

  test('unexpired offline reports offline', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(offlineFile(), JSON.stringify({
      enabled: true,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), // 1h ahead
    }));
    expect(await isOfflineMode(dataDir)).toBe(true);
  });

  // INVARIANT: Permanent offline lives in config. When the flag is set,
  // isOfflineMode is true regardless of the temporary file or its expiry, and
  // it is NOT subject to midnight auto-expiry.
  test('permanent config flag forces offline regardless of file/expiry', async () => {
    // No file at all → still offline because of the permanent flag.
    expect(await isOfflineMode(dataDir, true)).toBe(true);

    // An expired temporary file does NOT recover when permanent is set.
    await mkdir(dataDir, { recursive: true });
    await writeFile(offlineFile(), JSON.stringify({
      enabled: true,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(await isOfflineMode(dataDir, true)).toBe(true);
  });

  test('setOfflineMode(false) removes the file', async () => {
    await setOfflineMode(dataDir, true);
    expect(await fileExists(offlineFile())).toBe(true);
    await setOfflineMode(dataDir, false);
    expect(await fileExists(offlineFile())).toBe(false);
  });

  test('resolveOfflineStatus distinguishes temporary, permanent, and expired', async () => {
    // Permanent (config), no file.
    let s = await resolveOfflineStatus(dataDir, true);
    expect(s).toMatchObject({ offline: true, permanent: true, temporary: false });
    expect(formatOfflineExpiry(s)).toContain('permanent');

    // Temporary, unexpired.
    await setOfflineMode(dataDir, true, 'gitlab');
    s = await resolveOfflineStatus(dataDir, false);
    expect(s).toMatchObject({ offline: true, permanent: false, temporary: true });
    expect(s.configuredDriver).toBe('gitlab');
    expect(formatOfflineExpiry(s)).toContain('auto-resumes');
    expect(formatOfflineExpiry(s)).toContain('local');

    // Expired temporary → online.
    await writeFile(offlineFile(), JSON.stringify({
      enabled: true,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    s = await resolveOfflineStatus(dataDir, false);
    expect(s).toMatchObject({ offline: false, permanent: false, temporary: false });
  });

  // A malformed expiry must not silently strand the user; it is treated as
  // non-expiring (still offline) rather than guessing a boundary.
  test('legacy file with no expires_at stays offline (backward compat)', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(offlineFile(), JSON.stringify({ enabled: true }));
    expect(await isOfflineMode(dataDir)).toBe(true);
    const raw = await getOfflineStatus(dataDir);
    expect(raw.enabled).toBe(true);
    expect(raw.expires_at).toBeUndefined();
  });
});
