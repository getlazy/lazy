/** Stable account slots and destination requirements, shared by launch and RPC. */
import { DEFAULT_CURSOR_UPSTREAM } from '../proxy/upstream-defaults';
import { agentProfilesFor, selectableAgentProfiles, type AgentProfile, NO_CREDENTIAL, isAnthropicApiEndpoint, defaultCredentialFor } from '../config/agent-profiles';
import type { ResolvedConfig } from '../config/types';
import { credentialKinds, credentialLabel } from './providers';
import { memberCredentialGuidance } from './member-guidance';
import { isChatGptEndpoint } from '../utils/openai-compat';

export interface EndpointConsumer {
  profile: string;
  harness: string;
  tier: number | null;
  model: string;
}
export interface EndpointRequirement {
  endpointId: string;
  label: string;
  origin: string;
  /**
   * What a member's CONSENT must name for their secret to be sent here: the
   * origin plus the normalized path prefix ({@link normalizeEndpointScope}).
   * `origin` alone is not enough on a path-routed shared gateway, where one
   * host serves many operators' accounts by path.
   */
  scope: string;
  provider: string;
  credential: string;
  kinds: ('oauth' | 'api-key')[];
  session: boolean;
  credentialLabel?: string | null;
  howToGet?: string | null;
  consumers: EndpointConsumer[];
}

export function normalizeEndpointOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('An endpoint must be an HTTP(S) URL without embedded credentials.');
  }
  return url.origin;
}

/**
 * The consent scope of an endpoint URL: its origin plus its path, with
 * repeated and trailing slashes removed (`https://gw.example/v1/acct-a`).
 *
 * WHY THE PATH: a shared gateway can route by path — one host, a different
 * operator's account under each prefix (Cloudflare AI Gateway's
 * `/v1/<account>/…` is the shape that prompted this). Consent bound to the
 * origin alone let a key consented for one account's path be pushed to
 * another's on the same host. Dot segments are already resolved by URL
 * parsing, so `/a/../b` IS `/b` here, as it is on the wire.
 */
