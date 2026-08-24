/**
 * Per-TARGET upstream credentials — data, not per-backend hardcoding.
 *
 * WHAT THIS REPLACES: the proxy used to forward whatever credential the client
 * sent, to whichever target it happened to reach. On a reroute down the
 * failover chain that meant the user's Anthropic credential was handed to a
 * completely different backend, blindly. "Local Ollama needs no credential"
 * happened to make that harmless today; hosted Ollama (ollama.com) will carry
 * one, and so will any second-tier Anthropic-native endpoint.
 *
 * So a target's credential is LOOKED UP, never inferred from the backend type.
 * Each entry says which upstream it covers and how to resolve that upstream's
 * credential at request time (never frozen at daemon start — a key set while
 * the daemon runs must take effect on the next request, the same discipline
 * src/agent/credentials.ts established for launches).
 *
 * A target with no entry gets NO credential: the placeholder is stripped and
 * nothing is put in its place. That is the correct, safe default for an
 * unmapped fallback — a fallback is by definition a *different* backend, and
 * shipping the human's Anthropic secret to it because it happens to speak the
 * Anthropic wire format is exactly the leak this module exists to close.
 */

/** How a resolved credential goes on the wire. */
export type CredentialPlacement =
  | {
      /**
       * Canonical: delete whatever header carried the placeholder and set this
       * one. Correct even when the target's credential kind differs from the
       * slot the placeholder arrived in (OAuth placeholder → API-key target).
       */
      kind: 'header';
      header: string;
      value: string;
    }
  | {
      /**
       * Substitute the placeholder substring wherever it appeared, preserving
       * the client's framing. For upstreams whose auth wire format lazy does
       * not authoritatively know (Cursor), reproducing the client's own shape
       * is strictly safer than guessing a canonical header.
       */
      kind: 'in-place';
      value: string;
    };

/** The outcome of asking "what credential does this target need?". */
export type TargetCredentialOutcome =
  /** Resolved — swap it in. */
  | { kind: 'credential'; placement: CredentialPlacement; label: string }
  /** Mapped, and this target deliberately needs none (e.g. local Ollama). */
  | { kind: 'none'; reason: string }
  /**
   * This target should have a credential and lazy cannot produce one. NEVER
   * degrade to forwarding the placeholder or the client's own value — the
   * per-user-token-billing mandate means a turn either bills the acting user's
   * own credential or refuses. The proxy answers 401 with `reason`.
   */
  | { kind: 'missing'; reason: string };

/** Resolves one upstream's credential, live, at request time. */
export type TargetCredentialResolver = () => Promise<TargetCredentialOutcome>;

interface TargetEntry {
  /** Upstream base URL this entry covers, compared by origin. */
  upstream: string;
  resolve: TargetCredentialResolver;
}

/** Compare upstreams by origin so a trailing slash or path never misses. */
function originOf(upstream: string): string {
  try {
    return new URL(upstream).origin.toLowerCase();
  } catch {
    // Not a URL (misconfiguration surfaced elsewhere) — fall back to the raw
    // string so lookup is still deterministic rather than throwing on the hot
    // path.
    return upstream.replace(/\/$/, '').toLowerCase();
  }
}

/**
 * The proxy's target → credential map.
 *
 * Built once at daemon start with one entry per configured upstream (primary,
 * each fallback, cursor). The RESOLVERS are live, so the map itself never holds
 * a secret.
 */
export class TargetCredentials {
  private readonly entries = new Map<string, TargetCredentialResolver>();

  constructor(entries: TargetEntry[] = []) {
    for (const entry of entries) this.set(entry.upstream, entry.resolve);
  }

  set(upstream: string, resolve: TargetCredentialResolver): void {
    this.entries.set(originOf(upstream), resolve);
  }

  /** Is this upstream mapped at all? Diagnostics and startup logging. */
  has(upstream: string): boolean {
    return this.entries.has(originOf(upstream));
  }

  /**
   * What credential does this target need right now?
   *
   * An unmapped target answers `none` — see the module comment: no entry means
   * no credential, deliberately, rather than "send whatever we have".
   */
  async forTarget(upstream: string): Promise<TargetCredentialOutcome> {
    const resolve = this.entries.get(originOf(upstream));
    if (!resolve) {
      return {
        kind: 'none',
        reason: `no credential is configured for ${upstream}`,
      };
    }
    return resolve();
  }
}

/**
 * Build the placement for an Anthropic-family credential from the env var it
 * was found in.
 *
 * The two forms are the two Claude Code itself uses: an OAuth token goes in
 * `Authorization: Bearer`, an API key in `x-api-key`. Deriving the form from
 * the env var name (rather than sniffing the value) keeps it a stated fact
 * about the credential rather than a guess about its bytes.
 */
export function anthropicPlacement(envKey: string, value: string): CredentialPlacement {
  if (envKey === 'ANTHROPIC_API_KEY') {
    return { kind: 'header', header: 'x-api-key', value };
  }
  // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN are bearer tokens.
  return { kind: 'header', header: 'authorization', value: `Bearer ${value}` };
}
