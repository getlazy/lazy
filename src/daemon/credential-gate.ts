/**
 * The model-credential gate — a TURN gate, never a daemon-start gate.
 *
 * A daemon needs no model credential to exist. Registering a project, cloning
 * it, `lazy init`, starting the daemon, serving reads, the dashboard, a sync
 * whose merge is CLEAN, and accept all work without one; only a TURN talks to
 * a model — and a sync that conflicts runs one, to resolve it — so a turn
 * launch is the one place a credential is required. This module answers that question
 * for the PROFILE the turn runs on, and nothing broader.
 *
 * WHY NOT AT DAEMON START (it used to be). The daemon refused to start without a
 * credential for its role-default profiles, on the theory that a credential-less
 * daemon launches containers that cannot reach the model API. The cost of that
 * theory was everything else the daemon does: a Teams project could not even be
 * cloned before somebody connected a Claude credential, and a project whose
 * tasks run on codex or cursor was refused a daemon over an Anthropic token it
 * never spends — Claude is one harness of several. The failure the old gate
 * prevented is prevented here instead, at the moment it would happen: a turn on
 * a profile with no credential is refused BEFORE the task moves to `working`,
 * naming the profile and what it lacks, and nothing else is refused at all.
 * `lazy daemon health` and `lazy doctor` show the gap as a WARN before anyone
 * launches a turn into it.
 *
 * WHERE IT RUNS. `planTurnCredential` (./turn-credentials.ts) — the one function
 * every turn-launching path already calls, before the status flip — asks
 * {@link turnCredentialRefusal} for the task's profile. The daemon's own
 * automations ask the same question through `systemTurnBlock`, so they skip
 * with the reason instead of retrying into the refusal every tick. The rules
 * that add the team-mode owner/service check live once, in
 * `turnCredentialProblem` (./turn-credentials.ts), which the CLI pre-flight
 * (`turnCredentialCheck`), the pre-record check and the conflict-sync gate
 * all use — a conflicting sync with no credential is HELD on its pending-sync
 * counter, never dropped.
 *
 * TEAM MODE. When a control plane put per-user credentials in this daemon,
 * EVERY profile is paid by the turn OWNER's own credential for that profile (or
 * the project's service holder's), and `planTurnCredential` refuses a turn
 * whose owner has none (./member-credentials.ts). This gate therefore answers
 * nothing in team mode: the daemon's env and the project's credential store are
 * not what pays for any team-mode turn, so their contents must neither refuse
 * one nor let one through.
 *
 * PRESENCE, NOT VALIDITY. The gate never calls a model API: that would make a
 * launch depend on network reachability and replicate each vendor's auth
 * handshake. Validity is the proxy's to observe (the upstream 401/403 it sees
 * on every request) and doctor's to report.
 *
 * LIVE, NOT FROZEN AT START. The Anthropic credential is read from the daemon's
 * own environment (see `daemonEnv` in ../credentials/providers.ts), which was
 * filled once at startup. A daemon may now start with none, so a credential
 * stored afterwards (`lazy auth set anthropic`) is hydrated here, at the first
 * turn that needs it — never "restart the daemon" for the missing → present
 * transition. Every other credential is resolved from the store per launch.
 */

import { loadConfig } from '../config/loader';
import type { ResolvedConfig } from '../config/types';
import {
  type AgentProfile,
  NO_CREDENTIAL,
  agentProfilesFor,
  profileForAgentNameOrNull,
} from '../config/agent-profiles';
import {
  type Provider,
  credentialLabel,
  credentialNeedsDaemonRestart,
  credentialSetupCommand,
  envVarsFor,
  requiredCredentials,
} from '../credentials/providers';
import { credentialInEnv } from '../credentials/store';
import { hydrateCredentialEnv } from '../credentials/hydrate';
import { alternativeCredentialHint, locateProfileCredential } from '../agent/credentials';
import { logger } from '../utils/logger';

/** Env vars that can carry the Anthropic credential, in precedence order. */
const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/**
 * The name of the env var holding a usable Anthropic credential, or null if
 * there is none.
 *
 * "Usable" means present AND non-blank after trimming. A whitespace-only value
 * is treated as absent on purpose: `export CLAUDE_CODE_OAUTH_TOKEN=$(claude
 * setup-token)` leaves exactly that behind when the inner command fails.
 *
 * @param env - Environment to inspect (defaults to this process's environment)
 */
export function credentialFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name];
    if (value && value.trim().length > 0) return name;
  }
  return null;
}

/**
 * The stable prefix of a turn refused because the daemon holds no credential
 * for the profile it runs on. A WIRE marker, like `NO_OWNER_CREDENTIAL_MARKER`
 * (./turn-credentials.ts): Lazy Teams matches it to offer "connect a
 * credential" instead of a generic refusal — `lazy-teams/app/clients/
 * lazy_daemon/client.rb` names it too, so changing it is a wire change.
 */
