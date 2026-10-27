/**
 * `ssh -L 3000:web:3000` reaching the TASK's services from a member's own
 * container (docs/design/task-sessions-and-ssh.md §5, "Port forwards").
 *
 * A member container sits on an isolated bridge and the task's ports are
 * published only to the daemon host's loopback, so sshd inside it cannot reach
 * them itself. While an SSH connection is open, a small forwarder (lazy-agent
 * `service-forward`, ./service-forwarder.ts) listens in the member container on
 * {@link SERVICE_FORWARD_ADDR} at each declared service port, and the
 * connection's /etc/hosts maps every `[serve]` service name — and `services`,
 * for bare ports — to that address. Each accepted connection becomes a
 * WebSocket to THIS route on the daemon (over `host.docker.internal`, the
 * daemon address every container already reaches), which opens a raw TCP
 * connection to the service's published port. Raw TCP, so a database or a
 * debugger works, not only HTTP.
 *
 * The forwarder authenticates with a GRANT minted for one SSH connection
 * (task + member) and revoked when that connection ends — the same lifetime as
 * the SSH session that asked for it, and nothing else ever holds one. A grant
 * reaches only a port the project DECLARES in `[serve]`, on its own task, and
 * only while that task's container publishes it; nothing on this path starts a
 * container or runs a services command (../server/serve-proxy.ts's invariant).
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import type { Server, ServerWebSocket } from 'bun';
import type { Storage } from '../storage';
import type { WebSocketUpgrader, UpgradeOutcome } from '../server/ws';
import { getTaskServeState } from '../serve/discovery';
import type { ServicePort } from '../serve/ports';
import { loadConfig } from '../config/loader';
import { logger } from '../utils/logger';

import { SERVICE_FORWARD_ADDR, SERVICES_HOST_ALIAS, SERVICE_FORWARD_PATH } from './forward-constants';

export { SERVICE_FORWARD_ADDR, SERVICES_HOST_ALIAS, SERVICE_FORWARD_PATH };

export interface ForwardGrant {
  taskId: string;
  memberEmail: string;
}

const grants = new Map<string, ForwardGrant>();

/**
 * The forward sockets open under each grant. Revoking a grant closes them —
 * the WebSocket and the TCP connection behind it — so a forward never outlives
 * the SSH connection that was allowed to make it.
 */
const liveByGrant = new Map<string, Set<LiveForward>>();

interface LiveForward {
  close(reason: string): void;
}

/** More than this many bytes waiting for the service to read closes the forward. */
export const FORWARD_HIGH_WATER = 8 * 1024 * 1024;

/** Mint a grant for one SSH connection. Revoke it when the connection ends. */
export function mintForwardGrant(grant: ForwardGrant): string {
  const token = `lzfwd_${randomBytes(24).toString('hex')}`;
  grants.set(token, grant);
  return token;
}

export function revokeForwardGrant(token: string): void {
  grants.delete(token);
  const live = liveByGrant.get(token);
  liveByGrant.delete(token);
  for (const f of live ?? []) f.close('forward grant revoked');
}

/** How many forward sockets are open under a grant (for tests and logs). */
export function liveForwardCount(token: string): number {
  return liveByGrant.get(token)?.size ?? 0;
}

/** The grant a bearer token names, compared in constant time. */
export function lookupForwardGrant(token: string | null): ForwardGrant | null {
  if (!token) return null;
  const given = Buffer.from(token);
  for (const [known, grant] of grants) {
    const k = Buffer.from(known);
    if (k.length === given.length && timingSafeEqual(k, given)) return grant;
  }
  return null;
}

