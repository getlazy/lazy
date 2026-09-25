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
      /**
       * A beta flag the credential's FORM requires, merged into the request's
       * `anthropic-beta` list (never replacing what the client already sent).
       *
       * An Anthropic OAuth token is a bearer PLUS `oauth-2025-04-20`; the two
       * halves are one credential form, not a header and an option. Claude Code
       * sends the flag itself, so this changed nothing for it — but pi does not,
       * and cannot: the container is handed a placeholder and never learns
       * whether the real credential behind it is an OAuth token or an API key.
       * Without the flag the request authenticates all the same, and what came
       * back on real pi turns was `400 "You're out of extra usage"` and then
       * `429`, while Claude Code turns through the same proxy and credential
       * answered 200 in the same seconds (proxy audit log, 2026-09-13). That the
       * missing flag is WHY is inference from that pairing plus lazy's own OAuth
       * calls — not something re-run after this change, since the daemon runs the
       * installed binary. Confirming it needs a pi turn on a build carrying this.
       *
       * Deciding it HERE is what keeps the rule in one place: lazy already sent
       * this pair from its own OAuth calls (src/utils/token-count.ts,
       * src/daemon/credential-check.ts), whose comments called it "the mapping
       * the proxy already encodes" — it encoded only the bearer half.
       */
      requiredBeta?: string;
      /**
       * Further headers the credential's own form requires, SET alongside it.
       *
       * A credential that identifies an account as well as authenticating it
       * needs both halves to travel together: the ChatGPT subscription token is
       * a bearer PLUS `chatgpt-account-id`, which is what the codex CLI sends
       * when it holds the real session. The container holds only a placeholder
       * and so cannot know the account — putting it here keeps the pair
       * indivisible and keeps the account id out of the container entirely.
       *
       * `null` means "the host has no value for this" and DELETES the header
       * rather than leaving the client's. The proxy forwards every client header
       * through, so an entry that is merely absent is an opening: the container
       * would get to name the account its turn is billed to, alongside the user's
       * real credential. A header in this map is the host's to decide, present or
       * not.
       *
       * Distinct from {@link requiredBeta}, which MERGES into a list the client
       * also contributes to; these are set or deleted outright (see
       * applyCredential).
       */
      companionHeaders?: Record<string, string | null>;
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

/**
 * Compare upstreams by origin so a trailing slash or path never misses.
 *
 * Exported because the KEY of this map is a hazard callers have to reason about:
 * two upstreams sharing an origin share one entry, so whoever assembles the map
 * needs the same notion of sameness to detect a collision before it becomes a
 * silent credential inheritance (see buildProxyCredentialDeps).
 */
export function originOf(upstream: string): string {
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
  // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN are bearer tokens.
  return anthropicPlacementForKind(envKey === 'ANTHROPIC_API_KEY' ? 'api-key' : 'oauth', value);
}

/**
 * The same two Anthropic forms, chosen by the credential's stored KIND.
 *
 * The entry point for a NAMED credential (`credential = "work-anthropic"`),
 * whose env var is `LAZY_CREDENTIAL_*` and so says nothing about its form. One
 * rule, two ways in: {@link anthropicPlacement} maps a provider's env var onto a
 * kind and lands here, so a named credential and a provider credential of the
 * same kind can never end up in different headers.
 */
export function anthropicPlacementForKind(
  kind: 'api-key' | 'oauth',
  value: string,
): CredentialPlacement {
  if (kind === 'api-key') return { kind: 'header', header: 'x-api-key', value };
  return {
    kind: 'header',
    header: 'authorization',
    value: `Bearer ${value}`,
    // The other half of the OAuth form — see `requiredBeta` above. Never set
    // for an api-key: the flag describes the credential, not the endpoint.
    requiredBeta: ANTHROPIC_OAUTH_BETA,
  };
}

/**
 * The beta flag an Anthropic OAuth (subscription) token is presented with.
 *
 * The one spelling, shared with lazy's own direct OAuth calls so a change lands
 * in every place at once.
 */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/** Ollama Cloud API keys are sent as `Authorization: Bearer`. */
export function ollamaPlacement(value: string): CredentialPlacement {
  return { kind: 'header', header: 'authorization', value: `Bearer ${value}` };
}

/**
 * OpenAI and OpenRouter API keys are sent as `Authorization: Bearer` — for
 * OpenAI-wire calls (documented) and for OpenRouter's Anthropic-compatible
 * Messages endpoint alike (verified 2026-09-02: it wants Bearer, and answers
 * "Missing Authentication header" to a bare `x-api-key`).
 */
export function bearerPlacement(value: string): CredentialPlacement {
  return { kind: 'header', header: 'authorization', value: `Bearer ${value}` };
}

/** Header the ChatGPT backend attributes a subscription request to. */
export const CHATGPT_ACCOUNT_HEADER = 'chatgpt-account-id';

/**
 * A ChatGPT SUBSCRIPTION token: `Authorization: Bearer` plus the account header.
 *
 * Both halves are what the codex CLI itself sends when it holds a real ChatGPT
 * session — captured off codex-cli 0.152.1 against a local server
 * (docs/codex-chatgpt-subscription.md). lazy deliberately keeps the account id
 * out of the task container (it is also what makes the CLI try to refresh, and
 * rotate, the host's token), so the proxy supplies it here.
 */
export function chatGptPlacement(accessToken: string, accountId: string | null): CredentialPlacement {
  return {
    kind: 'header',
    header: 'authorization',
    value: `Bearer ${accessToken}`,
    // UNCONDITIONAL, including when the host has no account id: `null` deletes
    // the header (see applyCredential). Omitting the entry instead would leave
    // whatever the container sent, so an agent could pair the user's real bearer
    // with an account of its own choosing — the attribution is the host's answer
    // or it is nothing.
    companionHeaders: { [CHATGPT_ACCOUNT_HEADER]: accountId },
  };
}
