/**
 * Install a turn's session placeholder in the supervisor's own env, so the agent
 * it is about to spawn (which inherits that env) presents the credential THIS
 * turn runs on.
 *
 * A task's container is reused across turns and keeps the task's services
 * running between them, but its env is fixed at create. In team mode the
 * placeholder's env var follows the turn owner's credential KIND
 * (`CLAUDE_CODE_OAUTH_TOKEN` for OAuth, `ANTHROPIC_API_KEY` for an API key), and
 * a kind change mints a new placeholder value. The daemon used to answer such a
 * turn by recreating the container, which killed the services a person was
 * using. Now every team-mode work command carries the placeholder and its env
 * var (`session_credential_env`, built by turnCredentialCommandEnv in
 * src/daemon/turn-credentials.ts), and this applies it.
 *
 * Bounded on purpose:
 *   - Only when the env ALREADY holds a session placeholder in one of the
 *     Anthropic credential vars — i.e. the container was launched in team mode
 *     for a harness that is given one. A container launched without one (a codex
 *     or cursor task, whose launch withholds the Anthropic credential) is never
 *     handed one by a command.
 *   - Only `lazy-sess-` values are removed. A real credential is never touched.
 *   - pi reads `ANTHROPIC_AUTH_TOKEN` rather than `CLAUDE_CODE_OAUTH_TOKEN`, so an
 *     OAuth placeholder is mirrored there for pi exactly as the launch mirrors it
 *     (piCredentialMirror).
 */

import { isSessionPlaceholderToken } from '../daemon/session-credentials';
import { piCredentialMirror } from '../agent/pi-turn-config';

/** The env vars a session placeholder can live in (see the launch's piCredentialMirror). */
export const SESSION_PLACEHOLDER_ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * What to change in `env` for a turn carrying `credential`: keys to set and keys
 * to remove. Pure, so the decision is testable without touching process.env.
 */
export function turnCredentialEnvChanges(
  env: Record<string, string | undefined>,
  credential: Array<{ key: string; value: string }> | undefined,
  harness: string | undefined,
): { set: Record<string, string>; unset: string[] } {
  const none = { set: {}, unset: [] };
  if (!credential || credential.length === 0) return none;
  const holding = SESSION_PLACEHOLDER_ENV_KEYS.filter((k) => {
    const v = env[k];
    return typeof v === 'string' && isSessionPlaceholderToken(v);
  });
  if (holding.length === 0) return none;
  // Only placeholder values, only into the Anthropic credential vars.
  const wanted = credential.filter(
    (c) => (SESSION_PLACEHOLDER_ENV_KEYS as readonly string[]).includes(c.key) && isSessionPlaceholderToken(c.value),
  );
  if (wanted.length === 0) return none;
  const all = harness === 'pi' ? [...wanted, ...piCredentialMirror(wanted)] : wanted;
  const set: Record<string, string> = {};
  for (const c of all) set[c.key] = c.value;
  return { set, unset: holding.filter((k) => !(k in set)) };
}

/** Apply turnCredentialEnvChanges to this process's env. Returns whether anything changed. */
export function applyTurnCredentialEnv(
  credential: Array<{ key: string; value: string }> | undefined,
  harness: string | undefined,
): boolean {
  const { set, unset } = turnCredentialEnvChanges(process.env, credential, harness);
  let changed = false;
  for (const key of unset) {
    delete process.env[key];
    changed = true;
  }
  for (const [key, value] of Object.entries(set)) {
    if (process.env[key] !== value) changed = true;
    process.env[key] = value;
  }
  return changed;
}
