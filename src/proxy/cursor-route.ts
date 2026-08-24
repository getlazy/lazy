/**
 * Cursor passthrough route for lazy's proxy.
 *
 * WHY A PATH PREFIX RATHER THAN A SECOND PORT: the daemon already publishes one
 * proxy address that both container and host launches resolve (see
 * `proxyBaseUrlForRunner`). cursor-agent's endpoint override (`CURSOR_API_ENDPOINT`
 * / `--endpoint`) preserves a path prefix on the base URL — verified empirically:
 * `CURSOR_API_ENDPOINT=http://host:port/_lazy/cursor` produced
 * `POST /_lazy/cursor/auth/exchange_user_api_key` — so one port can host both the
 * Anthropic-native root and this route with no extra socket, firewall hole, or
 * discovery surface.
 *
 * WHY THE CREDENTIAL LIVES IN THE PATH: cursor-agent's `-H` flag is documented as
 * applying to *agent* requests only, and probing confirmed it does NOT appear on
 * `/auth/exchange_user_api_key`. A header would therefore cover only some of the
 * CLI's requests. The base URL, by contrast, is inherited by every request it
 * makes, so the launch's placeholder credential rides in one fixed segment right
 * after the prefix and is stripped before forwarding.
 *
 * That segment is what the proxy authenticates: it resolves to the grant, and
 * the grant states the role and task. This REPLACED two self-reported `role` /
 * `taskId` segments — those were whatever the client chose to put there, so any
 * container could have claimed another task's identity in the audit trail.
 *
 * The route is deliberately OPAQUE: requests are forwarded verbatim (method,
 * path, headers, streamed body) and audited coarsely. `src/proxy/extractor.ts` is
 * Anthropic-wire-shaped and must never see a cursor request.
 */

import type { RunnerType } from '../config/types';
import { proxyBaseUrlForRunner } from '../utils/role-target';

/** Path prefix that marks a request as cursor-bound. */
export const CURSOR_PROXY_PREFIX = '/_lazy/cursor';

/** Cursor's production API origin — the default upstream for this route. */
export const DEFAULT_CURSOR_UPSTREAM = 'https://api2.cursor.sh';

/**
 * Segment placeholder for "this launch has no minted grant".
 *
 * The one case that reaches it: a HOST cursor-agent authenticating with its own
 * `cursor-agent login` session instead of an API key. There is no key to swap,
 * so there is nothing to mint a placeholder against — the proxy forwards that
 * session credential untouched and records the traffic unattributed. Container
 * launches never hit this: they refuse outright without a key.
 */
const NONE = '-';

/** Same conservative alphabet the role/task header values use. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface CursorProxyRoute {
  /**
   * The launch's placeholder credential, or null for an unauthenticated launch
   * (see NONE). The proxy resolves it against the grant registry to get role and
   * task — attribution is therefore EVIDENCE, not a claim the client made.
   */
  token: string | null;
  /** Path (plus query) to forward upstream, with the lazy prefix removed. */
  upstreamPath: string;
}

/**
 * Build the `CURSOR_API_ENDPOINT` value for a launch.
 *
 * `proxyBaseUrl` is the already-surface-resolved proxy base (host.docker.internal
 * for containers, loopback for host processes).
 *
 * `token` is the launch's minted placeholder credential. It rides in the path
 * for the same reason the role/task segments used to: cursor-agent's `-H` flag
 * does not cover every request it makes, so a header would authenticate only
 * some of them. Putting it in the base URL means EVERY cursor request carries
 * it. That is safe here and only here — the base URL points at lazy's own
 * loopback/host-internal proxy, the token is worthless anywhere else, and the
 * prefix is stripped before anything is forwarded to Cursor.
 */
export function cursorProxyEndpoint(proxyBaseUrl: string, token?: string | null): string {
  const base = proxyBaseUrl.replace(/\/$/, '');
  const segment = token && SAFE_SEGMENT.test(token) ? token : NONE;
  return `${base}${CURSOR_PROXY_PREFIX}/${segment}`;
}

/** True when this request path belongs to the cursor route. */
export function isCursorProxyPath(pathname: string): boolean {
  return pathname === CURSOR_PROXY_PREFIX || pathname.startsWith(`${CURSOR_PROXY_PREFIX}/`);
}

