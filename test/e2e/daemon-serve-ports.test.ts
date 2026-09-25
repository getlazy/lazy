import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readProjectSettingsFile } from '../helpers/storage';
import { openSse, frameData } from '../helpers/sse';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

/**
 * `servePorts` — where a task's declared `[serve]` services are reachable — and
 * the `ports.changed` event that tells a subscriber to ask again.
 *
 * `withDaemon` because both halves only exist against a real daemon: the RPC is
 * a route on it, and the event is emitted as a side effect of a REAL storage
 * write made by an ordinary lifecycle path (src/daemon/event-tap.ts). Calling
 * either in-process would prove nothing about the surface a client sees.
 *
 * No docker is needed and none is used: the agent module mock the daemon runs
 * with reports every container as not running, which is exactly the state this
 * suite asserts on.
 */
describe('daemon servePorts RPC', () => {
  let ctx: TestContext;
  let target: string;
  let token: string;
  const open: Array<{ close: () => void }> = [];

  async function rpc(command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /** The status an RPC was refused with. Fails the test if it succeeded. */
  async function rpcStatus(command: string, params: Record<string, unknown> = {}) {
    try {
      await rpc(command, params);
      return { status: 200, message: '' };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, message: err.message };
    }
  }

  /**
   * Declare `[serve]` ports in the project's config.
   *
   * Appended rather than written over the generated lazy.toml: `lazy init` puts
   * the store's `external_path` in there, and a stub file would quietly point
   * the daemon at an empty store. `lazy init` writes no `[serve]` section, so
   * this is an addition, not a TOML redefinition — the template's `# [serve]`
   * is a comment, so the assertion below looks for a real section header.
   */
  async function declareServePorts(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\[serve\]/m);
    await writeFile(configPath, `${before}\n[serve]\nports = [3000, 5173]\n`);
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
    for (const conn of open.splice(0)) conn.close();
    await ctx.cleanup();
  });

  // --- Input validation ---

  // Every external surface confirms its inputs at the boundary rather than
  // coercing them — a missing taskId must say so, not resolve "undefined".
  test('rejects a missing or wrong-typed taskId', async () => {
    const missing = await rpcStatus('servePorts', {});
    expect(missing.status).toBe(400);
    expect(missing.message).toContain('taskId');

    const wrongType = await rpcStatus('servePorts', { taskId: 42 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.message).toContain('taskId');
  });

  test('reports an unknown task as not found', async () => {
    const result = await rpcStatus('servePorts', { taskId: 'deadbeef' });
    expect(result.status).toBe(404);
    expect(result.message).toContain('deadbeef');
  });

  // --- State ---

  test('a project with no [serve] declares nothing', async () => {
    const taskId = await createTask(ctx, 'Serve ports: nothing declared');

    const state = await rpc('servePorts', { taskId }) as Record<string, unknown>;
    expect(state.declared).toEqual([]);
    expect(state.services).toEqual([]);
    // Nothing declared is not an outage — there is simply nothing to publish.
    expect(state.unavailable).toBeNull();
    expect(typeof state.taskId).toBe('string');
    expect(state.status).toBe('backlog');
  });

  // INVARIANT: a task whose container is down is a normal ANSWER, not an error.
  // The caller is asking about state, and "not running" is the state.
  test('declared services report as unavailable while the container is down', async () => {
    await declareServePorts();
    const taskId = await createTask(ctx, 'Serve ports: declared but down');

    const state = await rpc('servePorts', { taskId }) as {
      declared: Array<{ name: string; port: number }>;
      services: unknown[];
      unavailable: string | null;
      containerName: string;
      runnerType: string;
    };
    expect(state.declared.map((s) => s.port)).toEqual([3000, 5173]);
    expect(state.services).toEqual([]);
    expect(state.unavailable).toBe('not-running');
    // The container name is answered even when nothing runs under it — it is
    // derived from the task, not read back from the runtime.
    expect(state.containerName).toBeTruthy();
    expect(state.runnerType).toBe('docker');
  });

  // --- Start services command ---

  // The command Lazy Teams shows and designates. It rides on servePorts so a
  // Services card needs one read, and it is saved through the same RPC the
  // dashboard's designate form uses.
  test('servePorts carries the designated Start services command; designation saves to the store', async () => {
    const taskId = await createTask(ctx, 'Serve ports: start command');
    const tomlBefore = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');

    let state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('');

    const saved = await rpc('serve.setStartServicesCmd', { command: '  bin/dev ', actor: 'human' });
    expect(saved).toEqual({ command: 'bin/dev' });

    state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('bin/dev');
    expect(await rpc('serve.getStartServicesCmd')).toEqual({ command: 'bin/dev' });
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('bin/dev');
    // INVARIANT: designation never edits lazy.toml.
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf-8')).toBe(tomlBefore);
  });

  test('serve.setStartServicesCmd refuses a multi-line or blank command with a 400', async () => {
    const multi = await rpcStatus('serve.setStartServicesCmd', { command: 'bin/dev\ncurl evil' });
    expect(multi.status).toBe(400);
    expect(multi.message).toMatch(/single line/);
    expect((await rpcStatus('serve.setStartServicesCmd', { command: '  ' })).status).toBe(400);
    expect((await rpcStatus('serve.setStartServicesCmd', {})).status).toBe(400);
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();
  });

  // Until the one-time import has run, lazy.toml's value still resolves, so an
  // existing setting never disappears.
  test('an existing lazy.toml start_services_cmd resolves until the store has one', async () => {
    const path = join(ctx.root, 'lazy.toml');
    await writeFile(path, `${await readFile(path, 'utf-8')}\n[serve]\nstart_services_cmd = "npm run dev"\n`);
    const taskId = await createTask(ctx, 'Serve ports: toml fallback');

    let state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('npm run dev');

    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('bin/dev');
  });

  // INVARIANT: an existing lazy.toml start_services_cmd never silently
  // disappears. The daemon copies it into the store ONCE, at startup, leaves
  // lazy.toml untouched, and does not re-read it after that.
  test('a daemon restart imports lazy.toml start_services_cmd into the store once', async () => {
    const path = join(ctx.root, 'lazy.toml');
    await writeFile(path, `${await readFile(path, 'utf-8')}\n[serve]\nstart_services_cmd = "npm run dev"\n`);
    const tomlBefore = await readFile(path, 'utf-8');
    const taskId = await createTask(ctx, 'Serve ports: import on restart');

    const restart = async () => {
      expectSuccess(await ctx.lazy(['daemon', 'restart', '--yes']));
      target = getDaemonTcpTarget(ctx.root)!;
      token = readToken(ctx.root)!;
    };

    await restart();
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('npm run dev');
    expect(await readFile(path, 'utf-8')).toBe(tomlBefore);

    // A later lazy.toml edit is not re-imported, and does not change what resolves.
    await writeFile(path, tomlBefore.replace('"npm run dev"', '"edited"'));
    await restart();
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('npm run dev');
    const state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('npm run dev');
  }, 120_000);

  // INVARIANT: a clear STICKS. Once somebody clears the command, neither the
  // lazy.toml fallback nor the daemon-start import brings the old
  // `[serve] start_services_cmd` back — otherwise the key the user can no
  // longer see would quietly resurrect a button they removed.
  test('clearing the command sticks across the lazy.toml fallback and a daemon restart', async () => {
    const path = join(ctx.root, 'lazy.toml');
    await writeFile(path, `${await readFile(path, 'utf-8')}\n[serve]\nstart_services_cmd = "npm run dev"\n`);
    const tomlBefore = await readFile(path, 'utf-8');
    const taskId = await createTask(ctx, 'Serve ports: clear sticks');

    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    expect(await rpc('serve.clearStartServicesCmd')).toEqual({ command: '' });

    let state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('');
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();

    expectSuccess(await ctx.lazy(['daemon', 'restart', '--yes']));
    target = getDaemonTcpTarget(ctx.root)!;
    token = readToken(ctx.root)!;

    state = await rpc('servePorts', { taskId }) as { startServicesCmd: string };
    expect(state.startServicesCmd).toBe('');
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();
    expect(await readFile(path, 'utf-8')).toBe(tomlBefore);

    // Designating again works, and a settings-form save keeps the cleared state
    // from coming back as the lazy.toml value.
    await rpc('serve.setStartServicesCmd', { command: 'bin/dev2' });
    expect((await rpc('servePorts', { taskId }) as { startServicesCmd: string }).startServicesCmd).toBe('bin/dev2');
    await rpc('serve.clearStartServicesCmd');
    await rpc('setProjectSettings', { defaultModel: 'opus' });
    expect((await rpc('servePorts', { taskId }) as { startServicesCmd: string }).startServicesCmd).toBe('');
  }, 120_000);

  // The command shares the project settings record with the settings form,
  // whose save is a whole-record replace — it must not wipe the command.
  test('saving project settings keeps the designated Start services command', async () => {
    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    await rpc('setProjectSettings', { defaultModel: 'opus' });
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('bin/dev');
    expect(readProjectSettingsFile(ctx.root)?.defaultModel).toBe('opus');
  });

  // --- ports.changed ---

  // The event that makes the RPC worth polling. A relaunch removes the old
  // container before creating the new one, and its ports move with it, so BOTH
  // halves have to reach the feed: removal used to write nothing at all, which
  // left a subscriber believing a stale mapping indefinitely.
  test('emits ports.changed for both the removal and the creation of a container', async () => {
    const taskId = await createTask(ctx, 'Serve ports: relaunch', 'Do some work');

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }

    // Subscribe only now: the interesting pair belongs to the SECOND launch,
    // which tears the first container down before standing a new one up.
    const conn = await openSse(new URL(`${target}/rpc/events`).toString(), {
      headers: { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
    });
    open.push(conn);
    await conn.waitFor((f) => f.event === 'feed.open', 10_000, 'feed.open');

    expectSuccess(
      await ctx.lazyMocked(['unblock', taskId, '--message', 'go again'], MOCK_CLAUDE_SUCCESS),
    );

    const removed = await conn.waitFor(
      (f) => f.event === 'ports.changed' && frameData(f).data.containerName === null,
      30_000,
      'ports.changed (removal)',
    );
    expect(frameData(removed).taskId).toBeTruthy();

    const created = await conn.waitFor(
      (f) => f.event === 'ports.changed' && typeof frameData(f).data.containerName === 'string',
      30_000,
      'ports.changed (creation)',
    );
    // Removal is observed BEFORE the replacement — the store is never claiming
    // a container that no longer exists.
    expect(Number(created.id)).toBeGreaterThan(Number(removed.id));
    // INVARIANT: the event says the mapping MOVED; it never carries the ports.
    // Host ports are assigned at creation and read back live, so a port list on
    // the feed would be stale the moment it was buffered — call servePorts.
    expect(removed.data).not.toContain('hostPort');
    expect(created.data).not.toContain('hostPort');
  });
});
