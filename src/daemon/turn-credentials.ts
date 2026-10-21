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
 *   gets a placeholder bound to that owner, and the proxy swaps in the owner's
 *   own credential FOR THE TURN'S AGENT PROFILE (./member-credentials.ts). A
 *   turn the daemon starts by itself (auto-deliver, sync) has no human behind it
 *   and runs on the project's SERVICE holder's credential for the profile — and
 *   if there is none, the automation is disabled with a stated reason instead of
 *   quietly billing whichever member happened to touch the task last (§3.2).
 */

import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';
import { memberInsideTask, memberInsideLaunchMessage } from '../server/member-terminals';
import { RpcError } from './rpc-error';
import {
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
import { turnCredentialRefusal } from './credential-gate';
import { loadConfig } from '../config/loader';
import { type AgentProfile, profileForAgentNameOrNull, resolveAgentProfiles } from '../config/agent-profiles';
import type { ResolvedConfig } from '../config/types';
import {
  memberCredentialFor,
  memberProfileCredentialProblem,
  memberEndpointCredentialFor,
  spendingMember,
} from './member-credentials';
import { endpointRequirementsForProfile } from '../credentials/endpoint-requirements';
import type { SessionCredentialLookup, SessionRequestContext } from '../proxy/session-auth';
import type { Storage } from '../storage/interface';
import { workContainerLaunchedWithoutSessionPlaceholder } from './container-credential-launch';
import { teamSessionPathTarget } from '../utils/role-target';
import type { RoleTarget } from '../config/types';
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
      /**
       * True when the credential KIND changed since this task's last binding (or
       * there was none) — see session-credentials.ts. No longer a reason to
       * recreate the container: every turn hands its supervisor the placeholder
       * and the env var it belongs in (turnCredentialCommandEnv).
       */
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
    /**
     * The agent profile a SPENDER's launch runs on — the builder role's, for a
     * member's builder or a one-shot beside a task. Given, the spender pays with
     * their own credential FOR THAT PROFILE (a Codex builder spends their OpenAI
     * credential, never asks for a Claude one); omitted, the launch is held to
     * the spender's Claude credential (a member's terminal, whose `claude` is
     * what it runs). Also given for a launch beside a task that NOBODY
     * asked for (a description the control plane requested): the service holder
     * then pays with their credential for that profile. Never given for a task's
     * own turn, which runs on the task's profile.
     */
    spenderProfile?: string;
    config?: ResolvedConfig;
  },
): Promise<TurnCredentialPlan> {
  // ATTRIBUTION FIRST, and unconditionally — before the team-mode question,
  // which decides only who PAYS. This function is the one thing every
  // turn-launch path calls with the task and session about to run, so recording
  // the owner here is what makes the record complete on a laptop as well as on
  // a fleet host, and what makes a launch path added later carry it without
  // knowing this exists. See ./turn-owner.ts.
  if (!input.spender && !input.spenderProfile) await recordSessionTurnOwner(input);

  const teamMode = await teamModeEnabled(projectRoot);
  const config = input.config ?? await loadConfig(projectRoot);

  // THE CREDENTIAL IS REQUIRED HERE, AND ONLY HERE (./credential-gate.ts): a
  // daemon starts, clones and serves reads with none, and a turn on a profile
  // that has none is refused now — before the status flip, naming the profile
  // and what it lacks. Only for the task's OWN turns: a spender's launch runs
  // beside the task on the spender's credential, which the branches below
  // decide. In team mode every slot is left to the principal check below.
  if (!input.spender && !input.spenderProfile) {
    const refusal = await taskTurnCredentialRefusal(projectRoot, input, teamMode, config);
    if (refusal) throw new TurnCredentialUnavailableError(refusal);
  }

  if (!teamMode) return { mode: 'daemon-env' };

  // WHO PAYS, and for WHICH PROFILE: the person who asked (or the spender), else
  // the project's service holder for a turn nobody asked for — each paying with
  // their OWN credential for the profile this turn runs on
  // (./member-credentials.ts). Never the project's store, never a teammate's.
  const principal = input.spender?.email ?? getTurnOwner(input.taskId) ?? SERVICE_CREDENTIAL_USER_ID;
  const profile = await turnProfile(projectRoot, input, config);
  const refusal = await principalCredentialProblem(projectRoot, principal, profile, config);
  if (refusal) throw new TurnCredentialUnavailableError(refusal);

  // The session binding names the principal for the whole turn: the proxy reads
  // its owner to resolve that principal's credential for every request the
  // turn's profile makes. Its KIND decides the Anthropic env var the container's
  // session placeholder lives in — the Claude credential's kind when the
  // principal has one (the one the placeholder resolves to), else an inert
  // default: a profile the Claude credential does not pay for never presents
  // that placeholder for its model traffic.
  const launchProfile = profile ?? rawClaudeProfile();
  const credential = await memberCredentialFor(projectRoot, principal, launchProfile, config);
  const kind: UserCredentialKind = credential.kind === 'credential' ? credential.record.kind : 'api-key';
  const member = await spendingMember(projectRoot, principal) ?? principal;
  const bound = await bindTurnCredential(projectRoot, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    ownerUserId: member,
    kind,
  });
  return { mode: 'session', token: bound.token, kind, ownerUserId: member, kindChanged: bound.kindChanged };
}

