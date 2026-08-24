/**
 * Anthropic-native passthrough proxy server.
 *
 * Forwards every request to the configured upstream unchanged (path, method,
 * body, auth headers). Streams the SSE response body back untouched — never
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
import { extractRequest } from './extractor';
import { AuditQueue, type AuditSink } from './audit';
import {
  activityPath, closeEventFromRecord, proxyActivity,
  CREDENTIAL_REFUSED_PREFIX, type ProxyActivityBus,
} from './activity';
import { enforceResponseBody } from './enforce';
import { extractUsage, teeUsageStream } from './usage';
import { defaultPolicyConfig, type ProxyPolicyConfig } from './policy';
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
import type { RoleName } from '../config/types';
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

export interface ProxyServerConfig {
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
   * Per-ROLE upstream overrides, keyed by the role a verified caller's grant was
   * minted for. A request from a role listed here is forwarded to ITS upstream
   * instead of the primary — this is what makes a role `endpoint` proxy-side
   * routing rather than a direct connection the agent makes itself (see
   * src/proxy/role-upstreams.ts).
   *
   * Deliberately NOT a failover chain: `[[proxy.fallback]]` is the primary's
   * failover, and failing an ollama role over to api.anthropic.com would change
   * the model AND bill the user, silently (CLAUDE.md: no silent fallbacks). A
   * role upstream that is down fails, loudly, like any other unreachable upstream.
   *
   * Unlisted roles — and unattributed traffic, which has no role at all — use the
   * primary upstream and its chain, unchanged.
   */
  roleUpstreams?: Partial<Record<RoleName, string>>;
  /**
   * Cursor API base URL that the `/_lazy/cursor/<token>` route forwards
   * to. Defaults to Cursor's production origin. This route is a verbatim
   * passthrough — see src/proxy/cursor-route.ts.
   */
  cursorUpstream?: string;
}

const LAZY_HEADERS = new Set(['x-lazy-role', 'x-lazy-task-id']);

/** Statuses that trigger failover to the next target. */
const OVERLOAD_STATUSES = new Set([429, 529]);

