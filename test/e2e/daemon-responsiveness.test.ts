/**
 * The daemon must stay responsive while a long operation is in flight.
 *
 * This is the regression suite for the field failure where `lazy_wait` MCP calls
 * reported "could not reach the daemon" and a large `accept` stalled past two
 * minutes, while `active`/`show`/`diff` answered instantly on either side of the
 * failures. Root cause: `Bun.serve`'s idle timer reaped requests whose handler
 * had produced no bytes yet, so every operation longer than the listener's
 * `idleTimeout` (120s on both daemon listeners) died mid-flight.
 *
 * Unlike test/unit/daemon-heartbeat.test.ts — which shrinks `idleTimeout` so the
 * reap reproduces in seconds — these tests run against a REAL daemon on its real
 * production timeouts, and assert the two properties that matter end-to-end:
 *
 *   1. a real long RPC (`wait`'s long-poll) is kept alive by heartbeat bytes on
 *      the wire, and its result survives the envelope through DaemonClient;
 *   2. short RPCs are answered promptly WHILE that long RPC is in flight.
 *
 * Property 2 is the concurrent-load assertion: it fails the moment someone puts
 * a sync fs call or a `spawnSync` back on a request path, or serializes handlers
 * behind a lock held for the duration of a long operation.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';
import { DaemonClient } from '../../src/daemon/client';
import {
  HEARTBEAT_CONTENT_TYPE,
  HEARTBEAT_INTERVAL_MS,
  heartbeatRequestHeaders,
} from '../../src/daemon/heartbeat';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';

const TOKEN = 'responsiveness-token';

/**
 * How long the long RPC is held open. Must exceed HEARTBEAT_INTERVAL_MS by
 * enough that at least two heartbeat lines are due — that is the proof the
 * daemon is actively keeping the connection alive rather than just being fast.
 */
const LONG_RPC_S = 14;

/**
 * Bound on a short RPC's round trip while the long one runs. A local daemon
 * reading a handful of small files has no excuse for taking this long; generous
 * against reality (single-digit milliseconds) but tight enough to catch a
 * blocked event loop or a handler queued behind the long operation.
 */
const SHORT_RPC_BUDGET_MS = 2_000;

