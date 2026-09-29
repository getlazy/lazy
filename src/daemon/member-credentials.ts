/**
 * Which of a member's OWN credentials pays for a turn on a given agent profile —
 * the one rule, in team mode, for every profile lazy can run.
 *
 * TEAM MODE BILLS THE ACTING MEMBER FOR EVERY PROFILE. With a control plane in
 * front of the daemon, each turn is paid by the person who asked for it (or, for
 * a turn nobody asked for, by the project's service holder) — the per-user
 * billing mandate: traceability, real per-person quotas, and never one account
 * shared among people. That used to be true only of Anthropic traffic; a codex,
 * cursor or pi turn spent whichever key the project's own credential store held,
 * shared by everybody. Now every profile is paid the same way, and the project
 * store is never consulted for a team-mode turn's model traffic — there is no
 * fallback to it, or to anybody else's credential.
 *
 * KEYED BY PROFILE. A member connects a credential per `[agents.<name>]` profile
 * (./user-credentials.ts, `profile`), so their secret only ever reaches the
 * upstream of the profile they connected it for. The record carries the
 * endpoint the member was SHOWN when they connected it — their consent, stated
 * by the control plane, never derived from config here — and a turn is refused
 * when the running proxy would forward the profile anywhere else, rather than
 * following the profile to a host they never agreed to send it to.
 *
 * THE CLAUDE CREDENTIAL still pays where it always did. A member's profile-less
 * record — the Claude credential they connected before profiles had credentials
 * of their own — pays EVERY profile that bills `anthropic` and whose traffic
 * goes to the proxy's primary upstream (no endpoint of its own) or to
 * Anthropic's own API, and only it does: exactly one credential answers for any
 * profile, so a member is never asked to connect the same Claude account twice
 * and no two copies can disagree about which one a turn spent.
 *
 * A profile that bills NOTHING (`credential = "none"`, a local model server)
 * needs nothing from anybody.
 */

import { loadConfig } from '../config/loader';
import {
  type AgentProfile,
  NO_CREDENTIAL,
  isAnthropicApiEndpoint,
  profileForAgentNameOrNull,
} from '../config/agent-profiles';
import { credentialLabel } from '../credentials/providers';
import { isChatGptEndpoint } from '../utils/openai-compat';
import { getUserCredential, SERVICE_CREDENTIAL_USER_ID, type UserCredentialRecord } from './user-credentials';
import { forwardingOriginFor } from './running-proxy-routes';

/**
 * The stable prefix on a refusal a control plane can act on: the person who
 * asked for this turn has not connected a credential for the turn's profile.
 * The profile's name follows, in double quotes. A WIRE marker —
 * `lazy-teams/app/clients/lazy_daemon/client.rb` names it too.
 *
 * The Claude-credential case keeps its own, older marker
 * (`NO_OWNER_CREDENTIAL_MARKER`, ./turn-credentials.ts) so a control plane that
 * predates profile credentials still says "connect your Claude account" for it.
 */
export const NO_OWNER_PROFILE_CREDENTIAL_MARKER = 'No credential of yours for agent profile';

/** What pays for one principal's turn on one profile. */
export type MemberCredentialAnswer =
  /** The profile authenticates nobody. */
  | { kind: 'none-needed' }
  | {
      kind: 'credential';
      record: UserCredentialRecord;
      /** `profile`: connected for this profile. `claude`: their Claude credential. */
      via: 'profile' | 'claude';
    }
  | {
      kind: 'missing';
      /** `claude`: the Claude credential would pay and there is none. */
      want: 'profile' | 'claude';
      /** Why, in one clause — "has not connected one", "its endpoint changed". */
      detail: string;
    };

/**
 * Does the principal's Claude credential pay for this profile?
 *
 * Decided on the SAVED config; {@link memberCredentialFor} additionally
 * refuses while the RUNNING proxy still forwards the profile anywhere else.
 *
 * Only where it is sent to Anthropic: the proxy's primary upstream (a profile
 * with no endpoint of its own — on a managed host that is the fleet's, which a
 * repository cannot change) or Anthropic's own API host.
 */
export function claudeCredentialPays(profile: Pick<AgentProfile, 'credential' | 'endpoint'>): boolean {
  if (profile.credential !== 'anthropic') return false;
  return profile.endpoint === '' || isAnthropicApiEndpoint(profile.endpoint);
}

/** Does this profile need a credential from anybody? */
export function profileNeedsCredential(profile: Pick<AgentProfile, 'credential'>): boolean {
  return profile.credential !== NO_CREDENTIAL;
}

