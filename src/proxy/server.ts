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
 * Clients identify themselves with two optional headers that lazy injects:
 *   x-lazy-role     — "builder" | "agent"
 *   x-lazy-task-id  — short task id
 *
 * These are stripped before forwarding to the real upstream.
 */

import { randomUUID } from 'crypto';
import type { Storage } from '../storage/interface';
import type { ProxyEnforcementAudit, ProxyReroute } from '../storage/types';
import { extractRequest } from './extractor';
import { AuditQueue } from './audit';
import { enforceResponseBody } from './enforce';
import { defaultPolicyConfig, type ProxyPolicyConfig } from './policy';
import { logger } from '../utils/logger';

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

export function createProxyServer(
  config: ProxyServerConfig,
  storage: Storage,
): ReturnType<typeof Bun.serve> {
  const upstream = config.upstream.replace(/\/$/, '');
  const fallbacks: ProxyFallbackTarget[] = (config.fallbacks ?? []).map((f) => ({
    upstream: f.upstream.replace(/\/$/, ''),
    model: f.model,
  }));
  const retryAfterThreshold = config.retryAfterThreshold ?? DEFAULT_RETRY_AFTER_THRESHOLD;
  const policy = config.policy ?? defaultPolicyConfig();
  const auditQueue = new AuditQueue(storage);
  let seq = 0;

  const fallbackNote = fallbacks.length
    ? `, failover chain: [${fallbacks.map((f) => f.upstream).join(', ')}]`
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

      // Lazy-injected audit hints — strip before forwarding to upstream
      const role = req.headers.get('x-lazy-role');
      const taskId = req.headers.get('x-lazy-task-id');

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

      // Forward headers: copy all, drop host (fetch sets it for upstream),
      // strip lazy-internal headers so they never reach Anthropic. Drop
      // content-length too — fetch recomputes it, and a model-rewritten failover
      // body has a different length than the client's original.
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete('host');
      fwdHeaders.delete('content-length');
      for (const h of LAZY_HEADERS) fwdHeaders.delete(h);

      // Ordered target list: primary first, then any configured fallbacks.
      // The primary never overrides the model (undefined); fallbacks may.
      const targets: ProxyFallbackTarget[] = [
        { upstream, model: undefined },
        ...fallbacks,
      ];

      const doFetch = (target: ProxyFallbackTarget): Promise<Response> => {
        const body = bodyForTarget(bodyText, parsedBody, target.model);
        return fetch(target.upstream + path, {
          method: req.method,
          headers: fwdHeaders,
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

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const isPrimary = i === 0;
        const isLast = i === targets.length - 1;
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
                `failing over to ${targets[i + 1].upstream}`,
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
          if (resp.status === 429 && isPrimary && targets.length > 1) {
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
                      `failing over to ${targets[i + 1].upstream}`,
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
                `failing over to ${targets[i + 1].upstream}`,
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
            fromUpstream: upstream,
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

        const durationMs = Date.now() - startMs;
        auditQueue.enqueue({
          id, seq: currentSeq, ts: startMs, role, taskId, backend: 'proxy', upstream: finalTarget.upstream,
          method: req.method, path, endpoint: extracted.endpoint, model: extracted.model,
          tier: extracted.tier, stream: extracted.stream, requestShape: extracted.requestShape,
          toolUses: extracted.toolUses, toolResults: extracted.toolResults,
          status, usage: null, stopReason: enforced.stopReason, error: null, durationMs,
          reroute, enforcement,
        });

        return new Response(enforced.bodyText, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: respHeaders,
        });
      }

      const durationMs = Date.now() - startMs;

      // Enqueue audit record; fire-and-forget — never awaited on the hot path
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
        status,
        usage: null,     // response body is streamed through; usage captured in a future tier
        stopReason: null,
        error: null,
        durationMs,
        reroute,
        enforcement: null,
      });

      // Stream the response body UNTOUCHED — return the upstream ReadableStream
      // directly.
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: respHeaders,
      });
    },
  });

  // Log the ACTUAL bound port (config.port may be 0 → OS-assigned).
  logger.info(`[proxy] listening on ${config.bind}:${server.port}, forwarding to ${upstream}${fallbackNote}`);

  return server;
}

export { AuditQueue };
