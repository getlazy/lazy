/**
 * The control plane's two doors onto per-profile member credentials: the list
 * of what each agent profile takes from a member, and storing one.
 *
 * A control plane (Lazy Teams) renders a "connect your credentials" page from
 * {@link agentCredentialProfiles} and never keeps its own list of profiles or
 * its own idea of which credential a profile needs: both are the daemon's
 * answer, read from the project's config as it resolves now. The rule deciding
 * which credential pays for a turn lives in ./member-credentials.ts; this file
 * only describes it and admits credentials into it.
 */

import { loadConfig } from '../config/loader';
import {
  type AgentProfile,
  agentProfilesFor,
  selectableAgentProfiles,
} from '../config/agent-profiles';
import { credentialKinds, credentialLabel } from '../credentials/providers';
import { parseChatGptTokens, serializeChatGptTokens } from '../credentials/chatgpt-tokens';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';
import {
  claudeCredentialPays,
  memberCredentialFor,
  profileNeedsCredential,
  profileTakesChatGptSession,
  type MemberCredentialAnswer,
} from './member-credentials';
import {
  getServiceCredential,
  putUserCredential,
  SERVICE_CREDENTIAL_USER_ID,
  type UserCredentialKind,
  type UserCredentialSummary,
} from './user-credentials';

/** One agent profile, as a "connect your credentials" page shows it. */
export interface AgentCredentialProfile {
  name: string;
  harness: string;
  /** '' means the harness's own default model. */
  model: string;
  builtin: boolean;
  /**
   * Which of a member's credentials pays for a turn on it:
   *   `claude`  — their Claude (Anthropic) credential, the one connected without a profile;
   *   `profile` — one they connect for this profile specifically;
   *   `none`    — nothing: the profile's upstream takes no credential.
   */
  paidBy: 'claude' | 'profile' | 'none';
  /** The credential name the profile bills (`anthropic`, `openai`, a name of the project's own), or null for `none`. */
  credential: string | null;
  /** Human-facing name of that credential: "OpenAI", "ChatGPT subscription". */
  credentialLabel: string | null;
  /** Kinds a member may connect for it, in the order to offer them. Empty unless `paidBy` is `profile`. */
  kinds: UserCredentialKind[];
  /** True when the credential is a ChatGPT subscription session — the JSON `codex login` writes. */
  session: boolean;
  /**
   * Where a credential connected for this profile is SENT: the origin of the
   * profile's own endpoint, or null when it has none (the project's default
   * upstream). Shown so a member knows where their secret goes before they
   * hand it over; the path is left out because it is not the member's concern.
   */
  endpoint: string | null;
  /** How to obtain one, one sentence. */
  howToGet: string | null;
  /**
   * Present when the list was asked FOR a principal: whether a turn that
   * principal starts on this profile would find a credential to pay with —
   * {@link memberCredentialFor}'s answer, the SAME one the launch refuses on.
   * A control plane renders "connected" from this, never from its own copy of
   * the secret, so its page and the start refusal cannot disagree.
   */
  yours?: MemberCredentialState;
}

/** One principal's standing on one profile, as the launch would judge it. */
export type MemberCredentialState =
  | { state: 'none-needed' }
  | { state: 'connected'; via: 'profile' | 'claude' }
  /** `detail` is the launch refusal's own reason clause, e.g. "no Cursor credential is connected for it". */
  | { state: 'missing'; want: 'profile' | 'claude'; detail: string };

/**
 * @param principal when given, each profile carries `yours` for that member
 *   (or the service key).
 */
export async function agentCredentialProfiles(
  projectRoot: string,
  principal?: string,
): Promise<{ profiles: AgentCredentialProfile[] }> {
  const config = await loadConfig(projectRoot);
  const profiles: AgentCredentialProfile[] = [];
  for (const profile of selectableAgentProfiles(agentProfilesFor(config))) {
    const described = describe(profile);
    if (principal !== undefined) described.yours = stateOf(await memberCredentialFor(projectRoot, principal, profile));
    profiles.push(described);
  }
  return { profiles };
}

