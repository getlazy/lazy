/**
 * Live proxy activity — the agent-agnostic "something is happening" signal.
 *
 * WHY THIS EXISTS
 *
 * `lazy watch` used to have exactly two sources: the supervisor's stdout and
 * the Claude agent's JSONL session file. That is a Claude-shaped answer to an
 * agent-agnostic question. `cursor-agent --print` emits one blob at exit and
 * its streaming wire format is opaque connect-rpc protobuf that lazy
 * deliberately does not parse — so a Cursor task showed nothing at all until it
 * finished.
 *
 * Since proxy-jit-credentials every agent's API traffic rides lazy's always-on
 * proxy, with attribution derived from the credential grant rather than from a
 * self-reported header. That makes the proxy the ONE place where "the agent is
 * doing something" is observable for every agent lazy will ever run, without
 * parsing anybody's output format.
 *
 * WHY A BUS AND NOT THE AUDIT LOG
 *
 * `.lazy/logs/proxy-audit.jsonl` (src/proxy/audit-log.ts) already records every
 * request and the CLI already reads it — but a record is written when the
 * request COMPLETES. A single streaming /v1/messages call runs for tens of
 * seconds to minutes, which is precisely the window in which watch felt dead.
 * So this bus carries two events per request: `open` at the moment the proxy
 * forwards it, and `close` projected from the audit record. The audit log stays
 * the durable trail; this is the live tap, and it is deliberately in-memory,
 * bounded, and lossy — losing it costs nothing.
 *
 * INVARIANT — observation must never break the request it observes. Publishing
 * is synchronous and fully guarded: a subscriber that throws is dropped from
 * the set, never propagated into the proxy hot path.
 */

import { denialsOf, isFailure } from './audit-query';
import type { ProxyAuditRecord } from '../storage/types';
import { logger } from '../utils/logger';

/** Fields shared by both event kinds — who, where, and what was asked for. */
interface ProxyActivityBase {
  /** Same id as the audit record for this request, so the two can be joined. */
  id: string;
  /** Per-process monotonic sequence, for ordering within one proxy run. */
  seq: number;
  /** Unix ms the request was received. */
  ts: number;
  /** Grant-derived role (agent|builder), or null for unverified traffic. */
  role: string | null;
  /** Grant-derived task id, or null. Trustworthy: never a client-supplied header. */
  taskId: string | null;
  /** anthropic|proxy|cursor|… — `cursor` records are coarse by construction. */
  backend: string;
  method: string;
  path: string;
  /** Wire model, when the backend speaks Anthropic's format. Null for cursor. */
  model: string | null;
}

/** The proxy is about to forward this request upstream. */
export interface ProxyActivityOpen extends ProxyActivityBase {
  kind: 'open';
}

/** The request settled (or failed). Projected from the audit record. */
export interface ProxyActivityClose extends ProxyActivityBase {
  kind: 'close';
  /** Upstream HTTP status, or null when the forward never got a response. */
  status: number | null;
  durationMs: number | null;
  /** Proxy/upstream error message, if any. Never contains a credential value. */
  error: string | null;
  /** Total tokens across all four counters, or null when none were captured. */
  totalTokens: number | null;
  /** tool_use blocks the policy engine denied on this response. */
  denials: number;
  /** True when the request ran on a failover target. */
  rerouted: boolean;
  /** True when the request failed — see `isFailure` in ./audit-query. */
  failed: boolean;
}

export type ProxyActivityEvent = ProxyActivityOpen | ProxyActivityClose;

/**
 * How many recent events are retained for replay.
 *
 * Replay is what makes `lazy watch` paint IMMEDIATELY instead of sitting blank
 * until the agent happens to make its next call — a command that shows nothing
 * is indistinguishable from one that is broken. Small on purpose: this is a
 * "what just happened" window, not history. History is the audit log.
 */
export const RECENT_EVENT_CAP = 200;

/**
 * Project the live `close` event from a durable audit record.
 *
 * Deliberately reuses `isFailure`/`denialsOf` rather than re-deriving them:
 * "was this request denied / did it fail" has exactly one answer, and a second
 * surface computing it by hand is how two readouts start disagreeing about a
 * security event (see the header of ./audit-query).
 */