/**
 * The profile a task's turn runs on, or null when the launch is held to the
 * principal's CLAUDE credential instead: a spender's launch (a member's
 * terminal, a builder session, a one-shot beside the task) always rides the
 * session placeholder to the proxy's primary upstream whatever the project's
 * profiles say — resolving one here once let a configured profile's credential
 * rules decide what a member's own `claude` spends — and a key that names no
 * task has no profile at all.
 */
async function turnProfile(
  projectRoot: string,
  input: { taskId: string; storage?: Storage; agentId?: string; spender?: TurnOwner; spenderProfile?: string },
  config: ResolvedConfig,
): Promise<AgentProfile | null> {
  if (input.spender || input.spenderProfile) {
    return input.spenderProfile ? profileForAgentNameOrNull(config, input.spenderProfile) : null;
  }
  const task = input.storage ? await input.storage.getTask(input.taskId) : null;
  if (!task && input.agentId === undefined) return null;
  return profileForAgentNameOrNull(config, input.agentId ?? task?.agent_id);
}

/** Member terminals run plain Claude on the primary, independent of a configured task profile. */
function rawClaudeProfile(): AgentProfile {
  return resolveAgentProfiles(undefined).get('claude-code')!;
}

/**
 * Why `principal` (a member's address, or nobody — the project's service
 * credential holder) cannot pay for a launch BESIDE a task on agent profile
 * `profileName`, or null when they can — the up-front check for a one-shot or a
 * builder a person asks for, so the refusal names the profile the launch really
 * runs on instead of always asking for a Claude credential. Null outside team
 * mode, where the daemon's own credentials pay as they always have.
 */
export async function sideLaunchCredentialProblem(
  projectRoot: string,
  principal: string | null,
  profileName: string,
  effectiveConfig?: ResolvedConfig,
): Promise<string | null> {
  if (!(await teamModeEnabled(projectRoot))) return null;
  const config = effectiveConfig ?? await loadConfig(projectRoot);
  const profile = profileForAgentNameOrNull(config, profileName);
  return principalCredentialProblem(projectRoot, principal ?? SERVICE_CREDENTIAL_USER_ID, profile, config);
}

/**
 * Why `principal` cannot pay for a turn on `profile`, or null when they can.
 * The one place the team-mode refusals are worded, for the launch
 * ({@link planTurnCredential}), the pre-record check and the pre-flight
 * ({@link turnCredentialProblem}) and the automations ({@link systemTurnBlock}).
 */
async function principalCredentialProblem(
  projectRoot: string,
  principal: string,
  profile: AgentProfile | null,
  config: ResolvedConfig,
): Promise<string | null> {
  return memberProfileCredentialProblem(projectRoot, principal, profile ?? rawClaudeProfile(), config);
}

/**
 * Refuse a turn `planTurnCredential` would refuse for want of a credential,
 * BEFORE its turn row is written. Throws `RpcError(400)` with the same text.
 *
 * For launches that carry no human feedback to save first: ask, review and the
 * resume paths. UNBLOCK does not use this — it records the member's words as a
 * withheld turn and only then refuses (`recordFeedbackThenRefuse`,
 * src/daemon/task-lifecycle.ts), so a missing credential never costs them what
 * they typed.
 *
 * Decides exactly what `planTurnCredential` decides, binds nothing, and loads
 * a stored daemon-env credential the same way — so the plan that follows
 * finds it in the environment.
 */
