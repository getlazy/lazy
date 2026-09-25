/**
 * Which credential a turn runs on — the one place that decides.
 *
 * Two mechanisms, one of which is dormant unless a control plane put a per-user
 * credential in this daemon (see `teamModeEnabled`):
 *
 *   NO-RAILS DEFAULT (every single-user install, unchanged). The launch path
 *   reads the daemon's own process env, the container gets the real token, and
 *   the proxy forwards its auth header verbatim. Nothing here runs.
 *
 *   TEAM MODE. The turn's owner is the human who initiated it; the container
 *   gets a placeholder bound to that owner, and the proxy swaps it. A turn the
 *   daemon starts by itself (auto-deliver, sync) has no human behind it and
 *   runs on the project's SERVICE credential — and if the project has not
 *   configured one, the automation is disabled with a stated reason instead of
 *   quietly billing whichever member happened to touch the task last (§3.2).
 */

import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';
import { memberInsideTask, memberInsideLaunchMessage } from '../server/member-terminals';
import { RpcError } from './rpc-error';
import {
  getServiceCredential,
  getUserCredential,
  teamModeEnabled,
  SERVICE_CREDENTIAL_USER_ID,
  type UserCredentialKind,
} from './user-credentials';
import {
  bindTurnCredential,
  getTaskSessionBinding,
  lookupSessionBinding,
  revokeTaskSessionBinding,
  SESSION_TOKEN_PREFIX,
} from './session-credentials';
import { getPendingTurnOwner, recordSessionTurnOwner } from './turn-owner';
import type { SessionCredentialLookup, SessionRequestContext } from '../proxy/session-auth';
import type { Storage } from '../storage/interface';
import type { TurnOwner } from '../types';

/**
 * The principal whose credential this turn spends, or null.
 *
 * Read from the pending turn owner (./turn-owner.ts) — the owner of the
 * request this launch runs inside, the same answer attribution uses, so "whose
 * turn is this" is asked once and answered once — and narrowed here to an owner this daemon may SPEND: a person a control plane
 * authenticated with a per-user token. A laptop's git identity names the person
 * for attribution but is not an account the credential registry was ever asked
 * to provision, so billing keeps its existing answer for it (the daemon's own
 * env, or the service credential) rather than refusing the turn because nobody
 * put a credential under that address.
 *
 * A turn the daemon starts by itself — outside any request, including one that
 * runs WHILE a member's request on the same task is still in flight — and a
 * turn relaunched after a daemon restart therefore have no spendable owner and
 * run on the service credential (or are refused), which is the safe direction
 * for MONEY. Attribution is the other half and is durable — see ./turn-owner.ts.
 */
export function getTurnOwner(taskId: string): string | null {
  const pending = getPendingTurnOwner(taskId);
  return pending?.spendable ? pending.email : null;
}

export type TurnCredentialPlan =
  /** Use the daemon's process env, exactly as lazy always has. */
  | { mode: 'daemon-env' }
  /** Inject a placeholder bound to `ownerUserId`, in the kind-mirrored env var. */
  | {
      mode: 'session';
      token: string;
      kind: UserCredentialKind;
      ownerUserId: string;
      /** True when the container must be recreated — see session-credentials.ts. */
      kindChanged: boolean;
    };

/**
 * Error thrown when a team-mode project cannot attribute a turn to anyone.
 *
 * Deliberately an error and not a fallback: the fallback would be to spend
 * somebody's money without their say-so.
 */
/**
 * The stable prefix on the refusal a control plane can actually act on: the
 * human who asked for this turn has no credential here.
 *
 * A marker rather than a new error field because `RpcError` carries a status
 * and a message and nothing else, and the whole wire — daemon route, HTTP
 * status, client — already reads that way. Rails matches this prefix to turn a
 * 400 into "connect your Claude account" instead of a generic refusal, exactly
 * as it already matches the project-mismatch marker. Changing this string is a
 * wire change: `lazy-teams/app/clients/lazy_daemon/client.rb` names it too.
 */
export const NO_OWNER_CREDENTIAL_MARKER = 'No Anthropic credential for this user';

/** Same, for a turn nobody asked for and no service credential to pay for it. */
export const NO_SERVICE_CREDENTIAL_MARKER = 'No service credential for automated turns';

export class TurnCredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnCredentialUnavailableError';
  }
}

