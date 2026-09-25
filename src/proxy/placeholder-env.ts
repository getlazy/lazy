/**
 * The launch-side half of JIT credential injection: turn a set of REAL
 * credential env vars into placeholders before they are handed to a process.
 *
 * Every launch path (docker supervisor, host-process supervisor, builder
 * container, the `getAuthEnv` RPC) funnels its credential env through here, so
 * "does this launch hold a real secret?" is one function's answer rather than a
 * property each call site has to remember to preserve.
 *
 * WHEN IT IS SAFE TO SWAP: only when the traffic will actually reach lazy's
 * proxy, because only the proxy can put the real credential back. Every role's
 * traffic does now, so in practice the answer is "whenever a live proxy address
 * was resolved" — but the decision is still NOT made here: the caller passes
 * `proxied`, which it knows from the resolved role target far more reliably
 * than this module could infer it. The launches that still keep a real
 * credential are the ones with no daemon to mint against (the in-container
 * supervisor, daemonless test modes), documented at each call site.
 */

import type { GrantRole } from './credential-broker';
import { mintCredentialGrant } from './credential-broker';
import { isCredentialEnvKey } from '../utils/redact';

export interface AuthEnvVar {
  key: string;
  value: string;
}

/** Which launch a placeholder is minted for. */
export interface LaunchIdentity {
  role: GrantRole;
  /** Task the launch belongs to; null/undefined for the taskless builder. */
  taskId?: string | null;
  /**
   * Human-readable name for the launch — container name, session name. Only
   * distinguishes builder sessions from each other; diagnostics otherwise.
   */
  label: string;
  /**
   * Agent profile this launch runs, which is what the proxy routes by.
   *
   * REQUIRED, in the same spirit as `LaunchSurface` on the role target: a launch
   * always knows which profile it is launching, and an optional field here would
   * make "routed to the primary upstream" the silent default for a call site
   * that simply forgot to pass one. Legacy grants already on disk are the only
   * profile-less case, and they are handled where they actually arise — at
   * lookup, not at mint.
   */
  profile: string;
}

/**
 * Replace every credential VALUE with a per-launch placeholder, keeping the key.
 *
 * The key is preserved deliberately: the client picks its auth wire shape from
 * which variable is set (`CLAUDE_CODE_OAUTH_TOKEN` → `Authorization: Bearer`,
 * `ANTHROPIC_API_KEY` → `x-api-key`), so swapping only the value leaves the
 * request byte-identical apart from the secret — and the proxy's job is then a
 * pure substitution rather than a protocol translation.
 *
 * Non-credential vars (ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, the
 * ollama stability flags) pass through untouched.
 */
export async function placeholderizeAuthEnv(
  projectRoot: string,
  vars: AuthEnvVar[],
  identity: LaunchIdentity,
): Promise<AuthEnvVar[]> {
  const out: AuthEnvVar[] = [];
  for (const v of vars) {
    if (!isCredentialEnvKey(v.key)) {
      out.push(v);
      continue;
    }
    const token = await mintCredentialGrant(projectRoot, {
      role: identity.role,
      taskId: identity.taskId ?? null,
      label: identity.label,
      envKey: v.key,
      profile: identity.profile,
    });
    out.push({ key: v.key, value: token });
  }
  return out;
}
