/**
 * The reverse proxy that puts a task's `[serve]` services on a NAME:
 * `http://<service>.<task>.lazy.localhost:<dashboard-port>`.
 *
 * It rides the daemon's existing dashboard listener — same Bun.serve, same port
 * — and routes purely on the Host header, so nothing new is bound and nothing
 * new is exposed: the listener was already loopback-only.
 *
 * Why a proxy at all, when the container's port is already published on
 * loopback: see src/serve/subdomain.ts. Short version — a name gives each task
 * its own cookie jar and stops the URL moving on every container recreate.
 *
 * ## The two invariants this file exists to hold
 *
 * INVARIANT: NOTHING on this path starts a container or runs
 * `start_services_cmd`. Not on a GET, not on any method, not "just once to be
 * helpful". A page anywhere on the internet can embed
 * `<img src="http://web.my-task.lazy.localhost:26024/x">`, and a proxy that
 * started containers would hand that page the ability to spend this machine's
 * CPU and disk. When a service is down the proxy REPORTS it; every start is a
 * POST behind a button the human pressed (src/server/container-start.ts).
 *
 * INVARIANT: the dashboard session cookie never leaves the dashboard host. The
 * browser already refuses to send it here (it is host-only, no `Domain=`), and
 * {@link upstreamRequestHeaders} strips it anyway — a task container runs
 * agent-written code, and the cookie is the human's full authority over the
 * daemon. The reverse direction is guarded too: {@link downstreamResponseHeaders}
 * drops `Domain=` from every upstream `Set-Cookie`, so an app cannot widen its
 * own cookie onto `lazy.localhost` and shadow that session.
 *
 * Being the proxy is a powerful seat. Every header decision — in either
 * direction — is in those two functions and nowhere else; keep it that way.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { Storage } from '../storage/interface';
import { getTaskServeState } from '../serve/discovery';
import { findService, type ResolvedService } from '../serve/ports';
import { parseServeHost } from '../serve/subdomain';
import { serveNoticePath, type ServeNoticeReason } from './serve-notice';
import { taskPathSegment, duplicateTaskCodes } from './task-urls';
import { DASHBOARD_COOKIE_NAME } from '../daemon/dashboard-auth';
import type { UpgradeOutcome, WebSocketUpgrader } from './ws';
import { logger } from '../utils/logger';

/**
 * How long a resolved target is reused.
 *
 * Resolution is expensive in a way that is easy to miss: `getTaskServeState`
 * loads config, builds a runner and shells out to `docker inspect` + `docker
 * port`. One HTML page pulling thirty assets would be sixty docker spawns
 * without this. Same window and same reasoning as the daemon's live commit
 * count (`COMMIT_COUNT_TTL_MS`) — a mapping at most this stale is
 * indistinguishable from a live one, because a container that moved its ports
 * was recreated, and that takes longer than this.
 *
 * The window is also short enough to be self-correcting: a failed connect
 * drops the entry immediately (see {@link forgetTarget}), so a container that
 * restarted is picked up on the very next request rather than at the deadline.
 */
const TARGET_TTL_MS = 2_000;

/** Cap on cached targets, so a long-lived daemon cannot accumulate them. */
const TARGET_CACHE_MAX = 256;

/**
 * How long the proxy waits for the upstream to send response HEADERS.
 *
 * Deliberately bounded, and deliberately only over the header phase: a dev
 * server that accepted the connection and then went quiet must not hold a
 * daemon request open forever, but a response that has STARTED may stream for
 * as long as it likes (SSE, a log tail, a large download). `AbortSignal.timeout`
 * would kill those too, which is why the timer below is cleared the moment
 * `fetch` resolves.
 */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;

/** How long the upstream WebSocket has to complete its handshake. */
const UPSTREAM_WS_OPEN_TIMEOUT_MS = 10_000;

/**
 * Headers that describe one HOP and must never be forwarded (RFC 9110 §7.6.1).
 * `host` is handled separately — preserving it is the entire point.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ServeProxyDeps {
  /** Project root the daemon serves. */
  root: string;
  /** Storage is resolved lazily — the proxy is built before storage init finishes. */
  getStorage(): Promise<Storage>;
  /** The dashboard's own hostname, e.g. `lazy.localhost`. Read per request: the bind may not have happened yet. */
  dashboardHost(): string;
}

