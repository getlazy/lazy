/**
 * Usage pausing, the DAEMON half: the gate every launch that spends a model
 * passes through, the one-shot override, and the record of work the gate is
 * holding.
 *
 * `[usage_pause] threshold_percent` (off by default) is the share of a
 * subscription usage window past which lazy stops STARTING turns that would
 * spend that credential. The policy — which windows count, when one trips,
 * when it lifts — is src/usage-pause/policy.ts; the readings are the proxy's
 * (src/proxy/usage-limits.ts). This module decides WHICH credential a launch
 * would spend and applies the verdict to the two kinds of launch:
 *
 *   EXPLICIT launches — start, unblock, resume, a review, an ask, the conflict
 *   resolution of a sync somebody asked for, a review conversation's builder
 *   turn, a link description, a memory compact, a pair or chat session — are
 *   REFUSED (429) with the credential, window, reading, threshold and reset
 *   time. Somebody is there to read it, and nothing is lost: nothing has been
 *   written yet when the gate runs, and the CLI keeps typed feedback in its
 *   recovery file. The one exception is a task's own AGENT starting its
 *   subtask: that start is HELD and replayed after the reset
 *   (`holdAgentStart`), because the agent can do nothing useful with a refusal.
 *
 *   Whether the pause CAN act at all — a credential it is armed for with no
 *   usable reading — is its own answer (`usagePauseCoverage`), and every
 *   surface says it out loud.
 *
 *   The daemon's OWN launches — auto-resume, auto-delivery, cluster restarts,
 *   a review's auto-fix, the automatic review after a final, an automatic sync
 *   that hits a conflict — are HELD: skipped with the state they retry from
 *   left intact, and marked on the task (`usage_pause_held` metadata) so
 *   `lazy show` and `lazy doctor` can say what is waiting and why. The first
 *   hold of a pause episode files one system message. When the window resets
 *   the pause lifts by itself, because every held launch is re-offered on every
 *   tick: queued signals and cluster arrivals by auto-delivery, an interrupted
 *   task by the reconciler's stranded-interrupt sweep, a final with no review
 *   after it by the auto-review catchup, a queued sync by the sync retry loop.
 *   The first offer after the reset goes ahead.
 *
 * A turn already running is never touched — nor a nudge the supervisor sends
 * inside it: the gate only runs at launch.
 */

import { randomUUID } from 'crypto';
import type { ResolvedConfig } from '../config/types';
import type { Storage } from '../storage/interface';
import type { ActorInput, Task } from '../types';
import { loadConfig } from '../config/loader';
import { agentProfilesFor, profileForAgentNameOrNull } from '../config/agent-profiles';
import { actorEmail, actorRole } from '../actor-ref';
import { displayId } from '../task/identity';
import { parentTaskIdOf } from '../task-target';
import { isUserStopped } from '../task/user-stop';
import { isClusterTask, isTerminalStatus } from '../types';
import { logger } from '../utils/logger';
import { buildTargetCredentials } from '../proxy/credential-deps';
import {
  daemonUsageLimits,
  upstreamOrigin,
  usageLimitCredentialKey,
  type UsageLimitReading,
} from '../proxy/usage-limits';
import {
  anySourcePauseWindows,
  describeReadingsStoreError,
  describeUsagePause,
  evaluateUsagePause,
  overageStatusOf,
  readingCoverage,
  STORE_ERROR_WINDOW,
  thresholdFor,
  usageSourceFor,
  windowLabel,
  type UsagePauseCoverage,
  type UsagePauseVerdict,
} from '../usage-pause/policy';
import {
  parseUsagePauseHold,
  usagePauseHoldOf,
  USAGE_PAUSE_HELD_KEY,
  USAGE_PAUSE_PENDING_FIX_KEY,
  USAGE_PAUSE_PENDING_START_KEY,
  USAGE_PAUSE_WAKE_KEY,
  usagePausePendingStartOf,
  usagePauseWakeChildrenOf,
  type UsagePauseHold,
  type UsagePausePendingStart,
} from '../usage-pause/hold';
import { seedUsageReadings, usageReadingsStoreError, type UsageReadingsStoreError } from './usage-readings';
import { RpcError } from './rpc-error';
import { getTaskSessionBinding } from './session-credentials';
import {
  memberUsageLimitsView,
  projectUsageLimits,
  scopeUsageLimitsView,
  usageLimitsUnreadableMessage,
  type UsageLimitsView,
} from '../usage-pause/limits-view';
import { getTurnOwner } from './turn-credentials';
import { SERVICE_CREDENTIAL_USER_ID, teamModeEnabled } from './user-credentials';

export { describeNoReading, type UsagePauseCoverage } from '../usage-pause/policy';

/** The `lazy daemon config` key for the one-shot override. */
export const USAGE_PAUSE_OVERRIDE_KEY = 'usage_pause_threshold';

// --- The one-shot override (daemon memory only) ---

/**
 * INVARIANT: the override is good for exactly ONE launch — the first start,
 * unblock, resume, review, ask, conflict sync, review-conversation turn or
 * one-shot a PERSON asks for that it LETS PAST A PAUSE. It is gone
 * the moment it does that, reverting to lazy.toml. One use is one LAUNCH, not
 * one window: an override that lasted the rest of a window would be a second,
 * silent threshold.
 *
 * A launch it changes nothing for leaves it pending: one the configured
 * threshold already lets through (an unpaused credential, a harness with no
 * usage signal, pausing off), and one it would not let through either (an
 * override below the reading). Otherwise a start on some other task would
 * spend the override its setter is about to use on the paused one.
 *
 * Taken synchronously, after the verdict and only if it is still the same
 * pending value, so two launches racing for it cannot both use it. Like every
 * `lazy daemon config` override it lives only in this process and a daemon
 * restart drops it.
 *
 * INVARIANT: the override is the HUMAN's escape hatch, and only a launch whose
 * channel is `human` takes it. Not the builder, not an agent, not a call that
 * names no actor at all: each of those is a model that can read the refusal and
 * act on it, and letting one of them use the override turned the pause into a
 * suggestion — it could set the override and relaunch, every time. So the gate
 * never offers it to them (and their refusal text never names the command),
 * `lazy daemon config set` refuses a non-human channel and needs a real
 * terminal (src/cli/commands/daemon-config.ts), and the daemon's own launches
 * never take it either — including one that rides the explicit path carrying a
 * PERSON as its actor (a review's auto-fix carries the reviewer's): it passes
 * `daemonLaunch`, and the actor is attribution, not a request.
 */
let override: number | null = null;
/** When the pending override was set (unix ms), for the surfaces that show it. */
let overrideSetAt: number | null = null;

/** Set (a percent, 0 = no pause) or clear (`null`) the one-shot override. */
export function setUsagePauseOverride(value: number | null, now: number = Date.now()): void {
  override = value;
  overrideSetAt = value === null ? null : now;
}

export function getUsagePauseOverride(): number | null {
  return override;
}

/**
 * May this channel set, or use, the one-shot override? Only a person's own —
 * see the invariant above. `undefined` (a call that names no channel) is NOT a
 * person: an unattributed call never gets the benefit of the doubt here.
 */
export function mayUseUsagePauseOverride(actor: ActorInput | undefined): boolean {
  return actorRole(actor) === 'human';
}


