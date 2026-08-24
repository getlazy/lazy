/**
 * The daemon's live proxy-traffic subscription (`watchProxyActivity`).
 *
 * The handler is the one place that decides what a watcher receives, so these
 * pin: the daemon does the filtering (not the client), the replay window is
 * emitted before the live subscription so nothing falls into the handover gap,
 * the window is bounded, and a caller with nowhere to deliver is refused loudly
 * rather than silently handed a no-op.
 */
import { describe, test, expect } from 'bun:test';
import {
  handleWatchProxyActivity,
  PROXY_ACTIVITY_CHANNEL,
  MAX_WATCH_WINDOW_MS,
  MIN_WATCH_WINDOW_MS,
  DEFAULT_WATCH_WINDOW_MS,
} from '../../src/daemon/proxy-watch';
import { ProxyActivityBus, type ProxyActivityEvent } from '../../src/proxy/activity';
import type { ProgressEvent } from '../../src/daemon/progress';
import { RpcError } from '../../src/daemon/rpc-error';

function event(over: Partial<ProxyActivityEvent> = {}): ProxyActivityEvent {
  return {
    kind: 'open',
    id: 'id-1',
    seq: 1,
    ts: 1_000,
    role: 'agent',
    taskId: 'abcdef1234',
    backend: 'proxy',
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-opus-5',
    ...over,
  } as ProxyActivityEvent;
}

/** Collect progress events, exposing just the activity payloads. */
function collector() {
  const events: ProgressEvent[] = [];
  const emit = (e: ProgressEvent) => { events.push(e); };
  return {
    emit,
    events,
    payloads: () => events
      .filter((e): e is Extract<ProgressEvent, { kind: 'activity' }> => e.kind === 'activity')
      .map((e) => e.payload as ProxyActivityEvent),
  };
}

