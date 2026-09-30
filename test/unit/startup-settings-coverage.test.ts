import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { STARTUP_SETTINGS } from '../../src/daemon/config-status';

describe('startup-only settings list', () => {
  // INVARIANT: every lazy.toml key the daemon reads from its startup config is
  // listed in STARTUP_SETTINGS. A startup read that is not listed is a setting
  // `lazy daemon status` never reports as pending — the silence the list exists
  // to end (a dashboard URL still served from a branch's lazy.toml).
  test('every startupConfig.<section>.<key> read in the daemon server is listed', async () => {
    const source = await readFile(join(import.meta.dir, '../../src/daemon/server.ts'), 'utf-8');
    const read = new Set([...source.matchAll(/startupConfig\.([a-z_]+)\.([a-z_]+)/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(read.size).toBeGreaterThan(0);
    const listed = new Set(STARTUP_SETTINGS.map((s) => s.key));
    expect([...read].filter((key) => !listed.has(key))).toEqual([]);
  });
});
