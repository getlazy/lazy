/**
 * Anthropic-native passthrough proxy server.
 *
 * Forwards ALLOWED requests to the configured upstream unchanged (path, method,
 * body, auth headers). What counts as allowed is the declared forwarding surface
 * in src/proxy/path-allowlist.ts — the proxy scopes WHAT it forwards, not just
 * WHERE, so a granted agent cannot reach an upstream's administrative endpoints
 * (ollama's /api/pull, /api/delete) through it. A refused request is 403'd with
 * an actionable body and recorded in the audit log; nothing is silently dropped.
 * Streams the SSE response body back untouched — never
 * buffers it. Strips stale content-encoding/content-length from the response
 * before forwarding (Bun's fetch transparently decodes gzip from real Anthropic;
 * forwarding the compressed-length headers to the client causes ZlibErrors).
 *
 * Per-request: reads the request body, runs the extractor, enqueues an audit
 * record asynchronously, then forwards. The audit enqueue returns immediately —
 * no blocking I/O on the hot path.
 *
 * Token usage is captured on both response paths (src/proxy/usage.ts). The
 * enforcement path already buffers the body, so it just parses it. The
 * streaming path tees the body: each chunk is forwarded to the client before
 * the usage scanner sees it, nothing is buffered, and the audit record is
 * enqueued when the stream ends. Only the terminal-error path (no response at
 * all) records `usage: null`, because there genuinely is none.
 *
 * Smart routing (opt-in): when `fallbacks` is configured, a primary that returns
 * 429/529 or is unreachable is rerouted to the next fallback target in order,
 * re-sending the (already-buffered) request body. Failover is EXPLICIT — it only
 * happens when the user configured a fallback chain; with no fallbacks the proxy
 * fails hard exactly as before (AGENTS.md: no silent fallbacks). Every reroute is
 * logged (logger.warn) and recorded on the audit record (`reroute`). A response
 * that has already begun streaming to the client is never rerouted mid-stream —
 * failover decisions are made purely on the upstream's status line, before its
 * body is handed back to the client.
 *
 * Outbound request plugins (user extension seam): when the project has plugin
 * modules in `.lazy/plugins/`, the parsed request body is passed through a chain
 * of pure transforms before it is forwarded (src/proxy/plugins). With no plugin
 * installed — the default — the chain is empty, short-circuits, and the original
 * bytes go out untouched.
 *
 * Clients without a grant (see JIT CREDENTIALS below) may identify themselves
 * with two optional headers:
 *   x-lazy-role     — "builder" | "agent"
 *   x-lazy-task-id  — short task id
 *
 * JIT CREDENTIALS: a launched agent never holds a real credential. It carries a
 * per-launch PLACEHOLDER (src/proxy/credential-broker.ts); this server resolves
 * it to the grant it was minted for, and swaps in the target's real credential
 * immediately before forwarding (src/proxy/inject.ts,
 * src/proxy/target-credentials.ts). Three consequences worth stating outright:
 *
 *  - Attribution is EVIDENCE. Role and task come from the grant, not from the
 *    x-lazy-role / x-lazy-task-id headers, which any client could have written.
 *    Those headers remain as a fallback for traffic with no grant (a host
 *    process using its own login session) and are still stripped before
 *    forwarding.
 *  - A placeholder NEVER goes upstream. Whichever header carried it is
 *    rewritten or removed for every target.
 *  - A request that presents no credential is forwarded with none added, not
 *    401'd. Claude Code probes this endpoint unauthenticated (HEAD /api/hello);
 *    401-ing that would report the endpoint as down. 401 is reserved for
 *    "presented a lazy placeholder that does not verify".
 */

import { randomUUID } from 'crypto';
import type { ResolvedConfig } from '../config/types';
import type { ProxyAuditRecord, ProxyEnforcementAudit, ProxyReroute } from '../storage/types';
import { extractRequest, classifyEndpoint } from './extractor';
import { warmToolResultTokenizer } from './tool-result-tokens';
import type { ProxyToolStatsRecorder } from './tool-stats';
import type { ProxyTurnLatencyRecorder } from './turn-latency-recorder';
import { AuditQueue, type AuditSink } from './audit';
import {
  captureUsageLimitHeaders,
  codexRefusalHeaders,
  daemonUsageLimits,
  usageLimitCredentialKey,
  type UsageLimitTracker,
} from './usage-limits';
import { credentialValuesIn, upstreamErrorExcerpt } from './upstream-error';
import { forwardableBody } from '../utils/forward-body';
import {
  activityPath, closeEventFromRecord, proxyActivity,
  CREDENTIAL_REFUSED_PREFIX, CREDENTIAL_UNAVAILABLE_PREFIX, PATH_REFUSED_PREFIX, TIERS_FULL_PREFIX, TIER_REFUSED_PREFIX, type ProxyActivityBus,
} from './activity';
import {
  decideProxyPath,
  pathRefusalBody,
  pathRefusalMessage,
  pathRefusalReasonText,
} from './path-allowlist';
import { enforceResponseBody } from './enforce';
import { extractUsage, readBodyTimed, teeUsageStream, type UsageWire } from './usage';
import { isSseContentType, withSseKeepAlive } from './keepalive';
import {
  DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
  describeUpstreamFailure,
  isUpstreamTimeout,
  upstreamFetchOptions,
} from './upstream-timeout';
import { extractOpenAIRequest } from './openai-extractor';
import { routeForProfile, type AgentUpstreamRoute } from './agent-upstreams';
import {
  chooseTier, earliestReset, allFullRetryAfterSeconds, allTiersFullMessage, allTiersFullBody,
  isCapacityRefusal, refusalFor, describeRefusal, daemonTierRefusals, DEFAULT_TIER_RETRY_INTERVAL_SECONDS,
  type TierChoice, type TierSwitchEvent, type TierRefusals,
} from './tier-select';
import { stripThinkingHistory } from './tier-history';
import type { TierServed } from '../types';
import { ANTHROPIC_OAUTH_BETA, originOf } from './target-credentials';
import { defaultPolicyConfig, type ProxyPolicyConfig } from './policy';
import { applyRequestPlugins, type ProxyRequestPlugin } from './plugins/types';
import {
  scanForPlaceholder,
  swapCredential,
  expectedFormFor,
  envVarForForm,
  denialMessage,
  normalizePeerAddress,
  type SessionAuthDenial,
  type SessionCredentialLookup,
} from './session-auth';
import { isSessionPlaceholderToken } from '../daemon/session-credentials';
import {
  CURSOR_PROXY_PREFIX,
  DEFAULT_CURSOR_UPSTREAM,
  isCursorProxyPath,
  parseCursorProxyPath,
  type CursorProxyRoute,
} from './cursor-route';
import {
  collectPresentedCredentials,
  applyCredential,
  stripAuthHeaders,
  removeBetaFlag,
  credentialErrorBody,
  credentialUnavailableBody,
  unknownPlaceholderMessage,
  missingCredentialMessage,
  type PresentedCredential,
} from './inject';
import type { TargetCredentialOutcome, TargetCredentials } from './target-credentials';
import {
  derivedPlaceholderFor,
  grantAcceptsPeer,
  DERIVED_PLACEHOLDER_PATTERN,
  type CredentialGrant,
} from './credential-broker';
import { looksLikeLazyPlaceholder } from './credential-broker';
import { logger } from '../utils/logger';

/**
 * What the server needs in order to exchange placeholders for real credentials.
 *
 * Passed as a REQUIRED-but-nullable constructor argument rather than an optional
 * one: passing null is a deliberate statement ("this server does no credential
 * work" — the shape most unit tests want), whereas an omitted optional would let
 * a real call site fail open by forgetting an argument, which is the one failure
 * mode this whole task exists to remove.
 */
export interface ProxyCredentialDeps {
  /** Resolve a presented value to the grant it was minted for, or null. */
  lookup(token: string): Promise<CredentialGrant | null>;
  /**
   * Hold upstream-minted credentials behind placeholders bound to the grant
   * (src/proxy/credential-broker.ts, bindDerivedCredentials). False = the grant
   * is gone. Optional only for unit tests of the routing paths; without it a
   * Cursor key exchange's tokens are WITHHELD, never forwarded raw.
   */
  bindDerived?(grantToken: string, pairs: ReadonlyArray<{ placeholder: string; real: string }>): Promise<boolean>;
  /** Per-upstream real credentials, resolved live at request time. */
  targets: TargetCredentials;
  /**
   * TEAM MODE: the credential a verified TASK caller is paid with — its turn
   * principal's own credential for the grant's profile — or null when the
   * per-upstream map decides (no team mode, no task). When it answers, it is
   * the whole answer for the caller's first target: nothing falls back to the
   * map, and failover targets are dropped rather than paid by anybody else.
   * See resolveMemberCredential in ./credential-deps.ts.
   */
  member?(grant: CredentialGrant, expectedOrigin?: string, route?: ProxyMemberRoute): Promise<MemberCredentialResolution | null>;
  /** null = solo mode; a member-mode answer never consults the project credential map. */
  memberUsage?(grant: CredentialGrant, endpoint: string): Promise<{ key: string | null } | null>;
}

/** Host-derived selected route; never populated from a request field. */
export interface ProxyMemberRoute {
  upstream: string;
  endpoint?: string;
  tier?: number;
  config?: ResolvedConfig;
}

/** What {@link ProxyCredentialDeps.member} answers. */
export interface MemberCredentialResolution {
  outcome: TargetCredentialOutcome;
  /** Whose credential it is, for the audit record; null when nobody could be named. */
  userId: string | null;
  /** The profile the credential was connected for; null when it is their Claude credential. */
  profile?: string | null;
  endpoint?: string | null;
}

/** A presented placeholder that verified, and the grant it proves. */
interface VerifiedCaller {
  grant: CredentialGrant;
  /** The placeholder value itself — what gets substituted out. */
  token: string;
  presented: PresentedCredential[];
}

/** A single failover target: an alternate Anthropic-native upstream + optional model override. */
export interface ProxyFallbackTarget {
  /** Anthropic-native base URL to reroute to (e.g. a different tier, or a local Ollama endpoint). */
  upstream: string;
  /**
   * Model to rewrite the request body's `model` to on this target. When unset,
   * the original wire model is preserved (useful when the fallback is a
   * different *backend* serving the same model name).
   */
  model?: string;
}

/**
 * What `createProxyServer` returns: Bun's primary server, whose `stop` also
 * stops every extra listener, plus `binds` — every address actually listening.
 */
export type ProxyServer = ReturnType<typeof Bun.serve> & {
  binds: string[];
  /** The audit queue's append history, for `lazy daemon health`. */
  auditHealth: () => ReturnType<AuditQueue['health']>;
};

/**
 * The proxy's own liveness path, answered by the proxy itself and never
 * forwarded. `lazy daemon health` sends one request here to prove the proxy
 * is listening and its handler runs — it carries no credential, reaches no
 * upstream, spends nothing and is not audited. Under the `/_lazy/` prefix the
 * cursor route already reserves, so it can never shadow an upstream path.
 */
export const PROXY_HEALTH_PATH = '/_lazy/health';

export interface ProxyAgentRouting {
  routes: Record<string, AgentUpstreamRoute>;
  targets: TargetCredentials;
  profiles: ReadonlySet<string>;
  /** Consent and routing must use the very same effective configuration. */
  config?: ResolvedConfig;
}