export function closeEventFromRecord(record: ProxyAuditRecord): ProxyActivityClose {
  const u = record.usage;
  return {
    kind: 'close',
    id: record.id,
    seq: record.seq,
    ts: record.ts,
    role: record.role,
    taskId: record.taskId,
    backend: record.backend,
    method: record.method,
    path: activityPath(record.path),
    model: record.model,
    status: record.status,
    durationMs: record.durationMs,
    error: record.error,
    totalTokens: u
      ? (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0)
      : null,
    denials: denialsOf(record).length,
    rerouted: record.reroute !== null && record.reroute !== undefined,
    failed: isFailure(record),
  };
}

/**
 * The prefix the proxy puts on a refused-credential audit error, and the exact
 * string `credentialRefusalHint` keys its remedy line off.
 *
 * Shared rather than spelled twice: the renderer's hint is the ONLY place that
 * turns a 401 into "your placeholder has no live grant", and a reworded refusal
 * in the proxy would silently take that remedy off the screen with nothing
 * failing. This module is the light one both sides already import.
 */
export const CREDENTIAL_REFUSED_PREFIX = 'credential refused';

/**
 * The prefix the proxy puts on a refused-PATH audit error (403), as distinct
 * from a refused credential (401).
 *
 * Deliberately a different string: the two refusals have different remedies. A
 * credential refusal means the launch outlived its grant; a path refusal means an
 * agent tried to reach something outside the model API surface
 * (src/proxy/path-allowlist.ts), which is a security event worth being able to
 * grep for on its own.
 */
export const PATH_REFUSED_PREFIX = 'path refused';

/**
 * The path as a watcher should see it: query string removed.
 *
 * A query string is caller-controlled and carries no signal for "the agent is
 * doing something" — but it CAN carry values that were never meant for another
 * human's screen (`?key=…` on a hand-rolled call). Dropping it at publish time
 * means no downstream surface has to remember to.
 */
export function activityPath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

/** Filter applied to a subscription. Every field is optional and ANDed. */
export interface ProxyActivityFilter {
  /**
   * Accepted attribution forms for one task — match any of them.
   *
   * WHY A LIST AND NOT ONE STRING: what the proxy stamps on an event is the
   * task REF the agent was launched with (`taskRef()` — the task's code, or its
   * short id when it has none), because attribution comes from the credential
   * grant. What a caller has in hand is usually the full task id. Neither is a
   * prefix of the other, so a single string plus `startsWith` silently matched
   * NOTHING and `lazy watch` printed its header above an empty screen. The
   * caller resolves the task once and passes every form it answers to.
   */
  taskIds?: string[];
  /** Only events whose role matches exactly. */
  role?: string;
}

/**
 * Shortest form that may match as a PREFIX rather than outright.
 *
 * A 1–3 character fragment is not an identifier, it is a wildcard: `ec` would
 * subscribe an operator to every task whose id happens to start that way.
 */
export const MIN_LOOSE_PREFIX_LENGTH = 4;

/** Hex-only, i.e. shaped like a task id or a short id — never like a code. */
const HEXISH = /^[0-9a-f]+$/i;

/**
 * Does this event's task attribution answer to one of the accepted forms?
 *
 * Exact match always wins. Prefix matching is bidirectional (so a short id
 * matches a full id and vice versa, which is the whole reason this is a list —
 * see ProxyActivityFilter) but is deliberately restricted to HEX-SHAPED forms
 * of at least MIN_LOOSE_PREFIX_LENGTH: those are ids, where a prefix genuinely
 * denotes the same task, and an operator typing `ec67af` means exactly that.
 *
 * A CODE never matches loosely. lazy's own clone/redo conventions mint codes
 * that share a prefix with the task they came from — `add-agent-to-unblock` and
 * `add-agent-to-unblock-clone-1` both exist in this project's store — so prefix
 * matching on codes silently folds a sibling task's traffic into the watch, and
 * a watcher cannot tell whose request they are looking at.
 */