/** The project's declared services (root lazy.toml only). Empty when none or unreadable. */
export async function declaredServices(projectRoot: string): Promise<ServicePort[]> {
  try {
    const config = await loadConfig(projectRoot);
    return config.serve.services;
  } catch (err) {
    logger.warn(`ssh service forwards: could not read [serve]: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Host names the forwarder answers to: every valid service name, and `services`. */
export function serviceHostNames(services: ServicePort[]): string[] {
  const names = new Set<string>([SERVICES_HOST_ALIAS]);
  for (const s of services) if (/^[A-Za-z][A-Za-z0-9-]*$/.test(s.name)) names.add(s.name.toLowerCase());
  return [...names];
}

interface ForwardSocketData {
  target: { hostAddress: string; hostPort: number };
  label: string;
  /** The grant this forward was opened under — revoking it closes this. */
  grantToken: string;
  live?: LiveForward;
  tcp: import('bun').Socket<undefined> | null;
  /** Bytes the service has not taken yet (and, before it connects, `early`). */
  pending: Uint8Array[];
  pendingBytes: number;
  early: Uint8Array[];
  closed: boolean;
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export function createServiceForwardUpgrader(deps: {
  root: string;
  getStorage: () => Promise<Storage>;
  /**
   * Test seam: a task's live service bindings. Defaults to the daemon's ONE
   * serve resolution, which reads the runtime and never starts anything.
   */
  serveState?: typeof getTaskServeState;
  /** Test seam: {@link FORWARD_HIGH_WATER}. */
  highWater?: number;
}): WebSocketUpgrader {
  const highWater = deps.highWater ?? FORWARD_HIGH_WATER;
  const serveState = deps.serveState ?? getTaskServeState;
  // Only the GRANT's task is ever resolved: a forward cannot name another
  // task, so another task's service is unreachable through it by construction.
  const resolveBinding = async (grant: ForwardGrant, port: number): Promise<{ hostAddress: string; hostPort: number } | { error: string; status: number }> => {
    const storage = await deps.getStorage();
    const task = await storage.getTask(grant.taskId);
    if (!task) return { status: 404, error: 'task not found' };
    const session = await storage.getSessionByTaskId(task.id);
    const state = await serveState(deps.root, task, session);
    if (state.unavailable) return { status: 409, error: `the task's services are not available (${state.unavailable})` };
    const service = state.services.find((s) => s.port === port);
    if (!service) return { status: 403, error: `port ${port} is not a declared service of this task` };
    if (!service.binding) return { status: 409, error: `service ${service.name} (port ${port}) is not published by the task's container — restart the task's environment so it publishes the port` };
    return { hostAddress: service.binding.hostAddress, hostPort: service.binding.hostPort };
  };

  const handler = {
    open(ws: ServerWebSocket<ForwardSocketData>) {
      const d = ws.data;
      // A grant revoked between the upgrade and now: nothing opens.
      if (!grants.has(d.grantToken)) {
        try { ws.close(1008, 'forward grant revoked'); } catch (err) { void err; }
        return;
      }
      d.live = {
        close(reason: string) {
          d.closed = true;
          try { ws.close(1008, reason); } catch (err) { void err; }
          d.tcp?.end();
        },
      };
      let set = liveByGrant.get(d.grantToken);
      if (!set) liveByGrant.set(d.grantToken, (set = new Set()));
      set.add(d.live);
      void Bun.connect({
        hostname: d.target.hostAddress,
        port: d.target.hostPort,
        socket: {
          open(sock) {
            if (d.closed) { sock.end(); return; }
            d.tcp = sock;
            const early = d.early;
            d.early = [];
            d.pendingBytes = 0;
            for (const b of early) writeTcp(d, b);
          },
          data(_sock, bytes) {
            try {
              if (ws.sendBinary(bytes) === 0) ws.close(1011, 'forward backlog');
            } catch (err) {
              logger.debug(`ssh service forward relay failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
          drain() { flushTcp(d); },
          close() {
            // A close the route itself decided has already said why.
            if (d.closed) return;
            d.closed = true;
            try { ws.close(1000, 'service closed'); } catch (err) { void err; }
          },
          error(_sock, err) {
            logger.debug(`ssh service forward ${d.label}: ${err instanceof Error ? err.message : String(err)}`);
          },
        },
      }).catch((err) => {
        logger.info(`ssh service forward ${d.label} could not connect: ${err instanceof Error ? err.message : String(err)}`);
        try { ws.close(1011, 'service unreachable'); } catch (e) { void e; }
      });
    },
    message(ws: ServerWebSocket<ForwardSocketData>, message: string | Buffer) {
      if (typeof message === 'string') return;
      const d = ws.data;
      const bytes = new Uint8Array(message);
      if (d.closed) return;
      // The service is not keeping up (or not connected yet): past the
      // high-water mark the forward is closed rather than buffered without
      // bound — Bun cannot pause reading a WebSocket.
      if (d.pendingBytes + bytes.length > highWater) {
        logger.info(`ssh service forward ${d.label}: closed, more than ${highWater} bytes waiting for the service`);
        d.closed = true;
        try { ws.close(1009, 'service not keeping up'); } catch (err) { void err; }
        d.tcp?.end();
        return;
      }
      if (!d.tcp) {
        d.early.push(bytes);
        d.pendingBytes += bytes.length;
      } else writeTcp(d, bytes);
    },
    close(ws: ServerWebSocket<ForwardSocketData>) {
      ws.data.closed = true;
      ws.data.tcp?.end();
      if (ws.data.live) liveByGrant.get(ws.data.grantToken)?.delete(ws.data.live);
    },
  };

  return {
    handler: handler as unknown as import('bun').WebSocketHandler<unknown>,
    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      if (url.pathname !== SERVICE_FORWARD_PATH) return null;
      const auth = req.headers.get('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      const grant = lookupForwardGrant(token);
      if (!grant) return refuse(401, 'no valid forward grant');
      if (req.method !== 'GET') return refuse(405, 'Method not allowed');
      const port = Number(url.searchParams.get('port'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(400, 'port must be 1-65535');
      const binding = await resolveBinding(grant, port);
      if ('error' in binding) {
        // The forwarder tells the person (./service-forwarder.ts); this is for
        // whoever runs the daemon. Logged on the upgrade only: the plain GET
        // that follows is the forwarder re-asking for the reason in words.
        const upgrading = (req.headers.get('upgrade') ?? '').toLowerCase().includes('websocket');
        if (upgrading) logger.info(`ssh service forward ${grant.memberEmail} → task ${grant.taskId.slice(0, 8)}:${port} refused (${binding.status}): ${binding.error}`);
        return refuse(binding.status, binding.error);
      }
      const data: ForwardSocketData = {
        target: binding,
        label: `${grant.memberEmail} → task ${grant.taskId.slice(0, 8)}:${port}`,
        grantToken: token!,
        tcp: null,
        pending: [],
        pendingBytes: 0,
        early: [],
        closed: false,
      };
      if (!server.upgrade(req, { data })) return refuse(426, 'Expected a WebSocket upgrade request.');
      return 'upgraded';
    },
  };
}

function writeTcp(d: ForwardSocketData, bytes: Uint8Array): void {
  if (!d.tcp || d.closed) return;
  if (d.pending.length > 0) {
    d.pending.push(bytes);
    d.pendingBytes += bytes.length;
    return;
  }
  const sent = d.tcp.write(bytes);
  if (sent < bytes.length) {
    const rest = bytes.subarray(Math.max(0, sent));
    d.pending.push(rest);
    d.pendingBytes += rest.length;
  }
}

function flushTcp(d: ForwardSocketData): void {
  while (d.tcp && !d.closed && d.pending.length > 0) {
    const head = d.pending[0]!;
    const sent = d.tcp.write(head);
    if (sent < head.length) {
      d.pending[0] = head.subarray(Math.max(0, sent));
      d.pendingBytes -= Math.max(0, sent);
      return;
    }
    d.pending.shift();
    d.pendingBytes -= head.length;
  }
}
