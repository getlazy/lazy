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
 * The task's Claude Code profile selects its endpoint and tiers. The same
 * planner as a member-launched turn binds its payer, and launch auth turns
 * that binding into the profile's proxy grant. No project secret is read here.
 * Shell on another harness retains the built-in Claude environment.
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
import { ANTHROPIC_DEFAULT_TARGET, roleTargetForProfile } from '../config/default-target';
import { withLiveProxyTarget } from '../daemon/auth-env';
import {
  planTurnCredential,
  credentialEnvForPlan,
  releaseTurnCredential,
  TurnCredentialUnavailableError,
  NO_OWNER_CREDENTIAL_MARKER,
  sideLaunchCredentialProblem,
} from '../daemon/turn-credentials';
import { getLaunchAuthEnvVars } from '../capture/claude';
import { revokeBuilderCredentialGrant, revokeGrantsByLabelPrefix, pinGrantsToAddresses } from '../proxy/credential-broker';
import { getTaskSessionBinding, revokeBindingsByKeyPrefix, setSessionBindingOrigin } from '../daemon/session-credentials';
import { memberCredentialFor, memberProfileCredentialProblem } from '../daemon/member-credentials';
import { profileForAgentName, profileForAgentNameOrNull, resolveAgentProfiles } from '../config/agent-profiles';
import { teamModeEnabled } from '../daemon/user-credentials';
import { targetEnvOverrides } from '../utils/role-target';
import { logger } from '../utils/logger';
import { MEMBER_SESSION_HARNESSES } from '../agent/interactive-modes';
import { AGENT_KEY_ENV } from '../agent/credentials';
import { codexLaunchEnvVars } from '../proxy/codex-route';
import { cursorLaunchEnvVars } from '../proxy/cursor-route';
import { piLaunchEnvVars, piCredentialMirror } from '../agent/pi-turn-config';
import { DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from '../proxy/upstream-defaults';
import { getDaemonContext, hasDaemonContext } from '../daemon/context';
import type { ResolvedConfig } from '../config/types';
import type { AgentProfile } from '../config/agent-profiles';
import { blockMemberBinding, MEMBER_EXEC_BINDING_PREFIX } from '../daemon/member-recovery';
export { MEMBER_EXEC_BINDING_PREFIX } from '../daemon/member-recovery';

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

/**
 * The task's profile, when its harness can run in a member's own session
 * (Claude Code, Codex, Cursor, Pi): the member's container is created with
 * that profile's credential for the member, exactly as a turn the member
 * launches would be, and every Pair/Chat exec refreshes it. Any other harness
 * keeps Shell's plain Claude environment.
 */
export async function memberTerminalProfile(root: string, agentId?: string | null): Promise<string | undefined> {
  const profile = profileForAgentNameOrNull(await loadConfig(root), agentId);
  return profile && MEMBER_SESSION_HARNESSES.includes(profile.harness) ? profile.name : undefined;
}

/** Same member/profile gate as a turn, without allocating a binding during discovery. */
export async function memberTerminalCredentialProblem(root: string, email: string, profile?: string): Promise<string | null> {
  // Outside team mode a member must never inherit the daemon's service credential.
  if (!(await teamModeEnabled(root))) return memberCredentialMissingMessage(email);
  const problem = profile
    ? await sideLaunchCredentialProblem(root, email, profile)
    : await memberProfileCredentialProblem(root, email, resolveAgentProfiles(undefined).get('claude-code')!, await loadConfig(root));
  return problem
    ? `${problem} Connect the named endpoint in Lazy Teams under Connections (account, team, or project), then reopen the terminal.`
    : null;
}

/**
 * Every env var that can carry a model credential into an agent a member's
 * session runs: Claude Code's (Pi reads the same ones) and the Codex and
 * Cursor keys. Whichever the member's placeholder does not use is set EMPTY.
 */
export const MEMBER_EXEC_CREDENTIAL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...Object.values(AGENT_KEY_ENV)];

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
  /**
   * The binding key ({@link memberExecBindingKey}), recorded on the container
   * so a later daemon can re-adopt it. Absent: the container is never re-adopted.
   */
  key?: string;
}

