/**
 * RPC dispatch layer — routes CLI queries through the daemon.
 *
 * In v0.11+, the daemon is required. CLI commands call these functions
 * to get structured data via daemon RPC. The only exception is test mode
 * (LAZY_TEST=1) and daemon-self mode (LAZY_IS_DAEMON=1), where tryRpc()
 * returns null and we fall back to calling handlers directly.
 *
 * This module is intentionally thin — all command logic lives in
 * rpc-handlers.ts. This file only handles:
 * 1. tryRpc → if null (test/daemon-self) → call handler with project root
 * 2. Deserialization (e.g., Map reconstruction from JSON)
 * 3. Error translation (RpcError → return types the CLI expects)
 */

import type { ReviewSettingsOverrides } from '../review/mode';
import { tryRpc, RpcApplicationError } from './client';
import {
  handleList,
  handleBlocked,
  handleActive,
  handleShow,
  handleSearch,
  handleDiff,
  handleWait,
  handleStartTask,
  handleUnblockTask,
  handleAskTask,
  handleReviewTask,
  handleAwaitClaimedTurn,
  handleAcceptTaskPreflight,
  handleAcceptTask,
  handleRejectTask,
  handleCloseTask,
  handleReopenTask,
  handleSyncTask,
  handleReparentTask,
  handleLinkTask,
  handleResumeTask,
  handleGetDaemonMcpConfig,
  handleGetProjectSettings,
  handleSetProjectSettings,
  handleRevokeDaemonMcpToken,
  handleConcurrency,
  handleBuilderSlot,
  handleEditComment,
  handleIdentity,
  handleUsageLimits,
  RpcError,
} from './rpc-handlers';
import { resolveLazyRoot, resolveStorage } from '../preconditions';
import { admitInteractiveSession, describeUsagePauseState, type UsagePauseState } from './usage-pause';
import type { AcceptGateInfo } from './task-lifecycle';
import type { SelfSyncStep } from './self-sync';
import type { TaskWithSession } from '../task/tree';
import type { TaskShowData } from '../task/show-data';
import type { SearchResult } from '../storage';
import type { RunnerType } from '../config/types';
import type { Actor, ActorInput, RaisedItemResolution, ReviewReport } from '../types';
import type { ClaimedTurnWaitResult } from './task-lifecycle';
import type { ProgressEmitter } from './progress';
import type { RpcObservers } from './client';
import type { EffectiveProjectSettings } from './project-settings';
import type { UsageLimitReading } from '../proxy/usage-limits';
import type { IdentityAnswer } from '../identity';
import type { CommitRepairResult, ConfirmedRepair } from './repair-commits';
import type { BuilderSession } from '../storage/types';
import type { AttachSessionInfo } from './session-attach';


/**
 * What a caller may pass to watch a long operation run.
 *
 * A bare {@link ProgressEmitter} sees only phase changes; the observer pair
 * ALSO sees the daemon's liveness heartbeats, which is what lets a non-TTY
 * display say "still on Fetch upstream, 35s" during a phase that is genuinely
 * long. A CLI `PhaseDisplay` satisfies the object form structurally, so a
 * command passes the display itself.
 */
export type ProgressSink = ProgressEmitter | RpcObservers;

/** Normalize either sink form to the observer pair `tryRpc` expects. */
function observersOf(sink?: ProgressSink): RpcObservers {
  return typeof sink === 'function' ? { onProgress: sink } : (sink ?? {});
}

// --- List ---

export interface ListResult {
  tree: TaskWithSession[];
}

