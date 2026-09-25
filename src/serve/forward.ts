/**
 * `lazy forward` — on-demand, loopback-only port forwarding into a task's
 * environment, for exactly as long as the command runs.
 *
 * The complement to `[serve]` (see ./ports.ts). `[serve]` publishes ports when a
 * container is CREATED: permanent, declared per project, and fixed for the
 * container's life. That is the right shape for the ports a project always
 * serves on, and the wrong shape for "I want to poke at the postgres inside this
 * one task for five minutes" — which is what this is.
 *
 * Neither docker nor podman can add a published port to a RUNNING container, so
 * this cannot be a runtime call. It is a host-side forwarder living in the CLI
 * process: a loopback listener per pair, and one exec into the environment per
 * accepted connection, piping bytes both ways. When the command ends, every
 * listener is closed and every exec killed — nothing survives it, by
 * construction, because nothing was ever registered anywhere.
 *
 * The engine here is deliberately ignorant of containers: it takes an
 * `OpenChannel` that turns a container port into a byte pipe. The runtime detail
 * (`docker exec -i <name> socat STDIO TCP:127.0.0.1:<port>`) lives behind the
 * Runner, and tests supply their own channel.
 */

import { SERVE_BIND_HOST } from './ports';

/** One `<host-port>:<container-port>` pair to forward. */
export interface ForwardSpec {
  /** Host port to listen on. 0 means "let the OS assign one". */
  hostPort: number;
  /** Port to connect to inside the task environment. */
  containerPort: number;
  /** The pair exactly as the user typed it, for error messages. */
  raw: string;
}

/** A byte pipe into the task environment — one per accepted connection. */
export interface ForwardChannel {
  /** Bytes from the host connection, headed into the environment. */
  write(chunk: Uint8Array): void;
  /** No more host bytes are coming. */
  end(): void;
  /** Bytes coming back out of the environment. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Diagnostics from the tunnel process itself (not the forwarded stream). */
  readonly stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with the tunnel's exit code when it ends. */
  readonly exited: Promise<number | null>;
  /** Tear the tunnel down now. */
  kill(): void;
}

/** Opens one byte pipe to `containerPort` inside the task environment. */
export type OpenChannel = (containerPort: number) => ForwardChannel;

/** A listener that is up and forwarding. */
export interface ActiveForward {
  spec: ForwardSpec;
  /** The host port actually bound — the resolved one when the spec said 0. */
  hostPort: number;
  /** Close the listener and kill every connection it is still carrying. */
  stop(): void;
  /** Connections currently open through this forward. */
  readonly openConnections: number;
}

const MAX_PORT = 65535;

/**
 * Parse one `<host>:<container>` or bare `<container>` argument.
 *
 * Bare form means "assign me a host port" — the same posture `[serve]` takes,
 * and the one that cannot collide with anything already on the machine. Throws
 * with an actionable message; a typo'd pair is a typo, not a thing to guess at.
 */
export function parseForwardSpec(raw: string): ForwardSpec {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(
      `Empty port pair. Each argument is <host-port>:<container-port>, or just ` +
      `<container-port> to have a host port assigned.`,
    );
  }

  const parts = trimmed.split(':');
  if (parts.length > 2) {
    throw new Error(
      `"${raw}" is not a port pair. Write <host-port>:<container-port> (e.g. 8080:3000), ` +
      `or just <container-port> (e.g. 3000) to have a host port assigned.`,
    );
  }

  const port = (text: string, what: string, allowZero: boolean): number => {
    if (!/^\d+$/.test(text)) {
      throw new Error(
        `"${raw}": ${what} must be a number, got "${text}". Write ` +
        `<host-port>:<container-port> (e.g. 8080:3000), or just <container-port>.`,
      );
    }
    const value = Number(text);
    const min = allowZero ? 0 : 1;
    if (value < min || value > MAX_PORT) {
      throw new Error(`"${raw}": ${what} ${value} is out of range — must be between ${min} and ${MAX_PORT}.`);
    }
    return value;
  };

  if (parts.length === 1) {
    return { hostPort: 0, containerPort: port(parts[0], 'the port', false), raw: trimmed };
  }
  return {
    // 0 is spelled out as well as implied: `0:3000` is the explicit way to say
    // "assign one", and refusing it would be a pointless surprise.
    hostPort: port(parts[0], 'the host port', true),
    containerPort: port(parts[1], 'the container port', false),
    raw: trimmed,
  };
}

/**
 * Parse every pair, rejecting a host port claimed twice.
 *
 * Two listeners cannot share a port, and finding that out from the second
 * `EADDRINUSE` — after the first forward is already up and printed — reads like
 * a machine problem rather than the typo it is.
 */
export function parseForwardSpecs(raws: string[]): ForwardSpec[] {
  const specs = raws.map(parseForwardSpec);
  const claimed = new Map<number, string>();
  for (const spec of specs) {
    if (spec.hostPort === 0) continue;
    const owner = claimed.get(spec.hostPort);
    if (owner !== undefined) {
      throw new Error(
        `Host port ${spec.hostPort} is requested twice ("${owner}" and "${spec.raw}"). ` +
        `One host port can only forward to one container port.`,
      );
    }
    claimed.set(spec.hostPort, spec.raw);
  }
  return specs;
}

