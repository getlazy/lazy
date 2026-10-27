/** Real cleanup, Storage, git and DockerRunner. Only the runtime CLI is fake. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinConfig } from '../helpers/pin-config';
import { FileStorage } from '../../src/storage/file-storage';
import { runAcceptFollowThrough } from '../../src/daemon/task-lifecycle';
import { ACCEPT_FOLLOWTHROUGH_KEY, FOLLOWTHROUGH_STEPS } from '../../src/daemon/accept-intent';
import { loadConfig } from '../../src/config/loader';
import { TerminalCleanupManager } from '../../src/daemon/terminal-cleanup';
import { getWorktreePath, taskRef } from '../../src/task/identity';
import { acquireLock, removeLock } from '../../src/utils/lock';
import { memberHomesDir } from '../../src/daemon/member-container';
import { claimMemberTerminal, markMemberTerminalEntered, resetMemberTerminalsForTests } from '../../src/server/member-terminals';

// INVARIANT: terminal cleanup must prove environment removal before removing
// its mounted files; a runtime's logged failure is not a successful teardown.
describe('finished-task resources on disk', () => {
  let ctx: TestContext, storage: FileStorage, manager: TerminalCleanupManager, unpin: () => void;
  let dir: string, path: string, taskId: string, runName: string, savedPath: string | undefined;
  let savedTest: string | undefined;
  beforeEach(async () => {
    ctx = await setupTestLazy(); unpin = pinConfig(ctx.root);
    // This drives daemon-owned code in-process, with no agent/model launch.
    savedTest = process.env.LAZY_TEST; process.env.LAZY_TEST = '1';
    storage = new FileStorage(ctx.root, { basePath: join(storageDirFor(ctx.root), 'cleanup-test-store') }); await storage.initialize();
    const task = await storage.createTask('Finished', undefined, undefined, 'closed'); taskId = task.id;
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/closed', '');
    await storage.updateSessionRunnerType(session.id, 'docker');
    runName = `lazy-${taskRef(task)}`;
    await storage.updateSessionContainerName(session.id, runName);
    await storage.updateTaskStatus(task.id, 'abandoned', 'human');
    path = getWorktreePath(ctx.root, task);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'large-file'), 'x'.repeat(32768));
    dir = join(ctx.root, 'fake-cleanup-runtime'); await mkdir(dir);
    await writeFile(join(dir, 'docker'), `#!/usr/bin/env bun
import { existsSync, appendFileSync, unlinkSync } from 'fs';
const dir = ${JSON.stringify(dir)}, name = ${JSON.stringify(runName)}, id = ${JSON.stringify(taskId)};
const argv = process.argv.slice(2); appendFileSync(dir+'/calls', argv.join(' ')+'\\n');
let exists = existsSync(dir+'/environment');
if (argv[0] === 'inspect' && existsSync(dir+'/removing')) {
  if (existsSync(dir+'/fail-probe')) { console.error('daemon unavailable'); process.exit(1); }
  if (existsSync(dir+'/stuck-removal')) { console.log('true'); process.exit(0); }
  if (existsSync(dir+'/probed-removing')) { unlinkSync(dir+'/environment'); unlinkSync(dir+'/removing'); exists = false; }
  else appendFileSync(dir+'/probed-removing', '1');
}
if (argv[0] === 'ps') {
  if (exists && !argv.join(' ').includes('label=lazy.member-terminal')) console.log(name);
} else if (argv[0] === 'inspect') {
  if (!exists) { console.error('Error: No such container: '+name); process.exit(1); }
  console.log('true 0 0001-01-01T00:00:00Z false');
} else if (argv[0] === 'rm') {
  if (existsSync(dir+'/fail-removal')) { console.error('permission denied removing container'); process.exit(1); }
  if (existsSync(dir+'/removal-in-progress')) {
    appendFileSync(dir+'/removing', '1');
    console.error('Error response from daemon: removal of container '+name+' is already in progress'); process.exit(1);
  }
  if (exists) unlinkSync(dir+'/environment');
}
`);
    await chmod(join(dir, 'docker'), 0o755);
    savedPath = process.env.PATH; process.env.PATH = `${dir}:${savedPath}`;
    manager = new TerminalCleanupManager(storage, ctx.root);
  });
  afterEach(async () => {
    resetMemberTerminalsForTests();
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (ctx) await rm(memberHomesDir(ctx.root), { recursive: true, force: true });
    await storage?.close(); unpin?.(); await ctx?.cleanup();
    if (savedTest === undefined) delete process.env.LAZY_TEST; else process.env.LAZY_TEST = savedTest;
  });
  async function exists(p: string) { try { await stat(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

  test('Free space measures and removes a finished worktree through the standard cleanup', async () => {
    const view = await manager.view();
    expect(view.items.find(i => i.kind === 'worktree')!.bytes).toBeGreaterThan(0);
    await manager.run('Free space', view.plan.id);
    expect(await exists(path)).toBe(false);
    const restarted = new TerminalCleanupManager(storage, ctx.root);
    expect((await restarted.view()).lastRun!.removed.map(i => i.kind)).toEqual(['worktree']);
  });

  test('a failed container removal stays visible and retains its files and saved name', async () => {
    await writeFile(join(dir, 'environment'), '1'); await writeFile(join(dir, 'fail-removal'), '1');
    await manager.run();
    expect(await exists(path)).toBe(true);
    expect((await storage.getSessionByTaskId(taskId))!.container_name).toBe(runName);
    expect((await manager.view()).failures[0].error).toContain('permission denied removing container');
    await rm(join(dir, 'fail-removal'));
    await manager.run();
    expect(await exists(path)).toBe(false);
    expect((await storage.getSessionByTaskId(taskId))!.container_name).toBeNull();
    expect((await manager.view()).failures).toEqual([]);
    expect((await readFile(join(dir, 'calls'), 'utf8'))).toContain(`rm -f ${runName}`);
  });

  // INVARIANT: a concurrent Docker removal is successful accept cleanup only
  // after the environment is gone; no retry remains owed to the person.
  test('accept cleanup waits for an in-progress removal and leaves nothing pending', async () => {
    await storage.updateTaskStatus(taskId, 'blocked', 'human');
    await storage.updateTaskStatus(taskId, 'merging', 'human');
    await storage.updateTaskStatus(taskId, 'complete', 'system');
    const record = {
      targetBranch: 'main', viaForge: false, pushParent: false,
      done: FOLLOWTHROUGH_STEPS.filter(s => s !== 'cleanup'), attempts: 0,
    };
    await storage.updateTaskMetadata(taskId, ACCEPT_FOLLOWTHROUGH_KEY, JSON.stringify(record));
    await writeFile(join(dir, 'environment'), '1');
    await writeFile(join(dir, 'removal-in-progress'), '1');
    const result = await runAcceptFollowThrough(ctx.root, taskId, {
      storage, config: await loadConfig(ctx.root), driver: {} as any,
    });
    expect(result.pending).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(await exists(join(dir, 'probed-removing'))).toBe(true);
    expect(await exists(join(dir, 'environment'))).toBe(false);
    expect(await exists(path)).toBe(false);
    expect((await storage.getSessionByTaskId(taskId))!.container_name).toBeNull();
    expect((await storage.getTask(taskId))!.metadata![ACCEPT_FOLLOWTHROUGH_KEY]).toBe('');
  });

  // INVARIANT: an in-progress removal never permits deleting mounted files
  // when Docker cannot confirm absence, or when the removal never completes.
  for (const failure of ['fail-probe', 'stuck-removal']) {
    test(`concurrent removal preserves files when ${failure}`, async () => {
      await writeFile(join(dir, 'environment'), '1');
      await writeFile(join(dir, 'removal-in-progress'), '1');
      await writeFile(join(dir, failure), '1');
      await manager.run();
      expect(await exists(path)).toBe(true);
      expect((await storage.getSessionByTaskId(taskId))!.container_name).toBe(runName);
      expect((await manager.view()).failures[0].error).toContain(
        failure === 'fail-probe' ? 'daemon unavailable' : 'did not finish within 10s',
      );
    }, 20_000);
  }

  test('a live worktree lock and an open member session never enter the removal plan', async () => {
    await acquireLock(path, 'test live lock');
    expect((await manager.view()).plan.items).toEqual([]);
    expect((await manager.view()).items[0].blockedReason).toContain('lock');
    await removeLock(path);
    expect(claimMemberTerminal(taskId, 'member@example.com', async () => {}).ok).toBe(true);
    markMemberTerminalEntered(taskId, 'member@example.com');
    const view = await manager.view();
    expect(view.plan.items).toEqual([]);
    await manager.run('Free space', view.plan.id);
    expect(await exists(path)).toBe(true);
  });

  test('a member home whose conversation cannot be saved remains visible and protects the worktree', async () => {
    const home = join(memberHomesDir(ctx.root), `lazymember-${taskId.slice(0, 8)}-leftover`);
    await mkdir(home, { recursive: true }); await writeFile(join(home, 'conversation.txt'), 'valuable conversation');
    await manager.run();
    expect(await exists(path)).toBe(true); expect(await exists(home)).toBe(true);
    const view = await manager.view();
    expect(view.failures[0].item.kind).toBe('member-environment');
    expect(view.failures[0].error).toContain('conversation');
    expect(view.items.find(i => i.kind === 'member-environment')!.bytes).toBeGreaterThan(0);
  });
});