export interface ProxyServerConfig {
  /**
   * Addresses to listen on IN ADDITION to `bind`, on the same port — the
   * container bridge gateway on native Linux (see resolveProxyBindHosts in
   * src/daemon/bind-hosts.ts). Empty or absent means `bind` alone.
   */
  extraBindHosts?: string[];
  /** TCP port to listen on. */
  port: number;
  /** Bind address (e.g., "127.0.0.1"). */
  bind: string;
  /** Upstream Anthropic-compatible base URL (e.g., "https://api.anthropic.com"). */
  upstream: string;
  /**
   * Ordered failover targets, tried in sequence when the primary returns
   * 429/529 or is unreachable. Empty/undefined = no failover (fail hard).
   */
  fallbacks?: ProxyFallbackTarget[];
  /**
   * On a 429 whose `Retry-After` is ≤ this many seconds, wait that long and
   * retry the PRIMARY once before failing over (a brief rate-limit blip is
   * cheaper to wait out than to reroute). A larger Retry-After fails over
   * immediately. Default 5. Applies when a fallback chain is configured, and
   * to tiered profiles (a short 429 is waited out on the same tier).
   */
  retryAfterThreshold?: number;
  /**
   * Seconds a tier of a TIERED profile that refused for capacity (a 429) and
   * gave no retry time stays skipped before the next request tries it again
   * (`[proxy] tier_retry_interval`, default 300). Also the longest a
   * windowed tier waits, whatever reset it reported.
   */
  tierRetryIntervalSeconds?: number;
  /**
   * Mechanistic policy (§6.3 layer 1). Defaults to the decided closed posture
   * (enforce on, connectors deny-by-default) when omitted.
   */
  policy?: ProxyPolicyConfig;
  /**
   * Ordered outbound request-transform chain, already loaded from the project's
   * `.lazy/plugins/` directory by the caller (src/proxy/plugins/loader.ts).
   * Omitted or empty means NO plugin runs and the request body is forwarded
   * byte-for-byte, which is the default posture.
   *
   * The server takes a LIST rather than a config object on purpose: loading is
   * async and can fail loudly, and that failure belongs to daemon startup, not
   * to constructing a server.
   */
  plugins?: readonly ProxyRequestPlugin[];
  /**
   * Resolve a lazy session placeholder token to its owner's real credential
   * (src/proxy/session-auth.ts). Supplied by the daemon, which is the only
   * process that holds real per-user credentials.
   *
   * Omitted — the default, and the only shape a single-user install ever has —
   * means no request can carry a placeholder lazy would honour, so credential
   * headers are forwarded verbatim exactly as they always were.
   */
  resolveSessionCredential?: SessionCredentialLookup;
  /**
   * Per-PROFILE upstream overrides, keyed by the agent profile a verified
   * caller's grant was minted for (`[agents.<name>]`, see
   * src/proxy/agent-upstreams.ts). A request from a profile listed here is
   * forwarded to ITS upstream instead of the primary — this is what makes a
   * profile `endpoint` proxy-side routing rather than a direct connection the
   * agent makes itself.
   *
   * Deliberately NOT a failover chain: `[[proxy.fallback]]` is the primary's
   * failover, and failing an ollama profile over to api.anthropic.com would
   * change the model AND bill the user, silently (AGENTS.md: no silent
   * fallbacks). A profile upstream that is down fails, loudly, like any other
   * unreachable upstream.
   *
   * Existing profiles without an endpoint and unattributed traffic use the
   * primary upstream; removed profiles with verified grants are refused.
   *
   * Each entry carries the upstream's WIRE FORMAT too: an `openai` wire routes
   * the request through the OpenAI path-allowlist tier and the OpenAI usage
   * extractor; the Anthropic-shaped extractor never sees that traffic.
   */
  agentUpstreams?: Record<string, AgentUpstreamRoute>;
  /** Read routes and credential targets from the same config snapshot. */
  liveAgentRouting?: () => Promise<ProxyAgentRouting>;
  /**
   * Cursor API base URL that the `/_lazy/cursor/<token>` route forwards
   * to. Defaults to Cursor's production origin. This route is a verbatim
   * passthrough — see src/proxy/cursor-route.ts.
   */
  cursorUpstream?: string;
  /**
   * Seconds the proxy waits for an upstream to answer before giving up, on
   * every route. Defaults to {@link DEFAULT_UPSTREAM_TIMEOUT_SECONDS}; 0 means
   * no ceiling. This REPLACES Bun's hidden default fetch timeout, which used to
   * end slow local-model requests at a number lazy never chose — see
   * src/proxy/upstream-timeout.ts.
   */
  upstreamTimeoutSeconds?: number;
}

const LAZY_HEADERS = new Set(['x-lazy-role', 'x-lazy-task-id']);

/** Statuses that trigger failover to the next target. */
const OVERLOAD_STATUSES = new Set([429, 529]);

const DEFAULT_RETRY_AFTER_THRESHOLD = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap an SSE response body in keep-alive framing; hand anything else back
 * untouched.
 *
 * The content type is read from the headers the CLIENT will receive, so the
 * decision matches what the client's parser will do with the bytes. A
 * non-SSE body is never touched: an injected comment would corrupt JSON, and
 * cursor's connect-rpc passthrough is not SSE either.
 */
function keepAliveIfSse(
  body: ReadableStream<Uint8Array> | null,
  respHeaders: Headers,
): ReadableStream<Uint8Array> | null {
  if (!body || !isSseContentType(respHeaders.get('content-type'))) return body;
  return withSseKeepAlive(body);
}

/**
 * Parse a `Retry-After` header into seconds. Supports both the delta-seconds
 * form ("5") and the HTTP-date form. Returns null when absent/unparseable, and
 * never returns a negative wait.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
}

/**
 * Build the request body for a target. When the target overrides the model and
 * the body is JSON with a `model` field, re-serialise with the new model;
 * otherwise re-send the original bytes verbatim.
 */
function bodyForTarget(
  bodyText: string,
  parsedBody: unknown,
  model: string | undefined,
): string {
  if (!model || parsedBody === null || typeof parsedBody !== 'object') return bodyText;
  return JSON.stringify({ ...(parsedBody as Record<string, unknown>), model });
}

/** Most tasks whose tier state the proxy keeps in memory; the oldest is dropped. */
const TIER_STATE_MAX = 1000;

/**
 * Largest cursor request body lazy will BUFFER in order to substitute a
 * placeholder that appears in it.
 *
 * cursor-agent sends its API key in the body of at least one call
 * (`/auth/exchange_user_api_key`), so a header-only swap would forward the
 * placeholder verbatim and the call would fail. Those calls are small unary
 * JSON. The agent stream, by contrast, is a long connect-rpc bidi stream that
 * must never be buffered — buffering it deadlocks the call.
 *
 * The two are told apart by `content-length`: a streamed body has none. So a
 * request is buffered only when it declares a length AND that length is under
 * this cap; anything else is streamed through untouched. A cursor auth call
 * that somehow exceeded the cap would fail upstream with an auth error rather
 * than hang — the safe direction to be wrong in.
 */
const CURSOR_BODY_SUBSTITUTION_LIMIT = 64 * 1024;

/**
 * Encoder for the credential substitution. Placeholders and API keys are ASCII
 * by construction (see the mint prefixes in src/proxy/credential-broker.ts), so
 * encoding them is lossless and the byte search above is exact.
 */
const ASCII = new TextEncoder();

/**
 * Overrides for a `missing` outcome that is only TRANSIENT (a token refresh that
 * timed out, a 5xx from the token endpoint): a retryable 503 instead of a 401,
 * and no `credential`, so the request is not evidence the credential is broken
 * (src/proxy/credential-health.ts) and the turn is not parked as an auth failure.
 */
function transientRefusal(outcome: { reason: string; transient?: true }) {
  if (!outcome.transient) return {};
  return {
    status: 503,
    errorPrefix: CREDENTIAL_UNAVAILABLE_PREFIX,
    body: credentialUnavailableBody,
    message: `lazy could not resolve the credential for this request right now; retry it. ${outcome.reason}`,
    credential: undefined,
  };
}

/**
 * Enqueue an audit record for a request the proxy REFUSED, and return the
 * refusal response. Credential refusals (401) are the default shape; a path
 * refusal (403) passes `status`, `errorPrefix` and its own body.
 *
 * A refusal is the single most security-interesting thing this proxy does — a
 * revoked task hammering the proxy, or a container presenting a placeholder it
 * was never given, is exactly the evidence an audit trail exists to preserve.
 * Leaving those as warn-only lines put them in a rotating process log while
 * every SUCCESSFUL request was durably recorded, which is precisely backwards.
 *
 * The presented credential is never part of the record: 'reason' describes the
 * refusal, and the token itself stays out of the audit log the same way it
 * stays out of the warn lines.
 */
function refuse(
  ctx: { id: string; seq: number; startMs: number; auditQueue: AuditQueue },
  req: Request,
  opts: {
    path: string;
    upstream: string;
    backend: string;
    role: string | null;
    taskId: string | null;
    reason: string;
    message: string;
    /** Refusal status. Defaults to 401 (credential grounds). */
    status?: number;
    /** Audit-error prefix. Defaults to the credential one. */
    errorPrefix?: string;
    /** Response body builder. Defaults to the authentication-error shape. */
    body?: (message: string) => string;
    /** Extra response headers (e.g. `retry-after`). */
    headers?: Record<string, string>;
    /**
     * Which credential was refused, when lazy knows: lets the refusal count as
     * evidence about THAT credential's health (src/proxy/credential-health.ts).
     */
    credential?: { key: string; userId: string | null; profile: string | null };
  },
): Response {
  const status = opts.status ?? 401;
  const errorPrefix = opts.errorPrefix ?? CREDENTIAL_REFUSED_PREFIX;
  const body = opts.body ?? credentialErrorBody;
  ctx.auditQueue.enqueue({
    id: ctx.id,
    seq: ctx.seq,
    ts: ctx.startMs,
    role: opts.role,
    taskId: opts.taskId,
    // Its OWN field, never `credential`/`userId`: those are read as "this
    // member's Claude token was rejected" (auth-verdict.ts) and as spend
    // (usage-limits.ts), and a refusal is neither. Only credential-health reads it.
    ...(opts.credential ? { refusedCredential: opts.credential } : {}),
    backend: opts.backend,
    upstream: opts.upstream,
    method: req.method,
    path: opts.path,
    endpoint: opts.backend === 'cursor' ? 'cursor' : 'other',
    model: null,
    tier: null,
    stream: null,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status,
    usage: null,
    stopReason: null,
    // The prefix is shared rather than spelled here: `lazy watch`'s remedy line
    // keys off it (see CREDENTIAL_REFUSED_PREFIX in ./activity).
    error: `${errorPrefix}: ${opts.reason}`,
    durationMs: Date.now() - ctx.startMs,
    reroute: null,
    enforcement: null,
  });
  return new Response(body(opts.message), {
    status,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
}

/** Index of `needle` in `hay` at or after `from`, or -1. Byte-level. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return -1;
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Body for a cursor request, with the placeholder swapped for the real key when
 * the body is small and declared. Returns null to mean "stream it, unchanged"
 * \u2014 null is only ever returned BEFORE the stream is consumed, because consuming
 * it makes streaming impossible afterwards.
 *
 * WHY BYTES, NOT TEXT: this buffers every declared body under the cap, not just
 * the ones carrying a placeholder, and cursor speaks connect-rpc \u2014 a unary call
 * under 64 KiB can be binary protobuf. Decoding that to a JS string turns every
 * non-UTF-8 byte into U+FFFD and re-encodes it as three different bytes, which
 * is silent corruption of a request lazy is only supposed to be observing. The
 * token and the credential are both ASCII, so the substitution is exact at the
 * byte level and every other byte is passed through untouched.
 */
async function cursorBodyWithCredential(
  req: Request,
  substitutions: ReadonlyArray<readonly [placeholder: string, real: string]>,
): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (!Number.isFinite(declared) || declared <= 0) return null;
  if (declared > CURSOR_BODY_SUBSTITUTION_LIMIT) return null;

  let bytes: Uint8Array = new Uint8Array(await req.arrayBuffer());
  // No placeholder in the body: the ORIGINAL bytes come back. The stream is
  // already consumed, so "unchanged" has to mean these exact bytes, not a
  // re-encoding of them.
  for (const [token, real] of substitutions) bytes = substituteBytes(bytes, token, real);
  return bytes;
}

/** `bytes` with every occurrence of `token` replaced by `real`; the same array when there is none. */
function substituteBytes(bytes: Uint8Array, token: string, real: string): Uint8Array {
  const needle = ASCII.encode(token);
  let at = indexOfBytes(bytes, needle, 0);
  if (at === -1) return bytes;

  const replacement = ASCII.encode(real);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  while (at !== -1) {
    parts.push(bytes.subarray(cursor, at), replacement);
    cursor = at + needle.length;
    at = indexOfBytes(bytes, needle, cursor);
  }
  parts.push(bytes.subarray(cursor));

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const CURSOR_ERROR_CAPTURE_LIMIT = 16 * 1024;

async function cursorErrorExcerpt(response: Response, secrets: string[]): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > CURSOR_ERROR_CAPTURE_LIMIT) {
        void reader.cancel().catch(() => {});
        return 'upstream: error body exceeds diagnostic limit';
      }
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return upstreamErrorExcerpt(new TextDecoder().decode(bytes), secrets);
  } finally {
    reader.releaseLock();
  }
}

/** The request's source address, as the listening server saw it. */
function peerAddressOf(
  req: Request,
  srv?: { requestIP(req: Request): { address: string } | null },
): string | null {
  return normalizePeerAddress(srv?.requestIP(req)?.address);
}

/**
 * Refuse a verified placeholder presented from an address its grant is not
 * pinned to (src/proxy/credential-broker.ts, grantAcceptsPeer). Loud and
 * audited: it means the value left the container it was minted for.
 */
