/**
 * `lazy url` — where a task's declared `[serve]` ports are reachable.
 *
 * The container runtime is faked with a scriptable `docker` on PATH, so the
 * whole path under test is real: config load → runner → `docker port` → the
 * name/port lookup. Only the runtime is pretend.
 *
 * The URL printed is the SUBDOMAIN name the daemon's proxy answers on
 * (`http://web.<task>.lazy.localhost:<dashboard port>`), because the human's
 * next move is to open it in a browser. `--direct` prints the raw 127.0.0.1
 * mapping the container actually publishes, for curl and scripts — both forms
 * are asserted here, since the two are what every other surface composes from.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { checkDaemonHealth } from '../../src/daemon';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * A `docker` that answers only what discovery asks: `ps --filter` (is it
 * running?) and `port` (what does it publish?). Both read a state directory the
 * test writes, so a single fake covers running/not-running and any mapping.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
case "\${1:-}" in
  ps)
    if [ -f "\$STATE/running" ]; then echo "deadbeef1234"; fi
    exit 0
    ;;
  port)
    cat "\$STATE/ports" 2>/dev/null
    exit 0
    ;;
  info) exit 0 ;;
esac
exit 0
`;

describe('lazy url', () => {
  let ctx: TestContext;
  let binDir: string;
  let stateDir: string;

  let fakeRoot: string;
  /** The port the test daemon's dashboard (and so the serve proxy) answers on. */
  let webPort: number;

  beforeEach(async () => {
    // The fake lives OUTSIDE the test project and is installed before the
    // daemon starts: `lazy show` resolves its data daemon-side, so the daemon
    // needs the fake on its own PATH, and that PATH must be known at startup.
    fakeRoot = await mkdtemp(join(tmpdir(), 'lazy-url-fake-'));
    binDir = join(fakeRoot, 'bin');
    stateDir = join(fakeRoot, 'state');
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const script = join(binDir, 'docker');
    await writeFile(script, FAKE_DOCKER.replace('__STATE_DIR__', stateDir));
    await chmod(script, 0o755);

    // Daemon-backed: `lazy show` only renders the serving block for a task that
    // HAS a session (a task with no container cannot publish anything), and only
    // the daemon reconciler creates one.
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        PATH: `${binDir}:${process.env.PATH}`,
        // The daemon runs under the module mock (it must, or `lazy start` would
        // launch a real agent), and that mock answers "is this container
        // running?" itself. Point it at the SAME state file the fake docker
        // reads, so the two cannot disagree: `publish()` makes the container
        // running for both, and the port mapping still comes from a real
        // `docker port` call.
        LAZY_MOCK_RUNNING_CONTAINERS: join(stateDir, 'running'),
      },
    });

    // Where the proxy answers — every subdomain URL is built against it.
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    webPort = health.webPort!;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(fakeRoot, { recursive: true, force: true });
  });

  /** Run `lazy url` with the fake docker first on PATH. */
  function url(args: string[]) {
    return ctx.lazy(['url', ...args], { env: { PATH: `${binDir}:${process.env.PATH}` } });
  }

  /** Append a [serve] section to the project's lazy.toml (the template has none). */
  async function declareServe(section: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    await writeFile(path, `${before}\n${section}\n`);
  }

  /** Pretend the task's container is up and publishing these mappings. */
  async function publish(lines: string[]): Promise<void> {
    await writeFile(join(stateDir, 'running'), '');
    await writeFile(join(stateDir, 'ports'), lines.join('\n') + '\n');
  }

  test('a project with no [serve] says so, and says how to declare one', async () => {
    const taskId = await createTask(ctx, 'No ports');
    const result = await url([taskId]);
    expectFailure(result);
    expectError(result, 'declares no ports');
    expectError(result, '[serve]');
  });

  test('a container that is not running explains why there is nothing yet', async () => {
    await declareServe('[serve]\nports = [3000]');
    const taskId = await createTask(ctx, 'Not running');
    const result = await url([taskId]);
    expectFailure(result);
    expectError(result, 'no running container');
    // The remedy is bare `lazy shell` — it enters (and brings up) the container
    // by default now.
    expectError(result, 'lazy shell');
  });

  test('lists every declared service with the name a browser opens', async () => {
    await declareServe('[serve]\nports = [3000]\n\n[serve.services]\napi = 8080');
    const taskId = await createTask(ctx, 'Multi service');
    await publish(['3000/tcp -> 127.0.0.1:49154', '8080/tcp -> 127.0.0.1:49160']);

    const result = await url([taskId]);
    expectSuccess(result);
    // A bare `[serve] ports` entry is named by its port, so that is its label
    // in the hostname too — a leading digit is a valid DNS label.
    expectOutput(result, `http://3000.${taskId}.lazy.localhost:${webPort}`);
    expectOutput(result, 'api');
    expectOutput(result, `http://api.${taskId}.lazy.localhost:${webPort}`);
    // These names only resolve in a browser, so the list says where to get a
    // URL that works in curl rather than leaving the reader to find out.
    expectOutput(result, '--direct');
  });

  test('--direct lists the raw loopback mappings instead', async () => {
    await declareServe('[serve]\nports = [3000]\n\n[serve.services]\napi = 8080');
    const taskId = await createTask(ctx, 'Multi service direct');
    await publish(['3000/tcp -> 127.0.0.1:49154', '8080/tcp -> 127.0.0.1:49160']);

    const result = await url([taskId, '--direct']);
    expectSuccess(result);
    expectOutput(result, 'http://127.0.0.1:49154');
    expectOutput(result, 'http://127.0.0.1:49160');
    // Nothing that only a browser can resolve, and no advice to pass the flag
    // the caller already passed.
    expect(result.stdout).not.toContain('lazy.localhost');
    expect(result.stdout).not.toContain('--direct');
  });

  // A task with a code is addressed BY that code — the whole point of a stable
  // name is that `web.my-task.lazy.localhost` survives a container recreate and
  // reads like the task, not like a hex id.
  test('a task code becomes the label in the hostname', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const result = await ctx.lazy(['create', '--goal', 'Coded task', '--code', 'my-task']);
    expectSuccess(result);
    await publish(['3000/tcp -> 127.0.0.1:49154']);

    const listed = await url(['my-task']);
    expectSuccess(listed);
    expect(listed.stdout).toContain(`http://web.my-task.lazy.localhost:${webPort}`);
  });

  // The list carries a liveness dot per service, from the shared TCP probe
  // (src/serve/probe.ts): ● when a connect to the published host port
  // succeeds, ○ when nothing answers. The probe never sends a byte, so a real
  // listener is all the fixture needs — no app, no request handling.
  test('the list shows which published ports actually answer', async () => {
    const live = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const dead = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const deadPort = dead.port;
    dead.stop(true);
    try {
      await declareServe('[serve.services]\nweb = 3000\napi = 8080');
      const taskId = await createTask(ctx, 'Liveness');
      await publish([
        `3000/tcp -> 127.0.0.1:${live.port}`,
        `8080/tcp -> 127.0.0.1:${deadPort}`,
      ]);

      const result = await url([taskId]);
      expectSuccess(result);
      const webLine = result.stdout.split('\n').find((l) => l.startsWith('web'));
      const apiLine = result.stdout.split('\n').find((l) => l.startsWith('api'));
      expect(webLine).toContain('● listening');
      expect(apiLine).toContain('○ not listening');
    } finally {
      live.stop(true);
    }
  });

  // INVARIANT: with a service argument the output is exactly one bare URL and
  // nothing else, so `open "$(lazy url my-task web)"` works. Labels, alignment
  // or a trailing note here would break every script that uses it.
  test('one service prints one bare URL', async () => {
    await declareServe('[serve.services]\nweb = 3000\napi = 8080');
    const taskId = await createTask(ctx, 'Scriptable');
    await publish(['3000/tcp -> 127.0.0.1:49154', '8080/tcp -> 127.0.0.1:49160']);

    const result = await url([taskId, 'web']);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe(`http://web.${taskId}.lazy.localhost:${webPort}`);
  });

  // INVARIANT: `--direct` prints the raw mapping, alone, for the same reason —
  // `curl "$(lazy url my-task web --direct)"` is the documented way to reach a
  // task service from anything that is not a browser, because only Chromium and
  // Firefox resolve *.localhost and a wildcard cannot go in /etc/hosts.
  test('--direct prints the raw loopback URL, and nothing else', async () => {
    await declareServe('[serve.services]\nweb = 3000\napi = 8080');
    const taskId = await createTask(ctx, 'Scriptable direct');
    await publish(['3000/tcp -> 127.0.0.1:49154', '8080/tcp -> 127.0.0.1:49160']);

    const result = await url([taskId, 'web', '--direct']);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe('http://127.0.0.1:49154');
  });

  test('a bare declared port is addressable by that port', async () => {
    await declareServe('[serve]\nports = [5173]');
    const taskId = await createTask(ctx, 'By port');
    await publish(['5173/tcp -> 127.0.0.1:49200']);

    const result = await url([taskId, '5173']);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe(`http://5173.${taskId}.lazy.localhost:${webPort}`);

    const direct = await url([taskId, '5173', '--direct']);
    expectSuccess(direct);
    expect(direct.stdout.trim()).toBe('http://127.0.0.1:49200');
  });

  test('an unknown service errors and lists what is declared', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Unknown name');
    await publish(['3000/tcp -> 127.0.0.1:49154']);

    const result = await url([taskId, 'nope']);
    expectFailure(result);
    expectError(result, 'no service "nope"');
    expectError(result, 'web');
  });

  // `lazy show` resolves ALL its data daemon-side, so this asserts the serving
  // block survives the RPC boundary — the daemon serializes TaskShowData through
  // an explicit field list, and a field left off it vanishes silently. The
  // subdomain URL is a second field on each service, so it is exactly the kind
  // of thing that can go missing on the way out of the daemon.
  test('lazy show surfaces the task services, with the URL to open', async () => {
    // Committed before the task exists, so the task's WORKTREE carries it —
    // `[serve]` is a per-branch fact and discovery reads it from there.
    await declareServe('[serve.services]\nweb = 3000');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'declare serve ports');

    const taskId = await createTask(ctx, 'Shown in show', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await publish(['3000/tcp -> 127.0.0.1:49154']);

    const result = await ctx.lazy(['show', taskId], { env: { PATH: `${binDir}:${process.env.PATH}` } });
    expectSuccess(result);
    expectOutput(result, 'Serving:');
    expectOutput(result, 'web');
    expectOutput(result, `http://web.${taskId}.lazy.localhost:${webPort}`);
  });

  // The same block for a task whose container is down: named, but with no URL
  // that could only refuse the connection.
  test('lazy show says a service is not reachable while the container is down', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'declare serve ports');

    const taskId = await createTask(ctx, 'Down in show', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    const result = await ctx.lazy(['show', taskId], { env: { PATH: `${binDir}:${process.env.PATH}` } });
    expectSuccess(result);
    expectOutput(result, 'Serving:');
    expectOutput(result, 'container not running');
    expect(result.stdout).not.toContain('lazy.localhost');
  });

  // INVARIANT: a project that declares nothing pays nothing. `lazy show` must
  // not grow a runtime call (or a section) for the common case.
  test('lazy show says nothing about serving when nothing is declared', async () => {
    const taskId = await createTask(ctx, 'No serve section');
    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expect(result.stdout).not.toContain('Serving:');
  });

  // Published ports are fixed when a container is CREATED, so a container that
  // predates a [serve] edit is a real, reachable state. It must be reported as
  // "restart to pick this up", not as a mystery blank.
  test('a declared port the running container does not publish says why', async () => {
    await declareServe('[serve.services]\nweb = 3000\nlater = 9000');
    const taskId = await createTask(ctx, 'Stale container');
    await publish(['3000/tcp -> 127.0.0.1:49154']);

    const listed = await url([taskId]);
    expectSuccess(listed);
    expectOutput(listed, 'not published');
    expectOutput(listed, 'restart the task');

    const single = await url([taskId, 'later']);
    expectFailure(single);
    expectError(single, 'not published');
  });
});