export async function assertTurnCredentialAvailable(
  projectRoot: string,
  input: { taskId: string; storage: Storage; agentId?: string },
): Promise<void> {
  const refusal = await turnCredentialProblem(projectRoot, input);
  if (refusal) throw new RpcError(400, refusal);
}

/**
 * Why a turn for this task would be refused for want of a credential, or null
 * when it would launch — the non-throwing form of
 * {@link assertTurnCredentialAvailable}, and the ONE place its rules live, so
 * the CLI pre-flight (`turnCredentialCheck`), the pre-record check and the
 * sync gate can never disagree with each other or with `planTurnCredential`:
 *
 *   1. the credential the turn's PROFILE bills (`agentId` when an `--agent`
 *      switch will change it, else the task's own) — ./credential-gate.ts;
 *   2. in team mode, the turn OWNER's own credential for that profile when a
 *      person asked for the turn, else the project's service holder's
 *      (./member-credentials.ts).
 *
 * `owner`: omitted, it is read from the request scope exactly as a launch
 * reads it (`getTurnOwner`); a caller outside that scope (the pre-flight RPC,
 * which is not a turn-launching command) passes the one it resolved, and
 * `null` for nobody. `load: false` answers from presence only (see
 * `profileCredentialRefusal`).
 */
export async function turnCredentialProblem(
  projectRoot: string,
  input: {
    taskId: string;
    storage: Storage;
    agentId?: string;
    owner?: string | null;
    load?: boolean;
  },
): Promise<string | null> {
  const teamMode = await teamModeEnabled(projectRoot);
  const config = await loadConfig(projectRoot);
  const task = await input.storage.getTask(input.taskId);
  if (!task) return null;
  const agentId = input.agentId ?? task.agent_id;
  const refusal = await turnCredentialRefusal(projectRoot, agentId, {
    perUser: teamMode,
    config,
    ...(input.load === false ? { load: false } : {}),
  });
  if (refusal) return refusal;
  if (!teamMode) return null;
  const principal = (input.owner === undefined ? getTurnOwner(input.taskId) : input.owner) ?? SERVICE_CREDENTIAL_USER_ID;
  return principalCredentialProblem(projectRoot, principal, await turnProfile(projectRoot, { ...input, agentId }, config), config);
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
): Promise<{ mustRecreateContainer: boolean; plan: TurnCredentialPlan }> {
  try {
    const plan = await planTurnCredential(projectRoot, input);
    return {
      mustRecreateContainer: await mustRecreateForCredentialPlan(projectRoot, input.taskId, plan),
      plan,
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
 * A SESSION plan never needs a new container. A running container's env is
 * fixed at create, but the agent does not read the placeholder from there: the
 * turn's command carries it, with the env var its kind needs
 * (turnCredentialCommandEnv), and the supervisor installs it in its own env
 * before the agent starts. So a turn whose owner holds a different credential
 * kind than the last one — a member on OAuth after the service credential's
 * API key, or the reverse, which Teams does whenever a daemon-started turn
 * falls between two of a person's — runs in the SAME container, and the
 * task's services in it keep running (engineer, 2026-10-20: starting a turn
 * must leave them alone). It used to recreate the container on every such
 * change.
 *
 * Two ways a running container's env is still wrong for the turn:
 *
 *   NO PLACEHOLDER TO REPLACE — the plan is a session plan, but the container
 *   was launched WITHOUT a session placeholder: created under solo billing (the
 *   daemon's own credential, as a grant) before the project switched to member
 *   billing. The supervisor only replaces a placeholder the container holds, so
 *   the agent would keep the solo grant and the proxy would refuse the turn
 *   (`auth_kind_mismatch`). What each container was launched with is recorded
 *   at launch (./container-credential-launch.ts).
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
  if (plan.mode === 'session') return workContainerLaunchedWithoutSessionPlaceholder(projectRoot, taskId);
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
export async function systemTurnBlock(
  projectRoot: string,
  task?: { agent_id?: string | null },
): Promise<string | null> {
  const teamMode = await teamModeEnabled(projectRoot);
  const config = await loadConfig(projectRoot);
  // The task's profile first: with no credential for it, the turn would be
  // refused at launch whoever paid for it — say that, every tick, instead.
  if (task) {
    // PRESENCE ONLY: this runs on every reconciler tick, which must never open
    // a keychain item. The launch that follows loads for real.
    const refusal = await turnCredentialRefusal(projectRoot, task.agent_id, { perUser: teamMode, load: false, config });
    if (refusal) return refusal;
  }
  if (!teamMode) return null;
  const profile = task ? profileForAgentNameOrNull(config, task.agent_id) : null;
  return principalCredentialProblem(projectRoot, SERVICE_CREDENTIAL_USER_ID, profile, config);
}

/**
 * The turn gate for the task behind `input.taskId`, or null when it may launch
 * (or when the key names no task — a one-shot's own binding key).
 */
async function taskTurnCredentialRefusal(
  projectRoot: string,
  input: { taskId: string; storage?: Storage },
  teamMode: boolean,
  config: ResolvedConfig,
): Promise<string | null> {
  const task = input.storage ? await input.storage.getTask(input.taskId) : null;
  if (!task) return null;
  return turnCredentialRefusal(projectRoot, task.agent_id, { perUser: teamMode, config });
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
 * Read at container-launch time from the binding the launcher already made.
 * Only a NEW container takes it from here; a reused one is handed each turn's
 * placeholder by that turn's command (turnCredentialCommandEnv).
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
  // unknown_session_token until the task's next real turn, whose command hands
  // the supervisor a placeholder that resolves (src/supervisor/turn-credential-env.ts);
  // the container is kept.
  return [{ key: 'ANTHROPIC_API_KEY', value: unboundPlaceholder() }];
}

/** A syntactically valid placeholder that is deliberately bound to nobody. */
function unboundPlaceholder(): string {
  return `${SESSION_TOKEN_PREFIX}unbound-${randomBytes(16).toString('hex')}`;
}

/**
 * The credential env a turn's COMMAND carries to its supervisor, or undefined.
 *
 * Only for a session plan, and only for a profile whose LAUNCH is handed the
 * session placeholder itself — claude-code or pi on the primary Anthropic
 * profile, exactly the rule teamModeLaunchCreds applies (teamSessionPathTarget).
 * A codex or cursor container holds none on purpose, and a claude-code / pi
 * profile with its own endpoint or a non-Anthropic credential is launched with
 * a per-profile grant instead: the member's session placeholder must never be
 * written into such a container's command file. The supervisor installs these values in its own
 * env before the agent starts (src/supervisor/turn-credential-env.ts), which is
 * what lets a running container serve a turn whose credential kind — and so
 * whose env var, and placeholder value — differs from the one it was created
 * with. The value is the placeholder the container already holds or its
 * replacement; it confers nothing outside the binding the proxy checks.
 */
export function turnCredentialCommandEnv(
  plan: TurnCredentialPlan,
  target: Pick<RoleTarget, 'harness' | 'credential' | 'endpoint'>,
): Array<{ key: string; value: string }> | undefined {
  if (plan.mode !== 'session') return undefined;
  if (target.harness !== 'claude-code' && target.harness !== 'pi') return undefined;
  if (!teamSessionPathTarget(target)) return undefined;
  return credentialEnvForPlan(plan) ?? undefined;
}

/**
 * `{ session_credential_env }` for a work command, or `{}` — spread into the
 * command literal. `resolveTarget` gives the task's launch target and is only
 * called for a session plan: a solo install never resolves anything here.
 */
export function sessionCredentialCommandField(
  plan: TurnCredentialPlan,
  resolveTarget: () => Pick<RoleTarget, 'harness' | 'credential' | 'endpoint'>,
): { session_credential_env?: Array<{ key: string; value: string }> } {
  if (plan.mode !== 'session') return {};
  const env = turnCredentialCommandEnv(plan, resolveTarget());
  return env ? { session_credential_env: env } : {};
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
    const config = context?.config ?? await loadConfig(projectRoot);
    const profile = rawClaudeProfile();
    const requirement = endpointRequirementsForProfile(profile, config)[0]!;
    const answer = await memberEndpointCredentialFor(projectRoot, binding.ownerUserId, requirement, context?.upstream ?? config.proxy.upstream);
    if (answer.kind !== 'credential') return { ok: false, detail: answer.kind === 'missing' ? answer.detail : 'this endpoint takes no credential' };
    const credential = answer.record;
    // The STORED kind decides, not the kind at bind time: an owner who rotated
    // from an API key to an OAuth token since their container launched must get
    // a loud auth_kind_mismatch, not a swap into a header shape their new
    // credential cannot satisfy.
    return { ok: true, userId: answer.member, endpoint: requirement.endpointId, kind: credential.kind, secret: credential.token };
  };
}

export { getTaskSessionBinding };
