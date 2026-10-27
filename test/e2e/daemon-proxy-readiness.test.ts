import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { waitForDaemon, checkDaemonHealth, acquireDaemonLock, releaseDaemonLock, writeWebPort } from '../../src/daemon/lifecycle';
import { getLogPath, getPidPath } from '../../src/daemon/paths';
import { TEST_PARENT_PID_ENV } from '../../src/daemon/test-parent-watch';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker } from '../helpers/fake-docker';
import { getOrCreateStorage } from '../../src/daemon/rpc-handlers';
import { clearDaemonContext, getDaemonContext, hasDaemonContext, setDaemonContext, type DaemonContext } from '../../src/daemon/context';

isolateInProcessDaemonEnv();

let ctx: TestContext;
let dir: string;
let unpin: () => void;
let restoreConfig: () => void;
let priorContext: DaemonContext | null;
let starting: Promise<RunningDaemon> | undefined;

beforeEach(async () => {
  process.env.LAZY_TEST = '1';
  ctx = await setupTestLazy();
  dir = await makeDaemonBaseDir();
  unpin = pinDaemonBaseDir(dir);
  restoreConfig = pinConfig(ctx.root);
  priorContext = hasDaemonContext() ? getDaemonContext() : null;
  clearDaemonContext();
  starting = undefined;
});

afterEach(async () => {
  try {
    if (starting) {
      // A failed startup has already torn down its partial daemon; successful
      // starts still need stopping even when an assertion failed.
      const [outcome] = await Promise.allSettled([starting]);
      if (outcome.status === 'fulfilled') await outcome.value.stop();
    }
  } finally {
    try {
      await ctx.cleanup();
    } finally {
      restoreConfig();
      if (priorContext) setDaemonContext(priorContext);
      else clearDaemonContext();
      unpin();
      await removeDaemonBaseDir(dir);
    }
  }
});

// INVARIANT: answering RPC is not launch readiness: the always-on proxy must
// have bound too, or every harness can fail immediately after auto-start.
test('readiness waits for a delayed proxy after RPC begins answering', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const reached = new Promise<void>(r => { entered = r; });
  starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0, reconcileIntervalSeconds: 60,
    _beforeProxyStart: async () => { entered(); await held; },
  });
  try {
    await Promise.race([reached, starting]);
    expect((await checkDaemonHealth(ctx.root)).running).toBe(true);
    expect(await waitForDaemon(ctx.root, 250)).toBe(false);
    let commandFinished = false;
    const command = ctx.lazy(['list'], { env: { LAZY_TEST: '', LAZY_DAEMON_BASE_DIR: dir } })
      .then(result => { commandFinished = true; return result; });
    await new Promise(r => setTimeout(r, 5500));
    expect(commandFinished).toBe(false);
    release();
    await starting;
    const result = await command;
    expect(result.stderr).toContain('Daemon is still starting');
    expect({ code: result.exitCode, stderr: result.stderr, stdout: result.stdout }).toMatchObject({ code: 0 });
    expect(await waitForDaemon(ctx.root, 1000)).toBe(true);
    expect((await checkDaemonHealth(ctx.root)).proxy?.running).toBe(true);
  } finally {
    release();
  }
}, 30000);

// INVARIANT: a proxy bind failure must retain the actionable startup error;
// waiting for readiness must not turn it into a slow generic timeout.
test('a proxy startup failure fails at once with the proxy remedy', async () => {
  starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0,
    _beforeProxyStart: async () => { throw new Error('test proxy bind failed'); },
  });
  await expect(starting).rejects.toThrow('Daemon failed to start the [proxy] server: test proxy bind failed');
  const { readFile } = await import('fs/promises');
  const { getStartupErrorPath } = await import('../../src/daemon/paths');
  const message = await readFile(getStartupErrorPath(ctx.root), 'utf-8');
  expect(message).toContain('Bind address unavailable');
  expect(message).toContain('lazy daemon');
}, 30000);

