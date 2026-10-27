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
  /** The client's first bytes, kept to tell an HTTP client from raw TCP. */
  head: Uint8Array | null;
  /** Whether the daemon has sent the client anything yet. */
  answered: boolean;
  /** Set once the connection is being torn down, so it is reported once. */
  done: boolean;
}

function log(message: string): void {
  process.stderr.write(`lazy-ssh: service-forward: ${message}\n`);
}

const HTTP_METHOD = /^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS|CONNECT|TRACE) \S/;

/** Whether a client's first bytes are an HTTP/1.x request line. */
export function looksLikeHttp(head: Uint8Array | null): boolean {
  if (!head) return false;
  return HTTP_METHOD.test(new TextDecoder().decode(head.subarray(0, 16)));
}

/** The minimal response an HTTP client gets when lazy could not forward it. */
export function httpRefusal(reason: string): string {
  const body = `lazy could not forward this connection: ${reason}\n`;
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

/**
 * Why the daemon refused the upgrade. A WebSocket client never sees the
 * refused response, so the same request is made again without the upgrade:
 * the route runs the same checks in the same order and answers the refusal in
 * words (or 426 when every check passed and only the upgrade itself failed).
 */
export async function diagnoseRefusal(httpUrl: string, token: string): Promise<string> {
  try {
    const res = await fetch(httpUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    const text = (await res.text()).trim();
    if (res.status === 426) return 'the forward to the daemon failed';
    return text ? `${text} (${res.status})` : `the daemon refused the forward (${res.status})`;
  } catch (err) {
    return `the daemon could not be reached (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Relay one accepted TCP connection to the daemon. */
function bridge(sock: import('bun').Socket<ConnState>, base: string, token: string, port: number): void {
  const httpUrl = `${base.replace(/\/$/, '')}${SERVICE_FORWARD_PATH}?port=${port}`;
  const ws = new WebSocket(httpUrl.replace(/^http/, 'ws'), { headers: { Authorization: `Bearer ${token}` } } as never);
  ws.binaryType = 'arraybuffer';
  sock.data.ws = ws;
  let opened = false;
  // Nothing has reached the client yet: say why, in the log and — for an
  // HTTP client only, raw TCP stays raw — in a response it can show.
  const fail = async (reason: string | null) => {
    if (sock.data.done) return;
    sock.data.done = true;
    if (!sock.data.answered) {
      const why = reason ?? await diagnoseRefusal(httpUrl, token);
      log(`port ${port}: ${why}`);
      if (looksLikeHttp(sock.data.head)) sock.write(httpRefusal(why));
    }
    sock.end();
  };
  ws.onopen = () => {
    opened = true;
    for (const b of sock.data.early) ws.send(b);
    sock.data.early = [];
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    sock.data.answered = true;
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (sock.data.pending.length > 0) {
      sock.data.pending.push(bytes);
      return;
    }
    const sent = sock.write(bytes);
    if (sent < bytes.length) sock.data.pending.push(bytes.subarray(Math.max(0, sent)));
  };
  ws.onclose = (ev) => {
    if (!opened) return void fail(null);
    // A service that accepted and closed is an answer, not a failure.
    if (ev.code === 1000) {
      sock.data.done = true;
      return void sock.end();
    }
    void fail(ev.reason || `the forward closed (${ev.code})`);
  };
  ws.onerror = () => { if (!opened) void fail(null); };
}

/**
 * The listening socket's handlers for one forwarded port — exported so a
 * test can run them on an address of its own.
 */
export function forwardSocketHandlers(base: string, token: string, port: number): import('bun').SocketHandler<ConnState> {
  return {
    open(sock) {
      sock.data = { ws: null, early: [], pending: [], head: null, answered: false, done: false };
      bridge(sock, base, token, port);
    },
    data(sock, bytes) {
      if (!sock.data.head) sock.data.head = new Uint8Array(bytes);
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
    close(sock) { sock.data.done = true; sock.data.ws?.close(); },
    error(sock) { sock.data.done = true; sock.data.ws?.close(); },
  };
}

/** Run until killed. Returns only when there is nothing to forward. */
export async function runServiceForwarder(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const base = env[FORWARD_ENV.url];
  const token = env[FORWARD_ENV.token];
  const ports = (env[FORWARD_ENV.ports] ?? '').split(',').map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!base || !token || ports.length === 0) return 0;

  const listenOn = (port: number) => {
    try {
      Bun.listen<ConnState>({ hostname: SERVICE_FORWARD_ADDR, port, socket: forwardSocketHandlers(base, token, port) });
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
