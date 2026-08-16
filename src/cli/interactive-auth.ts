/**
 * The launch environment for lazy's INTERACTIVE Claude Code sessions —
 * `lazy pair` (task mode and branchless) and `lazy chat`.
 *
 * WHY THIS EXISTS — the credential comes from the DAEMON, never from the shell.
 *
 * These three surfaces spawn Claude Code as a host process from the CLI client.
 * They used to fill in the model credential from their own `process.env`
 * (`anthropicEnvVarsFromProcess`), which asks a different question than the rest
 * of lazy answers: the daemon is the single credential owner (see
 * credential-gate.ts) and refuses to start without one. In a daemon-only-env
 * setup — or simply a shell opened after the daemon was started, which is what
 * an upgrade leaves behind — the human's shell exports nothing, so pairing
 * handed Claude Code no credential at all and it fell through to the host
 * `~/.claude` store, or to a `/login` prompt, while task agents kept running
 * fine on the daemon's token.
 *
 * So: daemon credentials win, unconditionally. There is deliberately NO config
 * key, precedence chain, or "prefer the host store when it has one" heuristic.
 * A human who wants their own login can type `/login` inside the session — an
 * explicit override beats an implicit fallback nobody can see.
 *
 * This is the SINGLE seam all three call sites use, so role resolution,
 * reachability preflight, surface conversion and credential sourcing cannot
 * drift between them.
 *
 * ── Why pairing does NOT shadow ~/.claude/.credentials.json ─────────────────
 *
 * The builder shadows that file (see src/builder/claude-home.ts): Claude Code's
 * 401-recovery path reads the credential store off disk and adopts a different
 * token it finds there, which silently swapped the builder's good daemon token
 * for the human's stale host one. Pair and chat are exposed to the same recovery
 * path, so the question is real — but the answer is no, for two reasons.
 *
 * 1. It is not the same failure. The builder ran in a CONTAINER, where the human
 *    could neither see nor intend the swap, and where lazy had mounted a store
 *    that authentication was never supposed to use. Pair and chat run as HOST
 *    processes in the human's own shell, on their own machine, against their own
 *    store. A recovery that falls back to that store lands on the credential
 *    they would have got by typing `/login` — the sanctioned override — rather
 *    than on a store lazy mounted behind their back.
 *
 * 2. The only way to shadow it here is to repoint CLAUDE_CONFIG_DIR, and that
 *    costs far more than it buys. That directory also holds settings, custom
 *    commands, agents, plugins, MCP approvals, per-project trust and theme, and
 *    it is where an interactive `/login` PERSISTS its result. Redirecting it
 *    would strip the human's own configuration out of their own session and make
 *    `/login` forget itself on exit — breaking the exact escape hatch this
 *    design depends on. Pair deliberately leaves CLAUDE_CONFIG_DIR alone (see
 *    the comment in commands/pair.ts).
 *
 * So the host store stays reachable, and a 401 mid-session can still fall back
 * to it. What changed is that it is no longer the FIRST thing consulted: the
 * session now starts on the daemon credential every time.
 *
 * Secrets hygiene: the credential travels over the local, token-authenticated
 * unix socket and is never logged or written to disk. Diagnostics below name
 * the env var CARRYING a credential, never its value.
 */

import { loadConfig } from '../config/loader';
import { resolveRoleTarget, preflightRoleTarget, type LaunchSurface } from '../utils/role-target';
import { resolveAuthEnvFromDaemon, withLiveProxyTarget, type AuthEnvVar } from '../daemon/auth-env';
import { credentialFromEnv } from '../daemon/credential-gate';
import type { RoleTarget } from '../config/types';

/** Env keys that can carry a usable model credential to Claude Code. */
const CREDENTIAL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * `lazy pair` / `lazy chat` resolved no model credential from any source.
 *
 * Fails BEFORE the launch, naming every source checked and what was found in
 * it. The alternative — launching anyway — is the bug this task fixed: Claude
 * Code comes up, silently falls back to whatever is in the host store, and the
 * human discovers it as a `/login` prompt minutes into a session they thought
 * was authenticated. Same contract as the builder's MCP preflight
 * (src/builder/mcp-config-check.ts): throw, never warn.
 */
