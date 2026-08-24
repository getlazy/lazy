/**
 * The live proxy activity bus — the agent-agnostic "something is happening"
 * signal behind `lazy watch`.
 *
 * These pin the properties the watch feature actually rests on: publication is
 * synchronous and cannot break the request being observed, replay is bounded,
 * the close projection agrees with the audit trail's own predicates, and the
 * wire boundary validates rather than casts.
 */
import { describe, test, expect } from 'bun:test';
import {
  ProxyActivityBus,
  closeEventFromRecord,
  matchesFilter,
  parseProxyActivityEvent,
  RECENT_EVENT_CAP,
  type ProxyActivityEvent,
} from '../../src/proxy/activity';
import { AuditQueue } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

function record(over: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000000',
    seq: 1,
    ts: 1_000,
    role: 'agent',
    taskId: 'task-alpha',
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: 'end_turn',
    error: null,
    durationMs: 100,
    reroute: null,
    enforcement: null,
    ...over,
  };
}

function openEvent(over: Partial<ProxyActivityEvent> = {}): ProxyActivityEvent {
  return {
    kind: 'open',
    id: 'id-1',
    seq: 1,
    ts: 1_000,
    role: 'agent',
    taskId: 'task-alpha',
    backend: 'proxy',
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-opus-5',
    ...over,
  } as ProxyActivityEvent;
}

describe('ProxyActivityBus', () => {
  test('publishes to every subscriber and stops after unsubscribe', () => {
    const bus = new ProxyActivityBus();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.subscribe((e) => a.push(e.id));
    bus.subscribe((e) => b.push(e.id));

    bus.publish(openEvent({ id: 'one' }));
    offA();
    bus.publish(openEvent({ id: 'two' }));

    expect(a).toEqual(['one']);
    expect(b).toEqual(['one', 'two']);
    expect(bus.subscriberCount).toBe(1);
  });

  // INVARIANT: observation must never break the request being observed. The
  // proxy calls publish() on its hot path, so a broken watcher has to be
  // dropped, not propagated — and the OTHER watchers must still be served.
  test('a subscriber that throws is dropped, and does not break publish', () => {
    const bus = new ProxyActivityBus();
    const survivor: string[] = [];
    bus.subscribe(() => { throw new Error('watcher blew up'); });
    bus.subscribe((e) => survivor.push(e.id));

    expect(() => bus.publish(openEvent({ id: 'one' }))).not.toThrow();
    expect(bus.subscriberCount).toBe(1);
    bus.publish(openEvent({ id: 'two' }));
    expect(survivor).toEqual(['one', 'two']);
  });

  // Replay is what makes watch paint immediately instead of sitting blank
  // until the agent's next call — but it is a "what just happened" window,
  // never history. History is the audit log.
  test('replay is bounded to the cap, keeping the newest events', () => {
    const bus = new ProxyActivityBus(3);
    for (let i = 0; i < 10; i++) bus.publish(openEvent({ id: `id-${i}` }));
    expect(bus.recentEvents().map((e) => e.id)).toEqual(['id-7', 'id-8', 'id-9']);
  });

  test('default cap is the documented constant', () => {
    const bus = new ProxyActivityBus();
    for (let i = 0; i < RECENT_EVENT_CAP + 5; i++) bus.publish(openEvent({ id: `id-${i}` }));
    expect(bus.recentEvents()).toHaveLength(RECENT_EVENT_CAP);
  });

  test('recentEvents applies the filter', () => {
    const bus = new ProxyActivityBus();
    bus.publish(openEvent({ id: 'a', taskId: 'abcdef12', role: 'agent' }));
    bus.publish(openEvent({ id: 'b', taskId: 'zzzzzz99', role: 'builder' }));

    expect(bus.recentEvents({ taskIds: ['abcd'] }).map((e) => e.id)).toEqual(['a']);
    expect(bus.recentEvents({ role: 'builder' }).map((e) => e.id)).toEqual(['b']);
  });
});

