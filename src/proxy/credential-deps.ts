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
import { resolveCredential } from '../credentials/store';
import { resolveChatGptSession, resolveChatGptSessionFrom } from '../credentials/chatgpt-session';
import { ChatGptRefreshTransientError } from '../credentials/chatgpt-tokens';
import { isCredentialEnvKey } from '../utils/redact';
import { lookupCredentialGrant, bindDerivedCredentials, type CredentialGrant } from './credential-broker';
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
import type { MemberCredentialResolution, ProxyCredentialDeps, ProxyMemberRoute } from './server';
import { resolveAgentUpstreams, type AgentUpstream } from './agent-upstreams';
import {
  NO_CREDENTIAL,
  type AgentProfile,
  type AgentWire,
  agentProfilesFor,
  profileNameForAgent,
  providerCredentialHostMismatch,
} from '../config/agent-profiles';
import { loadConfig } from '../config/loader';
import { providerCredentialHostAdvice } from '../config/agent-profile-advice';
import { isManagedMode } from '../config/managed-mode';
import { getTaskSessionBinding } from '../daemon/session-credentials';
import { memberBindingMaySpend } from '../daemon/member-recovery';
import {
  storeRenewedEndpointCredential,
  teamModeEnabled,
  type EndpointCredentialRecord,
} from '../daemon/user-credentials';
import {
  memberEndpointCredentialFor,
  spendingMember,
  principalPhrase,
  profileLabel,
  profileTakesChatGptSession,
} from '../daemon/member-credentials';
import { isChatGptEndpoint } from '../utils/openai-compat';
import { endpointRequirementsForProfile, type EndpointRequirement } from '../credentials/endpoint-requirements';
import { memberEndpointUsageKey } from './usage-limits';
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
        'no Anthropic credential is available to the daemon. Store one with ' +
        '`claude setup-token | lazy auth set anthropic` — the next turn loads it — or set ' +
        'CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY where the daemon starts and restart it',
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
    const key = await resolveCredential(projectRoot, 'cursor');
    if (!key) {
      return {
        kind: 'missing',
        reason:
          'no Cursor API key is available to the daemon. Set one with `lazy agent key set cursor`, ' +
          'or export CURSOR_API_KEY in the environment the daemon starts from.',
      };
    }
    return { kind: 'credential', placement: { kind: 'in-place', value: key.value }, label: 'CURSOR_API_KEY',
      sourceId: JSON.stringify([projectRoot, key.source, key.setName ?? null]) };
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
  provider: 'openai' | 'openrouter' | 'fireworks',
): () => Promise<TargetCredentialOutcome> {
  const remedy = provider === 'openai'
    ? 'Create one at https://platform.openai.com/api-keys and run `lazy auth set openai`, ' +
      'or export OPENAI_API_KEY in the environment the daemon starts from.'
    : provider === 'fireworks'
      ? 'Create one at https://app.fireworks.ai/settings/users/api-keys and run `lazy auth set fireworks`, ' +
        'or export FIREWORKS_API_KEY in the environment the daemon starts from.'
      : 'Create one at https://openrouter.ai/keys and run `lazy auth set openrouter`, ' +
        'or export OPENROUTER_API_KEY in the environment the daemon starts from.';
  const label = provider === 'openai' ? 'OpenAI' : provider === 'fireworks' ? 'Fireworks' : 'OpenRouter';
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
 * A refresh that failed for a reason unrelated to the session (timeout, network,
 * 5xx/429): not a refusal, and never a reason to tell anyone to reconnect.
 */
function transientRefreshFailure(err: ChatGptRefreshTransientError): TargetCredentialOutcome {
  return { kind: 'missing', transient: true, reason: `the ChatGPT credential could not be refreshed right now: ${err.message}` };
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
      if (err instanceof ChatGptRefreshTransientError) return transientRefreshFailure(err);
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
    case 'fireworks': return resolveOpenAICompat(projectRoot, 'fireworks');
    case NO_CREDENTIAL: return null;
    default: return wire ? resolveNamed(projectRoot, credential, wire) : null;
  }
}

