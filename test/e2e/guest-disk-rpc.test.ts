import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { mkdir, stat, writeFile } from 'fs/promises';
import { getOrCreateStorage } from '../../src/daemon/rpc-handlers';
import { getWorktreePath } from '../../src/task/identity';
import { acquireLock, removeLock } from '../../src/utils/lock';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { mintDaemonToken } from '../../src/daemon/actor-tokens';
import { clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { DiskSpaceManager, setDiskSpaceManager, type EngineDiskUsage } from '../../src/docker/disk-space';
import { FileStorage } from '../../src/storage/file-storage';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { storageDirFor } from '../helpers/storage';

isolateInProcessDaemonEnv();
const TOKEN = 'guest-disk-control';

describe('guest disk control-plane RPC', () => {
  let ctx: TestContext, daemon: RunningDaemon, storage: FileStorage;
  let restoreConfig: () => void, restoreBase: () => void, base: string;
  let savedEnv: Record<string, string | undefined>;
  let data: EngineDiskUsage;
  let commands: string[][];
  let inventoryFailure: boolean;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    savedEnv = Object.fromEntries(['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', 'LAZY_MANAGED_BACKEND'].map(key => [key, process.env[key]]));
    base = await makeDaemonBaseDir();
    restoreBase = pinDaemonBaseDir(base);
    clearMcpTokenCache();
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = storageDirFor(ctx.root);
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    storage = new FileStorage(ctx.root, { basePath: join(ctx.root, 'fake-guest-store') });
    await storage.initialize();
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
    data = { Images: [], BuildCache: [], LayersSize: 0, Containers: [
      { Id: 'a'.repeat(64), Names: ['/unused'], ImageID: 'b'.repeat(64), State: 'exited', Labels: { 'lazy.project': ctx.root }, SizeRw: 100 },
    ] };
    commands = [];
    inventoryFailure = false;
    setDiskSpaceManager(new DiskSpaceManager(storage, ctx.root, {
      inventory: async () => {
        if (inventoryFailure) throw new Error('Docker inventory failed: no space left on device');
        return structuredClone(data);
      }, filesystem: async () => ({ totalBytes: 32 * 1024 ** 3, freeBytes: 1024 ** 3 }),
      buildsRunning: () => 0, command: async args => { commands.push(args); },
    }));
  });

  afterEach(async () => {
    await daemon?.stop();
    setDiskSpaceManager(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    clearMcpTokenCache();
    await storage?.close();
    restoreConfig?.();
    await ctx?.cleanup();
    restoreBase?.();
    await removeDaemonBaseDir(base);
  });

  async function rpc(command: string, params = {}, token = TOKEN) {
    const response = await fetch(`http://127.0.0.1:${daemon.webPort}/rpc/${command}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Lazy-Project': ctx.root },
      body: JSON.stringify(params),
    });
    return { status: response.status, body: await response.json() as any };
  }

  test('control plane previews removals, rejects a stale plan and records confirmed reclaim', async () => {
    const preview = await rpc('diskSpace');
    expect(preview.status).toBe(200);
    expect(preview.body.plan.items.map((i: any) => i.name)).toEqual(['unused']);
    data.Containers[0].State = 'running';
    expect((await rpc('reclaimDiskSpace', { planId: preview.body.plan.id })).status).toBe(409);
    expect(commands).toEqual([]);
    data.Containers[0].State = 'exited';
    expect((await rpc('reclaimDiskSpace', { planId: preview.body.plan.id })).status).toBe(200);
    expect(commands).toEqual([['container', 'rm', 'a'.repeat(64)]]);
    expect((await rpc('diskSpace')).body.lastRecovery.reason).toBe('Free space');
  });

  // INVARIANT: admin-confirmed cleanup uses only fresh terminal-task findings;
  // a live lock acquired after preview must invalidate that removal plan.
  test('control-plane Free space includes measured finished worktrees and rejects newly locked files', async () => {
    const owned = await getOrCreateStorage();
    const task = await owned.createTask('Closed task files', undefined, undefined, 'closed-files');
    await owned.updateTaskStatus(task.id, 'abandoned', 'human');
    const path = getWorktreePath(ctx.root, task);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'build-output'), 'x'.repeat(16384));
    const preview = await rpc('diskSpace');
    const item = preview.body.plan.items.find((i: any) => i.kind === 'worktree');
    expect(item.taskCode).toBe('closed-files');
    expect(item.bytes).toBeGreaterThan(0);
    await acquireLock(path, 'live cleanup test lock');
    try {
      expect((await rpc('reclaimDiskSpace', { planId: preview.body.plan.id })).status).toBe(409);
      expect((await stat(path)).isDirectory()).toBe(true);
      expect((await rpc('diskSpace')).body.terminalCleanup.items[0].blockedReason).toContain('lock');
    } finally { await removeLock(path); }
    const fresh = await rpc('diskSpace');
    expect((await rpc('reclaimDiskSpace', { planId: fresh.body.plan.id })).status).toBe(200);
    await expect(stat(path)).rejects.toHaveProperty('code', 'ENOENT');
    const result = await rpc('diskSpace');
    expect(result.body.terminalCleanup.lastRun.removed[0].taskCode).toBe('closed-files');
  });

  test('finished-task cleanup state cannot be overwritten through the storage RPC', async () => {
    expect((await rpc('storage.saveTerminalCleanupState', { failures: [] })).status).toBe(404);
    expect((await rpc('storage.getTerminalCleanupState')).status).toBe(404);
  });

  // INVARIANT: broken Docker inventory cannot hide an exhaustion request from
  // the fleet; growing the disk may be what makes the engine answer again.
  test('durable growth status remains readable when engine inventory fails', async () => {
    await storage.saveDiskSpaceState({ needsGrowth: true, images: [], lastRecovery: null });
    inventoryFailure = true;
    expect((await rpc('diskSpace')).status).toBe(500);
    const recovery = await rpc('diskSpace', { recoveryOnly: true });
    expect(recovery.status).toBe(200);
    expect(recovery.body).toMatchObject({ supported: true, needsGrowth: true });
  });

  test('growth acknowledgement cannot erase a newer exhaustion request', async () => {
    await storage.saveDiskSpaceState({ needsGrowth: true, growthGeneration: 4, images: [], lastRecovery: null });
    const observed = await rpc('diskSpace', { recoveryOnly: true });
    await storage.saveDiskSpaceState({ needsGrowth: true, growthGeneration: 5, images: [], lastRecovery: null });
    expect((await rpc('acknowledgeDiskGrowth', { growthGeneration: observed.body.growthGeneration })).body.acknowledged).toBe(false);
    expect((await rpc('diskSpace', { recoveryOnly: true })).body.needsGrowth).toBe(true);
    expect((await rpc('acknowledgeDiskGrowth')).status).toBe(400);
    expect((await rpc('acknowledgeDiskGrowth', { growthGeneration: 5 })).body.acknowledged).toBe(true);
    expect((await rpc('diskSpace', { recoveryOnly: true })).body.needsGrowth).toBe(false);
  });

  // INVARIANT: only the fleet control plane can reclaim Docker space or clear
  // exhaustion. A member token must not gain host controls through raw RPC.
  test('user and agent tokens cannot use disk controls or the recovery state writer', async () => {
    const member = await mintDaemonToken(ctx.root, { kind: 'user', email: 'member@example.com' }, 'member');
    const agent = await mintDaemonToken(ctx.root, { kind: 'builder' }, 'builder');
    for (const command of ['diskSpace', 'reclaimDiskSpace', 'acknowledgeDiskGrowth']) {
      expect((await rpc(command, { planId: 'anything', needsGrowth: false }, member)).status).toBe(403);
      expect((await rpc(command, {}, agent)).status).toBe(401);
    }
    // The state backend is deliberately unavailable over generic storage RPC,
    // including to control: only acknowledgeDiskGrowth clears exhaustion.
    expect((await rpc('storage.saveDiskSpaceState', { needsGrowth: false })).status).toBe(404);
    expect((await rpc('storage.saveDiskSpaceState', { needsGrowth: false }, member)).status).toBe(404);
    expect(commands).toEqual([]);
  });
});