/** A resolved upstream, or the reason there is not one. `seg` is the task's
 *  URL segment (code when unique, id otherwise, already escaped) for the
 *  serve-notice redirect — present on both outcomes because a successful
 *  resolution can still fail to CONNECT, and that redirect carries it too. */
type ProxyTarget =
  | { ok: true; taskId: string; seg: string; hostAddress: string; hostPort: number }
  | { ok: false; taskId: string | null; seg?: string; reason: ServeNoticeReason | 'unknown-task' };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const targetCache = new Map<string, { at: number; target: Promise<ProxyTarget> }>();

/**
 * `<service>.<task>` — the hostname prefix these two labels came from.
 *
 * Unambiguous because both are host labels by the time they get here, and a
 * host label cannot contain a dot: no pair of labels can collide with another.
 */
function cacheKey(task: string, service: string): string {
  return `${service}.${task}`;
}

/** Drop a cached target — called when its port stops answering. */
function forgetTarget(task: string, service: string): void {
  targetCache.delete(cacheKey(task, service));
}

/**
 * Resolve `<service>.<task>` to a host port, through the daemon's ONE serve
 * resolution path (`getTaskServeState` + `findService`) — never a second
 * lookup of its own.
 *
 * The in-flight PROMISE is cached, not just its value, so the thirty parallel
 * asset requests of a single page load collapse into one resolution rather than
 * thirty racing ones.
 */
async function resolveTarget(deps: ServeProxyDeps, task: string, service: string): Promise<ProxyTarget> {
  const key = cacheKey(task, service);
  const now = Date.now();
  const cached = targetCache.get(key);
  if (cached && now - cached.at < TARGET_TTL_MS) return cached.target;

  const pending = resolveTargetUncached(deps, task, service);
  // Delete before set so the entry moves to the END of the Map. `set` on an
  // existing key keeps its original position, which would make the oldest-first
  // eviction below read first-seen order instead of last-resolved order.
  targetCache.delete(key);
  targetCache.set(key, { at: now, target: pending });
  if (targetCache.size > TARGET_CACHE_MAX) pruneTargetCache(now);

  // A resolution that THREW must not be remembered as the answer for the next
  // two seconds — the next request should try again rather than inherit a
  // transient docker hiccup.
  pending.catch(() => targetCache.delete(key));
  return pending;
}

/**
 * Keep the cache under its cap: expired entries first, then — if that was not
 * enough — the oldest live ones.
 *
 * Dropping only EXPIRED entries would make the cap advisory rather than real.
 * Every `<anything>.<task>.lazy.localhost` is its own key, so a burst of
 * distinct labels inside one TTL window (a scan, or just a page whose assets
 * are spread over several service names) grows the Map with nothing to trim.
 * Evicting a live entry costs exactly one re-resolution — the same cost its
 * expiry would have imposed a moment later.
 */
function pruneTargetCache(now: number): void {
  for (const [key, entry] of targetCache) {
    if (now - entry.at >= TARGET_TTL_MS) targetCache.delete(key);
  }
  // Insertion order, and every resolution re-inserts, so this walks oldest
  // first. Deleting during Map iteration is well-defined.
  for (const key of targetCache.keys()) {
    if (targetCache.size <= TARGET_CACHE_MAX) break;
    targetCache.delete(key);
  }
}

async function resolveTargetUncached(
  deps: ServeProxyDeps,
  taskLabel: string,
  serviceLabel: string,
): Promise<ProxyTarget> {
  const storage = await deps.getStorage();
  const resolved = await storage.resolveTask(taskLabel);
  const task = resolved.task;
  // An ambiguous prefix is "no task" here on purpose: the proxy cannot ask
  // which one was meant, and picking would send someone's browser into an
  // arbitrary task's app.
  if (!task) return { ok: false, taskId: null, reason: 'unknown-task' };

  // The serve-notice redirect names the task by its code when the code is
  // unique, so the URL it lands on reads like every other task URL.
  const seg = taskPathSegment(task, duplicateTaskCodes(await storage.listTaskCodes()));
  const session = await storage.getSessionByTaskId(task.id);
  const state = await getTaskServeState(deps.root, task, session);

  if (state.unavailable) {
    return { ok: false, taskId: task.id, seg, reason: state.unavailable };
  }
  const service: ResolvedService | null = findService(state.services, serviceLabel);
  if (!service) return { ok: false, taskId: task.id, seg, reason: 'unknown-service' };
  if (!service.binding) return { ok: false, taskId: task.id, seg, reason: 'not-published' };

  return {
    ok: true,
    taskId: task.id,
    seg,
    hostAddress: service.binding.hostAddress,
    hostPort: service.binding.hostPort,
  };
}

