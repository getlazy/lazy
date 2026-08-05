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
 */

import { loadConfig } from '../config/loader';

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
 * The check is env-based and process-local, so a preflight in the CLI process
 * that will later spawn the daemon (the daemon child inherits `process.env`) is
 * exactly equivalent to the gate the child will run.
 *
 * Mirrors the runner's existing auth logic: when `[ollama]` is enabled the
 * daemon uses local dummy credentials and needs no Anthropic token, so the gate
 * is skipped in that case.
 *
 * @param projectRoot - Project root (used to read lazy.toml for the ollama flag)
 */
export async function checkDaemonCredentials(projectRoot: string): Promise<string | null> {
  const config = await loadConfig(projectRoot);

  // Ollama-backed setups talk to a local model with dummy credentials — no
  // Claude/Anthropic token is required, matching runner.checkAvailability().
  if (config.ollama.enabled) return null;

  if (credentialFromEnv()) return null;

  return DAEMON_CREDENTIAL_ERROR;
}

/**
 * Throw an actionable error if the daemon's environment has no usable model
 * credential. The single enforcement point — see `checkDaemonCredentials` for
 * the non-throwing form used by preflights.
 *
 * @param projectRoot - Project root (used to read lazy.toml for the ollama flag)
 */
export async function assertDaemonCredentials(projectRoot: string): Promise<void> {
  const message = await checkDaemonCredentials(projectRoot);
  if (message) throw new Error(message);
}

/**
 * The actionable refusal text. Exported so callers that surface it through a
 * different channel (the startup-error marker file) emit the identical message
 * the user would have seen in their terminal.
 */
export const DAEMON_CREDENTIAL_ERROR =
  'Daemon refuses to start: no authentication credential found in the environment.\n' +
  '\n' +
  'The daemon launches task containers that inherit its credential. Without one,\n' +
  'every container it spawns would come up unable to reach the model API.\n' +
  '\n' +
  'Set one of these in the environment the daemon runs in, then try again:\n' +
  '  • CLAUDE_CODE_OAUTH_TOKEN — generate with `claude setup-token`\n' +
  '  • ANTHROPIC_API_KEY       — your Anthropic API key\n' +
  '\n' +
  '(If you use a local model, enable [ollama] in lazy.toml instead.)\n' +
  '\n' +
  'A set-but-blank value counts as absent — check for an empty export.';