function refuseWrongPeer(
  ctx: { id: string; seq: number; startMs: number; auditQueue: AuditQueue },
  req: Request,
  grant: CredentialGrant,
  peer: string | null,
  where: { path: string; upstream: string; backend: string },
): Response {
  const detail = `it is pinned to ${grant.boundAddresses?.join(', ')}, the request came from ${peer ?? 'an unknown address'}`;
  logger.error(
    `[proxy] seq=${ctx.seq} refused task ${grant.taskId ?? '-'}'s placeholder: ${detail}. ` +
    `It may have leaked out of its container.`,
  );
  return refuse(ctx, req, {
    ...where,
    role: grant.role,
    taskId: grant.taskId,
    reason: `placeholder presented from another address (${detail})`,
    message:
      'Unauthorized: this placeholder belongs to another container and is refused from here. ' +
      'Each task container may spend only the credential placeholder it was launched with.',
  });
}

/**
 * Forward one cursor-bound request and enqueue a coarse audit record.
 *
 * Deliberately minimal compared with the Anthropic path:
 *  - the request body is STREAMED, never buffered — cursor's agent stream is a
 *    connect-rpc stream, and buffering it would deadlock a bidi call. The one
 *    exception is a small declared-length body carrying the placeholder (see
 *    CURSOR_BODY_SUBSTITUTION_LIMIT);
 *  - no extractor, no policy enforcement, no usage capture, no failover chain.
 *    Cursor's wire format is not Anthropic's, and guessing at it would produce
 *    audit records that are confidently wrong. Coarse attribution (role, task,
 *    method, path, status, duration) is what this route promises today.
 *
 * The route's token segment has already been resolved by the caller: `caller`
 * is the grant it proved, or null for a launch with no placeholder at all (a
 * host `cursor-agent login` session — its own credential is forwarded
 * untouched and the record is unattributed).
 */