// ---------------------------------------------------------------------------
// Header rewriting — the ONE place, in both directions
// ---------------------------------------------------------------------------

/**
 * Headers for the request we make to the container.
 *
 * The Host header is passed through UNCHANGED, which is the single most
 * load-bearing decision in this file: Vite and Rails' dev host allowlists both
 * admit `.localhost` names by default, and rewriting Host to `127.0.0.1` is
 * precisely what makes a dev server answer "Blocked request".
 *
 * @param clientIp Peer address of the browser connection, or null.
 */
export function upstreamRequestHeaders(req: Request, clientIp: string | null): Headers {
  const headers = new Headers();

  for (const [name, value] of req.headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // A client does not get to describe its own provenance: we are the edge, so
    // every forwarding header on the wire is ours to state. Dropping whatever
    // arrived means an app that trusts X-Forwarded-For cannot be lied to
    // through us.
    if (key === 'forwarded' || key.startsWith('x-forwarded-')) continue;
    // INVARIANT: the dashboard session never reaches a task container. The
    // browser will not send it (host-only cookie on the dashboard host), so
    // this is the second lock on the same door — cheap, and it means a change
    // in cookie scoping elsewhere cannot silently open it.
    if (key === 'cookie') {
      const kept = stripDashboardCookie(value);
      if (kept) headers.set('cookie', kept);
      continue;
    }
    // Bun's fetch transparently decompresses the response but leaves
    // `content-encoding` on it, so a proxied gzip response would arrive
    // labelled gzip and already plain — and the browser would fail to decode
    // it. Asking upstream not to compress removes the ambiguity at the source;
    // downstreamResponseHeaders cleans up if it compresses anyway.
    if (key === 'accept-encoding') continue;
    headers.set(name, value);
  }

  headers.set('accept-encoding', 'identity');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', 'http');
  const host = req.headers.get('host');
  if (host) headers.set('x-forwarded-host', host);
  return headers;
}

/**
 * The `cookie` header minus the dashboard session, or '' when nothing is left.
 * Other cookies are the app's own and travel untouched.
 *
 * Splitting on `;` alone is NOT enough. A request carrying two `Cookie:`
 * headers is folded by `Headers` iteration into one `", "`-joined value, so
 * `a=1, lazy_dashboard=X` arrives as a single `;`-segment whose name reads as
 * `a` — and the session would ride through. Each segment is therefore also
 * examined comma-by-comma.
 *
 * A comma cannot legally appear in a cookie NAME (RFC 6265), so this can only
 * ever mis-split a value some app spelled with commas — and that case is
 * handled by leaving the segment byte-for-byte alone whenever nothing in it was
 * dropped.
 */
export function stripDashboardCookie(cookieHeader: string): string {
  const kept: string[] = [];
  for (const segment of cookieHeader.split(';')) {
    const parts = segment.split(',');
    const survivors = parts.filter((part) => cookiePairName(part) !== DASHBOARD_COOKIE_NAME);
    if (survivors.length === 0) continue;
    const rebuilt = survivors.length === parts.length ? segment : survivors.join(',');
    const trimmed = rebuilt.trim();
    if (trimmed) kept.push(trimmed);
  }
  return kept.join('; ');
}

/** The name half of a `name=value` cookie pair, trimmed. */
function cookiePairName(pair: string): string {
  return pair.split('=')[0]?.trim() ?? '';
}

/**
 * Headers for the response we hand back to the browser.
 */
