import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

/**
 * `show` reports WHERE one task's pieces live — the locations an operator needs
 * to troubleshoot it from a client that is not a shell on this host.
 *
 * `withDaemon` because this block is added by the RPC handler and not by
 * `loadTaskShowData`: it is deliberately absent from `lazy show`, whose reader
 * is already standing on the host. Only a real daemon call can see it.
 */
describe('daemon show RPC — task locations', () => {
  let ctx: TestContext;
  let target: string;
  let token: string;

  type Paths = {
    projectRoot: string;
    worktree: string;
    worktreeExists: boolean;
    storeRoot: string;
    taskDir: string;
  };

  async function showPaths(taskId: string): Promise<Paths> {
    const client = DaemonClient.fromTarget(target, token);
    const detail = await client.rpc('show', ctx.root, { taskId }) as { paths: Paths };
    return detail.paths;
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    token = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports the project root, worktree, store root and task directory', async () => {
    const taskId = await createTask(ctx, 'Locations: a task that has not started');

    const paths = await showPaths(taskId);

    expect(paths.projectRoot).toBe(ctx.root);
    expect(paths.worktree.startsWith(ctx.root)).toBe(true);
    expect(paths.worktree).toContain(join('.lazy', 'worktrees'));

    // INVARIANT: the store root comes from the Storage interface, not from an
    // assumed layout under the project. Test projects use EXTERNAL storage, so
    // a path inside the repo would mean the handler guessed rather than asked.
    expect(paths.storeRoot).toBeTruthy();
    expect(paths.storeRoot.startsWith(ctx.root)).toBe(false);

    // The task's own directory is under that store root and named by its FULL
    // id — a short id would send an operator to a directory that is not there.
    expect(paths.taskDir.startsWith(paths.storeRoot)).toBe(true);
    expect(paths.taskDir).toContain('tasks');
  });

  // A task that was never started has no worktree, and saying so is the point:
  // "not created" and "created but missing" are different diagnoses, and a page
  // that only printed a path could not tell them apart.
  test('states whether the worktree actually exists', async () => {
    const taskId = await createTask(ctx, 'Locations: worktree presence');

    const paths = await showPaths(taskId);
    expect(paths.worktreeExists).toBe(false);
  });

  // LOCATIONS, NEVER CONTENTS. This block names directories so an operator can
  // go and read them with their own credentials; it must never carry what is
  // in them, and nothing here is a credential.
  test('carries no file contents', async () => {
    const taskId = await createTask(ctx, 'Locations: paths only');

    const paths = await showPaths(taskId);
    for (const value of Object.values(paths)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toContain('\n');
    }
    expect(Object.keys(paths).sort()).toEqual(
      [ 'projectRoot', 'storeRoot', 'taskDir', 'worktree', 'worktreeExists' ],
    );
  });
});