/**
 * The answer for an endpoint that would be sent another provider's credential
 * the config never named for it: refuse, naming the fix. Never the credential.
 */
function providerHostRefusal(provider: string, entry: AgentUpstream): TargetCredentialResolver {
  return async () => ({
    kind: 'missing',
    reason:
      `lazy will not send the "${provider}" credential to ${entry.upstream}: that host is not ` +
      `${provider}'s, and lazy.toml did not name the credential for it. ` +
      providerCredentialHostAdvice(provider, { endpoint: entry.endpointName, profile: entry.profile }),
  });
}

/** The store-side answer for a managed project's pinned profile endpoint: none. */
function managedPinnedResolver(profile: string): TargetCredentialResolver {
  return async () => ({
    kind: 'missing',
    reason:
      `agent profile "${profile}" sends its traffic to an endpoint this project chose, and on a managed ` +
      `host that is paid only by the credential each member connects for the profile — never by the ` +
      `host's own. Connect yours for "${profile}".`,
  });
}

/**
 * Build the proxy's credential dependencies, and log the resulting map.
 *
 * The startup log lists every upstream and which credential it will receive,
 * because "which of my keys can this fallback see?" must be answerable without
 * reading source (AGENTS.md: transparent over terse). No secret is logged —
 * only which credential SLOT each target maps to.
 */
export function buildProxyCredentialDeps(
  projectRoot: string,
  config: ResolvedConfig,
  perMember: boolean = isManagedMode(),
): ProxyCredentialDeps {
  const { targets, lines } = buildTargetCredentials(projectRoot, config, perMember);

  logger.info(`[proxy] credential map: ${lines.join(', ')}`);

  return {
    lookup: (token: string) => lookupCredentialGrant(projectRoot, token),
    bindDerived: (grantToken, pairs) => bindDerivedCredentials(projectRoot, grantToken, pairs),
    targets,
    member: (grant, expectedOrigin, route) => resolveMemberCredential(projectRoot, grant, expectedOrigin, route),
    memberUsage: async (grant, endpoint) => {
      const payer = await resolveMemberSpender(projectRoot, grant);
      return payer ? { key: payer.member ? memberEndpointUsageKey(payer.member, endpoint) : null } : null;
    },
  };
}

/**
 * TEAM MODE: the credential a verified task caller's traffic is paid with — the
 * turn principal's OWN credential for the grant's profile — or null when this
 * is not a team-mode task caller, and the per-upstream map decides as it
 * always has.
 *
 * The principal is the owner of the task's LIVE session binding, which the
 * launch re-points at every turn (src/daemon/turn-credentials.ts); the profile
 * comes off the grant, which lazy minted for the launch, so neither is a claim
 * the client makes. The project's credential store is never consulted here:
 * per-user billing means a turn either spends its own principal's credential or
 * is refused — no fallback to a shared key, or to anybody else's.
 */
/** No member-mode grant can fall back to daemon credentials, including a builder with no binding. */
async function resolveMemberSpender(projectRoot: string, grant: CredentialGrant): Promise<{ member: string | null; bound: boolean; reason?: string } | null> {
  if (!(await teamModeEnabled(projectRoot))) return null;
  const bindingKey = grant.role === 'agent' ? grant.taskUuid : grant.bindingKey;
  const found = bindingKey ? await getTaskSessionBinding(projectRoot, bindingKey) : null;
  if (!found || found.revokedAt !== null || !memberBindingMaySpend(projectRoot, found.taskId)) return { member: null, bound: false, reason: 'this launch has no active member credential binding; resume it before spending' };
  const member = await spendingMember(projectRoot, found.ownerUserId);
  return { member, bound: true, ...(member ? {} : { reason: 'no service credential holder is configured' }) };
}