/** Test-only: forget the override and the posted-episode memory. */
export function resetUsagePauseStateForTest(): void {
  override = null;
  overrideSetAt = null;
  postedEpisodes.clear();
  oneshotAllowances.clear();
}

// --- Which credential a turn spends ---

/** True when pausing could ever apply under this config (a cheap early out). */
export function usagePauseConfigured(config: ResolvedConfig): boolean {
  return (
    config.usage_pause.threshold_percent > 0 ||
    Object.values(config.usage_pause.credentials).some((v) => v > 0)
  );
}

/** A credential key (as the proxy files readings) and the harness that would spend it. */
export interface SpendCredential {
  credential: string;
  harness: string;
}

/** The upstream a profile's traffic is forwarded to — the same resolution the proxy makes. */
function profileUpstream(config: ResolvedConfig, profile: { endpoint: string; harness: string }): string {
  return profile.endpoint.trim()
    ? profile.endpoint.trim().replace(/\/$/, '')
    : profile.harness === 'cursor'
      ? config.proxy.cursorUpstream
      : config.proxy.upstream;
}

/**
 * The credential a launch on the profile `agentName` would spend, billed (in
 * team mode) to `owner` — or null when lazy cannot tell.
 *
 * Answered from the same sources the launch and the proxy use, so it cannot
 * name a different credential than the one actually billed:
 *   - per-user credentials (Teams): `user:<owner>`, else the project's service
 *     credential — `planTurnCredential`'s answer, keyed exactly as the proxy
 *     keys it;
 *   - otherwise the proxy's own upstream → credential map, for the upstream the
 *     profile routes to, keyed `credential:<label>`.
 */