export class InteractiveCredentialError extends Error {
  constructor(command: string, daemonDetail: string, shellVar: string | null) {
    super(
      `${command} could not resolve a model credential, so Claude Code would come up unauthenticated.\n\n` +
      `Sources checked:\n` +
      `  - the lazy daemon (the credential owner, and the only source used here): ${daemonDetail}\n` +
      `  - this shell: ${shellVar ? `${shellVar} is set, and is deliberately NOT used` : 'no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY'}\n\n` +
      `lazy sources interactive credentials from the daemon so that pairing, chat and task\n` +
      `agents all run on the same token. Your shell is not consulted — if you want your own\n` +
      `login instead, run ${command} and type /login inside the session.\n\n` +
      `What to do:\n` +
      `  - Check the daemon:   lazy daemon status\n` +
      `  - Restart it from a shell that HAS the credential exported:  lazy daemon restart\n` +
      `  - Full diagnosis:     lazy doctor`,
    );
    this.name = 'InteractiveCredentialError';
  }
}

/** True when these env vars carry something Claude Code can authenticate with. */
function hasCredential(envVars: AuthEnvVar[]): boolean {
  return envVars.some(v => CREDENTIAL_KEYS.includes(v.key) && v.value.trim().length > 0);
}

/**
 * Resolve the role target and launch env for an interactive Claude Code session.
 *
 * `command` is the user-facing command name (`lazy pair`, `lazy chat`) and is
 * used only in the failure message.
 *
 * The surface is always `'host'`: pair and chat run Claude Code as a HOST
 * process even on a docker-runner project, so every address handed to it must
 * be host-reachable — the same conversion `preflightRoleTarget` probed. See
 * {@link LaunchSurface}.
 *
 * The target goes through `withLiveProxyTarget` FIRST, and `config` is then
 * passed to `resolveAuthEnvFromDaemon` as well. Both arm the fail-loud proxy
 * gate: with `[proxy]` enabled, a launch that cannot reach the audit plane fails
 * instead of connecting direct.
 *
 * The first call is not redundant, though it looks it — `resolveAuthEnvFromDaemon`
 * would report the live proxy address on the same RPC that carries the
 * credential. But when that RPC is BYPASSED (test / daemon-self mode) it falls
 * through to a local-env branch that never consults the gate at all, so dropping
 * `withLiveProxyTarget` silently disarmed the gate for those modes and let a
 * launch proceed unproxied. `withLiveProxyTarget` checks the bypass explicitly
 * (`proxyGateBypassed`), which is what `test/e2e/proxy-fail-loud.test.ts`
 * exercises via `LAZY_FORCE_PROXY_GATE=1`. Keep both.
 */
export async function resolveInteractiveLaunch(
  root: string,
  command: string,
): Promise<{ target: RoleTarget; envVars: AuthEnvVar[] }> {
  const config = await loadConfig(root);
  // pair and chat are both interactive BUILDER sessions. A local backend
  // (ollama/proxy) forces its model and base-URL env; preflight fails hard if it
  // is unreachable rather than silently using anthropic.
  const target = resolveRoleTarget('builder', config);
  await preflightRoleTarget('builder', target);

  const surface: LaunchSurface = 'host';
  const proxied = await withLiveProxyTarget(target, config);
  const envVars = await resolveAuthEnvFromDaemon(proxied, { role: 'builder' }, surface, config);

  // Ollama-backed roles authenticate against a local server with a dummy token,
  // so there is no daemon credential to check for and nothing to fail on.
  if (proxied.backend !== 'ollama' && !hasCredential(envVars)) {
    // Only "the daemon answered but held nothing" reaches here. The other two
    // ways to end up credential-less both throw before this point, each with a
    // message that fits its own situation: an UNREACHABLE daemon throws out of
    // the RPC above, and the RPC BYPASS modes (LAZY_TEST / LAZY_IS_DAEMON,
    // neither of which a human ever runs `lazy pair` under) fall through to
    // `getAuthEnvVars`, where the credential really is expected in this
    // process's own env and "set CLAUDE_CODE_OAUTH_TOKEN" really is the fix.
    throw new InteractiveCredentialError(
      command,
      'reachable, but it reported no credential',
      credentialFromEnv(),
    );
  }
  // The PROXIED target, not the raw one — it is what `envVars` was built from,
  // so a caller reading `.model` off it cannot disagree with the env it ships.
  return { target: proxied, envVars };
}

/** The resolved launch env as a spawn-ready `env` overlay. */
export function launchEnvOverlay(envVars: AuthEnvVar[]): Record<string, string> {
  return Object.fromEntries(envVars.map(v => [v.key, v.value]));
}