/**
 * Decide, and bind, the credential for the turn about to launch.
 *
 * @param taskId    task UUID (the key the launch path and the registry share)
 * @param sessionId the session this turn belongs to
 * @param spender   a named payer for a launch that is NOT one of the task's own
 *                  turns — see below
 */
export async function planTurnCredential(
  projectRoot: string,
  input: {
    taskId: string;
    sessionId: string;
    storage?: Storage;
    /**
     * WHO PAYS, for a launch that runs BESIDE a task rather than as one of its
     * turns — today, the builder of a review conversation, which spends the
     * reviewer's credential (§3.6).
     *
     * Such a launch must not decide the task's turn owner, and this parameter
     * is what lets it say so. The owner decides a NAME as well as a
     * credential, and a reviewer is not the person who asked for the task's
     * next turn — stamping them there is the §3.3 case 3 inheritance the
     * clearing direction exists to prevent, reached through a different door.
     *
     * A spender therefore records NO turn owner: the session id here is a
     * review session, not one of the task's, and the task's own current owner
     * is none of this launch's business.
     */
    spender?: TurnOwner;
  },
): Promise<TurnCredentialPlan> {
  // ATTRIBUTION FIRST, and unconditionally — before the team-mode question,
  // which decides only who PAYS. This function is the one thing every
  // turn-launch path calls with the task and session about to run, so recording
  // the owner here is what makes the record complete on a laptop as well as on
  // a fleet host, and what makes a launch path added later carry it without
  // knowing this exists. See ./turn-owner.ts.
  if (!input.spender) await recordSessionTurnOwner(input);

  if (!(await teamModeEnabled(projectRoot))) return { mode: 'daemon-env' };

  const ownerUserId = input.spender?.email ?? getTurnOwner(input.taskId);
  if (ownerUserId) {
    const credential = await getUserCredential(projectRoot, ownerUserId);
    if (!credential) {
      throw new TurnCredentialUnavailableError(
        `${NO_OWNER_CREDENTIAL_MARKER}: this turn was initiated by user '${ownerUserId}', who has ` +
        `no Anthropic credential stored in this daemon. The control plane must call ` +
        `putUserCredential for that user before their turns can run.`,
      );
    }
    const bound = await bindTurnCredential(projectRoot, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      ownerUserId,
      kind: credential.kind,
    });
    return { mode: 'session', token: bound.token, kind: credential.kind, ownerUserId, kindChanged: bound.kindChanged };
  }

  // System-initiated: no human asked for this turn.
  const service = await getServiceCredential(projectRoot);
  if (!service) {
    throw new TurnCredentialUnavailableError(systemTurnBlockedReason());
  }
  const bound = await bindTurnCredential(projectRoot, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    ownerUserId: SERVICE_CREDENTIAL_USER_ID,
    kind: service.kind,
  });
  return {
    mode: 'session',
    token: bound.token,
    kind: service.kind,
    ownerUserId: SERVICE_CREDENTIAL_USER_ID,
    kindChanged: bound.kindChanged,
  };
}

/**
 * What every turn-launching path calls before it launches: decide and bind the
 * credential, and say whether the running container (if any) can be reused.
 *
 * Returns `{mustRecreateContainer: false}` for every single-user install that has
 * no leftover binding, so the launch paths keep their existing container-reuse
 * behavior untouched.
 *
 * CALL IT BEFORE the turn's command is written and before the task moves to
 * `working`. A binding is revoked when its turn's process exits, and a
 * supervisor that outlived its daemon — the daemon crashed rather than stopped,
 * which is exactly what a "restart then resume" looks like — picks the next
 * command up the instant it lands. Binding afterwards leaves a window in which
 * the agent is already talking to the proxy on a revoked placeholder: 401,
 * classified `fatal_auth`, non-retryable, turn dead on attempt one.
 *
 * Throws `RpcError(400)` — not a silent fallback — when the project runs per-user
 * credentials and this turn cannot be attributed to anyone.
 */
export async function prepareTurnLaunch(
  projectRoot: string,
  input: { taskId: string; sessionId: string; storage?: Storage },
): Promise<{ mustRecreateContainer: boolean }> {
  try {
    const plan = await planTurnCredential(projectRoot, input);
    return {
      mustRecreateContainer: await mustRecreateForCredentialPlan(projectRoot, input.taskId, plan),
    };
  } catch (err) {
    if (err instanceof TurnCredentialUnavailableError) throw new RpcError(400, err.message);
    throw err;
  }
}