export const NO_PROFILE_CREDENTIAL_MARKER = 'No credential for agent profile';

/** "an Anthropic", "a ChatGPT subscription" — the label with its article. */
function withArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/** `"codex-subscription" (codex)` — the harness only when it adds information. */
function profilePhrase(profile: AgentProfile): string {
  return profile.name === profile.harness ? `"${profile.name}"` : `"${profile.name}" (${profile.harness})`;
}

/**
 * The refusal for a turn whose profile has no credential. Names the PROFILE and
 * the credential it bills — never "Claude" for a profile that does not run on
 * Anthropic — and how to connect one.
 */
export function profileCredentialMissingMessage(profile: AgentProfile): string {
  const label = credentialLabel(profile.credential);
  return (
    `${NO_PROFILE_CREDENTIAL_MARKER} ${profilePhrase(profile)}: it needs ${withArticle(label)} credential, ` +
    `and this daemon has none. Turns on this profile are refused until one is connected — ` +
    `store it with \`lazy ${credentialSetupCommand(profile.credential)}\`, or set ` +
    `${envVarsFor(profile.credential).join(' or ')} in the daemon's environment.` +
    alternativeCredentialHint(profile.harness, profile.credential)
  );
}

/**
 * Would a turn on this profile be refused for want of a credential? Returns the
 * refusal, or null when the turn may launch.
 *
 * @param opts.perUser - team mode: every slot is paid by the turn owner's own
 *   credential for the profile and checked by `planTurnCredential`, not here
 * @param opts.load - false answers from PRESENCE only (env and the non-secret
 *   index) and never opens a keychain item: for callers that only need to know
 *   whether a launch WOULD be refused — the reconciler's per-tick automation
 *   check, the CLI pre-flight — where a detached daemon blocking on an unlock
 *   prompt would be far worse than a slightly optimistic answer. The launch
 *   itself always loads (the default), and refuses then if the load fails.
 */
export async function profileCredentialRefusal(
  projectRoot: string,
  profile: AgentProfile,
  opts: { perUser: boolean; load?: boolean },
): Promise<string | null> {
  const credential = profile.credential;
  if (credential === NO_CREDENTIAL) return null;
  if (opts.perUser) return null;

  const located = await locateProfileCredential(projectRoot, credential, [profile.harness]);

  // Every credential but the daemon-env one is resolved from the store per
  // launch and per request, so presence anywhere is enough.
  if (!credentialNeedsDaemonRestart(credential)) {
    return located.present ? null : profileCredentialMissingMessage(profile);
  }

  // The daemon-env credential must be IN the environment, because that is
  // where the launch and the proxy read it. Stored since the daemon started →
  // load it now.
  if (credentialInEnv(credential)) return null;
  if (!located.present) return profileCredentialMissingMessage(profile);
  if (opts.load === false) return null;
  try {
    await hydrateCredentialEnv(projectRoot, process.env, [credential as Provider]);
  } catch (err) {
    return (
      `${NO_PROFILE_CREDENTIAL_MARKER} ${profilePhrase(profile)}: its ${credentialLabel(credential)} ` +
      `credential is stored but could not be loaded: ${err instanceof Error ? err.message : String(err)}. ` +
      `Re-store it with \`lazy ${credentialSetupCommand(credential)}\`.`
    );
  }
  if (credentialInEnv(credential)) {
    // Whatever startup could not load has loaded now: health must stop saying so.
    recordStartupCredentialProblem(null);
    return null;
  }
  // Present in the index, yet nothing reached the environment (a stored kind
  // with no env var — hydration warned). Refuse rather than launch into a 401.
  return profileCredentialMissingMessage(profile);
}

/**
 * The gate for a launch described by a resolved ROLE TARGET (a flattened
 * profile) that runs on the daemon's OWN credential — the builder sessions, the
 * review-conversation builder, machine one-shots (`lazy ask` on a stored
 * record, link descriptions, memory compaction). `getLaunchAuthEnvVars` asks
 * it, so every such launch loads a credential stored since startup and refuses
 * by profile instead of dying on "Authentication required". A launch carrying a
 * member's session placeholder is paid by that member and never asks.
 */
export async function targetCredentialRefusal(
  projectRoot: string,
  target: { profile: string; harness: string; credential: string },
): Promise<string | null> {
  const profile = { name: target.profile, harness: target.harness, credential: target.credential } as AgentProfile;
  return profileCredentialRefusal(projectRoot, profile, { perUser: false });
}

