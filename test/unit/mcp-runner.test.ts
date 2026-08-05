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
import { spawnSync } from '../../src/utils/spawn';

describe('MCP runner override', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-runner-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test('lazy_create with runner: host persists the host runner on the task', async () => {
    const handlers = createAllHandlers(ctx);
    const result = await handlers.get('lazy_create')!({ goal: 'Host task', runner: 'host' });

    expect((result as any).runner).toBe('dangerously-host-process-without-any-isolation');
    const task = await storage.getTask((result as any).full_id);
    expect(task?.runner_type).toBe('dangerously-host-process-without-any-isolation');
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
