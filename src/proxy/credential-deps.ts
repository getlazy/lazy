/**
 * Assemble the proxy's credential dependencies for a running daemon.
 *
 * One place that answers "which real credential does each upstream get?", so
 * the daemon's start path stays a single call and the mapping itself is
 * reviewable in isolation. Everything here resolves LIVE, per request: a
 * credential set (or revoked) while the daemon runs takes effect on the next
 * request without a restart, the same discipline src/agent/credentials.ts
 * established for launches.
 *
 * Note what is NOT here: any notion of "if the target speaks Anthropic, send
 * the Anthropic key". Each upstream is mapped explicitly or it gets nothing.
 */

import type { ResolvedConfig } from '../config/types';
import { getAuthEnvVars } from '../capture/claude';
import { resolveAgentApiKey } from '../agent/credentials';
import { resolveCredential } from '../credentials/store';
import { resolveChatGptSession } from '../credentials/chatgpt-session';
import { isCredentialEnvKey } from '../utils/redact';
import { lookupCredentialGrant } from './credential-broker';
import {
  TargetCredentials,
  anthropicPlacement,
  anthropicPlacementForKind,
  bearerPlacement,
  chatGptPlacement,
  ollamaPlacement,
  originOf,
  type TargetCredentialOutcome,
  type TargetCredentialResolver,
} from './target-credentials';
import type { ProxyCredentialDeps } from './server';
import { resolveAgentUpstreams } from './agent-upstreams';
import { NO_CREDENTIAL, type AgentWire } from '../config/agent-profiles';
import { isChatGptEndpoint } from '../utils/openai-compat';
import { namedCredentialEnvVar } from '../credentials/providers';
import { logger } from '../utils/logger';

/**
 * The user's own Anthropic credential, in the header form it belongs in.
 *
 * PER-USER-TOKEN BILLING: this reads the credential of whoever runs the daemon
 * — the acting user — and there is no second source to fall back to. A missing
 * or unreadable credential resolves to `missing`, which the proxy turns into a
 * 401 naming the remedy. It never degrades to "some other credential".
 */
