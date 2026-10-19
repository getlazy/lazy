/** Member endpoint spending: consent, provider compatibility and the actual payer. */
import { loadConfig } from '../config/loader';
import type { ResolvedConfig } from '../config/types';
import { type AgentProfile, NO_CREDENTIAL, isAnthropicApiEndpoint, profileForAgentNameOrNull } from '../config/agent-profiles';
import { credentialLabel } from '../credentials/providers';
import { isChatGptEndpoint } from '../utils/openai-compat';
import { credentialCompatibleWithEndpoint, credentialConsentedToEndpoint, endpointRequirementsForProfile, normalizeEndpointOrigin, type EndpointRequirement } from '../credentials/endpoint-requirements';
import { serviceTurnReason } from './launch-origin';
import { getEndpointCredential, getServiceHolder, getServiceHolderState, SERVICE_CREDENTIAL_USER_ID, type EndpointCredentialRecord } from './user-credentials';

/**
 * Why the service holder resolved to nobody. The daemon learns the holder only
 * from the service records Teams delivers, so it cannot tell "none designated"
 * from "designated, but nothing was delivered" — it names both, and Teams,
 * which can tell, says which (lazy-teams ServiceCredentialDiagnosis).
 */
export const NO_SERVICE_HOLDER_DELIVERED_REASON =
  "no service holder has been delivered to this project's daemon — either no admin has designated one in the project's Settings, or Teams could not deliver the holder's connections";
export const SERVICE_HOLDER_CONFLICTED_REASON =
  'the service connections delivered to this daemon name different holders; an admin designates one service holder again in Settings';

/** Legacy markers stay exported for callers adapting older daemons. */
export const NO_OWNER_PROFILE_CREDENTIAL_MARKER = 'No credential of yours for agent profile';
export const NO_OWNER_ENDPOINT_CREDENTIAL_MARKER = 'No credential of yours for endpoint';

export type MemberCredentialAnswer =
  | { kind: 'none-needed' }
  | { kind: 'credential'; record: EndpointCredentialRecord; via: 'endpoint'; member: string; requirement: EndpointRequirement }
  | { kind: 'missing'; want: 'endpoint'; endpoint: string; detail: string };

/** Compatibility for old profile descriptors; never used to resolve endpoint spending. */
export function claudeCredentialPays(profile: Pick<AgentProfile, 'credential' | 'endpoint'>): boolean {
  return profile.credential === 'anthropic' && (profile.endpoint === '' || isAnthropicApiEndpoint(profile.endpoint));
}

export function profileNeedsCredential(profile: Pick<AgentProfile, 'credential'>): boolean {
  return profile.credential !== NO_CREDENTIAL;
}

export function profileTakesChatGptSession(profile: Pick<AgentProfile, 'credential' | 'endpoint'>): boolean {
  return profile.credential !== NO_CREDENTIAL && (profile.credential === 'chatgpt' || isChatGptEndpoint(profile.endpoint));
}

/** Service aliases name a holder; they are never a pool of keys for arbitrary endpoints. */
export async function spendingMember(projectRoot: string, principal: string): Promise<string | null> {
  if (principal !== SERVICE_CREDENTIAL_USER_ID) return principal.trim().toLowerCase();
  return (await getServiceHolder(projectRoot))?.email.trim().toLowerCase() ?? null;
}

