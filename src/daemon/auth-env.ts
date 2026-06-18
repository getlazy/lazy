/**
 * Client-side auth env resolution — source the model credential from the daemon.
 *
 * The daemon is the single owner of credentials (see credential-gate.ts). Most
 * containers inherit the daemon's environment because the daemon spawns them.
 * But some launch paths run in the CLI CLIENT process and spawn their OWN
 * container — most notably `lazy builder`. In a daemon-only-env deployment the
 * user's interactive shell legitimately has no credential, so reading the
 * client's `process.env` to populate the container's auth would wrongly fail
 * with "Authentication required" even though the daemon holds a valid token.
 *
 * This helper closes that gap: client launch paths call it to obtain the auth
 * env from the daemon over RPC, never from their own environment.
 *
 * Secrets hygiene: the credential travels over the local, token-authenticated
 * unix socket only and is never written to disk or logged here.
 */

import { tryRpc } from './client';
import { getAuthEnvVars } from '../capture/claude';
import type { RoleTarget } from '../config/types';
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET } from '../utils/role-target';

export interface AuthEnvVar {
  key: string;
  value: string;
}

/**
 * Resolve the auth env vars for a client-launched container, preferring the
 * daemon as the credential source.
 *
 * - Ollama: dummy local credentials, no daemon needed — computed in-process.
 * - anthropic/proxy: the Anthropic credential is fetched from the daemon via the
 *   `getAuthEnv` RPC, then wrapped for the target (proxy prepends its base URL).
 * - Test (LAZY_TEST=1) / daemon-self (LAZY_IS_DAEMON=1): `tryRpc` returns null,
 *   so we fall back to the local env — in those modes the credential lives in
 *   this very process (tests set it; the daemon process holds it directly).
 */
export async function resolveAuthEnvFromDaemon(
  target?: RoleTarget,
): Promise<AuthEnvVar[]> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;

  // Ollama-backed setups use local dummy credentials — the daemon adds nothing.
  if (resolved.backend === 'ollama') {
    return targetEnvVars(resolved, []);
  }

  // anthropic/proxy: source the real Anthropic credential, preferring the daemon.
  const rpc = await tryRpc<{ authEnvVars: AuthEnvVar[] }>('getAuthEnv', {});
  if (rpc) {
    // The RPC returns the bare Anthropic credential; for proxy targets the base
    // URL must still be layered on top here.
    return resolved.backend === 'proxy'
      ? targetEnvVars(resolved, rpc.authEnvVars)
      : rpc.authEnvVars;
  }

  // Daemon bypassed (test or daemon-self mode): the credential is in this
  // process. getAuthEnvVars throws an actionable error if it is genuinely
  // absent, which is the correct behavior for those modes.
  return getAuthEnvVars(resolved);
}