async function forwardCursor(
  req: Request,
  route: CursorProxyRoute,
  cursorUpstream: string,
  caller: { grant: CredentialGrant; token: string } | null,
  credentials: ProxyCredentialDeps | null,
  ctx: {
    id: string; seq: number; startMs: number;
    auditQueue: AuditQueue;
    activity: ProxyActivityBus;
    upstreamTimeoutSeconds: number;
    config?: ResolvedConfig;
  },
): Promise<Response> {
  const fwdHeaders = new Headers(req.headers);
  fwdHeaders.delete('host');
  fwdHeaders.delete('content-length');
  for (const h of LAZY_HEADERS) fwdHeaders.delete(h);

  const target = cursorUpstream + route.upstreamPath;
  let hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body != null;
  let bodyOverride: Uint8Array | null = null;
  let cursorCredentialLabel: string | null = null;
  let cursorCredentialValue: string | null = null;
  let cursorUserId: string | null = null;
  let cursorEndpoint: string | null = null;
  const substitutions: Array<readonly [string, string]> = [];

  // --- JIT credential exchange ---
  if (caller && credentials) {
    // Team mode: the turn principal's own Cursor credential for the profile —
    // see ProxyCredentialDeps.member.
    const member = credentials.member ? await credentials.member(caller.grant, undefined, {
      upstream: cursorUpstream, config: ctx.config,
    }) : null;
    if (member?.userId) cursorUserId = member.userId;
    cursorEndpoint = member?.endpoint ?? null;
    const outcome = member ? member.outcome : await credentials.targets.forTarget(cursorUpstream);
    const presented = collectPresentedCredentials(req.headers);
    if (outcome.kind === 'missing') {
      return refuse(ctx, req, {
        path: route.upstreamPath,
        upstream: cursorUpstream,
        backend: 'cursor',
        role: caller.grant.role,
        taskId: caller.grant.taskId,
        reason: outcome.reason,
        message: missingCredentialMessage(cursorUpstream, outcome.reason),
        credential: {
          key: usageLimitCredentialKey({ userId: cursorUserId, endpoint: cursorEndpoint, upstream: cursorUpstream }),
          userId: cursorUserId,
          profile: member?.profile ?? null,
        },
        ...transientRefusal(outcome),
      });
    }
    if (outcome.kind === 'none') {
      // Nothing to inject — but the placeholder must still not go upstream.
      stripAuthHeaders(fwdHeaders);
    } else {
      applyCredential(fwdHeaders, presented, caller.token, outcome.placement);
      cursorCredentialLabel = outcome.label;
      cursorCredentialValue = outcome.placement.value;
      // Body substitution only for an in-place placement: that value is the
      // bare credential. A header placement's value may carry wire framing
      // ("Bearer x"), which belongs in a header and nowhere else.
      if (outcome.placement.kind === 'in-place') substitutions.push([caller.token, outcome.placement.value]);
    }

    // --- Upstream-minted credentials (Cursor's key exchange) ---
    // The container holds placeholders for the access/refresh tokens the
    // exchange returned (see cursorTokenResponse below); swap this grant's
    // back in. A derived placeholder this grant does not own is refused, not
    // forwarded: it is another task's, or revoked.
    const derived = caller.grant.derived ?? [];
    for (const d of derived) substitutions.push([d.placeholder, d.real]);
    // Collected first: Headers must not be mutated while being iterated.
    for (const [name, value] of [...fwdHeaders]) {
      let next = value;
      for (const d of derived) if (next.includes(d.placeholder)) next = next.split(d.placeholder).join(d.real);
      if (next !== value) fwdHeaders.set(name, next);
      DERIVED_PLACEHOLDER_PATTERN.lastIndex = 0;
      if (DERIVED_PLACEHOLDER_PATTERN.test(next)) {
        DERIVED_PLACEHOLDER_PATTERN.lastIndex = 0;
        return refuse(ctx, req, {
          path: route.upstreamPath, upstream: cursorUpstream, backend: 'cursor',
          role: caller.grant.role, taskId: caller.grant.taskId,
          reason: 'a Cursor session placeholder this launch does not own (revoked, or another task\'s)',
          message: unknownPlaceholderMessage(),
        });
      }
    }
    if (hasBody && substitutions.length > 0) {
      bodyOverride = await cursorBodyWithCredential(req, substitutions);
    }
  }

  const base: Omit<ProxyAuditRecord, 'status' | 'error' | 'durationMs'> = {
    id: ctx.id,
    seq: ctx.seq,
    ts: ctx.startMs,
    // Attribution from the GRANT, never from a client-supplied header: this
    // route's only identity claim is the token it presented, and the token was
    // minted by lazy for exactly one launch.
    role: caller?.grant.role ?? null,
    taskId: caller?.grant.taskId ?? null,
    // Team mode: whose own Cursor credential paid for this request.
    ...(cursorUserId ? { userId: cursorUserId } : {}),
    backend: 'cursor',
    upstream: cursorUpstream,
    method: req.method,
    // The lazy prefix is stripped: the record shows the path cursor actually saw.
    path: route.upstreamPath,
    endpoint: 'cursor',
    model: null,
    tier: null,
    stream: null,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    usage: null,
    stopReason: null,
    reroute: null,
    enforcement: null,
  };

  // LIVE: same announce as the Anthropic path. This is the ONLY activity a
  // Cursor task ever produces — cursor's own stream is opaque connect-rpc
  // protobuf that lazy deliberately does not parse — so a coarse
  // request-passed-through line is the whole signal, and it must not wait for
  // the response.
  ctx.activity.publish({
    kind: 'open',
    id: ctx.id, seq: ctx.seq, ts: ctx.startMs,
    role: base.role, taskId: base.taskId,
    backend: 'cursor', method: req.method, path: activityPath(base.path), model: null,
  });

  if (bodyOverride !== null) {
    hasBody = true;
    // The substituted body is a different length from the client's. Drop any
    // declared length rather than trusting fetch to notice \u2014 a stale
    // content-length either truncates the body upstream or hangs the call.
    // (Also deleted unconditionally above; this is the invariant that matters,
    // stated where the body actually changes.)
    fwdHeaders.delete('content-length');
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body: bodyOverride !== null ? bodyOverride : hasBody ? forwardableBody(req.body) : undefined,
      // Required whenever the body is a stream: the request body is still being
      // sent while the response is read. A substituted body is a plain string
      // and must NOT declare half-duplex.
      ...(bodyOverride === null && hasBody ? { duplex: 'half' } : {}),
      // lazy's own ceiling instead of Bun's hidden one — same rule on every
      // route, so no upstream can be reaped at a number nobody chose.
      ...upstreamFetchOptions(ctx.upstreamTimeoutSeconds),
    } as RequestInit);
  } catch (err) {
    const message = describeUpstreamFailure(err, cursorUpstream, ctx.upstreamTimeoutSeconds);
    ctx.auditQueue.enqueue({ ...base, status: null, error: message, durationMs: Date.now() - ctx.startMs });
    logger.warn(`[proxy] seq=${ctx.seq} cursor upstream ${cursorUpstream} unreachable: ${message}`);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  const cursorRecord: ProxyAuditRecord = {
    ...base,
    status: upstreamResp.status,
    usageLimitHeaders: captureUsageLimitHeaders(upstreamResp.headers),
    credential: usageLimitCredentialKey({
      userId: cursorUserId,
      endpoint: cursorEndpoint,
      credentialLabel: cursorCredentialLabel,
      upstream: cursorUpstream,
    }),
    error: null,
    durationMs: Date.now() - ctx.startMs,
  };

  // Same stale-encoding strip as the Anthropic path: Bun's fetch already
  // decoded the body, so forwarding the compressed length would break clients.
  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');

  if (upstreamResp.status >= 400 && upstreamResp.body != null &&
      !(upstreamResp.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const secrets = [
      ...credentialValuesIn(fwdHeaders),
      ...(caller ? [caller.token] : []),
      ...(cursorCredentialValue ? [cursorCredentialValue] : []),
      ...substitutions.flatMap(([placeholder, real]) => [placeholder, real]),
    ];
    void cursorErrorExcerpt(upstreamResp.clone(), secrets)
      .then((error) => ctx.auditQueue.enqueue({ ...cursorRecord, error }))
      .catch(() => ctx.auditQueue.enqueue(cursorRecord));
  } else {
    ctx.auditQueue.enqueue(cursorRecord);
  }

  // A launch's container must never hold a credential Cursor minted for it:
  // the key exchange's access/refresh tokens are swapped for grant-bound
  // placeholders before the body leaves the proxy.
  if (caller && upstreamResp.ok && upstreamResp.body != null && !isStreamingContentType(upstreamResp.headers.get('content-type'))) {
    return cursorTokenResponse(upstreamResp, respHeaders, caller, credentials, ctx);
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
}

/**
 * A streamed response (connect/gRPC streams, SSE) that must never be buffered.
 * Everything else is inspected for upstream-minted tokens WHATEVER its declared
 * type: cursor-agent parses the exchange answer as JSON regardless of the
 * header, so trusting `application/json` would forward a mislabelled session raw.
 */
function isStreamingContentType(value: string | null): boolean {
  return /^(application\/(connect\+|grpc)|text\/event-stream)/i.test((value ?? '').trim());
}

/** Fields of a token response that carry an upstream-minted credential. */
const CURSOR_TOKEN_FIELDS = ['accessToken', 'refreshToken'] as const;

/**
 * Forward a JSON response from the cursor route with every upstream-minted
 * token replaced by a placeholder bound to the caller's grant.
 *
 * WHY: cursor-agent (verified against the 2026.10.01 bundle) trades its API
 * key for a session at `POST /auth/exchange_user_api_key` — key in
 * `Authorization: Bearer`, body `{}` — and the answer is
 * `{ accessToken, refreshToken, ... }`, the access token a JWT it sends as a
 * bearer on every later call. Forwarded verbatim, a container that holds only a
 * placeholder KEY still walked away with a real, spendable Cursor session.
 * Applied to any unary JSON object carrying those fields, not to that one path,
 * so a renamed endpoint cannot reopen it; the body is otherwise byte-for-byte
 * what Cursor sent.
 *
 * Fails CLOSED: a body that names a token but cannot be bound (no binder, the
 * grant revoked mid-request) is withheld with a 502, never forwarded.
 */
async function cursorTokenResponse(
  upstreamResp: Response,
  respHeaders: Headers,
  caller: { grant: CredentialGrant; token: string },
  credentials: ProxyCredentialDeps | null,
  ctx: { seq: number },
): Promise<Response> {
  // Buffered as BYTES: unary Connect replies (`application/proto`) are binary,
  // and decoding them as text replaced invalid UTF-8 with U+FFFD — a corrupted
  // reply that broke Cursor launches. Only a valid-UTF-8 JSON object carrying
  // a token field is ever rebuilt; everything else goes out byte-for-byte.
  const bytes = new Uint8Array(await upstreamResp.arrayBuffer());
  const passThrough = () => new Response(bytes, {
    status: upstreamResp.status, statusText: upstreamResp.statusText, headers: respHeaders,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // Not UTF-8 JSON: it cannot carry a token FIELD, so there is nothing to
    // swap. Forwarded as received.
    return passThrough();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return passThrough();
  const body = parsed as Record<string, unknown>;
  const pairs: Array<{ placeholder: string; real: string }> = [];
  for (const field of CURSOR_TOKEN_FIELDS) {
    const real = body[field];
    if (typeof real !== 'string' || real === '') continue;
    const placeholder = derivedPlaceholderFor(real);
    pairs.push({ placeholder, real });
    body[field] = placeholder;
  }
  if (pairs.length === 0) return passThrough();

  const bound = credentials?.bindDerived ? await credentials.bindDerived(caller.token, pairs) : false;
  if (!bound) {
    logger.warn(`[proxy] seq=${ctx.seq} withheld a Cursor session token: its launch's grant could not hold it`);
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message: 'lazy withheld the Cursor session this request created: the launch it belongs to has ended. Resume the task to start a new turn.',
        },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify(body), {
    status: upstreamResp.status, statusText: upstreamResp.statusText, headers: respHeaders,
  });
}

export function createProxyServer(
  config: ProxyServerConfig,
  // The audit sink is the project-local bounded log (src/proxy/audit-log.ts) —
  // NOT the Storage layer. Audit records are disposable telemetry, so they must
  // never take a storage round-trip on the proxy hot path.
  auditSink: AuditSink,
  // Required, but nullable: see ProxyCredentialDeps. null = no placeholder
  // exchange at all (every request forwarded with whatever credential it came
  // with), which is what a unit test of the routing/audit paths wants.
  credentials: ProxyCredentialDeps | null,
  // Live-activity sink for `lazy watch`. Defaults to the daemon-wide singleton;
  // injectable so a unit test can observe one proxy's traffic in isolation.
  //
  // `toolStats` is the DURABLE per-task tool-stats recorder (src/proxy/tool-
  // stats.ts) — the one thing here that does reach Storage, because a per-tool
  // summary must outlive the bounded audit log. Optional: a unit test of the
  // routing paths wants no storage at all, and omitting it changes nothing
  // about how requests are forwarded.
  options?: {
    activity?: ProxyActivityBus;
    toolStats?: ProxyToolStatsRecorder;
    // Durable per-turn latency rollups (src/proxy/turn-latency-recorder.ts);
    // `observe` is an in-memory fold, flushed to Storage behind the request.
    turnLatency?: ProxyTurnLatencyRecorder;
    // Latest usage-limit reading per credential. Defaults to the daemon-wide
    // tracker the `usageLimits` RPC reads; injectable for tests.
    usageLimits?: UsageLimitTracker;
    // Called once per tier SWITCH of a tiered profile (src/proxy/tier-select.ts),
    // never per request; the daemon records it durably on the task.
    onTierSwitch?: (event: TierSwitchEvent) => void;
    // Called for EVERY request a tier serves (past every refusal), naming the
    // tier — the daemon dedupes it into the running turn's tiers_served.
    onTierServed?: (event: { taskId: string; tier: TierServed }) => void;
    // Has this task's tiered session already been served by more than one
    // provider (durably, across daemon restarts)? See src/proxy/tier-history.ts.
    historyCrossed?: (taskId: string) => Promise<boolean>;
    // Refresh saved readings before tier choice; existing tracker readings
    // remain usable if a refresh fails.
    prepareTierChoice?: () => Promise<void>;
    // Every tier's latest capacity refusal. Defaults to the daemon-wide record
    // the usage pause reads; injectable for tests.
    tierRefusals?: TierRefusals;
  },
): ProxyServer {
  const upstream = config.upstream.replace(/\/$/, '');
  const fallbacks: ProxyFallbackTarget[] = (config.fallbacks ?? []).map((f) => ({
    upstream: f.upstream.replace(/\/$/, ''),
    model: f.model,
  }));
  const cursorUpstream = (config.cursorUpstream ?? DEFAULT_CURSOR_UPSTREAM).replace(/\/$/, '');
  const agentUpstreams: Record<string, AgentUpstreamRoute> = {};
  for (const [profile, route] of Object.entries(config.agentUpstreams ?? {})) {
    if (route?.upstream) {
      agentUpstreams[profile] = {
        upstream: route.upstream.replace(/\/$/, ''),
        wire: route.wire,
        ...(route.tiers ? { tiers: route.tiers } : {}),
      };
    }
  }
  const retryAfterThreshold = config.retryAfterThreshold ?? DEFAULT_RETRY_AFTER_THRESHOLD;
  const tierRetryIntervalSeconds = config.tierRetryIntervalSeconds ?? DEFAULT_TIER_RETRY_INTERVAL_SECONDS;
  const tierRefusals = options?.tierRefusals ?? daemonTierRefusals;
  const upstreamTimeoutSeconds =
    config.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS;
  const policy = config.policy ?? defaultPolicyConfig();
  // Empty unless the project ships plugins in .lazy/plugins. An empty chain is
  // short-circuited per request, so the default path is unchanged.
  const requestPlugins = config.plugins ?? [];
  // The live tap: every audited record becomes a `close` event for any
  // `lazy watch` subscriber. Wired at the queue so no record site can miss it.
  const activity = options?.activity ?? proxyActivity;
  const toolStats = options?.toolStats ?? null;
  const turnLatency = options?.turnLatency ?? null;
  const usageLimits = options?.usageLimits ?? daemonUsageLimits;
  const auditQueue = new AuditQueue(auditSink, (record) => {
    activity.publish(closeEventFromRecord(record));
    // Pure in-memory map write; cannot fail on I/O.
    usageLimits.observe(record);
    // Folded at the queue for the same reason the activity tap is: every
    // record that reaches the trail reaches the durable tool stats too, by
    // construction, so a future audit site cannot forget it. `observe` returns
    // immediately — the read-modify-write runs behind the request.
    if (toolStats) {
      try {
        toolStats.observe(record);
      } catch (err) {
        // A statistics failure must never break the request being observed,
        // nor stop the DURABLE audit append below from happening.
        logger.warn(
          `[proxy] tool-stats fold failed for seq=${record.seq}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (turnLatency) {
      try {
        turnLatency.observe(record);
      } catch (err) {
        logger.warn(
          `[proxy] turn-latency fold failed for seq=${record.seq}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });
  let seq = 0;
  // Per task+profile: the tier the last request used, and which upstream
  // origins have served its session (two or more = its history crossed
  // providers; see src/proxy/tier-history.ts). In memory: a daemon restart
  // forgets it, which is a documented limit of the thinking-block handling.
  // `full`: the last request found every tier full and was answered 429.
  const tierState = new Map<string, { last: number | null; upstreams: Set<string>; full: boolean }>();

  // Load the BPE table the tool_result sizer needs, off the request path.
  // Fire-and-forget on purpose: results audited before it resolves record a
  // null token count (honest "not measured"), and nothing waits to serve.
  void warmToolResultTokenizer().catch((err) => {
    logger.warn(
      `[proxy] tool-result token sizing unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
        `Tool calls will still be audited; their result sizes will read as not measured.`,
    );
  });

  const fallbackNote = fallbacks.length
    ? `, failover chain: [${fallbacks.map((f) => f.upstream).join(', ')}]`
    : '';
  const agentEntries = Object.entries(agentUpstreams);
  const agentNote = agentEntries.length
    ? `, initial agent profiles: [${agentEntries.map(([p, u]) => `${p} → ${u.upstream} (${u.wire} wire)`).join(', ')}]`
    : '';

  // `tierAttempt`: how many tiers already refused THIS request (see the
  // capacity-refusal retry below); bounds the re-dispatch.
  const handleRequest = async (
    req: Request,
    srv?: { requestIP(req: Request): { address: string } | null },
    tierAttempt = 0,
  ): Promise<Response> => {
      const url = new URL(req.url);
      // Liveness self-check (see PROXY_HEALTH_PATH). FIRST, ahead of the
      // sequence counter and every audit site: it is not traffic.
      if (url.pathname === PROXY_HEALTH_PATH && req.method === 'GET') {
        return Response.json({ ok: true, service: 'lazy-proxy' });
      }
      const startMs = Date.now();
      const path = url.pathname + url.search;
      const id = randomUUID();
      const currentSeq = ++seq;
      let requestRoutes = agentUpstreams;
      let requestTargets = credentials?.targets;
      let requestProfiles: ReadonlySet<string> | undefined;
      let requestConfig: ResolvedConfig | undefined;
      if (config.liveAgentRouting) {
        try {
          const routing = await config.liveAgentRouting();
          requestRoutes = routing.routes;
          requestTargets = routing.targets;
          requestProfiles = routing.profiles;
          requestConfig = routing.config;
        } catch (err) {
          logger.error(`[proxy] cannot load agent routing: ${err instanceof Error ? err.message : String(err)}`);
          return Response.json({ error: 'Proxy agent routing is unavailable; check lazy.toml and run lazy doctor.' }, { status: 503 });
        }
      }

      // --- Cursor passthrough route ---
      // Opaque by design: forwarded verbatim, never parsed by the
      // Anthropic-shaped extractor, never enforced against, no usage capture —
      // and deliberately NOT subject to the path allowlist below. See the
      // "NOT COVERED" note in src/proxy/path-allowlist.ts for why.
      if (isCursorProxyPath(url.pathname)) {
        const route = parseCursorProxyPath(path);
        if (!route) {
          // A malformed prefix means the launch wiring is wrong. Say so loudly
          // rather than forwarding an unattributable request that would look
          // fine in the audit log. The path itself is NOT logged or echoed: its
          // first segment is a live credential.
          logger.warn(
            `[proxy] seq=${currentSeq} malformed cursor route path ` +
              `(${url.pathname.split('/').length} segments) — value withheld, it carries a credential`,
          );
          return new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'proxy_error',
                message:
                  `Malformed cursor proxy path. Expected ` +
                  `${CURSOR_PROXY_PREFIX}/<token>/<upstream path>.`,
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        // Resolve the route's token to its grant. An unresolvable one is a hard
        // 401: unlike the Anthropic path there is no "maybe it is a real
        // credential" case here — lazy put that segment in the URL itself.
        let cursorCaller: { grant: CredentialGrant; token: string } | null = null;
        if (route.token && credentials) {
          const grant = await credentials.lookup(route.token);
          if (!grant) {
            logger.warn(`[proxy] seq=${currentSeq} cursor route token did not verify`);
            return new Response(credentialErrorBody(unknownPlaceholderMessage()), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (!grantAcceptsPeer(grant, peerAddressOf(req, srv))) {
            return refuseWrongPeer({ id, seq: currentSeq, startMs, auditQueue }, req, grant, peerAddressOf(req, srv), {
              path: `${CURSOR_PROXY_PREFIX}/<redacted>`, upstream: cursorUpstream, backend: 'cursor',
            });
          }
          if (grant.profile && requestProfiles && !requestProfiles.has(grant.profile)) {
            return refuse(
              { id, seq: currentSeq, startMs, auditQueue }, req,
              {
                path: `${CURSOR_PROXY_PREFIX}/<redacted>`, upstream: cursorUpstream, backend: 'cursor', role: grant.role,
                taskId: grant.taskId,
                reason: `agent profile "${grant.profile}" no longer exists`,
                status: 410,
                message: `Agent profile "${grant.profile}" no longer exists; start a new turn with a configured profile.`,
              },
            );
          }
          cursorCaller = { grant, token: route.token };
        }
        return forwardCursor(req, route, cursorUpstream, cursorCaller, credentials, {
          id,
          seq: currentSeq,
          startMs,
          auditQueue,
          activity,
          upstreamTimeoutSeconds,
          config: requestConfig,
        });
      }

      // --- Caller verification ---
      // Every credential-shaped value on the request is offered to the broker.
      // Nothing is decided by shape: a value is a placeholder because a grant
      // exists for it, full stop (see src/proxy/inject.ts).
      const presented = credentials ? collectPresentedCredentials(req.headers) : [];
      let caller: VerifiedCaller | null = null;
      if (credentials) {
        for (const candidate of presented) {
          const grant = await credentials.lookup(candidate.value);
          if (grant) {
            if (!grantAcceptsPeer(grant, peerAddressOf(req, srv))) {
              return refuseWrongPeer({ id, seq: currentSeq, startMs, auditQueue }, req, grant, peerAddressOf(req, srv), {
                path, upstream, backend: 'proxy',
              });
            }
            caller = { grant, token: candidate.value, presented };
            break;
          }
        }
        // Presented something lazy-shaped that no grant backs: the launch that
        // owns it is gone (task accepted/rejected/closed) or the value is
        // forged. Refuse with the remedy rather than forwarding a placeholder
        // upstream, which would surface as a confusing Anthropic auth error.
        if (!caller && presented.some((c) => looksLikeLazyPlaceholder(c.value))) {
          logger.warn(`[proxy] seq=${currentSeq} presented placeholder did not verify`);
          // Attribution is null on purpose: the whole point is that the token
          // proved nothing, so there is no verified identity to record. The
          // self-reported headers are NOT substituted in here — an unverified
          // caller's claim about itself is not evidence.
          return refuse(
            { id, seq: currentSeq, startMs, auditQueue },
            req,
            {
              path,
              upstream,
              backend: 'proxy',
              role: null,
              taskId: null,
              reason: 'unknown or revoked placeholder',
              message: unknownPlaceholderMessage(),
            },
          );
        }
      }

      // Attribution: the grant when there is one (evidence), the lazy-injected
      // hint headers otherwise (a claim — kept for unproxied/login-session
      // traffic so those records are not simply blank). Both headers are
      // stripped before forwarding either way.
      // NOTE the ternary rather than `??`: a verified caller's grant is the
      // ONLY source, including when the grant's field is null. A builder grant
      // legitimately has taskId null, and `??` would have fallen through that
      // null to the client's own x-lazy-task-id header \u2014 letting a verified
      // caller forge the very attribution this token was introduced to prove.
      const role = caller ? caller.grant.role : req.headers.get('x-lazy-role');
      const taskId = caller ? caller.grant.taskId : req.headers.get('x-lazy-task-id');

      // Which upstream this request is bound for. Resolved HERE rather than at
      // the forwarding site because the allowlist tier depends on it: a routed
      // upstream is a non-Anthropic backend and gets the tighter list.
      //
      // The caller's PROFILE decides where this goes. It is read off the
      // broker-minted grant, so it is evidence rather than a client claim — an
      // agent cannot route itself somewhere else by setting a header. A caller
      // with no profile route (an unattributed request — a host `claude` login
      // session sharing the proxy — or a profile with no endpoint of its own)
      // has nothing to route by and uses the primary upstream, as before.
      if (caller?.grant.profile && requestProfiles && !requestProfiles.has(caller.grant.profile)) {
        return refuse(
          { id, seq: currentSeq, startMs, auditQueue }, req,
          {
            path, upstream, backend: 'proxy', role, taskId,
            reason: `agent profile "${caller.grant.profile}" no longer exists`,
            status: 410,
            message: `Agent profile "${caller.grant.profile}" no longer exists; start a new turn with a configured profile.`,
          },
        );
      }
      let callerRoute = caller ? routeForProfile(requestRoutes, caller.grant) : undefined;
      // --- Tiered profile: pick this request's tier (src/proxy/tier-select.ts) ---
      // The grant names the TIERED profile; which endpoint and model serve this
      // request is decided here, per request, from the live usage readings. The
      // chosen tier's upstream then flows through the ordinary per-target
      // credential lookup below, exactly like a plain profile's — so a tier's
      // request carries that tier's endpoint credential and nothing else.
      let tierChoice: TierChoice | null = null;
      let tierStrip = false;
      // The switch is RECORDED only once the request is past every refusal
      // below (path allowlist, team mode): a refused request switched nothing.
      let commitTierSwitch: (() => void) | null = null;
      let tierThinkingOff = false;
      // Set when every tier is full: answers the request with a 429 once it is
      // past every other refusal, so a forbidden path is still audited as one.
      let answerAllTiersFull: (() => Response) | null = null;
      // The refusal key of each tier this request looked at (`keyFor`).
      const tierKeys = new Map<number, string | null>();
      let tierCount = 0;
      if (caller && callerRoute?.tiers?.length) {
        if (callerRoute.tiers.some((t) => t.usage !== null) && options?.prepareTierChoice) {
          // Readings saved before a daemon restart, so a running turn's first
          // request after it is judged on them rather than on an empty tracker.
          try {
            await options.prepareTierChoice();
          } catch (err) {
            logger.warn(`[proxy] cannot refresh saved tier usage; using known readings: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const targetsNow = requestTargets;
        const tiers = callerRoute.tiers;
        tierCount = tiers.length;
        tierChoice = await chooseTier(tiers, {
          keyFor: async (t) => {
            const member = credentials?.memberUsage ? await credentials.memberUsage(caller!.grant, t.endpoint) : null;
            if (member) {
              tierKeys.set(t.index, member.key);
              return member.key;
            }
            const outcome = targetsNow ? await targetsNow.forTarget(t.upstream) : null;
            const key = usageLimitCredentialKey({
              credentialLabel: outcome?.kind === 'credential' ? outcome.label : null,
              upstream: t.upstream,
            });
            tierKeys.set(t.index, key);
            return key;
          },
          readingFor: (key) => usageLimits.reading(key),
          refusalFor: tierRefusals.lookupFor(caller.grant.profile ?? ''),
        });
        const choice = tierChoice;
        const chosen = choice.tier;
        const grant = caller.grant;
        const stateKey = `${grant.taskId ?? grant.label}|${grant.profile ?? ''}`;
        let state = tierState.get(stateKey);
        if (!state) {
          state = { last: null, upstreams: new Set<string>(), full: false };
          // Durable half of "this session's history crossed providers": the
          // in-memory set is lost on a daemon restart, and a session back on
          // tier 0 would then send another provider's thinking blocks on every
          // request (src/proxy/tier-history.ts).
          if (grant.taskId && options?.historyCrossed) {
            try {
              if (await options.historyCrossed(grant.taskId)) state.upstreams.add('(before restart)');
            } catch (err) {
              // Unknown: assume crossed — stripping costs thinking continuity,
              // not stripping can refuse every request.
              logger.warn(`[proxy] cannot read tier history for task ${grant.taskId}: ${err instanceof Error ? err.message : String(err)}`);
              state.upstreams.add('(unknown)');
            }
          }
        }
        const sessionState = state;
        const rememberState = () => {
          // Bounded: one entry per task on a tiered profile, oldest dropped.
          tierState.delete(stateKey);
          tierState.set(stateKey, sessionState);
          while (tierState.size > TIER_STATE_MAX) {
            const oldest = tierState.keys().next().value;
            if (oldest === undefined) break;
            tierState.delete(oldest);
          }
        };
        if (choice.allFull) {
          // Every tier is full: NO tier serves. The proxy answers 429 itself,
          // with retry-after = the earliest reset among the full windows, and
          // the request never leaves (engineer decision 2026-10-01,
          // docs/design/tiered-agent-profiles.md). Recorded once per stretch
          // of being full, like a switch, not once per refused request.
          const fullRoute = callerRoute;
          answerAllTiersFull = () => {
            const resetAt = earliestReset(choice);
            const message = allTiersFullMessage(grant.profile ?? '', choice, resetAt);
            if (!sessionState.full) {
              const from = sessionState.last === null ? null : tiers.find((t) => t.index === sessionState.last) ?? null;
              logger.warn(`[proxy] seq=${currentSeq} every tier full task=${taskId ?? '-'} profile=${grant.profile}: ${choice.reason}`);
              try {
                options?.onTierSwitch?.({
                  taskId: grant.taskId ?? null,
                  label: grant.label,
                  ...(grant.bindingKey ? { bindingKey: grant.bindingKey } : {}),
                  profile: grant.profile ?? '',
                  from: from ? { index: from.index, endpoint: from.endpoint, model: from.model } : null,
                  to: null,
                  retryAt: resetAt,
                  reason: choice.reason,
                  allFull: true,
                  crossed: sessionState.upstreams.size > 1,
                  thinkingDisabled: false,
                  ts: startMs,
                });
              } catch (err) {
                logger.warn(`[proxy] recording an every-tier-full event failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            sessionState.full = true;
            rememberState();
            return refuse(
              { id, seq: currentSeq, startMs, auditQueue }, req,
              {
                path, upstream: fullRoute.upstream, backend: 'proxy', role: grant.role,
                taskId: grant.taskId,
                reason: `every tier of agent profile "${grant.profile}" is full`,
                message,
                status: 429,
                errorPrefix: TIERS_FULL_PREFIX,
                body: allTiersFullBody(fullRoute.wire === 'openai' ? 'openai' : 'anthropic'),
                headers: { 'retry-after': String(allFullRetryAfterSeconds(resetAt)) },
              },
            );
          };
        }
        tierStrip = new Set([...sessionState.upstreams, originOf(chosen.upstream)]).size > 1;
        commitTierSwitch = () => {
          sessionState.upstreams.add(originOf(chosen.upstream));
          const crossed = sessionState.upstreams.size > 1;
          // Coming back from every-tier-full is always recorded, even onto the
          // tier that served last.
          const wasFull = sessionState.full;
          sessionState.full = false;
          if (sessionState.last !== chosen.index || wasFull) {
            const from = sessionState.last === null ? null : tiers.find((t) => t.index === sessionState.last) ?? null;
            // The first request a proxy sees for a task on tier 0 is the launch
            // state, not a switch.
            if (sessionState.last !== null || chosen.index !== 0 || wasFull) {
              logger.info(
                `[proxy] seq=${currentSeq} tier switch task=${taskId ?? '-'} profile=${grant.profile} ` +
                `${from ? `${from.endpoint}/${from.model}` : '(unknown)'} → ${chosen.endpoint}/${chosen.model}: ${choice.reason}`,
              );
              try {
                options?.onTierSwitch?.({
                  taskId: grant.taskId ?? null,
                  label: grant.label,
                  ...(grant.bindingKey ? { bindingKey: grant.bindingKey } : {}),
                  profile: grant.profile ?? '',
                  from: from ? { index: from.index, endpoint: from.endpoint, model: from.model } : null,
                  to: { index: chosen.index, endpoint: chosen.endpoint, model: chosen.model },
                  reason: choice.reason,
                  allFull: choice.allFull,
                  crossed,
                  thinkingDisabled: tierThinkingOff,
                  ts: startMs,
                });
              } catch (err) {
                logger.warn(`[proxy] recording a tier switch failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            sessionState.last = chosen.index;
          }
          rememberState();
        };
        callerRoute = { upstream: chosen.upstream, wire: callerRoute.wire };
      }
      // A tier that refuses for capacity hands THIS request to the next tier
      // (see below), so the turn continues; that needs the request as it
      // arrived, before its body is read. Bounded by the chain's length.
      const tierRetryReq = tierChoice && !answerAllTiersFull && tierAttempt < tierCount
        ? req.clone()
        : null;
      const routedUpstream = callerRoute?.upstream;
      // Which wire format this request's traffic speaks — picks the allowlist
      // tier, the request extractor, and the usage scanner. The Anthropic
      // extractor must never see OpenAI-wire traffic, and vice versa.
      const wire: UsageWire = callerRoute?.wire === 'openai' ? 'openai' : 'anthropic';

      // --- Forwarding-surface allowlist ---
      // Applied BEFORE the body is buffered, the extractor runs, or anything is
      // announced: a request lazy will not forward should not become work, and
      // the refusal record is the only thing worth keeping about it.
      //
      // Applied to ALL non-cursor traffic, verified caller or not. Restricting
      // it to granted callers would leave the surface open to exactly the class
      // of client that presents no credential, and there is no legitimate
      // non-model-API request through this proxy from any client.
      const tier = callerRoute ? (callerRoute.wire === 'openai' ? 'openai' : 'role') : 'primary';
      const pathDecision = decideProxyPath(req.method, url.pathname, tier);
      if (!pathDecision.allowed) {
        const upstreamForRecord = routedUpstream ?? upstream;
        logger.warn(
          `[proxy] seq=${currentSeq} REFUSED ${req.method} ${url.pathname} → ${upstreamForRecord} ` +
            `(${pathRefusalReasonText(pathDecision.reason)}) task=${taskId ?? '-'} role=${role ?? '-'}`,
        );
        return refuse(
          { id, seq: currentSeq, startMs, auditQueue },
          req,
          {
            path,
            upstream: upstreamForRecord,
            backend: 'proxy',
            role,
            taskId,
            reason: pathRefusalReasonText(pathDecision.reason),
            message: pathRefusalMessage(req.method, url.pathname, tier, pathDecision.reason),
            status: 403,
            errorPrefix: PATH_REFUSED_PREFIX,
            body: pathRefusalBody,
          },
        );
      }

      // Buffer the request body for audit extraction; forward verbatim (and
      // re-send on failover — the body is already in memory, so a reroute costs
      // nothing extra to buffer).
      let bodyText =
        req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();

      let parsedBody: unknown = null;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // Non-JSON body (e.g., raw binary) — leave null; extractor handles it
        }
      }

      // Tiered profile: the harness was launched on tier 0's model, so a request
      // served by another tier asks for THAT tier's model; on tier 0 the
      // harness's own choice (including its small background model) stands.
      // Rewritten before extraction so the audit names the model actually sent.
      if (tierChoice && parsedBody !== null && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
        let next = parsedBody as Record<string, unknown>;
        if (tierChoice.tier.index !== 0 && typeof next.model === 'string') {
          next = { ...next, model: tierChoice.tier.model };
        }
        if (tierStrip && wire === 'anthropic') {
          const stripped = stripThinkingHistory(next);
          if (stripped.stripped > 0) {
            logger.info(
              `[proxy] seq=${currentSeq} tiered history crossed providers: removed ${stripped.stripped} thinking ` +
              `block(s)${stripped.thinkingDisabled ? ' and turned thinking off for this request' : ''}`,
            );
          }
          tierThinkingOff = stripped.thinkingDisabled;
          next = stripped.body;
        }
        if (next !== parsedBody) {
          parsedBody = next;
          bodyText = JSON.stringify(next);
        }
      }

      // --- outbound request plugins (src/proxy/plugins) ---
      // No-op unless the project installed one: with an empty chain this
      // returns the same object identity and the original bytes are forwarded.
      // Runs BEFORE extraction so the audit trail describes what was actually
      // sent upstream, never a body the upstream never saw.
      // Plugins are Anthropic-body transforms; OpenAI-wire bodies are never
      // offered to them — a transform written against Anthropic block shapes
      // rewriting a chat-completions body would be silent corruption.
      if (requestPlugins.length > 0 && parsedBody !== null && wire === 'anthropic') {
        const originalBytes = bodyText.length;
        const transformed = applyRequestPlugins(requestPlugins, parsedBody, {
          method: req.method,
          path,
          endpoint: classifyEndpoint(path),
        });
        if (transformed.changed) {
          // Re-serialising must never take down a request: if the transformed
          // body somehow will not stringify, forward the original bytes.
          try {
            const nextText = JSON.stringify(transformed.body);
            parsedBody = transformed.body;
            bodyText = nextText;
            logger.debug(
              `[proxy] seq=${currentSeq} plugins [${transformed.appliedBy.join(', ')}] ` +
                `rewrote request body: ${originalBytes} → ${bodyText.length} bytes ` +
                `(${(((originalBytes - bodyText.length) / originalBytes) * 100).toFixed(1)}% smaller)`,
            );
          } catch (err) {
            logger.warn(
              `[proxy] seq=${currentSeq} plugin output could not be serialised; ` +
                `forwarding the original body: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const extracted = wire === 'openai'
        ? extractOpenAIRequest(path, parsedBody)
        : extractRequest(path, parsedBody);
      if (extracted.requestShape) {
        extracted.requestShape.bodyBytes = bodyText.length;
      }
      const wireModel = extracted.model;

      // LIVE: announce the forward before it happens. The audit record for this
      // request is only written when the upstream settles, and a streaming
      // /v1/messages call runs for tens of seconds — so without this `lazy
      // watch` would stay blank for exactly the window the agent is busiest.
      activity.publish({
        kind: 'open',
        id, seq: currentSeq, ts: startMs, role, taskId,
        backend: 'proxy', method: req.method, path: activityPath(path), model: extracted.model,
      });

      // Forward headers: copy all, drop host (fetch sets it for upstream),
      // strip lazy-internal headers so they never reach Anthropic. Drop
      // content-length too — fetch recomputes it, and a model-rewritten failover
      // body has a different length than the client's original.
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete('host');
      fwdHeaders.delete('content-length');
      for (const h of LAZY_HEADERS) fwdHeaders.delete(h);

      // --- per-user credentials: session placeholder → real token ---
      // Only touches a credential lazy itself minted (the `lazy-sess-` prefix).
      // With no resolver configured, or a request carrying a real credential,
      // this whole block is a single prefix test and the headers go out
      // untouched — the single-user path, unchanged.
      let userId: string | null = null;
      // Set when a member's credential FOR A PROFILE paid (see ProxyAuditRecord).
      let credentialProfile: string | null = null;
      let credentialEndpoint: string | null = null;
      const scan = config.resolveSessionCredential
        ? scanForPlaceholder(fwdHeaders, isSessionPlaceholderToken)
        : ({ kind: 'none' } as const);

      /** Refuse a placeholder request: 401, audited, never forwarded. */
      const denySession = (denial: SessionAuthDenial, detail?: string): Response => {
        const message = denialMessage(denial, detail);
        // `status` stays null: the request never reached the upstream, so this
        // is not evidence about lazy's own credential (see proxy/auth-verdict.ts
        // — a 401 there means "Anthropic rejected us"). The refusal is recorded
        // in `authDenial`, which is what a per-user audit reads.
        auditQueue.enqueue({
          id, seq: currentSeq, ts: startMs, role, taskId, userId,
          backend: 'proxy', upstream: config.upstream,
          method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
          tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
          toolUses: extracted.toolUses, toolResults: extracted.toolResults,
          status: null, usage: null, stopReason: null, error: message,
          durationMs: Date.now() - startMs, reroute: null, enforcement: null,
          authDenial: denial,
        });
        logger.warn(
          `[proxy] seq=${currentSeq} refused ${denial} task=${taskId ?? '-'} role=${role ?? '-'}` +
          (userId ? ` user=${userId}` : ''),
        );
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      };

      if (scan.kind === 'ambiguous') {
        return denySession(
          'auth_kind_mismatch',
          'a lazy session token was presented in both Authorization and x-api-key',
        );
      }
      if (scan.kind === 'one') {
        // Where the request came from: a member placeholder is pinned to its
        // container's address, and refused from anywhere else.
        const peerAddress = normalizePeerAddress(srv?.requestIP(req)?.address);
        const resolved = await config.resolveSessionCredential!(scan.credential.token, {
          peerAddress, upstream: routedUpstream ?? upstream, config: requestConfig,
        });
        if (!resolved.ok) {
          return resolved.reason === 'wrong_origin'
            ? denySession('session_token_wrong_origin', resolved.detail)
            : denySession('unknown_session_token');
        }
        userId = resolved.userId;
        credentialEndpoint = resolved.endpoint ?? null;
        const expected = expectedFormFor(resolved.kind);
        if (expected !== scan.credential.form) {
          return denySession(
            'auth_kind_mismatch',
            `user ${resolved.userId} holds a ${resolved.kind} credential, which lazy sends as ` +
            `${envVarForForm(expected)}, but the request arrived as ${envVarForForm(scan.credential.form)}`,
          );
        }
        // Only the checked primary receives this raw-session credential.
        stripAuthHeaders(fwdHeaders);
        swapCredential(fwdHeaders, scan.credential, resolved.secret);
      }

      // Ordered target list. A verified caller whose PROFILE names its own
      // upstream is routed there and ONLY there — see `agentUpstreams` for why
      // that list gets no failover chain. Everything else is
      // primary-then-fallbacks, and the primary never overrides the model
      // (undefined); fallbacks may.
      const targets: ProxyFallbackTarget[] = routedUpstream || scan.kind === 'one'
        ? [{ upstream: routedUpstream ?? upstream, model: undefined }]
        : [{ upstream, model: undefined }, ...fallbacks];

      // --- Per-target credentials ---
      // Resolved for EVERY candidate target up front, each into its own header
      // set. The failover chain is the whole reason this is per target: a
      // reroute must carry the credential the target it actually reaches needs,
      // not whichever one the client happened to present. Forwarding the
      // primary's credential down the chain is exactly the leak this closes.
      const chain: Array<{ target: ProxyFallbackTarget; headers: Headers; label: string | null }> = [];
      if (caller) {
        // TEAM MODE: a task caller is paid by its turn principal's own
        // credential for its profile, and by nothing else — so only the first
        // target is ever tried; a failover target would need somebody else's.
        const member = credentials!.member ? await credentials!.member(caller.grant, routedUpstream ? new URL(routedUpstream).origin : '', {
          upstream: routedUpstream ?? upstream,
          ...(tierChoice ? { endpoint: tierChoice.tier.endpoint, tier: tierChoice.tier.index } : {}),
          config: requestConfig,
        }) : null;
        if (member?.userId) userId = member.userId;
        if (member?.profile) credentialProfile = member.profile;
        credentialEndpoint = member?.endpoint ?? null;
        // All-full requests are authenticated and allowed, but use no target credential.
        if (answerAllTiersFull && (!member || member.outcome.kind !== 'missing')) return answerAllTiersFull();
        for (const target of targets) {
          const outcome: TargetCredentialOutcome = member
            ? (target === targets[0]
              ? member.outcome
              : { kind: 'missing', reason: 'a failover target is not paid by the member who asked for this turn' })
            : await requestTargets!.forTarget(target.upstream);
          const headers = new Headers(fwdHeaders);
          if (outcome.kind === 'credential') {
            if (member && outcome.placement.kind === 'header') stripAuthHeaders(headers);
            applyCredential(headers, presented, caller.token, outcome.placement);
          } else if (outcome.kind === 'none') {
            // Deliberately credential-free (local Ollama, an unmapped
            // fallback). The placeholder still must not travel.
            stripAuthHeaders(headers);
            // The OAuth beta flag leaves with the OAuth bearer it describes.
            removeBetaFlag(headers, ANTHROPIC_OAUTH_BETA);
          } else if (target === targets[0]) {
            // The primary has no usable credential. Refuse — never bill another
            // user's credential, never fall back silently.
            logger.warn(
              `[proxy] seq=${currentSeq} no credential for primary ${target.upstream}: ${outcome.reason}`,
            );
            return refuse(
              { id, seq: currentSeq, startMs, auditQueue },
              req,
              {
                path,
                upstream: target.upstream,
                backend: 'proxy',
                role: caller.grant.role,
                taskId: caller.grant.taskId,
                reason: outcome.reason,
                message: missingCredentialMessage(target.upstream, outcome.reason),
                credential: {
                  key: usageLimitCredentialKey({ userId, endpoint: credentialEndpoint, upstream: target.upstream }),
                  userId,
                  profile: credentialProfile,
                },
                ...transientRefusal(outcome),
              },
            );
          } else {
            // A fallback with no usable credential is dropped from the chain
            // rather than tried uncredentialed: a guaranteed 401 from it would
            // be reported to the client as the real outcome.
            logger.warn(
              `[proxy] seq=${currentSeq} dropping fallback ${target.upstream} from the chain: ${outcome.reason}`,
            );
            continue;
          }
          chain.push({ target, headers, label: outcome.kind === 'credential' ? outcome.label : null });
        }
      } else {
        // No verified caller: forward exactly what arrived, to every target.
        for (const target of targets) chain.push({ target, headers: fwdHeaders, label: null });
      }

      // The tier switch is recorded once the upstream has answered and the
      // request is NOT being handed to another tier after a capacity refusal
      // (below), or on the terminal error path: a tier that refused served
      // nothing, so it is neither a switch nor a provider of this session.
      // Same moments: the tier that actually answered is recorded as having
      // served this turn (src/task/tiers-served.ts).
      const recordTierServed = (): void => {
        if (!tierChoice || !taskId) return;
        const t = tierChoice.tier;
        options?.onTierServed?.({ taskId, tier: { index: t.index, endpoint: t.endpoint, model: t.model, upstream: t.upstream } });
      };

      // Every target reached below came OUT of the chain, so the lookup cannot
      // miss. It throws rather than defaulting to fwdHeaders because fwdHeaders
      // still holds the client's un-stripped placeholder: a future refactor that
      // broke this invariant would otherwise ship that placeholder upstream and
      // look like an ordinary auth failure.
      const headersFor = (target: ProxyFallbackTarget): Headers => {
        const entry = chain.find((c) => c.target === target);
        if (!entry) {
          throw new Error(
            `[proxy] no credential headers resolved for ${target.upstream} — this is a lazy bug, ` +
            `please report it`,
          );
        }
        return entry.headers;
      };

      const doFetch = (target: ProxyFallbackTarget): Promise<Response> => {
        const body = bodyForTarget(bodyText, parsedBody, target.model);
        return fetch(target.upstream + path, {
          method: req.method,
          headers: headersFor(target),
          body: body.length ? body : undefined,
          // lazy's own ceiling, replacing Bun's hidden default fetch timeout.
          // Without this a local model that is merely slow to produce its first
          // byte is aborted mid-prefill and reported as an unreachable upstream.
          ...upstreamFetchOptions(upstreamTimeoutSeconds),
        } as RequestInit);
      };

      let upstreamResp: Response | null = null;
      let forwardError: string | null = null;
      let finalTarget: ProxyFallbackTarget = targets[0];
      // What triggered the FIRST failover (so the audit reflects the primary's
      // failure, not an intermediate fallback's). Null until the primary fails.
      let firstTrigger: string | null = null;
      let attempts = 0;
      // The primary's usage-limit reading from the response that triggered the
      // failover. That response is cancelled below and never audited on its
      // own, so its headers — often the very "limit reached" signal — are
      // carried on the reroute instead.
      let primaryDropped: { credential: string; status: number; headers: Record<string, string> } | null = null;
      /** Capture a response the loop is about to discard, into the live view. */
      const noteDiscarded = (resp: Response, i: number): void => {
        const headers = captureUsageLimitHeaders(resp.headers);
        if (!headers) return;
        const credential = usageLimitCredentialKey({
          userId,
          endpoint: credentialEndpoint,
          credentialLabel: chain[i].label,
          upstream: chain[i].target.upstream,
        });
        usageLimits.observeReading({
          credential, ts: startMs, upstream: chain[i].target.upstream, backend: 'proxy',
          status: resp.status, taskId, model: wireModel, headers,
        });
        if (i === 0 && primaryDropped === null) primaryDropped = { credential, status: resp.status, headers };
      };

      for (let i = 0; i < chain.length; i++) {
        const target = chain[i].target;
        const isPrimary = i === 0;
        const isLast = i === chain.length - 1;
        finalTarget = target;
        attempts = i + 1;

        let resp: Response;
        try {
          resp = await doFetch(target);
        } catch (err) {
          // Unreachable, or past lazy's own ceiling. Reroute to the next target
          // if one exists, else this is the terminal error (unchanged behavior
          // when no fallback chain).
          forwardError = describeUpstreamFailure(err, target.upstream, upstreamTimeoutSeconds);
          if (firstTrigger === null) firstTrigger = isUpstreamTimeout(err) ? 'timeout' : 'unreachable';
          if (!isLast) {
            logger.warn(
              `[proxy] seq=${currentSeq} primary/target ${target.upstream} unreachable (${forwardError}); ` +
                `failing over to ${chain[i + 1].target.upstream}`,
            );
            continue;
          }
          break; // all targets exhausted → terminal error
        }

        if (OVERLOAD_STATUSES.has(resp.status)) {
          // On a primary 429 with a short Retry-After, wait it out and retry the
          // primary once before failing over — but only when failover is even
          // possible (a chain is configured). With no chain we must not wait:
          // that would change the no-config fail-hard behavior.
          // A tiered request counts as able to fail over too: its next TIER is
          // the failover, and a short burst limit must not cost a tier switch
          // (and the prompt cache) twice — down and straight back up.
          if (resp.status === 429 && isPrimary && (chain.length > 1 || tierChoice !== null)) {
            const wait = parseRetryAfter(resp.headers.get('retry-after'));
            if (wait !== null && wait <= retryAfterThreshold) {
              noteDiscarded(resp, i);
              await resp.body?.cancel();
              logger.warn(
                `[proxy] seq=${currentSeq} primary ${target.upstream} 429 with Retry-After=${wait}s ` +
                  `(≤ ${retryAfterThreshold}s); waiting then retrying primary before failover`,
              );
              await sleep(wait * 1000);
              try {
                resp = await doFetch(target);
              } catch (err) {
                forwardError = describeUpstreamFailure(err, target.upstream, upstreamTimeoutSeconds);
                if (firstTrigger === null) firstTrigger = isUpstreamTimeout(err) ? 'timeout' : 'unreachable';
                if (!isLast) {
                  logger.warn(
                    `[proxy] seq=${currentSeq} primary ${target.upstream} unreachable on retry (${forwardError}); ` +
                      `failing over to ${chain[i + 1].target.upstream}`,
                  );
                  continue;
                }
                break;
              }
              if (!OVERLOAD_STATUSES.has(resp.status)) {
                // Primary recovered after the wait — no reroute.
                upstreamResp = resp;
                forwardError = null;
                break;
              }
            }
          }

          if (firstTrigger === null) firstTrigger = String(resp.status);
          if (!isLast) {
            logger.warn(
              `[proxy] seq=${currentSeq} target ${target.upstream} returned ${resp.status}; ` +
                `failing over to ${chain[i + 1].target.upstream}`,
            );
            noteDiscarded(resp, i);
            await resp.body?.cancel();
            continue;
          }
          // Last target still overloaded — propagate its response unchanged.
          upstreamResp = resp;
          forwardError = null;
          break;
        }

        // Success, or a non-overload status (4xx/5xx that we do NOT reroute on).
        upstreamResp = resp;
        forwardError = null;
        break;
      }

      // A reroute happened iff we ended up on a target past the primary.
      const rerouted = finalTarget !== targets[0];
      const reroute: ProxyReroute | null = rerouted
        ? {
            // The chain's own head, not the configured primary: with a role
            // upstream in play they differ, and an audit record naming an
            // upstream this request never touched is a record that lies.
            fromUpstream: targets[0].upstream,
            fromModel: wireModel,
            toUpstream: finalTarget.upstream,
            toModel: finalTarget.model ?? wireModel,
            trigger: firstTrigger ?? 'unknown',
            attempts,
            ...(primaryDropped
              ? {
                  fromUsageLimitHeaders: (primaryDropped as { headers: Record<string, string> }).headers,
                  fromCredential: (primaryDropped as { credential: string }).credential,
                  fromStatus: (primaryDropped as { status: number }).status,
                }
              : {}),
          }
        : null;

      if (reroute) {
        logger.warn(
          `[proxy] seq=${currentSeq} rerouted after ${reroute.trigger}: ` +
            `${reroute.fromUpstream} (${reroute.fromModel ?? 'default'}) → ` +
            `${reroute.toUpstream} (${reroute.toModel ?? 'default'})`,
        );
      }

      // Terminal error path: every target was unreachable (thrown). Matches the
      // original single-target behavior when no fallback chain is configured.
      if (upstreamResp === null) {
        commitTierSwitch?.();
        recordTierServed();
        const durationMs = Date.now() - startMs;
        auditQueue.enqueue({
          id,
          seq: currentSeq,
          ts: startMs,
          role,
          taskId,
          userId,
          ...(credentialProfile ? { credentialProfile } : {}),
          ...(tierChoice ? { servedByEndpoint: tierChoice.tier.endpoint, tierIndex: tierChoice.tier.index, tierProfile: caller?.grant.profile ?? null } : {}),
          credential: usageLimitCredentialKey({ userId, endpoint: credentialEndpoint, credentialLabel: chain.find((c) => c.target === finalTarget)?.label ?? null, upstream: finalTarget.upstream }),
          backend: 'proxy',
          upstream: finalTarget.upstream,
          method: req.method,
          path,
          endpoint: extracted.endpoint,
          model: extracted.model,
          tier: extracted.tier,
          stream: extracted.stream,
          requestShape: extracted.requestShape,
          toolUses: extracted.toolUses,
          toolResults: extracted.toolResults,
          status: null,
          usage: null,
          stopReason: null,
          error: forwardError,
          durationMs,
          reroute,
          enforcement: null,
        });

        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: forwardError },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
      }

      // TTFB: the upstream's response headers are in hand. Taken HERE, before
      // anything below reads (or buffers) the body.
      const headersAt = Date.now();
      const status = upstreamResp.status;

      // Usage-limit signal: read off the response HEADERS, which arrive before
      // any body — so streamed and error (429) responses carry it alike.
      const usageLimitHeaders = captureUsageLimitHeaders(upstreamResp.headers);
      const credentialKey = usageLimitCredentialKey({
        userId,
        endpoint: credentialEndpoint,
        credentialLabel: chain.find((c) => c.target === finalTarget)?.label ?? null,
        upstream: finalTarget.upstream,
      });
      // A tiered profile chooses the NEXT request's tier from this reading, and
      // an agent sends that request as soon as this response ends — before the
      // audit queue folds the record in. So it is observed here, from the
      // headers, the moment they arrive. Idempotent with the later fold.
      if (tierChoice && usageLimitHeaders) {
        usageLimits.observeReading({
          credential: credentialKey, ts: startMs, upstream: finalTarget.upstream, backend: 'proxy',
          status: upstreamResp.status, taskId, model: wireModel, headers: usageLimitHeaders,
        });
      }

      // --- Tiered profile: a tier is used until it refuses for capacity ---
      // The refusal marks the tier unavailable for this profile and credential
      // until its retry time (src/proxy/tier-select.ts), and the SAME request
      // goes again through the whole pipeline, which now chooses the next
      // available tier — or answers "every tier full" when there is none. The
      // refused attempt is audited here; the client never sees it.
      if (tierChoice && caller && isCapacityRefusal(status)) {
        const refusedTier = tierChoice.tier;
        const profileName = caller.grant.profile ?? '';
        const refusal = refusalFor(refusedTier, status, usageLimitHeaders, tierRetryIntervalSeconds);
        tierRefusals.refuse(profileName, refusedTier, tierKeys.get(refusedTier.index) ?? null, refusal);
        const message =
          `tier ${refusedTier.index + 1} (${refusedTier.endpoint}, ${refusedTier.model}) ${describeRefusal(refusal)}` +
          (tierRetryReq ? '; retrying the request on the next available tier' : '');
        logger.warn(`[proxy] seq=${currentSeq} task=${taskId ?? '-'} profile=${profileName}: ${message}`);
        if (tierRetryReq) {
          await upstreamResp.body?.cancel();
          auditQueue.enqueue({
            id, seq: currentSeq, ts: startMs, role, taskId, userId,
            ...(credentialProfile ? { credentialProfile } : {}),
            servedByEndpoint: refusedTier.endpoint, tierIndex: refusedTier.index, tierProfile: caller?.grant.profile ?? null,
            backend: 'proxy', upstream: finalTarget.upstream,
            method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
            tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
            toolUses: extracted.toolUses, toolResults: extracted.toolResults,
            status, usage: null, stopReason: null, error: `${TIER_REFUSED_PREFIX}: ${message}`,
            durationMs: Date.now() - startMs, reroute, enforcement: null,
            usageLimitHeaders, credential: credentialKey,
          });
          return handleRequest(tierRetryReq, srv, tierAttempt + 1);
        }
      } else if (tierChoice && caller && status < 400) {
        // Only a refusal recorded BEFORE this request started is over: a
        // concurrent request sent earlier must not erase a newer refusal.
        const profileName = caller.grant.profile ?? '';
        const key = tierKeys.get(tierChoice.tier.index) ?? null;
        const prior = tierRefusals.get(profileName, tierChoice.tier, key);
        if (prior && prior.refusedAt < startMs) tierRefusals.clear(profileName, tierChoice.tier, key);
      }
      commitTierSwitch?.();
      recordTierServed();

      // A 404 on an inference path means the MODEL is not on this upstream, and
      // the proxy is the only place that holds both halves of that sentence: the
      // model the client asked for and the upstream its PROFILE routes to. The
      // agent sees an opaque 404 and the operator saw only `FAIL(404)` in the
      // traffic view, which is how a pi task pointed at Anthropic with an Ollama
      // model name cost a session to diagnose. One line, no body read.
      if (
        status === 404 &&
        (extracted.endpoint === 'messages' ||
          extracted.endpoint === 'chat_completions' ||
          extracted.endpoint === 'responses')
      ) {
        logger.warn(
          `[proxy] seq=${currentSeq} MODEL NOT FOUND: ${finalTarget.upstream} has no model ` +
            `"${extracted.model ?? '(unnamed)'}" (task=${taskId ?? '-'} role=${role ?? '-'} ` +
            `profile=${caller?.grant.profile ?? '-'}). An agent profile with no \`endpoint\` runs the ` +
            `primary upstream, so a model name from another service 404s there — set the task's model ` +
            `to one this upstream serves, or give the task a profile whose \`endpoint\` serves that model.`,
        );
      }

      // Bun's fetch decoded the body (gzip from real Anthropic), so strip the
      // now-stale content-encoding/content-length before forwarding or the
      // client's decoder will double-decode and fail with ZlibError.
      const respHeaders = new Headers(upstreamResp.headers);
      respHeaders.delete('content-encoding');
      respHeaders.delete('content-length');

      // --- §6.3 layer 1: active enforcement ---
      // Only a /v1/messages response to a request that DECLARED tools can carry
      // a fresh tool_use to enforce against. For everything else (no tools,
      // count_tokens, non-2xx, empty body) we keep the zero-latency streaming
      // passthrough — never buffer a response we won't rewrite.
      const mayEnforce =
        policy.enforce &&
        extracted.endpoint === 'messages' &&
        (extracted.requestShape?.numTools ?? 0) > 0 &&
        upstreamResp.ok &&
        upstreamResp.body != null;

      if (mayEnforce) {
        const contentType = upstreamResp.headers.get('content-type') ?? '';
        const isStream = contentType.includes('text/event-stream') || extracted.stream === true;
        // Read incrementally rather than with text(): the client gets nothing
        // until the whole body is in (enforcement must see every tool_use), but
        // the record still says when the first content token ARRIVED.
        const timedBody = await readBodyTimed(upstreamResp.body!, isStream, wire);
        const respText = timedBody.text;

        let enforced: ReturnType<typeof enforceResponseBody>;
        try {
          enforced = enforceResponseBody(isStream, respText, policy);
        } catch (err) {
          // Rewriting must never take down a request — on any parse/rewrite
          // failure, forward the original bytes untouched (fail open on the
          // REWRITE, not on the deny decision, which already errored safely).
          logger.warn(`[proxy] enforcement skipped for seq=${currentSeq}: ${err instanceof Error ? err.message : String(err)}`);
          enforced = { changed: false, bodyText: respText, denials: [], stopReason: null };
        }

        const enforcement: ProxyEnforcementAudit[] | null =
          enforced.denials.length > 0
            ? enforced.denials.map((d) => ({ toolUseId: d.toolUseId, name: d.name, rule: d.rule, reason: d.reason }))
            : null;

        if (enforcement) {
          for (const d of enforcement) {
            logger.info(`[proxy] DENY tool "${d.name}" (${d.rule}) task=${taskId ?? '-'} role=${role ?? '-'}`);
          }
        }

        // The body is already buffered here, so usage is a straight read. Parse
        // it from the ORIGINAL upstream text, not the rewritten one: a denial
        // rewrite changes content, never the tokens the upstream billed.
        const usage = extractUsage(isStream, respText);

        const durationMs = headersAt - startMs;
        auditQueue.enqueue({
          id, seq: currentSeq, ts: startMs, role, taskId, userId,
          ...(credentialProfile ? { credentialProfile } : {}),
          ...(tierChoice ? { servedByEndpoint: tierChoice.tier.endpoint, tierIndex: tierChoice.tier.index, tierProfile: caller?.grant.profile ?? null } : {}),
          backend: 'proxy', upstream: finalTarget.upstream,
          method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
          tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
          toolUses: extracted.toolUses, toolResults: extracted.toolResults,
          status, usage, stopReason: enforced.stopReason, error: null, durationMs,
          // Timed as the bytes arrived, before the buffered body was forwarded:
          // the upstream's latency, not what the client saw.
          ttftMs: timedBody.firstContentAt === null ? null : timedBody.firstContentAt - startMs,
          ttltMs: timedBody.endedAt - startMs,
          reroute, enforcement, usageLimitHeaders, credential: credentialKey,
        });

        return new Response(enforced.bodyText, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: respHeaders,
        });
      }

      const durationMs = headersAt - startMs;

      // Everything about the record except `usage` is known now. `durationMs`
      // deliberately stays "time to the upstream's response", not "time until
      // the stream drained" — same number this record has always carried.
      const record: ProxyAuditRecord = {
        id,
        seq: currentSeq,
        ts: startMs,
        role,
        taskId,
        userId,
        ...(credentialProfile ? { credentialProfile } : {}),
          ...(tierChoice ? { servedByEndpoint: tierChoice.tier.endpoint, tierIndex: tierChoice.tier.index, tierProfile: caller?.grant.profile ?? null } : {}),
        backend: 'proxy',
        upstream: finalTarget.upstream,
        method: req.method,
        path,
        endpoint: extracted.endpoint,
        model: extracted.model,
        tier: extracted.tier,
        stream: extracted.stream,
        requestShape: extracted.requestShape,
        toolUses: extracted.toolUses,
        toolResults: extracted.toolResults,
        status,
        usage: null,
        stopReason: null,
        error: null,
        durationMs,
        reroute,
        enforcement: null,
        usageLimitHeaders,
        credential: credentialKey,
      };

      // Only a successful inference response carries token usage —
      // /v1/messages on the Anthropic wire; /v1/chat/completions and
      // /v1/responses on the OpenAI wire. For everything else (count_tokens,
      // non-2xx, empty body) enqueue immediately and hand back the upstream
      // stream untouched, exactly as before.
      const usageEndpoint =
        extracted.endpoint === 'messages' ||
        extracted.endpoint === 'chat_completions' ||
        extracted.endpoint === 'responses';
      const canCaptureUsage = usageEndpoint && upstreamResp.ok && upstreamResp.body != null;

      if (!canCaptureUsage) {
        // A Codex 429 states its reset in a small JSON body, not in a header
        // (src/proxy/usage-limits.ts, `codexRefusalHeaders`). Read it here —
        // the one error response whose body the usage pause needs — and hand
        // the same bytes on to the client.
        if (
          status === 429 &&
          usageLimitHeaders &&
          Object.keys(usageLimitHeaders).some((h) => h.startsWith('x-codex-')) &&
          upstreamResp.body != null &&
          !(upstreamResp.headers.get('content-type') ?? '').includes('text/event-stream')
        ) {
          const body = await upstreamResp.text();
          const refusal = codexRefusalHeaders(body, startMs);
          const withError = { ...record, error: upstreamErrorExcerpt(body, credentialValuesIn(headersFor(finalTarget))) };
          auditQueue.enqueue(refusal ? { ...withError, usageLimitHeaders: { ...usageLimitHeaders, ...refusal } } : withError);
          return new Response(body, {
            status: upstreamResp.status,
            statusText: upstreamResp.statusText,
            headers: respHeaders,
          });
        }
        // An error response: record WHAT the upstream said, not just its status
        // — a bare FAIL(400) is undiagnosable (upstream-error.ts). Error bodies
        // are small JSON and the client needs the whole body anyway, so reading
        // it here costs nothing; an SSE body is still streamed untouched.
        if (
          status >= 400 &&
          upstreamResp.body != null &&
          !(upstreamResp.headers.get('content-type') ?? '').includes('text/event-stream')
        ) {
          // Forward the upstream's BYTES, and decode only a copy for the
          // excerpt: text() would replace invalid UTF-8 in what the client gets.
          const body = await upstreamResp.arrayBuffer();
          const excerpt = upstreamErrorExcerpt(
            new TextDecoder().decode(body),
            credentialValuesIn(headersFor(finalTarget)),
          );
          auditQueue.enqueue({ ...record, error: excerpt });
          return new Response(body, {
            status: upstreamResp.status,
            statusText: upstreamResp.statusText,
            headers: respHeaders,
          });
        }
        // Fire-and-forget — never awaited on the hot path.
        auditQueue.enqueue(record);
        return new Response(keepAliveIfSse(upstreamResp.body, respHeaders), {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: respHeaders,
        });
      }

      // Tee the body: every chunk is forwarded to the client BEFORE the scanner
      // sees it, so this adds no latency and buffers nothing. The audit record
      // is enqueued when the stream ends (or is cancelled/errors), with the
      // usage the scanner observed.
      const respContentType = upstreamResp.headers.get('content-type') ?? '';
      const respIsStream =
        respContentType.includes('text/event-stream') || extracted.stream === true;
      // The headers arrived with the response; a stream can run for minutes
      // before the record is enqueued, so update the live view now. The later
      // observe from the audit tap carries the same ts and changes nothing.
      usageLimits.observe(record);
      const teed = teeUsageStream(upstreamResp.body!, respIsStream, (usage, timing) => {
        auditQueue.enqueue({
          ...record,
          usage,
          ttftMs: timing.firstContentAt === null ? null : timing.firstContentAt - startMs,
          // A cancelled or broken stream has no "last token": recording its abort
          // time would pass for a finished response in the percentiles.
          ttltMs: timing.completed ? timing.endedAt - startMs : null,
        });
      }, wire);

      // Keep-alive framing wraps the tee, never the other way round: the usage
      // scanner must see the upstream's bytes and ONLY the upstream's bytes, or
      // lazy's own keep-alive comments would land in the audit record.
      return new Response(keepAliveIfSse(teed, respHeaders), {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: respHeaders,
      });
  };

    /**
     * Last line of defence for ONE request.
     *
     * Every failure the proxy anticipates is already handled inline and audited
     * (an unreachable upstream, a refused credential, a malformed cursor
     * route). Anything reaching here is a bug in the handler, and the question
     * is only what the client and the operator get.
     *
     * Without this callback Bun answers with its own 500 and prints the stack —
     * an HTML-ish page an SDK cannot parse, carrying lazy's internals to an
     * agent's stderr. With it, the caller gets the same JSON error envelope
     * every other proxy refusal uses, so a client that already knows how to
     * read an upstream error reads this one too, and the operator gets exactly
     * one line with the stack in the daemon log.
     *
     * This isolates the failing request and nothing more. It cannot see a throw
     * from an already-streaming response body — Bun logs those and tears down
     * the socket without consulting `error` (verified on Bun 1.4.2) — which is
     * why the daemon also installs process-level guards (src/daemon/process-guards.ts).
     */
  const handleError = (err: unknown): Response => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[proxy] request handler failed (proxy staying up): ${err instanceof Error ? (err.stack ?? message) : message}`,
      );
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `lazy proxy failed to handle this request: ${message}` },
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
  };

  // Bun.serve listens on ONE hostname per call, so every address the proxy
  // answers on is its own server sharing the handlers — the same shape the
  // daemon's RPC port uses (src/daemon/server.ts, "container reachability").
  const listen = (hostname: string, port: number) => Bun.serve({
    // 0 = let the OS assign a free port; the actual port is read back from
    // `server.port` below (and published so agents/status can find it).
    port,
    hostname,
    // Bun reaps a connection whose RESPONSE BODY has been silent this long
    // (verified 1.4.2; a handler that has not returned a Response yet is NOT
    // affected). Raising it is not an option — Bun caps it at 255 — so a silent
    // SSE body is kept warm by keep-alive comment frames instead
    // (src/proxy/keepalive.ts), and how long the proxy waits for an upstream is
    // a separate, explicit ceiling (src/proxy/upstream-timeout.ts).
    idleTimeout: 240,
    fetch: handleRequest,
    error: handleError,
  });

  const server = listen(config.bind, config.port);

  // CONTAINER REACHABILITY. A task container dials this proxy at
  // host.docker.internal:<port>; on native Linux Docker that name is the bridge
  // gateway, a non-loopback interface a loopback-bound proxy refuses. The
  // daemon resolves those extra addresses (resolveProxyBindHosts: only under
  // the daemon port's own conditions, never 0.0.0.0, never overriding an
  // explicit or managed-mode bind) and hands them here; each is bound on the
  // SAME port. Security posture unchanged: the proxy authenticates every
  // request by placeholder lookup, not by where it came from, and the
  // container bridge is exactly the set of clients it exists for. A bind that
  // fails is logged and skipped — a proxy the host can still reach beats none.
  const primaryPort = server.port ?? config.port;
  const extraServers: ReturnType<typeof Bun.serve>[] = [];
  const extraHosts: string[] = [];
  for (const host of config.extraBindHosts ?? []) {
    if (host === config.bind) continue;
    try {
      extraServers.push(listen(host, primaryPort));
      extraHosts.push(host);
      logger.info(`[proxy] also listening on ${host}:${primaryPort} (container reachability)`);
    } catch (err) {
      logger.warn(
        `[proxy] could not also listen on ${host}:${primaryPort} (container reachability): ` +
        `${err instanceof Error ? err.message : String(err)}. Task containers reaching the proxy via ` +
        `host.docker.internal:${primaryPort} may be refused.`,
      );
    }
  }

  // Log the ACTUAL bound port (config.port may be 0 → OS-assigned).
  logger.info(`[proxy] listening on ${config.bind}:${server.port}, forwarding to ${upstream}${fallbackNote}${agentNote}` +
      `, cursor route ${CURSOR_PROXY_PREFIX}/* → ${cursorUpstream}` +
      `, upstream timeout ${upstreamTimeoutSeconds > 0 ? `${upstreamTimeoutSeconds}s` : 'none'}`);

  // The primary server, with `stop` widened to every listener and the list of
  // addresses actually bound — `/daemon/status` reports it as `proxy.binds`.
  const primaryStop = server.stop.bind(server);
  const stop = async (closeActiveConnections?: boolean): Promise<void> => {
    for (const extra of extraServers) await extra.stop(closeActiveConnections);
    await primaryStop(closeActiveConnections);
  };
  return Object.assign(server, {
    binds: [config.bind, ...extraHosts],
    stop,
    auditHealth: () => auditQueue.health(),
  }) as ProxyServer;
}

export { AuditQueue };
