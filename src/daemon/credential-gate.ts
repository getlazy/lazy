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
 */

import { loadConfig } from '../config/loader';

/**
 * Throw an actionable error if the daemon's environment has no usable model
 * credential. Mirrors the runner's existing auth logic: when `[ollama]` is
 * enabled the daemon uses local dummy credentials and needs no Anthropic token,
 * so the gate is skipped in that case.
 *
 * @param projectRoot - Project root (used to read lazy.toml for the ollama flag)
 */
export async function assertDaemonCredentials(projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);

  // Ollama-backed setups talk to a local model with dummy credentials — no
  // Claude/Anthropic token is required, matching runner.checkAvailability().
  if (config.ollama.enabled) return;

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return;

  throw new Error(
    'Daemon refuses to start: no authentication credential found in the environment.\n' +
    '\n' +
    'The daemon launches task containers that inherit its credential. Without one,\n' +
    'every container it spawns would come up unable to reach the model API.\n' +
    '\n' +
    'Set one of these in the environment the daemon runs in, then try again:\n' +
    '  • CLAUDE_CODE_OAUTH_TOKEN — generate with `claude setup-token`\n' +
    '  • ANTHROPIC_API_KEY       — your Anthropic API key\n' +
    '\n' +
    '(If you use a local model, enable [ollama] in lazy.toml instead.)',
  );
}
