/**
 * `lazy forward` — reaching a port inside a task's container from this machine.
 *
 * The container runtime is faked with a scriptable `docker` on PATH, the same
 * way `url.test.ts` fakes published ports. Everything under test is real: flag
 * parsing → task resolution → runner → the socat probe → the loopback listener
 * and the byte pumps. Only the "inside the container" part is pretend, and it is
 * pretend in the most honest way available — the fake `docker exec … socat`
 * really relays bytes to a real TCP server the test started, so a round trip
 * through the command is a round trip through actual sockets.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, resolve } from 'path';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

/**
 * A `docker` that answers what `lazy forward` asks:
 *   - `ps --filter …`   → is the container running? (from the state dir)
 *   - `exec … sh -c …`  → the `command -v socat` probe (from the state dir)
 *   - `exec -i … socat STDIO TCP:host:port` → a real relay to that port
 *
 * The relay is bash's `/dev/tcp`, which is exactly the shape socat has here:
 * stdin goes to the socket, the socket comes back on stdout, and a refused
 * connection exits non-zero with the reason on stderr.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
case "\${1:-}" in
  info) exit 0 ;;
  ps)
    if [ -f "\$STATE/running" ]; then echo "deadbeef1234"; fi
    exit 0
    ;;
  exec)
    shift
    while [ \$# -gt 0 ]; do
      case "\$1" in -*) shift ;; *) break ;; esac
    done
    shift # container name
    if [ "\${1:-}" = "sh" ]; then
      if [ -f "\$STATE/no-socat" ]; then exit 1; fi
      exit 0
    fi
    if [ "\${1:-}" = "socat" ]; then
      target="\${3#TCP:}"
      host="\${target%%:*}"
      port="\${target##*:}"
      exec 3<>"/dev/tcp/\$host/\$port" || exit 1
      cat <&3 &
      relay=\$!
      cat >&3
      wait \$relay
      exit 0
    fi
    exit 0
    ;;
esac
exit 0
`;

describe('lazy forward', () => {
  let ctx: TestContext;
  let fakeRoot: string;
  let binDir: string;
  let stateDir: string;
  const closers: Array<() => void> = [];

  beforeEach(async () => {
    fakeRoot = await mkdtemp(join(tmpdir(), 'lazy-forward-fake-'));
    binDir = join(fakeRoot, 'bin');
    stateDir = join(fakeRoot, 'state');
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const script = join(binDir, 'docker');
    await writeFile(script, FAKE_DOCKER.replace('__STATE_DIR__', stateDir));
    await chmod(script, 0o755);

    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await ctx.cleanup();
    await rm(fakeRoot, { recursive: true, force: true });
  });

  const fakePath = () => `${binDir}:${process.env.PATH}`;

  /** Run `lazy forward` to completion (error paths only — the happy path blocks). */
  function forward(args: string[]) {
    return ctx.lazy(['forward', ...args], { env: { PATH: fakePath() } });
  }

  /** Pretend the task's container is up. */
  async function containerUp(): Promise<void> {
    await writeFile(join(stateDir, 'running'), '');
  }

  /** A real TCP server that echoes what it is sent, upper-cased. */
  function echoServer(): number {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.write(new TextDecoder().decode(chunk).toUpperCase());
        },
      },
    });
    closers.push(() => server.stop(true));
    return server.port;
  }

  /**
   * Start `lazy forward` and read stdout until every pair is announced.
   *
   * The command never exits on its own, which is the point of it — so the test
   * drives it the way a human does: read what it says, use it, then stop it.
   */
  async function runForward(args: string[], expectedLines: number) {
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'forward', ...args], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: fakePath(), LAZY_TEST: '1' },
    });

    // Both streams are drained in the background: stderr is where a tunnel
    // failure is narrated while the command keeps running, and an undrained
    // pipe would eventually stall the child.
    let output = '';
    let errors = '';
    const drain = (stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      return (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          onChunk(decoder.decode(value, { stream: true }));
        }
      })().catch(() => { /* the process was stopped mid-read */ });
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>, text => { output += text; });
    void drain(proc.stderr as ReadableStream<Uint8Array>, text => { errors += text; });

    const announced = () => (output.match(/^Forwarding 127\.0\.0\.1:/gm) ?? []).length;
    const deadline = Date.now() + 30_000;
    while (announced() < expectedLines && Date.now() < deadline) await Bun.sleep(50);

    const ports = [...output.matchAll(/^Forwarding 127\.0\.0\.1:(\d+) -> \S+:(\d+)$/gm)]
      .map(m => ({ hostPort: Number(m[1]), containerPort: Number(m[2]) }));

    return {
      get output() { return output; },
      get stderr() { return errors; },
      ports,
      /** Wait for `needle` to appear on stderr, or give up and return what there is. */
      async waitForStderr(needle: string): Promise<string> {
        const until = Date.now() + 15_000;
        while (!errors.includes(needle) && Date.now() < until) await Bun.sleep(100);
        return errors;
      },
      async stop() {
        proc.kill();
        await proc.exited;
      },
    };
  }

  /** Connect to `port`, send `payload`, resolve with everything read back. */
  function roundTrip(port: number, payload: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error('round trip timed out')), 15_000);
      Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          open(socket) { socket.write(payload); },
          data(socket, chunk) {
            received += new TextDecoder().decode(chunk);
            socket.end();
          },
          close() { clearTimeout(timer); resolvePromise(received); },
          error(_socket, err) { clearTimeout(timer); reject(err); },
        },
      }).catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  // --- Refusals, before anything is bound --------------------------------

  test('no port pair prints usage rather than guessing one', async () => {
    const taskId = await createTask(ctx, 'No pairs');
    const result = await forward([taskId]);
    expectFailure(result);
    expect(result.stdout).toContain('Usage: lazy forward');
  });

  test('a malformed pair names the offending side', async () => {
    const taskId = await createTask(ctx, 'Bad pair');
    const result = await forward([taskId, 'web:3000']);
    expectFailure(result);
    expectError(result, 'host port must be a number');
    expectError(result, '8080:3000');
  });

  // INVARIANT: a host port claimed twice is caught during parsing, before any
  // listener binds — so the error names both pairs instead of arriving as an
  // EADDRINUSE after the first forward is already up and announced.
  test('the same host port twice is refused before anything is bound', async () => {
    const taskId = await createTask(ctx, 'Duplicate host port');
    const result = await forward([taskId, '8080:3000', '8080:5432']);
    expectFailure(result);
    expectError(result, 'requested twice');
  });

  test('a container that is not running says how to bring it up', async () => {
    const taskId = await createTask(ctx, 'Not running');
    const result = await forward([taskId, '3000']);
    expectFailure(result);
    expectError(result, 'no running container');
    expectError(result, 'lazy shell');
  });

  // A container whose image predates socat would otherwise fail per-connection,
  // as a stream that closes instantly for no stated reason.
  test('an image without socat is refused up front, with the fix', async () => {
    await containerUp();
    await writeFile(join(stateDir, 'no-socat'), '');
    const taskId = await createTask(ctx, 'No socat');
    const result = await forward([taskId, '3000']);
    expectFailure(result);
    expectError(result, 'socat');
    expectError(result, 'lazy upgrade --images');
  });

  // --- Forwarding for real ------------------------------------------------

  test('a bare port is assigned a host port, announced, and carries bytes', async () => {
    await containerUp();
    const taskId = await createTask(ctx, 'Bare port');
    const inside = echoServer();

    const run = await runForward([taskId, String(inside)], 1);
    try {
      expect(run.ports).toHaveLength(1);
      expect(run.ports[0].containerPort).toBe(inside);
      expect(run.ports[0].hostPort).toBeGreaterThan(0);
      // Assigned, not the container port echoed back as a host port.
      expect(run.output).toContain('Press Ctrl-C to stop');

      expect(await roundTrip(run.ports[0].hostPort, 'hello')).toBe('HELLO');
    } finally {
      await run.stop();
    }
  });

  test('an explicit host port is the one bound, and several pairs work at once', async () => {
    await containerUp();
    const taskId = await createTask(ctx, 'Two pairs');
    const first = echoServer();
    const second = echoServer();
    // A free host port to ask for by name: bind one, note it, release it.
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const wanted = probe.port;
    probe.stop(true);

    const run = await runForward([taskId, `${wanted}:${first}`, String(second)], 2);
    try {
      expect(run.ports).toHaveLength(2);
      expect(run.ports[0]).toEqual({ hostPort: wanted, containerPort: first });
      expect(run.ports[1].containerPort).toBe(second);
      expect(await roundTrip(wanted, 'one')).toBe('ONE');
      expect(await roundTrip(run.ports[1].hostPort, 'two')).toBe('TWO');
    } finally {
      await run.stop();
    }
  });

  // INVARIANT: nothing a forward started outlives the command. That is the whole
  // reason this is a foreground command with no registry — stopping it is total,
  // and the host port is free again immediately.
  test('stopping the command releases the host port', async () => {
    await containerUp();
    const taskId = await createTask(ctx, 'Teardown');
    const inside = echoServer();

    const run = await runForward([taskId, String(inside)], 1);
    const hostPort = run.ports[0].hostPort;
    expect(await roundTrip(hostPort, 'up')).toBe('UP');
    await run.stop();

    const rebind = Bun.listen({ hostname: '127.0.0.1', port: hostPort, socket: { data() {} } });
    rebind.stop(true);
  });

  test('nothing listening inside the task is reported in plain words', async () => {
    await containerUp();
    const taskId = await createTask(ctx, 'Dead port');
    // A port nothing is on: bind one to learn it is free, then let it go.
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const dead = probe.port;
    probe.stop(true);

    const run = await runForward([taskId, String(dead)], 1);
    try {
      // The listener comes up regardless — nothing can know what is listening
      // inside the task until someone connects. The report arrives then.
      expect(run.ports).toHaveLength(1);
      await roundTrip(run.ports[0].hostPort, 'anyone there?').catch(() => '');
      expect(await run.waitForStderr('Nothing is listening'))
        .toContain(`Nothing is listening on port ${dead}`);
    } finally {
      await run.stop();
    }
  });
});