export function downstreamResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();

  // MEASURED: Bun's fetch decompresses the body but leaves `content-encoding`
  // and the now-wrong `content-length` on the response — and it does so even
  // when the request asked for `identity` and the upstream ignored that. So
  // relaying either header would tell the browser to gunzip plaintext. They are
  // dropped as a PAIR whenever the upstream claimed an encoding: the body goes
  // out chunked, which is true whatever its length.
  const wasEncoded = upstream.has('content-encoding');

  for (const [name, value] of upstream) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (wasEncoded && (key === 'content-encoding' || key === 'content-length')) continue;
    // Set-Cookie is multi-valued and Headers iteration folds it into one comma-
    // joined value, which is not re-splittable; it is re-added below instead.
    if (key === 'set-cookie') continue;
    headers.set(name, value);
  }

  // INVARIANT: an app cannot widen its cookie onto the dashboard's host.
  // `Set-Cookie: sid=x; Domain=lazy.localhost` from a task app would be sent
  // to EVERY task subdomain and to the dashboard itself — which is both the
  // cookie collision this whole feature exists to end, and a way to shadow the
  // human's `lazy_dashboard` session with a value the app chose. Stripping
  // `Domain` makes every app cookie host-only, which is what a per-task jar
  // means.
  for (const cookie of upstream.getSetCookie()) {
    headers.append('set-cookie', stripCookieDomain(cookie));
  }

  return headers;
}

/** One `Set-Cookie` value with any `Domain=` attribute removed. */
export function stripCookieDomain(setCookie: string): string {
  return setCookie
    .split(';')
    .filter((part) => !/^\s*domain\s*=/i.test(part))
    .join(';');
}

// ---------------------------------------------------------------------------
// The down case
// ---------------------------------------------------------------------------

/**
 * Is this a browser NAVIGATION — someone typing the URL, clicking a link,
 * reloading a tab — as opposed to an asset, an XHR or a `fetch`?
 *
 * Only a navigation may be answered with a redirect to an HTML page. Sending an
 * `<img>` or an XHR to the task page would hand a JSON parser a chunk of HTML
 * and produce a confusing error somewhere far away from the real problem.
 */
export function isNavigationRequest(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  // No Sec-Fetch-Mode (older browser, curl): fall back to what the caller says
  // it wants. An asset request asks for its own type first; a navigation asks
  // for HTML.
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/html');
}

/** One-line explanation for a machine-facing 502. */
function downText(reason: ServeNoticeReason | 'unknown-task', service: string, task: string): string {
  switch (reason) {
    case 'unknown-task':
      return `lazy: no task matches '${task}'.`;
    case 'unknown-service':
      return `lazy: task '${task}' declares no service '${service}'.`;
    case 'not-running':
      return `lazy: the container for task '${task}' is not running.`;
    case 'no-container-runner':
      return `lazy: task '${task}' runs without a container, so there is no port to proxy to.`;
    case 'not-published':
      return `lazy: task '${task}' does not publish '${service}' — its container predates the [serve] entry.`;
    case 'not-listening':
      return `lazy: nothing is listening for '${service}' on task '${task}'.`;
  }
}

/**
 * The answer when there is nothing to proxy to.
 *
 * A navigation goes to the task page, which explains the state and offers the
 * buttons that fix it. Everything else gets a plain 502 — honest to a machine,
 * and never HTML where HTML was not asked for.
 *
 * INVARIANT (restated where it would be broken): this function reports. It does
 * not start containers, does not run `start_services_cmd`, and must not grow a
 * "while we're here" that does.
 */
