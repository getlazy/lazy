/**
 * The network routes between the host and a solo smolvm project machine
 * (docs/design/ic-mode-smolvm-shape.md, shape (b): the daemon stays on the
 * host, task containers run on the machine's dockerd).
 *
 * smolvm gives a machine exactly two holes in its network boundary, both fixed
 * when the machine is created and recorded with it:
 *
 *   - ONE guest-to-host mapping, `SMOLVM_GUEST_HOST_SERVICE=<guest port>:<host
 *     port>`: the guest reaches the gateway address (100.96.0.1) on the guest
 *     port and lands on this host's loopback host port. Nothing else on the
 *     host is reachable from the guest — the egress policy (public CIDRs only,
 *     strict floor) is unchanged (probes S7/S8; S21 reached it from a container
 *     on the guest's docker bridge).
 *   - Published ports, host loopback → the guest's link address, which smolvm
 *     can only add while the machine is STOPPED. A new task service port can
 *     therefore never be published on a running machine without killing every
 *     task in it, so lazy publishes ONE port at create.
 *
 * Over those two holes run:
 *
 *   CALLBACKS (guest → host). A task container dials `host.docker.internal:<daemon
 *   port>` (its MCP config, the supervisor's daemon calls) and
 *   `host.docker.internal:<proxy port>` (model traffic with a placeholder
 *   credential). `--add-host …:host-gateway` makes that name the guest's docker
 *   bridge gateway, unchanged from the docker runner. A relay in the guest
 *   listens there on each of those ports and sends every connection through the
 *   one mapping with a first line naming its route; on the host the ROUTE MUX
 *   ({@link startRouteMux}), in the daemon, reads that line and connects to the
 *   daemon or the proxy on loopback. It can reach nothing else: the line picks
 *   between those two targets, and any other line closes the connection.
 *   Credentials stay on the host; containers keep their placeholders.
 *
 *   SERVICES (host → guest). Docker publishes a task's `[serve]` ports on the
 *   GUEST's loopback (`127.0.0.1:0:<port>`, as everywhere). The serve proxy,
 *   `lazy url` and the dashboard need a host address, so for each guest port
 *   the daemon opens a SERVICE TUNNEL ({@link ServiceTunnels}): a loopback
 *   listener whose every connection goes to the machine's one published port
 *   with a first line naming the guest port and the machine's services secret
 *   (`LAZY-PORT <secret> <n>`) — every container can reach the router, so
 *   the secret is what keeps one container off another's ports; the router in
 *   the guest connects to `127.0.0.1:<n>` there.
 *
 * The guest half of both is src/vm/solo-guest-relays.sh, run by the host after
 * every bring-up.
 */
import { randomBytes } from 'crypto';
import { createServer, connect, type Server, type Socket } from 'net';
import { logger } from '../utils/logger';
import RELAYS_SCRIPT from './solo-guest-relays.sh' with { type: 'text' };
import { SOLO_DEFAULTS } from './smolvm-docker-machine';

export { RELAYS_SCRIPT };

/** The callback routes a task container uses, by the name its first line carries. */
export type CallbackRoute = 'daemon' | 'proxy';
export const CALLBACK_ROUTES: readonly CallbackRoute[] = ['daemon', 'proxy'];

/** Where on the host each callback route lands; null while it is not listening. */
export type CallbackTargets = Record<CallbackRoute, { host: string; port: number } | null>;

/** The guest side's fixed numbers (smolvm-docker-machine.json `solo`). */
export const SOLO_ROUTE_FACTS = Object.freeze({
  guestGateway: SOLO_DEFAULTS.guestGateway,
  hostServiceGuestPort: SOLO_DEFAULTS.hostServiceGuestPort,
  servicesGuestPort: SOLO_DEFAULTS.servicesGuestPort,
});

/** The guest directory the relays keep their pid, spec and route scripts in (tmpfs). */
export const GUEST_RELAY_DIR = '/run/lazy-solo';

/** A route line is short; anything longer before a newline is not ours. */
const MAX_ROUTE_LINE = 64;
/** How long a connection may take to send its route line. */
const ROUTE_LINE_TIMEOUT_MS = 10_000;