async function spendCredentialFor(
  projectRoot: string,
  config: ResolvedConfig,
  agentName: string | null | undefined,
  owner: string | null,
  what: string,
): Promise<SpendCredential | null> {
  const profile = profileForAgentNameOrNull(config, agentName);
  if (!profile) return null;
  const harness = profile.harness;
  if (await teamModeEnabled(projectRoot)) {
    return {
      credential: usageLimitCredentialKey({ userId: owner ?? SERVICE_CREDENTIAL_USER_ID, upstream: '' }),
      harness,
    };
  }
  const upstream = profileUpstream(config, profile);
  try {
    const outcome = await buildTargetCredentials(projectRoot, config).targets.forTarget(upstream);
    if (outcome.kind !== 'credential') return null;
    return { credential: usageLimitCredentialKey({ credentialLabel: outcome.label, upstream }), harness };
  } catch (err) {
    // The proxy refuses to start on the same misconfiguration, so no turn on
    // this map could reach an upstream anyway; the launch reports that itself.
    logger.debug(
      `usage pause: cannot resolve the credential for ${what}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * The credential a turn of `task` would spend: the task's agent profile, billed
 * to the turn owner of the request this launch runs inside — a daemon launch
 * runs outside every request, so the project's service credential.
 */
export async function turnSpendCredential(
  projectRoot: string,
  config: ResolvedConfig,
  task: Task,
): Promise<SpendCredential | null> {
  return spendCredentialFor(projectRoot, config, task.agent_id, getTurnOwner(task.id), displayId(task));
}

/**
 * The credential a launch BESIDE any task would spend: a review conversation's
 * builder, or a machine one-shot (link-describe, memory compact, `lazy report`,
 * an ask answered from a task's stored record). Those run on the BUILDER role's
 * profile (src/oneshot/container-runner.ts), billed to whoever asked as a
 * SPENDER — never as a task's turn owner.
 */
export async function besideSpendCredential(
  projectRoot: string,
  config: ResolvedConfig,
  spenderEmail: string | null | undefined,
): Promise<SpendCredential | null> {
  return spendCredentialFor(
    projectRoot, config, config.models.roles.builder.profile, spenderEmail ?? null, 'the builder role',
  );
}

/** The latest reading for a credential, seeding from the audit log once per process. */
async function latestReading(
  projectRoot: string,
  config: ResolvedConfig,
  credential: string,
): Promise<UsageLimitReading | null> {
  await seedUsageReadings(projectRoot, config);
  return daemonUsageLimits.readings().find((r) => r.credential === credential) ?? null;
}

export interface TaskUsagePause {
  harness: string;
  verdict: UsagePauseVerdict;
}

/** The verdict a launch gets while the saved readings cannot be read. */
function storeErrorVerdict(
  credential: string,
  threshold: number,
  e: UsageReadingsStoreError,
  now: number,
): UsagePauseVerdict {
  return {
    credential, window: STORE_ERROR_WINDOW, usedPercent: null, status: null, threshold,
    resetsAt: null, readingAt: now, storeError: describeReadingsStoreError(e),
  };
}

/**
 * Is a launch spending `spend` paused right now? `threshold` replaces the
 * configured one (the override). Null when not paused, when pausing is off, or
 * when the harness has no usage signal.
 *
 * INVARIANT: while the SAVED readings cannot be read, every launch the pause
 * would judge is refused — the gate fails CLOSED. A corrupt readings file after
 * a restart, during a long pause, with the audit log rotated, left the tracker
 * with no reading and no spend mark: the gate saw "nothing paused", doctor
 * listed nothing, and a turn started at 97%. The verdict names the file
 * (`storeError`); no threshold and no override lifts it — a person moves the
 * file aside or restores it, and the next check (the seed retries on every
 * call) lets launches through again. A credential configured never to pause
 * (threshold 0) and a harness with no usage signal are not judged at all, so
 * they are not refused either.
 */
export async function usagePauseForSpend(
  projectRoot: string,
  config: ResolvedConfig,
  spend: SpendCredential | null,
  threshold?: number,
  now: number = Date.now(),
): Promise<TaskUsagePause | null> {
  if (threshold === undefined && !usagePauseConfigured(config)) return null;
  if (!spend) return null;
  const source = usageSourceFor(spend.harness);
  if (!source) return null;
  const configured = thresholdFor(config.usage_pause, spend.credential);
  const reading = await latestReading(projectRoot, config, spend.credential);
  const storeError = usageReadingsStoreError();
  if (storeError && usagePauseConfigured(config) && configured > 0) {
    return { harness: spend.harness, verdict: storeErrorVerdict(spend.credential, configured, storeError, now) };
  }
  if (threshold !== undefined && threshold <= 0) return null;
  const effective = threshold ?? configured;
  const verdict = evaluateUsagePause(reading, source.pauseWindows, effective, now);
  return verdict ? { harness: spend.harness, verdict } : null;
}

/**
 * Is a turn of `task` paused right now? `threshold` replaces the configured
 * one (the override). Null when not paused, when pausing is off, or when the
 * task's harness has no usage signal.
 */
export async function usagePauseForTask(
  projectRoot: string,
  config: ResolvedConfig,
  task: Task,
  threshold?: number,
  now: number = Date.now(),
): Promise<TaskUsagePause | null> {
  if (threshold === undefined && !usagePauseConfigured(config)) return null;
  const spend = await turnSpendCredential(projectRoot, config, task);
  return usagePauseForSpend(projectRoot, config, spend, threshold, now);
}

// --- Is the pause able to act at all? ---


/**
 * Every credential `[usage_pause]` is ARMED for that has spent turns, and
 * whether its latest reading lets the pause act.
 *
 * INVARIANT: "armed, but no usable reading" is never a quiet state. The gate
 * cannot tell it from "not paused" — both are a null verdict, and turns start —
 * so without this answer the feature silently did nothing whenever the reading
 * was missing, stale or in a header shape `usageWindows()` does not parse (the
 * Claude subscription header names are still unverified). `lazy doctor`, `lazy
 * daemon config get`, `lazy stats limits`, the dashboard and Teams all read it
 * from here and say it out loud.
 *
 * Which credentials: those lazy has billed traffic to (the tracker remembers
 * them, durably — src/daemon/usage-readings.ts) that a launch on a harness WITH
 * a usage source would spend. On a laptop that is the proxy's credential for
 * each such profile's upstream; in team mode every per-user and service
 * credential, as soon as any profile runs such a harness. A credential only a
 * harness with no source spends (cursor, pi) is never armed and never listed.
 * Empty when pausing is off.
 */
export async function usagePauseCoverage(
  projectRoot: string,
  config: ResolvedConfig,
  now: number = Date.now(),
): Promise<UsagePauseCoverage[]> {
  if (!usagePauseConfigured(config)) return [];
  await seedUsageReadings(projectRoot, config);
  const supported = [...agentProfilesFor(config).values()].filter((p) => usageSourceFor(p.harness) !== null);
  if (supported.length === 0) return [];
  const spent = daemonUsageLimits.spentCredentials();
  // Only spend on an upstream a usage-sourced harness uses counts: a member who
  // spends only on cursor or a local model has nothing pausing could read, and
  // calling that "armed, NO READING" was a false alarm. A credential whose
  // upstreams are UNKNOWN (a spend mark from before they were recorded) still
  // counts — the warning errs loud, never quiet.
  const sourced = new Set(supported.map((p) => upstreamOrigin(profileUpstream(config, p))).filter(Boolean));
  const spentOnSourced = (credential: string): boolean => {
    const via = daemonUsageLimits.spentUpstreams(credential);
    return via.length === 0 || via.some((o) => sourced.has(o));
  };
  const armed = new Set<string>();
  if (await teamModeEnabled(projectRoot)) {
    for (const credential of spent.keys()) {
      if (credential.startsWith('user:') && spentOnSourced(credential)) armed.add(credential);
    }
  } else {
    for (const profile of supported) {
      const spend = await spendCredentialFor(projectRoot, config, profile.name, null, `profile ${profile.name}`);
      if (spend && spent.has(spend.credential) && spentOnSourced(spend.credential)) armed.add(spend.credential);
    }
  }
  const readings = daemonUsageLimits.readings();
  return [...armed]
    .filter((credential) => thresholdFor(config.usage_pause, credential) > 0)
    .sort()
    .map((credential) => {
      const reading = readings.find((r) => r.credential === credential) ?? null;
      return {
        credential,
        coverage: readingCoverage(reading, anySourcePauseWindows, now),
        readingAt: reading?.ts ?? null,
        lastSpentAt: spent.get(credential) ?? null,
        overage: overageStatusOf(reading),
      };
    });
}


// --- Explicit launches: refuse ---

/** Which explicit launch a refusal is about; its first line says what did not happen. */
export type UsagePauseVerb = 'start' | 'unblock' | 'resume' | 'review' | 'ask' | 'sync' | 'pair' | 'chat';

const NOT_DONE: Record<UsagePauseVerb, string> = {
  start: 'started',
  unblock: 'unblocked',
  resume: 'resumed',
  review: 'reviewed',
  ask: 'asked',
  sync: 'synced',
  pair: 'opened for pairing',
  chat: 'opened for a chat',
};

/**
 * The gate an explicit launch of a TURN of `task` passes before it writes
 * anything: start, unblock, resume — and a review, an ask, or the conflict
 * resolution a sync needs. Throws a 429 naming the credential, window,
 * reading, threshold, reset and the one-shot override. See the override
 * invariant above for who consumes it.
 *
 * `peek` decides exactly the same way but never TAKES the override. Launch
 * paths that write before their late preflights (an `--agent` switch, a
 * runner override) call it first, on the task as it WILL be, so a refusal
 * leaves the task exactly as it was; the call at the usual place then takes
 * the override. Two calls rather than one early one, so an override is not
 * spent on a launch a later preflight (runner, pairing lock) refuses anyway.
 */
export async function assertTurnStartAllowed(
  projectRoot: string,
  input: {
    task: Task;
    config: ResolvedConfig;
    actor: ActorInput | undefined;
    verb: UsagePauseVerb;
    peek?: boolean;
    /** Started by the daemon itself: judged without the one-shot override. */
    daemonLaunch?: boolean;
    /** See {@link assertSpendAllowed}'s `overrideEligible`. */
    overrideEligible?: boolean;
    /** One more line for the refusal (what already happened, what did not). */
    note?: string;
  },
): Promise<void> {
  const { task, config } = input;
  await assertSpendAllowed({
    actor: input.actor,
    peek: input.peek,
    daemonLaunch: input.daemonLaunch,
    overrideEligible: input.overrideEligible,
    judge: (threshold) => usagePauseForTask(projectRoot, config, task, threshold),
    what: `the ${input.verb} of ${displayId(task)}`,
    refused: `Task ${displayId(task)} was not ${NOT_DONE[input.verb]}`,
    note: input.note,
  });
}

/**
 * The same gate for a model run BESIDE any task — a review conversation's
 * builder turn, a link description, a memory compact, a one-shot a person asked
 * for. It spends the builder role's credential ({@link besideSpendCredential}),
 * so that is the one judged. Only people start these, so a refusal is the whole
 * story: nothing is held and nothing is retried.
 */
export async function assertBesideLaunchAllowed(
  projectRoot: string,
  input: {
    config: ResolvedConfig;
    actor: ActorInput | undefined;
    /** "the review conversation turn on lazy-foo", "a memory compact with a model", … */
    what: string;
    /** One more line for the refusal. */
    note?: string;
    /** Decide as the launch would, but never TAKE the override (see assertTurnStartAllowed). */
    peek?: boolean;
    /** See {@link assertSpendAllowed}'s `overrideEligible`. */
    overrideEligible?: boolean;
  },
): Promise<void> {
  // Nothing can pause with pausing off, and the credential lookup is not free.
  if (!usagePauseConfigured(input.config)) return;
  const spend = await besideSpendCredential(projectRoot, input.config, actorEmail(input.actor) ?? null);
  await assertSpendAllowed({
    actor: input.actor,
    peek: input.peek,
    overrideEligible: input.overrideEligible,
    judge: (threshold) => usagePauseForSpend(projectRoot, input.config, spend, threshold),
    what: input.what,
    refused: `${input.what.charAt(0).toUpperCase()}${input.what.slice(1)} was not started`,
    note: input.note,
  });
}

/**
 * How long an admitted one-shot COMMAND may keep running its calls. A
 * `lazy report` over a big range or an ask over a long conversation is many
 * one-shot calls; this bounds a leaked allowance, not a real command.
 */
export const ONESHOT_ALLOWANCE_TTL_MS = 6 * 60 * 60_000;

/** Allowance id → expiry (unix ms), this process only. */
const oneshotAllowances = new Map<string, number>();

/**
 * Admit one CLI one-shot COMMAND (`lazy report`, `lazy ask` on a stored
 * conversation) through the pause, and return the allowance its calls carry.
 *
 * INVARIANT: a command that runs several one-shots is judged ONCE. Judged per
 * call, a pending one-shot override let chunk 1 through, was used up, and the
 * next chunk was refused — the person who set it got a half-finished report.
 * So the command is judged here, before its first call (the override is taken
 * here if it is what lets it through), and every call that presents the
 * allowance skips the gate. That also means a pause that trips MID-command
 * does not cut it off: like a running turn, a started command finishes.
 */
export async function admitOneshotCommand(
  projectRoot: string,
  actor: ActorInput | undefined,
  now: number = Date.now(),
): Promise<string> {
  await assertBesideLaunchAllowed(projectRoot, {
    config: await loadConfig(projectRoot), actor, what: 'a one-shot model run',
  });
  for (const [id, expires] of oneshotAllowances) {
    if (expires <= now) oneshotAllowances.delete(id);
  }
  const id = randomUUID();
  oneshotAllowances.set(id, now + ONESHOT_ALLOWANCE_TTL_MS);
  return id;
}

/**
 * Admit one interactive session a person opens — `lazy pair` or `lazy chat`.
 *
 * INVARIANT: an interactive session is a human launch like a start: refused on
 * a paused credential (the 429 names the window and the reset), and the
 * person's one-shot override may let it through. Judged ONCE, before the
 * session opens; a relaunch of the same session after a daemon restart is not
 * judged again, just as a running turn never is.
 *
 * Which credential: a task pair runs the TASK's agent profile in its container
 * (src/cli/commands/pair-container.ts), so it is the task's turn credential; a
 * chat, and a branchless pair on the host, run on the builder role's profile.
 */
export async function admitInteractiveSession(
  projectRoot: string,
  storage: Storage,
  input: { surface: 'pair' | 'chat'; taskId?: string; actor: ActorInput | undefined; peek?: boolean },
): Promise<void> {
  const config = await loadConfig(projectRoot);
  if (!usagePauseConfigured(config)) return;
  const task = input.taskId ? (await storage.resolveTask(input.taskId)).task : null;
  if (input.taskId && !task) throw new RpcError(404, `Task not found: ${input.taskId}`);
  if (task && input.surface === 'pair') {
    await assertTurnStartAllowed(projectRoot, { task, config, actor: input.actor, verb: 'pair', peek: input.peek });
    return;
  }
  await assertBesideLaunchAllowed(projectRoot, {
    config,
    actor: input.actor,
    peek: input.peek,
    what: input.surface === 'chat'
      ? `the chat with ${task ? displayId(task) : 'the task'}`
      : 'the pairing session',
  });
}

/** Does `id` name an admitted one-shot command that has not expired? */
export function oneshotAllowanceValid(id: string | undefined, now: number = Date.now()): boolean {
  if (!id) return false;
  const expires = oneshotAllowances.get(id);
  return expires !== undefined && expires > now;
}

async function assertSpendAllowed(input: {
  actor: ActorInput | undefined;
  peek?: boolean;
  daemonLaunch?: boolean;
  /**
   * INVARIANT: a launch the CLI makes TAKES the override (and is told the
   * command) only when the CLI vouched that a person at a real terminal asked
   * — `false` here means "not vouched", and the launch is judged like the
   * builder's. The actor alone could not say it: `lazy start` / `unblock` /
   * `resume` / `review` / `ask` / `sync` carry the `human` channel for
   * ATTRIBUTION from any process, the builder's shell included, so the builder
   * running `lazy unblock B` spent the override a person had set for task A,
   * and its refusal spelled the command out. The six launch sites pass
   * `params.usagePauseOverrideEligible === true` — fail closed: a caller that
   * does not say so never gets it. A Lazy Teams member's TOKEN does not say so
   * either: the Teams CLI proxy relays a bound clone's launch on it, whatever
   * shell ran the CLI, so the flag rides the body (the CLI's own answer,
   * relayed; `true` from Teams' browser launches) and is never pinned. `undefined` leaves the decision to the
   * actor, for the surfaces that already only name a person's channel when a
   * person asked (one-shots, pair, chat, the dashboard's web terminals).
   */
  overrideEligible?: boolean;
  /** The verdict at the configured threshold (no argument) or at `threshold`. */
  judge: (threshold?: number) => Promise<TaskUsagePause | null>;
  what: string;
  refused: string;
  note?: string;
}): Promise<void> {
  // The configured verdict first: a launch it already allows never touches the
  // override (see the invariant above).
  const pause = await input.judge();
  if (!pause) return;
  // Only a person's own launch is offered the override — never the builder, an
  // agent, an unattributed call or a daemon-started launch, whatever actor it
  // is attributed to (see the override invariant above).
  const human = !input.daemonLaunch && mayUseUsagePauseOverride(input.actor) && input.overrideEligible !== false;
  // Unreadable saved readings: refused, and the override is not consulted —
  // a person fixes the file (see usagePauseForSpend).
  if (pause.verdict.storeError) {
    throw usagePauseRefusal(pause.verdict, { refused: input.refused, note: input.note, human });
  }
  const pending = human ? override : null;
  if (pending !== null) {
    const withOverride = await input.judge(pending);
    // Re-checked after the await, and taken in the same synchronous step: a
    // racing launch that took it first leaves this one to the configured verdict.
    if (!withOverride && input.peek) return;
    if (!withOverride && override === pending) {
      override = null;
      overrideSetAt = null;
      logger.info(
        `usage pause: one-shot override (${pending > 0 ? `threshold ${pending}%` : 'off'}) let ${input.what} ` +
          `past the pause; the configured threshold applies again`,
      );
      return;
    }
  }
  throw usagePauseRefusal(pause.verdict, { refused: input.refused, note: input.note, human });
}

/**
 * The 429 a refused launch gets.
 *
 * INVARIANT: only a refusal addressed to a PERSON names the one-shot override
 * and the command that sets it. The builder and agents read their refusals and
 * act on them, and a refusal that spelled out the escape hatch was an
 * instruction to use it; theirs says when the pause lifts and nothing else.
 */
export function usagePauseRefusal(
  verdict: UsagePauseVerdict,
  input: { refused: string; note?: string; human: boolean },
): RpcError {
  if (verdict.storeError) {
    return new RpcError(
      429,
      `${input.refused}: lazy cannot read its saved usage readings, so it cannot tell whether this ` +
        `credential is over its usage-pause threshold.\n` +
        `  ${describeUsagePause(verdict)}\n` +
        (input.note ? `  ${input.note}\n` : '') +
        (input.human
          ? `  The one-shot override does not lift this. Explanation: lazy doctor`
          : `  This is for a person to fix, not you — do not retry until they have.`),
      'usage_paused',
    );
  }
  const pendingNote = input.human && override !== null
    ? `  The pending one-shot override (${override}%) does not cover this reading, so it was left unused — ` +
      `a number is still a threshold (100 pauses at a full or refused window); \`off\` always lets one turn through.\n`
    : '';
  const escape = input.human
    ? `  To let ONE turn start anyway (the override is used up by the turn it lets through):\n` +
      `    lazy daemon config set ${USAGE_PAUSE_OVERRIDE_KEY} off\n` +
      `  Readings: lazy stats limits · Explanation: lazy doctor`
    : `  New turns on this credential can start again once the window resets. ` +
      `This limit is the human's to lift, not yours — do not retry before the reset.`;
  return new RpcError(
    429,
    `${input.refused}: new turns on this credential are paused.\n` +
      `  ${describeUsagePause(verdict)}\n` +
      (input.note ? `  ${input.note}\n` : '') +
      pendingNote +
      escape,
    'usage_paused',
  );
}

// --- The daemon's own launches: hold ---

/** Pause episodes already announced with a system message, this process. */
const postedEpisodes = new Set<string>();

async function clearHold(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, USAGE_PAUSE_HELD_KEY, '');
}

/**
 * The gate for a launch the DAEMON starts by itself. Returns why the launch
 * must wait (the caller skips and logs it) or null to go ahead.
 *
 * INVARIANT: a held launch leaves every piece of state it would retry from
 * untouched — the caller returns before consuming a signal, advancing a
 * watermark, recording an attempt or a project-wide gap. That is what lets the
 * work go ahead by itself after the window resets instead of being dropped.
 * It never takes the one-shot override (see above).
 */
export async function usagePauseHold(
  projectRoot: string,
  storage: Storage,
  task: Task,
  held: string,
): Promise<string | null> {
  const config = await loadConfig(projectRoot);
  const existing = parseUsagePauseHold(await storage.getTaskMetadata(task.id, USAGE_PAUSE_HELD_KEY));
  const pause = await usagePauseForTask(projectRoot, config, task);
  if (!pause) {
    if (existing) await clearHold(storage, task.id);
    return null;
  }
  const v = pause.verdict;
  const unchanged =
    existing &&
    existing.held === held &&
    existing.credential === v.credential &&
    existing.window === v.window &&
    existing.resetsAt === v.resetsAt &&
    existing.usedPercent === v.usedPercent;
  if (!unchanged) {
    const hold: UsagePauseHold = { ...v, held, since: existing?.since ?? Date.now() };
    await storage.updateTaskMetadata(task.id, USAGE_PAUSE_HELD_KEY, JSON.stringify(hold));
  }
  await announceEpisode(storage, v, task, held);
  return describeUsagePause(v);
}

/**
 * One system message per pause episode (credential × window × reset), filed the
 * first time the pause actually holds work — the moment nobody is watching a
 * CLI that could tell them. Best-effort: a failed post must not turn a skip
 * into a crash of the tick that noticed it.
 */
async function announceEpisode(storage: Storage, v: UsagePauseVerdict, task: Task, held: string): Promise<void> {
  const episode = `${v.credential}|${v.window}|${v.resetsAt ?? 'untimed'}`;
  if (postedEpisodes.has(episode)) return;
  postedEpisodes.add(episode);
  const until = v.resetsAt === null ? 'a fresh reading' : new Date(v.resetsAt).toISOString();
  logger.warn(`usage pause: holding new turns on ${v.credential} until ${until} — ${describeUsagePause(v)}`);
  try {
    if (v.storeError) {
      await storage.createSystemMessage({
        source: 'daemon',
        kind: 'alert',
        title: `The usage pause cannot read its saved readings: launches on ${v.credential} are refused`,
        body:
          `${describeUsagePause(v)}\n\n` +
          `Turns already running continue. Turns lazy starts by itself (first held: the ${held} of ` +
          `**${displayId(task)}**) wait, and go ahead once the file is readable again.`,
      });
      return;
    }
    await storage.createSystemMessage({
      source: 'daemon',
      kind: 'notice',
      title: `New turns on ${v.credential} are paused: ${windowLabel(v.window)} at ${v.usedPercent ?? '?'}%`,
      body:
        `${describeUsagePause(v)}\n\n` +
        `Turns already running continue. Turns lazy starts by itself (first held: the ${held} of ` +
        `**${displayId(task)}**) wait and go ahead on their own when the window resets. ` +
        `Starts, unblocks, resumes, reviews, asks and the other model runs you ask for are refused ` +
        `until then.\n\n` +
        `To let ONE turn start anyway: \`lazy daemon config set ${USAGE_PAUSE_OVERRIDE_KEY} off\`, then ` +
        `start, unblock, resume, review or ask. \`lazy doctor\` lists everything the pause is holding.`,
    });
  } catch (err) {
    logger.warn(`usage pause: could not file the pause notice: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The reconciler's usage-pause pass, once per tick.
 *
 * Mostly a tidy-up: a hold mark whose pause has lifted, or whose task has left
 * the resting states, is cleared, so no surface reports a wait that is over.
 * The held work is re-offered by its own loop (see the header) and goes ahead
 * there.
 *
 * The one launch it makes itself is a review's AUTO-FIX, via
 * `resumeReviewFix`: a review settles exactly once, so no other loop would
 * ever offer that fix again. Tasks carrying a pending fix are visited even if
 * their hold mark is gone (another launch path's gate clears the mark when it
 * finds the pause lifted). Injected rather than imported, because the settle
 * lives in task-lifecycle.ts, which imports this module.
 *
 * The other is a subtask START its parent's agent asked for while paused
 * (`resumeHeldStart`, see {@link holdAgentStart}): nothing else would ever
 * offer it again either. Once the pause lifts it is launched with the
 * parameters the agent asked for; if the task was started or closed in the
 * meantime, the held start is simply dropped.
 */
export async function processUsagePauseHolds(
  projectRoot: string,
  storage: Storage,
  resumeReviewFix?: (task: Task) => Promise<void>,
  resumeHeldStart?: (task: Task, params: Record<string, unknown>) => Promise<'started' | 'held'>,
  wakeParent?: (parent: Task, message: string) => Promise<boolean>,
): Promise<void> {
  const held = (await storage.listTasks()).filter(
    (t) => t.metadata?.[USAGE_PAUSE_HELD_KEY] || t.metadata?.[USAGE_PAUSE_PENDING_FIX_KEY]
      || t.metadata?.[USAGE_PAUSE_PENDING_START_KEY] || t.metadata?.[USAGE_PAUSE_WAKE_KEY],
  );
  if (held.length === 0) return;
  const config = await loadConfig(projectRoot);
  for (const task of held) {
    if (task.metadata?.[USAGE_PAUSE_WAKE_KEY]) {
      await processParentWake(storage, task, wakeParent);
      if (!task.metadata?.[USAGE_PAUSE_HELD_KEY] && !task.metadata?.[USAGE_PAUSE_PENDING_FIX_KEY]
        && !task.metadata?.[USAGE_PAUSE_PENDING_START_KEY]) continue;
    }
    if (task.metadata?.[USAGE_PAUSE_PENDING_START_KEY]) {
      await processHeldStart(projectRoot, storage, config, task, resumeHeldStart);
      continue;
    }
    const hold = usagePauseHoldOf(task);
    const resting = ['interrupted', 'blocked', 'submitted', 'conflict'].includes(task.status);
    if (resting && (await usagePauseForTask(projectRoot, config, task))) continue;
    if (task.metadata?.[USAGE_PAUSE_HELD_KEY]) {
      await clearHold(storage, task.id);
      logger.info(`usage pause: no longer holding ${displayId(task)}${hold ? ` (${hold.held})` : ''}`);
    }
    if (task.metadata?.[USAGE_PAUSE_PENDING_FIX_KEY] && resumeReviewFix) {
      try {
        await resumeReviewFix(task);
      } catch (err) {
        logger.warn(
          `usage pause: the held review auto-fix of ${displayId(task)} could not run: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// --- A subtask start its parent's agent asked for: hold ---

/** What a held start's hold mark says is waiting. */
export const HELD_START_LABEL = "start (asked for by its parent's agent)";

/**
 * Hold a START a task's own agent asked for (`lazy_start` of its subtask —
 * a cluster driver's every child) while the credential it would spend is
 * paused, instead of refusing it.
 *
 * INVARIANT: a held start is not lost and not retried by the agent. The start's
 * parameters are stored on the subtask, the reconciler launches it by itself
 * once the window resets ({@link processUsagePauseHolds}), and until then the
 * subtask is waitable as if it were running (src/daemon/wait-race.ts). The
 * agent is told to END its turn rather than wait (every wait re-polls with a
 * model request on the paused credential); the daemon wakes the parked parent
 * once it has launched the child (`processParentWake`). Refused,
 * the driver's `lazy_start` got a 429 in the middle of a turn that nothing would
 * ever restart after the reset — the driver either gave up on the child or
 * retried, and retrying is the spending the pause is there to stop.
 *
 * `verdictTask` is the task as the start will run it (`--agent` applied).
 * Returns the line the agent is told. Writes nothing else: the launch path
 * calls this before its first write.
 */
export async function holdAgentStart(
  projectRoot: string,
  storage: Storage,
  task: Task,
  verdictTask: Task,
  params: Record<string, unknown>,
): Promise<string> {
  const pending: UsagePausePendingStart = { requestedAt: Date.now(), params };
  await storage.updateTaskMetadata(task.id, USAGE_PAUSE_PENDING_START_KEY, JSON.stringify(pending));
  const why = await usagePauseHold(projectRoot, storage, verdictTask, HELD_START_LABEL);
  logger.info(`usage pause: holding the start of ${displayId(task)} its parent's agent asked for${why ? ` — ${why}` : ''}`);
  const parentId = parentTaskIdOf(task);
  const parent = parentId ? await storage.getTask(parentId) : null;
  // Only a cluster is woken (see processParentWake); any other parent gets a note.
  const after = parent && isClusterTask(parent)
    ? `lazy wakes this task once it has started the held subtask, and you can wait on it then.`
    : `Once lazy has started the held subtask it leaves a note on this task, which you will ` +
      `see on your next turn.`;
  return (
    `The start of ${displayId(task)} is HELD by the usage pause, not refused.` +
    (why ? `\n  ${why}` : '') +
    `\n  lazy starts it by itself when the window resets — do not start it again. ` +
    `If nothing else needs you now, END YOUR TURN: waiting here costs a model request on ` +
    `every wait, on the credential that is paused. ${after}`
  );
}

async function processHeldStart(
  projectRoot: string,
  storage: Storage,
  config: ResolvedConfig,
  task: Task,
  resumeHeldStart: ((task: Task, params: Record<string, unknown>) => Promise<'started' | 'held'>) | undefined,
): Promise<void> {
  const pending = usagePausePendingStartOf(task);
  const drop = async (why: string) => {
    await storage.updateTaskMetadata(task.id, USAGE_PAUSE_PENDING_START_KEY, '');
    if (task.metadata?.[USAGE_PAUSE_HELD_KEY]) await clearHold(storage, task.id);
    logger.info(`usage pause: dropped the held start of ${displayId(task)}: ${why}`);
  };
  if (!pending) return drop('its record no longer parses');
  // Somebody started, closed or otherwise moved it on: the held start is moot.
  if (task.status !== 'backlog') return drop(`it is ${task.status} now`);
  // A start asked for by a parent that has since finished is nobody's any more.
  const parentId = parentTaskIdOf(task);
  const parent = parentId ? await storage.getTask(parentId) : null;
  if (parent && isTerminalStatus(parent.status)) return drop(`its parent is ${parent.status}`);
  // INVARIANT: a held start never launches while its parent is STOPPED.
  // `lazy stop` on a cluster means "run nothing of this without me", and the
  // start was the cluster's own request — so it stays HELD (never launched,
  // never dropped) until the stop lifts, exactly as the cluster restart and
  // auto-resume honour the gate (src/task/user-stop.ts). One of the paths
  // CLAUDE.md counts as consulting it.
  if (parent) {
    const parentSession = await storage.getSessionByTaskId(parent.id);
    if (parentSession && isUserStopped(parentSession)) {
      logger.debug(`usage pause: the held start of ${displayId(task)} waits — its parent ${displayId(parent)} was stopped`);
      return;
    }
  }
  const agentId = typeof pending.params.agentId === 'string' ? pending.params.agentId : undefined;
  const verdictTask = agentId ? { ...task, agent_id: agentId } : task;
  if (await usagePauseForTask(projectRoot, config, verdictTask)) return;
  if (!resumeHeldStart) return;
  let outcome: 'started' | 'held';
  try {
    outcome = await resumeHeldStart(task, pending.params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`usage pause: the held start of ${displayId(task)} failed after the reset: ${message}`);
    // Said on the task, so whoever looks at the never-started subtask (its
    // parent's agent, via lazy_show) learns why — and the wait on it returns,
    // since it is no longer a held start.
    await storage.appendJournalEntry(
      task.id,
      `The start held by the usage pause was launched after the window reset and failed:\n\n${message}`,
      'system',
    ).catch((journalErr: unknown) => {
      logger.warn(`usage pause: could not journal the failed held start of ${displayId(task)}: ${String(journalErr)}`);
    });
    await drop('the launch failed');
    return;
  }
  // `held`: the pause tripped again between the verdict and the launch, and
  // the launch path held it anew — its record stays.
  if (outcome === 'started') {
    await storage.updateTaskMetadata(task.id, USAGE_PAUSE_PENDING_START_KEY, '');
    logger.info(`usage pause: started ${displayId(task)}, whose start was held until the window reset`);
    // The parent was told to end its turn; mark it to be woken for this child.
    if (parent) await addParentWake(storage, parent.id, task.id);
  }
}

async function addParentWake(storage: Storage, parentId: string, childId: string): Promise<void> {
  const current = await storage.getTask(parentId);
  const children = current ? usagePauseWakeChildrenOf(current) : [];
  if (children.includes(childId)) return;
  await storage.updateTaskMetadata(parentId, USAGE_PAUSE_WAKE_KEY, JSON.stringify({ children: [...children, childId] }));
}

/**
 * Wake a parent whose held subtask starts the daemon has now launched.
 *
 * INVARIANT: the parent is woken, not left polling. The held-start answer tells
 * a driver to END its turn — a driver left waiting re-polls with a full-context
 * model request every wait timeout, for the whole pause, on the very credential
 * the pause is holding. So once the daemon launches the held child, a parked
 * CLUSTER parent gets ONE turn saying so, through `autoUnblockTask` (budgeted,
 * and held itself if the parent's own credential is still paused — the mark
 * stays and the next tick retries). A parent somebody STOPPED is never woken:
 * the news goes on it as a comment instead, delivered by whoever resumes it —
 * the same gate the cluster restart honours (src/task/user-stop.ts).
 *
 * INVARIANT: the mark outlives a parent that is not parked YET. A driver told
 * to end its turn may still be working (or interrupted) when the window resets
 * and the child launches; clearing the mark then left it to park `blocked` a
 * moment later with nothing to wake it — the stranded cluster that costs a
 * hand-unblock. So a cluster parent in any live state other than `blocked`
 * keeps the mark and is retried on a later tick; the mark is cleared only for
 * a finished parent, or once the wake or the comment has happened. A driver
 * that did wait gets one extra "your held subtasks started" turn — harmless,
 * and budgeted like every daemon-started turn.
 *
 * INVARIANT: only a CLUSTER parent is woken. A cluster driver's turns are the
 * daemon's to restart (a child added to a blocked cluster starts one too); an
 * ORDINARY task that happened to start a subtask may be parked on a blocking
 * raise or a final claim, and `autoUnblockTask` would walk straight past both.
 * It gets the same comment a stopped parent does, delivered by the next
 * unblock whoever sends it.
 */
async function processParentWake(
  storage: Storage,
  parent: Task,
  wakeParent: ((parent: Task, message: string) => Promise<boolean>) | undefined,
): Promise<void> {
  const children = usagePauseWakeChildrenOf(parent);
  const clear = () => storage.updateTaskMetadata(parent.id, USAGE_PAUSE_WAKE_KEY, '');
  if (children.length === 0 || isTerminalStatus(parent.status)) {
    await clear();
    return;
  }
  const names: string[] = [];
  for (const id of children) {
    const child = await storage.getTask(id);
    names.push(child ? displayId(child) : id.substring(0, 8));
  }
  const message =
    `The usage pause has lifted. lazy has now started the subtask start(s) it was holding: ` +
    `${names.join(', ')}. Wait on them and carry on.`;
  const session = await storage.getSessionByTaskId(parent.id);
  if (session && isUserStopped(session)) {
    await storage.createComment(parent.id, `[Held subtask starts launched while stopped] ${message}`, 'system');
    await clear();
    logger.info(`usage pause: ${displayId(parent)} is stopped — noted the started subtask(s) instead of waking it`);
    return;
  }
  // A comment starts nothing, so it is written whatever the parent is doing:
  // it rides the parent's next turn prompt.
  if (!isClusterTask(parent)) {
    await storage.createComment(parent.id, `[Held subtask starts launched] ${message}`, 'system');
    await clear();
    logger.info(`usage pause: ${displayId(parent)} is not a cluster — noted the started subtask(s) instead of waking it`);
    return;
  }
  // Not parked yet (working, interrupted, …): keep the mark, retry next tick.
  if (parent.status !== 'blocked') return;
  if (!wakeParent) return;
  if (await wakeParent(parent, message)) {
    await clear();
    logger.info(`usage pause: woke ${displayId(parent)} for its started subtask(s): ${names.join(', ')}`);
  }
}

// --- State for surfaces (`lazy daemon config`, the CLI pre-flight) ---

export interface UsagePauseState {
  configured: { threshold_percent: number; credentials: Record<string, number> };
  /** The pending one-shot override, or null. */
  override: number | null;
  /** When the pending override was set (unix ms), or null. */
  overrideSetAt: number | null;
  /**
   * Every credential the pause is armed for that has spent turns, and whether
   * its reading lets the pause act — `none` is "armed, NO READING" (see
   * {@link usagePauseCoverage}). Empty when pausing is off.
   */
  coverage: UsagePauseCoverage[];
  /** Every credential whose latest reading pauses it now. */
  paused: UsagePauseVerdict[];
  /** Tasks whose daemon-started launch the pause is holding. */
  held: Array<{ taskId: string; task: string; hold: UsagePauseHold }>;
  /**
   * The saved readings cannot be read (path and why), or null. While set, every
   * launch the pause would judge is refused — see usagePauseForSpend. Absent
   * from an older daemon's answer.
   */
  storeError?: UsageReadingsStoreError | null;
  /**
   * With `taskId`: that task's next turn, judged as a human start would be
   * (the pending override included, but NOT taken) — on `agentId` when given,
   * the agent an `--agent` switch will run it on. Null verdict = would start.
   */
  task?: { credential: string | null; harness: string | null; supported: boolean; verdict: UsagePauseVerdict | null };
  /**
   * With `beside`: a model run BESIDE a task (the builder role's credential —
   * `lazy ask` on a finished task, a chat), judged the same way. The CLI's
   * pre-flight before an editor opens for one.
   */
  beside?: { credential: string | null; harness: string | null; supported: boolean; verdict: UsagePauseVerdict | null };
  /** Answer to `admitOneshot`: the allowance every call of that one-shot command carries. */
  oneshotAllowance?: string;
}

/** `lazy daemon config set usage_pause_threshold <v>`: a percent 0–100, or `off` (= 0). */
export function parseUsagePauseOverride(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (raw === 'off') return 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new RpcError(
      400,
      `Invalid ${USAGE_PAUSE_OVERRIDE_KEY} value '${String(value)}': give a percent from 0 to 100, ` +
        `or 'off' to let the next turn start regardless of usage.`,
    );
  }
  return n;
}

export async function describeUsagePauseState(
  projectRoot: string,
  storage: Storage | null,
  taskId?: string,
  agentId?: string,
  now: number = Date.now(),
  /**
   * `overrideEligible: false` judges the task as the launch will judge a caller
   * that cannot take the override (src/cli/human-terminal.ts): the pending
   * override is not counted. Absent: counted, as before.
   */
  opts: { overrideEligible?: boolean } = {},
): Promise<UsagePauseState> {
  const config = await loadConfig(projectRoot);
  await seedUsageReadings(projectRoot, config);
  const paused: UsagePauseVerdict[] = [];
  for (const reading of daemonUsageLimits.readings()) {
    const v = evaluateUsagePause(
      reading,
      anySourcePauseWindows,
      thresholdFor(config.usage_pause, reading.credential),
      now,
    );
    if (v) paused.push(v);
  }
  const held: UsagePauseState['held'] = [];
  let taskState: UsagePauseState['task'];
  if (storage) {
    for (const t of await storage.listTasks()) {
      const hold = usagePauseHoldOf(t);
      if (hold) held.push({ taskId: t.id, task: displayId(t), hold });
    }
    if (taskId) {
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) throw new RpcError(404, `Task not found: ${taskId}`);
      // The launch gate judges the task AFTER an `--agent` switch, so the
      // pre-flight must judge the agent the turn will actually run on.
      const task = agentId ? { ...resolved.task, agent_id: agentId } : resolved.task;
      const spend = await turnSpendCredential(projectRoot, config, task);
      const configured = await usagePauseForTask(projectRoot, config, task, undefined, now);
      // Mirrors the gate: a pending override only matters to a paused launch,
      // and only to a caller that may take it.
      const pause = configured && override !== null && opts.overrideEligible !== false
        ? await usagePauseForTask(projectRoot, config, task, override, now)
        : configured;
      taskState = {
        credential: spend?.credential ?? null,
        harness: spend?.harness ?? null,
        supported: !!spend && usageSourceFor(spend.harness) !== null,
        verdict: pause?.verdict ?? null,
      };
    }
  }
  return {
    configured: { ...config.usage_pause, credentials: { ...config.usage_pause.credentials } },
    override,
    overrideSetAt: override === null ? null : overrideSetAt,
    coverage: await usagePauseCoverage(projectRoot, config, now),
    paused,
    held,
    storeError: usagePauseConfigured(config) ? usageReadingsStoreError() : null,
    ...(taskState ? { task: taskState } : {}),
  };
}

/**
 * A model run BESIDE a task (the builder role's credential), judged as the
 * launch would judge a person asking — the pending override counted, never
 * taken. The pre-flight a CLI command runs before it opens an editor for one
 * (`lazy ask` on a finished task); the launch itself is still the authority.
 */
export async function describeBesideLaunch(
  projectRoot: string,
  spenderEmail: string | null,
  now: number = Date.now(),
  /** As {@link describeUsagePauseState}'s `opts.overrideEligible`. */
  opts: { overrideEligible?: boolean } = {},
): Promise<NonNullable<UsagePauseState['beside']>> {
  const config = await loadConfig(projectRoot);
  const spend = await besideSpendCredential(projectRoot, config, spenderEmail);
  const configured = usagePauseConfigured(config)
    ? await usagePauseForSpend(projectRoot, config, spend, undefined, now)
    : null;
  const pause = configured && override !== null && opts.overrideEligible !== false
    ? await usagePauseForSpend(projectRoot, config, spend, override, now)
    : configured;
  return {
    credential: spend?.credential ?? null,
    harness: spend?.harness ?? null,
    supported: !!spend && usageSourceFor(spend.harness) !== null,
    verdict: pause?.verdict ?? null,
  };
}

/**
 * Is a model run the DAEMON makes beside any task — billed to nobody in
 * particular, so to the builder role's service credential — paused right now?
 * For the daemon's own background one-shots (the PR-description refresh of
 * the remote-sync sweep), which skip the pass while it is: nothing is lost,
 * because the sweep re-offers the same work on every pass.
 */
export async function daemonBesideLaunchPaused(projectRoot: string): Promise<TaskUsagePause | null> {
  const config = await loadConfig(projectRoot);
  if (!usagePauseConfigured(config)) return null;
  return usagePauseForSpend(projectRoot, config, await besideSpendCredential(projectRoot, config, null));
}

/**
 * The web Pair and Chat terminals (src/server/shell-pair.ts), judged as the
 * person at the page. Locally both spend the TASK's credential (they run the
 * task's agent in its container), so the task's turn credential is judged. A
 * MEMBER's session on a shared daemon runs in the member's own container on
 * their OWN credential, so `spenderEmail` names whose is judged — the attach
 * route is no turn-owner request, and the task's credential there would be the
 * project's service one. `peek` decides without taking the override — the
 * page calls it first, then again without `peek` once its own refusals have
 * passed, so an override is never spent on a session the page refuses anyway.
 * Returns the refusal to answer with, or null to go ahead.
 */
export async function webInteractiveRefusal(
  projectRoot: string,
  task: Task,
  config: ResolvedConfig,
  mode: 'pair' | 'chat',
  peek: boolean,
  spenderEmail: string | null = null,
): Promise<{ ok: false; status: 429; message: string } | null> {
  try {
    if (spenderEmail) {
      const spend = await spendCredentialFor(projectRoot, config, task.agent_id, spenderEmail, displayId(task));
      await assertSpendAllowed({
        actor: 'human',
        peek,
        judge: (threshold) => usagePauseForSpend(projectRoot, config, spend, threshold),
        what: `the ${mode} of ${displayId(task)}`,
        refused: `Task ${displayId(task)} was not ${NOT_DONE[mode]}`,
      });
    } else {
      await assertTurnStartAllowed(projectRoot, { task, config, actor: 'human', verb: mode, peek });
    }
    return null;
  } catch (err) {
    if (err instanceof RpcError && err.code === 'usage_paused') return { ok: false, status: 429, message: err.message };
    throw err;
  }
}
// --- Usage-limit readings as one view (`lazy stats limits --json`, `lazy_usage_limits`) ---

/**
 * The credential a task's CURRENT turn is spending — what its agent is allowed
 * to see readings for.
 *
 * On a Teams host that is the live placeholder binding the launch pointed at
 * the turn owner's (or the service) credential: the one record of what is
 * actually billed, which a request-scoped owner lookup cannot answer from inside
 * an agent's own MCP call. No live binding (the turn is over) → null, and the
 * agent sees nothing credential-specific. Elsewhere it is the proxy's own
 * upstream → credential map for the task's profile, as the pause gate uses.
 */
export async function taskViewCredential(
  projectRoot: string,
  config: ResolvedConfig,
  task: Task,
): Promise<string | null> {
  if (await teamModeEnabled(projectRoot)) {
    const binding = await getTaskSessionBinding(projectRoot, task.id);
    if (!binding || binding.revokedAt !== null) return null;
    return usageLimitCredentialKey({ userId: binding.ownerUserId, upstream: '' });
  }
  return (await turnSpendCredential(projectRoot, config, task))?.credential ?? null;
}

/** Who is asking for the usage-limit view over MCP — from the authenticated token, never an argument. */
export type UsageLimitsCaller =
  | { kind: 'task'; taskId: string }
  /** `label` is the builder's MCP token label (`builder-<id>` for a daemon-owned session). */
  | { kind: 'builder'; label: string | null };

/**
 * Seed the daemon's readings for the view, FAILING LOUDLY. An empty reading
 * list must mean "nothing recorded", never "the record could not be read" — a
 * builder planning from `readings: []` would read it as untouched headroom.
 * The readings come from Storage first, then the bounded audit log
 * (`seedUsageReadings`, src/daemon/usage-readings.ts); saved readings that
 * cannot be read are the failure that matters, so they are refused here with
 * the same message every other surface shows.
 */
export async function seedUsageLimitsView(projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  await seedUsageReadings(projectRoot, config);
  const storeError = usageReadingsStoreError();
  if (storeError) throw new RpcError(500, usageLimitsUnreadableMessage(storeError));
}

/**
 * The credential a builder SESSION spends: a daemon-owned session binds its
 * member's credential under its builder id, and its MCP token is labelled
 * `builder-<id>`. Null for any other builder (a host `lazy builder`, a session
 * whose binding is gone).
 */
async function builderViewCredential(projectRoot: string, label: string | null): Promise<string | null> {
  const id = label?.startsWith('builder-') ? label.slice('builder-'.length) : null;
  if (!id) return null;
  const binding = await getTaskSessionBinding(projectRoot, id);
  if (!binding || binding.revokedAt !== null) return null;
  return usageLimitCredentialKey({ userId: binding.ownerUserId, upstream: '' });
}

/**
 * The usage-limit view for an MCP caller, narrowed HERE, in the daemon, so no
 * reading the caller may not see ever leaves it:
 *   - a task agent: only the credential its own live turn spends;
 *   - the builder on a Lazy Teams host: no other member's credential (the
 *     service credential and its session's own, like a member's own CLI);
 *   - the builder on a single-person install: everything.
 * `seed` is injectable so its failure is testable; it runs before anything else.
 */
export async function describeUsageLimitsView(
  projectRoot: string,
  storage: Storage,
  caller: UsageLimitsCaller,
  seed: (projectRoot: string) => Promise<void> = seedUsageLimitsView,
): Promise<UsageLimitsView> {
  await seed(projectRoot);
  const state = await describeUsagePauseState(projectRoot, storage);
  const view = projectUsageLimits(daemonUsageLimits.readings(), state);
  if (caller.kind === 'builder') {
    if (!(await teamModeEnabled(projectRoot))) return view;
    return memberUsageLimitsView(
      view,
      await builderViewCredential(projectRoot, caller.label),
      usageLimitCredentialKey({ userId: SERVICE_CREDENTIAL_USER_ID, upstream: '' }),
    );
  }
  const task = await storage.getTask(caller.taskId);
  if (!task) throw new RpcError(404, `Task not found: ${caller.taskId}`);
  const config = await loadConfig(projectRoot);
  return scopeUsageLimitsView(view, await taskViewCredential(projectRoot, config, task), task.id);
}