/** Per-connection state carried on the socket. */
interface Conn {
  channel: ForwardChannel;
  /** Set once either side has gone away, so pumps stop rather than throw. */
  done: boolean;
  /** Resolver for the current backpressure wait, if any. */
  drain: (() => void) | null;
}

/** Optional narration for a running forward. */
export interface ForwardHooks {
  /**
   * A tunnel process failed. `message` is already human-readable and one line;
   * the command decides how loudly to say it.
   */
  onTunnelError?(spec: ForwardSpec, message: string): void;
}

/**
 * Bind `spec.hostPort` on loopback and forward every connection into the task
 * environment via `open`.
 *
 * Loopback only, never `0.0.0.0`: the same posture as `[serve]` and the daemon
 * itself. A forwarded port reaches whatever the task is running, with none of
 * the network's opinions about who may connect — that is for the person driving
 * the task, not for the café wifi.
 *
 * Throws if the host port cannot be bound, with the reason spelled out.
 */
export function startForward(
  spec: ForwardSpec,
  open: OpenChannel,
  hooks: ForwardHooks = {},
): ActiveForward {
  const conns = new Set<Conn>();
  /** Tunnel failures already reported, so a browser's six parallel connections say it once. */
  const reported = new Set<string>();

  let server: Bun.TCPSocketListener<Conn>;
  try {
    server = Bun.listen<Conn>({
      hostname: SERVE_BIND_HOST,
      port: spec.hostPort,
      socket: {
        open(socket) {
          const channel = open(spec.containerPort);
          const conn: Conn = { channel, done: false, drain: null };
          socket.data = conn;
          conns.add(conn);

          void pumpToSocket(socket, conn);
          void watchTunnel(socket, conn);
        },
        data(socket, chunk) {
          const conn = socket.data;
          if (!conn || conn.done) return;
          try {
            conn.channel.write(chunk);
          } catch {
            // The tunnel died between accept and this write. Nothing to salvage:
            // drop the connection and let watchTunnel report why.
            teardown(socket.data, () => socket.end());
          }
        },
        drain(socket) {
          const conn = socket.data;
          const resume = conn?.drain;
          if (resume) {
            conn.drain = null;
            resume();
          }
        },
        close(socket) {
          teardown(socket.data, null);
        },
        error(socket, _err) {
          teardown(socket.data, null);
        },
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (spec.hostPort !== 0) {
      throw new Error(
        `Cannot listen on ${SERVE_BIND_HOST}:${spec.hostPort} — ${reason}. ` +
        `Something else on this machine is probably using that port: pick another ` +
        `host port, or write just "${spec.containerPort}" to have one assigned.`,
      );
    }
    throw new Error(`Cannot open a loopback listener for "${spec.raw}" — ${reason}.`);
  }

  function teardown(conn: Conn | undefined, after: (() => void) | null): void {
    if (!conn || conn.done) return;
    conn.done = true;
    conn.drain?.();
    conn.drain = null;
    conns.delete(conn);
    try {
      conn.channel.kill();
    } catch {
      // Already exited — killing a dead tunnel is the expected case on a clean
      // close, not an error worth surfacing.
    }
    after?.();
  }

  /** Environment → host, honouring the socket's backpressure. */
  async function pumpToSocket(socket: Bun.Socket<Conn>, conn: Conn): Promise<void> {
    const reader = conn.channel.stdout.getReader();
    try {
      while (!conn.done) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        let buf = value;
        while (buf.length > 0 && !conn.done) {
          const written = socket.write(buf);
          if (written >= buf.length) break;
          buf = buf.subarray(Math.max(written, 0));
          await new Promise<void>(resolve => {
            conn.drain = resolve;
          });
        }
      }
    } catch {
      // The socket or the tunnel went away mid-copy. Both are ordinary ends of a
      // forwarded connection; teardown below is the whole response.
    } finally {
      reader.releaseLock();
      if (!conn.done) {
        // The environment side closed first: end the host side so the client
        // sees a clean EOF rather than a hang.
        try {
          socket.end();
        } catch {
          // Socket already gone; nothing to end.
        }
      }
      teardown(conn, null);
    }
  }

  /** Report a tunnel that failed, once per distinct message. */
  async function watchTunnel(socket: Bun.Socket<Conn>, conn: Conn): Promise<void> {
    const stderrText = conn.channel.stderr
      ? await new Response(conn.channel.stderr).text().catch(() => '')
      : '';
    const code = await conn.channel.exited;
    if (code === 0 || code === null) return;

    const detail = stderrText.trim().split('\n').filter(Boolean).pop() ?? '';
    const message =
      `Nothing is listening on port ${spec.containerPort} inside the task, or the ` +
      `connection was refused` + (detail ? ` (${detail})` : '') + '.';
    if (!reported.has(message)) {
      reported.add(message);
      hooks.onTunnelError?.(spec, message);
    }
    teardown(conn, null);
  }

  return {
    spec,
    hostPort: server.port,
    get openConnections() {
      return conns.size;
    },
    stop() {
      for (const conn of [...conns]) teardown(conn, null);
      server.stop(true);
    },
  };
}