function stateOf(answer: MemberCredentialAnswer): MemberCredentialState {
  if (answer.kind === 'none-needed') return { state: 'none-needed' };
  if (answer.kind === 'credential') return { state: 'connected', via: answer.via };
  return { state: 'missing', want: answer.want, detail: answer.detail };
}

function describe(profile: AgentProfile): AgentCredentialProfile {
  const paidBy = !profileNeedsCredential(profile) ? 'none' : claudeCredentialPays(profile) ? 'claude' : 'profile';
  const session = paidBy === 'profile' && profileTakesChatGptSession(profile);
  return {
    name: profile.name,
    harness: profile.harness,
    model: profile.model,
    builtin: profile.builtin,
    paidBy,
    credential: paidBy === 'none' ? null : profile.credential,
    credentialLabel: paidBy === 'none' ? null : session ? 'ChatGPT subscription' : credentialLabel(profile.credential),
    kinds: paidBy !== 'profile' ? [] : session ? ['oauth'] : [...credentialKinds(profile.credential)],
    session,
    endpoint: originOf(profile.endpoint),
    howToGet: paidBy === 'profile' ? howToGet(profile, session) : null,
  };
}

function originOf(endpoint: string): string | null {
  if (!endpoint.trim()) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

/**
 * Where a member gets one, in a sentence for a web page — never a `lazy auth`
 * command, which is how a terminal user stores one for the daemon itself and
 * nothing a member of a hosted team can run.
 */
const MEMBER_HOW_TO_GET: Record<string, string> = {
  openai: 'An API key from platform.openai.com/api-keys.',
  openrouter: 'An API key from openrouter.ai/keys.',
  ollama: 'An API key from ollama.com.',
  cursor: 'An API key from the Cursor dashboard.',
  anthropic: 'A `claude setup-token` token, or an API key from the Anthropic console.',
};

function howToGet(profile: AgentProfile, session: boolean): string {
  if (session) {
    return 'Run `codex login` (or `codex login --device-auth`) on your own machine and paste the contents of ' +
      '~/.codex/auth.json. Use a login made for this purpose: lazy renews it, which signs out any other copy.';
  }
  return MEMBER_HOW_TO_GET[profile.credential] ??
    'The API key (or token) this agent\'s endpoint accepts — ask whoever runs that service.';
}

/**
 * The stable prefix on a refusal that says THIS credential can never be stored
 * for this profile as it is configured now — it no longer takes one, the
 * member's Claude credential pays for it, it takes another kind, or the secret
 * is not what the profile takes. Retrying the same push can never succeed, so a
 * control plane matches this to set the row aside and show the member why,
 * rather than failing every provisioning pass on it. A WIRE marker —
 * `lazy-teams/app/clients/lazy_daemon.rb` names it too.
 */
export const CREDENTIAL_NOT_TAKEN_MARKER = 'Credential not taken for agent profile';

function notTaken(profile: AgentProfile, reason: string): RpcError {
  return new RpcError(400, `${CREDENTIAL_NOT_TAKEN_MARKER} "${profile.name}": ${reason}`);
}

/**
 * Store a credential a principal connected for one agent profile.
 *
 * Refused when the profile does not take one from a member — it bills nothing,
 * or the member's Claude credential pays for it (one credential per profile,
 * never two copies that could disagree) — or when the kind is not one the
 * profile takes.
 *
 * `endpoint` is the member's CONSENT: the endpoint (origin; '' for the
 * project's default upstream) the control plane SHOWED them for this profile
 * when they connected it. It is recorded exactly as stated — never derived from
 * the config — because the control plane re-pushes every credential on each
 * provisioning pass, and a stamp taken from config there would silently
 * re-consent every member to wherever the owner last pointed the profile. A
 * turn is refused while it differs from where the proxy forwards the profile
 * (./member-credentials.ts). Omitted, no consent is recorded and the credential
 * pays for nothing.
 *
 * A profile the project does not define (yet, or any more) is accepted, so a
 * control plane replaying its rows is never wedged by one stale row.
 */
export async function putProfileCredential(
  projectRoot: string,
  input: {
    userId: string;
    kind: string;
    token: string;
    label?: string;
    ownerEmail?: string;
    ownerName?: string;
    profile: string;
    /** The endpoint the member was shown — see above. */
    endpoint?: string;
  },
): Promise<UserCredentialSummary> {
  const profile = agentProfilesFor(await loadConfig(projectRoot)).get(input.profile) ?? null;
  let token = input.token;
  let renewable = false;

  if (profile) {
    const described = describe(profile);
    if (described.paidBy === 'none') {
      throw notTaken(profile, 'it takes no credential — its upstream authenticates nobody.');
    }
    if (described.paidBy === 'claude') {
      throw notTaken(
        profile,
        `it is paid by the member's Claude (Anthropic) credential — the one put without a profile. Put ` +
        `that one instead; a second copy for this profile would never be used.`,
      );
    }
    if (!(described.kinds as string[]).includes(input.kind)) {
      throw notTaken(
        profile,
        `it takes ${described.kinds.map((k) => `'${k}'`).join(' or ')} (${described.credentialLabel}), not '${input.kind}'.`,
      );
    }
    if (described.session) {
      // Validated and compacted on the way in, so a member who pasted the wrong
      // file hears it now rather than on their first turn.
      try {
        token = serializeChatGptTokens(parseChatGptTokens(input.token.trim(), 'The ChatGPT credential'));
      } catch (err) {
        throw notTaken(profile, err instanceof Error ? err.message : String(err));
      }
      renewable = true;
    }
  } else if (input.kind !== 'oauth' && input.kind !== 'api-key') {
    throw new RpcError(400, `kind must be 'oauth' or 'api-key'. Got '${input.kind}'.`);
  }

  let summary: UserCredentialSummary;
  // THE SERVICE SLOT OF A SESSION PROFILE REFERS TO THE HOLDER'S OWN LOGIN.
  // The control plane pushes the service holder's rows under the service key
  // too; for a ChatGPT session that would be a second copy of one login, and
  // the two copies' renewals would retire each other's refresh token. So the
  // service record names the holder (the service credential's owner) and holds
  // no secret of its own.
  let sameAs: string | undefined;
  if (profile && input.userId.trim() === SERVICE_CREDENTIAL_USER_ID && describe(profile).session) {
    sameAs = input.ownerEmail?.trim() || (await getServiceCredential(projectRoot))?.ownerEmail;
    if (!sameAs) {
      throw new RpcError(
        400,
        `The service credential for "${profile.name}" is a ChatGPT session, which is shared with its holder's own ` +
        `rather than copied — but no holder is named. Put the service credential (with its ownerEmail) first, or ` +
        `pass ownerEmail.`,
      );
    }
  }

  try {
    summary = await putUserCredential(projectRoot, {
      userId: input.userId,
      kind: input.kind as UserCredentialKind,
      token,
      label: input.label,
      ownerEmail: input.ownerEmail,
      ownerName: input.ownerName,
      profile: input.profile,
      endpoint: input.endpoint === undefined ? null : originOf(input.endpoint) ?? '',
      renewable: renewable && sameAs === undefined,
      ...(sameAs ? { sameAs, ownerEmail: undefined } : {}),
    });
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
  // Never log the secret, and never log enough to identify it.
  logger.info(
    `Stored ${summary.kind} credential for user ${summary.userId}, agent profile "${input.profile}"` +
    (profile ? '' : ' (not defined in this project — it pays for nothing until connected again)'),
  );
  return summary;
}