// INVARIANT: a caller whose child loses the singleton lock joins the winner's
// full startup wait. A five-second health fallback races a slow proxy again.
test('concurrent background starts wait for the winning daemon beyond five seconds', async () => {
  const lock = acquireDaemonLock(ctx.root);
  expect(lock).not.toBeNull();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const reached = new Promise<void>(r => { entered = r; });
  starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0, reconcileIntervalSeconds: 60,
    _beforeProxyStart: async () => { entered(); await held; },
  });
  const clients: ReturnType<typeof Bun.spawn>[] = [];
  const results: Promise<{ exitCode: number; stderr: string }>[] = [];
  try {
    await Promise.race([reached, starting]);
    // Run real background starts in separate client processes. Set argv to
    // the actual CLI entry so their detached children execute lazy, not bun test.
    const entry = join(import.meta.dir, '../../src/index.ts');
    const modulePath = join(import.meta.dir, '../../src/daemon/auto-start.ts');
    const script = `import { startDaemonBackground } from ${JSON.stringify(modulePath)};
      process.argv = [process.execPath, ${JSON.stringify(entry)}];
      await startDaemonBackground(${JSON.stringify(ctx.root)}, { foreign: null });`;
    let finished = 0;
    for (let i = 0; i < 2; i++) {
      const client = Bun.spawn([process.execPath, '-e', script], {
        cwd: ctx.root, stdout: 'ignore', stderr: 'pipe',
        env: { ...process.env, ...MCP_SERVER_ENV_PINS,
          [TEST_PARENT_PID_ENV]: String(process.pid), LAZY_DAEMON_BASE_DIR: dir,
        },
      });
      clients.push(client);
      results.push(Promise.all([client.exited, new Response(client.stderr).text()])
        .then(([exitCode, stderr]) => { finished++; return { exitCode, stderr }; }));
    }
    // Observe both real detached children lose the lock before timing the hold.
    const deadline = Date.now() + 10_000;
    let lost = 0;
    while (lost < 2 && Date.now() < deadline) {
      const log = await readFile(getLogPath(ctx.root), 'utf-8').catch(err => {
        if (err.code === 'ENOENT') return '';
        throw new Error(`Could not read startup log: ${err.message}`);
      });
      lost = (log.match(/Failed to acquire daemon lock/g) ?? []).length;
      if (lost < 2) await new Promise(r => setTimeout(r, 100));
    }
    expect(lost).toBeGreaterThanOrEqual(2);
    await new Promise(r => setTimeout(r, 5500));
    expect(finished).toBe(0);
    release();
    await starting;
    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stderr).toContain('Daemon is still starting');
    }
  } finally {
    release();
    for (const client of clients) {
      if (client.exitCode === null) client.kill();
    }
    await Promise.all(results);
    if (lock !== null) releaseDaemonLock(lock);
  }
}, 30_000);

// INVARIANT: the held daemon lock survives deletion of the PID file. A command
// must keep waiting for that live owner's proxy rather than report a timeout.
test('a missing PID file does not bypass the live lock owner startup wait', async () => {
  const lock = acquireDaemonLock(ctx.root);
  expect(lock).not.toBeNull();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const reached = new Promise<void>(r => { entered = r; });
  starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0, reconcileIntervalSeconds: 60,
    _beforeProxyStart: async () => { entered(); await held; },
  });
  let command: ReturnType<TestContext['lazy']> | undefined;
  try {
    await Promise.race([reached, starting]);
    await unlink(getPidPath(ctx.root));
    let finished = false;
    command = ctx.lazy(['list'], { env: { LAZY_TEST: '', LAZY_DAEMON_BASE_DIR: dir } })
      .then(result => { finished = true; return result; });
    await new Promise(r => setTimeout(r, 1000));
    expect(finished).toBe(false);
    release();
    await starting;
    const result = await command;
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stderr).not.toContain('startup timeout');
  } finally {
    release();
    await command;
    if (lock !== null) releaseDaemonLock(lock);
  }
}, 30_000);

// INVARIANT: completed startup without a proxy leaves reads and diagnostics
// usable; the shared live-address guard refuses only proxy-dependent calls.
test('failed proxy leaves list and doctor usable but refuses builder with the remedy', async () => {
  const created = await ctx.lazy(['create', '--goal', 'Readable with failed proxy', '--code', 'proxy-read']);
  expect(created.exitCode).toBe(0);
  starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0, reconcileIntervalSeconds: 60 });
  const daemon = await starting;
  // Model the degraded daemon's external contract without weakening the real
  // server's fatal bind-failure policy. Business RPCs still hit the real daemon.
  setDaemonContext({ webPort: daemon.webPort, token: daemon.token });
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    const response = await fetch(new URL(url.pathname + url.search, 'http://127.0.0.1:' + daemon.webPort), req);
    if (url.pathname !== '/daemon/status') return response;
    const status = await response.json() as Record<string, unknown>;
    return Response.json({ ...status, startup: { complete: true }, proxy: { running: false } });
  } });
  writeWebPort(ctx.root, gateway.port!);
  const options = { env: { LAZY_TEST: '', LAZY_DAEMON_BASE_DIR: dir } };
  try {
    const list = await ctx.lazy(['list'], options);
    expect({ code: list.exitCode, stderr: list.stderr }).toMatchObject({ code: 0 });
    expect(list.stdout).toContain('Readable with failed proxy');
    const show = await ctx.lazy(['show', 'proxy-read'], options);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('Readable with failed proxy');
    // Teams requests the paged list shape through this same RPC.
    const page = await fetch('http://127.0.0.1:' + gateway.port + '/rpc/list', {
      method: 'POST', headers: { Authorization: 'Bearer ' + daemon.token, 'Content-Type': 'application/json', 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ shape: 'page', view: 'all' }),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Readable with failed proxy');
    const doctor = await ctx.lazy(['doctor'], options);
    // A findings exit is fine; doctor must complete and explain the failure.
    const diagnosis = doctor.stdout + doctor.stderr;
    expect(diagnosis).toContain('Git installed');
    expect(diagnosis).toContain('No runner is available');
    expect(diagnosis).toContain('lazy daemon restart');
    const builder = await ctx.lazy(['builder', '--yes'], options);
    expect(builder.exitCode).not.toBe(0);
    expect(builder.stderr).toContain('could not resolve the live proxy address');
    expect(builder.stderr).toContain('lazy daemon restart');
    expect(builder.stderr).toContain('lazy daemon logs');
  } finally {
    gateway.stop(true);
    writeWebPort(ctx.root, daemon.webPort);
  }
}, 30_000);