/**
 * The gate for one task's turn: its profile's credential, or null to launch.
 *
 * A task whose profile no longer exists answers null — the launch path refuses
 * that itself with a message naming the task, and answering it twice here
 * would only compete with it.
 */
export async function turnCredentialRefusal(
  projectRoot: string,
  agentId: string | null | undefined,
  opts: { perUser: boolean; config?: ResolvedConfig; load?: boolean },
): Promise<string | null> {
  const config = opts.config ?? (await loadConfig(projectRoot));
  const profile = profileForAgentNameOrNull(config, agentId);
  if (!profile) return null;
  return profileCredentialRefusal(projectRoot, profile, opts);
}

/** One credential the configured profiles bill that turns on them would lack. */
export interface MissingTurnCredential {
  /** Credential name — a provider or a user-chosen one. */
  name: string;
  label: string;
  /** Profiles whose turns would be refused, sorted. */
  profiles: string[];
  /** How to connect one, one line. */
  remedy: string;
}

/**
 * Every credential a configured profile bills that is not available — the
 * DIAGNOSTIC twin of the turn gate, for `lazy daemon health`. Reads presence
 * only (env and the non-secret index): a health check must never open a
 * keychain item.
 *
 * A daemon-env credential stored but not yet loaded counts as available: the
 * first turn that needs it loads it (see {@link profileCredentialRefusal}).
 */
export async function missingTurnCredentials(
  projectRoot: string,
  opts: { perUser: boolean; config?: ResolvedConfig },
): Promise<MissingTurnCredential[]> {
  // Team mode: every profile is paid by each member's own credential for it,
  // so what this daemon holds says nothing about whether a turn can run.
  if (opts.perUser) return [];
  const config = opts.config ?? (await loadConfig(projectRoot));
  const profiles = agentProfilesFor(config);
  const missing: MissingTurnCredential[] = [];
  for (const { name, requiredBy } of requiredCredentials(config)) {
    const harnesses = requiredBy.map((p) => profiles.get(p)?.harness ?? '');
    const located = await locateProfileCredential(projectRoot, name, harnesses);
    if (located.present) continue;
    missing.push({
      name,
      label: credentialLabel(name),
      profiles: requiredBy,
      remedy:
        `store one with \`lazy ${credentialSetupCommand(name)}\`, or set ` +
        `${envVarsFor(name).join(' or ')} in the daemon's environment`,
    });
  }
  return missing;
}

/**
 * ONE line for a command about to (re)start a daemon from THIS process's
 * environment — `lazy daemon restart`, `lazy upgrade` — naming the configured
 * profiles whose turns the new daemon will refuse, or null when there are none.
 *
 * A notice, never a refusal: a daemon needs no credential to run. It exists
 * because the replacement inherits this shell's environment rather than the
 * old daemon's, so a restart from a shell without an exported token can
 * quietly take away a credential the running daemon had. Never throws — a
 * notice that failed to compute is not worth failing the command over.
 */
export async function missingCredentialNotice(projectRoot: string): Promise<string | null> {
  try {
    const { teamModeEnabled } = await import('./user-credentials');
    const missing = await missingTurnCredentials(projectRoot, {
      perUser: await teamModeEnabled(projectRoot),
    });
    if (missing.length === 0) return null;
    const what = missing.map((m) => `${m.profiles.join(', ')} (${m.label})`).join('; ');
    return `Note: the new daemon will have no credential for profile ${what} — turns on it will be refused ` +
      `until one is connected (see lazy daemon health).`;
  } catch (err) {
    logger.debug(`Could not check which profiles have a model credential: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Log, once at daemon start, which profiles cannot run turns yet. A WARN line,
 * never a refusal — the daemon starts either way.
 */
export async function warnMissingTurnCredentials(
  projectRoot: string,
  opts: { perUser: boolean },
): Promise<void> {
  try {
    for (const m of await missingTurnCredentials(projectRoot, opts)) {
      logger.warn(
        `No ${m.label} credential for profile ${m.profiles.join(', ')}; turns on it will be refused ` +
        `until one is connected (${m.remedy}).`,
      );
    }
  } catch (err) {
    logger.warn(`Could not check which profiles have a model credential: ${err instanceof Error ? err.message : String(err)}`);
  }
}


/**
 * Why stored credentials did not load at daemon startup, or null. Held for
 * `lazy daemon health`: startup no longer refuses over it, so without this the
 * only record would be one log line on a detached daemon nobody is watching.
 * Process-lifetime state on purpose — it describes THIS daemon's startup.
 */
let startupCredentialProblem: string | null = null;

export function recordStartupCredentialProblem(message: string | null): void {
  startupCredentialProblem = message;
}

export function getStartupCredentialProblem(): string | null {
  return startupCredentialProblem;
}
