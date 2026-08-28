/**
 * What the proxy is willing to FORWARD.
 *
 * THE HOLE THIS CLOSES: the proxy used to forward `url.pathname + url.search`
 * verbatim to whichever upstream it resolved. That is fine when the upstream is
 * api.anthropic.com — its whole surface is the model API — but a role upstream
 * (src/proxy/role-upstreams.ts) can be a local ollama server, whose surface also
 * includes `/api/pull`, `/api/delete`, `/api/create` and `/api/ps`. A task agent
 * holds a placeholder whose grant routes to that upstream, so "the proxy decides
 * WHERE traffic goes" was not enough: it also has to decide WHAT goes there.
 * Otherwise a granted agent can delete the user's local models through lazy's own
 * audit plane.
 *
 * The allowlist is DATA, deliberately: every entry says why it exists, and adding
 * a surface is a reviewable one-line diff rather than a new conditional buried in
 * the forwarding path.
 *
 * WHAT IT MATCHES, AND WHY THAT IS SAFE. The proxy never handles the raw wire
 * request-target: `new URL(req.url)` (src/proxy/server.ts) resolves `.` and `..`
 * segments while parsing, so the `pathname` handed to `decideProxyPath` contains
 * none. A client that sends `/v1/messages/../../api/pull` produces the pathname
 * `/api/pull`, and it is refused as that — which is what it is. The safety
 * property is not the collapsing itself but that the string judged here and the
 * string forwarded are THE SAME string: the server builds its forward target from
 * that same `url.pathname`. Matching the raw target instead would let a traversal
 * match the `/v1/messages` entry while the upstream resolved it to `/api/pull`,
 * which is the classic way a path allowlist is bypassed.
 *
 * Encoded traversals are covered by the same seam: the URL spec defines a
 * double-dot segment as `..` OR a case-insensitive `%2e.` / `.%2e` / `%2e%2e`, so
 * the parser resolves those too and they arrive here already collapsed. Any OTHER
 * percent-encoded spelling is left encoded in `pathname` and therefore matches no
 * entry below, so it is refused as an unlisted path. Both outcomes fall out of the
 * list being default-deny rather than from a special case — there is no encoding
 * table here to keep in sync with anyone's.
 *
 * TWO TIERS. The Anthropic-shaped primary gets the documented model API; a role
 * upstream gets inference and nothing else. An ollama endpoint has no legitimate
 * non-inference traffic from an agent, so its list is strictly the smaller one.
 *
 * NOT COVERED: the cursor passthrough route (`/_lazy/cursor/...`). That route is
 * opaque by design — cursor-agent speaks connect-rpc over a path space lazy has
 * never enumerated, and the CLI's own auth call (`/auth/exchange_user_api_key`)
 * is already outside anything model-shaped. An allowlist written from guesswork
 * there would break the integration on cursor's next endpoint rename while
 * protecting nothing: the upstream is cursor's own API, not a user-controlled
 * server with an admin surface sitting next to the inference surface. It stays
 * verbatim, and stays audited. Revisit if lazy ever points that route at a
 * self-hosted or user-supplied cursor-compatible endpoint.
 */

/** Which upstream a request is bound for — the two tiers get different lists. */
export type UpstreamTier =
  /** The configured Anthropic-native primary (or one of its failover targets). */
  | 'primary'
  /** A per-role upstream: a non-Anthropic backend, e.g. a local ollama server. */
  | 'role';

interface AllowedRoute {
  /** HTTP methods permitted on this path. Anything else is refused. */
  methods: readonly string[];
  /** Normalised pathname to match. */
  path: string;
  /** When true, sub-paths of `path` match too (`/v1/models/<id>`). */
  prefix?: boolean;
  /** Allowed on a role upstream as well as the primary. */
  onRoleUpstream: boolean;
}

/**
 * The forwarding surface. Every entry is here because lazy has SEEN it, or
 * because it is a documented read-only part of the same model API — never
 * because it seemed harmless.
 */