const DEFAULT_RETRY_AFTER_THRESHOLD = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Enqueue an audit record for a request the proxy REFUSED on credential
 * grounds, and return the 401.
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
  },
): Response {
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
    status: 401,
    usage: null,
    stopReason: null,
    // The prefix is shared rather than spelled here: `lazy watch`'s remedy line
    // keys off it (see CREDENTIAL_REFUSED_PREFIX in ./activity).
    error: `${CREDENTIAL_REFUSED_PREFIX}: ${opts.reason}`,
    durationMs: Date.now() - ctx.startMs,
    reroute: null,
    enforcement: null,
  });
  return new Response(credentialErrorBody(opts.message), {
    status: 401,
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
  },
): Promise<Response> {
  const fwdHeaders = new Headers(req.headers);
  fwdHeaders.delete('host');
  fwdHeaders.delete('content-length');
  for (const h of LAZY_HEADERS) fwdHeaders.delete(h);

  const target = cursorUpstream + route.upstreamPath;
  let hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body != null;
  let bodyOverride: Uint8Array | null = null;

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
    } as RequestInit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
  options?: { activity?: ProxyActivityBus },
): ReturnType<typeof Bun.serve> {
  const upstream = config.upstream.replace(/\/$/, '');
  const fallbacks: ProxyFallbackTarget[] = (config.fallbacks ?? []).map((f) => ({
    upstream: f.upstream.replace(/\/$/, ''),
    model: f.model,
  }));
  const cursorUpstream = (config.cursorUpstream ?? DEFAULT_CURSOR_UPSTREAM).replace(/\/$/, '');
  const roleUpstreams: Partial<Record<RoleName, string>> = {};
  for (const [role, url] of Object.entries(config.roleUpstreams ?? {})) {
    if (url) roleUpstreams[role as RoleName] = url.replace(/\/$/, '');
  }
  const retryAfterThreshold = config.retryAfterThreshold ?? DEFAULT_RETRY_AFTER_THRESHOLD;
  const policy = config.policy ?? defaultPolicyConfig();
  // The live tap: every audited record becomes a `close` event for any
  // `lazy watch` subscriber. Wired at the queue so no record site can miss it.
  const activity = options?.activity ?? proxyActivity;
  const auditQueue = new AuditQueue(auditSink, (record) =>
    activity.publish(closeEventFromRecord(record)),
  );
  let seq = 0;

  const fallbackNote = fallbacks.length
    ? `, failover chain: [${fallbacks.map((f) => f.upstream).join(', ')}]`
    : '';
  const roleEntries = Object.entries(roleUpstreams);
  const roleNote = roleEntries.length
    ? `, role upstreams: [${roleEntries.map(([r, u]) => `${r} → ${u}`).join(', ')}]`
    : '';

  const server = Bun.serve({
    // 0 = let the OS assign a free port; the actual port is read back from
    // `server.port` below (and published so agents/status can find it).
    port: config.port,
    hostname: config.bind,
    idleTimeout: 240,

    async fetch(req) {
      const startMs = Date.now();
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      const id = randomUUID();
      const currentSeq = ++seq;

      // --- Cursor passthrough route ---
      // Opaque by design: forwarded verbatim, never parsed by the
      // Anthropic-shaped extractor, never enforced against, no usage capture.
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

      // Buffer the request body for audit extraction; forward verbatim (and
      // re-send on failover — the body is already in memory, so a reroute costs
      // nothing extra to buffer).
      const bodyText =
        req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();

      let parsedBody: unknown = null;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // Non-JSON body (e.g., raw binary) — leave null; extractor handles it
        }
      }

      const extracted = extractRequest(path, parsedBody);
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

      // Ordered target list. A verified caller whose ROLE names its own upstream
      // is routed there and ONLY there — see `roleUpstreams` for why that list
      // gets no failover chain. Everything else is primary-then-fallbacks, and
      // the primary never overrides the model (undefined); fallbacks may.
      const roleUpstream = caller ? roleUpstreams[caller.grant.role] : undefined;
      const targets: ProxyFallbackTarget[] = roleUpstream
        ? [{ upstream: roleUpstream, model: undefined }]
        : [{ upstream, model: undefined }, ...fallbacks];

      // --- Per-target credentials ---
      // Resolved for EVERY candidate target up front, each into its own header
      // set. The failover chain is the whole reason this is per target: a
      // reroute must carry the credential the target it actually reaches needs,
      // not whichever one the client happened to present. Forwarding the
      // primary's credential down the chain is exactly the leak this closes.
      const chain: Array<{ target: ProxyFallbackTarget; headers: Headers }> = [];
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
          chain.push({ target, headers });
        }
      } else {
        // No verified caller: forward exactly what arrived, to every target.
        for (const target of targets) chain.push({ target, headers: fwdHeaders });
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
        });
      };

      let upstreamResp: Response | null = null;
      let forwardError: string | null = null;
      let finalTarget: ProxyFallbackTarget = targets[0];
      // What triggered the FIRST failover (so the audit reflects the primary's
      // failure, not an intermediate fallback's). Null until the primary fails.
      let firstTrigger: string | null = null;
      let attempts = 0;

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
          // Unreachable. Reroute to the next target if one exists, else this is
          // the terminal error (unchanged behavior when no fallback chain).
          forwardError = err instanceof Error ? err.message : String(err);
          if (firstTrigger === null) firstTrigger = 'unreachable';
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
              await resp.body?.cancel();
              logger.warn(
                `[proxy] seq=${currentSeq} primary ${target.upstream} 429 with Retry-After=${wait}s ` +
                  `(≤ ${retryAfterThreshold}s); waiting then retrying primary before failover`,
              );
              await sleep(wait * 1000);
              try {
                resp = await doFetch(target);
              } catch (err) {
                forwardError = err instanceof Error ? err.message : String(err);
                if (firstTrigger === null) firstTrigger = 'unreachable';
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
          id, seq: currentSeq, ts: startMs, role, taskId, backend: 'proxy', upstream: finalTarget.upstream,
          method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
          tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
          toolUses: extracted.toolUses, toolResults: extracted.toolResults,
          status, usage, stopReason: enforced.stopReason, error: null, durationMs,
          reroute, enforcement,
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
      };

      // Only a successful /v1/messages response carries token usage. For
      // everything else (count_tokens, non-2xx, empty body) enqueue immediately
      // and hand back the upstream stream untouched, exactly as before.
      const canCaptureUsage =
        extracted.endpoint === 'messages' && upstreamResp.ok && upstreamResp.body != null;

      if (!canCaptureUsage) {
        // Fire-and-forget — never awaited on the hot path.
        auditQueue.enqueue(record);
        return new Response(upstreamResp.body, {
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
      const teed = teeUsageStream(upstreamResp.body!, respIsStream, (usage) => {
        auditQueue.enqueue({ ...record, usage });
      });

      return new Response(teed, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: respHeaders,
      });
    },
  });

  // Log the ACTUAL bound port (config.port may be 0 → OS-assigned).
  logger.info(`[proxy] listening on ${config.bind}:${server.port}, forwarding to ${upstream}${fallbackNote}${roleNote}` +
      `, cursor route ${CURSOR_PROXY_PREFIX}/* → ${cursorUpstream}`);

  return server;
}

export { AuditQueue };
