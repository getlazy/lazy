import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { checkDaemonHealth } from '../../src/daemon';
import { getWebPortPath, getWebHostPath, getTokenPath, getPidPath, getDaemonDir } from '../../src/daemon/paths';
import { webOffLine } from '../../src/daemon/dashboard-availability';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('checkDaemonHealth carries the explicit managed field', () => {
  const root = '/tmp/lazy-managed-field-project';
  let baseDir: string;
  let unpin: () => void;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getTokenPath(root), 'test-token');
    await writeFile(getPidPath(root), String(process.pid));
  });

  afterEach(async () => {
    server?.stop(true);
    server = null;
    unpin();
    await removeDaemonBaseDir(baseDir);
  });

  async function statusFor(payload: Record<string, unknown>) {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ projectRoot: root, ...payload }) });
    await writeFile(getWebPortPath(root), String(server.port));
    await writeFile(getWebHostPath(root), '127.0.0.1');
    return checkDaemonHealth(root);
  }

  // INVARIANT: a managed daemon says so explicitly; the CLI never guesses why
  // dashboardUrl is null. Only an unmanaged daemon without a URL is "degraded".
  test('managed daemon: Web line says Lazy Teams serves the UI', async () => {
    const status = await statusFor({ dashboardUrl: null, managed: true });
    expect(status.managed).toBe(true);
    expect(webOffLine(status)).toBe('off (Lazy Teams serves the UI)');
  });

  test('unmanaged or older daemon without a URL stays degraded', async () => {
    const unmanaged = await statusFor({ dashboardUrl: null, managed: false });
    expect(unmanaged.managed).toBe(false);
    expect(webOffLine(unmanaged)).toContain('not bound (degraded');
    server?.stop(true);
    const older = await statusFor({ dashboardUrl: null });
    expect(older.managed).toBeUndefined();
    expect(webOffLine(older)).toContain('not bound (degraded');
  });
});