export function normalizeEndpointScope(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('An endpoint must be an HTTP(S) URL without embedded credentials.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length ? `${url.origin}/${segments.join('/')}` : url.origin;
}

/**
 * The consent scope lazy asks for and stores: origin + path, except on a
 * built-in provider's own origin, where it is the origin alone (one operator).
 */
export function consentScopeFor(value: string): string {
  const scope = normalizeEndpointScope(value);
  const origin = new URL(scope).origin;
  return FIRST_PARTY_ORIGINS.has(origin) ? origin : scope;
}

/** Legacy blank consent names an immutable provider default, never today's configured upstream. */
export function legacyDefaultEndpointOrigin(endpointId: string): string | undefined {
  const defaults: Record<string, string> = {
    'builtin:anthropic': 'https://api.anthropic.com',
    'builtin:cursor': DEFAULT_CURSOR_UPSTREAM,
    'builtin:openai': 'https://api.openai.com',
    'builtin:chatgpt': 'https://chatgpt.com',
  };
  return defaults[endpointId];
}

/**
 * The built-in providers' own API origins. Each is run by ONE operator — the
 * provider — whatever the path, so consent there stays origin-level. Lazy's
 * own fixed defaults, not a list of third-party gateways.
 */
const FIRST_PARTY_ORIGINS: ReadonlySet<string> = new Set([
  'https://api.anthropic.com', DEFAULT_CURSOR_UPSTREAM, 'https://api.openai.com', 'https://chatgpt.com',
].map(o => new URL(o).origin));

/**
 * Did this record's consent name the requirement's destination?
 *
 * On a built-in provider's own origin, the origin decides (one operator).
 * Everywhere else the consent must name exactly the requirement's SCOPE —
 * origin plus path. EXACT, not prefix, and that is the conservative migration:
 * consent stored before it carried a path names an origin only, and so covers
 * only a destination with no path, since nobody can say which path it was
 * given for. A member whose gateway endpoint has a path reconnects once.
 */
export function credentialConsentedToEndpoint(
  record: { endpoint?: string | null }, requirement: Pick<EndpointRequirement, 'endpointId' | 'origin' | 'scope'>,
): boolean {
  const consent = record.endpoint === '' ? legacyDefaultEndpointOrigin(requirement.endpointId) : record.endpoint;
  if (!consent) return false;
  let scope: string;
  try {
    scope = normalizeEndpointScope(consent);
  } catch {
    // Unparseable consent never authorizes a destination.
    return false;
  }
  if (FIRST_PARTY_ORIGINS.has(requirement.origin)) return new URL(scope).origin === requirement.origin;
  return scope === requirement.scope;
}

export function endpointIdentityForProfile(profile: AgentProfile): string {
  const defaultCredential = defaultCredentialFor(profile.harness, profile.wire, profile.endpoint);
  return profile.endpointName ?? (profile.endpointPinned || profile.credential !== defaultCredential ? `profile:${profile.name}` : `builtin:${profile.credential}`);
}

export function endpointRequirementsForProfile(profile: AgentProfile, config: ResolvedConfig): EndpointRequirement[] {
  const routes = profile.tiers?.map(t => ({ endpointId: t.endpoint, upstream: t.upstream, credential: t.credential, tier: t.index, model: t.model }))
    ?? [{ endpointId: endpointIdentityForProfile(profile), upstream: profile.harness === 'cursor' ? config.proxy.cursorUpstream ?? DEFAULT_CURSOR_UPSTREAM : profile.endpoint || config.proxy.upstream, credential: profile.credential, tier: null, model: profile.model }];
  return routes.map(route => {
    const session = route.credential !== NO_CREDENTIAL && (route.credential === 'chatgpt' || isChatGptEndpoint(route.upstream));
    // Provider is auth semantics, never inferred from the harness's wire format.
    const provider = session ? 'chatgpt' : route.credential;
    return {
      endpointId: route.endpointId,
      label: route.endpointId.startsWith('profile:') ? profile.name : route.endpointId.startsWith('builtin:') ? provider : route.endpointId,
      origin: normalizeEndpointOrigin(route.upstream), scope: consentScopeFor(route.upstream),
      provider, credential: route.credential,
      kinds: route.credential === NO_CREDENTIAL ? [] : session ? ['oauth'] : [...credentialKinds(route.credential)],
      session, consumers: [{ profile: profile.name, harness: profile.harness, tier: route.tier, model: route.model }],
      credentialLabel: route.credential === NO_CREDENTIAL ? null : credentialLabel(provider),
      howToGet: route.credential === NO_CREDENTIAL ? null : memberCredentialGuidance(provider, session),
    };
  });
}

export function endpointRequirements(config: ResolvedConfig): EndpointRequirement[] {
  const byId = new Map<string, EndpointRequirement>();
  for (const profile of selectableAgentProfiles(agentProfilesFor(config))) {
    for (const requirement of endpointRequirementsForProfile(profile, config)) {
      const existing = byId.get(requirement.endpointId);
      if (existing) {
        if (existing.scope !== requirement.scope || existing.provider !== requirement.provider || existing.session !== requirement.session) {
          throw new Error(`Endpoint '${requirement.endpointId}' has incompatible consumers; give those accounts separate endpoint names.`);
        }
        existing.consumers.push(...requirement.consumers);
      } else byId.set(requirement.endpointId, requirement);
    }
  }
  return [...byId.values()];
}

export function credentialCompatibleWithEndpoint(
  record: { kind: string; provider: string; session: boolean }, requirement: EndpointRequirement,
): boolean {
  if (record.provider === 'anthropic' && !isAnthropicApiEndpoint(requirement.origin)) return false;
  if (record.session && !isChatGptEndpoint(requirement.origin)) return false;
  return record.provider === requirement.provider && record.session === requirement.session && requirement.kinds.includes(record.kind as 'oauth' | 'api-key');
}