/** The JIT grant label of one member container's credential. */
export function memberTerminalGrantLabel(memberEmail: string, container: string): string {
  return `${MEMBER_TERMINAL_GRANT_PREFIX}${memberEmail}:${container}`;
}

/**
 * Revoke one member container's binding and grant. Never throws. A fresh
 * container's `release`, and a re-adopted one's removal, both end here.
 */
export async function releaseMemberContainerCredential(root: string, key: string, label: string): Promise<void> {
  blockMemberBinding(root, key);
  await releaseTurnCredential(root, key);
  try {
    await revokeBuilderCredentialGrant(root, label);
  } catch (err) {
    logger.warn(`member terminal grant ${label} could not be revoked: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The binding key for one member container. Exported so tests can assert it is
 * never the task id itself.
 */
export function memberExecBindingKey(taskId: string): string {
  return `${MEMBER_EXEC_BINDING_PREFIX}${taskId}:${randomBytes(6).toString('hex')}`;
}

/** Every member container's JIT grant label starts with this, and nothing else's does. */
export const MEMBER_TERMINAL_GRANT_PREFIX = 'member-terminal:';

/** Refresh a reused container's Pair/Chat environment without rebinding its payer. */
export async function memberContainerProfileEnv(opts: {
  root: string; taskId: string; memberEmail: string; container: string; key: string; profile: string;
}): Promise<string[]> {
  const problem = await memberTerminalCredentialProblem(opts.root, opts.memberEmail, opts.profile);
  if (problem) throw new Error(problem);
  const binding = await getTaskSessionBinding(opts.root, opts.key);
  if (!binding || binding.revokedAt !== null || binding.ownerUserId !== opts.memberEmail.trim().toLowerCase()) {
    throw new Error('Your terminal credential is no longer active. Close this environment and reopen it.');
  }
  // The binding fixes the payer, not the current endpoint's auth form. A
  // retained gateway container may now launch an Anthropic OAuth profile.
  const config = await loadConfig(opts.root);
  const profile = profileForAgentName(config, opts.profile, 'member terminal');
  const credential = await memberCredentialFor(opts.root, binding.ownerUserId, profile, config);
  if (credential.kind === 'missing') throw new Error(credential.detail);
  const kind = credential.kind === 'credential' ? credential.record.kind : 'api-key';
  const credEnv = credentialEnvForPlan({ mode: 'session', token: binding.token, kind, ownerUserId: binding.ownerUserId, kindChanged: false })!;
  const env = await memberCredentialEnvironment(opts, credEnv);
  if (binding.origin) await pinGrantsToAddresses(opts.root, memberTerminalGrantLabel(opts.memberEmail, opts.container), [binding.origin]);
  return env.map(({ key, value }) => `${key}=${value}`);
}

async function memberCredentialEnvironment(opts: {
  root: string; taskId: string; memberEmail: string; container: string; key: string; profile?: string;
}, credEnv: Array<{ key: string; value: string }>): Promise<Array<{ key: string; value: string }>> {
  const config = await loadConfig(opts.root);
  const profile = opts.profile ? profileForAgentName(config, opts.profile, 'member terminal') : null;
  const rawTarget = profile ? roleTargetForProfile(profile) : ANTHROPIC_DEFAULT_TARGET;
  const target = await withLiveProxyTarget(rawTarget, config);
  const identity = {
    role: 'builder' as const, taskId: opts.taskId,
    label: memberTerminalGrantLabel(opts.memberEmail, opts.container),
    profile: rawTarget.profile, bindingKey: opts.key, projectRoot: opts.root,
  };
  const vars = targetEnvOverrides(await getLaunchAuthEnvVars(identity, target, { role: 'builder' }, 'container', credEnv));
  if (profile) vars.push(...harnessSessionEnv(profile, config, vars));
  const set = new Set(vars.map((v) => v.key));
  return [...MEMBER_EXEC_CREDENTIAL_KEYS.filter((k) => !set.has(k)).map((k) => ({ key: k, value: '' })), ...vars];
}

/**
 * What a Codex, Cursor or Pi session needs beside its credential, the same
 * values a task turn on that profile is launched with (src/capture/claude.ts):
 * Codex's and Cursor's proxy endpoints (the Cursor one carries the session's
 * own key placeholder) and Pi's provider and timeout settings plus the mirror
 * of an OAuth placeholder into the variable Pi reads. Nothing for Claude Code.
 * A member container runs on the container engine, so the proxy address is a
 * container's.
 */
function harnessSessionEnv(
  profile: AgentProfile,
  config: ResolvedConfig,
  vars: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const proxyPort = hasDaemonContext() ? getDaemonContext().proxyPort : undefined;
  const common = { harness: profile.harness, runnerType: 'docker' as const, proxyPort, bind: config.proxy.bind };
  return [
    ...codexLaunchEnvVars({ ...common, endpoint: profile.endpoint }),
    ...cursorLaunchEnvVars({ ...common, token: vars.find((v) => v.key === AGENT_KEY_ENV.cursor)?.value ?? null }),
    ...piLaunchEnvVars({
      harness: profile.harness,
      profile,
      upstreamTimeoutMs: (config.proxy.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS) * 1000,
    }),
    ...(profile.harness === 'pi' ? piCredentialMirror(vars) : []),
  ];
}

/**
 * Revoke every member container's binding and grant except the ones `keep`
 * names — those of the containers the startup sweep re-adopted
 * (src/daemon/member-leftovers.ts), whose environment cannot be changed and
 * whose placeholder must therefore keep resolving. Run at DAEMON STARTUP,
 * after that sweep: a container's credential is otherwise revoked only when
 * the daemon removes the container, which a restart (every fleet roll)
 * interrupts, so everything else this matches belongs to a container that is
 * gone.
 */
export async function revokeLeftoverMemberTerminalCredentials(
  root: string,
  keep: { bindingKeys: ReadonlySet<string>; grantLabels: ReadonlySet<string> } = { bindingKeys: new Set(), grantLabels: new Set() },
): Promise<{ bindings: number; grants: number }> {
  const bindings = await revokeBindingsByKeyPrefix(root, MEMBER_EXEC_BINDING_PREFIX, keep.bindingKeys);
  const grants = await revokeGrantsByLabelPrefix(root, MEMBER_TERMINAL_GRANT_PREFIX, keep.grantLabels);
  return { bindings, grants };
}

export async function planMemberContainerCredential(opts: {
  root: string;
  taskId: string;
  sessionId: string;
  memberEmail: string;
  /** The container this credential is minted for — names its grant. */
  container: string;
  /** Claude Code profile of the task, resolved by the daemon. */
  profile?: string;
}): Promise<{ ok: true; credential: MemberContainerCredential } | { ok: false; status: number; message: string }> {
  const problem = await memberTerminalCredentialProblem(opts.root, opts.memberEmail, opts.profile);
  if (problem) return { ok: false, status: 400, message: problem };
  const key = memberExecBindingKey(opts.taskId);
  let plan;
  try {
    plan = await planTurnCredential(opts.root, {
      taskId: key,
      sessionId: opts.sessionId,
      spender: { email: opts.memberEmail },
      ...(opts.profile ? { spenderProfile: opts.profile } : {}),
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
  const label = memberTerminalGrantLabel(opts.memberEmail, opts.container);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseMemberContainerCredential(opts.root, key, label);
  };

  try {
    const env = await memberCredentialEnvironment({ ...opts, key }, credEnv);
    return {
      ok: true,
      credential: {
        env, release, key,
        pinOrigin: async (address) => {
          await setSessionBindingOrigin(opts.root, key, address);
          await pinGrantsToAddresses(opts.root, label, [address]);
        },
      },
    };
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
