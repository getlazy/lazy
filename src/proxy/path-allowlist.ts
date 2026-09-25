/**
 * What the proxy is willing to FORWARD.
 *
 * THE HOLE THIS CLOSES: the proxy used to forward `url.pathname + url.search`
 * verbatim to whichever upstream it resolved. That is fine when the upstream is
 * api.anthropic.com — its whole surface is the model API — but a profile
 * upstream (src/proxy/agent-upstreams.ts) can be a local ollama server, whose surface also
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
 * THREE TIERS. The Anthropic-shaped primary gets the documented model API; an
 * Anthropic-wire role upstream gets inference and nothing else (an ollama
 * endpoint has no legitimate non-inference traffic from an agent, so its list
 * is strictly the smaller one); an OpenAI-compatible profile upstream gets the
 * OpenAI inference surface (`/v1/chat/completions`, `/v1/responses`, model
 * discovery) and never the Anthropic paths — nor anything account-shaped.
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

/** Which upstream a request is bound for — each tier gets its own list. */
export type UpstreamTier =
  /** The configured Anthropic-native primary (or one of its failover targets). */
  | 'primary'
  /**
   * A per-PROFILE Anthropic-wire upstream: e.g. a local ollama server, or
   * OpenRouter's Messages endpoint. The identifier still reads `role` because
   * these upstreams were role-wide before `[agents.<name>]` profiles; the tier
   * is the same set of paths either way, so renaming it would churn every
   * allowlist entry and its tests for nothing.
   */
  | 'role'
  /** A per-profile OpenAI-compatible upstream (api.openai.com, openrouter.ai). OpenAI wire only. */
  | 'openai';

interface AllowedRoute {
  /** HTTP methods permitted on this path. Anything else is refused. */
  methods: readonly string[];
  /** Normalised pathname to match. */
  path: string;
  /** When true, sub-paths of `path` match too (`/v1/models/<id>`). */
  prefix?: boolean;
  /** Tiers this route is forwarded on. A tier not listed refuses the path. */
  tiers: readonly UpstreamTier[];
}

/**
 * The forwarding surface. Every entry is here because lazy has SEEN it, or
 * because it is a documented read-only part of the same model API — never
 * because it seemed harmless.
 *
 * The `openai` tier is DISJOINT from the Anthropic tiers on the inference
 * paths, deliberately: the Anthropic extractor must never see OpenAI-wire
 * traffic and vice versa, and an Anthropic-wire client misconfigured against an
 * OpenAI upstream (or the reverse) should fail with lazy's actionable 403, not
 * an upstream 404 that reads as an outage.
 */
export const PROXY_ALLOWED_ROUTES: readonly AllowedRoute[] = [
  {
    // The model API itself — the reason the proxy exists. 224 of the 259
    // requests in this project's own audit log are this path.
    methods: ['POST'],
    path: '/v1/messages',
    tiers: ['primary', 'role'],
  },
  {
    // Claude Code counts tokens before large turns. Inference-shaped and
    // read-only, so it is allowed on a role upstream too — ollama answers it
    // with a 404 (and so does OpenRouter's Anthropic-compatible endpoint,
    // verified 2026-09-02), and turning that into a lazy 403 would trade a
    // truthful upstream answer for a misleading one while protecting nothing.
    methods: ['POST'],
    path: '/v1/messages/count_tokens',
    tiers: ['primary', 'role'],
  },
  {
    // Claude Code's unauthenticated reachability probe against
    // ANTHROPIC_BASE_URL. Refusing it would report the endpoint as DOWN to the
    // agent, which is the one failure mode the proxy's "never 401 an
    // unauthenticated probe" rule already exists to avoid (src/proxy/server.ts
    // header comment). HEAD is what the CLI sends; GET is included because a
    // probe that changes verb must not read as an outage. On the openai tier
    // too: a probe is harmless everywhere and only ever read-only.
    methods: ['HEAD', 'GET'],
    path: '/api/hello',
    tiers: ['primary', 'role', 'openai'],
  },
  {
    // Read-only model discovery. On the ANTHROPIC side it is what an SDK calls
    // to resolve a model alias; on the OPENAI side both api.openai.com and
    // openrouter.ai serve it and OpenAI-wire clients call it to validate a
    // model name. NOT on the `role` tier: there the equivalent lists the user's
    // locally pulled ollama models, which is inventory disclosure an agent has
    // no inference need for. The openai tier's upstreams are hosted services
    // whose model list is public catalogue, not local inventory.
    methods: ['GET'],
    path: '/v1/models',
    prefix: true,
    tiers: ['primary', 'openai'],
  },
  {
    // OpenAI-wire inference: the Chat Completions API. pi's OpenAI/OpenRouter
    // providers speak this. OPENAI TIER ONLY — the primary and role tiers are
    // Anthropic-wire.
    methods: ['POST'],
    path: '/v1/chat/completions',
    tiers: ['openai'],
  },
  {
    // OpenAI-wire inference: the Responses API — what the Codex agent drives
    // via OPENAI_BASE_URL. Sub-paths cover the documented follow-ups on a
    // stored response (GET /v1/responses/{id}, its input_items listing, POST
    // {id}/cancel) — all inference-lifecycle, none account-surface.
    methods: ['GET', 'POST'],
    path: '/v1/responses',
    prefix: true,
    tiers: ['openai'],
  },
  {
    // The SAME two OpenAI-wire surfaces, unprefixed. The ChatGPT subscription
    // backend serves Codex at `https://chatgpt.com/backend-api/codex`, where the
    // Responses API is `<base>/responses` with no `/v1` segment (verified
    // against codex-cli 0.152.1 — see docs/codex-chatgpt-subscription.md). The
    // proxy forwards a request's path to the upstream UNCHANGED, which is an
    // invariant worth keeping, so the unprefixed spelling is listed here rather
    // than rewritten on the way out.
    //
    // OPENAI TIER ONLY, and no new capability: these are the same inference and
    // model-discovery paths the entries above already allow, in the spelling
    // that upstream uses. No account, billing or administrative surface sits at
    // an unprefixed path on any openai-tier upstream.
    methods: ['GET', 'POST'],
    path: '/responses',
    prefix: true,
    tiers: ['openai'],
  },
  {
    methods: ['GET'],
    path: '/models',
    prefix: true,
    tiers: ['openai'],
  },
];

export type PathRefusalReason =
  /** The path is on no entry at all. */
  | 'unlisted-path'
  /** The path is listed, but not for this method. */
  | 'method-not-allowed'
  /** The path is listed, but not for the tier this request's upstream is on. */
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

  if (!onMethod.some((r) => r.tiers.includes(tier))) {
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
      return 'path is not forwarded to this kind of upstream (inference only, matching its wire format)';
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
    ? "a per-profile upstream (an agent profile's endpoint, such as a local ollama server)"
    : tier === 'openai'
      ? 'an OpenAI-compatible upstream (api.openai.com, openrouter.ai)'
      : 'the Anthropic upstream';
  const allowed = PROXY_ALLOWED_ROUTES
    .filter((r) => r.tiers.includes(tier))
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