describe('daemon responsiveness under a long operation', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon;
  let tmpDir: string;
  let socketPath: string;
  let client: DaemonClient;
  let shortTaskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Created BEFORE the daemon starts: the CLI subprocess needs the storage
    // lock, which the running daemon holds for its whole lifetime.
    shortTaskId = await createTask(ctx, 'Long operation task');
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-responsive-'));
    socketPath = join(tmpDir, 'test.sock');
    // A long reconcile interval keeps the reconciler from transitioning the
    // hand-made 'working' task to 'interrupted' and cutting the long-poll short.
    // The loop's first tick still fires ~1s after start, before the task is set
    // to 'working' below, so nothing is left un-reconciled by accident.
    daemon = await startDaemonServer({
      socketPath,
      token: TOKEN,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 600,
    });
    client = DaemonClient.fromTarget(socketPath, TOKEN);
  });

  afterEach(async () => {
    // MUST be awaited: stop() removes the pidfile, and ctx.cleanup() kills
    // whatever pid it finds there — which, for an in-process daemon, is this
    // test process.
    if (daemon) await daemon.stop();
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Give the daemon a task that `wait` will genuinely long-poll on: 'working'
   * status with a session, created after the reconciler's first tick.
   */
  async function makeTaskWorking(): Promise<string> {
    const shortId = shortTaskId;

    // Let the reconciler's first tick (t+1s) pass while the task is still
    // backlog, so it is not flipped to 'interrupted' underneath the long-poll.
    await new Promise(resolve => setTimeout(resolve, 2_500));

    const storage = await openProjectStorage(ctx.root);
    const task = (await storage.listTasks()).find(t => t.id.startsWith(shortId));
    expect(task).toBeDefined();
    const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    await storage.createSession(task!.id, 'test-agent', `lazy/${shortId}`, startSha);
    await storage.updateTaskStatus(task!.id, 'working', 'system');
    await storage.close();

    // Precondition: the daemon sees the status a separate process wrote. If this
    // ever fails, the daemon's storage went stale — a much bigger bug than the
    // one under test, and the rest of this suite would be meaningless.
    const shown = await client.rpc('show', ctx.root, { taskId: shortId }) as { task: { status: string } };
    expect(shown.task.status).toBe('working');

    return shortId;
  }

  // INVARIANT: a real long daemon RPC is kept alive by heartbeat bytes on the
  // wire. Without them, Bun's idle timer reaps the connection at `idleTimeout`
  // and `wait`'s 600s long-poll could never complete — that is exactly what the
  // three "could not reach the daemon" lazy_wait failures were.
  test('a long RPC streams heartbeats and returns its real result', async () => {
    const shortId = await makeTaskWorking();

    // Raw fetch so the wire format itself is observable, rather than trusting
    // the client's unwrapping.
    const response = await fetch(`http://localhost/rpc/wait`, {
      method: 'POST',
      unix: socketPath,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Lazy-Project': ctx.root,
        ...heartbeatRequestHeaders(),
      },
      body: JSON.stringify({ taskId: shortId, timeout: LONG_RPC_S }),
    } as any);

    // Enveloped replies are always HTTP 200; the real status is the last line.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(HEARTBEAT_CONTENT_TYPE);

    const raw = await response.text();
    const lines = raw.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);

    expect(lines[0]).toEqual({ lazyEnvelope: 1 });

    const heartbeats = lines.filter(l => 'heartbeat' in l);
    const expectedHeartbeats = Math.floor((LONG_RPC_S * 1000) / HEARTBEAT_INTERVAL_MS) - 1;
    expect(heartbeats.length).toBeGreaterThanOrEqual(expectedHeartbeats);

    const result = lines[lines.length - 1] as { status: number; body: { timed_out: boolean; status: string } };
    expect(result.status).toBe(200);
    expect(result.body.timed_out).toBe(true);
    expect(result.body.status).toBe('working');
  }, 60_000);

  // INVARIANT: short RPCs are answered promptly while a long RPC is in flight.
  // The daemon is a local HTTP server — a long operation must never make it
  // unresponsive. Regression guard for sync fs / spawnSync on a request path and
  // for locks held across long operations.
  test('short RPCs stay fast while a long RPC is in flight', async () => {
    const shortId = await makeTaskWorking();

    const long = client.rpc('wait', ctx.root, { taskId: shortId, timeout: LONG_RPC_S }) as
      Promise<{ timed_out: boolean }>;

    const latencies: { command: string; ms: number }[] = [];
    const deadline = Date.now() + (LONG_RPC_S - 2) * 1000;
    while (Date.now() < deadline) {
      for (const command of ['list', 'active', 'blocked'] as const) {
        const t0 = Date.now();
        await client.rpc(command, ctx.root, {});
        latencies.push({ command, ms: Date.now() - t0 });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // The long call must still deliver its own result — sampling must not have
    // starved or aborted it.
    const longResult = await long;
    expect(longResult.timed_out).toBe(true);

    // Enough samples to have covered the whole window, including well past the
    // point where an unprotected connection would already be gone.
    expect(latencies.length).toBeGreaterThanOrEqual(9);
    const worst = latencies.reduce((a, b) => (a.ms > b.ms ? a : b));
    expect(worst.ms).toBeLessThan(SHORT_RPC_BUDGET_MS);
  }, 60_000);

  // INVARIANT: framing is opt-in. Containers launched before this change hold a
  // client that cannot parse NDJSON; a daemon upgrade underneath them must not
  // break their RPCs. A request without the header gets plain JSON.
  test('a request without the heartbeat header still gets plain JSON', async () => {
    const response = await fetch('http://localhost/rpc/list', {
      method: 'POST',
      unix: socketPath,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({}),
    } as any);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain(HEARTBEAT_CONTENT_TYPE);
    expect(Array.isArray((await response.json() as { tree: unknown[] }).tree)).toBe(true);
  }, 30_000);
});