/**
 * Split a cursor-route request path into its attribution segments and the
 * upstream path.
 *
 * Strict on purpose (CLAUDE.md: validate at the boundary). The arity is fixed:
 * exactly one credential segment follows the prefix. A request that does not
 * match is rejected by the caller rather than guessed at — a malformed prefix
 * means the launch wiring is wrong, and silently forwarding it would produce
 * unattributed audit records that look fine.
 */
export function parseCursorProxyPath(pathAndQuery: string): CursorProxyRoute | null {
  const queryAt = pathAndQuery.indexOf('?');
  const pathname = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const search = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);

  if (!isCursorProxyPath(pathname)) return null;

  const rest = pathname.slice(CURSOR_PROXY_PREFIX.length); // '' | '/tok' | '/tok/a/b'
  const segments = rest.split('/').slice(1); // drop the leading empty segment
  if (segments.length < 1) return null;

  const [token, ...tail] = segments;
  if (!SAFE_SEGMENT.test(token)) return null;

  const upstreamPath = `/${tail.join('/')}`;
  return {
    token: token === NONE ? null : token,
    upstreamPath: upstreamPath + search,
  };
}

/** Env var cursor-agent reads to override its API endpoint. */
export const CURSOR_ENDPOINT_ENV = 'CURSOR_API_ENDPOINT';

/**
 * Build the cursor endpoint env var for a launch, or fail loud.
 *
 * Mirrors the Anthropic path's contract (see `ProxyUnavailableError` in
 * src/daemon/auth-env.ts): the audit plane has no off switch, so a cursor launch
 * that cannot reach the proxy FAILS rather than connecting straight to Cursor's
 * servers with nothing recorded. The error is raised here rather than reusing
 * `ProxyUnavailableError` because both launch sites live upstream of
 * `src/daemon/auth-env.ts` in the import graph.
 */
export function cursorProxyEnvVars(
  proxyBaseUrl: string | undefined,
  token?: string | null,
): Array<{ key: string; value: string }> {
  if (!proxyBaseUrl) {
    throw new Error(
      `lazy could not resolve the live proxy address for a cursor turn.\n` +
      `All cursor API traffic routes through lazy's local audit proxy, always. Continuing\n` +
      `without it would talk straight to Cursor's servers with no audit record, so lazy\n` +
      `refuses rather than silently degrade. There is no way to turn the proxy off.\n\n` +
      `What to do:\n` +
      `  - Check the daemon:    lazy daemon status\n` +
      `  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)\n` +
      `  - Still failing? Its startup log says why the proxy did not bind: lazy daemon logs`,
    );
  }
  return [{ key: CURSOR_ENDPOINT_ENV, value: cursorProxyEndpoint(proxyBaseUrl, token) }];
}

/**
 * The launch-time env for an agent about to run, given the surface it runs on.
 *
 * ONE decision point for both launch surfaces (container in
 * `launchSupervisorAsync`, host in `HostProcessRunner`), because the surface is
 * exactly what they disagree about: a container reaches the proxy at
 * `host.docker.internal`, a host process at the proxy's own bind address. Doing
 * this inline at each site is how one of them ends up handing a container
 * address to a host process and silently failing to connect.
 *
 * Returns [] for every non-cursor agent — Anthropic traffic is routed by the
 * role-target machinery, not by this.
 */
export function cursorLaunchEnvVars(opts: {
  agentId: string | undefined;
  runnerType: RunnerType;
  /** Live proxy port, or undefined when the daemon context has no proxy. */
  proxyPort: number | undefined;
  bind: string;
  /**
   * The launch's minted placeholder credential — the proxy resolves it to the
   * role/task this traffic belongs to AND to the real Cursor key to inject.
   * Null only for a host launch with no API key at all (login-session auth):
   * that traffic is forwarded verbatim and recorded unattributed.
   */
  token: string | null;
}): Array<{ key: string; value: string }> {
  if (opts.agentId !== 'cursor') return [];
  const proxyBaseUrl = opts.proxyPort
    ? proxyBaseUrlForRunner(opts.runnerType, opts.proxyPort, opts.bind)
    : undefined;
  return cursorProxyEnvVars(proxyBaseUrl, opts.token);
}