/** Check the selected endpoint against its actual host-derived upstream before exposing its secret. */
export async function memberEndpointCredentialFor(
  projectRoot: string,
  principal: string,
  requirement: EndpointRequirement,
  upstream: string = requirement.origin,
): Promise<MemberCredentialAnswer> {
  if (requirement.credential === NO_CREDENTIAL) return { kind: 'none-needed' };
  const missing = (detail: string): MemberCredentialAnswer => ({ kind: 'missing', want: 'endpoint', endpoint: requirement.endpointId, detail });
  const service = principal === SERVICE_CREDENTIAL_USER_ID;
  let member: string;
  if (service) {
    const state = await getServiceHolderState(projectRoot);
    if (state.conflicted) return missing(SERVICE_HOLDER_CONFLICTED_REASON);
    if (!state.holder) return missing(NO_SERVICE_HOLDER_DELIVERED_REASON);
    member = state.holder.email.trim().toLowerCase();
  } else {
    member = principal.trim().toLowerCase();
  }
  const record = await getEndpointCredential(projectRoot, member, requirement.endpointId);
  if (!record) {
    return missing(service
      ? `the service holder ${member} has no ${credentialLabel(requirement.credential)} connection for endpoint "${requirement.endpointId}" on this project's daemon — either they have none at any level (account, team or project), or Teams has not delivered it`
      : `no usable ${credentialLabel(requirement.credential)} connection exists for endpoint "${requirement.endpointId}"`);
  }
  let actualOrigin: string;
  try {
    actualOrigin = normalizeEndpointOrigin(upstream);
  } catch (error) {
    return missing(`the selected destination is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualOrigin !== requirement.origin) return missing('the selected route does not match the endpoint in this request’s effective configuration');
  if (!credentialConsentedToEndpoint(record, requirement)) return missing(`its connection consented to ${record.endpoint || 'no destination'}, but requests go to ${requirement.scope}; reconnect it before spending`);
  // Consent alone cannot authorize a provider-bound secret at another provider.
  if ((record.provider === 'anthropic' || requirement.provider === 'anthropic') && actualOrigin !== 'https://api.anthropic.com') {
    return missing('an Anthropic credential is never sent to a non-Anthropic destination');
  }
  if (!credentialCompatibleWithEndpoint(record, requirement)) return missing('the connected credential’s provider, session or kind does not match this endpoint; reconnect it');
  return { kind: 'credential', record, via: 'endpoint', member, requirement };
}

/** Ordinary profile or tier zero. Launches use every requirement, not this convenience. */
export async function memberCredentialFor(projectRoot: string, principal: string, profile: AgentProfile, effectiveConfig?: ResolvedConfig): Promise<MemberCredentialAnswer> {
  const requirements = endpointRequirementsForProfile(profile, effectiveConfig ?? await loadConfig(projectRoot));
  const first = requirements[0];
  return first ? memberEndpointCredentialFor(projectRoot, principal, first) : { kind: 'none-needed' };
}

/** Every paid tier must be connected, even one unlikely to serve a request. */
export async function memberProfileCredentialProblem(projectRoot: string, principal: string, profile: AgentProfile, config: ResolvedConfig): Promise<string | null> {
  const requirements = endpointRequirementsForProfile(profile, config);
  for (const requirement of requirements) {
    const answer = await memberEndpointCredentialFor(projectRoot, principal, requirement);
    if (answer.kind !== 'missing') continue;
    const tiers = requirement.consumers.filter(c => c.profile === profile.name && c.tier !== null).map(c => `tier ${c.tier! + 1}`).join(', ');
    const who = principalPhrase(principal);
    const marker = principal === SERVICE_CREDENTIAL_USER_ID ? 'No service credential for automated turns' : NO_OWNER_ENDPOINT_CREDENTIAL_MARKER;
    // A service refusal says WHY the turn is the service holder's at all: the
    // member who sees it usually started the work, and is otherwise left to
    // wonder why their own connection was not used.
    const remedy = principal === SERVICE_CREDENTIAL_USER_ID
      ? `${serviceTurnReason()}; no teammate's credential is used instead. A turn a person starts, or a subtask their task's agent starts, runs on that person's own connections.`
      : 'Connect this endpoint for that member; no teammate or project credential is used.';
    return `${marker} "${requirement.endpointId}": ${who} cannot run on agent profile ${profileLabel(profile)}${tiers ? ` (${tiers})` : ''}: ${answer.detail}. ${remedy}`;
  }
  return null;
}

export async function memberCredentialForProfileName(projectRoot: string, principal: string, profileName: string): Promise<{ profile: AgentProfile; answer: MemberCredentialAnswer } | null> {
  const config = await loadConfig(projectRoot);
  const profile = profileForAgentNameOrNull(config, profileName);
  return profile ? { profile, answer: await memberCredentialFor(projectRoot, principal, profile, config) } : null;
}

export function profileLabel(profile: Pick<AgentProfile, 'name' | 'harness'>): string {
  return profile.name === profile.harness ? `"${profile.name}"` : `"${profile.name}" (${profile.harness})`;
}

export function principalPhrase(principal: string): string {
  return principal === SERVICE_CREDENTIAL_USER_ID ? "the project's service credential holder" : `user '${principal}'`;
}