export async function resolveMemberCredential(
  projectRoot: string,
  grant: CredentialGrant,
  _expectedOrigin?: string,
  route?: ProxyMemberRoute,
): Promise<MemberCredentialResolution | null> {
  const payer = await resolveMemberSpender(projectRoot, grant);
  if (!payer) return null;
  const missing = (reason: string): MemberCredentialResolution => ({ userId: payer.member, outcome: { kind: 'missing', reason } });
  if (!payer.bound) return missing(payer.reason!);
  const config = route?.config ?? await loadConfig(projectRoot);
  const profileName = profileNameForAgent(grant.profile);
  const profile = agentProfilesFor(config).get(profileName);
  if (!profile) return missing(`agent profile "${profileName}" no longer exists in this project`);
  const requirements = endpointRequirementsForProfile(profile, config);
  const requirement = route?.tier === undefined ? requirements[0] : requirements.find(r =>
    r.endpointId === route.endpoint && r.consumers.some(c => c.profile === profile.name && c.tier === route.tier));
  if (!requirement) return missing('the selected endpoint does not belong to this launch’s profile in the effective configuration');
  if (requirement.credential === NO_CREDENTIAL) return { userId: payer.member, endpoint: requirement.endpointId, outcome: { kind: 'none', reason: `endpoint "${requirement.endpointId}" takes no credential` } };
  if (!payer.member) return missing(payer.reason!);
  const upstream = route?.upstream ?? (_expectedOrigin || requirement.origin);
  const selectedTier = route?.tier === undefined ? undefined : profile.tiers?.find(t => t.index === route.tier);
  const credentialExplicit = selectedTier ? selectedTier.credentialExplicit : profile.credentialExplicit;
  const mismatch = credentialExplicit ? null : providerCredentialHostMismatch(requirement.credential, upstream);
  if (mismatch) return missing(`Provider credential "${mismatch}" cannot be sent to ${upstream} without an explicit endpoint credential setting`);
  const answer = await memberEndpointCredentialFor(projectRoot, payer.member, requirement, upstream);
  if (answer.kind === 'none-needed') return { userId: payer.member, endpoint: requirement.endpointId, outcome: { kind: 'none', reason: `endpoint "${requirement.endpointId}" takes no credential` } };
  if (answer.kind === 'missing') return missing(`${principalPhrase(payer.member)} cannot pay for endpoint "${answer.endpoint}" on agent profile ${profileLabel(profile)}: ${answer.detail}`);
  const selected = route?.tier === undefined ? profile : { ...profile, endpoint: upstream, credential: requirement.credential, wire: profile.tiers!.find(t => t.index === route.tier)!.wire, tiers: undefined };
  return {
    userId: answer.member,
    endpoint: requirement.endpointId,
    // Legacy auth verdicts distinguish the builtin Claude connection from
    // endpoint accounts, so a gateway 401 never asks to repair builtin Claude.
    profile: requirement.endpointId === 'builtin:anthropic' ? null : profile.name,
    outcome: await memberPlacement(projectRoot, answer.member, { ...selected, endpoint: upstream }, answer.record, requirement),
  };
}

/**
 * Where a member's credential goes on the wire — the SAME placements the
 * store resolvers above produce for the same credential, so a team-mode
 * request looks exactly like a single-user one to the upstream.
 */