describe('matchesFilter', () => {
  test('taskId matches by prefix (short ids), role matches exactly', () => {
    const e = openEvent({ taskId: 'abcdef1234', role: 'agent' });
    expect(matchesFilter(e, { taskIds: ['abcdef'] })).toBe(true);
    expect(matchesFilter(e, { taskIds: ['bcdef'] })).toBe(false);
    expect(matchesFilter(e, { role: 'agent' })).toBe(true);
    expect(matchesFilter(e, { role: 'ag' })).toBe(false);
    expect(matchesFilter(e, {})).toBe(true);
  });

  // REGRESSION: the proxy attributes an event with the task REF from the
  // agent's credential grant (its code, or its short id), while a caller holds
  // the full id. A one-directional `event.startsWith(filter)` matched neither
  // direction, so `lazy watch` rendered its header and then nothing at all for
  // a whole turn. Both directions, and any accepted form, must match.
  test('any accepted attribution form matches, in either direction', () => {
    const byCode = openEvent({ taskId: 'watch-proxy-traffic' });
    const byShortId = openEvent({ taskId: 'ec67afd6' });
    const forms = ['ec67afd6f0a14b2c', 'ec67afd6', 'watch-proxy-traffic'];

    expect(matchesFilter(byCode, { taskIds: forms })).toBe(true);
    expect(matchesFilter(byShortId, { taskIds: forms })).toBe(true);
    // A form that resolves to a different task still must not match.
    expect(matchesFilter(byCode, { taskIds: ['other-task', 'ffffffff'] })).toBe(false);
  });

  // INVARIANT: a task CODE matches exactly, never as a prefix. lazy's own
  // clone/redo conventions mint sibling codes that share a prefix — this
  // project's store holds `add-agent-to-unblock` and
  // `add-agent-to-unblock-clone-1` — so prefix-matching codes silently folds
  // another task's traffic into a watch that named one task.
  test('a sibling task whose code merely shares a prefix does not leak in', () => {
    const sibling = openEvent({ taskId: 'add-agent-to-unblock-clone-1' });
    const watched = openEvent({ taskId: 'add-agent-to-unblock' });
    const forms = ['add-agent-to-unblock'];

    expect(matchesFilter(watched, { taskIds: forms })).toBe(true);
    expect(matchesFilter(sibling, { taskIds: forms })).toBe(false);
    // And the other direction: watching the clone must not show the original.
    expect(matchesFilter(watched, { taskIds: ['add-agent-to-unblock-clone-1'] })).toBe(false);
  });

  // Loose matching exists for an operator typing part of a hex short id. Three
  // characters is not an identifier, it is a wildcard over every task whose id
  // starts that way — so there is a floor.
  test('loose prefix matching is hex-shaped and has a minimum length', () => {
    const e = openEvent({ taskId: 'ec67afd6' });
    expect(matchesFilter(e, { taskIds: ['ec67'] })).toBe(true);
    expect(matchesFilter(e, { taskIds: ['ec6'] })).toBe(false);
    expect(matchesFilter(e, { taskIds: ['ec'] })).toBe(false);
    // Exact still wins regardless of length or shape.
    expect(matchesFilter(openEvent({ taskId: 'ab' }), { taskIds: ['ab'] })).toBe(true);
  });

  test('unattributed traffic never satisfies a filter but is not an error', () => {
    const e = openEvent({ taskId: null, role: null });
    expect(matchesFilter(e, { taskIds: ['abc'] })).toBe(false);
    // Bidirectional prefixing makes '' match everything if left unguarded —
    // unattributed traffic belongs to the firehose, not to every task.
    expect(matchesFilter(e, { taskIds: ['ec67afd6f0a14b2c'] })).toBe(false);
    expect(matchesFilter(e, {})).toBe(true);
  });
});