export async function queryTaskList(params: {
  all?: boolean;
  taskFilter?: string;
  /** Depth limit — see pruneTasksToDepth. Undefined means no limit. */
  levels?: number;
}): Promise<ListResult> {
  const rpc = await tryRpc<ListResult>('list', {
    all: params.all,
    taskFilter: params.taskFilter,
    levels: params.levels,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  try {
    return await handleList(root, params) as ListResult;
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// --- Blocked ---

export async function queryBlockedTasks(params: { levels?: number } = {}): Promise<ListResult> {
  const rpc = await tryRpc<ListResult>('blocked', { levels: params.levels });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleBlocked(root, params) as ListResult;
}

// --- Active ---

export async function queryActiveTasks(
  params: { taskFilter?: string; levels?: number } = {},
): Promise<ListResult> {
  try {
    const rpc = await tryRpc<ListResult>('active', { taskFilter: params.taskFilter, levels: params.levels });
    if (rpc) return rpc;
  } catch (err) {
    // Same user-error treatment as the direct path below: an unknown or
    // ambiguous task filter gets the handler's actionable message, not a stack.
    if (err instanceof RpcApplicationError && (err.status === 404 || err.status === 400)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const root = resolveLazyRoot();
  try {
    return await handleActive(root, params) as ListResult;
  } catch (err) {
    // Unknown / ambiguous task filter is a user error, not a crash — print the
    // handler's actionable message and exit, matching queryTaskList.
    if (err instanceof RpcError && (err.status === 404 || err.status === 400)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// --- Show ---

export type ShowResult =
  | { ambiguous: false; data: TaskShowData }
  | {
      ambiguous: true;
      matches: Array<{
        id: string;
        code: string | null;
        goal: string;
        status: string;
        /** Session's last_interaction_at, or created_at for an unstarted task. */
        lastInteractionAt: number;
      }>;
    }
  | null; // not found

/**
 * Deserialize show handler output into ShowResult.
 * Both daemon RPC and direct handler return the same shape —
 * childSessions is a plain object that needs Map reconstruction.
 */
function deserializeShowResult(raw: Record<string, any>): ShowResult {
  if (raw.ambiguous) {
    return { ambiguous: true, matches: raw.matches };
  }
  return {
    ambiguous: false,
    data: {
      ...raw as any,
      childSessions: new Map(Object.entries(raw.childSessions || {})),
    },
  };
}

export async function queryTaskShow(taskId: string): Promise<ShowResult> {
  try {
    const rpc = await tryRpc<Record<string, any>>('show', { taskId });
    if (rpc) return deserializeShowResult(rpc);
  } catch (err) {
    // A 404 from the daemon means "no such task". Return null so the caller can
    // fall back to conversation/file resolution, matching the direct-path
    // behavior below. Without this, `lazy show <conversation-session-id>` would
    // fail with "Task not found" whenever the daemon is running, because the
    // RPC error would propagate past the CLI's conversation fallback.
    if (err instanceof RpcApplicationError && err.status === 404) return null;
    throw err;
  }

  const root = resolveLazyRoot();
  try {
    const result = await handleShow(root, { taskId }) as Record<string, any>;
    return deserializeShowResult(result);
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) return null;
    throw err;
  }
}

// --- Search ---

export interface SearchQueryResult {
  query: string;
  results: SearchResult[];
  /** Present only on a zero-result tag query — explains why nothing matched. */
  hint?: string;
}

export async function querySearch(params: {
  query: string;
  fuzzy?: boolean;
  types?: string[];
}): Promise<SearchQueryResult> {
  const rpc = await tryRpc<SearchQueryResult>('search', {
    query: params.query,
    fuzzy: params.fuzzy,
    types: params.types?.length ? params.types : undefined,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleSearch(root, params) as SearchQueryResult;
}

// --- Diff ---

export interface DiffResult {
  output: string;
  /** The git range the diff was computed over, e.g. `main...HEAD`. */
  diffRange: string;
  /** The resolved task's canonical short id. */
  taskId: string;
  /** True when accepted-child squash commits were excluded from the path set. */
  scopedToDirect?: boolean;
  /** How many accepted children were excluded. */
  acceptedSubtaskCount?: number;
}

export async function queryDiff(params: {
  taskId: string;
  full?: boolean;
  /** Whole-branch escape hatch: do not exclude accepted children's files. */
  fullBranch?: boolean;
  /** Restrict the diff to these pathspecs. */
  files?: string[];
  /** Scope the diff to one review region's files. */
  region?: string;
  /** Which "how to get the full diff" hint to render. Default 'cli'. */
  surface?: 'cli' | 'mcp';
}): Promise<DiffResult> {
  const rpc = await tryRpc<DiffResult>('diff', {
    taskId: params.taskId,
    full: params.full,
    fullBranch: params.fullBranch,
    files: params.files?.length ? params.files : undefined,
    region: params.region,
    surface: params.surface,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  // Errors PROPAGATE — they are not turned into diff output. Rendering
  // "Worktree is gone and branch X not found locally or on remote." as if it
  // were a diff exited 0 with the failure on STDOUT, so `lazy diff` looked
  // successful to every script and to the human's eye. The daemon path already
  // fails loud here (tryRpc throws RpcApplicationError); this fallback exists
  // only for test/daemon-self mode and must behave identically.
  return await handleDiff(root, params) as DiffResult;
}

// --- Commit-record repair ---

/**
 * Plan (or apply) the repair of recorded commit lists.
 *
 * Same daemon-first / in-process-fallback shape as `queryDiff`; the rule that
 * decides which commits belong to a task lives in the daemon, never here.
 *
 * `confirm` is the plan the caller already showed the human: the apply pass
 * re-plans only those tasks (so every refusal runs again) instead of sweeping
 * the whole store a second time. See ConfirmedRepair in ./repair-commits.
 */
export async function repairCommits(params: {
  taskId?: string;
  all?: boolean;
  apply?: boolean;
  confirm?: ConfirmedRepair[];
}, progress?: ProgressSink): Promise<CommitRepairResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<CommitRepairResult>('repairCommits', {
    taskId: params.taskId,
    all: params.all,
    apply: params.apply,
    confirm: params.confirm,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleRepairCommits } = await import('./repair-commits');
  return handleRepairCommits(root, params as Record<string, unknown>, observers.onProgress);
}

// --- Review regions ---

/**
 * The task's region cover, through the daemon.
 *
 * Same daemon-first / in-process-fallback shape as `queryDiff`: the daemon
 * owns the carving, and the direct call exists only for test and daemon-self
 * mode. Errors propagate — "no such region" must never look like an empty
 * region list.
 */
export async function queryRegions(params: {
  taskId: string;
  /** Ask for one region in full (its file lists) alongside the summaries. */
  region?: string;
  /**
   * Read the git carve instead of the task's declared walkthrough, and accept
   * a cover carved at an older head instead of paying for a recarve. The
   * carve is the agent-facing authoring hint; human surfaces never pass this.
   */
  provenance?: boolean;
  allowStale?: boolean;
  /** Show regions down to this depth (default 0: top level), or every one. */
  depth?: number | 'all';
  offset?: number;
  limit?: number;
}): Promise<import('./regions-service').RegionsResult> {
  type R = import('./regions-service').RegionsResult;
  const rpc = await tryRpc<R>('regions', {
    taskId: params.taskId,
    provenance: params.provenance,
    region: params.region,
    depth: params.depth,
    allowStale: params.allowStale,
    offset: params.offset,
    limit: params.limit,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleRegions } = await import('./regions-service');
  return await handleRegions(root, params) as R;
}

/**
 * Validate a walkthrough and resolve its directory/glob file items, through
 * the daemon — the write-side twin of `queryRegions`.
 *
 * A cap refusal comes back as `refused` rather than as an error: the caller
 * records it against the task before raising it, so the reviewer can see that
 * the cap was hit and not only the smaller walkthrough that followed.
 */
export async function expandPresentation(params: {
  taskId: string;
  presentation: unknown;
}): Promise<import('./presentation-expand').ExpandPresentationResult> {
  type R = import('./presentation-expand').ExpandPresentationResult;
  const rpc = await tryRpc<R>('expandPresentation', params);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleExpandPresentation } = await import('./presentation-expand');
  return await handleExpandPresentation(root, params as unknown as Record<string, unknown>) as R;
}

/** Set the human overlay on one region: a name, a sign-off, or both. */
export async function setRegionOverlay(params: {
  taskId: string;
  region: string;
  name?: string;
  /** Free-form actor. An empty string clears it. */
  owner?: string;
  signOff?: boolean;
}): Promise<{ taskId: string; region: string; overlay: import('../regions').RegionOverlay }> {
  type R = { taskId: string; region: string; overlay: import('../regions').RegionOverlay };
  const rpc = await tryRpc<R>('regionOverlay', params);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleRegionOverlay } = await import('./regions-service');
  return await handleRegionOverlay(root, params) as R;
}

// --- Wait ---

export interface WaitTaskSnapshot {
  task_id: string;
  display_id: string;
  code: string | null;
  status: string;
}

export interface WaitResult {
  task_id: string;
  /** Task code, or short id when the task has no code. */
  display_id?: string;
  status: string;
  timed_out: boolean;
  turn_count?: number;
  latest_turn?: {
    sequence: number;
    role: string;
    timestamp: number;
  };
  /** Every task waited on, with its status at return time. */
  tasks?: WaitTaskSnapshot[];
  /** Tasks still working at return time (excludes the winner). */
  pending?: WaitTaskSnapshot[];
  /**
   * Present ONLY when the winner's worktree holds an unresolved merge — a task
   * that is mid-merge must never read as a settled `blocked`
   * (fix-sync-silent-conflict).
   */
  merge_state?: { merge_in_progress: boolean; unmerged_files: string[]; summary: string };
  /**
   * Tip SHA when the wait settles: accept-tag commit if `complete`, else the
   * task branch HEAD. Matches the SHA in the parent's `[Subtask accepted]`
   * comment after accept so agents can de-dupe wait vs note.
   */
  head_sha?: string;
}

/**
 * Wait for the FIRST of one or more tasks to finish its turn.
 *
 * `taskIds` races the whole set inside a SINGLE daemon request — N parallel
 * client-side waits would burn a connection per task and still leave the losers
 * to cancel.
 */
export async function queryWait(params: {
  taskId?: string;
  taskIds?: string[];
  timeout?: number;
}): Promise<WaitResult> {
  try {
    const rpc = await tryRpc<WaitResult>('wait', {
      taskId: params.taskId,
      taskIds: params.taskIds,
      timeout: params.timeout,
    });
    if (rpc) return rpc;
  } catch (err) {
    // The daemon answered with an application error. Re-shape it as an RpcError
    // so the status survives for callers that map errors onto HTTP — same
    // reasoning as the direct path below.
    if (err instanceof RpcApplicationError) {
      throw new RpcError(err.status, err.message);
    }
    throw err;
  }

  const root = resolveLazyRoot();
  // INVARIANT: propagate the RpcError as-is — do NOT flatten it to a plain
  // Error. This is the in-daemon path (LAZY_IS_DAEMON=1 bypasses tryRpc), so
  // the caller is usually the daemon's own POST /mcp/:taskId/:toolName route,
  // which maps `err.status` onto the HTTP status. Flattening turned every
  // argument mistake (RpcError 400, e.g. a missing task_id) into an HTTP 500,
  // which reads as "the daemon crashed" and sends the operator down the wrong
  // path. RpcError extends Error, so callers that only read `.message` are
  // unaffected.
  return await handleWait(root, params) as WaitResult;
}

// --- Start Task ---

export interface StartTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  parentBranch: string | null;
  parentDisplayId: string | null;
  runnerType: string;
  warnings: string[];
  /** Set when the usage pause HELD an agent's start instead of launching it. */
  usagePauseHeld?: { message: string };
}

/**
 * An opt-in flag on the wire: `true` when set, ABSENT otherwise — never `false`.
 *
 * The daemon reads every one of these as "off unless true", so `false` and
 * absent are the same act. They are not the same REQUEST: Lazy Teams' proxy
 * refuses a body key its per-command list does not name, and these flags are
 * off that list on purpose (each skips a gate or does something the browser
 * cannot). Sending `forceLocal: false` on every `lazy start` got the ordinary
 * start refused in a clone bound to Teams, for a flag nobody had set.
 */
function optInFlag(flag: boolean | undefined): true | undefined {
  return flag === true ? true : undefined;
}

export async function queryStartTask(params: {
  taskId: string;
  modelOverride?: string;
  agentId?: string;
  forceLocal?: boolean;
  retargetOrphan?: boolean;
  effortOverride?: string;
  reviewOverrides?: ReviewSettingsOverrides;
  runnerOverride?: RunnerType;
  actor: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
  /** W3C trace context propagated from the CLI so daemon spans stitch onto the CLI trace. */
  traceparent?: string;
}, progress?: ProgressSink): Promise<StartTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<StartTaskRpcResult>('startTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    agentId: params.agentId,
    forceLocal: optInFlag(params.forceLocal),
    retargetOrphan: optInFlag(params.retargetOrphan),
    effortOverride: params.effortOverride,
    reviewOverrides: params.reviewOverrides && Object.values(params.reviewOverrides).some((v) => v !== undefined)
      ? params.reviewOverrides
      : undefined,
    runnerOverride: params.runnerOverride,
    actor: params.actor,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
    traceparent: params.traceparent,
  }, observers);
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleStartTask(root, params, observers.onProgress) as StartTaskRpcResult;
}

// --- Concurrency limits ---

export interface ConcurrencyLimitState {
  /** The lazy.toml value. */
  configured: number;
  /** The ephemeral daemon override, or null when none is set. */
  override: number | null;
  /** Effective cap: override if set, else configured. */
  limit: number;
  /** How many are running right now. */
  running: number;
}

export interface ConcurrencyResult {
  builders: ConcurrencyLimitState;
}

export async function queryConcurrency(params: {
  action?: 'get' | 'set' | 'reset';
  key?: string;
  value?: number;
} = {}): Promise<ConcurrencyResult> {
  const rpc = await tryRpc<ConcurrencyResult>('concurrency', {
    action: params.action,
    key: params.key,
    value: params.value,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleConcurrency(root, params) as ConcurrencyResult;
}

// --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---

export async function queryUsagePause(params: {
  action?: 'get' | 'set' | 'reset' | 'admitInteractive';
  value?: string | number;
  taskId?: string;
  agentId?: string;
  /** Also judge a model run beside a task (the builder role's credential). */
  beside?: boolean;
  /** `admitInteractive`: which session is opening. */
  surface?: 'pair' | 'chat';
  /** `admitInteractive`: decide without taking the override (a pre-flight). */
  peek?: boolean;
  /** The channel asking — only a `human` one may set or use the override. */
  actor?: Actor;
  /** The pre-flight's own eligibility: `false` judges the task without the pending override. */
  usagePauseOverrideEligible?: boolean;
} = {}): Promise<UsagePauseState> {
  const rpc = await tryRpc<UsagePauseState>('usagePause', params);
  if (rpc) return rpc;
  // No daemon: nothing is launching turns, and an override would be set in a
  // process that exits with this command — refuse rather than pretend. (A
  // reset has nothing to clear, so it simply reports the state.)
  if (params.action === 'set') {
    throw new Error(
      'The daemon is not running, so there is no override to change: overrides live in the running ' +
      'daemon only. Start it with `lazy daemon start` and try again.',
    );
  }
  const root = resolveLazyRoot();
  // The RPC was bypassed (this process IS the daemon, or the in-process test
  // harness): an interactive session is still JUDGED, in-process, exactly as
  // the daemon would judge it — never admitted unjudged.
  if (params.action === 'admitInteractive') {
    // The process-wide store (the daemon's own, or the test harness's): never
    // closed here, since other code in this process shares it.
    const storage = process.env.LAZY_IS_DAEMON === '1'
      ? await (await import('./rpc-handlers')).getOrCreateStorage()
      : await resolveStorage();
    await admitInteractiveSession(root, storage, {
      surface: params.surface ?? 'pair', taskId: params.taskId, actor: params.actor, peek: params.peek,
    });
    return describeUsagePauseState(root, storage);
  }
  return describeUsagePauseState(root, null);
}

// --- Builder admission (authoritative max_concurrent_builders gate) ---

export interface BuilderAdmissionResult {
  admitted: boolean;
  /** Slots in use after the decision (an admitted builder is counted). */
  running: number;
  /** The effective cap the decision was made against. */
  limit: number;
}

/**
 * Ask the daemon whether this builder may launch, reserving its slot when the
 * answer is yes. Every builder launcher must call this immediately before
 * spawning the container — the daemon, not the caller, decides.
 */
export async function admitBuilder(builderId: string): Promise<BuilderAdmissionResult> {
  const rpc = await tryRpc<BuilderAdmissionResult>('builderSlot', { action: 'admit', builderId });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleBuilderSlot(root, { action: 'admit', builderId }) as BuilderAdmissionResult;
}

/** Release a slot reserved by {@link admitBuilder}. Idempotent. */
export async function releaseBuilder(builderId: string): Promise<void> {
  const rpc = await tryRpc<{ released: boolean }>('builderSlot', { action: 'release', builderId });
  if (rpc) return;

  const root = resolveLazyRoot();
  await handleBuilderSlot(root, { action: 'release', builderId });
}

// --- Identity ---

/**
 * Who the DAEMON will attribute this person's writes to.
 *
 * Asked, never resolved locally: the daemon's environment is the authority, and
 * a CLI invoked from a different shell may see different git config than the
 * process that does the writing (docs/design/actor-identity-and-remote-clients.md
 * §3.4). The fallback path resolves it directly only because there is no daemon
 * to ask — test and daemon-self mode, where this process IS the writer.
 */
export async function queryIdentity(): Promise<IdentityAnswer> {
  const rpc = await tryRpc<IdentityAnswer>('identity', {});
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleIdentity(root);
}

// --- Project settings overlay (docs/design/lazy-teams.md §11) ---

export async function queryProjectSettings(): Promise<EffectiveProjectSettings> {
  const rpc = await tryRpc<EffectiveProjectSettings>('getProjectSettings', {});
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleGetProjectSettings(root) as EffectiveProjectSettings;
}

export async function writeProjectSettings(params: {
  /** Omit (or pass empty) to clear the override back to the repository default. */
  defaultModel?: string;
  actor?: string;
}): Promise<EffectiveProjectSettings> {
  const rpc = await tryRpc<EffectiveProjectSettings>('setProjectSettings', params);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleSetProjectSettings(root, params) as EffectiveProjectSettings;
}

// --- Get Daemon MCP Config ---

export interface DaemonMcpConfigResult {
  configPath: string;
}

export async function queryDaemonMcpConfig(params: {
  name?: string;
  /**
   * pid of the session that will own this credential — `lazy builder` passes
   * its own. The daemon uses it to keep a LIVE builder's token out of the
   * eviction path when the registry's builder cap trips (see mcp-tokens.ts).
   */
  ownerPid?: number;
}): Promise<DaemonMcpConfigResult> {
  const rpc = await tryRpc<DaemonMcpConfigResult>('getDaemonMcpConfig', {
    name: params.name,
    ownerPid: params.ownerPid,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleGetDaemonMcpConfig(root, params) as DaemonMcpConfigResult;
}

// --- Revoke Daemon MCP Token ---

export interface RevokeDaemonMcpTokenResult {
  /** How many tokens were dropped (0 when already revoked). */
  revoked: number;
}

/**
 * Revoke the token minted for a builder session. Runs in the daemon, which owns
 * the registry cache — see handleRevokeDaemonMcpToken.
 */
export async function queryRevokeDaemonMcpToken(params: {
  name: string;
}): Promise<RevokeDaemonMcpTokenResult> {
  const rpc = await tryRpc<RevokeDaemonMcpTokenResult>('revokeDaemonMcpToken', {
    name: params.name,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleRevokeDaemonMcpToken(root, params) as RevokeDaemonMcpTokenResult;
}

// --- Unblock Task ---

export interface UnblockTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  turnNumber: number;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
  /** Queued web review comments batched into this turn and marked delivered. */
  deliveredReviewComments: number;
}

export async function queryUnblockTask(params: {
  taskId: string;
  message: string;
  modelOverride?: string;
  raisedResolutions?: RaisedItemResolution[];
  retargetOrphan?: boolean;
  notesInEditor?: boolean;
  effortOverride?: string;
  agentOverride?: string;
  permissionMode?: 'plan' | 'default';
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<UnblockTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<UnblockTaskRpcResult>('unblockTask', {
    taskId: params.taskId,
    message: params.message,
    modelOverride: params.modelOverride,
    raisedResolutions: params.raisedResolutions,
    retargetOrphan: optInFlag(params.retargetOrphan),
    notesInEditor: params.notesInEditor,
    effortOverride: params.effortOverride,
    agentOverride: params.agentOverride,
    permissionMode: params.permissionMode,
    actor: params.actor,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
  }, observers);
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = resolveLazyRoot();
  return await handleUnblockTask(root, params, observers.onProgress) as UnblockTaskRpcResult;
}

// --- Ask Task (read-only Q&A) ---

/**
 * What STARTING an ask returns. There is no answer here unless the ask was
 * answered from the task's stored RECORD, which runs nothing.
 */
export interface AskTaskRpcResult {
  /** 'answered' = complete (record route). 'started' = an agent turn is running. */
  outcome: 'answered' | 'started';
  taskId: string;
  displayId: string;
  sessionId: string;
  /** Sequence the answer will occupy. 'started' only — pass to queryAwaitClaimedTurn. */
  turnSequence?: number;
  containerName?: string;
  /** Absent on a record-derived answer, which records no turn. */
  turnNumber?: number;
  /** 'answered' only. */
  answer?: string;
  /** Live resumed session, or the task's stored record. See AskTaskResult. */
  derivedFrom?: 'live-session' | 'stored-record';
  /** The sentence saying where a record-derived answer came from. */
  provenance?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  warnings: string[];
  timings: {
    daemon_ms: number;
    wait_ms: number;
    agent_ms?: number;
  };
}

export async function queryAskTask(params: {
  taskId: string;
  message: string;
  effortOverride?: string;
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<AskTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<AskTaskRpcResult>('askTask', {
    taskId: params.taskId,
    message: params.message,
    effortOverride: params.effortOverride,
    actor: params.actor,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleAskTask(root, params, observers.onProgress) as AskTaskRpcResult;
}

// --- Review Task (read-only review in a new session) ---

/** What STARTING a review returns. The report lands as a turn — see queryAwaitClaimedTurn. */
export interface ReviewTaskRpcResult {
  taskId: string;
  displayId: string;
  sessionId: string;
  /** Sequence the report will occupy — pass to queryAwaitClaimedTurn. */
  turnSequence: number;
  turnNumber: number;
  containerName: string;
  warnings: string[];
  timings: {
    daemon_ms: number;
    wait_ms: number;
  };
}

export async function queryReviewTask(params: {
  taskId: string;
  modelOverride?: string;
  effortOverride?: string;
  autoFix?: boolean;
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<ReviewTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<ReviewTaskRpcResult>('reviewTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
    autoFix: params.autoFix,
    actor: params.actor,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleReviewTask(root, params, observers.onProgress) as ReviewTaskRpcResult;
}

// --- Await a claimed turn (the blocking half of ask / review) ---

/**
 * Wait for an ask/review turn that {@link queryAskTask} / {@link queryReviewTask}
 * started.
 *
 * Human surfaces (`lazy ask`, `lazy review`, the TUI, the web dialog) keep a
 * blocking UX by calling this straight after starting the turn. `timeoutMs`
 * bounds only the caller: giving up leaves the turn running and its answer
 * still lands as a turn on the task.
 */
export async function queryAwaitClaimedTurn(params: {
  taskId: string;
  sessionId: string;
  turnSequence: number;
  timeoutMs?: number;
}, progress?: ProgressSink): Promise<ClaimedTurnWaitResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<ClaimedTurnWaitResult>('awaitClaimedTurn', {
    taskId: params.taskId,
    sessionId: params.sessionId,
    turnSequence: params.turnSequence,
    timeoutMs: params.timeoutMs,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleAwaitClaimedTurn(root, params, observers.onProgress) as ClaimedTurnWaitResult;
}

/** An ask started and then waited out, for a surface with a blocking UX. */
export interface AwaitedAskResult {
  taskId: string;
  displayId: string;
  sessionId: string;
  turnNumber?: number;
  answer: string;
  derivedFrom: 'live-session' | 'stored-record';
  provenance?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  warnings: string[];
}

/**
 * Start an ask and block until its answer lands — the pre-async `lazy ask` UX,
 * rebuilt out of the two halves.
 *
 * Only human surfaces do this. An agent starts the turn and waits with
 * `lazy_wait`, which is what keeps its own turn cheap and interruptible.
 */
export async function queryAskTaskAwaited(params: {
  taskId: string;
  message: string;
  effortOverride?: string;
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<AwaitedAskResult> {
  const started = await queryAskTask(params, progress);
  if (started.outcome === 'answered') {
    return {
      taskId: started.taskId,
      displayId: started.displayId,
      sessionId: started.sessionId,
      turnNumber: started.turnNumber,
      answer: started.answer ?? '',
      derivedFrom: started.derivedFrom ?? 'stored-record',
      provenance: started.provenance,
      usage: started.usage,
      warnings: started.warnings,
    };
  }
  const settled = await queryAwaitClaimedTurn({
    taskId: started.taskId,
    sessionId: started.sessionId,
    turnSequence: started.turnSequence!,
  }, progress);
  if (settled.kind !== 'settled') {
    throw new Error(
      settled.kind === 'abandoned'
        ? settled.message
        : `Gave up waiting for the ask on ${started.displayId}. It is still running — ` +
          `its answer will land as an ask turn on the task.`,
    );
  }
  return {
    taskId: started.taskId,
    displayId: started.displayId,
    sessionId: started.sessionId,
    turnNumber: settled.turnNumber,
    answer: settled.content,
    derivedFrom: 'live-session',
    usage: settled.usage,
    warnings: started.warnings,
  };
}

/** A review started and then waited out, for a surface with a blocking UX. */
export interface AwaitedReviewResult {
  taskId: string;
  displayId: string;
  sessionId: string;
  turnNumber: number;
  answer: string;
  report: ReviewReport;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  warnings: string[];
}

/** Start a review and block until its report lands. See {@link queryAskTaskAwaited}. */
export async function queryReviewTaskAwaited(params: {
  taskId: string;
  modelOverride?: string;
  effortOverride?: string;
  autoFix?: boolean;
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<AwaitedReviewResult> {
  const started = await queryReviewTask(params, progress);
  const settled = await queryAwaitClaimedTurn({
    taskId: started.taskId,
    sessionId: started.sessionId,
    turnSequence: started.turnSequence,
  }, progress);
  if (settled.kind !== 'settled') {
    throw new Error(
      settled.kind === 'abandoned'
        ? settled.message
        : `Gave up waiting for the review on ${started.displayId}. It is still running — ` +
          `its report will land as a review turn on the task.`,
    );
  }
  if (!settled.review) {
    // A review turn with no parsed report is the reviewer crashing or being
    // stopped: the turn text says which. Surface it rather than a bare
    // "unparsed", which reads like the reviewer merely wrote prose.
    throw new Error(settled.content || 'The review turn produced no report.');
  }
  return {
    taskId: started.taskId,
    displayId: started.displayId,
    sessionId: started.sessionId,
    turnNumber: settled.turnNumber,
    answer: settled.content,
    report: settled.review,
    usage: settled.usage,
    warnings: started.warnings,
  };
}

// --- Accept Task Preflight ---

export interface AcceptTaskPreflightRpcResult {
  taskId: string;
  fullTaskId: string;
  displayId: string;
  worktreePath: string;
  branchName: string;
  sessionId: string;
  parentTaskId: string | null;
  mergeTargetBranch: string;
  isChildTask: boolean;
  parentDisplayId: string | null;
  taskStatus: string;
  commitCount: number;
  metadata: Record<string, string>;
  gate: AcceptGateInfo;
  /** Protected files reverted during the task — absent from the diff, so named here. */
  revertedProtectedFiles: string[];
  warnings: string[];
}

export async function queryAcceptTaskPreflight(params: {
  taskId: string;
  approvedFiles?: string[];
  raisedResolutions?: RaisedItemResolution[];
  acceptDirtyWorktree?: boolean;
  /** `--allow-review-issues` on the CLI — see AcceptTaskPreflightParams. */
  allowReviewIssues?: boolean;
  /** `--allow-queued-comments` on the CLI — see AcceptTaskPreflightParams. */
  allowQueuedComments?: boolean;
  actor?: ActorInput;
}): Promise<AcceptTaskPreflightRpcResult> {
  const rpc = await tryRpc<AcceptTaskPreflightRpcResult>('acceptTaskPreflight', {
    taskId: params.taskId,
    approvedFiles: params.approvedFiles,
    raisedResolutions: params.raisedResolutions,
    acceptDirtyWorktree: optInFlag(params.acceptDirtyWorktree),
    allowReviewIssues: optInFlag(params.allowReviewIssues),
    allowQueuedComments: optInFlag(params.allowQueuedComments),
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleAcceptTaskPreflight(root, params) as AcceptTaskPreflightRpcResult;
}

// --- Accept Task (Full) ---

export interface AcceptTaskRpcResult {
  taskId: string;
  displayId: string;
  status: 'merged' | 'pending';
  reason?: string;
  prUrl?: string;
  warnings: string[];
  /** The task is accepted, but post-merge follow-through failed — see AcceptTaskResult. */
  followThroughPending?: { steps: string[]; error: string };
}

/**
 * `onProgress` receives the accept's phase narration (see daemon/progress.ts).
 * Over RPC the frames arrive on the heartbeat envelope; on the in-process
 * fallback path (LAZY_TEST / LAZY_IS_DAEMON) the emitter is handed straight to
 * the handler, so the same output appears with or without a daemon.
 */
export async function queryAcceptTask(params: {
  taskId: string;
  reason?: string;
  /** Approval passphrase for a protected merge — see AcceptTaskParams.token. */
  token?: string;
  approvedFiles?: string[];
  raisedResolutions?: RaisedItemResolution[];
  acceptDirtyWorktree?: boolean;
  /** Merge despite a failing accept check — see AcceptTaskParams.allowBroken. */
  allowBroken?: boolean;
  /** `--allow-review-issues` on the CLI — see AcceptTaskParams. */
  allowReviewIssues?: boolean;
  /** `--allow-queued-comments` on the CLI — see AcceptTaskParams. */
  allowQueuedComments?: boolean;
  actor?: ActorInput;
  callerTaskId?: string;
}, progress?: ProgressSink): Promise<AcceptTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<AcceptTaskRpcResult>('acceptTask', {
    taskId: params.taskId,
    reason: params.reason,
    token: params.token,
    approvedFiles: params.approvedFiles,
    raisedResolutions: params.raisedResolutions,
    acceptDirtyWorktree: optInFlag(params.acceptDirtyWorktree),
    allowBroken: optInFlag(params.allowBroken),
    allowReviewIssues: optInFlag(params.allowReviewIssues),
    allowQueuedComments: optInFlag(params.allowQueuedComments),
    actor: params.actor,
    callerTaskId: params.callerTaskId,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleAcceptTask(root, params, observers.onProgress) as AcceptTaskRpcResult;
}

// --- Reject Task ---

export interface RejectTaskRpcResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function queryRejectTask(params: {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<RejectTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<RejectTaskRpcResult>('rejectTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleRejectTask(root, params, observers.onProgress) as RejectTaskRpcResult;
}

// --- Close Task ---

export interface CloseTaskRpcResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function queryCloseTask(params: {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<CloseTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<CloseTaskRpcResult>('closeTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleCloseTask(root, params, observers.onProgress) as CloseTaskRpcResult;
}

// --- Stop Task ---

export interface StopTaskRpcResult {
  taskId: string;
  displayId: string;
  reason: string;
  /**
   * Which ending the stop took — `task` (work turn halted, blocked, no
   * auto-resume) or `claim` (an ask/review shown out, status restored, no
   * gate). See `StopTaskResult` for why the daemon answers this rather than
   * letting a client re-derive it. Optional on the wire: an older daemon does
   * not send it, and a client that cannot tell must not guess.
   */
  ended?: 'task' | 'claim';
}

export async function queryStopTask(params: {
  taskId: string;
  reason: string;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<StopTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<StopTaskRpcResult>('stopTask', {
    taskId: params.taskId,
    reason: params.reason,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleStopTask } = await import('./rpc-handlers');
  return await handleStopTask(root, params, observers.onProgress) as StopTaskRpcResult;
}

// --- Reopen Task ---

export interface ReopenTaskRpcResult {
  taskId: string;
  displayId: string;
  previousStatus: string;
  newStatus: 'blocked' | 'backlog';
  hadSession: boolean;
  gitBranch: string | null;
  warnings: string[];
}

export async function queryReopenTask(params: {
  taskId: string;
  reason?: string;
  actor?: ActorInput;
}): Promise<ReopenTaskRpcResult> {
  const rpc = await tryRpc<ReopenTaskRpcResult>('reopenTask', {
    taskId: params.taskId,
    reason: params.reason,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleReopenTask(root, params) as ReopenTaskRpcResult;
}

// --- Submit Task ---

export interface SubmitTaskRpcResult {
  taskId: string;
  displayId: string;
  prUrl: string | null;
  warnings: string[];
}

export async function querySubmitTask(params: {
  taskId: string;
  actor?: ActorInput;
}): Promise<SubmitTaskRpcResult> {
  const rpc = await tryRpc<SubmitTaskRpcResult>('submitTask', {
    taskId: params.taskId,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleSubmitTask } = await import('./rpc-handlers');
  return await handleSubmitTask(root, params) as SubmitTaskRpcResult;
}

// --- Per-task environment variables ---

/**
 * Result of any `lazy env` operation.
 *
 * Carries key NAMES only — never values. That is the point: values leave the
 * daemon exactly once, into the launch env, and no client-side type can hold
 * one long enough to print it.
 */
export interface TaskEnvRpcResult {
  taskId: string;
  displayId: string;
  /** Task status, so the CLI can warn that a running container keeps its old env. */
  status: string;
  /** All variable names now set on the task, sorted. */
  keys: string[];
  /** `set`: the names written by this call. */
  changed?: string[];
  /** `unset`/`clear`: what this call removed. */
  removed?: string[] | number;
}

export async function queryTaskEnv(params: {
  action: 'list' | 'set' | 'unset' | 'clear';
  taskId: string;
  /** Only for `set`. The one path a value travels. */
  vars?: Record<string, string>;
  /** Only for `unset`. */
  keys?: string[];
}): Promise<TaskEnvRpcResult> {
  const rpc = await tryRpc<TaskEnvRpcResult>('taskEnv', {
    action: params.action,
    taskId: params.taskId,
    vars: params.vars,
    keys: params.keys,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleTaskEnv } = await import('./rpc-handlers');
  return await handleTaskEnv(root, params as unknown as Record<string, unknown>) as TaskEnvRpcResult;
}

// --- Resume Task ---

export interface ResumeTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
}

export async function queryResumeTask(params: {
  taskId: string;
  modelOverride?: string;
  effortOverride?: string;
  actor?: ActorInput;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<ResumeTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<ResumeTaskRpcResult>('resumeTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
    actor: params.actor,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleResumeTask(root, params, observers.onProgress) as ResumeTaskRpcResult;
}

// --- Sync Task ---

export interface SyncTaskRpcResult {
  taskId: string;
  displayId: string;
  /** `merged` / `conflict` are the self-sync route — see src/daemon/self-sync.ts. */
  status: 'up_to_date' | 'sync_launched' | 'pending_sync' | 'merged' | 'conflict' | 'held_by_member';
  message: string;
  warnings: string[];
  steps?: SelfSyncStep[];
  instructions?: string;
}

export async function querySyncTask(params: {
  taskId: string;
  actor?: ActorInput;
  /** The task whose own agent is calling — MCP only; see SyncTaskParams. */
  callerTaskId?: string;
  /** A person at their own terminal asked — see src/cli/human-terminal.ts. */
  usagePauseOverrideEligible?: boolean;
}, progress?: ProgressSink): Promise<SyncTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<SyncTaskRpcResult>('syncTask', {
    taskId: params.taskId,
    actor: params.actor,
    callerTaskId: params.callerTaskId,
    usagePauseOverrideEligible: params.usagePauseOverrideEligible,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleSyncTask(root, params, observers.onProgress) as SyncTaskRpcResult;
}

// --- Reparent Task ---

export interface ReparentTaskRpcResult {
  taskId: string;
  displayId: string;
  status: 'noop' | 'reparented' | 'reparented_no_sync';
  syncStatus?: SyncTaskRpcResult['status'];
  newParent: string;
  message: string;
  warnings: string[];
}

export async function queryReparentTask(params: {
  taskId: string;
  parent: string;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<ReparentTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<ReparentTaskRpcResult>('reparentTask', {
    taskId: params.taskId,
    parent: params.parent,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleReparentTask(root, params, observers.onProgress) as ReparentTaskRpcResult;
}

// --- Link Task ---

export interface LinkTaskRpcResult {
  taskId: string;
  displayId: string;
  goal: string;
  branch: string;
  status: string;
  prUrl: string | null;
  prState: string | null;
  commentsImported: number;
  parentDisplayId: string | null;
  warnings: string[];
}

export async function queryLinkTask(params: {
  ref: string;
  parent?: string;
  code?: string;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<LinkTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<LinkTaskRpcResult>('linkTask', {
    ref: params.ref,
    parent: params.parent,
    code: params.code,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  return await handleLinkTask(root, params, observers.onProgress) as LinkTaskRpcResult;
}

export interface DescribeLinkedTaskRpcResult {
  taskId: string;
  displayId: string;
  goal: string;
  goalUpdated: boolean;
  promptChars: number;
  warnings: string[];
}

export async function queryDescribeLinkedTask(params: {
  taskId: string;
  force?: boolean;
  actor?: ActorInput;
}, progress?: ProgressSink): Promise<DescribeLinkedTaskRpcResult> {
  const observers = observersOf(progress);
  const rpc = await tryRpc<DescribeLinkedTaskRpcResult>('describeLinkedTask', {
    taskId: params.taskId,
    force: params.force,
    actor: params.actor,
  }, observers);
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleDescribeLinkedTask } = await import('./rpc-handlers');
  return await handleDescribeLinkedTask(root, params, observers.onProgress) as DescribeLinkedTaskRpcResult;
}

// --- Upstream status / clone / redo / submit preflight ---

export async function queryGetTaskUpstreamStatus(params: {
  taskId: string;
}): Promise<import('./upstream-status').TaskUpstreamStatus> {
  const rpc = await tryRpc<import('./upstream-status').TaskUpstreamStatus>('getTaskUpstreamStatus', {
    taskId: params.taskId,
  });
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleGetTaskUpstreamStatus } = await import('./rpc-handlers');
  return await handleGetTaskUpstreamStatus(root, params);
}

export async function querySubmitTaskPreflight(params: {
  taskId: string;
  /** Who would submit — an intermediate target is honoured for a person only. */
  actor?: ActorInput;
}): Promise<import('../submit-confirmation').SubmitPreflight> {
  const rpc = await tryRpc<import('../submit-confirmation').SubmitPreflight>('submitTaskPreflight', {
    taskId: params.taskId,
    actor: params.actor,
  });
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleSubmitTaskPreflight } = await import('./rpc-handlers');
  return await handleSubmitTaskPreflight(root, params);
}

export async function queryCloneTask(params: {
  taskId: string;
  goal?: string;
  prompt?: string;
  code?: string;
  parent?: string;
  model?: string;
  agent?: string;
  sameBase?: boolean;
  base?: string;
  defaultParent?: boolean;
  actor?: ActorInput;
}): Promise<import('./clone-redo').CloneTaskResult> {
  const rpc = await tryRpc<import('./clone-redo').CloneTaskResult>('cloneTask', params);
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleCloneTask } = await import('./rpc-handlers');
  return await handleCloneTask(root, params);
}

export async function queryRedoTask(params: {
  taskId: string;
  reason: string;
  actor?: ActorInput;
}): Promise<import('./clone-redo').RedoTaskResult> {
  const rpc = await tryRpc<import('./clone-redo').RedoTaskResult>('redoTask', params);
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleRedoTask } = await import('./rpc-handlers');
  return await handleRedoTask(root, params);
}

export async function queryListReparentTargets(params: {
  exceptTaskId?: string;
}): Promise<{ tasks: Array<{ id: string; code: string | null; goal: string }>; branches: string[] }> {
  const rpc = await tryRpc<{ tasks: Array<{ id: string; code: string | null; goal: string }>; branches: string[] }>(
    'listReparentTargets',
    params,
  );
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleListReparentTargets } = await import('./rpc-handlers');
  return await handleListReparentTargets(root, params);
}

// --- Ensure Task Container ---

export interface EnsureTaskContainerRpcResult {
  containerName: string;
  worktreePath: string;
  runnerType: string;
  alreadyRunning: boolean;
}

/**
 * Bring a task's container up without starting a turn.
 *
 * Goes through the daemon because the container's MCP config carries a
 * per-container token only the daemon can mint — a CLI-side `docker run` would
 * leave the agent inside with no `lazy_*` tools on its next turn.
 */
export async function queryEnsureTaskContainer(params: {
  taskId: string;
  restart?: boolean;
}): Promise<EnsureTaskContainerRpcResult> {
  const rpc = await tryRpc<EnsureTaskContainerRpcResult>('ensureTaskContainer', {
    taskId: params.taskId,
    restart: params.restart ?? false,
  });
  if (rpc) return rpc;

  const root = resolveLazyRoot();
  const { handleEnsureTaskContainer } = await import('./rpc-handlers');
  return await handleEnsureTaskContainer(root, params) as EnsureTaskContainerRpcResult;
}

// --- Comment edit ---

/**
 * Edit a comment the agent has not yet seen. The daemon refuses (409, with the
 * reason) when it has — the rule lives in src/task/comment-edit.ts.
 */
export async function editComment(params: {
  taskId: string;
  commentId: string;
  content: string;
  actor?: ActorInput;
}): Promise<{ comment: import('../types').Comment }> {
  const rpc = await tryRpc<{ comment: import('../types').Comment }>('editComment', params);
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  return await handleEditComment(root, params);
}

// --- Server-side sessions (a bound clone's builder / pair / shell) ---

/**
 * Why a session call returned nothing: the in-process fallback every other
 * wrapper here has does not exist for these. A server-side session is the
 * daemon's by definition (design doc §5.2) — there is no local handler a
 * test-mode or daemon-self process could run in its place and mean the same
 * thing.
 */
function sessionNeedsDaemon(command: string): Error {
  return new Error(`${command}: server-side sessions are only reachable through a daemon or Lazy Teams.`);
}

/**
 * Start this member's builder session on the server — or, when one is already
 * running for them, return THAT one: a second `lazy builder` from the same
 * member joins the existing session rather than starting another (§5.7).
 */
export async function rpcStartBuilderSession(): Promise<BuilderSession> {
  const rpc = await tryRpc<BuilderSession>('startBuilderSession', {});
  if (rpc) return rpc;
  throw sessionNeedsDaemon('startBuilderSession');
}

/**
 * Discovery for the attach route: which session, which modes, and whether its
 * container is up. Asked before a terminal opens a socket so a refusal reaches
 * the person as the daemon's own sentence, not as a failed upgrade.
 */
export async function rpcAttachSession(id?: string): Promise<AttachSessionInfo> {
  const rpc = await tryRpc<AttachSessionInfo>('attachSession', { ...(id ? { id } : {}) });
  if (rpc) return rpc;
  throw sessionNeedsDaemon('attachSession');
}

/** End a builder session — terminal; the only way one stops for good (§5.7). */
export async function rpcEndBuilderSession(id: string): Promise<BuilderSession> {
  const rpc = await tryRpc<BuilderSession>('endBuilderSession', { id });
  if (rpc) return rpc;
  throw sessionNeedsDaemon('endBuilderSession');
}

/** Stop a builder session and keep it resumable: the next start picks its conversation up again. */
export async function rpcStopBuilderSession(id: string): Promise<BuilderSession> {
  const rpc = await tryRpc<BuilderSession>('stopBuilderSession', { id });
  if (rpc) return rpc;
  throw sessionNeedsDaemon('stopBuilderSession');
}

// --- Sync Task From Remote ---

/**
 * Import a task's new forge comments and reconcile a PR merged or closed on the
 * forge. Goes through the daemon so a merged PR's accept transition runs under
 * the daemon's lifecycle lock (see `handleSyncTaskFromRemote`); the in-process
 * fallback is the usual test-mode / daemon-self bypass.
 */
export async function querySyncTaskFromRemote(params: {
  taskId: string;
}): Promise<{ status: string }> {
  const rpc = await tryRpc<{ status: string }>('syncTaskFromRemote', { taskId: params.taskId });
  if (rpc) return rpc;
  const root = resolveLazyRoot();
  const { handleSyncTaskFromRemote } = await import('./rpc-handlers');
  return await handleSyncTaskFromRemote(root, params);
}

// --- Proxy usage-limit readings (src/proxy/usage-limits.ts) ---

export async function queryUsageLimits(): Promise<{ readings: UsageLimitReading[] }> {
  const rpc = await tryRpc<{ readings: UsageLimitReading[] }>('usageLimits', {});
  if (rpc) return rpc;

  // Daemon down: the same fold over the bounded audit log, in-process.
  const root = resolveLazyRoot();
  return await handleUsageLimits(root);
}
