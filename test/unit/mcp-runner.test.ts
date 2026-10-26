/**
 * Unit test: the MCP `lazy_create` and `lazy_start` runner param.
 *
 * lazy_create persists a per-task runner override; both tools accept the
 * friendly aliases (host/docker/container/podman) and reject invalid values
 * with an actionable error.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { testStorageOptions } from '../helpers/storage';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';

isolateLazyEnv();


/** Teams' environment: managed, a foreign docker host, and a vendored smolvm. */
async function inManagedMode<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['LAZY_MANAGED', 'LAZY_FOREIGN_DOCKER_HOST', 'LAZY_SMOLVM_BINARY'] as const;
  const prior = keys.map((k) => process.env[k]);
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_FOREIGN_DOCKER_HOST = '1';
  process.env.LAZY_SMOLVM_BINARY = '/opt/lazy/smolvm/smolvm';
  try { return await fn(); }
  finally { keys.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; }); }
}

describe('MCP runner override', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-runner-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, testStorageOptions(testDir));
    ctx = { taskId: '', worktreePath: testDir, storage };
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test('lazy_create with runner: host is rejected', async () => {
    const handlers = createAllHandlers(ctx);
    await expect(handlers.get('lazy_create')!({ goal: 'Host task', runner: 'host' }))
      .rejects.toThrow('Host-process runner is no longer supported');
  });

  test('lazy_create with runner: smolvm is refused in managed mode before any write', async () => {
    // INVARIANT: Teams never runs the smolvm runner; a per-task override is refused and nothing is stored.
    const handlers = createAllHandlers(ctx);
    await inManagedMode(async () => { await expect(handlers.get('lazy_create')!({ goal: 'VM task', runner: 'smolvm' }))
      .rejects.toThrow(/not available on Lazy Teams/); });
    const list = await handlers.get('lazy_list')!({});
    expect((list as any).count).toBe(0);
  });

  test('lazy_create with runner: container maps to docker', async () => {
    const handlers = createAllHandlers(ctx);
    const result = await handlers.get('lazy_create')!({ goal: 'Container task', runner: 'container' });

    expect((result as any).runner).toBe('docker');
    const task = await storage.getTask((result as any).full_id);
    expect(task?.runner_type).toBe('docker');
  });

  test('lazy_create with no runner inherits the global default (null on the task)', async () => {
    const handlers = createAllHandlers(ctx);
    const result = await handlers.get('lazy_create')!({ goal: 'Default task' });

    expect((result as any).runner).toBeNull();
    const task = await storage.getTask((result as any).full_id);
    expect(task?.runner_type).toBeNull();
  });

  test('lazy_create rejects an invalid runner before creating the task', async () => {
    const handlers = createAllHandlers(ctx);
    await expect(handlers.get('lazy_create')!({ goal: 'Bad runner', runner: 'vm' })).rejects.toThrow(/Invalid runner/);

    // The task must NOT have been created (validation happens before any write).
    const list = await handlers.get('lazy_list')!({});
    expect((list as any).count).toBe(0);
  });
});