function downResponse(
  req: Request,
  dashboardOrigin: string,
  service: string,
  task: string,
  target: Extract<ProxyTarget, { ok: false }>,
): Response {
  if (target.reason !== 'unknown-task' && target.taskId && isNavigationRequest(req)) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${dashboardOrigin}${serveNoticePath(target.seg ?? encodeURIComponent(target.taskId), service, target.reason)}`,
        // The state that produced this redirect changes without warning; a
        // cached 302 would outlive it.
        'Cache-Control': 'no-store',
      },
    });
  }

  const status = target.reason === 'unknown-task' ? 404 : 502;
  return new Response(`${downText(target.reason, service, task)}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * The dashboard's own origin, derived from the Host the browser used.
 *
 * `web.my-task.lazy.localhost:26024` → `http://lazy.localhost:26024`. Taken by
 * dropping the two labels {@link parseServeHost} already validated, so the
 * redirect lands on the same port the browser is already talking to — and no
 * part of it is free-form client input.
 */
function dashboardOriginFor(hostHeader: string): string {
  return `http://${hostHeader.trim().split('.').slice(2).join('.')}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Try to serve one request as a task service.
 *
 * Returns null when the request is not addressed to a task subdomain, and the
 * daemon's ordinary routing continues. This is called FIRST in the daemon's
 * request chain, ahead of `/rpc`, `/mcp` and the dashboard guard: the subdomain
 * namespace belongs entirely to the app behind it, so an app route that happens
 * to be called `/rpc/x` must reach the app rather than lazy's own auth.
 */
export function createServeProxy(deps: ServeProxyDeps) {
  return async function handleServeProxy(req: Request, server: Server<unknown>): Promise<Response | null> {
    const hostHeader = req.headers.get('host');
    const ref = parseServeHost(hostHeader, deps.dashboardHost());
    if (!ref || !hostHeader) return null;

    // This request may stream for minutes (an SSE feed, a large download). The
    // daemon-wide idleTimeout is sized for RPC calls, so exempt it explicitly;
    // the header-phase timeout below is what actually bounds a dead upstream.
    server.timeout(req, 0);

    const dashboardOrigin = dashboardOriginFor(hostHeader);
    let target: ProxyTarget;
    try {
      target = await resolveTarget(deps, ref.task, ref.service);
    } catch (err) {
      logger.warn(`serve proxy: resolving ${ref.service}.${ref.task} failed: ${errText(err)}`);
      return new Response(`lazy: could not resolve '${ref.service}' on task '${ref.task}'.\n`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (!target.ok) return downResponse(req, dashboardOrigin, ref.service, ref.task, target);

    const url = new URL(req.url);
    const upstreamUrl = `http://${bracket(target.hostAddress)}:${target.hostPort}${url.pathname}${url.search}`;
    const clientIp = server.requestIP(req)?.address ?? null;

    // Bounded over the HEADER phase only: cleared as soon as fetch resolves, so
    // a streaming response is never cut off mid-flight. Chained to the client's
    // own signal so a browser that goes away releases the upstream connection.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream did not send headers in time')), UPSTREAM_HEADER_TIMEOUT_MS);
    const onClientAbort = () => controller.abort(req.signal.reason);
    req.signal.addEventListener('abort', onClientAbort, { once: true });

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamRequestHeaders(req, clientIp),
        // Streamed, never buffered: an upload of any size passes through
        // without the daemon holding it in memory. `duplex: 'half'` is required
        // by the Streams spec for a streaming request body.
        body: req.body,
        ...(req.body ? { duplex: 'half' } : {}),
        // A 3xx belongs to the browser, which must see the app's own Location
        // and decide. Following it here would resolve it against the container
        // port and leak that address into the browser's history.
        redirect: 'manual',
        signal: controller.signal,
      } as RequestInit);

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: downstreamResponseHeaders(upstream.headers),
      });
    } catch (err) {
      // The failed connect IS the liveness probe: one connect attempt, no
      // separate check, and therefore no window in which the port could go down
      // between probing and proxying.
      forgetTarget(ref.task, ref.service);
      if (req.signal.aborted) {
        // The browser left. Nothing to answer to; say so with a status no
        // client will read.
        return new Response(null, { status: 499 });
      }
      logger.debug(`serve proxy: ${ref.service}.${ref.task} -> ${upstreamUrl} failed: ${errText(err)}`);
      return downResponse(req, dashboardOrigin, ref.service, ref.task, {
        ok: false,
        taskId: target.taskId,
        seg: target.seg,
        reason: 'not-listening',
      });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onClientAbort);
    }
  };
}