async function resolveAnthropic(): Promise<TargetCredentialOutcome> {
  let vars: Array<{ key: string; value: string }>;
  try {
    vars = getAuthEnvVars();
  } catch (err) {
    return {
      kind: 'missing',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const cred = vars.find(v => isCredentialEnvKey(v.key) && v.value);
  if (!cred) {
    return {
      kind: 'missing',
      reason:
        'no Anthropic credential is available to the daemon. Run `claude setup-token` (or set ' +
        'ANTHROPIC_API_KEY) in the environment the daemon starts from, then: lazy daemon restart',
    };
  }
  return {
    kind: 'credential',
    placement: anthropicPlacement(cred.key, cred.value),
    label: cred.key,
  };
}

/**
 * The user's Cursor API key.
 *
 * Placement is `in-place`: cursor-agent's auth wire format is not something
 * lazy has a contract for, so the credential goes exactly where the client put
 * its placeholder — header or body — instead of a header lazy guessed at.
 */
function resolveCursor(projectRoot: string): () => Promise<TargetCredentialOutcome> {
  return async () => {
    const key = await resolveAgentApiKey(projectRoot, 'cursor');
    if (!key) {
      return {
        kind: 'missing',
        reason:
          'no Cursor API key is available to the daemon. Set one with `lazy agent key set cursor`, ' +
          'or export CURSOR_API_KEY in the environment the daemon starts from.',
      };
    }
    return { kind: 'credential', placement: { kind: 'in-place', value: key.value }, label: 'CURSOR_API_KEY' };
  };
}

function resolveOllama(projectRoot: string): () => Promise<TargetCredentialOutcome> {
  return async () => {
    const cred = await resolveCredential(projectRoot, 'ollama');
    if (!cred) {
      return {
        kind: 'missing',
        reason:
          'no Ollama API key is available to the daemon. Create one at https://ollama.com and run ' +
          '`lazy auth set ollama`, or export OLLAMA_API_KEY in the environment the daemon starts from.',
      };
    }
    return {
      kind: 'credential',
      placement: ollamaPlacement(cred.value),
      label: cred.envVar,
    };
  };
}

/**
 * The user's OpenAI or OpenRouter API key, as `Authorization: Bearer`.
 *
 * One resolver for both because they differ only in which store entry is read
 * and which console/env var the remedy names — the wire placement is identical,
 * for the OpenAI wire (documented) and for OpenRouter's Anthropic-compatible
 * Messages endpoint (verified: it authenticates with Bearer too).
 */
function resolveOpenAICompat(
  projectRoot: string,
  provider: 'openai' | 'openrouter',
): () => Promise<TargetCredentialOutcome> {
  const remedy = provider === 'openai'
    ? 'Create one at https://platform.openai.com/api-keys and run `lazy auth set openai`, ' +
      'or export OPENAI_API_KEY in the environment the daemon starts from.'
    : 'Create one at https://openrouter.ai/keys and run `lazy auth set openrouter`, ' +
      'or export OPENROUTER_API_KEY in the environment the daemon starts from.';
  const label = provider === 'openai' ? 'OpenAI' : 'OpenRouter';
  return async () => {
    const cred = await resolveCredential(projectRoot, provider);
    if (!cred) {
      return {
        kind: 'missing',
        reason: `no ${label} API key is available to the daemon. ${remedy}`,
      };
    }
    return {
      kind: 'credential',
      placement: bearerPlacement(cred.value),
      label: cred.envVar,
    };
  };
}

/**
 * The user's ChatGPT SUBSCRIPTION session, refreshed on the way out.
 *
 * Unlike every other resolver here, this one can MUTATE the store: a ChatGPT
 * access token lives hours, so presenting one means renewing it, and renewing
 * rotates the refresh token. That work is deliberately not inlined — it belongs
 * with the credential (src/credentials/chatgpt-session.ts), which serializes
 * concurrent refreshes and writes the rotated token back before handing it out.
 *
 * A refresh FAILURE resolves to `missing`, which the proxy answers with a 401
 * carrying this reason, rather than presenting a token known to be dead: the
 * per-user-token-billing mandate says a turn either bills the acting user's own
 * credential or refuses.
 */
function resolveChatGpt(
  projectRoot: string,
  name: string,
): () => Promise<TargetCredentialOutcome> {
  return async () => {
    let session: Awaited<ReturnType<typeof resolveChatGptSession>>;
    try {
      session = await resolveChatGptSession(projectRoot, name);
    } catch (err) {
      // FOUND BUT BROKEN, kept distinct from absent below: a revoked or
      // malformed session must not tell the user to go and set one up.
      //
      // ...but it must still say what to DO. A stored session that will not
      // parse is a CORRUPT one — a truncated write is the way that happens —
      // and quoting only the JSON error left a real user reading
      // "Unterminated string" off a 401 with no idea that re-importing fixes
      // it. Re-import is the remedy for every shape of broken here: it
      // overwrites whatever is in the store, intact or not.
      return {
        kind: 'missing',
        reason:
          `the stored ChatGPT subscription credential could not be used: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          `Re-import the session to replace it: \`codex login\` then ` +
          `\`lazy auth import ${name}\`.`,
      };
    }
    if (!session) {
      return {
        kind: 'missing',
        reason:
          `no ChatGPT subscription credential is available to the daemon. Run \`codex login\` ` +
          `(or \`codex login --device-auth\` on a headless host) on this machine, then ` +
          `\`lazy auth import ${name}\`.`,
      };
    }
    return {
      kind: 'credential',
      placement: chatGptPlacement(session.tokens.accessToken, session.tokens.accountId),
      label: 'ChatGPT subscription',
    };
  };
}

/**
 * A NAMED credential — one lazy knows nothing about but the name a profile gave
 * it and the secret the user stored under it.
 *
 * Placement is derived from the profile's WIRE and the credential's stored
 * KIND, which is everything there is to derive it from: an OpenAI-wire upstream
 * takes `Authorization: Bearer`, an Anthropic-wire one takes `x-api-key` for an
 * API key and `Authorization: Bearer` for an OAuth token — the same two forms
 * the provider resolvers above produce, reached through the same helper so they
 * cannot drift. Cursor is not reachable here: a profile on that harness may not
 * name a credential outside the provider vocabulary (see
 * src/config/agent-profiles.ts), precisely because its placement is `in-place`
 * and there is nothing to derive.
 */
function resolveNamed(
  projectRoot: string,
  name: string,
  wire: AgentWire,
): () => Promise<TargetCredentialOutcome> {
  return async () => {
    const cred = await resolveCredential(projectRoot, name);
    if (!cred) {
      return {
        kind: 'missing',
        reason:
          `no credential named "${name}" is available to the daemon. Store one with ` +
          `\`lazy auth set ${name}\`, or export ${namedCredentialEnvVar(name, 'api-key')} in the ` +
          `environment the daemon starts from.`,
      };
    }
    return {
      kind: 'credential',
      placement: wire === 'openai'
        ? bearerPlacement(cred.value)
        : anthropicPlacementForKind(cred.kind, cred.value),
      label: cred.envVar,
    };
  };
}

/**
 * The live resolver for a declared credential slot, or null for `none`.
 *
 * One table so the fallback chain and the agent profiles cannot drift apart on
 * which slots exist. The switch stays exhaustive over `Provider` — a new
 * provider is a compile error here rather than a silent 401 — and anything that
 * is not a provider is a NAMED credential, which needs `wire` to know where on
 * the wire to put it. A caller with no wire to offer (the fallback chain, whose
 * `credential` key is provider-only) gets `null` rather than a guessed header.
 */
function resolverForSlot(
  projectRoot: string,
  credential: string,
  wire?: AgentWire,
  endpoint?: string,
): TargetCredentialResolver | null {
  // THE ENDPOINT OVERRULES THE NAME for the ChatGPT backend, and only there:
  // that host accepts nothing but a subscription session, so a credential stored
  // under a name of the user's own (`credential = "personal-chatgpt"`) is a
  // ChatGPT session whatever it is called. Without this it would fall through to
  // the named-credential resolver and be bearered upstream as the raw JSON blob
  // it is stored as — a 401 whose cause is invisible from either end.
  if (endpoint && credential !== NO_CREDENTIAL && isChatGptEndpoint(endpoint)) {
    return resolveChatGpt(projectRoot, credential);
  }
  switch (credential) {
    case 'anthropic': return resolveAnthropic;
    case 'chatgpt': return resolveChatGpt(projectRoot, credential);
    case 'cursor': return resolveCursor(projectRoot);
    case 'ollama': return resolveOllama(projectRoot);
    case 'openai': return resolveOpenAICompat(projectRoot, 'openai');
    case 'openrouter': return resolveOpenAICompat(projectRoot, 'openrouter');
    case NO_CREDENTIAL: return null;
    default: return wire ? resolveNamed(projectRoot, credential, wire) : null;
  }
}

/**
 * Build the proxy's credential dependencies, and log the resulting map.
 *
 * The startup log lists every upstream and which credential it will receive,
 * because "which of my keys can this fallback see?" must be answerable without
 * reading source (CLAUDE.md: transparent over terse). No secret is logged —
 * only which credential SLOT each target maps to.
 */
export function buildProxyCredentialDeps(
  projectRoot: string,
  config: ResolvedConfig,
): ProxyCredentialDeps {
  const { targets, lines } = buildTargetCredentials(projectRoot, config);

  logger.info(`[proxy] credential map: ${lines.join(', ')}`);

  return {
    lookup: (token: string) => lookupCredentialGrant(projectRoot, token),
    targets,
  };
}

/**
 * The upstream → credential map itself, with the human-readable lines the
 * proxy logs at startup. Split out so a caller that must predict which
 * credential a turn will spend (usage pausing, src/daemon/usage-pause.ts)
 * answers from the SAME map the proxy forwards with, rather than a copy.
 * Throws on the same misconfigurations the proxy refuses to start with.
 */
export function buildTargetCredentials(
  projectRoot: string,
  config: ResolvedConfig,
): { targets: TargetCredentials; lines: string[] } {
  const targets = new TargetCredentials();

  targets.set(config.proxy.upstream, resolveAnthropic);
  targets.set(config.proxy.cursorUpstream, resolveCursor(projectRoot));

  const lines: string[] = [
    `${config.proxy.upstream} → anthropic`,
    `${config.proxy.cursorUpstream} → cursor`,
  ];
  // Which credential each ORIGIN has been promised, so the profile block below
  // can tell "already mapped" apart from "already mapped to something else".
  // `targets` alone cannot answer that — it stores resolvers, not slot names.
  const claimed = new Map<string, string>([
    [originOf(config.proxy.upstream), 'anthropic'],
    [originOf(config.proxy.cursorUpstream), 'cursor'],
  ]);
  for (const fb of config.proxy.fallbacks) {
    // ORIGIN COLLISION: the map is keyed by ORIGIN, so a fallback that shares an
    // origin with an already-mapped target does not get "no credential" — it
    // silently inherits that target's. Left unchecked, a fallback written as
    // `credential = "none"` would receive the user's Anthropic token while the
    // startup line below truthfully-but-uselessly printed "→ none". A config
    // that reads as one thing and behaves as another is worse than a config
    // that is rejected, so this fails loud (CLAUDE.md: errors are actionable).
    const fbResolver = resolverForSlot(projectRoot, fb.credential);
    if (fbResolver === null && targets.has(fb.upstream)) {
      throw new Error(
        `[[proxy.fallback]] upstream "${fb.upstream}" has credential = "${fb.credential ?? 'none'}", ` +
        `but it shares an origin with an upstream that is already mapped to a credential, so it ` +
        `would receive that credential anyway. lazy refuses to start with a proxy credential map ` +
        `that does not mean what it says.\n\n` +
        `What to do:\n` +
        `  - If this fallback SHOULD get that credential, say so: credential = "anthropic", ` +
        `"ollama", "openai" or "openrouter"\n` +
        `  - If it should not, give it a distinct origin (host or port) from proxy.upstream ` +
        `and proxy.cursor_upstream`,
      );
    }
    if (fbResolver) {
      targets.set(fb.upstream, fbResolver);
      claimed.set(originOf(fb.upstream), fb.credential);
      lines.push(`${fb.upstream} → ${fb.credential} (fallback)`);
    } else {
      // Left unmapped on purpose: TargetCredentials answers `none` for an
      // unmapped upstream, so the placeholder is stripped and nothing replaces
      // it. Mapping it to an explicit "none" resolver would read the same and
      // say less. Still CLAIMED, so a later profile cannot quietly attach a real
      // credential to an origin this config said gets none.
      claimed.set(originOf(fb.upstream), NO_CREDENTIAL);
      lines.push(`${fb.upstream} → none (fallback)`);
    }
  }
  // PROFILE UPSTREAMS: a profile's `endpoint` is where the proxy forwards that
  // profile's traffic, so it is a target like any other and needs an explicit
  // credential — an ollama server gets none (it ignores auth, and shipping the
  // user's token to a local process leaks it), a pinned Anthropic-native
  // endpoint gets the real credential, which is what it received back when the
  // agent dialed it directly. This is also what replaces the removed codex
  // default route: the built-in `codex` profile resolves to api.openai.com with
  // the `openai` credential, so a zero-config codex turn is mapped here by the
  // same rule as every other profile rather than by a special case.
  //
  // ORIGIN COLLISION, one rule covering both directions: a profile declaring NO
  // credential on an origin that already has one would silently inherit it, and
  // a profile naming a DIFFERENT credential from the one that origin already
  // carries would be billed to the other key — the cross-credential leak the
  // per-target model exists to close, and worse than the `none` case because it
  // spends a real secret. An origin already claimed by the SAME credential is
  // fine: that is "two profiles on the same provider share one key".
  for (const entry of resolveAgentUpstreams(config)) {
    const slot = entry.credential ?? NO_CREDENTIAL;
    const origin = originOf(entry.upstream);
    const existing = claimed.get(origin);
    if (existing !== undefined && existing !== slot) {
      throw new Error(
        `[agents.${entry.profile}] endpoint "${entry.upstream}" resolves to credential = "${slot}", ` +
        `but that origin is already mapped to the "${existing}" credential, and the proxy's ` +
        `credential map is keyed by origin — so this profile would be billed to "${existing}" ` +
        `instead. lazy refuses to start with a proxy credential map that does not mean what it ` +
        `says.\n\n` +
        `What to do:\n` +
        `  - If this profile SHOULD use that key, say so: credential = "${existing}"\n` +
        `  - Otherwise give it a distinct origin (host or port) from proxy.upstream, ` +
        `proxy.cursor_upstream, any [[proxy.fallback]], and the other profiles`,
      );
    }
    const profileResolver = resolverForSlot(projectRoot, slot, entry.wire, entry.upstream);
    claimed.set(origin, slot);
    if (profileResolver) {
      targets.set(entry.upstream, profileResolver);
      lines.push(`${entry.upstream} → ${slot} (agent: ${entry.profile})`);
    } else {
      // Left unmapped on purpose — TargetCredentials answers `none` for an
      // unmapped upstream, so the placeholder is stripped and nothing replaces it.
      lines.push(`${entry.upstream} → none (agent: ${entry.profile})`);
    }
  }

  return { targets, lines };
}
