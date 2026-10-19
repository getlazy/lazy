/**
 * A real daemon and a repository plugin with an observable import-time side
 * effect: no daemon imports it, managed or single-user.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdir, writeFile, readFile, stat, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { getLogPath, getDaemonDir } from '../../src/daemon/paths';

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function daemonOutput(root: string): Promise<string> {
  const parts = await Promise.all([
    readFile(getLogPath(root), 'utf8').catch(() => ''),
    readFile(join(getDaemonDir(root), 'test-startup.log'), 'utf8').catch(() => ''),
  ]);
  return parts.join('\n');
}

async function waitFor(check: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

describe('repository plugins and the daemon', () => {
  let ctx: TestContext;
  let markerDir: string;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 'lazy-plugin-marker-'));
  });

  afterEach(async () => {
    await ctx?.cleanup();
    await rm(markerDir, { recursive: true, force: true });
  });

  async function installPlugin(root: string): Promise<string> {
    const marker = join(markerDir, 'imported.marker');
    const dir = join(root, '.lazy', 'plugins');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'side-effect.ts'),
      `import { writeFileSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
        `export default { name: 'side-effect', transformRequest: () => null };\n`,
    );
    return marker;
  }

  // INVARIANT: a managed (Teams) daemon never runs repository plugin code in
  // its own process — that process holds every member's credentials.
  test('managed daemon starts with a plugin present and never imports it', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const marker = await installPlugin(ctx.root);
    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    expect(
      await waitFor(async () => (await daemonOutput(ctx.root)).includes('Repository plugins (.lazy/plugins) are not run')),
    ).toBe(true);
    expect(await exists(marker)).toBe(false);
  }, 60000);

  // INVARIANT: a single-user daemon does not run them either — no repository
  // code runs inside lazy's own process on the host, in any mode (engineer,
  // 2026-10-10: "accept or no accept"). The log says so and names the file.
  test('solo daemon starts with a plugin present and never imports it', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const marker = await installPlugin(ctx.root);
    await ctx.restartDaemon();
    expect(
      await waitFor(async () => (await daemonOutput(ctx.root)).includes('ignored: side-effect.ts')),
    ).toBe(true);
    expect(await exists(marker)).toBe(false);
  }, 60000);
});
