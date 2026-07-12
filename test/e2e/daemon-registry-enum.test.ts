/**
 * Unit-level tests for the daemon registry (src/daemon/registry.ts) — the
 * host-wide enumeration that powers `lazy daemon list/kill-stray`.
 *
 * These run in-process and drive the registry directly via the
 * `LAZY_DAEMON_BASE_DIR` override, so they exercise classification logic
 * (stray vs live-root vs dead vs unknown-root) without spawning the CLI.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { enumerateDaemons, writeDaemonRoot } from '../../src/daemon/registry';
import { getRootPath, getDaemonDir } from '../../src/daemon/paths';

describe('daemon registry enumeration', () => {
  let baseDir: string;
  let prevBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-reg-base-')));
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
  });

  afterEach(async () => {
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  async function fab(slug: string, pid: number, root: string | null): Promise<void> {
    const dir = join(baseDir, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lazy.pid'), String(pid));
    if (root !== null) await writeFile(join(dir, 'root'), root);
  }

  test('returns [] when the base dir does not exist', async () => {
    await rm(baseDir, { recursive: true, force: true });
    expect(await enumerateDaemons()).toEqual([]);
  });

  test('writeDaemonRoot writes the root marker enumerate reads back', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-proj-')));
    // The marker lands in the slug dir for this root; the dir must exist first.
    await mkdir(getDaemonDir(projectRoot), { recursive: true });
    await writeDaemonRoot(projectRoot);
    // A live pid so the record is considered a running daemon.
    await writeFile(join(getDaemonDir(projectRoot), 'lazy.pid'), String(process.pid));

    const records = await enumerateDaemons();
    const rec = records.find(r => r.projectRoot === projectRoot);
    expect(rec).toBeDefined();
    expect(rec!.rootKnown).toBe(true);
    expect(rec!.rootExists).toBe(true);
    expect(rec!.stray).toBe(false);
    expect(existsSync(getRootPath(projectRoot))).toBe(true);

    await rm(projectRoot, { recursive: true, force: true });
  });

  test('classifies stray, live-root, dead-pid, and unknown-root daemons', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-')));
    const goneRoot = await mkdtemp(join(tmpdir(), 'lazy-gone-'));
    await rm(goneRoot, { recursive: true, force: true });

    await fab('live-1', process.pid, liveRoot);   // alive + root exists
    await fab('stray-1', process.pid, goneRoot);  // alive + root gone  → stray
    await fab('dead-1', 2 ** 22, '/tmp/whatever'); // dead pid          → not alive
    await fab('unknown-1', process.pid, null);    // alive + no root file

    const bySlug = Object.fromEntries((await enumerateDaemons()).map(r => [r.slug, r]));

    expect(bySlug['live-1'].alive).toBe(true);
    expect(bySlug['live-1'].stray).toBe(false);

    expect(bySlug['stray-1'].alive).toBe(true);
    expect(bySlug['stray-1'].stray).toBe(true);

    expect(bySlug['dead-1'].alive).toBe(false);
    expect(bySlug['dead-1'].stray).toBe(false);

    // INVARIANT: a live daemon with an UNKNOWN root is never classified stray —
    // we can't prove its root is gone, so kill-stray must leave it alone.
    expect(bySlug['unknown-1'].alive).toBe(true);
    expect(bySlug['unknown-1'].rootKnown).toBe(false);
    expect(bySlug['unknown-1'].stray).toBe(false);

    await rm(liveRoot, { recursive: true, force: true });
  });
});