/**
 * `sh -c <script> …` for the guest relays, as one `machine exec` argv. Callback
 * routes are left out when this process does not know where they land (only
 * the daemon does); the services router never needs that.
 */
export function guestRelayArgv(callbackPorts: Partial<Record<CallbackRoute, number>> | null, servicesSecret: string): string[] {
  const routes = callbackPorts
    ? CALLBACK_ROUTES.flatMap((r) => (callbackPorts[r] ? [r, String(callbackPorts[r])] : []))
    : [];
  return [
    'sh', '-c', RELAYS_SCRIPT, 'lazy-solo-relays',
    GUEST_RELAY_DIR, SOLO_ROUTE_FACTS.guestGateway,
    String(SOLO_ROUTE_FACTS.hostServiceGuestPort), String(SOLO_ROUTE_FACTS.servicesGuestPort),
    servicesSecret,
    ...routes,
  ];
}

/** `127.0.0.1` for a wildcard or empty bind; the bind address otherwise. */
export function dialableHost(bind: string | undefined): string {
  return !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
}

/**
 * Read one `\n`-terminated line (at most {@link MAX_ROUTE_LINE} bytes) from a
 * paused socket, then hand back the bytes that followed it. Rejects on a
 * longer line, an early close, or the timeout.
 */
function readRouteLine(sock: Socket): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('no route line in time')), ROUTE_LINE_TIMEOUT_MS);
    const finish = (err: Error | null, value?: { line: string; rest: Buffer }) => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('error', onEnd);
      sock.pause();
      if (err) reject(err);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) finish(null, { line: buf.subarray(0, nl).toString('utf8').replace(/\r$/, ''), rest: buf.subarray(nl + 1) });
      else if (buf.length > MAX_ROUTE_LINE) finish(new Error('route line too long'));
    };
    const onEnd = () => finish(new Error('closed before a route line'));
    sock.on('data', onData);
    sock.once('end', onEnd);
    sock.once('error', onEnd);
    sock.resume();
  });
}

/** Splice two sockets both ways; either side ending or failing tears both down. */
function splice(a: Socket, b: Socket): void {
  const down = () => { a.destroy(); b.destroy(); };
  a.on('error', down);
  b.on('error', down);
  a.on('close', down);
  b.on('close', down);
  a.pipe(b);
  b.pipe(a);
  a.resume();
  b.resume();
}

/**
 * Give an accepted connection its teardown BEFORE anything asynchronous: a
 * client that resets while its upstream is still being dialed emits 'error'
 * with no other listener attached yet, and an unhandled socket 'error' is an
 * uncaught exception — in the daemon, a crash.
 */
function guardClient(sock: Socket, what: string): void {
  sock.on('error', (err) => {
    logger.debug(`${what}: client connection failed: ${err.message}`);
    sock.destroy();
  });
}

/** Splice once the upstream is up — unless the client went away meanwhile, when the upstream is dropped. */
function spliceIfClientAlive(sock: Socket, upstream: Socket, first?: Buffer | string): void {
  if (sock.destroyed) { upstream.destroy(); return; }
  if (first !== undefined && first.length) upstream.write(first);
  splice(sock, upstream);
}

/** Opens a connection to `host:port`; injectable so tests can make it slow. */
export type Dialer = (host: string, port: number) => Promise<Socket>;