/**
 * Whether the task's running container (if any) can carry this plan's
 * credential, or has to be recreated. The one place that decides, for both the
 * RPC turn paths and the daemon's own automations.
 *
 * Two ways a running container's env can be wrong for the turn about to start:
 *
 *   KIND CHANGED — the placeholder has to move to a different env var, and a
 *   running container's env cannot be changed.
 *
 *   LEFTOVER PLACEHOLDER — the plan says use the daemon's own credential, but
 *   this task has a binding, so its container was launched holding a
 *   `lazy-sess-…` placeholder that nothing on the daemon-env path re-points.
 *   Reusing it runs the whole turn on a token the proxy resolves to nobody:
 *   401 on the agent's first request, `fatal_auth`, turn dead on attempt one.
 */
export async function mustRecreateForCredentialPlan(
  projectRoot: string,
  taskId: string,
  plan: TurnCredentialPlan,
): Promise<boolean> {
  // A MEMBER IS WORKING IN THE TASK (a Teams terminal): no turn starts until
  // they leave. Here because every turn-launching path reaches this function
  // under the task's lifecycle lock — the same lock a member's entry takes.
  await refuseLaunchWhileMemberInside(projectRoot, taskId);
  if (plan.mode === 'session') return plan.kindChanged;
  return (await getTaskSessionBinding(projectRoot, taskId)) !== null;
}

/**
 * Refuse a turn launch while a member has a terminal open on the task
 * (../server/member-terminals.ts). The member's terminals run in a container
 * of their own, so the two never share a process space or a credential — but
 * they would share the worktree's files, mid-edit, and a member pairing on a
 * task is not asking for an agent to work underneath them.
 *
 * Throws RpcError(409), naming the member. Before throwing it RELEASES the
 * binding this launch has just planned: left live, the task would read as
 * "running a turn" to the member's next terminal while no turn runs at all.
 * Call it under the task's lifecycle lock, where a member's entry cannot
 * interleave with it.
 */
export async function refuseLaunchWhileMemberInside(projectRoot: string, taskId: string): Promise<void> {
  const holder = memberInsideTask(taskId);
  if (!holder) return;
  await releaseTurnCredential(projectRoot, taskId);
  throw new RpcError(409, memberInsideLaunchMessage(holder));
}

/**
 * The same refusal, for a launch that has not planned a credential yet — and
 * so has nothing to release. Every launch that RECORDS A TURN before it plans
 * its credential (unblock, ask, review, start, manual resume) calls this
 * first, right after its in-lock status re-read: refusing after the turn is
 * written would leave a half-dispatched human turn behind, which the
 * redelivery path would later hand the agent as unconsumed feedback. The
 * human's words are not lost by refusing here — every surface keeps them
 * until a delivery succeeds (the CLI's recovery file, the review draft,
 * Teams' ask record).
 */
export function assertNoMemberInside(taskId: string): void {
  const holder = memberInsideTask(taskId);
  if (holder) throw new RpcError(409, memberInsideLaunchMessage(holder));
}

/**
 * Why automation that would launch a turn is currently disabled, or null when
 * it is not. Checked by the daemon's own turn-launching automations so they
 * skip with a stated reason instead of failing at the container.
 */
export async function systemTurnBlock(projectRoot: string): Promise<string | null> {
  if (!(await teamModeEnabled(projectRoot))) return null;
  if (await getServiceCredential(projectRoot)) return null;
  return systemTurnBlockedReason();
}

function systemTurnBlockedReason(): string {
  return (
    `${NO_SERVICE_CREDENTIAL_MARKER}: this project runs per-user Anthropic credentials, and turns the daemon starts by itself ` +
    `(auto-deliver, sync) have no user to bill. Configure a project service credential — ` +
    `putUserCredential with userId '${SERVICE_CREDENTIAL_USER_ID}' — to enable them. ` +
    `Until then these turns are disabled rather than charged to an arbitrary member.`
  );
}

/**
 * The env var a placeholder of this kind must be injected into.
 *
 * KIND MIRRORING, the decision the rest of the feature rests on: Claude Code
 * derives its request shape from which of these it finds, so putting the
 * placeholder in the var matching the OWNER's credential makes the client emit
 * the shape the real credential needs — and lets the proxy replace a value
 * inside the header the request arrived with, never rewrite header shape.
 */