// INVARIANT: watching an existing run reads its logs without launching a model
// or requiring the failed proxy, on both CLI and browser/Teams Watch.
test('failed proxy preserves CLI and web Watch supervisor streams', async () => {
  const docker = await installFakeDocker(join(ctx.root, 'watch-runtime'));
  const savedPath = process.env.PATH;
  process.env.PATH = docker.binDir + ':' + savedPath;
  let watch: ReturnType<TestContext['lazy']> | undefined;
  let socket: WebSocket | undefined;
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  let taskId: string | undefined;
  try {
    starting = startDaemonServer({ projectRoot: ctx.root, webPort: 0, reconcileIntervalSeconds: 60 });
    const daemon = await starting;
    setDaemonContext({ webPort: daemon.webPort, token: daemon.token });
    gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const url = new URL(req.url);
      const response = await fetch(new URL(url.pathname + url.search, 'http://127.0.0.1:' + daemon.webPort), req);
      if (url.pathname !== '/daemon/status') return response;
      return Response.json({ ...await response.json(), startup: { complete: true }, proxy: { running: false } });
    } });
    writeWebPort(ctx.root, gateway.port!);
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Watch an existing run without the proxy');
    taskId = task.id;
    const runName = 'lazy-watch-existing';
    const sha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/watch-existing', sha);
    await storage.updateSessionContainerName(session.id, runName);
    await docker.seedContainer(runName, { state: 'running', project: ctx.root });
    await writeFile(join(docker.stateDir, 'logs-' + runName), 'retained supervisor output\n');
    await storage.updateTaskStatus(task.id, 'working', 'system');

    let webOutput = '';
    socket = new WebSocket('ws://127.0.0.1:' + daemon.webPort + '/rpc/tasks/' + task.id + '/watch/ws', {
      headers: { Authorization: 'Bearer ' + daemon.token, 'X-Lazy-Project': ctx.root },
    } as never);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      webOutput += typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
    });
    watch = ctx.lazy(['watch', task.id, '--no-traffic'], {
      env: { LAZY_TEST: '', LAZY_DAEMON_BASE_DIR: dir, PATH: process.env.PATH! },
    });
    const deadline = Date.now() + 10_000;
    let followers = 0;
    while (Date.now() < deadline) {
      followers = (await docker.invocations()).filter(line => line.startsWith('logs --follow') && line.endsWith(runName)).length;
      if (followers >= 2 && webOutput.includes('sup> retained supervisor output')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(followers).toBeGreaterThanOrEqual(2);
    expect(webOutput).toContain('sup> retained supervisor output');
    expect(webOutput).not.toContain('streams unavailable');
    await storage.updateTaskStatus(task.id, 'blocked', 'system');
    const result = await watch;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sup> retained supervisor output');
    expect(result.stderr).not.toContain('could not resolve the live proxy address');
  } finally {
    socket?.close();
    if (taskId) {
      const storage = await getOrCreateStorage();
      if ((await storage.getTask(taskId))?.status === 'working') await storage.updateTaskStatus(taskId, 'blocked', 'system');
    }
    await watch;
    gateway?.stop(true);
    if (starting) {
      const [result] = await Promise.allSettled([starting]);
      if (result.status === 'fulfilled') writeWebPort(ctx.root, result.value.webPort);
    }
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
}, 30_000);