/** Connect to `host:port`, resolving with the socket once connected. */
function dial(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port, allowHalfOpen: true });
    s.pause();
    s.once('connect', () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

export interface RouteMuxHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * The host half of the callbacks: a loopback listener on the machine's
 * recorded host-service port. Each connection's first line names a route
 * (`LAZY-ROUTE daemon` / `LAZY-ROUTE proxy`); the mux connects to where
 * `targets()` says that route lands right now and splices the rest of the
 * connection through. Any other line, or a route that is not listening, closes
 * the connection — the mux reaches nothing but the daemon and its proxy, both
 * of which every local process can reach on loopback already.
 */
export async function startRouteMux(port: number, targets: () => CallbackTargets, dialer: Dialer = dial): Promise<RouteMuxHandle> {
  const server: Server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (sock) => {
    guardClient(sock, 'smolvm route mux');
    void (async () => {
      let line: string;
      let rest: Buffer;
      try { ({ line, rest } = await readRouteLine(sock)); }
      catch (err) {
        logger.debug(`smolvm route mux: dropped a connection: ${(err as Error).message}`);
        sock.destroy();
        return;
      }
      const route = /^LAZY-ROUTE ([a-z]+)$/.exec(line)?.[1] as CallbackRoute | undefined;
      const target = route && CALLBACK_ROUTES.includes(route) ? targets()[route] : null;
      if (!target) {
        logger.debug(`smolvm route mux: no route for ${JSON.stringify(line.slice(0, MAX_ROUTE_LINE))}`);
        sock.destroy();
        return;
      }
      let upstream: Socket;
      try { upstream = await dialer(target.host, target.port); }
      catch (err) {
        logger.warn(`smolvm route mux: a task container's ${route} connection could not reach ${target.host}:${target.port}: ${(err as Error).message}`);
        sock.destroy();
        return;
      }
      spliceIfClientAlive(sock, upstream, rest);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Tunnel { server: Server; port: number; handedOutAt: number; open: number }

/** A tunnel not handed out for this long, with no connection open, is closed. */
const TUNNEL_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * The host half of services: one loopback listener per (published machine
 * port, guest port), opened on demand and kept while it is used. Its address
 * is what `lazy url --direct`, the dashboard and the serve proxy connect to.
 *
 * Tunnels are per process — the daemon's live as long as the daemon — and
 * keyed by guest port, so a container recreated on the same guest port gets
 * the same host port.
 */
export class ServiceTunnels {
  private readonly tunnels = new Map<string, Promise<Tunnel>>();

  constructor(private readonly now: () => number = Date.now, private readonly dialer: Dialer = dial) {}

  /** The host port that reaches guest-loopback `guestPort` through the machine's published `servicesHostPort`. */
  async open(servicesHostPort: number, guestPort: number, secret: string): Promise<number> {
    await this.sweep();
    const key = `${servicesHostPort}:${guestPort}:${secret}`;
    let entry = this.tunnels.get(key);
    if (!entry) {
      entry = this.listen(servicesHostPort, guestPort, secret);
      this.tunnels.set(key, entry);
      entry.catch(() => this.tunnels.delete(key));
    }
    const tunnel = await entry;
    tunnel.handedOutAt = this.now();
    return tunnel.port;
  }

  /** Close every tunnel (tests, and a process that is going away). */
  async closeAll(): Promise<void> {
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const t of all) {
      try { const tunnel = await t; await new Promise<void>((r) => tunnel.server.close(() => r())); }
      catch { /* a tunnel that never listened has nothing to close */ }
    }
  }

  private async sweep(): Promise<void> {
    for (const [key, entry] of this.tunnels) {
      const tunnel = await entry.catch(() => null);
      if (tunnel && tunnel.open === 0 && this.now() - tunnel.handedOutAt > TUNNEL_IDLE_MS) {
        this.tunnels.delete(key);
        tunnel.server.close();
      }
    }
  }

  private async listen(servicesHostPort: number, guestPort: number, secret: string): Promise<Tunnel> {
    const tunnel: Tunnel = { server: null as unknown as Server, port: 0, handedOutAt: this.now(), open: 0 };
    tunnel.server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (sock) => {
      tunnel.open++;
      sock.once('close', () => { tunnel.open--; });
      guardClient(sock, 'smolvm service tunnel');
      this.dialer('127.0.0.1', servicesHostPort).then((upstream) => {
        spliceIfClientAlive(sock, upstream, `LAZY-PORT ${secret} ${guestPort}\n`);
      }, (err: Error) => {
        logger.debug(`smolvm service tunnel: the machine's services port ${servicesHostPort} refused a connection for guest port ${guestPort}: ${err.message}`);
        sock.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      tunnel.server.once('error', reject);
      tunnel.server.listen(0, '127.0.0.1', () => { tunnel.server.off('error', reject); resolve(); });
    });
    tunnel.server.unref();
    const address = tunnel.server.address();
    tunnel.port = typeof address === 'object' && address ? address.port : 0;
    return tunnel;
  }
}

/** A new services secret: 32 random bytes as hex. */
export function newServicesSecret(): string {
  return randomBytes(32).toString('hex');
}

/** A free loopback port right now (it can be taken before it is used; callers retry). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}
