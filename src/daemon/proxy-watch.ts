/**
 * `watchProxyActivity` — the daemon's live proxy-traffic subscription.
 *
 * Every agent lazy runs sends its API traffic through the always-on proxy, and
 * since proxy-jit-credentials that traffic is attributed from the credential
 * grant rather than a self-reported header. That makes the proxy the one
 * agent-agnostic place where "the agent is doing something" is observable —
 * which is what `lazy watch` streams from here (see src/proxy/activity.ts for
 * why the bus exists rather than a tail of the audit log).
 *
 * TRANSPORT: no new one. The heartbeat envelope (./heartbeat.ts) already frames
 * a long reply as NDJSON and already carries `{"progress": …}` lines mid-flight
 * with a client-side observer to receive them. A subscription is simply a
 * request that emits many progress events and settles when its window closes;
 * the client re-subscribes to keep watching. Heartbeats every 5s keep the
 * connection off the listener's idle timer for the whole window.
 *
 * The daemon owns the filtering — the client says which task it cares about and
 * receives only that, rather than being handed a firehose to sift.
 */

import { RpcError } from './rpc-error';
import { optionalBoolean, optionalNumber, optionalString } from './rpc-params';
import type { ProgressEmitter } from './progress';
import {
  matchesFilter, proxyActivity,
  type ProxyActivityBus, type ProxyActivityFilter,
} from '../proxy/activity';

/** Channel name carried on every emitted progress event. */
export const PROXY_ACTIVITY_CHANNEL = 'proxy';

/**
 * Longest a single subscription is held open.
 *
 * Bounded rather than endless so a client that vanishes without closing its
 * socket cannot pin a subscriber forever; the CLI simply re-subscribes, and the
 * replay window covers the handover gap. Well under `wait`'s 600s long-poll,
 * which is the precedent for how long a daemon request may legitimately live.
 */
export const MAX_WATCH_WINDOW_MS = 240_000;

/** Default window when the caller does not ask for one. */
export const DEFAULT_WATCH_WINDOW_MS = 120_000;

/** Floor, so a mistyped `durationMs: 5` cannot turn watching into a busy loop. */
export const MIN_WATCH_WINDOW_MS = 1_000;

export interface WatchProxyActivityResult {
  /** Events emitted from the replay ring at subscription time. */
  replayed: number;
  /** Events emitted live during the window. */
  live: number;
  /** How long the subscription actually stayed open. */
  windowMs: number;
}

/**
 * Hold a subscription open for a bounded window, emitting each matching event
 * as a `{kind:'activity'}` progress line.
 *
 * `bus` is injectable so a unit test can drive events without a live proxy.
 */
export async function handleWatchProxyActivity(
  params: Record<string, unknown> = {},
  progress?: ProgressEmitter,
  bus: ProxyActivityBus = proxyActivity,
): Promise<WatchProxyActivityResult> {
  // A subscription with nowhere to deliver is a silent no-op, and a silent
  // no-op is exactly how a watcher ends up staring at a blank screen believing
  // nothing is happening. Refuse loudly instead, naming the remedy.
  if (!progress) {
    throw new RpcError(
      400,
      'watchProxyActivity streams its results and requires heartbeat framing. ' +
        `Send the ${'X-Lazy-Heartbeat'} header (every lazy client does; a bare curl does not).`,
    );
  }

  const filter: ProxyActivityFilter = {};
  // `taskIds` carries every form the task answers to (full id, short id, code,
  // launch ref) because the proxy stamps events with the REF from the agent's
  // credential grant, not the full id the caller usually holds — see the
  // ProxyActivityFilter docs. `taskId` remains accepted as a single form so a
  // direct caller can subscribe with whatever it has.
  const taskIds = optionalStringArray(params, 'taskIds');
  const taskId = optionalString(params, 'taskId');
  const supplied = [...(taskIds ?? []), ...(taskId !== undefined ? [taskId] : [])];
  const forms = supplied.filter((f) => f.trim().length > 0);
  // A scoping parameter that scopes nothing must NOT fall through to the
  // firehose: `taskIds: [""]` reads like "this one task" and would silently
  // hand back every task's traffic instead — a widening of scope the caller
  // never asked for. Degenerate input is a 400 at the boundary, per lazy's
  // rule that every external surface confirms its inputs.
  if (supplied.length > 0 && forms.length === 0) {
    throw new RpcError(400, 'taskId/taskIds must name at least one non-empty task form');
  }
  if (forms.length > 0) filter.taskIds = [...new Set(forms)];
  const role = optionalString(params, 'role');
  if (role) filter.role = role;

  const requested = optionalNumber(params, 'durationMs') ?? DEFAULT_WATCH_WINDOW_MS;
  const windowMs = Math.min(MAX_WATCH_WINDOW_MS, Math.max(MIN_WATCH_WINDOW_MS, requested));
  const replay = optionalBoolean(params, 'replay') ?? true;

  let replayed = 0;
  let live = 0;

  const emit = (payload: unknown) => {
    progress({ kind: 'activity', channel: PROXY_ACTIVITY_CHANNEL, payload });
  };

  // Replay FIRST, and before subscribing, so the client paints immediately
  // instead of waiting for the agent's next call — a watcher that sees nothing
  // cannot tell "quiet" from "broken". Reading the ring before subscribing also
  // means an event cannot be missed in between; a duplicate is possible instead,
  // and the client de-duplicates on record id.
  if (replay) {
    for (const event of bus.recentEvents(filter)) {
      emit(event);
      replayed++;
    }
  }

  const unsubscribe = bus.subscribe((event) => {
    // The bus filters nothing — filtering is this handler's job, so a second
    // subscriber with a different filter is unaffected by ours. Note this uses
    // the SAME matcher as the replay path above: a hand-rolled second copy of
    // the matching rule is how replay and live drifted apart once already.
    if (!matchesFilter(event, filter)) return;
    emit(event);
    live++;
  });

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, windowMs));
  } finally {
    unsubscribe();
  }

  return { replayed, live, windowMs };
}

/**
 * Wire boundary: a list of strings, or undefined when ABSENT.
 *
 * Malformed is a 400, not an undefined: silently ignoring a filter the caller
 * did supply would widen the subscription to every task's traffic, which is the
 * opposite of what they asked for.
 */
function optionalStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new RpcError(400, `${key} must be an array of strings`);
  }
  return value as string[];
}
