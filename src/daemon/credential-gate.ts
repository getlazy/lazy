/**
 * Daemon credential gate.
 *
 * The daemon is what launches task containers, and those containers inherit the
 * Claude Code OAuth token / Anthropic API key from the daemon's environment. If
 * the daemon starts without a credential, every container it spawns comes up
 * unable to reach the model API and silently fails. Gating the daemon itself on
 * credential presence eliminates that failure mode at the source: no daemon
 * means an immediate, actionable error instead of a fleet of broken containers.
 *
 * This is the SINGLE enforcement point for auth — clients (pair, builder, start,
 * etc.) no longer enforce it themselves; they auto-start the daemon and let this
 * gate be authoritative.
 *
 * WHERE IT RUNS (all of these, deliberately):
 *  - `startDaemonServer()` (src/daemon/server.ts) — the AUTHORITATIVE point. It
 *    is the one function that actually brings a daemon up, so enforcing there
 *    makes "no daemon without a credential" a structural property rather than a
 *    convention every caller has to remember. Any future start path inherits it.
 *  - `startDaemonBackground()` (src/daemon/auto-start.ts) — a pre-flight so the
 *    refusal lands in the CALLER's terminal immediately, instead of as a
 *    detached child that dies behind a readiness-poll timeout. Covers auto-start
 *    (every CLI command) and `lazy daemon start`.
 *  - `daemonRestart()` (src/cli/commands/daemon.ts) — a pre-flight BEFORE the
 *    stop, so a restart in a credential-less shell can't take down a working
 *    daemon and then refuse to bring one back.
 *  - `lazy upgrade` — its own pre-flight, before it stops containers and
 *    rebuilds (see `checkDaemonCredentials` callers).
 *
 * PRESENCE, NOT VALIDITY — and why. This gate deliberately does not call the
 * model API to check that the credential actually works:
 *  - It would make daemon startup depend on network reachability. A flaky link
 *    or an offline laptop would then refuse to start a daemon that holds a
 *    perfectly good token — a strictly worse failure than the one we're
 *    preventing.
 *  - Validating an OAuth token correctly means replicating Claude Code's own
 *    auth handshake (bearer + beta headers + refresh semantics). Getting that
 *    subtly wrong kills daemons that are fine.
 *  - Validity is not a start-time property anyway: a token that is valid at
 *    start can expire an hour later, so a start-time probe gives false
 *    assurance while doing nothing for the case it claims to cover.
 * The authoritative, always-current signal for "this credential does not work"
 * is the upstream 401/403 the audit proxy already sees on every request. What
 * this gate owns is the cheap, offline, deterministic half: a credential must
 * be present and non-blank (see `credentialFromEnv`).
 *
 * WHICH credential, though? Not "an Anthropic token, always". The gate resolves
 * the AGENT PROFILE each role defaults to (`[models.roles.<role>] agent`, else
 * `[agent] agent_id`, else the built-in `claude-code` profile) into the set of
 * PROVIDERS those profiles actually need, and demands a credential for exactly
 * those. A default profile on a local model server needs none and is let
 * through; a mixed setup still needs its Anthropic token. Widening the skip to
 * "any local endpoint anywhere in the config" would be the wrong fix — it would
 * wave through the mixed case this gate exists to catch.
 *
 * PRESENCE IS READ FROM THE INDEX, NEVER THE SECRET. A credential in the store
 * counts, but the gate answers "is there one?" from the non-secret
 * `credential-index.json`, not by opening a keychain item. That matters: the
 * daemon usually starts DETACHED from any GUI session, and touching a macOS
 * Keychain item there can block on an unlock prompt nobody can answer. The
 * secret itself is read once, later, by `hydrateCredentialEnv`.
 */

import { loadConfig } from '../config/loader';
import {
  type Provider,
  envVarsFor,
  credentialHowToGet,
  credentialLabel,
  requiredProviders,
} from '../credentials/providers';
import { credentialAvailable } from '../credentials/store';
import { localModelProfileAdvice } from '../config/agent-profile-advice';

