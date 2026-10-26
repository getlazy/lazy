/**
 * The daemon's `/ssh-forward/ws` route (src/ssh/service-forward.ts): what an
 * SSH connection's in-container forwarder uses to reach the TASK's services.
 *
 * A real Bun server carries the upgrader, a real TCP server stands in for the
 * task's published service port, and the serve resolution is a seam that
 * records which task it was asked about — the route's only runtime read, and
 * one that never starts anything.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import type { Task, Session } from '../../src/types';
import type { TaskServeState } from '../../src/serve/discovery';
import {
  createServiceForwardUpgrader,
  mintForwardGrant,
  revokeForwardGrant,
  liveForwardCount,
  SERVICE_FORWARD_PATH,
} from '../../src/ssh/service-forward';

const TASK_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TASK_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const DECLARED = 3000;

interface Harness {
  url: string;
  asked: string[];
  serviceConns: { closed: boolean }[];
  stop(): void;
}

async function start(opts: { aRunning?: boolean; highWater?: number; serviceReads?: boolean } = {}): Promise<Harness> {
  const serviceConns: { closed: boolean }[] = [];
  // The task's service: echoes, unless told not to read at all.
  const service = Bun.listen<{ rec: { closed: boolean } }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(sock) {
        const rec = { closed: false };
        serviceConns.push(rec);
        sock.data = { rec };
        if (opts.serviceReads === false) sock.pause();
      },
      data(sock, bytes) { sock.write(bytes); },
      close(sock) { sock.data.rec.closed = true; },
    },
  });
  const asked: string[] = [];
  const tasks: Record<string, Partial<Task>> = { [TASK_A]: { id: TASK_A }, [TASK_B]: { id: TASK_B } };
  const storage = {
    getTask: async (id: string) => (tasks[id] as Task | undefined) ?? null,
    getSessionByTaskId: async () => null as Session | null,
  };
  const serveState = async (_root: string, task: Task): Promise<TaskServeState> => {
    asked.push(task.id);
    const running = task.id === TASK_A ? opts.aRunning !== false : true;
    const base = { declared: [{ name: 'web', port: DECLARED }], containerName: `lazy-${task.id.slice(0, 8)}`, runnerType: 'docker' };
    if (!running) return { ...base, services: [], unavailable: 'not-running', containerRunning: false };
    return {
      ...base,
      services: [{ name: 'web', port: DECLARED, binding: { containerPort: DECLARED, hostAddress: '127.0.0.1', hostPort: service.port }, url: null }],
      unavailable: null,
      containerRunning: true,
    };
  };
  const up = createServiceForwardUpgrader({
    root: '/projects/demo',
    getStorage: async () => storage as never,
    serveState: serveState as never,
    highWater: opts.highWater,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const out = await up.tryUpgrade(req, srv);
      if (out === 'upgraded') return undefined as never;
      return out ?? new Response('not found', { status: 404 });
    },
    websocket: up.handler as never,
  });
  return {
    url: `ws://127.0.0.1:${server.port}${SERVICE_FORWARD_PATH}`,
    asked,
    serviceConns,
    stop() { server.stop(true); service.stop(true); },
  };
}

async function status(h: Harness, token: string | null, port = DECLARED): Promise<number> {
  const res = await fetch(`${h.url.replace(/^ws/, 'http')}?port=${port}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  await res.text();
  return res.status;
}

function open(h: Harness, token: string, port = DECLARED) {
  const ws = new WebSocket(`${h.url}?port=${port}`, { headers: { Authorization: `Bearer ${token}` } } as never);
  ws.binaryType = 'arraybuffer';
  const received: string[] = [];
  let closeCode: number | null = null;
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('forward socket errored'));
  });
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (ev) => { closeCode = ev.code; resolve(ev.code); };
  });
  ws.onmessage = (ev) => received.push(new TextDecoder().decode(ev.data as ArrayBuffer));
  return { ws, received, opened, closed, code: () => closeCode };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(20);
  }
}

describe('the SSH service-forward route', () => {
  let h: Harness;
  afterEach(() => h?.stop());

  // INVARIANT: only a LIVE grant opens a forward. No grant, a token nobody
  // minted, and a grant revoked when its SSH connection ended are all 401,
  // before the task or the runtime is even asked.
  test('a missing, unknown or revoked grant is 401', async () => {
    h = await start();
    expect(await status(h, null)).toBe(401);
    expect(await status(h, 'lzfwd_not-a-grant')).toBe(401);
    const token = mintForwardGrant({ taskId: TASK_A, memberEmail: 'a@example.com' });
    revokeForwardGrant(token);
    expect(await status(h, token)).toBe(401);
    expect(h.asked).toEqual([]);
  });

  // INVARIANT: a forward reaches only a port the project DECLARES in [serve];
  // anything else on the task's container is 403.
  test('an undeclared port is 403', async () => {
    h = await start();
    const token = mintForwardGrant({ taskId: TASK_A, memberEmail: 'a@example.com' });
    try {
      expect(await status(h, token, 22)).toBe(403);
    } finally {
      revokeForwardGrant(token);
    }
  });

  // INVARIANT: a grant reaches its OWN task and nothing else. The request
  // cannot name a task; only the grant's is resolved, so with that task's
  // container down the forward is refused even though another task's same
  // service is up — and nothing is started to make it answer.
  test("another task's service is never reached, and no container is started", async () => {
    h = await start({ aRunning: false });
    const token = mintForwardGrant({ taskId: TASK_A, memberEmail: 'a@example.com' });
    try {
      expect(await status(h, token)).toBe(409);
      expect(h.asked).toEqual([TASK_A]);
      expect(h.serviceConns).toEqual([]);
    } finally {
      revokeForwardGrant(token);
    }
  });

  // INVARIANT: revoking a grant (its SSH connection ended, or access was
  // withdrawn) CLOSES the forwards open under it — the WebSocket and the TCP
  // connection to the service — rather than only refusing new ones.
  test('revoking a grant closes its open forwards and their TCP connections', async () => {
    h = await start();
    const token = mintForwardGrant({ taskId: TASK_A, memberEmail: 'a@example.com' });
    const f = open(h, token);
    await f.opened;
    f.ws.send(new TextEncoder().encode('ping'));
    await until(() => f.received.join('') === 'ping');
    expect(liveForwardCount(token)).toBe(1);
    expect(h.serviceConns).toHaveLength(1);

    revokeForwardGrant(token);
    expect(await f.closed).toBe(1008);
    await until(() => h.serviceConns[0]!.closed);
    expect(liveForwardCount(token)).toBe(0);
  });

  // A service that does not read cannot make the daemon buffer without bound:
  // past the high-water mark the forward is closed.
  test('a forward the service does not keep up with is closed past the high-water mark', async () => {
    h = await start({ serviceReads: false, highWater: 64 * 1024 });
    const token = mintForwardGrant({ taskId: TASK_A, memberEmail: 'a@example.com' });
    try {
      const f = open(h, token);
      await f.opened;
      const chunk = new Uint8Array(256 * 1024);
      for (let i = 0; i < 64 && f.code() === null; i++) {
        f.ws.send(chunk);
        await Bun.sleep(5);
      }
      expect(await f.closed).toBe(1009);
    } finally {
      revokeForwardGrant(token);
    }
  });
});