export function envVarForCredentialKind(kind: UserCredentialKind): string {
  return kind === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

/**
 * The credential env a task's container should be launched with, or null to use
 * the daemon's own (the single-user default).
 *
 * Read at container-launch time from the binding the launcher already made, so
 * the launch path has exactly one source of truth for both halves of the
 * decision — whether to recreate the container, and what to put in its env.
 */
export async function sessionCredentialEnvFor(
  projectRoot: string,
  taskId: string,
): Promise<Array<{ key: string; value: string }> | null> {
  // Team mode decides the MODE, before any binding is consulted. A single-user
  // install uses the daemon's own credential, as lazy always has — including
  // when a stale binding from a previous team-mode life is still on disk.
  // Handing that container a placeholder no live binding backs is a guaranteed
  // 401 for the whole turn.
  if (!(await teamModeEnabled(projectRoot))) return null;

  const binding = await getTaskSessionBinding(projectRoot, taskId);
  if (binding) {
    return [{ key: envVarForCredentialKind(binding.kind), value: binding.token }];
  }

  // In team mode it is NOT: a container launched outside a turn (e.g. `lazy
  // container ensure`) would otherwise be handed the daemon's real credential,
  // which is the one thing this feature exists to prevent. Give it a placeholder
  // that is bound to nobody instead — every request it makes is refused with
  // unknown_session_token, and the task's next real turn recreates the container
  // with a placeholder that resolves.
  return [{ key: 'ANTHROPIC_API_KEY', value: unboundPlaceholder() }];
}

/** A syntactically valid placeholder that is deliberately bound to nobody. */
function unboundPlaceholder(): string {
  return `${SESSION_TOKEN_PREFIX}unbound-${randomBytes(16).toString('hex')}`;
}

/** The launch-time credential env for a plan, or null to use the daemon env. */
export function credentialEnvForPlan(
  plan: TurnCredentialPlan,
): Array<{ key: string; value: string }> | null {
  if (plan.mode === 'daemon-env') return null;
  return [{ key: envVarForCredentialKind(plan.kind), value: plan.token }];
}

/**
 * Release a task's session binding — the turn's process has exited.
 *
 * Best-effort by design: it must never turn a finished turn into a failed one.
 * A binding that survives (daemon killed mid-teardown) is re-pointed by the
 * next turn anyway, and cannot be used by anyone but the container that already
 * holds it.
 *
 * It touches no turn owner: that lives in the request that asked for the turn
 * (./turn-owner.ts) and ends with it, so there is nothing here to forget.
 */
export async function releaseTurnCredential(projectRoot: string, taskId: string): Promise<void> {
  try {
    await revokeTaskSessionBinding(projectRoot, taskId);
  } catch (err) {
    logger.warn(
      `Could not revoke the session credential binding for task ${taskId.substring(0, 8)}: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `It will be re-pointed on the task's next turn.`,
    );
  }
}

/**
 * The proxy's window into per-user credentials: placeholder → owner → real
 * secret. Nothing else about a credential ever leaves this process, and this
 * function hands the secret to code running in the SAME process (the proxy is
 * served by the daemon).
 *
 * Returns `{ok:false}` for an unknown, revoked or credential-less placeholder.
 * The proxy turns that into a 401 unconditionally — there is no unattributed
 * bucket on this path.
 */
export function createSessionCredentialResolver(projectRoot: string): SessionCredentialLookup {
  return async (token: string, context?: SessionRequestContext) => {
    const binding = await lookupSessionBinding(projectRoot, token);
    if (!binding) return { ok: false };
    // A placeholder pinned to one container (a member's terminal environment)
    // is honoured only from that container's address. Loud: a mismatch means
    // the value left the container it was minted for.
    if (binding.origin && context?.peerAddress !== binding.origin) {
      const detail = `it is pinned to ${binding.origin}, the request came from ${context?.peerAddress ?? 'an unknown address'}`;
      logger.error(`[proxy] refused a member terminal's placeholder for ${binding.ownerUserId}: ${detail}. It may have leaked out of its container.`);
      return { ok: false, reason: 'wrong_origin', detail };
    }
    const credential = await getUserCredential(projectRoot, binding.ownerUserId);
    if (!credential) return { ok: false };
    // The STORED kind decides, not the kind at bind time: an owner who rotated
    // from an API key to an OAuth token since their container launched must get
    // a loud auth_kind_mismatch, not a swap into a header shape their new
    // credential cannot satisfy.
    return { ok: true, userId: binding.ownerUserId, kind: credential.kind, secret: credential.token };
  };
}

export { getTaskSessionBinding };