async function memberPlacement(
  projectRoot: string,
  principal: string,
  profile: AgentProfile,
  record: EndpointCredentialRecord,
  requirement: EndpointRequirement,
): Promise<TargetCredentialOutcome> {
  const label = `${principal} (endpoint ${record.endpointId})`;
  // Renewed and written back as the record's OWN owner: the service slot of a
  // session profile answers with its holder's record, and the two uses must
  // share that record's one renewal chain.
  const owner = record.userId;
  if (profileTakesChatGptSession(profile)) {
    let session: Awaited<ReturnType<typeof resolveChatGptSessionFrom>>;
    try {
      session = await resolveChatGptSessionFrom({
        projectRoot,
        key: JSON.stringify([projectRoot, 'member', owner, record.endpointId]),
        read: async () => {
          // A queued renewal reads live. Re-check that live record against this
          // request's selected route before it can replace the checked secret.
          const current = await memberEndpointCredentialFor(projectRoot, owner, requirement, profile.endpoint);
          if (current.kind === 'missing') throw new Error(current.detail);
          return current.kind === 'credential' ? { value: current.record.token, source: 'store', envVar: '' } : null;
        },
        describe: () => `the ChatGPT subscription ${owner} connected for agent profile "${record.endpointId}"`,
        persist: async (secret, renewedFrom) => {
          const stored = await storeRenewedEndpointCredential(projectRoot, owner, record.endpointId, secret, renewedFrom);
          if (!stored) {
            throw new Error('The connected ChatGPT credential was replaced or removed while renewing. The newer connection was preserved.');
          }
        },
        label: `${owner}, profile ${record.endpointId}`,
      });
    } catch (err) {
      if (err instanceof ChatGptRefreshTransientError) return transientRefreshFailure(err);
      return {
        kind: 'missing',
        reason:
          `the ChatGPT subscription ${owner} connected for agent profile "${record.endpointId}" could not be ` +
          `used: ${err instanceof Error ? err.message : String(err)}. Connect it again from a fresh \`codex login\`.`,
      };
    }
    if (!session) return { kind: 'missing', reason: `${owner}'s ChatGPT subscription for "${record.endpointId}" is gone` };
    return {
      kind: 'credential',
      placement: chatGptPlacement(session.tokens.accessToken, session.tokens.accountId),
      label,
    };
  }
  switch (profile.credential) {
    case 'cursor':
      return { kind: 'credential', placement: { kind: 'in-place', value: record.token }, label,
        sourceId: JSON.stringify([projectRoot, 'member', owner, record.endpointId]) };
    case 'ollama':
      return { kind: 'credential', placement: ollamaPlacement(record.token), label };
    case 'openai':
    case 'openrouter':
    case 'fireworks':
      return { kind: 'credential', placement: bearerPlacement(record.token), label };
    case 'anthropic':
      return { kind: 'credential', placement: anthropicPlacementForKind(record.kind, record.token), label };
    default:
      return {
        kind: 'credential',
        placement: profile.wire === 'openai'
          ? bearerPlacement(record.token)
          : anthropicPlacementForKind(record.kind, record.token),
        label,
      };
  }
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
  perMember: boolean = isManagedMode(),
): { targets: TargetCredentials; lines: string[] } {
  const targets = new TargetCredentials();
  // Managed grants always resolve the bound member's endpoint slot. An origin
  // map cannot represent two independent accounts on the same provider host.
  if (perMember) return { targets, lines: ['member endpoint credentials only'] };

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
    // that is rejected, so this fails loud (AGENTS.md: errors are actionable).
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
  const pinnedProfiles = new Set(
    [...agentProfilesFor(config).values()].filter((p) => p.endpointPinned).map((p) => p.name),
  );
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
    claimed.set(origin, slot);
    // BACKSTOP: a provider's credential reaches only that provider's own hosts,
    // unless lazy.toml named it for this endpoint. The config loader already
    // refuses an endpoint that names no credential, and only built-ins (whose
    // hosts are their providers') are inferred — so this is the second,
    // independent line: if a future default, built-in or migration ever pairs
    // a provider's secret with another host, the request is refused here
    // rather than the secret sent to a stranger.
    const mismatch = entry.credentialExplicit ? null : providerCredentialHostMismatch(slot, entry.upstream);
    if (mismatch) {
      targets.set(entry.upstream, providerHostRefusal(mismatch, entry));
      lines.push(`${entry.upstream} → refused: "${mismatch}" is not this host's credential (agent: ${entry.profile})`);
      continue;
    }
    const storeResolver = resolverForSlot(projectRoot, slot, entry.wire, entry.upstream);
    // MANAGED: an endpoint the PROJECT pinned (its config, not lazy's built-in
    // default) is paid only by the credential each member connects for that
    // profile (resolveMemberCredential), never by the host's own store or
    // environment — which is what lets a managed project pin one at all
    // (src/config/managed.ts, `agents.*.endpoint`).
    const profileResolver = storeResolver && isManagedMode() && pinnedProfiles.has(entry.profile)
      ? managedPinnedResolver(entry.profile)
      : storeResolver;
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
