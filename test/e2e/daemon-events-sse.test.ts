import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { openSse, frameData, type SseFrame } from '../helpers/sse';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

/**
 * The daemon's SSE event feed, `GET /rpc/events`.
 *
 * `withDaemon` because every assertion here is about a real HTTP request
 * against a real daemon: the route, its auth, and — crucially — the fact that
 * events are emitted as a side effect of REAL storage writes performed by
 * ordinary lazy commands. An in-process call would bypass the route entirely,
 * and a hand-called `publishDaemonEvent` would prove nothing about whether the
 * lifecycle paths actually reach it (that is the failure mode this task exists
 * to avoid — see docs/spikes/event-data-plane.md).
 */
describe('daemon SSE event feed', () => {
  let ctx: TestContext;
  let target: string;
  let token: string;
  const open: Array<{ close: () => void }> = [];

  function eventsUrl(params: Record<string, string> = {}): string {
    const url = new URL(`${target}/rpc/events`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root, ...extra };
  }

  async function connect(params: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const conn = await openSse(eventsUrl(params), { headers: authHeaders(headers) });
    open.push(conn);
    return conn;
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    token = resolvedToken;
  });

  afterEach(async () => {
    for (const conn of open.splice(0)) conn.close();
    await ctx.cleanup();
  });

  // --- Auth ---

  // INVARIANT: the feed is authenticated exactly like any other /rpc/* route.
  // It streams the shape of everything happening in a project; an unauthenticated
  // reader is a disclosure, not a convenience.
  test('requires authentication', async () => {
    const res = await fetch(eventsUrl(), { headers: { 'X-Lazy-Project': ctx.root } });
    expect(res.status).toBe(401);
    await res.text();

    const bad = await fetch(eventsUrl(), {
      headers: { Authorization: 'Bearer not-a-real-token', 'X-Lazy-Project': ctx.root },
    });
    expect(bad.status).toBe(401);
    await bad.text();
  });

  // INVARIANT: there is no query-parameter token path. The subscriber is a
  // server-side listener that can set headers, and browsers never talk to a
  // daemon directly (docs/design/lazy-teams.md §2.3). A token in a URL leaks
  // into logs and referrers — do not add one to make a browser demo easier.
  test('does not accept a token as a query parameter', async () => {
    const res = await fetch(eventsUrl({ token }), { headers: { 'X-Lazy-Project': ctx.root } });
    expect(res.status).toBe(401);
    await res.text();
  });

  test('requires a matching X-Lazy-Project header', async () => {
    const missing = await fetch(eventsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('X-Lazy-Project');

    const wrong = await fetch(eventsUrl(), {
      headers: { Authorization: `Bearer ${token}`, 'X-Lazy-Project': '/somewhere/else' },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Project mismatch');
  });

  // Every external surface validates its inputs at the boundary rather than
  // coercing them — a NaN cursor would silently mean "replay everything".
  test('rejects a malformed Last-Event-ID', async () => {
    for (const bad of ['abc', '-3', '1.5']) {
      const res = await fetch(eventsUrl({ last_event_id: bad }), { headers: authHeaders() });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Last-Event-ID');
    }
  });

  // --- Connect ---

  test('connects and sends an open frame describing the stream', async () => {
    const conn = await connect();
    const opened = await conn.waitFor((f) => f.event === 'feed.open', 10_000, 'feed.open');
    const data = frameData(opened);

    expect(typeof data.feedId).toBe('string');
    expect(data.replayed).toBe(0);
    expect(data.gap).toBe(false);
    expect(data.capacity).toBe(1000);
    // The open frame carries no id: — it is metadata about the stream, not an
    // event, and must never become a client's cursor.
    expect(opened.id).toBeUndefined();
  });

  test('sets SSE response headers', async () => {
    const res = await fetch(eventsUrl(), { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    // Cancel rather than draining an endless body.
    await res.body?.cancel();
  });

  // --- Real events from real writes ---

  // This is the load-bearing test: the event must arrive because an ORDINARY
  // lazy command wrote to storage, not because the test published one. Emission
  // hangs off the daemon's single writable Storage instance (src/daemon/event-tap.ts)
  // precisely so no lifecycle path can be missed.
  test('delivers a task.status_changed event for a real transition', async () => {
    const taskId = await createTask(ctx, 'Feed status task');
    const conn = await connect();
    await conn.waitFor((f) => f.event === 'feed.open');

    expectSuccess(await ctx.lazy(['close', taskId, '--yes', '--reason', 'done with it']));

    const frame = await conn.waitFor(
      (f) => f.event === 'task.status_changed',
      15_000,
      'task.status_changed',
    );
    const event = frameData(frame);
    expect(event.taskId).toBeTruthy();
    expect(event.data.status).toBe('abandoned');
    expect(event.data.from).toBe('backlog');
    // Every buffered event carries an id: line so a reconnect can resume from it.
    expect(frame.id).toBe(String(event.seq));
  });

  test('delivers a comment.added event, without the comment body', async () => {
    const taskId = await createTask(ctx, 'Feed comment task');
    const conn = await connect();
    await conn.waitFor((f) => f.event === 'feed.open');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'a secret-ish note']));

    const frame = await conn.waitFor((f) => f.event === 'comment.added', 15_000, 'comment.added');
    const event = frameData(frame);
    expect(event.taskId).toBeTruthy();
    expect(typeof event.data.commentId).toBe('string');
    // INVARIANT: the feed is an invalidation hint, not a data plane. Content
    // stays in the store, where its access is governed by the read path.
    expect(frame.data).not.toContain('secret-ish');
  });

  // A whole turn, driven by the ordinary `start` path: this exercises the
  // session and turn taps together with the status transitions the reconciler
  // makes on its own, which no hand-written storage call would reach.
  test('delivers session and turn events across a real turn', async () => {
    const taskId = await createTask(ctx, 'Feed turn task', 'Do some work');
    const conn = await connect();
    await conn.waitFor((f) => f.event === 'feed.open');

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }

    const started = await conn.waitFor((f) => f.event === 'session.started', 30_000, 'session.started');
    expect(typeof frameData(started).data.sessionId).toBe('string');

    const turn = await conn.waitFor((f) => f.event === 'turn.added', 30_000, 'turn.added');
    const turnEvent = frameData(turn);
    // Turns are stored against a session; the feed resolves the task for the
    // subscriber, which indexes by task.
    expect(turnEvent.taskId).toBeTruthy();
    expect(typeof turnEvent.data.sequence).toBe('number');
    expect(typeof turnEvent.data.role).toBe('string');

    // The reconciler's own transition into `working` is on the feed too — the
    // tap sits on storage, not on the command surface.
    const statuses = conn.frames
      .filter((f) => f.event === 'task.status_changed')
      .map((f) => frameData(f).data.status);
    expect(statuses).toContain('working');
  });

  // --- Replay ---

  test('replays missed events after a reconnect with Last-Event-ID', async () => {
    const taskId = await createTask(ctx, 'Feed replay task');

    const first = await connect();
    const firstOpen = await first.waitFor((f) => f.event === 'feed.open');
    expect(frameData(firstOpen).gap).toBe(false);

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'before disconnect']));
    const seen = await first.waitFor((f) => f.event === 'comment.added', 15_000, 'first comment');
    const cursor = seen.id!;
    first.close();

    // Happen while nobody is listening.
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'while away']));
    expectSuccess(await ctx.lazy(['close', taskId, '--yes', '--reason', 'while away too']));

    const second = await connect({ last_event_id: cursor });
    const reopened = await second.waitFor((f) => f.event === 'feed.open');
    const openData = frameData(reopened);
    expect(openData.gap).toBe(false);
    expect(openData.replayed).toBeGreaterThanOrEqual(2);

    const replayedComment = await second.waitFor(
      (f) => f.event === 'comment.added',
      10_000,
      'replayed comment',
    );
    const replayedStatus = await second.waitFor(
      (f) => f.event === 'task.status_changed',
      10_000,
      'replayed status',
    );
    // Strictly after the cursor — no re-delivery of what was already seen.
    expect(Number(replayedComment.id)).toBeGreaterThan(Number(cursor));
    expect(frameData(replayedStatus).data.status).toBe('abandoned');
  });

  test('an explicit last_event_id query parameter beats the Last-Event-ID header', async () => {
    const taskId = await createTask(ctx, 'Feed cursor precedence task');
    const first = await connect();
    await first.waitFor((f) => f.event === 'feed.open');
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'one']));
    const seen = await first.waitFor((f) => f.event === 'comment.added', 15_000, 'comment');
    first.close();

    // Header says "resume from a bogus future cursor", query says "from 0".
    // The explicit parameter wins, so there is no gap.
    const conn = await connect({ last_event_id: '0' }, { 'Last-Event-ID': '999999' });
    const opened = await conn.waitFor((f) => f.event === 'feed.open');
    expect(frameData(opened).gap).toBe(false);
    void seen;
  });

  // --- Gap ---

  // INVARIANT: a cursor the ring cannot serve is answered with an explicit gap,
  // never with silence. `seq` restarts at 1 on daemon restart precisely because
  // the feed is not durable, so a stale cursor is AHEAD of the ring — and a
  // client told "you are caught up" would miss everything since.
  test('signals a gap for a cursor the ring cannot serve', async () => {
    const conn = await connect({ last_event_id: '999999' });
    const opened = await conn.waitFor((f) => f.event === 'feed.open', 10_000, 'feed.open');
    const data = frameData(opened);
    expect(data.gap).toBe(true);
    expect(data.replayed).toBe(0);
    // The client resnapshots through normal reads; the feed does not try to
    // reconstruct history it deliberately did not persist.
    expect(data.latestSeq).toBeLessThan(999999);
  });

  // --- Multiple subscribers ---

  test('fans one event out to every subscriber', async () => {
    const taskId = await createTask(ctx, 'Feed fanout task');
    const a = await connect();
    const b = await connect();
    await a.waitFor((f) => f.event === 'feed.open');
    await b.waitFor((f) => f.event === 'feed.open');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'to everyone']));

    const fa = await a.waitFor((f) => f.event === 'comment.added', 15_000, 'A comment');
    const fb = await b.waitFor((f) => f.event === 'comment.added', 15_000, 'B comment');
    expect(frameData(fa).seq).toBe(frameData(fb).seq);
  });

  test('a disconnected subscriber does not block writes for others', async () => {
    const taskId = await createTask(ctx, 'Feed disconnect task');
    const dead = await connect();
    const live = await connect();
    await dead.waitFor((f) => f.event === 'feed.open');
    await live.waitFor((f) => f.event === 'feed.open');
    dead.close();

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'after disconnect']));
    const frame = await live.waitFor((f) => f.event === 'comment.added', 15_000, 'comment');
    expect(frameData(frame).taskId).toBeTruthy();

    // And the write itself succeeded — a feed failure must never fail a write.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
  });

  // --- Sequence discipline ---

  test('sequence numbers are monotonic across event types', async () => {
    const taskId = await createTask(ctx, 'Feed ordering task');
    const conn = await connect();
    await conn.waitFor((f) => f.event === 'feed.open');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'one']));
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'two']));
    expectSuccess(await ctx.lazy(['close', taskId, '--yes', '--reason', 'three']));
    await conn.waitFor((f) => f.event === 'task.status_changed', 15_000, 'status change');

    const seqs = conn.frames
      .filter((f: SseFrame) => f.id !== undefined)
      .map((f: SseFrame) => Number(f.id));
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
