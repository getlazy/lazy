/**
 * The `lazy forward` engine: pair parsing and the loopback forwarder itself.
 *
 * The forwarder is exercised with an in-memory channel rather than a container,
 * which is the whole point of it taking an `OpenChannel`: the listener, the byte
 * pumps and the teardown are lazy's code and are tested here, while the runtime
 * detail (`docker exec … socat`) is covered end-to-end in test/e2e/forward.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SERVE_BIND_HOST } from '../../src/serve/ports';
import {
  parseForwardSpec,
  parseForwardSpecs,
  startForward,
  type ForwardChannel,
} from '../../src/serve/forward';

/** A channel that echoes what it is written, upper-cased, so direction is visible. */
function echoChannel(): ForwardChannel {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already closed by an earlier end()/kill(); nothing to do.
    }
  };
  return {
    write(chunk) {
      if (!closed) controller.enqueue(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()));
    },
    end: close,
    stdout,
    stderr: null,
    exited: Promise.resolve(0),
    kill: close,
  };
}

/** A channel that fails immediately, the way socat does against a dead port. */
function refusedChannel(): ForwardChannel {
  return {
    write() {},
    end() {},
    stdout: new ReadableStream<Uint8Array>({ start: c => c.close() }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('socat: Connection refused\n'));
        c.close();
      },
    }),
    exited: Promise.resolve(1),
    kill() {},
  };
}

/** Connect, send `payload`, and resolve with everything received before close. */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          received += new TextDecoder().decode(chunk);
          socket.end();
        },
        close() {
          resolve(received);
        },
        error(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

describe('forward pair parsing', () => {
  test('a bare port asks for an assigned host port', () => {
    expect(parseForwardSpec('3000')).toEqual({ hostPort: 0, containerPort: 3000, raw: '3000' });
  });

  test('host:container maps both sides', () => {
    expect(parseForwardSpec('8080:3000')).toEqual({ hostPort: 8080, containerPort: 3000, raw: '8080:3000' });
  });

  test('an explicit 0 host port is the spelled-out "assign me one"', () => {
    expect(parseForwardSpec('0:3000').hostPort).toBe(0);
  });

  test('a non-numeric side names itself in the error', () => {
    expect(() => parseForwardSpec('web:3000')).toThrow(/host port must be a number, got "web"/);
    expect(() => parseForwardSpec('8080:web')).toThrow(/container port must be a number/);
  });

  test('an out-of-range port says the range', () => {
    expect(() => parseForwardSpec('8080:99999')).toThrow(/out of range/);
  });

  // A container port of 0 would mean "connect to port zero", which is not a
  // thing — only the HOST side has an assign-me meaning.
  test('container port 0 is refused', () => {
    expect(() => parseForwardSpec('8080:0')).toThrow(/out of range/);
    expect(() => parseForwardSpec('0')).toThrow(/out of range/);
  });

  test('more than two segments is rejected with the correct shape', () => {
    expect(() => parseForwardSpec('1:2:3')).toThrow(/<host-port>:<container-port>/);
  });

  // INVARIANT: two listeners cannot share a host port. Catching it during
  // parsing means the error names both pairs, instead of arriving as an
  // EADDRINUSE after the first forward is already up and announced.
  test('the same host port requested twice is refused up front', () => {
    expect(() => parseForwardSpecs(['8080:3000', '8080:5432'])).toThrow(/requested twice/);
  });

  test('several assigned host ports do not collide with each other', () => {
    expect(parseForwardSpecs(['3000', '5432']).map(s => s.containerPort)).toEqual([3000, 5432]);
  });
});

describe('startForward', () => {
  test('an assigned host port is reported and carries bytes both ways', async () => {
    const spec = parseForwardSpec('3000');
    const forward = startForward(spec, () => echoChannel());
    try {
      expect(forward.hostPort).toBeGreaterThan(0);
      expect(await roundTrip(forward.hostPort, 'ping')).toBe('PING');
    } finally {
      forward.stop();
    }
  });

  test('the container port the channel is opened for is the one from the pair', async () => {
    const opened: number[] = [];
    const forward = startForward(parseForwardSpec('5432'), port => {
      opened.push(port);
      return echoChannel();
    });
    try {
      await roundTrip(forward.hostPort, 'hi');
      expect(opened).toEqual([5432]);
    } finally {
      forward.stop();
    }
  });

  // INVARIANT: loopback only, never 0.0.0.0. A forwarded port reaches whatever
  // the task is running; it is for the person driving the task, not for the
  // network the machine happens to be on.
  //
  // Asserted on the address the forwarder binds rather than by probing an
  // external interface: whether a wildcard bind collides with a loopback one is
  // an OS-specific answer (Linux refuses, macOS's SO_REUSEADDR lets it through),
  // so a probe would assert the platform, not the posture.
  test('the forwarder binds the same loopback address [serve] does', () => {
    expect(SERVE_BIND_HOST).toBe('127.0.0.1');
    const source = readFileSync(join(import.meta.dir, '../../src/serve/forward.ts'), 'utf-8');
    const binds = [...source.matchAll(/hostname:\s*([^,\n]+)/g)].map(m => m[1].trim());
    expect(binds).toEqual(['SERVE_BIND_HOST']);
  });

  test('a tunnel that cannot connect is reported once, in plain words', async () => {
    const messages: string[] = [];
    const forward = startForward(parseForwardSpec('3000'), () => refusedChannel(), {
      onTunnelError: (_spec, message) => messages.push(message),
    });
    try {
      await roundTrip(forward.hostPort, 'ping');
      await roundTrip(forward.hostPort, 'ping');
      // Both attempts fail, but a browser opening six connections should not
      // print the same line six times.
      await Bun.sleep(50);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Nothing is listening on port 3000');
      expect(messages[0]).toContain('Connection refused');
    } finally {
      forward.stop();
    }
  });

  test('a busy host port fails with the port named and a way out', () => {
    const squatter = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      expect(() => startForward(parseForwardSpec(`${squatter.port}:3000`), () => echoChannel()))
        .toThrow(new RegExp(`Cannot listen on 127.0.0.1:${squatter.port}`));
    } finally {
      squatter.stop(true);
    }
  });

  // INVARIANT: nothing a forward started outlives it. The whole reason this is
  // a foreground command with no registry is that stopping it is total.
  test('stop() releases the port and kills the tunnels it was carrying', async () => {
    let killed = 0;
    const forward = startForward(parseForwardSpec('3000'), () => {
      const channel = echoChannel();
      return { ...channel, kill: () => { killed++; channel.kill(); } };
    });
    const port = forward.hostPort;

    // Hold a connection open so stop() has something live to tear down.
    const held = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, close() {}, error() {} },
    });
    await held;
    await Bun.sleep(20);
    expect(forward.openConnections).toBe(1);

    forward.stop();
    expect(killed).toBeGreaterThan(0);
    expect(forward.openConnections).toBe(0);

    // The port is free again: re-binding it is the check that the listener is
    // really gone, not merely no longer referenced.
    const rebind = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    rebind.stop(true);
  });
});