describe('closeEventFromRecord', () => {
  // INVARIANT: "did this request fail / was it denied" has exactly ONE answer.
  // The live view projects the audit module's own predicates rather than
  // re-deriving them, or two surfaces start disagreeing about a security event.
  test('failure and denial verdicts come from the audit predicates', () => {
    const denied = closeEventFromRecord(record({
      status: 403,
      enforcement: [{ toolUseId: 't1', name: 'x', rule: 'r', reason: 'no' }],
    }));
    expect(denied.failed).toBe(true);
    expect(denied.denials).toBe(1);

    const noResponse = closeEventFromRecord(record({ status: null, error: 'connect ECONNREFUSED' }));
    expect(noResponse.failed).toBe(true);
    expect(noResponse.status).toBeNull();

    expect(closeEventFromRecord(record()).failed).toBe(false);
  });

  test('token total sums all four counters, and is null when none were captured', () => {
    const withUsage = closeEventFromRecord(record({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
      } as ProxyAuditRecord['usage'],
    }));
    expect(withUsage.totalTokens).toBe(20);
    expect(closeEventFromRecord(record()).totalTokens).toBeNull();
  });

  test('a reroute is flagged', () => {
    expect(closeEventFromRecord(record()).rerouted).toBe(false);
    const rerouted = closeEventFromRecord(record({
      reroute: {
        fromUpstream: 'https://api.anthropic.com',
        fromModel: 'claude-opus-5',
        toUpstream: 'http://127.0.0.1:11434',
        toModel: 'claude-opus-5',
        trigger: '429',
        attempts: 2,
      },
    }));
    expect(rerouted.rerouted).toBe(true);
  });

  // A query string is caller-controlled, carries no "the agent is busy" signal,
  // and can hold values never meant for another human's screen. It is dropped
  // where events are made, so no downstream surface has to remember to.
  test('the query string is dropped from the path', () => {
    const e = closeEventFromRecord(record({ path: '/v1/messages?key=sk-ant-secret&beta=1' }));
    expect(e.path).toBe('/v1/messages');
  });

  test('the close event joins to its audit record by id', () => {
    const r = record({ id: 'join-me', seq: 42 });
    const e = closeEventFromRecord(r);
    expect(e.id).toBe('join-me');
    expect(e.seq).toBe(42);
  });
});

describe('AuditQueue activity tap', () => {
  // The tap is wired into the QUEUE rather than at each of the proxy's audit
  // sites so a future record site cannot forget it: every record that reaches
  // the durable trail reaches `lazy watch` too, by construction.
  test('fires synchronously for every enqueued record', () => {
    const seen: string[] = [];
    const queue = new AuditQueue({ append: async () => {} }, (r) => seen.push(r.id));
    queue.enqueue(record({ id: 'one' }));
    queue.enqueue(record({ id: 'two' }));
    // Synchronous: no await between enqueue and observation.
    expect(seen).toEqual(['one', 'two']);
  });

  // INVARIANT: the live tap is best-effort telemetry; the durable append is not.
  // A broken tap must not cost the audit trail a record.
  test('a throwing tap still lets the durable append happen', async () => {
    const appended: string[] = [];
    const queue = new AuditQueue(
      { append: async (r) => { appended.push(r.id); } },
      () => { throw new Error('tap exploded'); },
    );
    expect(() => queue.enqueue(record({ id: 'one' }))).not.toThrow();
    await queue.flush();
    expect(appended).toEqual(['one']);
  });

  test('no tap is fine — the queue is unchanged without one', async () => {
    const appended: string[] = [];
    const queue = new AuditQueue({ append: async (r) => { appended.push(r.id); } });
    queue.enqueue(record({ id: 'one' }));
    await queue.flush();
    expect(appended).toEqual(['one']);
  });
});

describe('parseProxyActivityEvent (the wire boundary)', () => {
  // The daemon carries these as an OPAQUE payload so the transport never learns
  // proxy shapes; that makes the CLI an external surface receiving untrusted
  // shape, and per the project rule it validates rather than casting.
  test('round-trips a close event through JSON', () => {
    const original = closeEventFromRecord(record());
    const parsed = parseProxyActivityEvent(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });

  test('round-trips an open event', () => {
    const original = openEvent();
    expect(parseProxyActivityEvent(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  test('rejects anything that is not an activity event', () => {
    for (const bad of [
      null, undefined, 42, 'string', [],
      {},
      { kind: 'open' },                                  // no id/method/path
      { kind: 'weird', id: 'a', method: 'POST', path: '/x', backend: 'p', ts: 1 },
      { id: 'a', method: 'POST', path: '/x', backend: 'p', ts: 1 },  // no kind
      { kind: 'open', id: 'a', method: 'POST', path: '/x', backend: 'p' }, // no ts
      { kind: 'open', id: 5, method: 'POST', path: '/x', backend: 'p', ts: 1 }, // wrong type
    ]) {
      expect(parseProxyActivityEvent(bad)).toBeNull();
    }
  });

  test('coerces missing optional fields to nulls rather than undefined', () => {
    const parsed = parseProxyActivityEvent({
      kind: 'close', id: 'a', method: 'GET', path: '/v1/x', backend: 'cursor', ts: 5,
    });
    expect(parsed).toEqual({
      kind: 'close', id: 'a', seq: 0, ts: 5, role: null, taskId: null,
      backend: 'cursor', method: 'GET', path: '/v1/x', model: null,
      status: null, durationMs: null, error: null, totalTokens: null,
      denials: 0, rerouted: false, failed: false,
    });
  });
});
