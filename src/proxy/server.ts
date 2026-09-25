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
 * fails hard exactly as before (CLAUDE.md: no silent fallbacks). Every reroute is
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
 * Clients identify themselves with two optional headers that lazy injects:
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
import type { ProxyAuditRecord, ProxyEnforcementAudit, ProxyReroute } from '../storage/types';
import { extractRequest, classifyEndpoint } from './extractor';
import { warmToolResultTokenizer } from './tool-result-tokens';
import type { ProxyToolStatsRecorder } from './tool-stats';
import { AuditQueue, type AuditSink } from './audit';
import {
  captureUsageLimitHeaders,
  daemonUsageLimits,
  usageLimitCredentialKey,
  type UsageLimitTracker,
} from './usage-limits';
import {
  activityPath, closeEventFromRecord, proxyActivity,
  CREDENTIAL_REFUSED_PREFIX, PATH_REFUSED_PREFIX, type ProxyActivityBus,
} from './activity';
import {
  decideProxyPath,
  pathRefusalBody,
  pathRefusalMessage,
  pathRefusalReasonText,
} from './path-allowlist';
import { enforceResponseBody } from './enforce';
import { extractUsage, teeUsageStream, type UsageWire } from './usage';
import { isSseContentType, withSseKeepAlive } from './keepalive';
import {
  DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
  describeUpstreamFailure,
  isUpstreamTimeout,
  upstreamFetchOptions,
} from './upstream-timeout';
import { extractOpenAIRequest } from './openai-extractor';
import { routeForProfile, type AgentUpstreamRoute } from './agent-upstreams';
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
  stripPresentedCredential,
  credentialErrorBody,
  unknownPlaceholderMessage,
  missingCredentialMessage,
  type PresentedCredential,
} from './inject';
import type { TargetCredentials } from './target-credentials';
import type { CredentialGrant } from './credential-broker';
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
  /** Per-upstream real credentials, resolved live at request time. */
  targets: TargetCredentials;
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
   * immediately. Default 5. Only applies when a fallback chain is configured.
   */
  retryAfterThreshold?: number;
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
   * change the model AND bill the user, silently (CLAUDE.md: no silent
   * fallbacks). A profile upstream that is down fails, loudly, like any other
   * unreachable upstream.
   *
   * Unlisted profiles — and unattributed traffic, which has no profile at all —
   * use the primary upstream and its chain, unchanged.
   *
   * Each entry carries the upstream's WIRE FORMAT too: an `openai` wire routes
   * the request through the OpenAI path-allowlist tier and the OpenAI usage
   * extractor; the Anthropic-shaped extractor never sees that traffic.
   */
  agentUpstreams?: Record<string, AgentUpstreamRoute>;
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
    headers: { 'content-type': 'application/json' },
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
  token: string,
  real: string,
): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (!Number.isFinite(declared) || declared <= 0) return null;
  if (declared > CURSOR_BODY_SUBSTITUTION_LIMIT) return null;

  const bytes = new Uint8Array(await req.arrayBuffer());
  const needle = ASCII.encode(token);
  let at = indexOfBytes(bytes, needle, 0);
  // No placeholder in the body: hand back the ORIGINAL bytes. The stream is
  // already consumed, so "unchanged" has to mean these exact bytes, not a
  // re-encoding of them.
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

  // --- JIT credential exchange ---
  if (caller && credentials) {
    const outcome = await credentials.targets.forTarget(cursorUpstream);
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
      });
    }
    if (outcome.kind === 'none') {
      // Nothing to inject — but the placeholder must still not go upstream.
      stripPresentedCredential(fwdHeaders, presented, caller.token);
    } else {
      applyCredential(fwdHeaders, presented, caller.token, outcome.placement);
      cursorCredentialLabel = outcome.label;
      // Body substitution only for an in-place placement: that value is the
      // bare credential. A header placement's value may carry wire framing
      // ("Bearer x"), which belongs in a header and nowhere else.
      if (hasBody && outcome.placement.kind === 'in-place') {
        bodyOverride = await cursorBodyWithCredential(req, caller.token, outcome.placement.value);
      }
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
      body: bodyOverride !== null ? bodyOverride : hasBody ? req.body : undefined,
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

  ctx.auditQueue.enqueue({
    ...base,
    status: upstreamResp.status,
    usageLimitHeaders: captureUsageLimitHeaders(upstreamResp.headers),
    credential: usageLimitCredentialKey({
      credentialLabel: cursorCredentialLabel,
      upstream: cursorUpstream,
    }),
    error: null,
    durationMs: Date.now() - ctx.startMs,
  });

  // Same stale-encoding strip as the Anthropic path: Bun's fetch already
  // decoded the body, so forwarding the compressed length would break clients.
  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
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
    // Latest usage-limit reading per credential. Defaults to the daemon-wide
    // tracker the `usageLimits` RPC reads; injectable for tests.
    usageLimits?: UsageLimitTracker;
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
      };
    }
  }
  const retryAfterThreshold = config.retryAfterThreshold ?? DEFAULT_RETRY_AFTER_THRESHOLD;
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
  });
  let seq = 0;

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
    ? `, agent profiles: [${agentEntries.map(([p, u]) => `${p} → ${u.upstream} (${u.wire} wire)`).join(', ')}]`
    : '';

  const handleRequest = async (req: Request, srv?: { requestIP(req: Request): { address: string } | null }): Promise<Response> => {
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
          cursorCaller = { grant, token: route.token };
        }
        return forwardCursor(req, route, cursorUpstream, cursorCaller, credentials, {
          id,
          seq: currentSeq,
          startMs,
          auditQueue,
          activity,
          upstreamTimeoutSeconds,
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
      const callerRoute = caller ? routeForProfile(agentUpstreams, caller.grant) : undefined;
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
        const resolved = await config.resolveSessionCredential!(scan.credential.token, { peerAddress });
        if (!resolved.ok) {
          return resolved.reason === 'wrong_origin'
            ? denySession('session_token_wrong_origin', resolved.detail)
            : denySession('unknown_session_token');
        }
        userId = resolved.userId;
        const expected = expectedFormFor(resolved.kind);
        if (expected !== scan.credential.form) {
          return denySession(
            'auth_kind_mismatch',
            `user ${resolved.userId} holds a ${resolved.kind} credential, which lazy sends as ` +
            `${envVarForForm(expected)}, but the request arrived as ${envVarForForm(scan.credential.form)}`,
          );
        }
        swapCredential(fwdHeaders, scan.credential, resolved.secret);
      }

      // Ordered target list. A verified caller whose PROFILE names its own
      // upstream is routed there and ONLY there — see `agentUpstreams` for why
      // that list gets no failover chain. Everything else is
      // primary-then-fallbacks, and the primary never overrides the model
      // (undefined); fallbacks may.
      const targets: ProxyFallbackTarget[] = routedUpstream
        ? [{ upstream: routedUpstream, model: undefined }]
        : [{ upstream, model: undefined }, ...fallbacks];

      // --- Per-target credentials ---
      // Resolved for EVERY candidate target up front, each into its own header
      // set. The failover chain is the whole reason this is per target: a
      // reroute must carry the credential the target it actually reaches needs,
      // not whichever one the client happened to present. Forwarding the
      // primary's credential down the chain is exactly the leak this closes.
      const chain: Array<{ target: ProxyFallbackTarget; headers: Headers; label: string | null }> = [];
      if (caller) {
        for (const target of targets) {
          const outcome = await credentials!.targets.forTarget(target.upstream);
          const headers = new Headers(fwdHeaders);
          if (outcome.kind === 'credential') {
            applyCredential(headers, presented, caller.token, outcome.placement);
          } else if (outcome.kind === 'none') {
            // Deliberately credential-free (local Ollama, an unmapped
            // fallback). The placeholder still must not travel.
            stripPresentedCredential(headers, presented, caller.token);
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
          if (resp.status === 429 && isPrimary && chain.length > 1) {
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
        const durationMs = Date.now() - startMs;
        auditQueue.enqueue({
          id,
          seq: currentSeq,
          ts: startMs,
          role,
          taskId,
          userId,
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

      const status = upstreamResp.status;

      // Usage-limit signal: read off the response HEADERS, which arrive before
      // any body — so streamed and error (429) responses carry it alike.
      const usageLimitHeaders = captureUsageLimitHeaders(upstreamResp.headers);
      const credentialKey = usageLimitCredentialKey({
        userId,
        credentialLabel: chain.find((c) => c.target === finalTarget)?.label ?? null,
        upstream: finalTarget.upstream,
      });

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
        const respText = await upstreamResp.text();
        const contentType = upstreamResp.headers.get('content-type') ?? '';
        const isStream = contentType.includes('text/event-stream') || extracted.stream === true;

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

        const durationMs = Date.now() - startMs;
        auditQueue.enqueue({
          id, seq: currentSeq, ts: startMs, role, taskId, userId, backend: 'proxy', upstream: finalTarget.upstream,
          method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
          tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
          toolUses: extracted.toolUses, toolResults: extracted.toolResults,
          status, usage, stopReason: enforced.stopReason, error: null, durationMs,
          reroute, enforcement, usageLimitHeaders, credential: credentialKey,
        });

        return new Response(enforced.bodyText, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: respHeaders,
        });
      }

      const durationMs = Date.now() - startMs;

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
      const teed = teeUsageStream(upstreamResp.body!, respIsStream, (usage) => {
        auditQueue.enqueue({ ...record, usage });
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
