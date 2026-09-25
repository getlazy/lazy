import { describe, test, beforeEach, expect } from 'bun:test';
import {
  publishDaemonEvent,
  publishEphemeralEvent,
  replaySince,
  parseLastEventId,
  latestEventSeq,
  oldestEventSeq,
  resetEventFeedForTests,
  EVENT_RING_CAPACITY,
  DAEMON_EVENT_TYPES,
} from '../../src/daemon/event-feed';

describe('daemon event ring', () => {
  beforeEach(() => {
    resetEventFeedForTests();
  });

  test('assigns monotonic sequence numbers starting at 1', () => {
    const a = publishDaemonEvent('task.status_changed', { taskId: 't1', data: { status: 'working' } });
    const b = publishDaemonEvent('turn.added', { taskId: 't1', data: { turnId: 'x' } });
    expect(a!.seq).toBe(1);
    expect(b!.seq).toBe(2);
    expect(latestEventSeq()).toBe(2);
    expect(oldestEventSeq()).toBe(1);
  });

  test('event carries the documented wire shape', () => {
    const e = publishDaemonEvent('comment.added', { taskId: 'abc', data: { commentId: 'c1' } })!;
    expect(Object.keys(e).sort()).toEqual(['data', 'seq', 'taskId', 'ts', 'type']);
    expect(e.type).toBe('comment.added');
    expect(e.taskId).toBe('abc');
    expect(e.data).toEqual({ commentId: 'c1' });
    expect(new Date(e.ts).toString()).not.toBe('Invalid Date');
  });

  test('daemon-scoped events omit taskId entirely', () => {
    const e = publishDaemonEvent('daemon.health', { data: { pid: 1 } })!;
    expect('taskId' in e).toBe(false);
  });

  test('a fresh subscriber gets no replay and no gap', () => {
    publishDaemonEvent('turn.added', { taskId: 't', data: {} });
    expect(replaySince(0)).toEqual({ events: [], gap: false });
  });

  test('replays only events after the cursor', () => {
    for (let i = 0; i < 5; i++) publishDaemonEvent('turn.added', { taskId: 't', data: { i } });
    const { events, gap } = replaySince(2);
    expect(gap).toBe(false);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test('a caught-up cursor replays nothing without signalling a gap', () => {
    for (let i = 0; i < 3; i++) publishDaemonEvent('turn.added', { taskId: 't', data: { i } });
    expect(replaySince(3)).toEqual({ events: [], gap: false });
  });

  // INVARIANT: the feed is NOT durable, so `seq` restarts at 1 when the daemon
  // restarts. A cursor from a previous generation is AHEAD of the ring and must
  // be answered with a gap — answering "you are caught up" would silently hide
  // every event since the restart, which is exactly the failure the gap signal
  // exists to prevent. Do not "fix" this into a no-op.
  test('a cursor ahead of the ring signals a gap (daemon restarted)', () => {
    publishDaemonEvent('turn.added', { taskId: 't', data: {} });
    const { events, gap } = replaySince(5000);
    expect(gap).toBe(true);
    expect(events).toEqual([]);
  });

  // INVARIANT: the ring is bounded and lossy on purpose. Falling off the back of
  // it is reported, never papered over by persisting events — see
  // docs/spikes/event-data-plane.md for why durability was removed.
  test('evicts oldest events past capacity and signals a gap for them', () => {
    for (let i = 0; i < EVENT_RING_CAPACITY + 10; i++) {
      publishDaemonEvent('turn.added', { taskId: 't', data: { i } });
    }
    expect(latestEventSeq()).toBe(EVENT_RING_CAPACITY + 10);
    expect(oldestEventSeq()).toBe(11);

    // Cursor 5 was evicted — the next event it expects (6) is gone.
    const evicted = replaySince(5);
    expect(evicted.gap).toBe(true);
    expect(evicted.events[0].seq).toBe(11);

    // Cursor 10 is the last evicted seq, but its NEXT event (11) is still in
    // the ring, so nothing was missed.
    const boundary = replaySince(10);
    expect(boundary.gap).toBe(false);
    expect(boundary.events[0].seq).toBe(11);
  });

  test('ephemeral events do not enter the ring or advance the sequence', () => {
    publishDaemonEvent('turn.added', { taskId: 't', data: {} });
    publishEphemeralEvent('daemon.health', { pid: 1 });
    publishEphemeralEvent('daemon.health', { pid: 1 });
    expect(latestEventSeq()).toBe(1);
    expect(replaySince(0).events).toHaveLength(0);
    expect(replaySince(1).events).toHaveLength(0);
  });

  describe('parseLastEventId', () => {
    test('treats absent/empty as no cursor', () => {
      expect(parseLastEventId(null)).toBe(0);
      expect(parseLastEventId(undefined)).toBe(0);
      expect(parseLastEventId('')).toBe(0);
    });

    test('accepts non-negative integers', () => {
      expect(parseLastEventId('0')).toBe(0);
      expect(parseLastEventId('42')).toBe(42);
      expect(parseLastEventId(' 7 ')).toBe(7);
    });

    // Every external surface validates its inputs rather than coercing them —
    // a NaN cursor would silently become "replay everything".
    test('rejects anything else', () => {
      for (const bad of ['-1', '1.5', 'abc', '1e3', '0x10', '9'.repeat(30), ' ']) {
        expect(parseLastEventId(bad)).toBeNull();
      }
    });
  });

  test('the published type list matches the design', () => {
    expect([...DAEMON_EVENT_TYPES].sort()).toEqual([
      // Artifact events carry metadata only — a name and a size, never the
      // file's bytes. The feed is an invalidation hint, and an artifact can be
      // a megabyte of binary.
      'artifact.added',
      'artifact.removed',
      'comment.added',
      // An in-place edit of an unseen comment, or a forge re-import — no body.
      'comment.updated',
      'daemon.health',
      'ports.changed',
      'session.ended',
      'session.started',
      'task.status_changed',
      'turn.added',
    ]);
  });
});