/**
 * Does a credential for this profile hold a ChatGPT subscription SESSION (the
 * JSON `codex login` writes) rather than a plain key? The endpoint overrules
 * the name, exactly as the proxy's own resolver does: that host takes nothing
 * else.
 */
export function profileTakesChatGptSession(profile: Pick<AgentProfile, 'credential' | 'endpoint'>): boolean {
  if (profile.credential === NO_CREDENTIAL) return false;
  return profile.credential === 'chatgpt' || isChatGptEndpoint(profile.endpoint);
}

/**
 * Which of `principal`'s credentials pays for a turn on `profile`.
 *
 * @param principal a member's address, or {@link SERVICE_CREDENTIAL_USER_ID}
 */
export async function memberCredentialFor(
  projectRoot: string,
  principal: string,
  profile: AgentProfile,
): Promise<MemberCredentialAnswer> {
  if (!profileNeedsCredential(profile)) return { kind: 'none-needed' };

  if (claudeCredentialPays(profile)) {
    // Decided on the SAVED config, but the secret goes where the RUNNING proxy
    // forwards the profile — built at daemon start, re-routed only by a
    // restart. A profile re-pointed at Anthropic (or stripped of its endpoint)
    // on the Configuration page is still forwarded to its old host until then,
    // and the member's Anthropic token must not ride that request.
    const forwardsTo = forwardingOriginFor(projectRoot, profile.name, await loadConfig(projectRoot));
    if (forwardsTo !== '' && !isAnthropicApiEndpoint(forwardsTo)) {
      return {
        kind: 'missing',
        want: 'profile',
        detail:
          `the project now sends it to Anthropic, but requests on this profile still go to ${forwardsTo} ` +
          `until the project restarts, and a Claude credential is never sent anywhere but Anthropic`,
      };
    }
    const claude = await getUserCredential(projectRoot, principal);
    if (claude) return { kind: 'credential', record: claude, via: 'claude' };
    return { kind: 'missing', want: 'claude', detail: 'no Claude (Anthropic) credential is connected' };
  }

  const own = await getUserCredential(projectRoot, principal, profile.name);
  // The service slot of a session profile refers to its holder's OWN record
  // (./user-credentials.ts `sameAs`): answer with that record, and that
  // record's consent — one login, one renewal chain.
  if (own?.sameAs && principal === SERVICE_CREDENTIAL_USER_ID && own.sameAs !== SERVICE_CREDENTIAL_USER_ID) {
    return memberCredentialFor(projectRoot, own.sameAs, profile);
  }
  if (own) {
    // The stamp is the member's CONSENT — the endpoint the control plane showed
    // them when they connected it (null: none was stated). It is checked
    // against where the RUNNING proxy forwards this profile, which is where the
    // secret would actually go; a saved config the proxy has not been rebuilt
    // from yet is not.
    const consented = own.endpoint ?? null;
    const forwardsTo = forwardingOriginFor(projectRoot, profile.name, await loadConfig(projectRoot));
    if (consented !== forwardsTo) {
      const where = (origin: string) => origin || "the project's default upstream";
      return {
        kind: 'missing',
        want: 'profile',
        detail:
          (consented === null
            ? `the credential connected for it states no endpoint it was connected for`
            : `the credential connected for it was connected for ${where(consented)}`) +
          `, but requests on this profile go to ${where(forwardsTo)} — it is never sent anywhere its ` +
          `owner did not connect it for, so it must be connected again`,
      };
    }
    return { kind: 'credential', record: own, via: 'profile' };
  }

  return {
    kind: 'missing',
    want: 'profile',
    detail: `no ${credentialLabel(profile.credential)} credential is connected for it`,
  };
}

/** {@link memberCredentialFor} by profile NAME; null when the profile does not exist. */
export async function memberCredentialForProfileName(
  projectRoot: string,
  principal: string,
  profileName: string,
): Promise<{ profile: AgentProfile; answer: MemberCredentialAnswer } | null> {
  const profile = profileForAgentNameOrNull(await loadConfig(projectRoot), profileName);
  if (!profile) return null;
  return { profile, answer: await memberCredentialFor(projectRoot, principal, profile) };
}

/** `"claude-gw" (claude-code)` — the harness only when it adds information. */
export function profileLabel(profile: Pick<AgentProfile, 'name' | 'harness'>): string {
  return profile.name === profile.harness ? `"${profile.name}"` : `"${profile.name}" (${profile.harness})`;
}

/** Who a principal is, for a refusal. */
export function principalPhrase(principal: string): string {
  return principal === SERVICE_CREDENTIAL_USER_ID
    ? `the project's service credential holder (turns nobody asked for run on their credentials)`
    : `user '${principal}'`;
}
