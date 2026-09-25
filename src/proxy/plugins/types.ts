/**
 * Request-plugin seam for the Anthropic passthrough proxy — the contract a
 * user-authored plugin in `.lazy/plugins/` has to satisfy.
 *
 * SCOPE (deliberately small): a plugin is a PURE, SYNCHRONOUS function from a
 * parsed JSON request body to a new parsed JSON request body. That is the whole
 * contract. There is no response hook, no async, no I/O and no ordering DSL —
 * chain order is the sorted filename, and everything else a plugin needs it can
 * compute from the body it is handed.
 *
 * THE MODULE SHAPE a plugin file must export, and how the chain is discovered
 * and loaded, are documented in ./loader.ts. In short:
 *
 *     // .lazy/plugins/my-plugin.ts
 *     export default {
 *       name: 'my-plugin',
 *       transformRequest(body, ctx) { return null; },   // null = no change
 *     };
 *
 * The three properties the seam guarantees, in priority order:
 *
 *   1. ZERO-COST WHEN EMPTY. With no plugins installed, `applyRequestPlugins`
 *      returns the caller's own object identity and `changed: false`, so the
 *      server re-sends the original bytes verbatim. Default behavior is
 *      byte-identical to a build without this file.
 *
 *   2. FAIL OPEN. A plugin that throws is logged and SKIPPED; the pipeline
 *      continues from the last good body. The proxy is on every agent's
 *      critical path — a buggy transform must degrade to passthrough, never to
 *      a failed request. (This mirrors the enforcement path's rewrite fallback
 *      in server.ts: fail open on the REWRITE, never on a security decision.)
 *
 *   3. PURE AND DETERMINISTIC. Same body in, same body out, always. This is
 *      what keeps upstream prompt caching viable: a nondeterministic transform
 *      would produce a different prefix on every turn and destroy the cache.
 *      Plugins must not do I/O, read the clock, or hold state across calls.
 */

import { logger } from '../../utils/logger';
import type { ClassifiedEndpoint } from '../extractor';

/** Read-only request facts a plugin may key its decision off. */
export interface ProxyRequestContext {
  /** HTTP method of the inbound request. */
  method: string;
  /** Path + query, as received (e.g. "/v1/messages"). */
  path: string;
  /** Endpoint classification from the extractor. */
  endpoint: ClassifiedEndpoint;
}

export interface ProxyRequestPlugin {
  /** Stable identifier, used in logs. */
  readonly name: string;
  /**
   * Transform a parsed JSON request body.
   *
   * Return `null` to mean "no change" — that is the cheap path and plugins
   * should take it whenever they have nothing to do. Returning a value means
   * "forward this instead"; the returned body is re-serialised by the caller.
   *
   * MUST be pure, synchronous and deterministic. MUST NOT mutate `body` in
   * place — build and return a new object, so that a later plugin throwing
   * cannot leave a half-applied transform behind.
   */
  transformRequest(body: unknown, ctx: ProxyRequestContext): unknown | null;
}

export interface ApplyPluginsResult {
  /** The body to forward. Identical reference to the input when `changed` is false. */
  body: unknown;
  /** True iff at least one plugin returned a replacement body. */
  changed: boolean;
  /** Names of the plugins that actually changed the body, in application order. */
  appliedBy: string[];
}

/**
 * Run the plugin chain over a parsed request body.
 *
 * Never throws: a plugin that throws is logged at warn and skipped, and the
 * chain continues from the last known-good body (property 2 above).
 */
export function applyRequestPlugins(
  plugins: readonly ProxyRequestPlugin[],
  body: unknown,
  ctx: ProxyRequestContext,
): ApplyPluginsResult {
  if (plugins.length === 0 || body === null || typeof body !== 'object') {
    return { body, changed: false, appliedBy: [] };
  }

  let current = body;
  const appliedBy: string[] = [];

  for (const plugin of plugins) {
    let next: unknown | null;
    try {
      next = plugin.transformRequest(current, ctx);
    } catch (err) {
      logger.warn(
        `[proxy] request plugin "${plugin.name}" threw and was skipped: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (next === null || next === undefined || next === current) continue;
    current = next;
    appliedBy.push(plugin.name);
  }

  return { body: current, changed: appliedBy.length > 0, appliedBy };
}
