/**
 * The legacy store-root proxy audit log is cleaned up on daemon start.
 *
 * Older versions appended the proxy audit stream to `<store>/proxy-audit.jsonl`
 * with no cap; one real store grew a 677 MiB blob that broke a `git push`. The
 * daemon removes that file on startup and logs what went away.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { storageDirFor } from '../helpers/storage';
import { AUDIT_LOG_FILENAME } from '../../src/proxy/audit-log';
import { projectSlug, LOG_FILE } from '../../src/daemon/paths';

describe('legacy proxy audit log cleanup on daemon start', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-audit-prune-'));
    daemonBaseDir = await makeDaemonBaseDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
    await removeDaemonBaseDir(daemonBaseDir);
  });

  /** Pin `[server] port` to a port the OS just reported free. */
  async function pinFreeServerPort(projectRoot: string): Promise<void> {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('p') });
    const port = probe.port!;
    probe.stop(true);
    const configPath = join(projectRoot, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    const updated = existing.replace(/^port\s*=\s*\d+/m, `port = ${port}`);
    expect(updated).not.toBe(existing);
    await writeFile(configPath, updated);
  }

  const env = () => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBaseDir,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
    CLAUDE_CODE_OAUTH_TOKEN: '',
  });

  /** Seed an oversized pre-move audit log at the store root. */
  async function seedLegacyLog(): Promise<string> {
    const legacyPath = join(storageDirFor(ctx.root), AUDIT_LOG_FILENAME);
    await writeFile(legacyPath, 'x'.repeat(2 * 1024 * 1024));
    expect((await stat(legacyPath)).size).toBeGreaterThan(0);
    return legacyPath;
  }

  test('daemon start removes it and says so', async () => {
    await pinFreeServerPort(ctx.root);
    const legacyPath = await seedLegacyLog();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);
    try {
      expect(await stat(legacyPath).catch(() => null)).toBeNull();
      // Removing data silently would violate the no-hidden-side-effects rule in
      // CLAUDE.md — the daemon must name the file and the size it dropped.
      const daemonLog = await readFile(
        join(daemonBaseDir, projectSlug(ctx.root), LOG_FILE),
        'utf-8',
      );
      expect(daemonLog).toContain('Removed the legacy proxy audit log');
      expect(daemonLog).toContain(legacyPath);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });

  // INVARIANT: the cleanup is NOT gated on anything about the proxy's current
  // configuration. It removes a file a PREVIOUS version wrote, so the proxy's
  // present state is irrelevant — gating it would strand the oversized blob
  // forever while `lazy doctor` told the user to restart the daemon to remove
  // it. (This used to be written as `[proxy] enabled = false`; that option was
  // removed, so the section now carries an unrelated explicit setting.)
  test('runs regardless of the [proxy] settings in lazy.toml', async () => {
    await pinFreeServerPort(ctx.root);
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    // The init template mentions [proxy] only in comments (the proxy is always
    // on with no config), so appending a real section is not a
    // duplicate-key error here.
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(configPath, `${before}\n[proxy]\nbind = "127.0.0.1"\n`);

    const legacyPath = await seedLegacyLog();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);
    try {
      expect(await stat(legacyPath).catch(() => null)).toBeNull();
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
