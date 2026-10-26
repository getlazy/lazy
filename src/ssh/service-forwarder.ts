/**
 * `lazy-agent service-forward` — the in-container half of reaching a task's
 * services over `ssh -L` from a member's own container (./service-forward.ts
 * is the daemon half and explains why it exists).
 *
 * Started by an SSH connection's wrapper (./sshd-command.ts) and killed when
 * that connection ends. It listens on {@link SERVICE_FORWARD_ADDR} at every
 * declared service port and turns each accepted connection into a WebSocket
 * to the daemon carrying the connection's grant; bytes are relayed verbatim.
 *
 * Several SSH connections may be open at once, each starting one of these: the
 * first to bind a port serves it, and the others retry the bind every few
 * seconds, so a port stays served while ANY connection lives.
 */

import { SERVICE_FORWARD_ADDR, SERVICE_FORWARD_PATH, FORWARD_ENV } from './forward-constants';

const RETRY_MS = 3_000;
const SEND_HIGH_WATER = 4 * 1024 * 1024;

interface ConnState {
  ws: WebSocket | null;
  early: Uint8Array[];
  pending: Uint8Array[];
}

function log(message: string): void {
  process.stderr.write(`lazy-ssh: service-forward: ${message}\n`);
}

/** Relay one accepted TCP connection to the daemon. */
function bridge(sock: import('bun').Socket<ConnState>, base: string, token: string, port: number): void {
  const url = `${base.replace(/^http/, 'ws').replace(/\/$/, '')}${SERVICE_FORWARD_PATH}?port=${port}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as never);
  ws.binaryType = 'arraybuffer';
  sock.data.ws = ws;
  ws.onopen = () => {
    for (const b of sock.data.early) ws.send(b);
    sock.data.early = [];
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (sock.data.pending.length > 0) {
      sock.data.pending.push(bytes);
      return;
    }
    const sent = sock.write(bytes);
    if (sent < bytes.length) sock.data.pending.push(bytes.subarray(Math.max(0, sent)));
  };
  ws.onclose = () => sock.end();
  ws.onerror = () => sock.end();
}

/** Run until killed. Returns only when there is nothing to forward. */
export async function runServiceForwarder(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const base = env[FORWARD_ENV.url];
  const token = env[FORWARD_ENV.token];
  const ports = (env[FORWARD_ENV.ports] ?? '').split(',').map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!base || !token || ports.length === 0) return 0;

  const listenOn = (port: number) => {
    try {
      Bun.listen<ConnState>({
        hostname: SERVICE_FORWARD_ADDR,
        port,
        socket: {
          open(sock) {
            sock.data = { ws: null, early: [], pending: [] };
            bridge(sock, base, token, port);
          },
          data(sock, bytes) {
            const ws = sock.data.ws;
            if (!ws || ws.readyState === 0) {
              sock.data.early.push(new Uint8Array(bytes));
              return;
            }
            if (ws.readyState === 1) ws.send(new Uint8Array(bytes));
            if (ws.bufferedAmount > SEND_HIGH_WATER) {
              // Hold the client's bytes until the socket to the daemon catches up.
              sock.pause?.();
              const wait = setInterval(() => {
                if (ws.readyState !== 1 || ws.bufferedAmount <= SEND_HIGH_WATER) {
                  clearInterval(wait);
                  sock.resume?.();
                }
              }, 5);
            }
          },
          drain(sock) {
            while (sock.data.pending.length > 0) {
              const head = sock.data.pending[0]!;
              const sent = sock.write(head);
              if (sent < head.length) {
                sock.data.pending[0] = head.subarray(Math.max(0, sent));
                return;
              }
              sock.data.pending.shift();
            }
          },
          close(sock) { sock.data.ws?.close(); },
          error(sock) { sock.data.ws?.close(); },
        },
      });
    } catch (err) {
      // Another connection's forwarder holds it, or the port is privileged:
      // try again later rather than give up while this connection lives.
      const why = err instanceof Error ? err.message : String(err);
      if (!/EADDRINUSE|in use/i.test(why)) log(`port ${port}: ${why}`);
      setTimeout(() => listenOn(port), RETRY_MS);
    }
  };
  for (const port of ports) listenOn(port);
  await new Promise<never>(() => {});
  return 0;
}