function taskMatches(eventTaskId: string | null, accepted: string[]): boolean {
  const value = eventTaskId ?? '';
  // Unattributed traffic belongs to no task. Without this it would match every
  // filter, since '' is a prefix of everything — the firehose is where it shows.
  if (!value) return false;
  return accepted.some((form) => {
    if (!form) return false;
    if (form === value) return true;
    if (!HEXISH.test(form) || !HEXISH.test(value)) return false;
    if (form.length < MIN_LOOSE_PREFIX_LENGTH || value.length < MIN_LOOSE_PREFIX_LENGTH) {
      return false;
    }
    return value.startsWith(form) || form.startsWith(value);
  });
}

export function matchesFilter(
  event: ProxyActivityEvent,
  filter: ProxyActivityFilter = {},
): boolean {
  if (filter.taskIds !== undefined && !taskMatches(event.taskId, filter.taskIds)) return false;
  if (filter.role !== undefined && (event.role ?? '') !== filter.role) return false;
  return true;
}

type Subscriber = (event: ProxyActivityEvent) => void;

/**
 * In-process publish/subscribe for proxy activity, with a bounded replay ring.
 *
 * Lives in the daemon process: the proxy publishes, the `watchProxyActivity`
 * RPC handler subscribes. Nothing here is persisted and nothing here is
 * awaited — see the module header for why that is the right trade.
 */
export class ProxyActivityBus {
  private readonly subscribers = new Set<Subscriber>();
  private recent: ProxyActivityEvent[] = [];
  private readonly cap: number;

  constructor(cap: number = RECENT_EVENT_CAP) {
    this.cap = cap;
  }

  /** Fire-and-forget. Synchronous, and cannot throw into the caller. */
  publish(event: ProxyActivityEvent): void {
    this.recent.push(event);
    // Drop the single oldest rather than re-slicing the whole window: this runs
    // on the proxy's request path, and allocating a fresh 200-element array per
    // request is work the hot path should not be doing.
    while (this.recent.length > this.cap) this.recent.shift();

    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (err) {
        // A broken listener is dropped rather than retried: it has already
        // demonstrated it cannot receive, and the proxy must not spend another
        // request's latency finding that out again.
        this.subscribers.delete(subscriber);
        logger.warn(
          `[proxy] activity subscriber removed after it threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  /** Retained events, oldest first, optionally filtered. */
  recentEvents(filter: ProxyActivityFilter = {}): ProxyActivityEvent[] {
    return this.recent.filter((e) => matchesFilter(e, filter));
  }

  /** Live subscriber count — test/diagnostic use. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Drop retained events and subscribers (test teardown). */
  reset(): void {
    this.recent = [];
    this.subscribers.clear();
  }
}

/**
 * The daemon's bus. A module singleton because there is exactly one proxy per
 * daemon process and the RPC handler needs to reach it without the proxy's
 * `Bun.serve` handle being threaded through every layer between them — the same
 * shape src/daemon/progress-registry.ts uses for the same reason.
 */
export const proxyActivity = new ProxyActivityBus();

// --- Validation (the wire boundary) -------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse an activity event that arrived over the wire, returning null when it is
 * not one.
 *
 * The daemon serializes these into the heartbeat envelope's progress lines as
 * an opaque payload, so the CLI is an external surface receiving untrusted
 * shape — it validates rather than casting. A malformed event is dropped, not
 * rendered as `undefined undefined`.
 */
export function parseProxyActivityEvent(value: unknown): ProxyActivityEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  const id = str(v.id);
  const method = str(v.method);
  const path = str(v.path);
  const backend = str(v.backend);
  const ts = numOrNull(v.ts);
  if (id === null || method === null || path === null || backend === null || ts === null) return null;

  const base: ProxyActivityBase = {
    id,
    seq: numOrNull(v.seq) ?? 0,
    ts,
    role: str(v.role),
    taskId: str(v.taskId),
    backend,
    method,
    path,
    model: str(v.model),
  };

  if (v.kind === 'open') return { ...base, kind: 'open' };
  if (v.kind !== 'close') return null;

  return {
    ...base,
    kind: 'close',
    status: numOrNull(v.status),
    durationMs: numOrNull(v.durationMs),
    error: str(v.error),
    totalTokens: numOrNull(v.totalTokens),
    denials: numOrNull(v.denials) ?? 0,
    rerouted: v.rerouted === true,
    failed: v.failed === true,
  };
}