export const PROXY_ALLOWED_ROUTES: readonly AllowedRoute[] = [
  {
    // The model API itself — the reason the proxy exists. 224 of the 259
    // requests in this project's own audit log are this path.
    methods: ['POST'],
    path: '/v1/messages',
    onRoleUpstream: true,
  },
  {
    // Claude Code counts tokens before large turns. Inference-shaped and
    // read-only, so it is allowed on a role upstream too — ollama answers it
    // with a 404, and turning that into a lazy 403 would trade a truthful
    // upstream answer for a misleading one while protecting nothing.
    methods: ['POST'],
    path: '/v1/messages/count_tokens',
    onRoleUpstream: true,
  },
  {
    // Claude Code's unauthenticated reachability probe against
    // ANTHROPIC_BASE_URL. Allowed on both tiers: refusing it would report the
    // endpoint as DOWN to the agent, which is the one failure mode the proxy's
    // "never 401 an unauthenticated probe" rule already exists to avoid
    // (src/proxy/server.ts header comment). HEAD is what the CLI sends; GET is
    // included because a probe that changes verb must not read as an outage.
    methods: ['HEAD', 'GET'],
    path: '/api/hello',
    onRoleUpstream: true,
  },
  {
    // Read-only model discovery on the documented Anthropic API. Not observed in
    // lazy's own traffic, but it is what an SDK calls to resolve a model alias,
    // and a GET that lists models cannot mutate anything. PRIMARY ONLY: on a
    // role upstream the equivalent lists the user's locally pulled models, which
    // is inventory disclosure an agent has no inference need for.
    methods: ['GET'],
    path: '/v1/models',
    prefix: true,
    onRoleUpstream: false,
  },
];

export type PathRefusalReason =
  /** The path is on no entry at all. */
  | 'unlisted-path'
  /** The path is listed, but not for this method. */
  | 'method-not-allowed'
  /** The path is listed for the primary, but this request is bound for a role upstream. */
  | 'role-upstream-restricted';

export type PathDecision =
  | { allowed: true }
  | { allowed: false; reason: PathRefusalReason };

/**
 * Normalise a pathname for matching: drop a trailing slash so `/v1/messages/`
 * and `/v1/messages` are the same decision. Root stays `/`.
 */
function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

function matchesPath(route: AllowedRoute, pathname: string): boolean {
  if (pathname === route.path) return true;
  return route.prefix === true && pathname.startsWith(route.path + '/');
}

/**
 * May the proxy forward `method pathname` to an upstream of this tier?
 *
 * Takes the pathname WITHOUT the query string: the query never widens the
 * surface (`?beta=true` is the normal spelling of `/v1/messages`), and matching
 * on it would make every entry brittle.
 */
export function decideProxyPath(
  method: string,
  pathname: string,
  tier: UpstreamTier,
): PathDecision {
  const path = normalise(pathname);
  const verb = method.toUpperCase();

  const onPath = PROXY_ALLOWED_ROUTES.filter((r) => matchesPath(r, path));
  if (onPath.length === 0) return { allowed: false, reason: 'unlisted-path' };

  const onMethod = onPath.filter((r) => r.methods.includes(verb));
  if (onMethod.length === 0) return { allowed: false, reason: 'method-not-allowed' };

  if (tier === 'role' && !onMethod.some((r) => r.onRoleUpstream)) {
    return { allowed: false, reason: 'role-upstream-restricted' };
  }
  return { allowed: true };
}

/** One-line summary for the audit record and the log line. */
export function pathRefusalReasonText(reason: PathRefusalReason): string {
  switch (reason) {
    case 'unlisted-path':
      return 'path is not part of the model API surface the proxy forwards';
    case 'method-not-allowed':
      return 'method is not permitted on this path';
    case 'role-upstream-restricted':
      return 'path is not forwarded to a per-role upstream (inference only)';
  }
}

/**
 * The body returned to the refused caller. Actionable per CLAUDE.md: it names
 * exactly what was refused, states the rule, and says what to do if the need is
 * legitimate — the allowlist is source, so the remedy is a code change, and
 * saying so beats letting someone hunt for a config key that does not exist.
 */
export function pathRefusalMessage(
  method: string,
  pathname: string,
  tier: UpstreamTier,
  reason: PathRefusalReason,
): string {
  const surface = tier === 'role'
    ? 'a per-role upstream (a non-Anthropic backend such as a local ollama server)'
    : 'the Anthropic upstream';
  const allowed = PROXY_ALLOWED_ROUTES
    .filter((r) => tier === 'primary' || r.onRoleUpstream)
    .map((r) => `  ${r.methods.join('/')} ${r.path}${r.prefix ? '/*' : ''}`)
    .join('\n');

  return (
    `lazy proxy: refused to forward ${method.toUpperCase()} ${pathname} to ${surface}.\n` +
    `Reason: ${pathRefusalReasonText(reason)}.\n\n` +
    `The proxy forwards the model API and nothing else. It is lazy's audit and policy\n` +
    `plane for agent traffic, so an agent's credential must not also reach an upstream's\n` +
    `administrative surface (on ollama: /api/pull, /api/delete, /api/create).\n\n` +
    `Forwarded to ${surface}:\n${allowed}\n\n` +
    `If this is a legitimate new need, add it to PROXY_ALLOWED_ROUTES in\n` +
    `src/proxy/path-allowlist.ts with a comment saying why — it is a reviewed list,\n` +
    `not a config knob.`
  );
}

/** Anthropic-shaped error body for a refusal (403 = authenticated, not permitted). */
export function pathRefusalBody(message: string): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'permission_error', message },
  });
}