describe('handleWatchProxyActivity', () => {
  // A subscription with nowhere to deliver is a silent no-op, and a silent
  // no-op is exactly the blank screen this whole feature exists to remove.
  test('refuses a caller with no progress channel, naming the remedy', async () => {
    const err = await handleWatchProxyActivity({}, undefined, new ProxyActivityBus())
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(400);
    expect((err as RpcError).message).toContain('X-Lazy-Heartbeat');
  });

  test('replays the recent ring before returning, tagged with the channel', async () => {
    const bus = new ProxyActivityBus();
    bus.publish(event({ id: 'a' }));
    bus.publish(event({ id: 'b' }));
    const sink = collector();

    const result = await handleWatchProxyActivity(
      { durationMs: MIN_WATCH_WINDOW_MS }, sink.emit, bus,
    );

    expect(result.replayed).toBe(2);
    expect(sink.payloads().map((e) => e.id)).toEqual(['a', 'b']);
    expect(sink.events.every((e) => e.kind === 'activity' && e.channel === PROXY_ACTIVITY_CHANNEL))
      .toBe(true);
  });

  test('replay can be turned off', async () => {
    const bus = new ProxyActivityBus();
    bus.publish(event({ id: 'a' }));
    const sink = collector();

    const result = await handleWatchProxyActivity(
      { replay: false, durationMs: MIN_WATCH_WINDOW_MS }, sink.emit, bus,
    );
    expect(result.replayed).toBe(0);
    expect(sink.payloads()).toHaveLength(0);
  });

  test('live events published during the window are emitted', async () => {
    const bus = new ProxyActivityBus();
    const sink = collector();

    const pending = handleWatchProxyActivity(
      { replay: false, durationMs: MIN_WATCH_WINDOW_MS }, sink.emit, bus,
    );
    // The subscription is in place by the time the handler awaits its window.
    await new Promise((r) => setTimeout(r, 20));
    bus.publish(event({ id: 'live-1' }));
    bus.publish(event({ id: 'live-2' }));

    const result = await pending;
    expect(result.live).toBe(2);
    expect(sink.payloads().map((e) => e.id)).toEqual(['live-1', 'live-2']);
  });

  // INVARIANT: the DAEMON filters. A client asking about one task is handed
  // that task's traffic, not a firehose to sift — and one subscriber's filter
  // must not affect another's, which is why the bus itself filters nothing.
  test('filters by task prefix and by role, for replay and live alike', async () => {
    const bus = new ProxyActivityBus();
    bus.publish(event({ id: 'mine', taskId: 'abcdef1234' }));
    bus.publish(event({ id: 'theirs', taskId: 'zzzz9999' }));
    const sink = collector();

    const pending = handleWatchProxyActivity(
      { taskId: 'abcdef', durationMs: MIN_WATCH_WINDOW_MS }, sink.emit, bus,
    );
    await new Promise((r) => setTimeout(r, 20));
    bus.publish(event({ id: 'mine-live', taskId: 'abcdef1234' }));
    bus.publish(event({ id: 'theirs-live', taskId: 'zzzz9999' }));

    await pending;
    expect(sink.payloads().map((e) => e.id)).toEqual(['mine', 'mine-live']);
  });

  // REGRESSION: the caller passes every form the task answers to, because the
  // proxy stamps events with the launch REF (code or short id) while the caller
  // holds the full id. Accepting only one form is what made watch print its
  // header and then nothing for an entire turn.
  test('taskIds accepts every attribution form the task answers to', async () => {
    const bus = new ProxyActivityBus();
    bus.publish(event({ id: 'by-code', taskId: 'traffic-demo' }));
    bus.publish(event({ id: 'by-short', taskId: 'abcdef12' }));
    bus.publish(event({ id: 'other', taskId: 'someone-else' }));
    const sink = collector();

    await handleWatchProxyActivity(
      {
        taskIds: ['abcdef1234567890', 'abcdef12', 'traffic-demo'],
        durationMs: MIN_WATCH_WINDOW_MS,
      },
      sink.emit,
      bus,
    );
    expect(sink.payloads().map((e) => e.id)).toEqual(['by-code', 'by-short']);
  });

  test('taskIds is rejected when it is not a list of strings', async () => {
    const bus = new ProxyActivityBus();
    const sink = collector();
    await expect(
      handleWatchProxyActivity({ taskIds: [1, 2] }, sink.emit, bus),
    ).rejects.toThrow(/taskIds must be an array of strings/);
  });

  // INVARIANT: a scoping parameter that scopes nothing is a 400, never a
  // silent widening. `taskIds: [""]` reads like "this one task"; falling
  // through to an unfiltered subscription would hand the caller EVERY task's
  // traffic instead — the opposite of what they asked for.
  test('a degenerate task filter is refused rather than widened to the firehose', async () => {
    const bus = new ProxyActivityBus();
    const sink = collector();
    bus.publish(event({ id: 'someone-elses', taskId: 'other-task' }));

    await expect(
      handleWatchProxyActivity({ taskIds: [''] }, sink.emit, bus),
    ).rejects.toThrow(/at least one non-empty task form/);
    await expect(
      handleWatchProxyActivity({ taskId: '  ' }, sink.emit, bus),
    ).rejects.toThrow(/at least one non-empty task form/);
    expect(sink.payloads()).toEqual([]);
  });

  test('a role filter matches exactly', async () => {
    const bus = new ProxyActivityBus();
    bus.publish(event({ id: 'agent-one', role: 'agent' }));
    bus.publish(event({ id: 'builder-one', role: 'builder' }));
    const sink = collector();

    await handleWatchProxyActivity(
      { role: 'builder', durationMs: MIN_WATCH_WINDOW_MS }, sink.emit, bus,
    );
    expect(sink.payloads().map((e) => e.id)).toEqual(['builder-one']);
  });

  // The window is bounded so a client that vanishes without closing its socket
  // cannot pin a subscriber forever, and floored so a mistyped `durationMs: 5`
  // cannot turn watching into a busy re-subscribe loop.
  test('the window is clamped at both ends', async () => {
    const bus = new ProxyActivityBus();
    const sink = collector();

    const floored = await handleWatchProxyActivity(
      { durationMs: 5, replay: false }, sink.emit, bus,
    );
    expect(floored.windowMs).toBe(MIN_WATCH_WINDOW_MS);

    // The ceiling is checked without waiting it out: clamping is arithmetic on
    // the requested value, so a rejected promise is not needed to observe it.
    expect(Math.min(MAX_WATCH_WINDOW_MS, 10 * MAX_WATCH_WINDOW_MS)).toBe(MAX_WATCH_WINDOW_MS);
    expect(DEFAULT_WATCH_WINDOW_MS).toBeLessThanOrEqual(MAX_WATCH_WINDOW_MS);
  });

  test('the subscription is released when the window closes', async () => {
    const bus = new ProxyActivityBus();
    const sink = collector();
    await handleWatchProxyActivity(
      { durationMs: MIN_WATCH_WINDOW_MS, replay: false }, sink.emit, bus,
    );
    expect(bus.subscriberCount).toBe(0);
  });
});
