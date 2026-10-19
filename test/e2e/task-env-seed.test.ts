/**
 * `taskEnvSeed` — the environment every NEW task starts with
 * (src/daemon/task-env-seed.ts). A control plane cannot push a task's
 * environment before a launch it did not start (a cluster's `lazy_start`, the
 * builder, the CLI), so the daemon gives every task the seed at creation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { getTaskEnvPath, getTaskEnvSeedPath, getTaskFilesPath } from '../../src/daemon/paths';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';

describe('taskEnvSeed (new-task environment)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    const paths = [getTaskEnvSeedPath(ctx.root), getTaskEnvPath(ctx.root), getTaskFilesPath(ctx.root)];
    await ctx.cleanup();
    for (const p of paths) await rm(p, { force: true });
  });

  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const client = await DaemonClient.create(ctx.root);
    if (!client) throw new Error('test daemon is not running');
    return await client.rpc(method, ctx.root, params);
  }

  // INVARIANT: a task created by ANY surface after the seed was set has the
  // seed's variables and files in its own set before anything can launch it.
  // Teams cannot win the race against a create-then-start it did not make.
  test('a task created after the seed is set starts with it; earlier tasks are untouched', async () => {
    const before = await createTask(ctx, 'Before the seed', 'p');
    const set = await rpc('taskEnvSeed', {
      action: 'set',
      vars: { STRIPE_KEY: 'sk-seed-value-123456789' },
      files: [{ path: 'config/secret.env', contents: 'A=b-seeded-file-value\n' }],
    });
    expect(set).toEqual({ keys: ['STRIPE_KEY'], paths: ['config/secret.env'] });
    // No value ever comes back.
    expect(JSON.stringify(await rpc('taskEnvSeed', { action: 'list' }))).not.toContain('sk-seed-value');

    const after = await createTask(ctx, 'After the seed', 'p');
    expect((await rpc('taskEnv', { action: 'list', taskId: after })).keys).toEqual(['STRIPE_KEY']);
    expect((await rpc('taskFiles', { action: 'list', taskId: after })).paths).toEqual(['config/secret.env']);
    expect((await rpc('taskEnv', { action: 'list', taskId: before })).keys).toEqual([]);
  });

  // INVARIANT: the seed is validated like a task's own set, at push time.
  test('a reserved key is refused when the seed is pushed', async () => {
    let err: unknown;
    try {
      await rpc('taskEnvSeed', { action: 'set', vars: { ANTHROPIC_API_KEY: 'x' } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RpcApplicationError);
    expect(String((err as Error).message)).toContain('reserved');
  });
});