function bracket(hostAddress: string): string {
  return hostAddress.includes(':') ? `[${hostAddress}]` : hostAddress;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** The browser-side socket, in the only two ways this file uses it. */
interface BrowserSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

/** Per-connection state for one proxied socket pair. */
interface ProxySocketData {
  upstream: WebSocket;
  /**
   * The browser side, once Bun has opened it.
   *
   * Null in the window between the upstream handshake completing and Bun
   * calling `open` — a real window, because we connect upstream FIRST (see
   * below). Frames that arrive during it go to {@link queue}.
   */
  browser: BrowserSocket | null;
  /** Upstream frames received before the browser socket existed. */
  queue: (string | Uint8Array)[];
  /** A close that arrived before the browser socket existed, replayed on open. */
  pendingClose: { code: number; reason: string } | null;
  /** Set by whichever side tears down first, so the other does not echo it back. */
  closed: boolean;
}

/**
 * Close codes an endpoint is allowed to SEND (RFC 6455 §7.4.1): 1000, and the
 * application range 3000–4999. The rest — 1005 "no status received", 1006
 * "abnormal closure", the reserved block — are LOCAL OBSERVATIONS a library
 * reports to its own caller and no endpoint may put on the wire. Relaying one
 * verbatim, which a naive pump does, makes the other side's library throw
 * instead of closing.
 */
export function relayableCloseCode(code: number): number {
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/** Close reasons are capped at 123 bytes by RFC 6455; longer ones are rejected. */
function closeReason(reason: string | undefined): string {
  return (reason ?? '').slice(0, 123);
}

/**
 * WebSocket passthrough for task subdomains: Vite and Next HMR, ActionCable,
 * and whatever else the app runs over a socket.
 *
 * Goes FIRST in the daemon's upgrader list. The subdomain namespace belongs to
 * the app behind it, so a task app with its own `/shell` or `/watch` socket must
 * reach the app rather than lazy's — and an upgrader that declines (returns
 * null) costs the dashboard's own routes nothing but a Host-header comparison.
 *
 * INVARIANT (same as the HTTP path): nothing here starts a container. A refused
 * socket is reported and that is all.
 */
export function createServeProxyUpgrader(deps: ServeProxyDeps): WebSocketUpgrader {
  return {
    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const hostHeader = req.headers.get('host');
      const ref = parseServeHost(hostHeader, deps.dashboardHost());
      if (!ref) return null;
      // A plain HTTP request on a task subdomain is not ours: declining sends it
      // to the HTTP proxy, which is the same code path from there on.
      if (!(req.headers.get('upgrade') ?? '').toLowerCase().split(',').some((t) => t.trim() === 'websocket')) {
        return null;
      }

      let target: ProxyTarget;
      try {
        target = await resolveTarget(deps, ref.task, ref.service);
      } catch (err) {
        logger.warn(`serve proxy ws: resolving ${ref.service}.${ref.task} failed: ${errText(err)}`);
        return refusal(502, `lazy: could not resolve '${ref.service}' on task '${ref.task}'.`);
      }
      if (!target.ok) {
        // A status, never the down-page redirect: a WebSocket handshake cannot
        // be answered with HTML, and no browser would render it if it were.
        return refusal(
          target.reason === 'unknown-task' ? 404 : 502,
          downText(target.reason, ref.service, ref.task),
        );
      }

      const url = new URL(req.url);
      const wsUrl = `ws://${bracket(target.hostAddress)}:${target.hostPort}${url.pathname}${url.search}`;
      const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

      let upstream: WebSocket;
      try {
        // Connect upstream BEFORE upgrading the browser. The subprotocol the app
        // selects has to be echoed in OUR handshake response, and after
        // server.upgrade() has run there is no response left to put it in —
        // which is exactly how a proxy breaks ActionCable, whose client aborts
        // unless it gets `actioncable-v1-json` back.
        upstream = await openUpstream(
          wsUrl,
          upstreamRequestHeaders(req, server.requestIP(req)?.address ?? null),
          protocols,
        );
      } catch (err) {
        forgetTarget(ref.task, ref.service);
        logger.debug(`serve proxy ws: ${wsUrl} failed: ${errText(err)}`);
        return refusal(502, downText('not-listening', ref.service, ref.task));
      }

      const data: ProxySocketData = {
        upstream,
        browser: null,
        queue: [],
        pendingClose: null,
        closed: false,
      };
      // Pump BEFORE upgrading, so a server that greets a new connection
      // immediately (ActionCable's `welcome`, Vite's `connected`) has its first
      // frame queued rather than dropped on the floor.
      attachUpstreamPump(data);

      const upgraded = server.upgrade(req, {
        data,
        ...(upstream.protocol ? { headers: { 'Sec-WebSocket-Protocol': upstream.protocol } } : {}),
      });
      if (!upgraded) {
        data.closed = true;
        upstream.close(1000, 'upgrade refused');
        return refusal(426, 'lazy: this endpoint expects a WebSocket upgrade.');
      }
      return 'upgraded';
    },

    handler: {
      open(ws: ServerWebSocket<ProxySocketData>) {
        const data = ws.data;
        data.browser = ws;
        for (const frame of data.queue) ws.send(frame);
        data.queue.length = 0;
        if (data.pendingClose) {
          const { code, reason } = data.pendingClose;
          data.closed = true;
          ws.close(code, reason);
        }
      },
      message(ws: ServerWebSocket<ProxySocketData>, message: string | Buffer) {
        const data = ws.data;
        if (data.upstream.readyState !== WebSocket.OPEN) return;
        data.upstream.send(message);
      },
      close(ws: ServerWebSocket<ProxySocketData>, code: number, reason: string) {
        const data = ws.data;
        if (data.closed) return;
        data.closed = true;
        if (
          data.upstream.readyState === WebSocket.OPEN ||
          data.upstream.readyState === WebSocket.CONNECTING
        ) {
          data.upstream.close(relayableCloseCode(code), closeReason(reason));
        }
      },
    } as unknown as import('bun').WebSocketHandler<unknown>,
  };
}

/**
 * Wire upstream→browser: frames, and a close on either failure or completion.
 *
 * Attached the moment the upstream handshake completes, which is before the
 * browser socket exists — see {@link ProxySocketData.queue}.
 */
function attachUpstreamPump(data: ProxySocketData): void {
  data.upstream.addEventListener('message', (event: MessageEvent) => {
    const frame = frameOf(event.data);
    if (frame === null) return;
    if (!data.browser) {
      data.queue.push(frame);
      return;
    }
    data.browser.send(frame);
  });

  const shutdown = (code: number, reason: string) => {
    if (data.closed) return;
    const relayed = { code: relayableCloseCode(code), reason: closeReason(reason) };
    if (!data.browser) {
      // The browser socket has not opened yet; `open` replays this.
      data.pendingClose = relayed;
      return;
    }
    data.closed = true;
    data.browser.close(relayed.code, relayed.reason);
  };

  data.upstream.addEventListener('close', (event: CloseEvent) => shutdown(event.code, event.reason ?? ''));
  data.upstream.addEventListener('error', () => shutdown(1011, 'upstream error'));
}

/** One upstream frame as something the browser socket can send, or null. */
function frameOf(value: unknown): string | Uint8Array | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Open the upstream socket, resolving once its handshake completes so the
 * negotiated subprotocol is readable, and rejecting on failure or timeout.
 *
 * The browser's own request headers ride along — including `Origin`, unchanged,
 * which is what lets an app's origin check (ActionCable's
 * `allowed_request_origins` defaults to "same as Host") pass: both headers name
 * the subdomain, and they agree.
 */
