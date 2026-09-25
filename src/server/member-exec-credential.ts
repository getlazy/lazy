/**
 * The credential a MEMBER's own terminal container runs on, on a shared daemon.
 *
 * A member's terminals (Shell, Pair, Chat — reached through Teams on
 * `/rpc/sessions/:id/attach/ws`) run in a container of the member's OWN
 * (src/daemon/member-container.ts), never in the task's. That container is
 * created with exactly one credential in its environment: a placeholder bound
 * to the member, resolved by the proxy to that member's own stored credential —
 * the same shape a daemon-owned builder session launches with
 * (`planTurnCredential` with a `spender`). It is minted for the container and
 * revoked when the container is removed.
 *
 * ALWAYS the member's credential, on Anthropic's own wire. The target is the
 * built-in Anthropic default, never a configured profile: a profile naming its
 * own credential is preferred over the member's placeholder
 * (`getLaunchAuthEnvVars` resolves the profile's slot first), so resolving one
 * here would let a member's `claude` spend the project's key under their name.
 *
 * Keyed per container, not per task: the binding registry holds one binding per
 * key, and a task's own turn binding is keyed by the task id — sharing it would
 * re-point the next turn's placeholder, and releasing it would revoke a turn's.
 *
 * A member with no stored credential is refused with the existing
 * NO_OWNER_CREDENTIAL_MARKER shape, which Teams already turns into "connect
 * your Claude account" — INCLUDING on a shared daemon outside team mode, where
 * `planTurnCredential` answers `daemon-env`. That answer means "spend the
 * daemon's own (service) credential", which is right for a laptop and for
 * automation, and wrong for a member's terminal: per-user billing never falls
 * back silently. This function is only ever called for a member on a shared
 * daemon, so it never returns without the member's own credential.
 */

import { randomBytes } from 'crypto';
import { loadConfig } from '../config/loader';
import { ANTHROPIC_DEFAULT_TARGET } from '../config/default-target';
import { withLiveProxyTarget } from '../daemon/auth-env';
import {
  planTurnCredential,
  credentialEnvForPlan,
  releaseTurnCredential,
  TurnCredentialUnavailableError,
  NO_OWNER_CREDENTIAL_MARKER,
} from '../daemon/turn-credentials';
import { getLaunchAuthEnvVars } from '../capture/claude';
import { revokeBuilderCredentialGrant, revokeGrantsByLabelPrefix } from '../proxy/credential-broker';
import { revokeBindingsByKeyPrefix, setSessionBindingOrigin } from '../daemon/session-credentials';
import { logger } from '../utils/logger';

/**
 * Why a member's terminal is refused for want of their own credential. Starts
 * with NO_OWNER_CREDENTIAL_MARKER, the prefix Teams recognises.
 */
export function memberCredentialMissingMessage(email: string): string {
  return (
    `${NO_OWNER_CREDENTIAL_MARKER}: a terminal in a task's environment runs on your own Claude account, and none is ` +
    `stored for ${email} on this project. Connect your Claude account (in Lazy Teams: your account's Claude settings), ` +
    `then open the terminal again.`
  );
}

/** Every env var that can carry a model credential into Claude Code. */
export const MEMBER_EXEC_CREDENTIAL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export interface MemberContainerCredential {
  /**
   * The container's credential environment. Every key in
   * {@link MEMBER_EXEC_CREDENTIAL_KEYS} the placeholder does not use is set
   * EMPTY, so an image that bakes one in cannot put it beside the member's.
   */
  env: Array<{ key: string; value: string }>;
  /** Revoke the container's binding and grant. Idempotent, never throws. */
  release: () => Promise<void>;
  /**
   * Pin the placeholder to the container's network address: from then on the
   * proxy refuses it from anywhere else. Throws when it cannot be pinned.
   */
  pinOrigin: (address: string) => Promise<void>;
}

/**
 * The binding key for one member container. Exported so tests can assert it is
 * never the task id itself.
 */
export function memberExecBindingKey(taskId: string): string {
  return `${MEMBER_EXEC_BINDING_PREFIX}${taskId}:${randomBytes(6).toString('hex')}`;
}

/** Every member container's binding key starts with this, and nothing else's does. */
export const MEMBER_EXEC_BINDING_PREFIX = 'member-exec:';
/** Every member container's JIT grant label starts with this, and nothing else's does. */
export const MEMBER_TERMINAL_GRANT_PREFIX = 'member-terminal:';

/**
 * Revoke every member container's binding and grant. Run at DAEMON STARTUP:
 * a container's credential is otherwise revoked only when the daemon removes
 * the container, which a restart (every fleet roll) interrupts. No member
 * terminal survives a restart (its socket dies with the process, and the
 * startup sweep removes the containers too), so everything this matches is a
 * leftover.
 */
export async function revokeLeftoverMemberTerminalCredentials(root: string): Promise<{ bindings: number; grants: number }> {
  const bindings = await revokeBindingsByKeyPrefix(root, MEMBER_EXEC_BINDING_PREFIX);
  const grants = await revokeGrantsByLabelPrefix(root, MEMBER_TERMINAL_GRANT_PREFIX);
  return { bindings, grants };
}

export async function planMemberContainerCredential(opts: {
  root: string;
  taskId: string;
  sessionId: string;
  memberEmail: string;
  /** The container this credential is minted for — names its grant. */
  container: string;
}): Promise<{ ok: true; credential: MemberContainerCredential } | { ok: false; status: number; message: string }> {
  const key = memberExecBindingKey(opts.taskId);
  let plan;
  try {
    plan = await planTurnCredential(opts.root, {
      taskId: key,
      sessionId: opts.sessionId,
      spender: { email: opts.memberEmail },
    });
  } catch (err) {
    if (err instanceof TurnCredentialUnavailableError) return { ok: false, status: 400, message: err.message };
    throw err;
  }
  const credEnv = credentialEnvForPlan(plan);
  if (!credEnv) {
    // `daemon-env`: no member of this daemon has a credential stored (team
    // mode is off), so the member's terminal would run on the daemon's own
    // account. Refuse, the same way a member with no credential is refused in
    // team mode, so the page offers "connect your Claude account".
    return { ok: false, status: 400, message: memberCredentialMissingMessage(opts.memberEmail) };
  }

  // Should anything on the way ever placeholderize a real value, the JIT grant
  // it mints is labelled for this container and dies with it.
  const label = `${MEMBER_TERMINAL_GRANT_PREFIX}${opts.memberEmail}:${opts.container}`;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseTurnCredential(opts.root, key);
    try {
      await revokeBuilderCredentialGrant(opts.root, label);
    } catch (err) {
      logger.warn(`member terminal grant ${label} could not be revoked: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    const config = await loadConfig(opts.root);
    const target = await withLiveProxyTarget(ANTHROPIC_DEFAULT_TARGET, config);
    const identity = {
      role: 'builder' as const,
      taskId: opts.taskId,
      label,
      profile: ANTHROPIC_DEFAULT_TARGET.profile,
    };
    const vars = await getLaunchAuthEnvVars(identity, target, { role: 'builder' }, 'container', credEnv);
    const set = new Set(vars.map((v) => v.key));
    const env = [
      ...MEMBER_EXEC_CREDENTIAL_KEYS.filter((k) => !set.has(k)).map((k) => ({ key: k, value: '' })),
      ...vars,
    ];
    return { ok: true, credential: { env, release, pinOrigin: (address) => setSessionBindingOrigin(opts.root, key, address) } };
  } catch (err) {
    await release();
    logger.warn(`member terminal credential could not be prepared: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      status: 500,
      message: `Could not prepare your credential for this terminal: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