/** Env vars that can carry the model credential, in precedence order. */
const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/**
 * The name of the env var holding a usable credential, or null if there is none.
 *
 * "Usable" means present AND non-blank after trimming. A whitespace-only value
 * is treated as absent on purpose: `export CLAUDE_CODE_OAUTH_TOKEN=$(claude
 * setup-token)` leaves exactly that behind when the inner command fails, and a
 * blank-but-set var used to sail through the gate and produce the precise
 * failure this gate exists to prevent — a daemon that runs, answers RPC, and
 * hands every container it launches a credential the API rejects.
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
 * Would a daemon started in THIS process's environment be refused by the gate?
 *
 * Returns the actionable message when it would, or null when the environment is
 * fine. Callers that are about to start a daemon use `assertDaemonCredentials`
 * (throws); callers that want to PRE-FLIGHT the decision without failing yet —
 * notably `lazy upgrade`, which must not stop and rebuild anything only to be
 * refused a daemon at the very end — use this and decide for themselves.
 *
 * The check reads this process's environment and the project's credential index,
 * both of which the daemon child sees identically (it inherits `process.env` and
 * reads the same store), so a preflight in the CLI process that will later spawn
 * the daemon is exactly equivalent to the gate the child will run.
 *
 * Mirrors the runner's existing auth logic: a profile pointed at a local model
 * server declares `credential = "none"` and needs no Anthropic token, so a
 * project whose default profiles are all local requires nothing and passes.
 *
 * @param projectRoot - Project root (its lazy.toml resolves the role profiles,
 *                      its credential index answers store presence)
 */
export async function checkDaemonCredentials(projectRoot: string): Promise<string | null> {
  const config = await loadConfig(projectRoot);

  const missing: Provider[] = [];
  for (const provider of requiredProviders(config)) {
    if (!(await credentialAvailable(projectRoot, provider))) missing.push(provider);
  }
  if (missing.length === 0) return null;

  return daemonCredentialError(missing);
}

/**
 * The actionable refusal for a specific set of unsatisfied providers.
 *
 * Naming the provider is the whole point: "no credential found" sent people
 * hunting for an Anthropic token in projects that needed a different one, or
 * none at all. Each provider gets the env vars that would satisfy it, how to
 * obtain one, and the `lazy auth set` command that stores it durably so the next
 * daemon start does not depend on the shell it happened to be launched from.
 */
export function daemonCredentialError(providers: Provider[]): string {
  const lines: string[] = [
    `Daemon refuses to start: no ${providers.map(credentialLabel).join(' or ')} credential found.`,
    '',
    'The daemon launches task containers that inherit its credential. Without one,',
    'every container it spawns would come up unable to reach the model API.',
    '',
  ];

  for (const provider of providers) {
    lines.push(`${credentialLabel(provider)} — ${credentialHowToGet(provider)}`);
    lines.push(`  Store it (preferred, survives your shell):  lazy auth set ${provider}`);
    lines.push(`  Or export one of:  ${envVarsFor(provider).join(', ')}`);
    lines.push('');
  }

  lines.push(localModelProfileAdvice());
  lines.push('');
  lines.push('A set-but-blank value counts as absent — check for an empty export.');

  return lines.join('\n');
}

/**
 * Throw an actionable error if the daemon's environment has no usable model
 * credential. The single enforcement point — see `checkDaemonCredentials` for
 * the non-throwing form used by preflights.
 *
 * @param projectRoot - Project root (its lazy.toml resolves the role profiles)
 */
export async function assertDaemonCredentials(projectRoot: string): Promise<void> {
  const message = await checkDaemonCredentials(projectRoot);
  if (message) throw new Error(message);
}

/**
 * The actionable refusal text for the default (Anthropic-only) project — by far
 * the common case. Exported so callers that surface a refusal through a
 * different channel (the startup-error marker file, `lazy doctor`) emit the same
 * message the user would have seen in their terminal.
 *
 * A project with a different provider set gets the tailored message from
 * `daemonCredentialError`; this constant is the anthropic instance of it, not a
 * separate string that could drift from it.
 */
export const DAEMON_CREDENTIAL_ERROR = daemonCredentialError(['anthropic']);