function openUpstream(url: string, headers: Headers, protocols: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headerObject: Record<string, string> = {};
    for (const [name, value] of headers) headerObject[name] = value;

    // Bun's WebSocket client takes an options object (headers, protocols); the
    // ambient DOM type in scope here only declares the `protocols` overload, so
    // the shape is asserted rather than the call being rewritten.
    const options = {
      headers: headerObject,
      ...(protocols.length ? { protocols } : {}),
    } as unknown as string[];
    const ws = new WebSocket(url, options);
    // Binary frames arrive as ArrayBuffer rather than Blob, so a frame can be
    // handed to the browser socket synchronously — a Blob would need an await
    // per frame and reorder a busy HMR stream. `frameOf` converts.
    ws.binaryType = 'arraybuffer';

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`upstream WebSocket did not open within ${UPSTREAM_WS_OPEN_TIMEOUT_MS}ms`));
    }, UPSTREAM_WS_OPEN_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('upstream WebSocket connection failed'));
    });
    // An upstream that closes without ever opening (server hung up mid-handshake)
    // fires close, not error, in some paths — without this the promise would
    // hang until the timeout for something already known to have failed.
    ws.addEventListener('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('upstream WebSocket closed during handshake'));
    });
  });
}

/** A refusal the WS seam understands: a plain response instead of an upgrade. */
function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Test seam: drop every cached target. */
export function resetServeProxyCache(): void {
  targetCache.clear();
}
