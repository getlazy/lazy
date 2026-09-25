/**
 * Daemon RPC handlers — execute command logic and return structured data.
 *
 * The daemon holds a single long-lived Storage instance for its project.
 * All RPC handlers and the reconcile loop share this instance via
 * `getOrCreateStorage()`. This makes the daemon the single writer — CLI commands
 * use RemoteStorage and never touch .storage-lock.
 *
 * Handlers must NOT:
 * - Call process.exit()
 * - Write to stdout/stderr
 * - Import CLI rendering/theme modules
 * - Call storage.close() — the daemon owns the Storage lifecycle
 * - NEVER spawn lazy CLI as a subprocess (use internal functions instead)
 *
 * CRITICAL: The daemon has direct access to storage, runners, and all task
 * lifecycle functions. Never use getLazyCommand() or spawn lazy CLI from
 * daemon code — it causes deadlocks and storage lock contention.
 */

import { createTask as createTaskFromInput } from './create-task';
import { reviewSettingsViewOf } from '../review/mode';
import { existsSync } from 'fs';
import { getWorktreePath, getBranchNameFromId, displayId, shortId, taskRef } from '../task/identity';
import { parseStatsScope } from '../task/stats';
import { loadTaskStats } from '../task/stats-data';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { resolveTaskDiffContext } from './task-diff-context';
import { RpcError } from './rpc-error';
import {
  admitInteractiveSession,
  admitOneshotCommand,
  assertBesideLaunchAllowed,
  oneshotAllowanceValid,
  describeBesideLaunch,
  describeUsagePauseState,
  mayUseUsagePauseOverride,
  parseUsagePauseOverride,
  setUsagePauseOverride,
  USAGE_PAUSE_OVERRIDE_KEY,
  type UsagePauseState,
} from './usage-pause';
import { syncTaskFromRemote } from '../task/sync-remote';
import { parseCommentExternalRef } from '../remote/comment-identity';
import { editUnseenComment, CommentAlreadySeenError, CommentNotFoundError } from '../task/comment-edit';
import type { CommentExternalRef, CommentCreateOptions } from '../types';
import {
  requireString,
  requireNonBlankString,
  optionalString,
  optionalBoolean,
  optionalReviewOverrides,
  optionalNumber,
  requireNumber,
  optionalStringArray,
  optionalRaisedResolutions,
  optionalEnum,
  requireEnum,
  optionalActorInput,
  rejectLegacyActorUserId,
  requireActorInput,
  requireRaisedCreateInput,
} from './rpc-params';
import { handleClearStartServicesCmd, handleGetStartServicesCmd, handleSetStartServicesCmd } from './serve-service';
import { resolveProjectStartServicesCmd } from '../serve/start-cmd';
import {
  handleReviewQueue,
  handleNavCounts,
  handleReviewDiff,
  handleReviewRegions,
  handleReviewLineAttribution,
  handleReviewFileLines,
  handleReviewPresentations,
  handleReviewProseAnchors,
  handleReviewComments,
  handleReviewPostComment,
  handleReviewAsk,
  handleReviewRetryAsk,
  handleReviewPromoteDiscussion,
  handleConversationPromote,
  handleReviewWithdrawComment,
  handleReviewUnblock,
  handleReviewAccept,
  handleReviewSync,
  handleReviewViolationDecision,
  handleReviewResolveRaised,
  handleReviewUnresolveRaised,
  handleReviewFlagRaised,
  handleReviewPromoteRaised,
  handleReviewGetDraft,
  handleReviewSaveDraft,
  handleReviewVerify,
} from './rpc-review';
import {
  handleSaveMemoryRecord,
  handleDeleteMemoryRecord,
  handleCompactMemory,
  handleClearMemoryCompact,
  handleMemoryStatus,
} from './rpc-memory';
import { handleDoctorRun, handleDoctorReport, handleDoctorPreviewRemedy, handleDoctorApplyRemedy } from './rpc-doctor';
import { handleDaemonHealth } from './rpc-daemon-health';
import { loadConfig } from '../config/loader';
import { getNonHumanTurnCount, checkTurnBudget } from './turn-budget';
import { agentProfilesFor, agentProfileOrThrow, profileForAgentName, type AgentProfile } from '../config/agent-profiles';
import type { ResolvedConfig } from '../config/types';
import { getAuthEnvVars } from '../capture/claude';
import { credentialFromEnv } from './credential-gate';
import { credentialLabel, requiredCredentials, requiredProviders } from '../credentials/providers';
import { locateProfileCredential } from '../agent/credentials';
import type { DaemonCredentialEntry } from './auth-env';
import { createStorage, type Storage, type StorageBackend } from '../storage';
import { setTaskEnv, unsetTaskEnv, clearTaskEnv, listTaskEnvKeys } from './task-env';
import { tapStorageEvents } from './event-tap';
import { tapParentChildChanges } from './parent-child-tap';
import type { Task, SearchResult } from '../storage';
import { toFollowUpView } from '../raised/legacy-view';
import type { SpanRecord } from '../tracing/types';
import { withRootSpan, contextFromTraceparent } from '../tracing';
import type { TaskTarget, Actor, ActorInput, ActorRef, Turn, FileViolation } from '../types';
import type { RunnerType } from '../config/types';
import { VALID_EFFORT_LEVELS } from '../config/types';
import { DEFAULT_ONESHOT_EFFORT } from '../oneshot/types';
import { parentTaskIdOf, targetBranchOf, collectSubtreeIds, pruneTasksToDepth } from '../task-target';
import { buildTaskTree, collectActiveTasks } from '../task/tree';
import { loadTaskShowData } from '../task/show-data';
import { isDeferredBy, clusterProgressOf, clusterProgressPayload } from '../task/cluster-progress';
import { activeClusterCount, listClusterEntries, sortClusterEntries } from '../task/cluster-entries';
import {
  SHOW_SECTION_NAMES,
  parseShowSections,
  wantsSection,
  buildNotesState,
  buildShowChunks,
  buildShowFinal,
  buildShowReviews,
  type ShowSection,
} from '../task/show-sections';
import { acceptGateTurns, buildAcceptGate } from '../review/accept-gate';
import { isPendingDelivery } from '../server/review-actions';
import { queuedHumanFeedbackCount } from '../task/queued-feedback';
import { resolveOutstandingViolations } from '../protection/outstanding-resolver';
import { violationRecordsByFile } from '../protection/outstanding';
import { executeSearch, SearchPatternError, QueryParseError } from '../search';
import { getDiffStat, getDiffFull, getDiffPathSets, getFileAtCommit, getMergeBase, getRemoteDefaultBranch, branchExists, recoverMissingWorktreeWithFetch, countNewCommits } from '../git/operations';
import { resolveCommitScanBase } from '../task/session-commits';
import { validateFileLinesRequest, sliceFileLines } from '../review/file-lines';
import { readWorktreeFileNoFollow } from '../review/worktree-read';
import { getNewNotesSince, resolveNotesCutoff } from '../task/turn-context';
import { formatDate } from '../utils/format';
import { gitDiffPaths, resolveTaskDirectDiff, type TaskDirectDiffPlan } from '../task-diff-base';
import { readWorktreeMergeState, isMidMerge, describeMergeState, resolveTaskTipSha } from '../git/operations';
import { pathExists } from '../utils/fs';
import { saveConversationWithoutRegression } from '../import/conversation-storage';
import { launchTask, writeDaemonMcpConfig, type StartTaskParams } from './task-launcher';
import { editTask } from './edit-task';
import { raceWait, normalizeWaitInputs } from './wait-race';
import { revokeBuilderMcpToken } from './mcp-tokens';
import { LOGIN_TICKET_TTL_MS, mintDashboardLoginTicket } from './dashboard-sessions';
import { DASHBOARD_LOGIN_PARAM } from './dashboard-auth';
import { isManagedMode } from '../config/managed';
import { describeIdentity, resolveGitIdentity } from '../identity';
import { actorEmail, actorRole, canonicalPersonEmail, isPersonEmail } from '../actor-ref';
import { reviewerKey } from '../review-draft';
import { getActor } from '../constants';
import { isHumanInitiatedRpc, isStoreWritingRpc, PERSON_ATTRIBUTED_STORAGE_ACTORS } from './rpc-command-kinds';
import {
  mintDaemonToken,
  revokeDaemonTokens,
  lookupDaemonIdentity,
  lookupDaemonTokenLabel,
  type ActorIdentity,
} from './actor-tokens';
import {
  putUserCredential,
  revokeUserCredential,
  listUserCredentials,
  canonicalCredentialKey,
} from './user-credentials';
import { checkUserCredential, clearUserAuthRejection } from './credential-check';
import {
  runAsTurnOwnerRequest,
  type PendingTurnOwner,
  type TurnOwnerRequest,
} from './turn-owner';
import { resolveAgentIdForStorageCreateTask } from '../agent/task-agent';
import { effectiveProjectSettings, updateProjectSettings } from './project-settings';
import { assertAgentProfileRunnable, assertKnownAgentProfile } from './agent-profile-check';
import type { ProjectSettings } from '../storage/types';
import { readAuditRecords } from '../proxy/audit-log';
import { daemonUsageLimits, type UsageLimitReading } from '../proxy/usage-limits';
import { seedUsageReadings } from './usage-readings';
import {
  rejectionAgainstCurrentCredential,
  unresolvedAuthRejectionsByUser,
} from '../proxy/auth-verdict';
import { hasDaemonContext, getDaemonContext } from './context';
import type { ProgressEmitter } from './progress';
import { handleWatchProxyActivity } from './proxy-watch';
import { proxyBaseUrlForRunner, LOCAL_BACKEND_CREDS, resolveProfileLaunchCreds, resolveRoleTarget, roleTargetForProfile, targetEnvVars, usesSyntheticCreds, type LaunchSurface } from '../utils/role-target';
import { placeholderizeAuthEnv, type LaunchIdentity } from '../proxy/placeholder-env';
import { revokeBuilderCredentialGrant } from '../proxy/credential-broker';
// `approve` is gone on this branch (rework-accept-approve-collapse folded it
// into accept), so its lifecycle entry points are deliberately not imported.
import { launchUnblockTask, launchAskTask, launchReviewTask, awaitClaimedTurn, rejectTask, closeTask, stopTask, reopenTask, acceptTaskPreflight, acceptTask, syncTask, reparentTask, submitTask, resumeTask, type UnblockTaskParams, type AskTaskParams, type ReviewTaskParams, type RejectTaskParams, type CloseTaskParams, type StopTaskParams, type ReopenTaskParams, type AcceptTaskPreflightParams, type AcceptTaskParams, type SyncTaskParams, type ReparentTaskParams, type SubmitTaskParams, type ResumeTaskParams } from './task-lifecycle';
import { getTaskUpstreamStatus, formatUpstreamStatusLine } from './upstream-status';
import { cloneTask, redoTask, listReparentTargets } from './clone-redo';
import { linkTask, type LinkTaskParams } from './link-task';
import { submitTaskPreflight } from './submit-preflight';
import { ensureTaskContainer } from './task-container';
import { getTaskServeState } from '../serve/discovery';
import { probeServices } from '../serve/probe';
import { taskProgress } from './task-progress';
import type { Comment } from '../types';
import { logger } from '../utils/logger';
import { VERSION } from '../version';
import { groupScratchBySession, scratchEntry, searchScratch, scratchPathsMentionedIn } from '../builder/scratch-view';
import { createRunner } from '../runner';
import {
  countActiveBuilders,
  effectiveBuilderLimit,
  getLimitOverride,
  releaseBuilderSlot,
  setLimitOverride,
  tryAdmitBuilderSlot,
  LIMIT_KEYS,
  type LimitKey,
} from './concurrency';

// RpcError now lives in ./rpc-error so the input-validation helpers can raise
// it without importing this module. Re-exported here: every existing importer
// takes it from rpc-handlers.
export { RpcError };

/**
 * Single long-lived Storage instance for the daemon's project.
 *
 * The daemon is per-project and single-threaded (Bun's event loop), so
 * concurrent RPC calls are serialized naturally — no explicit mutex is needed.
 * Async operations may interleave, but FileStorage uses file-level locking
 * internally for individual operations, so this is safe.
 */
let daemonStorage: Storage | null = null;

/**
 * In-flight initialization promise. Memoized so concurrent first-callers (e.g.
 * the web handler, the proxy, and a reconcile tick all racing at startup) share
 * ONE createStorage()+lock.acquire() instead of each spinning up its own Storage
 * instance and contending for the filesystem lock. Without this, the proxy path
 * would initialize a second Storage that fights the daemon's own for the lock —
 * the single-writer violation behind the "Failed to acquire storage lock"
 * startup crash. Reset to null on failure so a later tick can retry.
 */
let daemonStorageInit: Promise<Storage> | null = null;

/** Module-level project root, set once by initDaemonStorage(). */
let daemonProjectRoot: string | null = null;

/**
 * Initialize the daemon storage module with the project root.
 * Must be called once during daemon startup before any RPC handlers run.
 */
export function initDaemonStorage(projectRoot: string): void {
  daemonProjectRoot = projectRoot;
}

/**
 * The project this daemon serves, or null in a process that is not one.
 *
 * For code that holds a Storage and no root — the system-identity resolution
 * behind a row written for a turn nobody asked for (src/daemon/turn-owner.ts).
 * Null is a real answer there: outside the daemon there is no configured
 * identity to resolve, and the row names nobody.
 */
export function getDaemonProjectRoot(): string | null {
  return daemonProjectRoot;
}

/**
 * Get or create the long-lived Storage instance for the daemon's project.
 * The instance stays open for the lifetime of the daemon process.
 *
 * The daemon is the sole writer — it acquires the storage lock once at startup
 * and holds it forever. All FileStorage write operations become re-entrant
 * (increment depth counter) instead of contending for the filesystem lock.
 *
 * Requires initDaemonStorage() to have been called first.
 */
export async function getOrCreateStorage(): Promise<Storage> {
  if (!daemonProjectRoot) {
    throw new Error('Daemon storage not initialized — call initDaemonStorage() first');
  }
  if (daemonStorage) return daemonStorage;
  // Memoize the in-flight init so concurrent first-callers share ONE Storage
  // instance (see daemonStorageInit above). The check-then-await in the old code
  // let two racing callers both pass `!daemonStorage` and each create their own.
  if (!daemonStorageInit) {
    const root = daemonProjectRoot;
    daemonStorageInit = (async () => {
      logger.debug('Initializing daemon storage...');
      const config = await loadConfig(root);
      const storage = await createStorage(root, {
        backend: config.storage.backend as StorageBackend,
        externalPath: config.storage.external_path || undefined,
      });
      // Acquire storage lock once and hold forever. The daemon is the sole writer
      // (CLI uses RemoteStorage, agents run in containers with their own data dir).
      // All FileStorage.withLock() calls become re-entrant within this process.
      await (storage as any).lock?.acquire?.();
      // Wrap AFTER the lock acquire (which reaches past the Storage interface
      // for `.lock`) so the tap never sits between a caller and lock state.
      // This is the single chokepoint for the event feed: the daemon holds the
      // only writable Storage in the system, so every writer — RPC, reconciler,
      // task lifecycle — flows through this one object. See src/daemon/event-tap.ts.
      // Parent-child notify sits OUTSIDE the event tap so the `[Subtask
      // added]` / `[Subtask removed]` comments it writes are themselves
      // published to the feed. See src/daemon/parent-child-tap.ts.
      const tapped = tapParentChildChanges(tapStorageEvents(storage));
      daemonStorage = tapped;
      // debug, not info: this is internal storage-lifecycle chatter. In the daemon
      // it's captured in the debug-level file log. Under the LAZY_TEST in-process
      // fallback (see requireStorage) this runs INSIDE the CLI process, where an
      // info-level line would print to the command's stdout and corrupt machine-
      // readable output (e.g. `lazy show --json`). Production CLIs never reach here
      // — they use RemoteStorage — so demoting it costs the daemon nothing.
      logger.debug(`Daemon storage initialized (backend: ${config.storage.backend})`);
      // The tapped instance, not the raw one — the memoized promise is what the
      // FIRST caller receives, so returning `storage` here would hand exactly
      // one caller an untapped Storage and drop its events on the floor.
      return tapped;
    })().catch((err) => {
      // Clear the memo so a later caller (e.g. the next reconcile tick, once a
      // contending lock holder releases) can retry — but surface THIS failure.
      daemonStorageInit = null;
      throw err;
    });
  }
  return daemonStorageInit;
}

/**
 * Close the long-lived Storage instance. Called on daemon shutdown.
 */
export async function closeAllStorage(): Promise<void> {
  if (daemonStorage) {
    logger.debug('Closing daemon storage...');
    try {
      await daemonStorage.close();
      logger.debug('Daemon storage closed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Error closing daemon storage: ${msg}`);
    }
    daemonStorage = null;
  }
  // Clear the init memo too, so a subsequent start (e.g. a teardown/retry in the
  // same process during tests) re-initializes cleanly instead of returning a
  // closed instance.
  daemonStorageInit = null;
}

/**
 * Open a fresh, short-lived Storage instance for a project.
 * Used by tests to verify data independently of the shared instance.
 * Not used by daemon RPC handlers — they use getOrCreateStorage() instead.
 */
export async function openProjectStorage(projectRoot: string): Promise<Storage> {
  // Resolve config relative to projectRoot, NOT the ambient process.cwd().
  // loadConfig defaults its search to process.cwd(); a caller running from a
  // different directory (e.g. an in-process test whose cwd is the dev repo, or
  // any tool invoked outside the target project) would otherwise pick up the
  // WRONG project's lazy.toml — resolving external_path to a foreign storage
  // path. This function takes an explicit root, so config must follow it.
  const config = await loadConfig(projectRoot);
  return createStorage(projectRoot, {
    backend: config.storage.backend as StorageBackend,
    externalPath: config.storage.external_path || undefined,
  });
}

/**
 * Dispatch an RPC request to the appropriate handler.
 *
 * `progress` is the caller's phase-narration sink (see ./progress.ts). Only
 * long, multi-phase commands use it; everything else ignores it, which is why
 * it is threaded rather than made part of `params` — it is a live callback into
 * the response stream, not a serializable request field.
 */
export async function handleRpc(
  command: string,
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
  caller: ActorIdentity = { kind: 'control' },
): Promise<unknown> {
  if (!existsSync(projectRoot)) {
    throw new RpcError(400, `Project root does not exist: ${projectRoot}`);
  }

  refuseCallerTaskIdFromUser(command, params, caller);

  // ON A SHARED HOST, A HUMAN ACTION GOES OUT ON THAT HUMAN'S TOKEN. Before
  // anything else, because the answer is about WHO MAY ASK rather than about
  // what the command does — and because a refusal must land before a store
  // write or a turn launch, not after.
  assertHumanActionCarriesAPerson(command, params, caller);

  // Identity is applied ONCE, here, rather than in each handler: a mutating
  // handler added later would otherwise silently keep trusting a
  // caller-supplied `actor`, and there is no test that can notice an
  // enforcement point nobody wrote.
  params = await applyCallerActor(command, projectRoot, params, caller);

  // WHO ASKED FOR THIS TURN, decided once, here — because this is the only
  // place that both knows the caller's derived identity and sees every
  // turn-launching command; a handler-by-handler version would silently miss
  // whichever one is added next. The launch path promotes it to the session,
  // where it attributes everything the agent writes for the length of the turn
  // (src/daemon/turn-owner.ts), and bills the turn to them when their identity
  // is one a control plane provisioned.
  //
  // A caller with no person behind it — the control plane on a managed host,
  // or a laptop whose git identity is unconfigured — asks as nobody, which
  // keeps meaning system-initiated.
  const owner = TURN_LAUNCHING_COMMANDS.has(command)
    ? await turnOwnerForCaller(projectRoot, caller)
    : null;
  const request = owner ? await turnOwnerRequest(params, owner) : null;
  if (request) {
    // THE OWNER LIVES IN THIS REQUEST'S SCOPE AND NOWHERE ELSE. Every launch
    // the command performs reads it from here, and so does work it queues and
    // finishes after returning — a review ask dispatched in the background —
    // because an async context follows the work that was started in it. A
    // concurrent request on the same task runs in its own scope; a turn the
    // daemon starts by itself (auto-deliver, auto-resume, the pending-sync
    // retry loop, a cluster restart) runs in none, and bills nobody even while
    // this request is still in flight. There is nothing to clear when the
    // request ends, so no outcome can leave an owner behind.
    return runAsTurnOwnerRequest(request, () =>
      dispatchRpc(command, projectRoot, params, progress, caller));
  }

  return dispatchRpc(command, projectRoot, params, progress, caller);
}

/** The command table itself. Split out so the turn-owner guard above can wrap it. */
async function dispatchRpc(
  command: string,
  projectRoot: string,
  params: Record<string, unknown>,
  progress: ProgressEmitter | undefined,
  caller: ActorIdentity,
): Promise<unknown> {
  switch (command) {
    case 'list': return handleList(projectRoot, params);
    case 'clusters': return handleClusters();
    // `loops` is the name this method had until 2026-09-20, kept answerable for
    // ONE release and removed in the next. A deployed Lazy Teams can be older
    // than the daemon it talks to, and there an unknown method is a hard
    // failure — the whole Clusters page becomes an error banner — where a
    // renamed FIELD is only a progress line that does not render. See
    // handleClusters for why the legacy answer also carries the legacy KEY.
    case 'loops': return handleClusters({ legacyKey: true });
    case 'blocked': return handleBlocked(projectRoot, params);
    case 'active': return handleActive(projectRoot, params);
    case 'show': return handleShow(projectRoot, params);
    case 'search': return handleSearch(projectRoot, params);
    // Builder scratch, read-only, for the web surfaces (src/builder/scratch-view.ts).
    case 'scratchList': return handleScratchList();
    case 'scratchShow': return handleScratchShow(params);
    case 'scratchSearch': return handleScratchSearch(params);
    case 'scratchMentions': return handleScratchMentions(params);
    case 'diff': return handleDiff(projectRoot, params);
    // Dynamic import for the same reason as `regions` below: it reaches back
    // into this module for getOrCreateStorage.
    case 'repairCommits':
      return (await import('./repair-commits')).handleRepairCommits(projectRoot, params, progress);
    case 'fileLines': return handleFileLines(projectRoot, params);
    // Dynamic so the regions service can import getOrCreateStorage from here
    // without a module cycle. Nothing else about it is special.
    case 'regions':
      return (await import('./regions-service')).handleRegions(projectRoot, params);
    // The overlay write is attributed to the CALLER, never to a request field —
    // see overlayActorOf in ./regions-service, the same posture as the review
    // drafts below.
    case 'regionOverlay':
      return (await import('./regions-service')).handleRegionOverlay(projectRoot, params, caller);
    // The WRITE side of the same partition: a walkthrough's directory/glob
    // items resolved against the task's diff range before it is stored.
    // Dynamic for the same reason as `regions` — it imports getOrCreateStorage
    // from here.
    case 'expandPresentation':
      return (await import('./presentation-expand')).handleExpandPresentation(projectRoot, params);
    case 'wait': return handleWait(projectRoot, params);
    case 'startTask': return handleStartTask(projectRoot, params, progress);
    case 'editTask': return handleEditTask(projectRoot, params);
    case 'unblockTask': return handleUnblockTask(projectRoot, params, progress);
    case 'askTask': return handleAskTask(projectRoot, params, progress);
    case 'reviewTask': return handleReviewTask(projectRoot, params, progress);
    case 'awaitClaimedTurn': return handleAwaitClaimedTurn(projectRoot, params, progress);
    case 'acceptTaskPreflight': return handleAcceptTaskPreflight(projectRoot, params);
    case 'acceptTask': return handleAcceptTask(projectRoot, params, progress);
    case 'watchProxyActivity': return handleWatchProxyActivity(await resolveActivityFilterParams(params), progress);
    case 'rejectTask': return handleRejectTask(projectRoot, params, progress);
    case 'closeTask': return handleCloseTask(projectRoot, params, progress);
    case 'stopTask': return handleStopTask(projectRoot, params, progress);
    case 'reopenTask': return handleReopenTask(projectRoot, params);
    case 'editComment': return handleEditComment(projectRoot, params);
    case 'ensureTaskContainer': return handleEnsureTaskContainer(projectRoot, params);
    case 'servePorts': return handleServePorts(projectRoot, params);
    case 'serve.getStartServicesCmd': return handleGetStartServicesCmd(projectRoot);
    case 'serve.setStartServicesCmd': return handleSetStartServicesCmd(params);
    case 'serve.clearStartServicesCmd': return handleClearStartServicesCmd();
    case 'taskProgress': return handleTaskProgress(projectRoot, params);
    case 'taskStats': return handleTaskStats(projectRoot, params);
    case 'submitTask': return handleSubmitTask(projectRoot, params);
    case 'submitTaskPreflight': return handleSubmitTaskPreflight(projectRoot, params);
    case 'getTaskUpstreamStatus': return handleGetTaskUpstreamStatus(projectRoot, params);
    case 'createTask': return handleCreateTask(projectRoot, params);
    case 'cloneTask': return handleCloneTask(projectRoot, params);
    case 'redoTask': return handleRedoTask(projectRoot, params);
    case 'listReparentTargets': return handleListReparentTargets(projectRoot, params);
    case 'taskEnv': return handleTaskEnv(projectRoot, params);
    case 'resumeTask': return handleResumeTask(projectRoot, params, progress);
    case 'syncTask': return handleSyncTask(projectRoot, params, progress);
    case 'syncTaskFromRemote': return handleSyncTaskFromRemote(projectRoot, params);
    case 'reparentTask': return handleReparentTask(projectRoot, params, progress);
    case 'linkTask': return handleLinkTask(projectRoot, params, progress);
    case 'describeLinkedTask': return handleDescribeLinkedTask(projectRoot, params, progress);
    case 'concurrency': return handleConcurrency(projectRoot, params);
    case 'usagePause': return handleUsagePause(projectRoot, params, caller);
    case 'getProjectSettings': return handleGetProjectSettings(projectRoot);
    case 'setProjectSettings': return handleSetProjectSettings(projectRoot, params);
    case 'builderSlot': return handleBuilderSlot(projectRoot, params);
    case 'getDaemonMcpConfig': return handleGetDaemonMcpConfig(projectRoot, params);
    case 'revokeDaemonMcpToken': return handleRevokeDaemonMcpToken(projectRoot, params);
    case 'startBuilderSession':
      return (await import('./builder-sessions')).handleStartBuilderSession(projectRoot, params);
    case 'stopBuilderSession':
      return (await import('./builder-sessions')).handleStopBuilderSession(projectRoot, params);
    case 'endBuilderSession':
      return (await import('./builder-sessions')).handleEndBuilderSession(projectRoot, params);
    case 'attachSession':
      return (await import('./session-attach')).handleAttachSession(projectRoot, params);
    case 'mintDashboardTicket': return handleMintDashboardTicket(projectRoot);
    case 'mintActorToken': return handleMintActorToken(projectRoot, params, caller);
    case 'revokeActorToken': return handleRevokeActorToken(projectRoot, params, caller);
    case 'putUserCredential': return handlePutUserCredential(projectRoot, params, caller);
    case 'revokeUserCredential': return handleRevokeUserCredential(projectRoot, params, caller);
    case 'listUserCredentials': return handleListUserCredentials(projectRoot, caller);
    case 'checkUserCredential': return handleCheckUserCredential(projectRoot, params, caller);
    // Read-only, and answerable precisely when the answer is "nobody": this is
    // what every CLI command asks BEFORE opening an editor, so that a refusal
    // can never discard feedback a human already typed.
    case 'identity': return handleIdentity(projectRoot);
    case 'usageLimits': return handleUsageLimits(projectRoot, caller);
    case 'getAuthEnv': return handleGetAuthEnv(projectRoot, params);
    case 'getCredentialState': return handleGetCredentialState(projectRoot, params);
    // The review surface. In-process this port is injected straight into the
    // daemon's own web handler; these commands are the same port over the wire,
    // for a client that is not the daemon (a from-source web UI, a remote one).
    case 'reviewQueue': return handleReviewQueue(projectRoot);
    case 'navCounts': return handleNavCounts(projectRoot, params);
    case 'reviewDiff': return handleReviewDiff(projectRoot, params);
    case 'reviewRegions': return handleReviewRegions(projectRoot, params);
    case 'reviewLineAttribution': return handleReviewLineAttribution(projectRoot, params);
    case 'reviewFileLines': return handleReviewFileLines(projectRoot, params);
    case 'reviewPresentations': return handleReviewPresentations(projectRoot, params);
    case 'reviewProseAnchors': return handleReviewProseAnchors(params);
    case 'reviewComments': return handleReviewComments(projectRoot, params);
    case 'reviewPostComment': return handleReviewPostComment(projectRoot, params);
    case 'reviewAsk': return handleReviewAsk(projectRoot, params);
    case 'reviewRetryAsk': return handleReviewRetryAsk(projectRoot, params);
    case 'reviewPromoteDiscussion': return handleReviewPromoteDiscussion(projectRoot, params);
    case 'conversationPromote': return handleConversationPromote(projectRoot, params);
    case 'reviewWithdrawComment': return handleReviewWithdrawComment(projectRoot, params);
    case 'reviewUnblock': return handleReviewUnblock(projectRoot, params, progress);
    case 'reviewAccept': return handleReviewAccept(projectRoot, params, progress);
    case 'reviewSync': return handleReviewSync(projectRoot, params, progress);
    case 'reviewViolationDecision': return handleReviewViolationDecision(projectRoot, params);
    case 'reviewResolveRaised': return handleReviewResolveRaised(projectRoot, params);
    case 'reviewUnresolveRaised': return handleReviewUnresolveRaised(projectRoot, params);
    case 'reviewFlagRaised': return handleReviewFlagRaised(projectRoot, params);
    case 'reviewPromoteRaised': return handleReviewPromoteRaised(projectRoot, params);
    // Drafts are keyed on the CALLER's identity, never on a request field —
    // see reviewerKey in src/review-draft.ts.
    case 'reviewGetDraft': return handleReviewGetDraft(projectRoot, params, caller);
    case 'reviewSaveDraft': return handleReviewSaveDraft(projectRoot, params, caller);
    case 'reviewVerify': return handleReviewVerify(projectRoot, params, caller);
    case 'runOneshot': return handleRunOneshot(projectRoot, params);
    case 'saveMemoryRecord': return handleSaveMemoryRecord(projectRoot, params);
    case 'deleteMemoryRecord': return handleDeleteMemoryRecord(projectRoot, params);
    case 'compactMemory': return handleCompactMemory(projectRoot, params, progress);
    case 'clearMemoryCompact': return handleClearMemoryCompact(projectRoot, params);
    case 'memoryStatus': return handleMemoryStatus(projectRoot);
    case 'doctor.run': return handleDoctorRun(projectRoot, params);
    case 'doctor.report': return handleDoctorReport(projectRoot);
    case 'daemonHealth': return handleDaemonHealth(projectRoot, params, progress);
    case 'doctor.previewRemedy': return handleDoctorPreviewRemedy(projectRoot, params);
    case 'doctor.applyRemedy': return handleDoctorApplyRemedy(projectRoot, params, progress);
    case 'storage': return handleStorageCall(projectRoot, params, caller);
    default: throw new RpcError(404, `Unknown RPC command: ${command}`);
  }
}

/**
 * Expand `taskId` into every attribution form that task answers to.
 *
 * WHY THIS EXISTS: proxy events are attributed from the agent's credential
 * grant, which carries the task REF it was launched with — the task's code, or
 * its short id when it has none. A caller (`lazy watch`) holds the full task id.
 * Matching one against the other found nothing, so watch printed its header and
 * then sat silent for a whole turn while the agent was demonstrably making
 * calls. Resolution belongs here rather than in the handler because storage
 * lives on this side; proxy-watch.ts importing it back would be a cycle.
 *
 * An unresolvable id is passed through untouched — an operator watching a
 * partial id, or a task the store no longer has, still gets prefix matching
 * rather than an error, because this is an observability surface.
 */
async function resolveActivityFilterParams(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = params.taskId;
  if (typeof raw !== 'string' || !raw) return params;

  // Start from whatever the caller already asked for. Replacing their list with
  // ours would NARROW the subscription behind their back — a client that passed
  // both `taskIds` and a `taskId` means the union, and dropping half of it is
  // the same "watch shows nothing" failure this resolution exists to prevent.
  // A malformed `taskIds` is left untouched so the handler's own validator is
  // the one that reports it — sanitizing it here would turn a 400 into a
  // silently different filter.
  if (params.taskIds !== undefined && params.taskIds !== null) {
    if (!Array.isArray(params.taskIds) || params.taskIds.some((v) => typeof v !== 'string')) {
      return params;
    }
  }
  const existing = (Array.isArray(params.taskIds) ? params.taskIds : []) as string[];
  const forms = new Set<string>([raw, ...existing.filter((f) => f.trim().length > 0)]);
  try {
    const storage = await getOrCreateStorage();
    const { task } = await storage.resolveTask(raw);
    if (task) {
      forms.add(task.id);
      forms.add(shortId(task.id));
      forms.add(taskRef(task));
      if (task.code) forms.add(task.code);
    }
  } catch (err) {
    // Resolution is an enrichment, not a precondition: the raw form is still a
    // usable filter, and failing a watch because the store hiccuped would trade
    // a degraded view for no view at all.
    logger.debug(
      `[proxy] could not resolve task '${raw}' for activity filter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { taskId: _dropped, ...rest } = params;
  return { ...rest, taskIds: [...forms] };
}

// --- List ---

/**
 * Restrict `tasks` to the subtree rooted at the task `taskFilter` resolves to
 * (the task itself plus every descendant). The subtree is computed against ALL
 * tasks so a terminal task in the middle of the hierarchy can't hide its still
 * non-terminal descendants from a filtered view.
 *
 * Throws a 404 when nothing matches, and a 400 listing the candidates when the
 * input is ambiguous — the caller sees the same actionable guidance the CLI
 * gives for any other task reference.
 *
 * Exported because the MCP `lazy_list` / `lazy_active` handlers filter by
 * subtree too. They shape their own response, but the SCOPE of a `task_id`
 * filter must be one definition: `lazy_list` used to return direct children
 * only while `lazy list <id>` returned the whole subtree, so an agent that
 * generalised from `lazy_active` (subtree on both surfaces) silently reviewed
 * a truncated tree.
 */
export async function filterToSubtree(storage: Storage, tasks: Task[], taskFilter: string): Promise<Task[]> {
  const result = await storage.resolveTask(taskFilter);
  if (!result.task) {
    if (result.ambiguousMatches && result.ambiguousMatches.length > 0) {
      const options = result.ambiguousMatches
        .map(t => `  ${shortId(t.id)}  ${t.status.padEnd(12)}  ${t.goal}`)
        .join('\n');
      throw new RpcError(400, `Multiple tasks match '${taskFilter}'. Use the ID to disambiguate:\n${options}`);
    }
    throw new RpcError(404, `Task not found: ${taskFilter}`);
  }

  const allowedIds = collectSubtreeIds(result.task.id, await storage.listTasks());
  return tasks.filter(t => allowedIds.has(t.id));
}

/**
 * Read and validate the optional `levels` depth limit shared by the list /
 * blocked / active handlers. Absent means "no limit"; a non-positive or
 * non-integer value is a caller error, not something to silently clamp.
 */
function optionalLevels(params: Record<string, unknown>): number | undefined {
  const raw = params.levels;
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new RpcError(400, `'levels' must be a positive integer (1 = top level only), got '${String(raw)}'.`);
  }
  return value;
}

/**
 * Apply an optional depth limit and build the display tree. Shared by every
 * listing handler so `levels` means the same thing on all of them.
 */
async function buildTreeWithDepth(
  storage: Storage,
  tasks: Task[],
  projectRoot: string,
  levels: number | undefined,
) {
  if (levels === undefined) return buildTaskTree(storage, tasks, projectRoot);
  const { kept, hidden } = pruneTasksToDepth(tasks, levels);
  return buildTaskTree(storage, kept, projectRoot, { hiddenDescendants: hidden });
}

export async function handleList(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const all = params.all === true;
  const levels = optionalLevels(params);
  let tasks = all
    ? await storage.listTasks()
    : await storage.listTasksWithOptions({ nonTerminalOnly: true });

  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
  }

  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
  return { tree };
}

// --- Blocked ---

export async function handleBlocked(projectRoot: string, params: Record<string, unknown> = {}) {
  const storage = await getOrCreateStorage();
  const levels = optionalLevels(params);
  const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
  return { tree };
}

// --- Active ---

export async function handleActive(projectRoot: string, params: Record<string, unknown> = {}) {
  const storage = await getOrCreateStorage();
  const levels = optionalLevels(params);
  let tasks = await collectActiveTasks(storage);

  // Optional subtree filter: show only the given task and its descendants.
  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
  }

  // Depth limit applies AFTER the subtree filter, so `active <task> --levels 1`
  // means "that task, no descendants" rather than one of the two silently
  // winning.
  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
  return { tree };
}

// --- Concurrency limits (get / set / reset ephemeral overrides) ---

/**
 * A discoverer of live builder container names for this project, for
 * {@link countActiveBuilders}.
 *
 * Swallows its own failure to an empty list rather than throwing: a container
 * engine we cannot reach means we cannot see running builders, and refusing to
 * answer would either break `daemon config get` or block a human's builder on a
 * Docker hiccup. The in-flight reservations the daemon holds are still counted,
 * so admission stays race-safe even when the live set is unreadable.
 */
function builderRunDiscoverer(projectRoot: string): () => Promise<string[]> {
  return async () => {
    try {
      const runner = await createRunner(projectRoot);
      return await runner.discoverProjectBuilderRuns(projectRoot);
    } catch (err) {
      logger.debug(`Concurrency: could not count builder containers: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  };
}

/**
 * Builder admission — the authoritative `max_concurrent_builders` gate.
 *
 * `action`:
 *   - 'admit' (default): atomically count live builders and decide whether
 *     `builderId` may launch, reserving its slot when admitted.
 *   - 'release': drop the reservation (launch failed, or the session ended).
 *
 * WHY THIS EXISTS HERE and not only in the CLI: the cap used to be a comparison
 * in `lazy builder`, so it bound exactly one launcher and raced with itself when
 * two builders started at once. The daemon owns the count and the verdict; a
 * client asks. See the module header of src/daemon/concurrency.ts for what this
 * can and cannot guarantee given that builder containers are spawned client-side.
 */
export async function handleBuilderSlot(projectRoot: string, params: Record<string, unknown>) {
  const action = optionalEnum(params, 'action', ['admit', 'release'] as const) ?? 'admit';
  const builderId = optionalString(params, 'builderId');
  if (!builderId) {
    throw new RpcError(400, 'builderId is required');
  }

  if (action === 'release') {
    releaseBuilderSlot(builderId);
    return { released: true };
  }

  const config = await loadConfig(projectRoot);
  const limit = effectiveBuilderLimit(config);
  const decision = await tryAdmitBuilderSlot(builderRunDiscoverer(projectRoot), builderId, limit);
  return {
    admitted: decision.admitted,
    // On a denial this is the count that filled the cap; on an admission it
    // includes the builder just admitted (same convention as SlotDecision).
    running: decision.running,
    limit,
  };
}

/**
 * Report and (optionally) mutate the daemon's builder concurrency cap.
 *
 * `action`:
 *   - 'get' (default): report the cap — configured value, ephemeral override,
 *     effective limit, and current running count.
 *   - 'set':   set an ephemeral override for `params.key` to `params.value`.
 *   - 'reset': clear the ephemeral override for `params.key`.
 *
 * Agent tasks are uncapped (remove-reaper-cap-sweep) — only the builder cap
 * remains. Overrides live only in this daemon process (lost on restart) — this
 * handler NEVER writes lazy.toml. See src/daemon/concurrency.ts.
 */
/**
 * Model ids are free-form in lazy (`[models] default` is any string — an alias
 * like "opus", a full id like "claude-opus-4-8", or an ollama tag), so there is
 * no allowlist to check against and inventing one here would reject models
 * lazy.toml itself accepts. Validate the SHAPE instead, and loudly: this is an
 * external surface and must confirm its own inputs rather than assume some
 * other surface already did.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MODEL_ID_MAX_LENGTH = 200;

/**
 * Read the project's settings overlay composed with lazy.toml — what is in
 * force, what the repository says, and which won for each key.
 *
 * See docs/design/lazy-teams.md §11. Like `concurrency` above, this NEVER reads
 * or writes lazy.toml as a mutable store: the file is an input, the overlay is
 * the only thing this handler can change.
 */
export async function handleGetProjectSettings(projectRoot: string) {
  const [storage, config] = await Promise.all([
    getOrCreateStorage(),
    loadConfig(projectRoot),
  ]);
  const settings = await storage.getProjectSettings();
  return effectiveProjectSettings(settings, config);
}

/**
 * Replace the project's settings overlay, then report the new effective state.
 *
 * Whole-record replace: a key absent from `params` clears that override back to
 * the repository default. That is what makes "reset to the repository default"
 * expressible at all — a patch API cannot say it.
 */
export async function handleSetProjectSettings(projectRoot: string, params: Record<string, unknown>) {
  const defaultModel = optionalString(params, 'defaultModel');
  const defaultAgent = optionalString(params, 'defaultAgent');

  const next: ProjectSettings = {};
  // An absent key and an explicitly empty string both mean "no override".
  // Normalizing them to the same thing here is why the read path can treat a
  // missing key as authoritative.
  if (defaultModel !== undefined && defaultModel.trim() !== '') {
    const model = defaultModel.trim();
    if (model.length > MODEL_ID_MAX_LENGTH) {
      throw new RpcError(400, `defaultModel is too long (${model.length} chars, max ${MODEL_ID_MAX_LENGTH}).`);
    }
    if (!MODEL_ID_PATTERN.test(model)) {
      throw new RpcError(
        400,
        `Invalid defaultModel '${model}'. A model id may contain letters, digits, and . _ : / - ` +
        `and must start with a letter or digit (e.g. "opus", "claude-opus-4-8", "qwen3.5:35b").`,
      );
    }
    next.defaultModel = model;
  }
  if (defaultAgent !== undefined && defaultAgent.trim() !== '') {
    const agent = defaultAgent.trim();
    await assertKnownAgentProfile(projectRoot, agent, 'defaultAgent');
    next.defaultAgent = agent;
  }
  next.updatedAt = new Date().toISOString();
  const actor = optionalString(params, 'actor');
  if (actor) next.updatedBy = actor;

  const [storage, config] = await Promise.all([
    getOrCreateStorage(),
    loadConfig(projectRoot),
  ]);
  // The Start services command shares this record but is not a settings-form
  // key — a form save must not wipe it (it is designated from the Services card).
  // Serialized with that designation so neither write can drop the other.
  await updateProjectSettings(storage, (previous) => {
    if (previous?.startServicesCmd) next.startServicesCmd = previous.startServicesCmd;
    if (previous?.startServicesCmdCleared) next.startServicesCmdCleared = true;
    return next;
  });
  return effectiveProjectSettings(next, config);
}

export async function handleConcurrency(projectRoot: string, params: Record<string, unknown>) {
  const action = optionalEnum(params, 'action', ['get', 'set', 'reset'] as const) ?? 'get';

  if (action === 'set' || action === 'reset') {
    const key = optionalString(params, 'key') as LimitKey;
    if (!LIMIT_KEYS.includes(key)) {
      throw new RpcError(400, `Unknown limit key '${String(params.key)}'. Valid keys: ${LIMIT_KEYS.join(', ')}.`);
    }
    if (action === 'reset') {
      setLimitOverride(key, undefined);
    } else {
      const value = Number(params.value);
      if (!Number.isInteger(value) || value < 1) {
        throw new RpcError(400, `Value must be a positive integer, got '${String(params.value)}'.`);
      }
      setLimitOverride(key, value);
    }
  }

  const config = await loadConfig(projectRoot);

  // Builder containers launch client-side and have no storage entity — count the
  // live ones via the runner, plus any launch the daemon has admitted but whose
  // container is not up yet (see countActiveBuilders). If the runner is
  // unavailable (e.g. Docker down) the container half is unknown; report what we
  // do know so `config get` still works rather than failing the whole call (the
  // caller is asking about limits, not launching).
  const builderRunning = await countActiveBuilders(builderRunDiscoverer(projectRoot));

  return {
    builders: {
      configured: config.limits.max_concurrent_builders,
      override: getLimitOverride('max_concurrent_builders') ?? null,
      limit: effectiveBuilderLimit(config),
      running: builderRunning,
    },
  };
}

// --- Show ---

/**
 * Where one task's pieces live on disk, for an operator troubleshooting it from
 * a client that is not a shell on this host.
 *
 * Every other fact a diagnostics surface needs is already on the wire — the
 * session carries `container_name`, `runner_type`, `git_branch` and
 * `interrupt_reason` — but these paths are not, and a client cannot derive
 * them: the worktree path depends on the project's data dir AND on the task's
 * ref (`metadata.task_ref`, which falls back to the short id), and the store
 * root is wherever `[storage] external_path` points, which only the daemon has
 * read. Guessing either is how a diagnostics page tells an operator to look in
 * a directory that does not exist.
 *
 * LOCATIONS, NEVER CONTENTS. Nothing here opens a file, and nothing here is a
 * secret — same boundary lazy-teams states on its own project diagnostics.
 *
 * Path accessors go through the Storage interface (`getStoragePath` /
 * `getTaskDir`), so a Postgres or remote backend answers for itself rather than
 * this handler assuming a filesystem layout.
 */
async function taskLocations(storage: Storage, task: Task, projectRoot: string) {
  const worktree = getWorktreePath(projectRoot, task);
  return {
    projectRoot,
    worktree,
    // A worktree is removed when a task ends, so its absence is normal for a
    // finished task and a real finding for a working one. Stating it costs one
    // stat and saves the reader a guess.
    worktreeExists: await pathExists(worktree),
    storeRoot: storage.getStoragePath(),
    taskDir: storage.getTaskDir(task.id),
  };
}

/**
 * The protected files a client must show: everything still outstanding over the
 * whole branch, plus everything already approved (so the summary can mark them
 * decided). Degrades to the recorded set rather than to "nothing owed" —
 * see src/protection/outstanding.ts.
 */
async function outstandingFileViolations(
  storage: Awaited<ReturnType<typeof getOrCreateStorage>>,
  task: Task,
  projectRoot: string,
  turns: Turn[],
): Promise<FileViolation[]> {
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return [];
  const state = await resolveOutstandingViolations(projectRoot, task, session, turns, storage);
  const records = violationRecordsByFile(turns);
  return [
    ...state.outstanding,
    ...state.approved.map((file) => ({
      file,
      base_sha: records.get(file)?.base_sha ?? '',
      status: 'approved' as const,
    })),
  ];
}

/**
 * One task's record, plus the answers a client would otherwise re-derive.
 *
 * `sections` (and `offset` / `limit`) are honoured here, and this is what they
 * mean: OMITTING `sections` serves every section whole — what `lazy show` and
 * every caller written before this relied on. Naming sections narrows the
 * payload to those, paged by `offset`/`limit` within each (from the start, so a
 * search hit's `index` is a usable offset). An unknown name is a 400, never a
 * silent drop. The summary — task, session, raised items, protection, serve
 * state, file violations, `counts`, `sectionsServed` — is always served,
 * whatever `sections` says.
 *
 * Three of the fields are DERIVED rather than stored, and are here because the
 * rules behind them live in exactly one function each and a second copy in
 * another language cannot be reviewed: `notes` (the resolved delivery cutoff)
 * and the `delivered` flag on every comment, `chunks`, and `reviews`. See
 * src/task/show-sections.ts.
 */
export async function handleShow(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const storage = await getOrCreateStorage();
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      // Return ambiguous matches so CLI can handle disambiguation.
      // last_interaction_at is part of the payload because it is what actually
      // tells the two apart for a human ("the one I was working on this
      // morning") — the same field resolveTaskOrExit shows for every other
      // command. Falls back to created_at for a task that was never started.
      const matches = [];
      for (const t of result.ambiguousMatches) {
        const session = await storage.getSessionByTaskId(t.id);
        matches.push({
          id: t.id,
          code: t.code,
          goal: t.goal,
          status: t.status,
          lastInteractionAt: session?.last_interaction_at ?? t.created_at,
        });
      }
      return { ambiguous: true, matches };
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }

  const { sections, invalid } = parseShowSections(params.sections);
  if (invalid.length > 0) {
    throw new RpcError(
      400,
      `Unknown show section(s): ${invalid.join(', ')}. Valid sections: ${SHOW_SECTION_NAMES.join(', ')}`,
    );
  }
  const offset = typeof params.offset === 'number' && params.offset > 0 ? Math.floor(params.offset) : 0;
  const limit = typeof params.limit === 'number' && params.limit >= 0
    ? Math.floor(params.limit)
    : Number.POSITIVE_INFINITY;
  /** One page of a requested section; `[]` when the caller did not ask for it. */
  const page = <T>(section: ShowSection, items: T[]): T[] => (
    wantsSection(sections, section) ? items.slice(offset, offset + limit) : []
  );

  const data = await loadTaskShowData(storage, result.task, projectRoot);
  const config = await loadConfig(projectRoot);

  // The derived answers, resolved HERE so no client re-derives them. Each is a
  // projection of the one function that owns the rule (src/task/show-sections.ts).
  const notes = buildNotesState(data.session, data.turns, data.comments);
  const queuedCommentIds = new Set(notes.queued_ids);
  const review = reviewSettingsViewOf(result.task.metadata, config.review, {
    metadata: data.parent?.metadata,
    code: data.parent?.code,
  });
  const reviews = buildShowReviews(data.turns, review);
  const chunks = buildShowChunks(data.turns);
  const final = buildShowFinal(data.turns);
  const fileViolations = await outstandingFileViolations(storage, result.task, projectRoot, data.turns);
  const turnBudgetMax = config.limits.max_turns_without_human;
  const turnBudgetCount = await getNonHumanTurnCount(storage, result.task.id);
  const turnBudget = {
    count: turnBudgetCount,
    max: turnBudgetMax,
    exhausted: !checkTurnBudget(turnBudgetCount, turnBudgetMax).allowed,
  };

  // Serialize TaskShowData — convert Map to plain object
  return {
    task: data.task,
    session: data.session,
    turns: page('turns', data.turns),
    commits: page('commits', data.commits),
    // Every comment carries whether the agent has SEEN it, so a client never
    // compares its own timestamps against the cutoff (CLAUDE.md: "A lazy
    // comment never starts a turn" — the cutoff is the last delivery).
    comments: page('comments', data.comments).map((c) => ({
      ...c,
      delivered: !queuedCommentIds.has(c.id),
    })),
    journal: page('journal', data.journal),

    // Derived sections. `notes` is the resolved cutoff and the queue; `chunks`
    // is the review grouping every surface reviews by; `reviews` is which
    // agent reviews COUNT — the predicate behind it also gates accept, so a
    // remote client must never re-implement it.
    notes: wantsSection(sections, 'notes') ? notes : null,
    chunks: page('chunks', chunks),
    reviews: page('reviews', reviews),

    /**
     * Pencils down: whether anybody has declared this work done and whether
     * that claim still stands, resolved by `resolveFinalState` — the ANSWER,
     * never the turns for a client to re-derive it from. `null` means nobody
     * has declared it, which is itself the answer a surface renders.
     *
     * Never section-gated, same rule as `clusterProgress` (the cluster k-of-n)
     * and `raisedItems`: a
     * client that must ask for an answer by name is a client that renders the
     * page without it.
     */
    final,

    /**
     * The cap on consecutive turns without a human (limits.
     * max_turns_without_human): how many non-human turns ran since a person
     * last unblocked, resumed or started the task, and whether the NEXT one
     * would be refused — the answer `checkTurnBudget` gives the refusal
     * itself, so a surface can tell a person the task is waiting on them.
     * `max` 0 means unlimited. Never section-gated, same rule as `final`.
     */
    turnBudget,

    /**
     * What this response actually served, and how big each section is whole.
     * Without this a caller cannot tell a section that is EMPTY from one it did
     * not ask for — which is the defect that sent a Teams port re-deriving
     * these answers in Ruby in the first place.
     */
    sectionsServed: sections === null ? [...SHOW_SECTION_NAMES] : sections,
    counts: {
      turns: data.turns.length,
      chunks: chunks.length,
      commits: data.commits.length,
      comments: data.comments.length,
      journal: data.journal.length,
      children: data.children.length,
      'status-history': data.statusHistory.length,
      'tag-history': data.tagHistory.length,
      reviews: reviews.length,
    },

    /**
     * How far a `cluster` task is along, or null for every other type. Derived
     * from the FULL child list rather than the paged `children` section above,
     * because a k-of-n taken from one page of children is not a k-of-n — and
     * never section-gated, for the same reason `raisedItems` is not: a client
     * that has to ask for an answer by name is a client that renders the page
     * without it.
     *
     * Renamed from `loopProgress` with the Ruby client, not ahead of it. Unlike
     * the `clusters` RPC below, this field gets NO compatibility spelling: a
     * client that does not find it reads `null` — the same answer every
     * non-cluster task gives — and simply renders no progress line, where an
     * unknown METHOD would have taken the whole page down.
     */
    clusterProgress: (() => {
      const progress = clusterProgressOf(result.task!, data.children);
      return progress ? clusterProgressPayload(progress) : null;
    })(),

    // Explicit list (same rule as mergeState): omitting raisedItems / turnReport /
    // fileDecisions would silently drop those sections over RPC even when
    // loadTaskShowData computed them.
    raisedItems: data.raisedItems,
    turnReport: data.turnReport,
    fileDecisions: data.fileDecisions,
    // Same rule as mergeState below: this list is explicit, so an artifact
    // section that renders daemonless would silently vanish over RPC.
    artifacts: data.artifacts,
    statusHistory: page('status-history', data.statusHistory),
    tagHistory: page('tag-history', data.tagHistory),
    children: page('children', data.children),
    childSessions: Object.fromEntries(data.childSessions.entries()),
    parent: data.parent,
    retryStatus: data.retryStatus,
    orphanStatus: data.orphanStatus,
    autoReactStatus: data.autoReactStatus,
    supervisorStatus: data.supervisorStatus,
    workingSubstate: data.workingSubstate,
    // A mid-merge worktree only reaches the CLI if it is serialized here — this
    // list is explicit, so an omission silently restores the old lie that a
    // stranded task is just `blocked` (fix-sync-silent-conflict).
    mergeState: data.mergeState,
    // Same rule as mergeState: protection only reaches the CLI if it is
    // serialized here, and omitting it silently restores the old behavior
    // where a gate was invisible until accept refused.
    protection: data.protection,
    // Same rule again: the serving block only reaches the CLI if it is listed
    // here. Omitting it is invisible — `lazy show` simply stops mentioning the
    // task's ports, with nothing anywhere saying why.
    serveState: data.serveState,
    // RPC-only, deliberately: `lazy show` runs on the host and its reader can
    // already see these paths, so this is computed here rather than in
    // `loadTaskShowData` and adds nothing to the CLI's output.
    paths: await taskLocations(storage, result.task, projectRoot),
    // RPC-only, deliberately: the file-violation set a human must resolve is
    // NOT "the violations on the last agent turn", and since the decision moved
    // to accept it is not one turn's record either — a conflict task runs many
    // turns, and the newest record REPLACES the older one. It is the
    // whole-branch outstanding set (`resolveOutstandingViolations`), the same
    // answer the accept gate and the review page use, plus the files already
    // approved so a client can show them as decided. A remote client (Lazy
    // Teams) re-deriving any of that in another language would be a second copy
    // of a load-bearing invariant. Answer it here, once, in the daemon.
    fileViolations,
    /**
     * "Before you can accept": the rows the daemon's own Current review tab
     * renders, as data — built by the one function that renders them there
     * (src/review/accept-gate.ts), from the same whole-branch file set served
     * above. Row text is composed by the daemon; a client only links it.
     * Never section-gated, same rule as `final`: it is an answer, not a record.
     */
    acceptGate: buildAcceptGate({
      turns: acceptGateTurns(data.turns),
      raisedItems: data.raisedItems,
      fileViolations,
      taskMetadata: result.task.metadata,
      // Human feedback the agent has not been shown — the count accept
      // itself refuses on (src/task/queued-feedback.ts).
      queuedComments: queuedHumanFeedbackCount({
        session: data.session,
        turns: data.turns,
        comments: data.comments,
        pendingReviewComments: (await storage.getTaskReviewComments(result.task.id)).filter(isPendingDelivery).length,
      }),
    }),
    // Same rule again: the slow-lane indicator silently disappears from a
    // daemon-backed `lazy show` if this field is omitted here, even though
    // loadTaskShowData computed it correctly.
    autoResumeQueue: data.autoResumeQueue,
    // [[automation.maintain]] globs for review presentation (docs-first ordering
    // on remote clients). Instructions are supervisor-only; patterns are enough
    // for the maintained-files residual bucket.
    ...(config.automation.maintain.length > 0 && {
      maintain: config.automation.maintain.map(({ title, pattern }) => ({ title, pattern })),
    }),
    // The effective review settings, resolved here so `lazy show`, `lazy_show`
    // and the task page all render one answer rather than three resolutions.
    // Values, the line, WHERE EACH VALUE CAME FROM, the plain-words clauses and
    // the docs pointer — one composition, so no surface explains the same
    // setting differently from another.
    // The parent is passed because an UNLAUNCHED task has pinned nothing:
    // without it a backlog child of a hub that chose `separate` would be shown
    // the project default, on exactly the tasks a human reads before starting.
    review,
    // Same no-network line the Landing header and MCP lazy_show print.
    upstreamLine: await (async () => {
      try {
        return formatUpstreamStatusLine(await getTaskUpstreamStatus(projectRoot, data.task.id));
      } catch {
        return null;
      }
    })(),
  };
}

// --- Search ---

export async function handleSearch(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.query !== 'string' || !params.query) {
    throw new RpcError(400, 'query is required');
  }

  const storage = await getOrCreateStorage();

  try {
    return await executeSearch(storage, {
      query: params.query,
      fuzzy: params.fuzzy === true,
      types: Array.isArray(params.types) ? params.types.filter((t): t is string => typeof t === 'string') : undefined,
    });
  } catch (err) {
    // A refused regex and an unparseable query are both the CALLER's query, not
    // a server fault — a 400 carrying the message says so instead of a 500
    // carrying a stack.
    // The prefix is added HERE, not at the client, so a parse error reads
    // identically whether the CLI ran the search in-process (it sees the
    // QueryParseError itself) or asked a daemon for it.
    if (err instanceof QueryParseError) {
      throw new RpcError(400, `Query parse error: ${err.message}`);
    }
    if (err instanceof SearchPatternError) {
      throw new RpcError(400, err.message);
    }
    throw err;
  }
}

// --- Builder scratch (read-only web surfaces) ---
//
// Answers, not storage passthroughs: listing entries carry no bodies and a
// human reason for every file recorded by name only, so Lazy Teams renders
// exactly what the daemon dashboard does without re-deriving either.

export async function handleScratchList() {
  const storage = await getOrCreateStorage();
  return { groups: groupScratchBySession(await storage.listScratchFiles()) };
}

export async function handleScratchShow(params: Record<string, unknown>) {
  if (typeof params.path !== 'string' || !params.path) throw new RpcError(400, 'path is required');
  const storage = await getOrCreateStorage();
  const file = await storage.getScratchFile(params.path);
  if (!file) throw new RpcError(404, `No captured scratch file at '${params.path}'`);
  return { file: { ...scratchEntry(file), content: file.skipped ? null : file.content } };
}

export async function handleScratchSearch(params: Record<string, unknown>) {
  if (typeof params.query !== 'string' || !params.query.trim()) throw new RpcError(400, 'query is required');
  const storage = await getOrCreateStorage();
  return { query: params.query.trim(), hits: await searchScratch(storage, params.query.trim()) };
}

export async function handleScratchMentions(params: Record<string, unknown>) {
  if (typeof params.text !== 'string') throw new RpcError(400, 'text is required');
  const storage = await getOrCreateStorage();
  const paths = (await storage.listScratchFiles()).map((f) => f.path);
  return { paths: scratchPathsMentionedIn(params.text, paths) };
}

// --- Diff ---

/**
 * Render comments as a virtual unified diff section.
 */
function renderNotesDiff(comments: Comment[]): string {
  if (comments.length === 0) return '';

  const lines: string[] = [];
  lines.push('diff --lazy a/comments b/comments');
  lines.push('--- /dev/null');
  lines.push('+++ b/comments');

  const commentLines: string[] = [];
  for (const comment of comments) {
    commentLines.push(`[${formatDate(comment.created_at)}]`);
    const contentLines = comment.content.split('\n');
    commentLines.push(...contentLines);
    commentLines.push('');
  }

  lines.push(`@@ -0,0 +1,${commentLines.length} @@`);
  for (const line of commentLines) {
    lines.push(`+${line}`);
  }

  return lines.join('\n');
}

/**
 * Diff a task's branch against its integration base.
 *
 * This is the ONE implementation behind both `lazy diff` and the `lazy_diff`
 * MCP tool. MCP used to compute its own base ref, hardcoding the literal
 * 'main' for top-level tasks and for tasks whose parent session was missing —
 * so on a repo whose default branch is not `main`, or for a task targeting a
 * release branch, an agent reviewed the wrong diff and reported it
 * confidently. Do not reintroduce a second base-ref computation; add
 * parameters here instead.
 *
 * Params:
 *   taskId  — required task reference (short id or code)
 *   full    — full patch instead of a --stat summary
 *   files   — pathspecs to restrict the diff to
 *   surface — which "how to get the full diff" hint to render ('cli' default,
 *             or 'mcp' so an agent is told the tool call rather than a shell
 *             command it may not be able to run)
 *   includeComments — append the synthetic `diff --lazy a/comments b/comments`
 *             section for comments not yet delivered to the agent. Default
 *             TRUE: it is documented behaviour of `lazy diff` and `lazy_diff`.
 *             Surfaces that PARSE the output as a real patch (the web review
 *             page) must pass false — that section is not a git patch, and
 *             feeding it to a diff parser produced a phantom "comments" file
 *             that consumed the last real file's name and hunks.
 */

export async function handleDiff(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  const files = Array.isArray(params.files)
    ? params.files.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : undefined;
  const surface = params.surface === 'mcp' ? 'mcp' : 'cli';
  const includeComments = params.includeComments !== false;
  const regionRef = typeof params.region === 'string' && params.region.trim()
    ? params.region.trim()
    : null;

  const diffStorage = await getOrCreateStorage();
  // A region filter is inherently about the WHOLE branch: on a release hub the
  // default diff excludes accepted children's files, and every child-task
  // region is made of exactly those. Intersecting the two would hand back an
  // empty diff for a region that plainly has files.
  const { storage, task, sess, worktreePath, fromRef, useTwoDotDiff, direct } =
    await resolveTaskDiffContext(diffStorage, projectRoot, params.taskId, {
      fullBranch: params.fullBranch === true || regionRef !== null,
    });

  // Scoping is by the region's FILES against the task's own base..HEAD range,
  // not by re-diffing the region's commit range. Two reasons: review comments
  // anchor to line numbers in the task diff, so a different range would strand
  // them; and a reviewer of the task wants the cumulative state of those files,
  // including any later commit that touched them again.
  let regionFiles: string[] | undefined;
  if (regionRef) {
    // §6.3: the region a diff is scoped to is the PRESENTED one — the
    // walkthrough the task declared, whose `files` are its own membership
    // claim (or, on a hub, the region one landed child owns). An agent scoping by a carve id from the provenance
    // hint gets the same clear "no region by that name" a human would: the
    // hint names groups so the present step can narrate, and a diff scoped
    // to a grouping the agent then invented would not be reviewable by
    // anyone but it.
    const { loadPresentedRegions } = await import('./regions-presentation');
    const { requireRegion } = await import('./regions-service');
    const { cover } = await loadPresentedRegions(diffStorage, projectRoot, params.taskId);
    regionFiles = requireRegion(cover, regionRef).files;
  }

  const full = params.full === true;
  const pathFilter = intersectPaths(files, regionFiles);
  // A region whose files the caller's own `files` filter excluded entirely is
  // an EMPTY diff. `restrictDiffPaths` reads `[]` as "no filter", so the empty
  // case is decided here rather than handed to it as an ambiguous value.
  const restrict = regionFiles && pathFilter && pathFilter.length === 0
    ? { paths: [] as string[], empty: true }
    : restrictDiffPaths(direct, pathFilter);

  // Notes not yet delivered to the agent — same cutoff the next unblock uses.
  let newNotes: Comment[] = [];
  if (includeComments) {
    const turns = await storage.getSessionTurns(sess.id);
    const noteCutoff = resolveNotesCutoff(sess, turns);

    const allNotes = await storage.getTaskComments(task.id);
    newNotes = noteCutoff === null ? allNotes : getNewNotesSince(allNotes, noteCutoff);
  }
  const notesDiffSection = renderNotesDiff(newNotes);

  const diffRange = useTwoDotDiff ? `${fromRef}..HEAD` : `${fromRef}...HEAD`;

  let output = '';
  if (restrict.empty) {
    output = (!includeComments || newNotes.length === 0)
      ? 'No changes.'
      : (full
        ? notesDiffSection
        : ` comments | ${newNotes.length} comment(s) added`);
  } else if (full) {
    const diff = await getDiffFull(fromRef, 'HEAD', worktreePath, useTwoDotDiff, restrict.paths);
    if (!diff && !notesDiffSection) {
      output = 'No changes.';
    } else {
      const parts: string[] = [];
      if (diff) parts.push(diff);
      if (notesDiffSection) parts.push(notesDiffSection);
      output = parts.join('\n\n');
    }
  } else {
    const stat = await getDiffStat(fromRef, 'HEAD', worktreePath, useTwoDotDiff, restrict.paths);
    if (!stat && newNotes.length === 0) {
      output = 'No changes.';
    } else {
      const parts: string[] = [];
      if (stat) parts.push(stat);
      if (newNotes.length > 0) {
        parts.push(` comments | ${newNotes.length} comment(s) added`);
      }
      // The hint names a call the CALLER can actually make: a shell command for
      // the CLI, the tool call for an MCP client.
      parts.push(surface === 'mcp'
        ? `\nFor full diff: lazy_diff(task_id: "${displayId(task)}", full: true)`
        : `\nFor full diff: lazy diff ${displayId(task)} --full`);
      if (direct.scopedToDirect) {
        const n = direct.acceptedChildren.length;
        parts.push(surface === 'mcp'
          ? `Direct changes only (${n} accepted subtask${n === 1 ? '' : 's'} excluded). For the whole branch: lazy_diff(task_id: "${displayId(task)}", full_branch: true)`
          : `Direct changes only (${n} accepted subtask${n === 1 ? '' : 's'} excluded). For the whole branch: lazy diff ${displayId(task)} --full-branch`);
      }
      output = parts.join('\n');
    }
  }

  return {
    output,
    diffRange,
    taskId: shortId(task.id),
    scopedToDirect: direct.scopedToDirect,
    acceptedSubtaskCount: direct.acceptedChildren.length,
  };
}

/**
 * Combine the caller's `files` filter with a region's file list.
 *
 * Either may be absent. When both are present the answer is the intersection,
 * and an empty intersection stays an EMPTY ARRAY rather than `undefined` —
 * `undefined` would mean "no filter" and silently widen the diff to the whole
 * branch, which is the opposite of what the caller asked for.
 */
function intersectPaths(
  files: string[] | undefined,
  regionFiles: string[] | undefined,
): string[] | undefined {
  if (!regionFiles) return files;
  if (!files || files.length === 0) return regionFiles;
  const allow = new Set(regionFiles);
  return files.filter((f) => allow.has(f));
}

/**
 * Intersect a caller-supplied path filter with the hub's direct-changes
 * restriction. An empty intersection is an empty diff, never "the whole tree".
 */
function restrictDiffPaths(
  plan: TaskDirectDiffPlan,
  files?: string[],
): { paths: string[] | undefined; empty: boolean } {
  const scoped = gitDiffPaths(plan);
  if (!files || files.length === 0) return scoped;
  if (scoped.empty) return { paths: [], empty: true };
  if (!scoped.paths) return { paths: files, empty: false };
  const allow = new Set(scoped.paths);
  const hit = files.filter((f) => allow.has(f));
  return { paths: hit, empty: hit.length === 0 };
}

/**
 * A range of UNCHANGED lines from one file of a task's diff — the data behind
 * the review page's expand-context controls.
 *
 * The browser must not read git: it asks for (file, side, start, end) and gets
 * text back, resolved through the same worktree and refs the diff itself was
 * rendered from (resolveTaskDiffContext). Two refusals matter and both are
 * loud: a path that is not part of this diff is a 404 (the review page is a
 * view of one change, not a file browser), and a range is bounded at the
 * boundary rather than trusted (src/review/file-lines.ts).
 *
 * The `new` side is read from the WORKTREE, not from HEAD, because the diff the
 * reviewer is looking at includes uncommitted changes (getDiffFull appends
 * them) — reading HEAD would hand back context that does not match the hunks
 * around it. HEAD is the fallback for a file that is not on disk.
 *
 * Params:
 *   taskId — required task reference (short id or code)
 *   path   — file path, as it appears in the diff (post-image for `new`)
 *   side   — 'new' (default) or 'old'
 *   start / end — 1-based inclusive line numbers; end is clamped
 */
export async function handleFileLines(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  const { task, worktreePath, fromRef, useTwoDotDiff, direct } =
    await resolveTaskDiffContext(await getOrCreateStorage(), projectRoot, params.taskId);

  const restrict = gitDiffPaths(direct);
  const pathSets = restrict.empty
    ? { newPaths: [] as string[], oldPaths: [] as string[] }
    : await getDiffPathSets(fromRef, 'HEAD', worktreePath, useTwoDotDiff, restrict.paths);
  const side = params.side === 'old' ? 'old' : 'new';
  const validation = validateFileLinesRequest({
    path: params.path,
    side: params.side,
    start: params.start,
    end: params.end,
    allowedPaths: side === 'old' ? pathSets.oldPaths : pathSets.newPaths,
  });
  if (!validation.ok) {
    throw new RpcError(validation.status, validation.error);
  }
  const request = validation.request;

  let content: string | null = null;
  if (request.side === 'new') {
    let read;
    try {
      read = await readWorktreeFileNoFollow(worktreePath, request.path);
    } catch (err) {
      // A real read failure — must not be reported as "no such file".
      throw new RpcError(500,
        `Failed to read ${request.path}: ${err instanceof Error ? err.message : err}`);
    }
    if (read.kind === 'outside') {
      throw new RpcError(400, `Refusing to read path outside the worktree: ${request.path}`);
    }
    // 'missing' is ordinary (a committed file the reviewer has since deleted, a
    // file only in the index). 'notRegular' means a symlink or a directory: we
    // never follow it, and read the BLOB instead — a symlink blob is just its
    // target string, which is exactly what git renders in the hunks, so the
    // expanded context agrees with the change it surrounds.
    content = read.kind === 'content'
      ? read.content
      : await getFileAtCommit('HEAD', request.path, worktreePath);
  } else {
    // The pre-image of a three-dot diff is the merge base, not the base ref
    // itself — the same range the hunks were computed against.
    const oldRef = useTwoDotDiff ? fromRef : await getMergeBase(fromRef, 'HEAD', worktreePath);
    content = await getFileAtCommit(oldRef, request.path, worktreePath);
  }
  if (content === null) {
    throw new RpcError(404, `File not found on the ${request.side} side: ${request.path}`);
  }

  const slice = sliceFileLines(content, request.start, request.end);
  return {
    taskId: shortId(task.id),
    path: request.path,
    side: request.side,
    start: slice.start,
    end: slice.end,
    lines: slice.lines,
    totalLines: slice.totalLines,
    atEof: slice.atEof,
  };
}

// --- Wait ---

/**
 * Long-poll until the FIRST of one or more tasks finishes its turn — its turn
 * count increases with an agent turn, or its status changes from 'working'.
 *
 * This eliminates client-side polling — the daemon holds ONE connection and
 * races every task internally. The polling core lives in ./wait-race.ts.
 */
export async function handleWait(projectRoot: string, params: Record<string, unknown>) {
  const inputs = normalizeWaitInputs(params);
  const storage = await getOrCreateStorage();
  const result = await raceWait(storage, inputs, {
    timeoutSecs: optionalNumber(params, 'timeout'),
  });

  // Report a half-merged worktree on the winner. Computed here rather than in
  // raceWait because only the daemon knows the project root — and every wait
  // client (CLI, MCP, rpc-fallback) goes through this one handler, so they all
  // tell the same truth (fix-sync-silent-conflict).
  //
  // Also resolve head_sha here: for a complete task it is the accept-tag commit
  // (same SHA the parent `[Subtask accepted]` comment carries); otherwise the
  // task branch tip. Observational — never fails the wait.
  if (!result.timed_out) {
    try {
      const task = await storage.getTask(result.task_id);
      if (task) {
        const worktreePath = getWorktreePath(projectRoot, task);
        if (await pathExists(worktreePath)) {
          const state = await readWorktreeMergeState(worktreePath);
          if (isMidMerge(state)) {
            result.merge_state = {
              merge_in_progress: state.mergeInProgress,
              unmerged_files: state.unmergedFiles,
              summary:
                `Worktree has an unresolved merge (${describeMergeState(state)}). A sync did not ` +
                `finish — run \`lazy sync ${result.display_id}\` to complete it.`,
            };
          }
        }
        const session = await storage.getSessionByTaskId(task.id);
        const tip = await resolveTaskTipSha(
          task.id,
          task.status,
          session?.git_branch ?? null,
          projectRoot,
        );
        if (tip) {
          result.head_sha = tip;
        }
      }
    } catch (err) {
      // Observational only — never fail a wait because a worktree was unreadable.
      logger.debug(`wait: could not read merge state / head_sha for ${result.display_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

// --- Start Task ---

/**
 * The taxonomy value recorded for a `user`-kind caller. A per-user token is
 * held by a human's own client (CLI/MCP login), so every write it makes is a
 * human write — which is also what the same person's writes look like through
 * the control plane, so attribution does not change shape with the route taken.
 */
const USER_ACTOR: Actor = 'human';

/**
 * The request field carrying the daemon-imposed reviewer key. Named once so the
 * gate that writes it and the handlers that read it cannot drift, and prefixed
 * like the other imposed fields so it reads as "not yours to set".
 */
const CALLER_REVIEWER_KEY_PARAM = 'callerReviewerKey';

/**
 * In managed mode, refuse a HUMAN-INITIATED mutating command presented on the
 * CONTROL token.
 *
 * THE FLIP THIS IS. Outside managed mode a control caller is the machine's
 * owner and may name the actor ROLE on anything; that is unchanged and this
 * function does nothing there. On a managed host — a fleet user's daemon
 * serving several people through one control plane — a control token names the
 * control plane and nobody in particular, so a human's accept, reject, close,
 * stop, create or edit arriving on it is an action with no person behind it.
 * Rather than attribute it to a machine, the daemon refuses and names the
 * remedy: mint a user token for the acting member
 * (docs/design/actor-identity-and-remote-clients.md §3.6).
 *
 * WHY THE DAEMON AND NOT THE CONTROL PLANE. A control plane's own list of
 * "verbs that need a member's token" cannot see a verb the daemon gained later;
 * this one is enforced at the surface every caller goes through, and its
 * membership is enumerated in ./rpc-command-kinds.ts where a test fails when a
 * new mutating command classifies itself as neither human nor control.
 *
 * READS ARE NEVER REFUSED, on either token — the same posture as the identity
 * gate. Nor are the control-plane surfaces of §3.6: minting and revoking
 * tokens, pushing credentials, project settings, session and container
 * plumbing. Those are the control plane acting as itself, not as somebody.
 */
function assertHumanActionCarriesAPerson(
  command: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
): void {
  if (caller.kind !== 'control') return;
  if (!isManagedMode()) return;
  if (!isHumanInitiatedRpc(command, params)) return;
  const what = command === 'storage' && typeof params.method === 'string'
    ? `storage.${params.method}`
    : command;
  throw new RpcError(
    403,
    `Forbidden: ${what} is a human-initiated action, and on a managed host every human action is recorded ` +
    `against the person who took it. This is the control-plane token, which names no person. ` +
    `Mint a user token for the acting member (mintActorToken with their email and name) and retry with it. ` +
    `The control token still does control-plane work: minting and revoking tokens, per-user credentials, ` +
    `project settings, session plumbing, and every read.`,
  );
}

/**
 * Impose the caller's token-derived identity on the `actor` it supplies.
 *
 * INVARIANT — a `user`-kind caller cannot name its own actor. `actor` is a
 * request FIELD, so honoring it from a per-user token would put attribution
 * back in the hands of the party being attributed: a human's CLI could record
 * its unblock as 'system' or 'agent' and disappear from the audit trail.
 *
 * A `control`-kind caller keeps naming the ROLE freely, and that is the whole
 * back-compat story: the legacy shared token resolves to `control`, so every
 * existing CLI, supervisor, and MCP path — all of which set `actor`
 * deliberately to record the CHANNEL a write came through — is untouched. The
 * control plane is trusted to name the role because it has already
 * authenticated the human itself.
 *
 * WHAT A CONTROL CALLER MAY NEVER NAME, outside managed mode, is the PERSON.
 * On a laptop there is no control plane and no directory of people: the
 * identity is the daemon's own git config (src/identity/), the daemon stamps it
 * here, and a request that arrives carrying an `email` or a `name` is refused
 * with a 403 in the same shape `pinActor` uses. One path in, always — a second
 * one would be the path nobody ever exercises and nobody ever checks. When that
 * identity is not configured, a store-writing command is refused in git's own
 * words; a READ is untouched (see ./rpc-command-kinds.ts).
 *
 * Applies to the `storage` proxy's nested `args` as well as to top-level
 * params: `storage` is the widest mutating surface there is (createTask,
 * updateTaskStatus, createComment, addTaskTag, saveMemory …), and leaving it
 * out would leave the enforcement trivially bypassable by routing the same
 * write through it.
 */
/**
 * `callerTaskId` says "the caller IS this task's own running agent", and the
 * handlers trust it as that proof: it is what lets a task sync itself while
 * `working` (`handleSyncTask`) and what lets a child be accepted into a parent
 * whose agent is mid-turn (`handleAcceptTask`). Only the MCP boundary may set
 * it, from the authenticated per-task context — and MCP tool calls reach the
 * handlers in-process or on a control token, never on a person's token.
 *
 * So a USER-kind caller presenting one is refused outright, never stripped: a
 * user token is what the Teams proxy relays a member's request on, and a
 * refusal is what makes a regression in that proxy's own argument check visible
 * instead of silently papered over. Checked at the top level and inside the
 * `storage` proxy's `args`, the two places a body can carry it.
 */
function refuseCallerTaskIdFromUser(
  command: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
): void {
  if (caller.kind !== 'user') return;
  const args = params.args;
  const nested = args !== null && typeof args === 'object' && !Array.isArray(args)
    && Object.hasOwn(args, 'callerTaskId');
  if (Object.hasOwn(params, 'callerTaskId') || nested) {
    throw new RpcError(
      403,
      `'${command}' refused: callerTaskId identifies a task's own running agent and cannot be sent on a person's token.`,
    );
  }
}

async function applyCallerActor(
  command: string,
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
): Promise<Record<string, unknown>> {
  // WHOSE DRAFT a delivered unblock/accept spends, imposed here and overwriting
  // anything a client sent. It is the CALLER's key — the review page and the
  // CLI of a one-person install share `local` — and deliberately NOT derived
  // from `actor`, which now carries a person on every laptop write and would
  // therefore never match the key the review page saved under.
  params = { ...params, [CALLER_REVIEWER_KEY_PARAM]: reviewerKey(caller) };

  // A member's token names a PERSON, but not that the person is at a terminal:
  // the Teams CLI proxy relays a bound clone's launch — a builder's or a
  // script's shell included — on that same token. So `usagePauseOverrideEligible`
  // is NOT pinned here; it is read from the body like any caller's, and the
  // Teams app (the only holder of user tokens) relays what the CLI sent and
  // sends `true` itself only from its own browser launches
  // (src/daemon/usage-pause.ts, `overrideEligible`).
  if (caller.kind === 'user') return pinCallerActor(params, caller);

  // Managed mode: identity rides the caller's token (§3.6). The environment
  // names nobody on a shared host, so the git-config path is not consulted at
  // all, and a control caller keeps its existing freedom.
  if (isManagedMode()) return params;

  // A request never carries a person outside managed mode — refused whether or
  // not this command writes, because a client sending one believes something
  // about how it is attributed that is not true.
  rejectAnySuppliedPerson(params);

  if (!isStoreWritingRpc(command, params)) return params;

  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) {
    throw new RpcError(403, resolution.refusal);
  }
  const { email, name } = resolution.identity;

  // The storage proxy is stamped BY METHOD, at the location that method's actor
  // actually sits (./rpc-command-kinds.ts). Only some of Storage's writers take
  // an `ActorInput` — the rest take a bare role, and their row types have no
  // person columns at all (a journal entry, an artifact, a memory record).
  // Handing one of those an `{ role, email }` object does not attribute it: it
  // writes the object itself into the row's `actor` field, which is a corrupt
  // record nobody notices until a surface renders "[object Object]".
  if (params.method !== undefined) {
    const path = typeof params.method === 'string'
      ? PERSON_ATTRIBUTED_STORAGE_ACTORS.get(params.method)
      : undefined;
    if (!path) return params;
    return stampAtPath(params, ['args', ...path], email, name);
  }

  const stamped = mapActorContainers(params, (c) => stampPerson(c, email, name));

  // A COMMAND THAT NAMES NO ACTOR still has one: every mutating handler falls
  // back to `params.actor ?? getActor()`, the daemon's own channel default, and
  // `lazy unblock` — the single most attribution-bearing action a human takes —
  // is one of the callers that relies on it. Making that default explicit here
  // is what puts the person on it; the ROLE is unchanged, because this is the
  // same `getActor()` the handler would have called a moment later.
  //
  // Deliberately top-level only. A `storage` call that names no actor means
  // "record no actor" (a row shape the store supports and several internal
  // writes rely on), and inventing a role there would put a person's name on a
  // write nobody attributed.
  if (stamped.method === undefined && actorRole(stamped.actor as ActorInput | undefined) === undefined) {
    return { ...stamped, actor: { role: getActor(), email, ...(name ? { name } : {}) } satisfies ActorRef };
  }
  return stamped;
}

/**
 * Apply `transform` to every container a USER-kind caller's actor can sit in.
 *
 * THREE of them: top-level params, the `storage` proxy's `args`, and
 * `args.options` — `createTurn` is the storage method that carries its actor
 * inside an options bag, and it is the single most attribution-bearing write
 * there is. This is the pinning path (a token-derived identity), which is only
 * ever asked to OVERWRITE what a caller sent; the daemon's own stamping goes
 * through {@link stampAtPath} instead, at the declared location.
 */
function mapActorContainers(
  params: Record<string, unknown>,
  transform: (container: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  if (params.method !== undefined && typeof params.args === 'object' && params.args !== null && !Array.isArray(params.args)) {
    const args = transform(params.args as Record<string, unknown>);
    if (typeof args.options === 'object' && args.options !== null && !Array.isArray(args.options)) {
      args.options = transform(args.options as Record<string, unknown>);
    }
    return { ...params, args };
  }
  return transform(params);
}

/**
 * Write `{ role, email, name }` at one declared location, cloning the objects
 * along the way so the caller's request is never mutated in place.
 *
 * Only where a ROLE is already present — see {@link stampPerson}. A missing
 * intermediate container means the call did not carry an actor there at all,
 * which is not this function's business to invent.
 */
function stampAtPath(
  params: Record<string, unknown>,
  path: readonly string[],
  email: string,
  name: string | undefined,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) return params;
  if (rest.length === 0) return stampPerson(params, email, name);
  const child = params[head];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return params;
  return { ...params, [head]: stampAtPath(child as Record<string, unknown>, rest, email, name) };
}

/**
 * Refuse a request that names the PERSON behind ANY actor in it, wherever it
 * sits.
 *
 * A WALK AND NOT A LIST OF PLACES, deliberately. The first version checked the
 * three containers the pinning path knows about, and so silently allowed the
 * one shape that mattered most: `storage` → `resolveRaisedItem` carries its
 * actor inside `resolution`, reaches `resolved_by_email` / `resolved_by_name`,
 * and a daemon-token caller could therefore record somebody else as having
 * decided a raised item — permanently, on the gate that blocks an accept —
 * while the same attempt through `createComment` was correctly refused. An
 * enumeration that has to stay in step with every argument shape in the Storage
 * proxy is an enumeration that will fall out of step; refusing on the KEY,
 * anywhere, cannot.
 *
 * Bounded: objects and arrays only, to a depth past anything the proxy nests.
 * A blank email/name is 'unset' rather than 'somebody else' (the same rule the
 * store uses, see `actorEmail` in src/actor-ref.ts), so it never trips this.
 */
function rejectAnySuppliedPerson(value: unknown, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) rejectAnySuppliedPerson(entry, depth + 1);
    return;
  }
  const container = value as Record<string, unknown>;
  const supplied = container.actor;
  if (supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied)) {
    const ref = supplied as Record<string, unknown>;
    const named = (ref.email !== undefined && ref.email !== null && ref.email !== '')
      || (ref.name !== undefined && ref.name !== null && ref.name !== '');
    if (named) {
      throw new RpcError(
        403,
        "Forbidden: a request may not name the person behind its actor. This daemon takes the acting identity from its own git config " +
        "(git config user.email / user.name) — send the actor ROLE alone, or nothing at all. " +
        'Only a managed-mode deployment attributes writes from a caller-presented token.',
      );
    }
  }
  for (const entry of Object.values(container)) rejectAnySuppliedPerson(entry, depth + 1);
}

/**
 * Put the daemon's resolved git identity on an actor the caller named.
 *
 * Only where a ROLE is already present. An absent `actor` means the write
 * records no actor at all — a storage default this gate has no business
 * turning into a claim that a particular person did it. A bare role string is
 * widened into a ref, which is exactly how the CLI's `actor: 'human'` becomes
 * "Ada did this, from a terminal".
 */
function stampPerson(
  container: Record<string, unknown>,
  email: string,
  name: string | undefined,
): Record<string, unknown> {
  const role = actorRole(container.actor as ActorInput | undefined);
  if (!role) return container;
  const stamped: ActorRef = { role, email, ...(name ? { name } : {}) };
  return { ...container, actor: stamped };
}

/**
 * Replace whatever `actor` a user-kind caller supplied with the token's own
 * identity: the `human` role AND the person behind it.
 *
 * The person is what makes attribution durable — the `(email, name)` pair is
 * written to the store alongside the role (see ActorRef in src/types) — and it
 * comes from HERE, the token, never from the request. A caller may still send
 * `actor: 'human'` (or `{ role: 'human', email: <its own address> }`)
 * redundantly; naming a DIFFERENT role or a DIFFERENT person is a 403 rather
 * than a silent overwrite.
 *
 * Both halves refuse for the same reason. Overwriting would be unforgeable
 * either way — the stored value comes from the token regardless — but a client
 * that believes it is writing as someone else is confused about whose identity
 * it holds, and silently rewriting the row it asked for hides that from it. The
 * refusal is the only thing that tells it.
 *
 * WHERE the identity lands is not uniform, and the two halves are deliberately
 * asymmetric: the REFUSALS walk the whole request, while the PINNING follows
 * `PERSON_ATTRIBUTED_STORAGE_ACTORS` for a `storage` call and the top level for
 * everything else. See the comments inside for why writing a person anywhere
 * else corrupts the row.
 */
function pinCallerActor(
  params: Record<string, unknown>,
  caller: Extract<ActorIdentity, { kind: 'user' }>,
): Record<string, unknown> {
  // REFUSALS FIRST, AND OVER EVERYTHING THE CALLER SENT. A client naming a
  // foreign role or a foreign person must be told so wherever it put it —
  // including in a container this function will not pin into. Narrowing the
  // refusal to the pinned location would make "which method is it" decide
  // whether impersonation is reported, which is exactly backwards.
  assertActorIsNotForeign(params, caller);

  // THE STORAGE PROXY IS PINNED BY METHOD, at the location that method's actor
  // actually sits — the same declaration the daemon's own stamping path reads
  // (PERSON_ATTRIBUTED_STORAGE_ACTORS, ./rpc-command-kinds.ts).
  //
  // WHY THIS IS NOT `mapActorContainers`, WHICH IT USED TO BE: that walked
  // `args` and `args.options` for EVERY method, and most of Storage's writers
  // take a bare `Actor` ROLE STRING (`createTaskArtifact`, `saveScratchFile`,
  // `saveMemory`, `dismissSystemMessage`). Their row types have no person
  // columns at all, and the proxy table passes the argument through as `any`,
  // so an ActorRef OBJECT landed in the row verbatim — `updated_by:
  // {"role":"human",...}` persisted into append-only state and rendered as
  // "[object Object]". The stamping path already consulted this map for that
  // exact reason; the pinning path did not, and once a managed host refuses
  // every non-read `storage` call on the control token, this path is the ONLY
  // route those writes take. A method absent from the map keeps whatever role
  // it carried: the store records no person for it, which is the truth.
  if (params.method !== undefined) {
    const path = typeof params.method === 'string'
      ? PERSON_ATTRIBUTED_STORAGE_ACTORS.get(params.method)
      : undefined;
    if (!path) return params;
    return pinAtPath(params, ['args', ...path], pinnedActorOf(caller));
  }

  return { ...params, actor: pinnedActorOf(caller) };
}

/**
 * Refuse a request in which a user-kind caller names a DIFFERENT role or a
 * DIFFERENT person than its token, wherever in the request it sits.
 *
 * A WALK, for the same reason {@link rejectAnySuppliedPerson} is one: the
 * argument shapes in the Storage proxy are not uniform, and an enumeration of
 * containers will fall out of step with them. Bounded to the same depth.
 */
function assertActorIsNotForeign(
  value: unknown,
  caller: Extract<ActorIdentity, { kind: 'user' }>,
  depth = 0,
): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertActorIsNotForeign(entry, caller, depth + 1);
    return;
  }
  const container = value as Record<string, unknown>;
  const supplied = container.actor;
  const isRef = supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied);
  // Before anything else, and here as well as in the parser: this path REPLACES
  // the supplied actor, so a client still sending the pre-identity `userId`
  // spelling would have it dropped without ever being told.
  if (isRef) rejectLegacyActorUserId(supplied as Record<string, unknown>);
  const suppliedRole = isRef ? (supplied as Record<string, unknown>).role : supplied;
  if (suppliedRole !== undefined && suppliedRole !== null && suppliedRole !== USER_ACTOR) {
    throw new RpcError(
      403,
      `Forbidden: this token identifies user ${caller.email}, which may not act as '${String(suppliedRole)}'. ` +
      `Per-user tokens take their actor from the token itself — omit the 'actor' parameter. ` +
      `Only a control-plane token may name the actor on a request.`,
    );
  }
  // An empty email is 'unset', not 'somebody else' — same rule the store uses
  // (see actorEmail in src/actor-ref.ts), so a blank never trips the refusal.
  // Compared canonically, so a member spelling their OWN address with different
  // case or a stray space is not told they are impersonating themselves.
  const suppliedEmail = isRef ? (supplied as Record<string, unknown>).email : undefined;
  if (
    typeof suppliedEmail === 'string' && suppliedEmail !== '' &&
    canonicalPersonEmail(suppliedEmail) !== canonicalPersonEmail(caller.email)
  ) {
    throw new RpcError(
      403,
      `Forbidden: this token identifies user ${caller.email}, which may not act as user '${String(suppliedEmail)}'. ` +
      `Per-user tokens take their actor from the token itself — omit the 'actor' parameter. ` +
      `Only a control-plane token may name the actor on a request.`,
    );
  }
  for (const entry of Object.values(container)) assertActorIsNotForeign(entry, caller, depth + 1);
}

/**
 * Write a pinned actor at one declared location, cloning along the way.
 *
 * Unlike {@link stampAtPath} this sets the actor whether or not one was already
 * present: a user token's write is that person's act even when the client sent
 * no `actor` at all. A missing INTERMEDIATE container still leaves the request
 * untouched — the call did not carry an actor there, and inventing the bag to
 * hold one would change what the method was asked to do.
 */
function pinAtPath(
  params: Record<string, unknown>,
  path: readonly string[],
  pinned: ActorRef,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) return params;
  if (rest.length === 0) return { ...params, [head]: pinned };
  const child = params[head];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return params;
  return { ...params, [head]: pinAtPath(child as Record<string, unknown>, rest, pinned) };
}

function pinnedActorOf(caller: Extract<ActorIdentity, { kind: 'user' }>): ActorRef {
  // The token's identity, as the store names people: BOTH halves of the
  // `(email, name)` pair the token was minted with. The address answers WHICH
  // person and lands in `actor_email`; the display name is what a surface
  // renders beside it (`name <email>`, as git does) and lands in `actor_name`.
  //
  // The name comes from the MINT and never from the token's free-text label,
  // which names the TOKEN rather than a person — the one control plane minting
  // these used to pass the member's address there beside an opaque id, so
  // adopting the label would have persisted `actor_email: 'user-7'` beside
  // `actor_name: 'ada@example.com'`: a person who does not exist. The mint now
  // takes the pair by name (docs/design/actor-identity-and-remote-clients.md
  // §3.6), which is what makes stamping the name safe.
  //
  // A supplied `name` is not refused the way `email` is: a display name is not
  // a claim about WHICH person, so it cannot impersonate anyone, and the
  // token's own name overwrites it either way.
  return {
    role: USER_ACTOR,
    email: caller.email,
    ...(caller.name ? { name: caller.name } : {}),
  };
}

/** Refuse a control-plane-only RPC to anyone else. */
function requireControlActor(caller: ActorIdentity, command: string): void {
  if (caller.kind === 'control') return;
  throw new RpcError(
    403,
    `Forbidden: ${command} is a control-plane operation. This token identifies user ${caller.email}, ` +
    `which cannot mint or revoke daemon access.`,
  );
}

export async function handleStartTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const startParams: StartTaskParams = {
    taskId: requireString(params, 'taskId'),
    modelOverride: optionalString(params, 'modelOverride'),
    agentId: optionalString(params, 'agentId'),
    forceLocal: optionalBoolean(params, 'forceLocal'),
    retargetOrphan: optionalBoolean(params, 'retargetOrphan'),
    effortOverride: optionalString(params, 'effortOverride'),
    // Validated at the boundary, like every external input: an unrecognised
    // mode, gate or toggle is refused by name rather than silently resolving to
    // a default the caller did not ask for.
    reviewOverrides: optionalReviewOverrides(params, 'reviewOverrides'),
    // Not enum-checked here: resolveRunnerType owns the alias mapping and its
    // own error text ("container" → docker, etc.).
    runnerOverride: optionalString(params, 'runnerOverride') as RunnerType | undefined,
    // REQUIRED here, unlike every other handler's `optionalActorInput`: a start
    // WRITES the turn whose actor decides the task's audience, and a launch
    // path that forgot to name its channel used to default to `human` in
    // silence. A 400 naming the field is the correct answer to a caller that
    // does not know who it is. See StartTaskParams.actor.
    actor: requireActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    onProgress: progress,
  };

  logger.info(`Starting task ${startParams.taskId.substring(0, 8)}`);

  // Root span for the whole start request. Stitches under the caller's trace
  // when a `traceparent` was propagated (CLI → daemon); otherwise starts a new
  // trace. This is the "request received" boundary on the daemon side.
  const parentCtx = contextFromTraceparent(optionalString(params, 'traceparent'));
  return withRootSpan('lazy.start', parentCtx, {
    'lazy.command': 'start',
    'lazy.task_id': startParams.taskId,
  }, () => launchTask(projectRoot, startParams));
}

// --- Edit Task ---

export async function handleEditTask(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  try {
    return await editTask(storage, projectRoot, {
      taskId: requireString(params, 'taskId'),
      goal: optionalString(params, 'goal'),
      prompt: optionalString(params, 'prompt'),
      model: optionalString(params, 'model'),
      type: optionalString(params, 'type'),
      code: params.code === null || typeof params.code === 'string' ? (params.code as string | null) : undefined,
      parent: params.parent === null || typeof params.parent === 'string' ? (params.parent as string | null) : undefined,
      effort: optionalString(params, 'effort'),
      agent: optionalString(params, 'agent'),
      runner: params.runner === null || typeof params.runner === 'string' ? (params.runner as string | null) : undefined,
      // An edit is attributed like every other human act on a task. This
      // handler read no actor at all until `teams-identity-is-the-token`, so a
      // per-user token on an `editTask` call bought nothing: the change to a
      // task's model or effort was the one act with nobody behind it.
      actor: optionalActorInput(params) ?? getActor(),
    });
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // validateModel/validateCode throw plain Errors with human text.
    throw new RpcError(400, message);
  }
}

// --- Unblock Task ---

export async function handleUnblockTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const rawPermissionMode = params.permissionMode;
  let permissionMode: 'plan' | 'default' | undefined;
  if (rawPermissionMode !== undefined) {
    if (rawPermissionMode !== 'plan' && rawPermissionMode !== 'default') {
      throw new RpcError(400, `Invalid permissionMode: ${String(rawPermissionMode)}. Expected 'plan' or 'default'.`);
    }
    permissionMode = rawPermissionMode;
  }

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept):
  // unblock has no approval channel at all. Refuse loudly rather than accept and
  // ignore the field: an older client passing `approvedFiles: []` meant "revert
  // everything", and silently treating that as a no-op would leave the caller
  // believing it had made a decision the daemon never recorded.
  if (params.approvedFiles !== undefined) {
    throw new RpcError(400,
      'unblock no longer takes approvedFiles: protected-file approval happens at accept. ' +
      'Unblock with feedback alone, then run `lazy accept <task> --approve-file <file>` when the work is ready to merge.');
  }

  const unblockParams: UnblockTaskParams = {
    taskId: requireString(params, 'taskId'),
    message: requireString(params, 'message'),
    modelOverride: optionalString(params, 'modelOverride'),
    raisedResolutions: optionalRaisedResolutions(params),
    retargetOrphan: optionalBoolean(params, 'retargetOrphan'),
    notesInEditor: optionalBoolean(params, 'notesInEditor'),
    effortOverride: optionalString(params, 'effortOverride'),
    agentOverride: optionalString(params, 'agentOverride'),
    permissionMode,
    actor: optionalActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    callerReviewerKey: optionalString(params, CALLER_REVIEWER_KEY_PARAM),
    // Somebody typed this unblock — `lazy unblock`, `lazy_unblock`, the review
    // page — so it submits whatever review they were holding.
    filesReview: true,
    keepFeedbackDraft: optionalBoolean(params, 'keepFeedbackDraft'),
    onProgress: progress,
  };

  logger.info(`Unblocking task ${unblockParams.taskId.substring(0, 8)}`);
  return launchUnblockTask(projectRoot, unblockParams);
}

// --- Ask Task (read-only Q&A against the session) ---

export async function handleAskTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const askParams: AskTaskParams = {
    taskId: requireString(params, 'taskId'),
    message: requireString(params, 'message'),
    effortOverride: optionalString(params, 'effortOverride'),
    actor: optionalActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    onProgress: progress,
  };

  logger.info(`Asking task ${askParams.taskId.substring(0, 8)}`);
  return launchAskTask(projectRoot, askParams);
}

// --- Review Task (read-only review turn in a NEW session) ---

export async function handleReviewTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const reviewParams: ReviewTaskParams = {
    taskId: requireString(params, 'taskId'),
    modelOverride: optionalString(params, 'modelOverride'),
    effortOverride: optionalString(params, 'effortOverride'),
    autoFix: optionalBoolean(params, 'autoFix'),
    actor: optionalActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    onProgress: progress,
  };

  logger.info(`Reviewing task ${reviewParams.taskId.substring(0, 8)}`);
  return launchReviewTask(projectRoot, reviewParams);
}

// --- Await a claimed turn (the blocking half of ask / review) ---

/**
 * Block until an asynchronous ask/review turn has been recorded.
 *
 * `askTask` and `reviewTask` START a turn and return; this is what a surface
 * that keeps a blocking UX for a human (`lazy ask`, `lazy review`, the TUI,
 * the web Review dialog) calls next. `timeoutMs` bounds only THIS caller — the
 * turn itself has no ceiling and keeps running if the caller gives up.
 */
export async function handleAwaitClaimedTurn(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  return awaitClaimedTurn(projectRoot, {
    taskId: requireString(params, 'taskId'),
    sessionId: requireString(params, 'sessionId'),
    turnSequence: requireNumber(params, 'turnSequence'),
    timeoutMs: optionalNumber(params, 'timeoutMs'),
    onProgress: progress,
  });
}

// --- Accept Task Preflight ---

export async function handleAcceptTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  const preflightParams: AcceptTaskPreflightParams = {
    taskId: requireString(params, 'taskId'),
    approvedFiles: optionalStringArray(params, 'approvedFiles'),
    raisedResolutions: optionalRaisedResolutions(params),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    // `--allow-review-issues` on the CLI. Deliberately never set by the MCP
    // boundary: the agent-facing surface has no such parameter (an agent may
    // not overrule a review of its own work).
    allowReviewIssues: optionalBoolean(params, 'allowReviewIssues'),
    allowQueuedComments: optionalBoolean(params, 'allowQueuedComments'),
    actor: optionalActorInput(params),
  };

  return acceptTaskPreflight(projectRoot, preflightParams);
}

// --- Accept Task (Full) ---

export async function handleAcceptTask(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const acceptParams: AcceptTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: optionalString(params, 'reason'),
    // The approval passphrase for a protected merge, from the CLI's own TTY
    // prompt. The MCP boundary never sets it (see createAcceptHandler) — a
    // gated accept over MCP is refused before this RPC is ever made.
    token: optionalString(params, 'token'),
    approvedFiles: optionalStringArray(params, 'approvedFiles'),
    raisedResolutions: optionalRaisedResolutions(params),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    allowBroken: optionalBoolean(params, 'allowBroken'),
    // `--allow-review-issues` on the CLI. Deliberately never set by the MCP
    // boundary (see handleAcceptTaskPreflight) — an agent may not overrule a
    // review of its own work.
    allowReviewIssues: optionalBoolean(params, 'allowReviewIssues'),
    allowQueuedComments: optionalBoolean(params, 'allowQueuedComments'),
    actor: optionalActorInput(params),
    callerReviewerKey: optionalString(params, CALLER_REVIEWER_KEY_PARAM),
    callerTaskId: optionalString(params, 'callerTaskId'),
    onProgress: progress,
  };

  return acceptTask(projectRoot, acceptParams);
}

// --- Reject Task ---

export async function handleRejectTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const rejectParams: RejectTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: requireString(params, 'reason'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    actor: optionalActorInput(params),
    onProgress: progress,
  };

  return rejectTask(projectRoot, rejectParams);
}

// --- Close Task ---

export async function handleCloseTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const closeParams: CloseTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: requireString(params, 'reason'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    actor: optionalActorInput(params),
    onProgress: progress,
  };

  return closeTask(projectRoot, closeParams);
}

// --- Sync Task From Remote ---

/**
 * `syncTaskFromRemote` — import a task's new PR/MR comments and reconcile a PR
 * merged or closed on the forge, for the CLI's review flows (`lazy unblock`,
 * `lazy loop`). It runs HERE, not in the CLI process, because a merged PR runs
 * the accept transition under the task's lifecycle lock, and that lock is an
 * in-process map: only inside the daemon does it exclude a live accept, a
 * stranded-merge resume, or the daemon's own remote-sync seeing the same merge.
 */
export async function handleSyncTaskFromRemote(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const taskId = requireString(params, 'taskId');
  const task = await storage.getTask(taskId);
  if (!task) throw new RpcError(404, `Task not found: ${taskId}`);
  await syncTaskFromRemote(task, storage, projectRoot, optionalActorInput(params));
  const fresh = await storage.getTask(taskId);
  return { status: fresh?.status ?? task.status };
}

// --- Reopen Task ---

export async function handleReopenTask(projectRoot: string, params: Record<string, unknown>) {
  const reopenParams: ReopenTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: optionalString(params, 'reason'),
    actor: optionalActorInput(params),
  };
  return reopenTask(projectRoot, reopenParams);
}

// --- Stop Task ---

export async function handleStopTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const stopParams: StopTaskParams = {
    taskId: requireString(params, 'taskId'),
    // Stop's reason must be non-blank: it is recorded as the human turn that
    // explains why the task was halted, and "   " explains nothing.
    reason: requireNonBlankString(params, 'reason'),
    actor: optionalActorInput(params),
    onProgress: progress,
  };
  return stopTask(projectRoot, stopParams);
}

/**
 * Bring a task's container up WITHOUT starting a turn.
 *
 * `lazy shell --container` needs an environment to enter, not an agent to run.
 * The launch has to happen here because the container's MCP config carries a
 * per-container token only the daemon can mint.
 */
export async function handleEnsureTaskContainer(projectRoot: string, params: Record<string, unknown>) {
  return ensureTaskContainer(projectRoot, {
    taskId: requireString(params, 'taskId'),
    restart: optionalBoolean(params, 'restart'),
  });
}

// --- Published ports ---

/**
 * `servePorts` — where a task's declared `[serve]` services are reachable.
 *
 * The same state `lazy url` prints, over RPC, for a client that is not this
 * process. Its subscriber is the lazy-teams Rails UI, which composes this
 * container→host hop with the VM→host one to build a preview URL
 * (docs/design/lazy-teams.md §2.4, §6) — it had no way to ask for it before.
 *
 * Read-only and computed on demand: host ports are OS-assigned at container
 * creation and read back from the runtime, never persisted. That is also why
 * the `ports.changed` event carries no port list — it says the mapping MOVED,
 * and the client calls this to find out what it moved to.
 *
 * Each resolved service also carries `listening` — a bare TCP connect probe
 * against its host port (src/serve/probe.ts: connect, close on connect, no
 * bytes, ~300ms cap, all services in parallel). `null` when the probe could
 * not be attempted (no live binding). Never cached: this is called per render.
 *
 * A task whose runner has no container, or whose container is down, is a normal
 * answer (`unavailable`), not an error: the caller is asking about state, and
 * "not running" IS the state. Only an unresolvable task ref is a 4xx.
 */
export async function handleServePorts(projectRoot: string, params: Record<string, unknown>) {
  const ref = requireString(params, 'taskId');
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${ref}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${ref}`);
  }
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  const [state, startServicesCmd] = await Promise.all([
    getTaskServeState(projectRoot, task, session),
    resolveProjectStartServicesCmd(storage, projectRoot),
  ]);
  const services = await probeServices(state.services);

  // Task identity travels with the state so a client holding several of these
  // does not have to remember which ref it asked with. `startServicesCmd` is
  // the project's designated Start services command ('' when none) — the same
  // resolution the dashboard's Services card renders, so Lazy Teams shows and
  // designates the one value (`serve.setStartServicesCmd`).
  return { taskId: task.id, displayId: displayId(task), status: task.status, ...state, services, startServicesCmd };
}

// --- Live progress on a running task ---

/**
 * How long one task's git commit count is reused before it is measured again.
 *
 * Several people watching the same task collapse to one `git rev-list` per
 * window rather than one per viewer, and the readout ticks every few seconds
 * anyway — a count that is at most this stale is indistinguishable from a live
 * one, and it bounds what polling can cost the daemon.
 */
const COMMIT_COUNT_TTL_MS = 2000;

const commitCountCache = new Map<string, { at: number; count: number }>();

async function liveCommitCount(worktreePath: string, sinceSha: string): Promise<number> {
  const key = `${worktreePath}\u0000${sinceSha}`;
  const cached = commitCountCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < COMMIT_COUNT_TTL_MS) return cached.count;

  const count = await countNewCommits(sinceSha, worktreePath);
  commitCountCache.set(key, { at: now, count });
  // The cache is keyed by worktree and only grows with tasks that were actually
  // watched; trim it rather than let a long-lived daemon accumulate entries.
  if (commitCountCache.size > 128) {
    for (const [k, v] of commitCountCache) {
      if (now - v.at >= COMMIT_COUNT_TTL_MS) commitCountCache.delete(k);
    }
  }
  return count;
}

/**
 * What a task has spent and produced, including the turn still in flight.
 *
 * A read, and only a read: it resolves the task, sums the durable numbers the
 * store already has, and adds the live ones — the proxy's in-memory tally for
 * tokens (see `./task-progress`) and a git count for commits an agent has made
 * but that no turn has recorded yet. Nothing here starts work, and nothing here
 * talks to a supervisor.
 *
 * `live` is what tells a client to stop asking: a task that is not working has
 * nothing left to tick.
 */
export async function handleTaskProgress(projectRoot: string, params: Record<string, unknown>) {
  const ref = requireString(params, 'taskId');
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${ref}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${ref}`);
  }
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  const live = task.status === 'working';

  const recordedUsage = session?.total_usage ?? null;
  const recordedTokens = recordedUsage
    ? recordedUsage.inputTokens + recordedUsage.outputTokens +
      recordedUsage.cacheCreationTokens + recordedUsage.cacheReadTokens
    : 0;

  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const commits = session ? await storage.getSessionCommits(session.id) : [];

  // The boundary between "already recorded" and "happening now". Everything the
  // proxy saw after the last recorded turn belongs to the turn in flight; when
  // that turn is reconciled the boundary moves past it and the live figure
  // falls back to zero on its own.
  const lastRecordedAt = turns.reduce(
    (latest, turn) => Math.max(latest, turn.timestamp ?? 0),
    session?.started_at ?? task.created_at ?? 0,
  );

  const turnTotals = live ? taskProgress.since(task.id, lastRecordedAt) : null;

  // Commits an agent made this turn are in the branch immediately; storage only
  // learns about them when the turn is reconciled. Only worth measuring while
  // the task is live, and only when its worktree is actually there.
  let uncountedCommits = 0;
  if (live) {
    const worktreePath = getWorktreePath(projectRoot, task);
    // Anchor at the BRANCH POINT, never at the last recorded commit.
    // `getSessionCommits` sorts by write time while git answers newest-first,
    // so on a task with legacy records that last element is the OLDEST commit
    // of its batch and the range start walks backwards — the same defect this
    // task exists to remove, here inflating a live counter instead of the
    // store. Counting from the branch point and subtracting what is recorded
    // asks a question that cannot drift.
    // ...and through the same ancestry check the recording path uses, so a
    // branch point that stopped being an ancestor of the tip (a reopened task,
    // a recovered worktree, a rewritten base) degrades to the merge base
    // instead of counting a range that spans unrelated history.
    if (await pathExists(worktreePath)) {
      const { base } = await resolveCommitScanBase(session?.git_start_sha, worktreePath);
      if (base) {
        const onBranch = await liveCommitCount(worktreePath, base);
        uncountedCommits = Math.max(0, onBranch - commits.length);
      }
    }
  }

  return {
    taskId: task.id,
    displayId: displayId(task),
    status: task.status,
    live,
    tokens: {
      recorded: recordedTokens,
      turn: turnTotals?.totalTokens ?? 0,
      total: recordedTokens + (turnTotals?.totalTokens ?? 0),
    },
    requests: { turn: turnTotals?.requests ?? 0 },
    turns: turns.length,
    commits: commits.length + uncountedCommits,
    lastActivityAt: session?.last_interaction_at ?? lastRecordedAt ?? null,
  };
}

// --- Task stats ---

/**
 * Where one task's — or one whole subtree's — time and tokens went.
 *
 * The same derivation the web Stats tab renders, over the wire for a client
 * that is not this daemon (Lazy Teams). Scope is the caller's to pick and the
 * answer says which one it actually got: asking for `subtree` on a leaf task
 * returns `task`, because folding in nothing is not a rollup.
 */
export async function handleTaskStats(projectRoot: string, params: Record<string, unknown>) {
  const ref = requireString(params, 'taskId');
  const rawScope = params.scope === undefined || params.scope === null ? null : String(params.scope);
  const scope = rawScope === null ? 'subtree' : parseStatsScope(rawScope);
  if (scope === null) {
    throw new RpcError(400, `Invalid scope '${rawScope}'. Expected 'task' or 'subtree'.`);
  }

  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(
        409,
        `Ambiguous task ID '${ref}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`,
      );
    }
    throw new RpcError(404, `Task not found: ${ref}`);
  }

  const result = await loadTaskStats(storage, resolved.task, { scope });
  return {
    taskId: resolved.task.id,
    displayId: displayId(resolved.task),
    scope: result.scope,
    descendantCount: result.descendantCount,
    stats: result.stats,
  };
}

// --- Per-task environment variables ---

/**
 * Read/write a task's own environment variables (`lazy env`).
 *
 * One handler for the whole family because they share the ref resolution and
 * the same shaped result. The `set` action is the ONLY place a value crosses
 * this boundary; every response returns key NAMES only, so no surface above
 * this one — RPC log, CLI output, web UI — can print a value even by accident.
 *
 * Deliberately absent from the MCP tool surface: an agent must not be able to
 * read or rewrite the secrets its own task was given. See
 * docs/surface-asymmetries.md.
 */
export async function handleTaskEnv(projectRoot: string, params: Record<string, unknown>) {
  const action = requireString(params, 'action');
  const storage = await getOrCreateStorage();
  const ref = requireString(params, 'taskId');
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${ref}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${ref}`);
  }
  const task = resolved.task;

  try {
    switch (action) {
      case 'list':
        return { taskId: task.id, displayId: displayId(task), status: task.status, keys: await listTaskEnvKeys(projectRoot, task.id) };
      case 'set': {
        const vars = params.vars;
        if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
          throw new RpcError(400, `'vars' must be an object of KEY=VALUE pairs.`);
        }
        const entries: Record<string, string> = {};
        for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
          if (typeof value !== 'string') {
            throw new RpcError(400, `Value for '${key}' must be a string.`);
          }
          entries[key] = value;
        }
        if (Object.keys(entries).length === 0) {
          throw new RpcError(400, `No variables given. Pass at least one KEY=VALUE.`);
        }
        const keys = await setTaskEnv(projectRoot, task.id, entries);
        return { taskId: task.id, displayId: displayId(task), status: task.status, keys, changed: Object.keys(entries).sort() };
      }
      case 'unset': {
        const keys = optionalStringArray(params, 'keys') ?? [];
        if (keys.length === 0) throw new RpcError(400, `No variable names given.`);
        const removed = await unsetTaskEnv(projectRoot, task.id, keys);
        return { taskId: task.id, displayId: displayId(task), status: task.status, removed, keys: await listTaskEnvKeys(projectRoot, task.id) };
      }
      case 'clear': {
        const count = await clearTaskEnv(projectRoot, task.id);
        return { taskId: task.id, displayId: displayId(task), status: task.status, removed: count, keys: [] };
      }
      default:
        throw new RpcError(400, `Unknown taskEnv action: ${action}`);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    // Validation failures (bad key name, reserved key, caps) carry the
    // actionable text the user needs — surface it as a 400, not a 500.
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}

// --- Submit Task ---

export async function handleSubmitTask(projectRoot: string, params: Record<string, unknown>) {
  const submitParams: SubmitTaskParams = {
    taskId: requireString(params, 'taskId'),
    actor: optionalActorInput(params),
  };

  return submitTask(projectRoot, submitParams);
}

export async function handleSubmitTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  return submitTaskPreflight(projectRoot, requireString(params, 'taskId'), optionalActorInput(params));
}

export async function handleGetTaskUpstreamStatus(projectRoot: string, params: Record<string, unknown>) {
  return getTaskUpstreamStatus(projectRoot, requireString(params, 'taskId'));
}

/**
 * `createTask` — the whole create, through the ONE implementation the web
 * New-task form uses (`src/daemon/create-task.ts`): validation, parent
 * resolution (a finished parent is refused), agent inheritance from the parent
 * and `[agent.by_type]`, the parent's image pin, code derivation, and the
 * prompt / model / effort writes. Lazy Teams used to reassemble a create from
 * raw storage writes, which skipped every one of those rules for a subtask.
 * What a new child means for its parent (a cluster's wake) stays in the
 * storage tap, which this goes through like every other create.
 */
export async function handleCreateTask(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  return createTaskFromInput(storage, projectRoot, {
    goal: requireString(params, 'goal'),
    prompt: optionalString(params, 'prompt'),
    code: optionalString(params, 'code'),
    parent: optionalString(params, 'parent'),
    type: optionalString(params, 'type'),
    model: optionalString(params, 'model'),
    effort: optionalString(params, 'effort'),
    agent: optionalString(params, 'agent'),
    actor: optionalActorInput(params),
  });
}

export async function handleCloneTask(projectRoot: string, params: Record<string, unknown>) {
  return cloneTask(projectRoot, {
    taskId: requireString(params, 'taskId'),
    goal: optionalString(params, 'goal'),
    prompt: optionalString(params, 'prompt'),
    code: optionalString(params, 'code'),
    parent: optionalString(params, 'parent'),
    model: optionalString(params, 'model'),
    agent: optionalString(params, 'agent'),
    sameBase: params.sameBase === true,
    base: optionalString(params, 'base'),
    defaultParent: params.defaultParent === true,
    actor: optionalActorInput(params),
  });
}

export async function handleRedoTask(projectRoot: string, params: Record<string, unknown>) {
  return redoTask(projectRoot, {
    taskId: requireString(params, 'taskId'),
    reason: requireString(params, 'reason'),
    actor: optionalActorInput(params),
  });
}

/**
 * `clusters` — every `cluster` task, how far along it is, and its children.
 *
 * The method was called `loops` until 2026-09-20 and still answers to that name
 * for ONE release, because a deployed Lazy Teams can be older than the daemon
 * it talks to and an unknown method there is a hard failure. That legacy call
 * gets the rows under the legacy KEY as well (`legacyKey`), which is the whole
 * point of keeping it: a client that called `loops` reads `payload["loops"]`,
 * so answering the old method with only the new key would hand it an empty
 * list and render "no cluster tasks" for a project that has several — worse
 * than the error it was meant to avoid. Both go in the next release.
 *
 * The whole point of this command is that the DERIVATION travels rather than
 * the ingredients: k-of-n, what is running, what was deferred and what was
 * closed are `clusterProgressOf` (src/task/cluster-progress.ts), answered here,
 * so a remote client renders the same numbers `lazy show` and the dashboard
 * print. A client that reassembled them from a task tree would be holding a
 * second copy of a rule CLAUDE.md says has exactly one home — and would get the
 * denominator wrong the first time a child was closed.
 *
 * Ordering is part of the answer too (running clusters first, newest first), so
 * two surfaces cannot list the same clusters differently. `openCount` is the
 * dashboard's own badge number, for a client that wants it without counting
 * statuses itself.
 */
export async function handleClusters(options: { legacyKey?: boolean } = {}) {
  const storage = await getOrCreateStorage();
  const entries = sortClusterEntries(await listClusterEntries(storage));
  const clusters = entries.map(({ task, children }) => ({
    task,
    // Non-null by construction: listClusterEntries only returns `cluster` tasks.
    progress: clusterProgressPayload(clusterProgressOf(task, children)!),
    // The child rows a listing renders, each carrying whether THIS cluster set
    // it aside — the same tag test the progress above used.
    children: children
      .slice()
      .sort((a, b) => a.created_at - b.created_at)
      .map((child) => ({ ...child, deferred: isDeferredBy(task, child) })),
  }));
  return {
    clusters,
    // Only the deprecated `loops` call pays this duplication, and only until the
    // next release — see the note above.
    ...(options.legacyKey ? { loops: clusters } : {}),
    openCount: activeClusterCount(entries.map((e) => e.task)),
  };
}

export async function handleListReparentTargets(projectRoot: string, params: Record<string, unknown>) {
  return listReparentTargets(projectRoot, optionalString(params, 'exceptTaskId'));
}

// --- Resume Task ---

export async function handleResumeTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const resumeParams: ResumeTaskParams = {
    taskId: requireString(params, 'taskId'),
    modelOverride: optionalString(params, 'modelOverride'),
    effortOverride: optionalString(params, 'effortOverride'),
    actor: optionalActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    onProgress: progress,
  };

  logger.info(`Resuming task ${resumeParams.taskId.substring(0, 8)}`);
  return resumeTask(projectRoot, resumeParams);
}

// --- Sync Task ---

export async function handleSyncTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const syncParams: SyncTaskParams = {
    taskId: requireString(params, 'taskId'),
    actor: optionalActorInput(params),
    usagePauseOverrideEligible: params.usagePauseOverrideEligible === true,
    // Only the MCP boundary sets this, from the authenticated per-task context —
    // it is what lets a task's own running agent sync itself (see self-sync.ts).
    callerTaskId: optionalString(params, 'callerTaskId'),
    onProgress: progress,
  };
  // An explicit sync lifts a pinned base — unless an agent is asking (see liftPin).
  syncParams.liftPin = actorRole(syncParams.actor) !== 'agent';

  return syncTask(projectRoot, syncParams);
}

// --- Reparent Task ---

export async function handleReparentTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const reparentParams: ReparentTaskParams = {
    taskId: requireString(params, 'taskId'),
    parent: requireString(params, 'parent'),
    actor: optionalActorInput(params),
    onProgress: progress,
  };

  return reparentTask(projectRoot, reparentParams);
}

export async function handleLinkTask(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  const linkParams: LinkTaskParams = {
    ref: requireString(params, 'ref'),
    parent: optionalString(params, 'parent'),
    code: optionalString(params, 'code'),
    actor: optionalActorInput(params),
    onProgress: progress,
  };
  return linkTask(projectRoot, linkParams);
}

// --- Describe Linked Task ---

export async function handleDescribeLinkedTask(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const { describeLinkedTask } = await import('./link-describe');
  return describeLinkedTask(projectRoot, {
    taskId: requireString(params, 'taskId'),
    force: params.force === true,
    actor: optionalActorInput(params),
    onProgress: progress,
  });
}

// --- Get Daemon MCP Config ---

export async function handleGetDaemonMcpConfig(projectRoot: string, params: Record<string, unknown>) {
  // Fallback label for a caller that supplied none. Random, not a clock reading:
  // the label IS the MCP identity key, so two callers landing in the same
  // millisecond would share a token and the first to revoke would take the
  // other's tools away. `lazy builder` always passes its own `builder-<id>`.
  const name = optionalString(params, 'name') || `builder-${randomUUID().split('-')[0]}`;
  // The caller's own pid, when it sent one. `lazy builder` runs on the host
  // beside the daemon, so this is a pid the daemon can test with kill(pid, 0) —
  // it is what keeps a LIVE builder's token from being evicted by the registry's
  // builder cap. Validated here because this is the external surface: a
  // nonsense pid would silently make a live session look dead (or, worse,
  // resolve to some unrelated process) instead of being refused.
  const ownerPid = optionalNumber(params, 'ownerPid');
  if (ownerPid !== undefined && (!Number.isInteger(ownerPid) || ownerPid <= 0)) {
    throw new RpcError(400, `ownerPid must be a positive integer, got ${ownerPid}`);
  }
  try {
    // Builder identity: no task id. A builder token is refused on any
    // task-scoped MCP claim, and a task token is refused on the builder
    // surface — see src/daemon/mcp-tokens.ts.
    const configPath = await writeDaemonMcpConfig(projectRoot, name, { kind: 'builder' }, { ownerPid });
    return { configPath };
  } catch (err) {
    // Safety net: if writeDaemonMcpConfig hits an uninitialized daemon
    // context (web bind failed on startup), surface a 503 with a clear,
    // actionable message instead of the opaque "Daemon context not
    // initialized" internal error. Post-fix, startDaemonServer refuses to
    // start without a web port, so this path should only trigger for a
    // daemon built before the fix — but we keep the safety net in case a
    // future change reintroduces a partial-startup state.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Daemon context not initialized')) {
      throw new RpcError(
        503,
        'Daemon running in degraded mode: web port not bound. ' +
        'Restart the daemon after freeing the port: lazy daemon restart',
      );
    }
    throw err;
  }
}

/**
 * Revoke the MCP token minted for one builder session.
 *
 * The counterpart to handleGetDaemonMcpConfig: `lazy builder` asks for a config
 * before launching the builder container and calls this once the builder
 * supervisor has exited. Revocation MUST happen in the daemon process rather
 * than by editing the registry file from the CLI — the daemon caches the
 * registry in memory and only re-reads it on a token MISS, so a file edited
 * behind its back would leave the revoked token still accepted.
 */
export async function handleRevokeDaemonMcpToken(projectRoot: string, params: Record<string, unknown>) {
  const name = requireString(params, 'name');
  const revoked = await revokeBuilderMcpToken(projectRoot, name);
  // The builder's placeholder credential has the same lifetime as its MCP
  // token — both are minted for one session and are worthless after it. Keyed
  // by the same session name, so the two registries stay in step.
  //
  // Independently guarded: the MCP token is already revoked by the line above,
  // and reporting THAT as failed would make the caller retry a revocation that
  // succeeded — or worse, treat a revoked token as still live. A grant that
  // outlives its session is bounded anyway (the registry cap evicts it), so a
  // loud log is the right cost here.
  try {
    await revokeBuilderCredentialGrant(projectRoot, name);
  } catch (err) {
    logger.warn(
      `[proxy] failed to revoke the builder credential grant for "${name}": ` +
      `${err instanceof Error ? err.message : err}. Its MCP token IS revoked. The stale ` +
      `grant is evicted by the registry cap; to clear it now: lazy daemon restart`,
    );
  }
  return { revoked };
}

/**
 * Mint a one-time login ticket for the web dashboard (`lazy dashboard`).
 *
 * Reachable ONLY over `/rpc`, which is the point: `/rpc` accepts the shared
 * daemon token or an actor token and REFUSES agent MCP tokens, so a task
 * container — which holds an MCP token and can reach this port through
 * host.docker.internal — cannot ask for a dashboard credential.
 *
 * Refused outright in managed mode: a managed daemon has no dashboard to sign
 * into, and handing out a ticket that every route would 404 is worse than a
 * clear refusal.
 */
export async function handleMintDashboardTicket(projectRoot: string) {
  if (isManagedMode()) {
    throw new RpcError(
      404,
      'This daemon is managed; use Lazy Teams. The web dashboard is disabled in managed mode.',
    );
  }
  const ticket = await mintDashboardLoginTicket(projectRoot);
  return { ticket, expiresInMs: LOGIN_TICKET_TTL_MS, param: DASHBOARD_LOGIN_PARAM };
}

// --- Identity ---

/**
 * Who this daemon will attribute a write to, and whether it will accept one.
 *
 * THE DAEMON'S ENVIRONMENT IS THE AUTHORITY, which is why this is an RPC and
 * not a local resolution every client repeats: a CLI invoked from another
 * shell, a container or a cron job may see different git config than the
 * process that performs the write. Asking here means the preflight's answer and
 * the write's answer are the same answer.
 */
/**
 * Latest usage-limit reading per credential, as the proxy saw it. The daemon's
 * in-memory view, seeded once from the readings saved to Storage and the
 * bounded audit log, so a restart does not blank it (src/daemon/usage-readings.ts).
 */
export async function handleUsageLimits(
  projectRoot: string,
  caller?: ActorIdentity,
): Promise<{ readings: UsageLimitReading[] }> {
  // Every member's readings (user ids, tasks, utilization) — control-plane
  // only, like listUserCredentials. The in-process fallback passes no caller.
  if (caller) requireControlActor(caller, 'usageLimits');
  const config = await loadConfig(projectRoot);
  await seedUsageReadings(projectRoot, config);
  return { readings: daemonUsageLimits.readings() };
}

/**
 * The [usage_pause] state: configured thresholds, the one-shot override, every
 * credential currently paused or armed without a reading, and every task whose
 * launch the pause is holding. `taskId` adds that task's own verdict — the
 * CLI's pre-flight before it opens an editor — judged on `agentId` when the
 * command switches agents.
 *
 * Actions:
 *  - `set` / `reset` change the one-shot override (`value`: a percent 0–100, or
 *    `off` = no pause, for the next paused launch it lets through). `set` is
 *    refused unless the caller's channel is `human`: the override is the
 *    person's escape hatch, and the builder or an agent that could set it could
 *    talk its way past every pause (src/daemon/usage-pause.ts). The CLI adds a
 *    real-terminal requirement on top (src/cli/commands/daemon-config.ts).
 *  - `admitOneshot` admits one CLI one-shot command (`lazy report`, `lazy ask`
 *    on a stored conversation), judged once before its first call.
 *  - `admitInteractive` admits one interactive session a person opens — `lazy
 *    pair` (`surface: 'pair'`, on `taskId`'s credential, or the builder role's
 *    when there is no task) or `lazy chat` (`surface: 'chat'`, which runs on the
 *    builder role). Judged once, like a start; a relaunch of the same session
 *    after a daemon restart is not judged again, as a running turn never is.
 *
 * Both admissions are judged on the `actor` the client names — only a `human`
 * one may use the override, and none at all never does.
 *
 * Control-plane only when a caller is named, like usageLimits: on a managed
 * host the paused list names every member's credential.
 */
export async function handleUsagePause(
  projectRoot: string,
  params: Record<string, unknown>,
  caller?: ActorIdentity,
): Promise<UsagePauseState> {
  if (caller) requireControlActor(caller, 'usagePause');
  const action = optionalEnum(
    params, 'action', ['get', 'set', 'reset', 'admitOneshot', 'admitInteractive'] as const,
  ) ?? 'get';
  const actor = optionalActorInput(params);
  if (action === 'reset') setUsagePauseOverride(null);
  if (action === 'set') {
    if (!mayUseUsagePauseOverride(actor)) {
      throw new RpcError(
        403,
        `The one-shot ${USAGE_PAUSE_OVERRIDE_KEY} override was not set: it is the human's escape hatch ` +
          `from [usage_pause], and this request came from ${actorRole(actor) ? `the '${actorRole(actor)}' channel` : 'no named channel'}. ` +
          `Only a person, at their own terminal, can set it.`,
      );
    }
    setUsagePauseOverride(parseUsagePauseOverride(params.value));
  }
  const oneshotAllowance = action === 'admitOneshot'
    ? await admitOneshotCommand(projectRoot, actor)
    : undefined;
  const taskId = optionalString(params, 'taskId');
  const agentId = optionalString(params, 'agentId');
  const storage = await getOrCreateStorage();
  if (action === 'admitInteractive') {
    await admitInteractiveSession(projectRoot, storage, {
      surface: requireEnum(params, 'surface', ['pair', 'chat'] as const),
      taskId,
      actor,
      peek: optionalBoolean(params, 'peek'),
    });
  }
  // The CLI pre-flight judges as its launch will: a caller that may not take
  // the override (usagePauseOverrideEligible: false) is judged without it.
  const judge = { overrideEligible: params.usagePauseOverrideEligible !== false };
  const state = await describeUsagePauseState(projectRoot, storage, taskId, agentId, undefined, judge);
  const beside = optionalBoolean(params, 'beside')
    ? await describeBesideLaunch(projectRoot, actorEmail(actor) ?? null, undefined, judge)
    : undefined;
  return { ...state, ...(beside ? { beside } : {}), ...(oneshotAllowance ? { oneshotAllowance } : {}) };
}

export async function handleIdentity(projectRoot: string) {
  return describeIdentity(projectRoot);
}

// --- Actor tokens (the /rpc/* identity registry) ---

/**
 * Mint a token that authenticates `/rpc/*` as a control plane or as one user.
 *
 * Control-plane only, and bootstrapped by the legacy shared token: a fresh
 * install has no actor tokens, so the first caller is by definition whoever
 * holds `~/.lazy/daemon/<slug>/token` — the machine owner, who is exactly the
 * party entitled to hand out access.
 *
 * The returned token is the ONLY time the secret is readable; the registry is
 * never listed back with secrets in it. A caller that loses it rotates.
 */
export async function handleMintActorToken(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  requireControlActor(caller, 'mintActorToken');

  const kind = requireString(params, 'kind');
  if (kind !== 'control' && kind !== 'user') {
    throw new RpcError(400, `kind must be one of: control, user (got '${kind}')`);
  }
  const rotate = optionalBoolean(params, 'rotate');

  if (kind === 'control') {
    // Control tokens have no id of their own, so the label IS the identity:
    // two control clients sharing a label would share a token, and revoking
    // one would silently revoke the other.
    const label = requireNonBlankString(params, 'label');
    const token = await mintDaemonToken(projectRoot, { kind: 'control' }, label, { rotate });
    logger.info(`Minted control actor token '${label}'${rotate ? ' (rotated)' : ''}`);
    return { token, kind, label };
  }

  // OUTSIDE MANAGED MODE THERE IS NO USER TO MINT FOR. Identity on a laptop is
  // the daemon's environment (src/identity/), and `/rpc/*` refuses user-kind
  // tokens there (see resolveRpcActor). Minting one anyway would leave a second
  // way for identity to arrive with nobody ever exercising it — a token that
  // authenticates nothing, handed out as if it did.
  if (!isManagedMode()) {
    throw new RpcError(
      400,
      'Refusing to mint a user token: this daemon is not in managed mode, so /rpc/* accepts the daemon token only ' +
      'and identity comes from the daemon\'s own git config (git config user.email / user.name). ' +
      'Per-user tokens exist for a control plane that authenticates people; there is none here.',
    );
  }

  // A USER TOKEN NAMES A PERSON THE WAY THE STORE DOES: an email, plus the
  // display name to render beside it. Both by name, and the pair is what every
  // row this token writes carries (see pinActor).
  //
  // The pre-identity spelling was `(userId, label)` — an opaque control-plane
  // id and a free-text token name — and it is refused rather than mapped: the
  // two were in practice passed INVERTED (the member's address as the label),
  // so accepting them would persist a person who does not exist. A control
  // plane on the old spelling gets told which field replaced which.
  if (params.userId !== undefined || params.label !== undefined) {
    throw new RpcError(
      400,
      "mintActorToken no longer takes 'userId'/'label' for a user token: a person is named by email. " +
      "Pass 'email' (the member's address, which lands in actor_email on every row this token writes) " +
      "and optionally 'name' (their display name, which lands in actor_name).",
    );
  }
  // CANONICALISE BEFORE VALIDATING, AND STORE WHAT WAS VALIDATED. `isPersonEmail`
  // trims internally, so a padded or mixed-case address passes the check; keying
  // the registry on the raw string would then file this person under a spelling
  // that a later revoke, the credential registry (which trims its own key) and
  // every attributed row would each fail to match. See canonicalPersonEmail.
  const email = canonicalPersonEmail(requireNonBlankString(params, 'email'));
  if (!isPersonEmail(email)) {
    throw new RpcError(
      400,
      `Refusing to mint a user token for '${email}': a user token names a person by email address, and every row ` +
      `it writes promises one (docs/design/actor-identity-and-remote-clients.md §3.8). An opaque control-plane ` +
      `id is not an identity this store can resolve to anybody.`,
    );
  }
  const name = optionalString(params, 'name');
  // The registry's own `label` is a session name for logs and eviction order,
  // never a claim about a person — so it is derived, not taken from a caller.
  const token = await mintDaemonToken(
    projectRoot,
    { kind: 'user', email, ...(name ? { name } : {}) },
    name ? `${name} <${email}>` : email,
    { rotate },
  );
  logger.info(`Minted user actor token for ${name ? `${name} <${email}>` : email}${rotate ? ' (rotated)' : ''}`);
  return { token, kind, email, ...(name ? { name } : {}) };
}

/**
 * Revoke actor tokens, by user, by control label, or by the secret itself.
 *
 * Control-plane only, and deliberately unable to touch task/builder MCP
 * tokens: those belong to agent sessions and are revoked by the lifecycle that
 * owns them (accept/reject/close, builder exit). Letting the control plane
 * revoke one here would strip a running agent of its tools mid-turn.
 */
export async function handleRevokeActorToken(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  requireControlActor(caller, 'revokeActorToken');

  const token = optionalString(params, 'token');
  // Canonicalised with the same rule the mint stores under, or a revoke would
  // miss the token it names on nothing worse than a stray space.
  const rawEmail = optionalString(params, 'email');
  const email = rawEmail === undefined ? undefined : canonicalPersonEmail(rawEmail);
  const label = optionalString(params, 'label');
  // Same rename as the mint, and refused for the same reason: a `userId`
  // selector would silently match nothing now that user tokens key on an
  // address, and "revoked 0" reads exactly like "already gone".
  if (params.userId !== undefined) {
    throw new RpcError(
      400,
      "revokeActorToken no longer takes 'userId': user tokens are keyed by email. Pass 'email' instead.",
    );
  }
  const supplied = [token, email, label].filter(v => v !== undefined && v !== '');
  if (supplied.length !== 1) {
    throw new RpcError(
      400,
      'revokeActorToken takes exactly one of: token (the secret), email (a user token), ' +
      `label (a control token). Got ${supplied.length}.`,
    );
  }

  if (token) {
    // Refuse to revoke by secret unless that secret is an ACTOR token — the
    // agent-token carve-out above, enforced rather than merely documented.
    const identity = await lookupDaemonIdentity(projectRoot, token);
    if (identity && identity.kind !== 'control' && identity.kind !== 'user') {
      throw new RpcError(
        400,
        'That token is an MCP session token, not an actor token. Agent tokens are revoked by the ' +
        'session lifecycle (accept/reject/close, builder exit), not through revokeActorToken.',
      );
    }
    const revoked = await revokeDaemonTokens(projectRoot, { token });
    logger.info(`Revoked ${revoked} actor token(s) by secret`);
    return { revoked };
  }

  const selector = email
    ? ({ kind: 'user', email } as const)
    : ({ kind: 'control', label: label! } as const);
  const revoked = await revokeDaemonTokens(projectRoot, selector);
  logger.info(`Revoked ${revoked} actor token(s) for ${email ? `user ${email}` : `control '${label}'`}`);
  return { revoked };
}

// --- Per-user credentials (docs/design/lazy-teams.md §3.2) ---

/**
 * Store one principal's real Anthropic credential in the daemon.
 *
 * Control-plane only, for the same reason minting is: this decides whose
 * account pays for model traffic. A user token can neither add a credential nor
 * see one — its holder is the subject of this data, not its administrator.
 *
 * The secret goes to `~/.lazy/daemon/<slug>/user-credentials.json` (mode 0600)
 * and never leaves the daemon process again: containers get a session-bound
 * placeholder, and the proxy does the swap.
 */
export async function handlePutUserCredential(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  requireControlActor(caller, 'putUserCredential');

  const userId = requireNonBlankString(params, 'userId');
  const kind = requireNonBlankString(params, 'kind');
  const token = requireNonBlankString(params, 'token');
  const label = optionalString(params, 'label');
  // WHOSE ACCOUNT pays for the project's automations, for the service
  // credential only (§3.3 case 3). A control-plane configuration field, not an
  // actor: it names the identity system-initiated writes are attributed to,
  // which is the daemon's own decision to make from what was configured — the
  // person is never taken from the caller of the write itself.
  const ownerEmail = optionalString(params, 'ownerEmail');
  const ownerName = optionalString(params, 'ownerName');

  if (kind !== 'oauth' && kind !== 'api-key') {
    throw new RpcError(
      400,
      `kind must be 'oauth' (a \`claude setup-token\` token, sent as Authorization: Bearer) ` +
      `or 'api-key' (an Anthropic API key, sent as x-api-key). Got '${kind}'. ` +
      `The kind decides which env var a placeholder for this user is injected into, so it ` +
      `cannot be inferred — a wrong guess produces a refused request, not a working one.`,
    );
  }

  let summary;
  try {
    summary = await putUserCredential(projectRoot, { userId, kind, token, label, ownerEmail, ownerName });
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }

  // Pushing a new credential IS the remedy every "re-authorize" banner names.
  // Clear the dead-token verdict immediately — do not wait for a turn or a
  // timestamp edge case to self-clear it.
  const config = await loadConfig(projectRoot);
  await clearUserAuthRejection(join(projectRoot, config.data.path), userId);

  // Never log the secret, and never log enough to identify it.
  logger.info(`Stored ${summary.kind} credential for user ${summary.userId} (${summary.label})`);
  return summary;
}

/** Remove a principal's stored credential. Their turns stop running. */
export async function handleRevokeUserCredential(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  requireControlActor(caller, 'revokeUserCredential');

  const userId = requireNonBlankString(params, 'userId');
  const revoked = await revokeUserCredential(projectRoot, userId);
  logger.info(
    revoked
      ? `Revoked stored credential for user ${userId}`
      : `No stored credential for user ${userId} to revoke`,
  );
  return { revoked };
}

/**
 * How many recent audit records the per-owner auth verdict looks back over.
 * Same window `lazy doctor` uses for the daemon-wide verdict.
 */
const USER_AUTH_VERDICT_RECORDS = 200;

/**
 * Which principals have a credential stored, and whether each one's token still
 * works. Never returns a secret.
 *
 * The `rejection` field is what makes a dead token visible to a control plane.
 * lazy holds long-lived credentials and does no refresh (docs/per-user-
 * credentials.md), so an expired setup-token presents as every one of that
 * member's turns failing while the credential store cheerfully reports one
 * stored. The proxy already records the upstream 401/403 per request with the
 * owner's id on it; this reads that back, self-clearing the moment a later
 * request of theirs succeeds.
 *
 * A control plane turns this into a per-user "re-authorize your Claude token"
 * prompt — the team-mode counterpart of `lazy doctor`'s daemon-wide hint, which
 * cannot be right here because one member's dead token says nothing about
 * anyone else's.
 */
export async function handleListUserCredentials(projectRoot: string, caller: ActorIdentity) {
  requireControlActor(caller, 'listUserCredentials');

  const credentials = await listUserCredentials(projectRoot);
  const config = await loadConfig(projectRoot);
  const records = await readAuditRecords(join(projectRoot, config.data.path), {
    limit: USER_AUTH_VERDICT_RECORDS,
  });
  const rejections = unresolvedAuthRejectionsByUser(records);

  return {
    credentials: credentials.map((credential) => ({
      ...credential,
      // Only a rejection that postdates the STORED credential is about the
      // credential this listing describes — see rejectionAgainstCurrentCredential.
      rejection: rejectionAgainstCurrentCredential(
        rejections.get(credential.userId),
        credential.updatedAt,
      ),
    })),
  };
}

/**
 * Exercise one principal's stored credential against the upstream, on demand.
 *
 * Control-plane only, like every other credential RPC: the answer names whose
 * credential it is, and a user token's holder is the subject of this data
 * rather than its administrator.
 *
 * A rejected credential is a 200 with `ok: false`, not an RPC error. "We asked
 * and the answer is no" is a successful check — turning it into a failure would
 * make it indistinguishable from "we could not ask", which is the distinction
 * the whole call exists to draw.
 */
export async function handleCheckUserCredential(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  requireControlActor(caller, 'checkUserCredential');

  // Canonicalised here as well as inside the registry, so the verdict and the
  // log line name the key the credential is actually filed under rather than
  // whatever spelling the control plane happened to send.
  const userId = canonicalCredentialKey(requireNonBlankString(params, 'userId'));
  const result = await checkUserCredential(projectRoot, userId);
  // Never log the secret, and never log enough to identify it.
  logger.info(`Credential check for user ${userId}: ${result.outcome}`);
  return result;
}

/**
 * Commands that launch (or relaunch) an agent turn. A turn started through one
 * of these by a user token is billed to that user.
 *
 * The `review*` half is the same mechanism reached under a different name: the
 * web review surface is how a team member actually works, and its commands land
 * on the very same launchers (`reviewUnblock` → launchUnblockTask, `reviewSync`
 * → syncTask, `reviewAsk` / `reviewRetryAsk` → the ask dispatch). Naming only
 * the `…Task` commands here silently put every review-surface turn on the
 * system-initiated branch — spending the project's service account for work a
 * named person asked for, which is the one thing per-user credentials exist to
 * prevent.
 *
 * `accept` is listed for history and for what it may launch again: its retired
 * pre-accept validation ran a real agent turn before the merge, attributed
 * 'system' in the record — lazy's own validation pass — but a named person
 * asked for it by accepting, and it spent a real Anthropic account (left out,
 * a member's accept billed the project's service account, and on a project
 * with no service credential it was refused outright). The mechanical gate
 * that replaced it runs no agent and no turn, so the entry is inert today —
 * kept because an accept path that launches a turn again must not silently
 * fall back to the service account.
 *
 * `rejectTask`/`closeTask` stay out: they end a task without running a turn. So
 * does `reviewPostComment` — a comment launches nothing; the turn that later
 * delivers it is started by the daemon's own auto-deliver, which is
 * system-initiated by design (see turn-credentials.ts). The first ask used to
 * ride that same command with `intent: 'ask'`, which is why it is a sibling
 * command (`reviewAsk`) rather than an intent on a store-write: this set is
 * command-name-only, so a dual-purpose command cannot be in it.
 * `reviewPostComment` refuses `intent: 'ask'` — a leftover launch there would
 * spend without a turn owner.
 */
export const TURN_LAUNCHING_COMMANDS = new Set([
  'startTask',
  'unblockTask',
  'resumeTask',
  'askTask',
  'reviewTask',
  'syncTask',
  'reparentTask',
  'acceptTask',
  'reviewUnblock',
  'reviewSync',
  'reviewAsk',
  'reviewRetryAsk',
  'reviewAccept',
]);

/**
 * The person behind a turn-launching call, or null when there is none.
 *
 * ONE resolution, and the same two sources `applyCallerActor` stamps a row
 * from, in the same order — a turn and the rows it produces must not disagree
 * about who is acting:
 *
 *   A USER TOKEN names the person, and a control plane provisioned them, so
 *   their turn is theirs to pay for (`spendable`).
 *
 *   ON A LAPTOP the person is the daemon's own git config (§3.4). They are the
 *   same human for attribution, and deliberately NOT spendable: the per-user
 *   credential registry was never asked to hold an account under that address,
 *   so billing keeps the answer it has always given (the daemon's own env).
 *
 * In managed mode the git path is not consulted at all, exactly as
 * `applyCallerActor` does not consult it: a control token on a shared host
 * names nobody, and a turn it launches is system-initiated.
 *
 * Never a request field: an unconfigured identity yields null rather than
 * anything a caller could have supplied.
 */
async function turnOwnerForCaller(
  projectRoot: string,
  caller: ActorIdentity,
): Promise<PendingTurnOwner | null> {
  if (caller.kind === 'user') {
    return { email: caller.email, ...(caller.name ? { name: caller.name } : {}), spendable: true };
  }
  if (isManagedMode()) return null;

  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) return null;
  const { email, name } = resolution.identity;
  return { email, ...(name ? { name } : {}), spendable: false };
}

/**
 * The request scope a turn-launching command runs in: its task's UUID (the key
 * every launch path reads the owner back under) and the person who asked.
 *
 * Best-effort: a task reference that does not resolve is not this function's
 * problem — the handler about to run will produce the real 404, with the error
 * text the caller needs. Failing here would replace that with a worse message.
 * It returns null in that case, and the command runs with no owner.
 */
async function turnOwnerRequest(
  params: Record<string, unknown>,
  owner: PendingTurnOwner,
): Promise<TurnOwnerRequest | null> {
  const ref = typeof params.taskId === 'string' ? params.taskId : null;
  if (!ref) return null;
  try {
    const storage = await getOrCreateStorage();
    const resolved = await storage.resolveTask(ref);
    if (!resolved.task) return null;
    return { taskId: resolved.task.id, owner };
  } catch (err) {
    logger.debug(
      `Could not resolve '${ref}' to name the turn owner: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// --- Get Auth Env ---

/**
 * Return the model auth credential from the DAEMON's environment.
 *
 * The daemon is the single owner of credentials (see credential-gate.ts): it
 * refuses to start without one, so by the time it can answer this RPC it is
 * guaranteed to hold a usable token (or be Ollama-backed, which needs none).
 *
 * Client-side launch paths that spawn their OWN containers — notably
 * `lazy builder`, which the CLI client launches directly rather than through
 * the daemon — must source the credential here instead of from their own
 * `process.env`. The user's interactive shell legitimately has no credential
 * in daemon-only-env deployments; reading the client env would wrongly fail
 * with "Authentication required".
 *
 * Secrets hygiene: the value crosses only the token-authenticated daemon RPC
 * channel (loopback by default) and is never logged.
 */
export async function handleGetAuthEnv(projectRoot: string, params: Record<string, unknown>) {
  // SCHEMA-VALIDATE AT THE BOUNDARY (CLAUDE.md: every external surface parses
  // and confirms its inputs). `proxied` decides whether this call hands back a
  // PLACEHOLDER or the user's real credential, so it is required rather than
  // defaulted: a caller that forgets it is a caller that would silently have
  // received the real token and shipped it into a container. That is the exact
  // forgotten-argument failure this task exists to remove, so it must fail
  // loudly instead of failing open.
  if (typeof params.proxied !== 'boolean') {
    throw new Error(
      'getAuthEnv: the `proxied` parameter is required and must be a boolean. It selects ' +
      'between a placeholder credential and the real one, so there is no safe default. ' +
      'This is a lazy bug — please report it.',
    );
  }
  const proxied = params.proxied === true;
  // `selfCredentialed`: the caller's profile has the `none` credential slot —
  // a local model server, which ignores auth. It still wants a placeholder —
  // that grant is how the proxy authenticates the caller and routes it to that
  // profile's upstream — but minting one over the user's token would be both
  // pointless and, in an all-local project with no Anthropic credential at all,
  // fatal. Validated as a boolean like `proxied`, but optional: absent means
  // "the normal case", which is the safe one.
  if (params.selfCredentialed !== undefined && typeof params.selfCredentialed !== 'boolean') {
    throw new Error(
      'getAuthEnv: the `selfCredentialed` parameter must be a boolean when present. ' +
      'This is a lazy bug — please report it.',
    );
  }
  const selfCredentialed = params.selfCredentialed === true;
  // Returns the bare Anthropic credential from the daemon process env. Callers
  // (resolveAuthEnvFromDaemon) wrap it for their resolved role target, layering
  // the proxy's base URL on top.
  //
  // Reads the daemon process env. Throws an actionable error if absent, but the
  // credential gate makes that practically unreachable for a running daemon.
  //
  // Also returns the daemon's live proxy base URL (with the actual bound port)
  // when the proxy is running, so a CLI-client launch (e.g. `lazy builder`) can
  // fill in a `backend = "proxy"` role that omitted `endpoint` — the client has
  // no daemon context of its own to read the OS-assigned port from.
  //
  // Three things below need the config — the proxy address, the identity's
  // profile name, and the credential that profile bills — so load it at most
  // once, and only if one of them is actually reached.
  let configPromise: Promise<ResolvedConfig> | undefined;
  const config = () => (configPromise ??= loadConfig(projectRoot));

  let proxyBaseUrl: string | undefined;
  const proxyPort = hasDaemonContext() ? getDaemonContext().proxyPort : undefined;
  if (proxyPort) {
    const cfg = await config();
    proxyBaseUrl = proxyBaseUrlForRunner(cfg.runner.type, proxyPort, cfg.proxy.bind);
  }

  // A caller that only needs the address (resolveLiveProxyUrl) says so, and the
  // secret does not cross the socket at all. Same principle as
  // handleGetCredentialState: nothing that merely describes auth moves it.
  if (params.credentials === false) {
    return { authEnvVars: [] as AuthEnvVar[], ...(proxyBaseUrl ? { proxyBaseUrl } : {}) };
  }

  // Parsed BEFORE the credential is resolved, because the identity's profile is
  // what decides which credential this launch bills.
  const profiles = agentProfilesFor(await config());
  const identity = parseLaunchIdentity(params, profiles);

  // A self-credentialed role never touches the daemon's own credential — which
  // is the point: the daemon may not have one, and the gate lets it start
  // anyway precisely because all-local projects do not need it. Every other
  // credential slot the profile names — hosted ollama.com, OpenRouter, a named
  // `work-openai` — resolves from the credential store.
  let real: AuthEnvVar[];
  if (selfCredentialed) {
    real = LOCAL_BACKEND_CREDS;
  } else {
    // The credential comes from the SAME profile the grant routes by. It used to
    // be read off `[models.roles.<role>]` — the role's DEFAULT profile — while
    // routing came from the identity's profile, so a task pinned to a different
    // profile of the same role could be handed one profile's credential and
    // forwarded to another profile's upstream. Today that divergence only picks
    // the placeholder's env-var KEY (the proxy substitutes per route regardless),
    // but two answers to "which credential is this launch on" is a bug waiting
    // for the first caller that reads the wrong one.
    //
    // An identity is present exactly when the caller sent role+label, which is
    // also the only way the old role hint was reached — so this replaces that
    // path rather than adding a second one.
    const fromProfile = identity
      ? await resolveProfileLaunchCreds(
        projectRoot,
        roleTargetForProfile(agentProfileOrThrow(profiles, identity.profile)),
      )
      : null;
    // null means "the profile bills Anthropic", whose source on THIS path is the
    // daemon's own process env — the reason this RPC exists.
    real = fromProfile ?? getAuthEnvVars();
  }

  // JIT CREDENTIALS: a launch whose traffic will flow through lazy's proxy gets
  // per-launch PLACEHOLDERS, and the proxy swaps the real value back in just
  // before forwarding. The client decides `proxied` — it resolved the role
  // target and is the only side that knows whether the address actually points
  // at this daemon's proxy (see resolveAuthEnvFromDaemon).
  if (proxied) {
    if (!identity) {
      // Fail loud rather than fall back to the real credential: a launch path
      // that forgot its identity would otherwise quietly keep shipping the
      // user's token into a container, which is the whole thing this prevents.
      throw new Error(
        'getAuthEnv: proxied launches must identify themselves (role, label) so a ' +
        'placeholder credential can be minted for them. This is a lazy bug — please report it.',
      );
    }
    if (proxyPort) {
      return {
        authEnvVars: await placeholderizeAuthEnv(projectRoot, real, identity),
        ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
      };
    }
    // No proxy bound: hand back the real credential and let the client's
    // fail-loud gate refuse the launch. Minting here would produce a
    // placeholder nothing can exchange.
  }

  // Omit proxyBaseUrl entirely when the port is not yet bound — don't send an
  // `undefined` field over the wire. The client treats its absence as a failure
  // to resolve the audit plane, not as permission to connect direct.
  return { authEnvVars: real, ...(proxyBaseUrl ? { proxyBaseUrl } : {}) };
}

/**
 * Fresh model/proxy launch environment for a TASK container relaunching its
 * agent in place — the retry path in src/supervisor/work.ts.
 *
 * WHY A ROUTE AND NOT THE `getAuthEnv` RPC. A task supervisor runs inside the
 * container, and `tryRpc` reaches the daemon only through the host-side port
 * marker and token files (`DaemonClient.create`), which are deliberately not
 * mounted into a task container. So every in-container refresh failed with
 * "Daemon is not running" — against a daemon that was serving the whole time —
 * and turned a retryable failure into a fatal one whose message named the wrong
 * cause. The container's one credential for calling home is its per-task MCP
 * token, which is exactly what this route authenticates, the same way the
 * builder's own refresh route does.
 *
 * The TOKEN names the task. Nothing about which task's credentials are minted
 * comes from the request body, so a container cannot refresh into another
 * task's grant — the identity is evidence, as everywhere else on this surface.
 *
 * What comes back is what the launch assembly would have produced for this
 * task's own agent profile: the live proxy address plus a fresh per-launch
 * placeholder, in the env-var shape the configured runner uses.
 */
export async function handleGetAgentLaunchEnv(
  projectRoot: string,
  presentedToken: string,
): Promise<{ authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string; lazyVersion: string }> {
  const identity = await lookupDaemonIdentity(projectRoot, presentedToken);
  if (!identity || identity.kind !== 'task') {
    throw new RpcError(
      401,
      'Unauthorized: /agent/launch-env requires a task MCP token. ' +
      'It is minted per task container at launch; restart the task if this persists.',
    );
  }
  // The grant label the original launch used — the container name. Refreshing
  // under a different label would mint a SECOND grant, so it is read back from
  // the token rather than recomputed.
  const label = await lookupDaemonTokenLabel(projectRoot, presentedToken);
  if (!label) {
    throw new RpcError(
      401,
      'Unauthorized: this task MCP token is unknown or revoked. Restart the task.',
    );
  }

  const task = await (await getOrCreateStorage()).getTask(identity.taskId);
  if (!task) {
    throw new RpcError(404, `Task ${shortId(identity.taskId)} no longer exists.`);
  }

  const config = await loadConfig(projectRoot);
  // The task's PROFILE decides the upstream, the credential slot and the
  // routing key on the minted grant — the same resolution the launch made, so
  // the refreshed environment lands on the same upstream it started on.
  const profile = profileForAgentName(config, task.agent_id, `task ${displayId(task)}`);
  const target = roleTargetForProfile(profile);
  const selfCredentialed = usesSyntheticCreds(target);

  const authResult = await handleGetAuthEnv(projectRoot, {
    proxied: true,
    role: 'agent',
    label,
    taskId: task.id,
    profile: profile.name,
    ...(selfCredentialed ? { selfCredentialed: true } : {}),
  }) as { authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string };

  let proxyUrl = authResult.proxyBaseUrl;
  if (!proxyUrl && hasDaemonContext() && getDaemonContext().proxyPort) {
    proxyUrl = proxyBaseUrlForRunner(
      config.runner.type,
      getDaemonContext().proxyPort!,
      config.proxy.bind,
    );
  }
  if (!proxyUrl && !selfCredentialed) {
    throw new RpcError(
      503,
      'The daemon proxy is not running, so this task cannot refresh its launch environment. ' +
      'Check `lazy daemon status` and retry.',
    );
  }

  // Surface follows the configured runner, exactly as the launch did: a
  // container is handed the proxy's `host.docker.internal` spelling, a host
  // process its loopback one.
  const surface: LaunchSurface =
    config.runner.type === 'docker' || config.runner.type === 'podman' ? 'container' : 'host';

  const authEnvVars = targetEnvVars(
    proxyUrl ? { ...target, proxyUrl, primaryUpstream: config.proxy.upstream } : target,
    authResult.authEnvVars,
    surface,
    { role: 'agent', taskId: task.id },
  );

  return {
    authEnvVars,
    ...(proxyUrl ? { proxyBaseUrl: proxyUrl } : {}),
    lazyVersion: VERSION,
  };
}

/**
 * Fresh model/proxy launch environment for a builder container relaunching Claude
 * Code in place after a daemon restart or upgrade.
 *
 * Authenticated like POST /builder/storage — builder-kind MCP token only. Returns
 * the same env vars `docker run` would have passed at initial launch, with the
 * daemon's LIVE proxy address substituted for the stale one baked in at
 * container start.
 */
export async function handleGetBuilderLaunchEnv(
  projectRoot: string,
  presentedToken: string,
): Promise<{ authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string; lazyVersion: string }> {
  const identity = await lookupDaemonIdentity(projectRoot, presentedToken);
  if (!identity || identity.kind !== 'builder') {
    throw new RpcError(
      401,
      'Unauthorized: /builder/launch-env requires a builder-session MCP token. ' +
      'Relaunch the builder to obtain a fresh one if this persists.',
    );
  }
  const label = await lookupDaemonTokenLabel(projectRoot, presentedToken);
  if (!label) {
    throw new RpcError(
      401,
      'Unauthorized: builder MCP token is unknown or revoked. Relaunch the builder.',
    );
  }

  const config = await loadConfig(projectRoot);
  const target = resolveRoleTarget('builder', config);

  // The builder has no task and therefore no task-level agent: the profile its
  // relaunch is routed by is the one the builder ROLE defaults to — the same
  // one `docker run` used at initial launch, so the refreshed environment lands
  // on the same upstream with the same credential.
  const authResult = await handleGetAuthEnv(projectRoot, {
    proxied: true,
    role: 'builder',
    label,
    taskId: null,
    profile: target.profile,
  }) as { authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string };
  let proxyUrl = authResult.proxyBaseUrl;
  if (!proxyUrl && hasDaemonContext() && getDaemonContext().proxyPort) {
    proxyUrl = proxyBaseUrlForRunner(
      config.runner.type,
      getDaemonContext().proxyPort!,
      config.proxy.bind,
    );
  }
  if (!proxyUrl && !usesSyntheticCreds(target)) {
    throw new RpcError(
      503,
      'The daemon proxy is not running, so this builder cannot refresh its launch environment. ' +
      'Check `lazy daemon status` and retry.',
    );
  }

  const authEnvVars = targetEnvVars(
    proxyUrl ? { ...target, proxyUrl, primaryUpstream: config.proxy.upstream } : target,
    authResult.authEnvVars,
    'container',
  );

  return {
    authEnvVars,
    ...(proxyUrl ? { proxyBaseUrl: proxyUrl } : {}),
    lazyVersion: VERSION,
  };
}

interface AuthEnvVar { key: string; value: string }

/**
 * Parse the launch identity a proxied caller must send, or null if absent.
 *
 * Validated at the boundary (CLAUDE.md): the identity is what the minted grant
 * binds attribution AND ROUTING to, so a malformed one would produce audit
 * records naming a task that does not exist, or send a turn's traffic to an
 * upstream nobody chose. Rejected loudly rather than coerced.
 *
 * `profile` is required of any caller that describes an identity at all —
 * defaulting it would silently route, say, a codex launch to the primary
 * Anthropic upstream and surface as an unexplained wire error deep in a turn.
 * The only client that can omit it is one older than profiles, and telling that
 * caller to upgrade is the actionable answer.
 *
 * ...and it must NAME a profile this project actually configures. "Non-empty"
 * is not enough: the proxy routes by looking the grant's profile up in its route
 * table, and a name that is not there is indistinguishable from a legacy grant
 * carrying no profile at all — both forward to the PRIMARY upstream. So a typo
 * would not fail the launch, it would quietly bill an Anthropic turn for work
 * the user pointed at a local server. Refused here, where the bad name is still
 * attributable to the caller that sent it.
 */
function parseLaunchIdentity(
  params: Record<string, unknown>,
  profiles: Map<string, AgentProfile>,
): LaunchIdentity | null {
  const role = params.role;
  const label = params.label;
  if (role === undefined && label === undefined) return null;
  if (role !== 'agent' && role !== 'builder') {
    throw new Error(`getAuthEnv: role must be "agent" or "builder", got ${JSON.stringify(role)}`);
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('getAuthEnv: label must be a non-empty string identifying the launch');
  }
  const taskId = params.taskId;
  if (taskId !== undefined && taskId !== null && typeof taskId !== 'string') {
    throw new Error(`getAuthEnv: taskId must be a string or null, got ${JSON.stringify(taskId)}`);
  }
  const profile = params.profile;
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new Error(
      'getAuthEnv: profile must be a non-empty agent profile name — it decides which upstream ' +
      'this launch is forwarded to. A client that sends none predates agent profiles; ' +
      'run `lazy upgrade` so the CLI and the daemon are the same version.',
    );
  }
  agentProfileOrThrow(profiles, profile, 'the launch identity for this turn');
  return { role, label, profile, taskId: (taskId as string | null | undefined) ?? null };
}

// --- Run One-shot ---

/**
 * Run a machine one-shot inside the daemon, through the project's Runner.
 *
 * This is the ONE place a one-shot executes for a CLI caller. The daemon holds
 * the credential and runs the audit/policy proxy, so routing `lazy ask`,
 * `lazy report` and memory compaction through here fixes their auth by
 * construction and puts their traffic on the audit plane — neither of which a
 * CLI-side `claude -p` had. See docs/oneshot-execution.md.
 *
 * The isolation (no repo mount, or a read-only one; write tools disallowed
 * unconditionally; a bounded run) is the Runner's, not this handler's — this
 * handler only validates what came over the wire.
 *
 * Deliberately CLI-only: no MCP tool exposes it (docs/surface-asymmetries.md).
 */
export async function handleRunOneshot(projectRoot: string, params: Record<string, unknown>) {
  const prompt = requireNonBlankString(params, 'prompt');
  const model = optionalString(params, 'model');
  const repoAccess = optionalEnum(params, 'repoAccess', ['none', 'read-only'] as const);
  const timeoutMs = optionalNumber(params, 'timeoutMs');
  const taskId = optionalString(params, 'taskId');
  // OPTIONAL over the wire although `OneshotRequest.effort` is required in the
  // type: within one lazy version every call site names its kind's effort at
  // compile time, but an older CLI RPCing a newer daemon sends params that
  // predate the field. A BAD value is still rejected loudly — silently
  // downgrading a typo to the default is how a one-shot ends up running at an
  // effort nobody chose.
  const effort = optionalEnum(params, 'effort', VALID_EFFORT_LEVELS) ?? DEFAULT_ONESHOT_EFFORT;

  if (timeoutMs !== undefined && timeoutMs < 0) {
    throw new RpcError(400, `timeoutMs must be >= 0 (0 means unbounded), got ${timeoutMs}`);
  }

  // [usage_pause]: a one-shot spends the builder role's credential, so a paused
  // credential REFUSES it before anything runs. Judged on the channel the call
  // names: only a person's may take their one-shot override, and a call naming
  // none is nobody's. A command of many calls is
  // judged ONCE: its client admits it first (`usagePause` action
  // `admitOneshot`) and every call carries the allowance, which skips the gate
  // (see admitOneshotCommand). A call without one — an older CLI — is judged on
  // its own.
  if (!oneshotAllowanceValid(optionalString(params, 'usagePauseAllowance'))) {
    await assertBesideLaunchAllowed(projectRoot, {
      config: await loadConfig(projectRoot),
      actor: optionalActorInput(params),
      what: 'a one-shot model run',
    });
  }

  const { runOneshotWithRunner } = await import('../oneshot');
  return runOneshotWithRunner({ prompt, model, effort, repoAccess, timeoutMs, taskId }, projectRoot);
}

// --- Get Credential State ---

/**
 * Report WHICH credentials this project's agent profiles bill and WHETHER the
 * daemon holds each one, with where it found it — never a credential itself.
 *
 * Diagnostics (`lazy doctor`) need to answer "does lazy have the credentials it
 * needs?", and the only environment that matters is the DAEMON's: it is the
 * single owner (credential-gate.ts) and every agent it launches inherits its
 * env. Reading the CLI's own `process.env` answers a different question and
 * gets it wrong in both directions — a daemon-only-env deployment reads as "not
 * authenticated" while everything works, and a stale token in the user's shell
 * reads as healthy auth the daemon does not have.
 *
 * PER CREDENTIAL, over every CONFIGURED profile (`requiredCredentials`): the
 * role defaults plus every `[agents.<name>]` block. That is deliberately wider
 * than the startup gate, which reads the role defaults only — a declared profile
 * nobody runs must not refuse a daemon, but a task that selects it will refuse
 * to launch without its credential, and this report is where a user learns
 * that first. Each entry names the profiles billing it, so the line doctor
 * prints says who is affected.
 *
 * ONE BAD READ DEGRADES ONE ENTRY. Presence comes from the store's non-secret
 * index and (for harness-keyed credentials) the agent key file; either can
 * exist and be unreadable. That failure lands on THAT credential's entry as
 * `error`, verbatim, and every other entry is still answered — an RPC that
 * threw would turn "one corrupt file" into "doctor cannot say anything about
 * credentials", which is exactly when it is being asked.
 *
 * Deliberately NOT `getAuthEnv`: that ships the actual token to the client,
 * which is correct for a launch that must inject it and wrong for a report that
 * only needs booleans and labels. Nothing that merely describes auth should
 * move the secret: `via` is an env var NAME, a backend id or a file path.
 *
 * PRESENCE, NOT VALIDITY — same contract as the gate. "Upstream accepts this
 * credential" is a separate question answered from the audit trail (see
 * `checkCredentialAccepted` in doctor).
 */
export async function handleGetCredentialState(projectRoot: string, _params: Record<string, unknown>) {
  const config = await loadConfig(projectRoot);
  const source = credentialFromEnv();
  const profiles = agentProfilesFor(config);

  const providers: DaemonCredentialEntry[] = [];
  for (const required of requiredCredentials(config)) {
    const entry = {
      name: required.name,
      label: credentialLabel(required.name),
      requiredBy: required.requiredBy,
    };
    // Which harnesses bill it decides whether the agent key file is consulted;
    // every name in requiredBy resolved at config load, so this cannot miss.
    const harnesses = required.requiredBy.map((name) => agentProfileOrThrow(profiles, name).harness);
    try {
      providers.push({ ...entry, ...(await locateProfileCredential(projectRoot, required.name, harnesses)) });
    } catch (err) {
      providers.push({
        ...entry,
        present: false,
        source: null,
        via: null,
        kind: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    // The Anthropic-only answer, kept for a client older than `providers`.
    present: source !== null,
    // The env var NAME (e.g. CLAUDE_CODE_OAUTH_TOKEN), never its value.
    source,
    // Whether an Anthropic token is needed by the ROLE DEFAULTS — the gate's
    // scope, read through the same `requiredProviders` the credential gate
    // starts the daemon by, so this flag and the gate cannot disagree.
    anthropicRequired: requiredProviders(config).includes('anthropic'),
    providers,
  };
}

// --- Comment identity / edit helpers (boundary validation) ---

function parseRpcExternal(value: unknown, field: string): CommentExternalRef | undefined {
  try {
    return parseCommentExternalRef(value, field);
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}

function parseCommentCreateOptions(value: unknown): CommentCreateOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RpcError(400, 'options must be an object');
  const o = value as Record<string, unknown>;
  const external = parseRpcExternal(o.external, 'options.external');
  if (o.revises_comment_id !== undefined && typeof o.revises_comment_id !== 'string') {
    throw new RpcError(400, 'options.revises_comment_id must be a string');
  }
  return {
    ...(external ? { external } : {}),
    ...(o.revises_comment_id ? { revises_comment_id: o.revises_comment_id as string } : {}),
  };
}

async function editCommentOrRpcError(
  storage: Storage,
  taskId: string,
  commentId: string,
  content: string,
  external?: CommentExternalRef,
  editor?: ActorInput,
) {
  try {
    return await editUnseenComment(storage, taskId, commentId, content, {
      ...(external ? { external } : {}),
      ...(editor ? { editor } : {}),
    });
  } catch (err) {
    if (err instanceof CommentAlreadySeenError) throw new RpcError(409, err.message);
    if (err instanceof CommentNotFoundError) throw new RpcError(404, err.message);
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * `editComment` — the human surfaces' edit (CLI, dashboard, Teams). Refuses
 * with 409 and the reason when the agent has already seen the comment.
 */
export async function handleEditComment(_projectRoot: string, params: Record<string, unknown>) {
  const taskRef = requireString(params, 'taskId');
  const commentId = requireString(params, 'commentId');
  const content = requireString(params, 'content');
  const storage = await getOrCreateStorage();
  const { task } = await storage.resolveTask(taskRef);
  if (!task) throw new RpcError(404, `Task not found (or ambiguous): ${taskRef}`);
  // `actor` is pinned from a per-user token by applyCallerActor, so a Teams
  // member's edit is attributed to that member, never to the comment's author.
  const comment = await editCommentOrRpcError(storage, task.id, commentId, content, undefined, params.actor as ActorInput | undefined);
  return { comment };
}

// --- Storage proxy ---

/**
 * All Storage methods that can be called via RPC.
 * Each entry maps the method name to a function that extracts args and calls storage.
 */
// Exported so BUILDER_STORAGE_METHODS can be checked against it: an allowlist
// entry that names a method this map does not have would 403 on the builder
// surface and 404 on the full one, i.e. fail at runtime instead of at test time.
export const STORAGE_METHODS: Record<string, (storage: Storage, args: Record<string, unknown>) => Promise<unknown> | unknown> = {
  // Path accessors (synchronous)
  getStoragePath: (s) => s.getStoragePath(),
  getTaskDir: (s, a) => s.getTaskDir(a.taskId as string),

  // Tasks
  createTask: (s, a) => s.createTask(
    a.goal as string,
    a.parentTaskId as string | undefined,
    a.branchedFromSha as string | undefined,
    a.code as string | undefined,
    a.type as string | undefined,
    a.agentId as string | undefined,
    a.actor as Actor | undefined,
  ),
  getTask: (s, a) => s.getTask(a.taskId as string),
  resolveTask: (s, a) => s.resolveTask(a.input as string),
  listTasks: (s) => s.listTasks(),
  listTasksWithOptions: (s, a) => s.listTasksWithOptions(a.options as any),
  listTaskCodes: (s) => s.listTaskCodes(),
  countDescendants: (s, a) => s.countDescendants(a.taskIds as string[]),
  updateTaskStatus: (s, a) => s.updateTaskStatus(a.taskId as string, a.status as any, a.actor as any),
  updateTaskGoal: (s, a) => s.updateTaskGoal(a.taskId as string, a.goal as string),
  updateTaskCode: (s, a) => s.updateTaskCode(a.taskId as string, a.code as string | null),
  updateTaskTarget: (s, a) => s.updateTaskTarget(a.taskId as string, a.target as TaskTarget),
  updateTaskBranchedFromSha: (s, a) => s.updateTaskBranchedFromSha(a.taskId as string, a.sha as string),
  updateTaskModel: (s, a) => s.updateTaskModel(a.taskId as string, a.model as string),
  updateTaskRunnerType: (s, a) => s.updateTaskRunnerType(a.taskId as string, a.runnerType as RunnerType | null),
  updateTaskAgent: (s, a) => s.updateTaskAgent(a.taskId as string, a.agentId as string),
  updateTaskType: (s, a) => s.updateTaskType(a.taskId as string, a.type as string),
  resetTaskPendingSync: (s, a) => s.resetTaskPendingSync(a.taskId as string),
  incrementTaskPendingSync: (s, a) => s.incrementTaskPendingSync(a.taskId as string),
  abandonTask: (s, a) => s.abandonTask(a.taskId as string, a.reason as string, a.actor as any),
  reopenTask: (s, a) => s.reopenTask(a.taskId as string, a.actor as any),
  updateTaskMetadata: (s, a) => s.updateTaskMetadata(a.taskId as string, a.key as string, a.value as string),
  getTaskMetadata: (s, a) => s.getTaskMetadata(a.taskId as string, a.key as string),
  updateTaskPrompt: (s, a) => s.updateTaskPrompt(a.taskId as string, a.content as string, a.sessionId as string | undefined),
  getPromptHistory: (s, a) => s.getPromptHistory(a.taskId as string),
  getPromptVersion: (s, a) => s.getPromptVersion(a.taskId as string, a.version as number),

  // Sessions
  createSession: (s, a) => s.createSession(
    a.taskId as string,
    a.agentId as string,
    a.gitBranch as string,
    a.gitStartSha as string,
    a.claudeSessionId as string | undefined,
  ),
  getSession: (s, a) => s.getSession(a.sessionId as string),
  getSessionByTaskId: (s, a) => s.getSessionByTaskId(a.taskId as string),
  listSessions: (s, a) => s.listSessions(a.taskId as string | undefined, a.activeOnly as boolean | undefined),
  endSession: (s, a) => s.endSession(a.sessionId as string, a.outcome as any),
  resetSession: (s, a) => s.resetSession(a.sessionId as string),
  updateSessionClaudeId: (s, a) => s.updateSessionClaudeId(a.sessionId as string, a.claudeSessionId as string),
  updateSessionContainerName: (s, a) => s.updateSessionContainerName(
    a.sessionId as string,
    a.containerName as string | null,
    a.containerAgentId as string | null | undefined,
  ),
  updateSessionRunnerType: (s, a) => s.updateSessionRunnerType(a.sessionId as string, a.runnerType as RunnerType | null),
  // resetAgentSession defaults to true for a pre-profiles client: the old wire
  // shape had no such field and always cleared the session id.
  updateSessionAgent: (s, a) => s.updateSessionAgent(a.sessionId as string, a.agentId as string, a.resetAgentSession !== false),
  updateSessionInteraction: (s, a) => s.updateSessionInteraction(a.sessionId as string, a.durationMs as number),
  updateSessionUsage: (s, a) => s.updateSessionUsage(a.sessionId as string, a.usage as any),
  updateSessionUpstreamMergeSha: (s, a) => s.updateSessionUpstreamMergeSha(a.sessionId as string, a.sha as string),
  markNotesDelivered: (s, a) => s.markNotesDelivered(a.sessionId as string, a.timestamp as number),
  recordInterrupt: (s, a) => s.recordInterrupt(a.sessionId as string, a.diagnostics as any),
  resetConsecutiveInterruptions: (s, a) => s.resetConsecutiveInterruptions(a.sessionId as string),
  setAutoResumed: (s, a) => s.setAutoResumed(a.sessionId as string, a.autoResumed as boolean),
  setUserStopped: (s, a) => s.setUserStopped(a.sessionId as string, a.userStopped as boolean),

  // Turns
  createTurn: (s, a) => s.createTurn(a.options as any),
  getSessionTurns: (s, a) => s.getSessionTurns(a.sessionId as string),
  getNextTurnSequence: (s, a) => s.getNextTurnSequence(a.sessionId as string),
  reserveTurnSequences: (s, a) => s.reserveTurnSequences(a.sessionId as string, a.count as number),
  beginInFlightTurn: (s, a) => s.beginInFlightTurn(a.taskId as string, a.turn as any),
  stampInFlightTurnRun: (s, a) => s.stampInFlightTurnRun(a.taskId as string, a.turnSequence as number, a.run as any),
  settleInFlightTurn: (s, a) => s.settleInFlightTurn(a.taskId as string, a.turnSequence as number, a.outcome as any),
  clearInFlightTurn: (s, a) => s.clearInFlightTurn(a.taskId as string, a.turnSequence as number | undefined),
  getTurnCountByTaskId: (s, a) => s.getTurnCountByTaskId(a.taskId as string),
  updateTurnViolations: (s, a) => s.updateTurnViolations(a.taskId as string, a.turnId as string, a.violations as any),
  updateTurnWrapUpSteps: (s, a) => s.updateTurnWrapUpSteps(a.taskId as string, a.turnId as string, a.wrapUpSteps as string[]),
  updateTurnReview: (s, a) => s.updateTurnReview(a.taskId as string, a.turnId as string, a.review as any),
  markFeedbackConsumed: (s, a) => s.markFeedbackConsumed(a.sessionId as string),

  // Commits
  createCommit: (s, a) => s.createCommit(a.sessionId as string, a.sha as string, a.message as string),
  getSessionCommits: (s, a) => s.getSessionCommits(a.sessionId as string),
  deleteSessionCommits: (s, a) => s.deleteSessionCommits(a.sessionId as string, a.shas as string[]),

  // Reviews
  createReview: (s, a) => s.createReview(a.commitId as string, a.verdict as any, a.rationale as string, a.reviewer as string),
  getCommitReviews: (s, a) => s.getCommitReviews(a.commitId as string),

  // Worktree Snapshots
  createWorktreeSnapshot: (s, a) => s.createWorktreeSnapshot(a.sessionId as string, a.turnSequence as number, a.uncommittedDiff as string, a.gitStatus as string),
  getLatestWorktreeSnapshot: (s, a) => s.getLatestWorktreeSnapshot(a.sessionId as string),
  getWorktreeSnapshotForTurn: (s, a) => s.getWorktreeSnapshotForTurn(a.sessionId as string, a.turnSequence as number),

  // Task Tree
  getChildTasks: (s, a) => s.getChildTasks(a.parentTaskId as string),
  getRootTask: (s, a) => s.getRootTask(a.taskId as string),
  getTaskAncestry: (s, a) => s.getTaskAncestry(a.taskId as string),
  getTaskTree: (s, a) => s.getTaskTree(a.rootTaskId as string),

  // Comments, journal entries and follow-ups all persist a `content: string`
  // the type system calls required, and all three used to read it with a blind
  // `a.content as string`. That asserts to the compiler and checks nothing: a
  // caller that lost its argument (or sent a number, or an object) reached the
  // storage write, where `normalizeRecordContent` coerced it to '' and warned.
  // A coerced-and-logged write is a defective record the human never sees —
  // exactly the family of content-less annotations that later crashed
  // `lazy review` (see src/utils/turn-content.ts). The storage guard stays as
  // the second layer, for internal callers; this is the boundary rejecting a
  // bad request as a 400 that names the field, per the same rule the rest of
  // /rpc follows (src/daemon/rpc-params.ts).

  // Comments
  createComment: (s, a) => s.createComment(a.taskId as string, requireString(a, 'content'), a.actor as any, a.source as any, parseCommentCreateOptions(a.options)),
  // A CONTENT change goes through the unseen-only rule even on this raw path,
  // so no /rpc client can rewrite a comment the agent has already read.
  // Identity-only updates (stamping forge ids) change nothing the agent saw.
  updateComment: (s, a) => {
    const taskId = requireString(a, 'taskId');
    const commentId = requireString(a, 'commentId');
    const update = (a.update ?? {}) as Record<string, unknown>;
    const external = parseRpcExternal(update.external, 'update.external');
    if (update.content !== undefined) {
      if (typeof update.content !== 'string') throw new RpcError(400, 'update.content must be a string');
      return editCommentOrRpcError(s, taskId, commentId, update.content, external, a.actor as ActorInput | undefined);
    }
    if (!external) throw new RpcError(400, 'updateComment needs update.content or update.external');
    return s.updateComment(taskId, commentId, { external });
  },
  getTaskComments: (s, a) => s.getTaskComments(a.taskId as string),

  // Journal (append-only, pull-based side channel — appending never triggers a
  // turn, and entry bodies are never injected into a prompt; only their count is)
  appendJournalEntry: (s, a) => s.appendJournalEntry(a.taskId as string, requireString(a, 'content'), a.actor as any),
  getTaskJournal: (s, a) => s.getTaskJournal(a.taskId as string),

  // DEPRECATED follow-up RPC methods, kept for Lazy Teams until it is ported to
  // raised items. Each is an adapter over the one entity: it creates or reads a
  // NON-BLOCKING raised item and projects the result back into the follow-up
  // shape Teams still renders (src/raised/legacy-view.ts). Delete this block and
  // that module together with the Teams port.
  // Validation is deliberately SYNCHRONOUS, like every other annotation writer:
  // a bad body must refuse before any storage call, not as a rejected promise
  // after one. `requireRaisedCreateInput` keeps the two legacy shapes apart —
  // a bare `content` string and a structured `input` object — so a caller that
  // sends `content: 42` still gets a 400 naming the field rather than reaching
  // storage as a bogus proposal and being coerced to a blank record there.
  createFollowUp: (s, a) => {
    const input = requireRaisedCreateInput(a);
    return s.createRaisedItem(
      a.taskId as string,
      {
        ...input,
        // A follow-up is exactly a non-blocking raised item; the legacy caller
        // has no say in the flag.
        blocking: false,
        session_id: a.sessionId as string | null,
      } as any,
    ).then(toFollowUpView);
  },
  getTaskFollowUps: async (s, a) => {
    const items = await s.getTaskRaisedItems(a.taskId as string);
    return items.filter(i => !i.blocking).map(toFollowUpView);
  },
  triageFollowUp: async (s, a) => {
    const triage = a.triage as { status: 'acknowledged' | 'dismissed'; actor: Actor; note?: string | null };
    const item = await s.resolveRaisedItem(a.taskId as string, a.followUpId as string, {
      action: triage.status === 'dismissed' ? 'dismiss' : 'acknowledge',
      actor: triage.actor,
      // Dismiss requires a reason; Teams' note is optional, so supply the same
      // wording the web surface uses when a reviewer dismisses without typing one.
      response: triage.note ?? (triage.status === 'dismissed' ? 'Dismissed' : null),
    });
    return toFollowUpView(item);
  },
  promoteFollowUp: async (s, a) => {
    const { raised_item, task } = await s.promoteRaisedItem(
      a.taskId as string,
      a.followUpId as string,
      { ...(a.options as any), relation: 'peer' },
    );
    return { follow_up: toFollowUpView(raised_item), task };
  },
  listFollowUps: (s, a) => s.listRaisedItems(a.options as any),

  // Raised items — everything an agent surfaces for human eyes
  createRaisedItem: (s, a) => s.createRaisedItem(
    a.taskId as string,
    requireRaisedCreateInput(a, { requireBlocking: true }) as any,
  ),
  getTaskRaisedItems: (s, a) => s.getTaskRaisedItems(a.taskId as string),
  addRaisedItemComment: (s, a) => s.addRaisedItemComment(
    a.taskId as string,
    a.itemId as string,
    {
      content: requireString(a, 'content'),
      actor: a.actor as ActorInput,
      ...(a.session_id !== undefined ? { session_id: a.session_id as string | null } : {}),
      ...(a.turn_sequence !== undefined ? { turn_sequence: a.turn_sequence as number | null } : {}),
    },
  ),
  resolveRaisedItem: (s, a) => s.resolveRaisedItem(a.taskId as string, a.itemId as string, a.resolution as any),
  unresolveRaisedItem: (s, a) => s.unresolveRaisedItem(a.taskId as string, a.itemId as string, a.actor as any),
  markRaisedItemCommentDelivered: (s, a) => s.markRaisedItemCommentDelivered(
    a.taskId as string,
    a.itemId as string,
    a.extras as { promoted_task_id?: string | null; pending_comment?: string | null; delivered_turn?: number | null } | undefined,
  ),
  setRaisedItemBlocking: (s, a) => s.setRaisedItemBlocking(
    a.taskId as string,
    a.itemId as string,
    a.blocking as boolean,
    a.actor as any,
  ),
  promoteRaisedItem: (s, a) => s.promoteRaisedItem(a.taskId as string, a.itemId as string, a.options as any),
  promoteConversation: (s, a) => s.promoteConversation(a.sessionId as string, a.options as any),
  listRaisedItems: (s, a) => s.listRaisedItems(a.options as any),
  migrateFollowUpsToRaisedItems: (s) => s.migrateFollowUpsToRaisedItems(),
  migrateActorIdentity: (s) => s.migrateActorIdentity(),

  // Turn reports + file decisions (structured-turn-report / present-review-changes)
  upsertTurnReport: (s, a) => s.upsertTurnReport(a.taskId as string, a.input as any),
  getTaskTurnReports: (s, a) => s.getTaskTurnReports(a.taskId as string),
  getTurnReportBySession: (s, a) => s.getTurnReportBySession(a.taskId as string, a.sessionId as string),
  stampTurnReportSequence: (s, a) =>
    s.stampTurnReportSequence(a.taskId as string, a.sessionId as string, a.turnSequence as number),
  upsertFileDecision: (s, a) => s.upsertFileDecision(a.taskId as string, a.input as any),
  getTaskFileDecisions: (s, a) => s.getTaskFileDecisions(a.taskId as string),

  // Task artifacts (named files attached to a task; content base64 in/out).
  // Attaching is passive — like follow-ups, it never triggers a turn.
  createTaskArtifact: (s, a) => s.createTaskArtifact(a.taskId as string, a.input as any, a.actor as any),
  listTaskArtifacts: (s, a) => s.listTaskArtifacts(a.taskId as string),
  getTaskArtifact: (s, a) => s.getTaskArtifact(a.taskId as string, a.name as string),
  deleteTaskArtifact: (s, a) => s.deleteTaskArtifact(a.taskId as string, a.name as string),

  // Review regions (computed cover + the human overlay, kept apart on purpose)
  getRegionCover: (s, a) => s.getRegionCover(a.taskId as string),
  saveRegionCover: (s, a) => s.saveRegionCover(a.taskId as string, a.cover as any),
  getRegionOverlays: (s, a) => s.getRegionOverlays(a.taskId as string),
  setRegionOverlay: (s, a) =>
    s.setRegionOverlay(a.taskId as string, a.unitId as string, a.patch as any),

  // Hunk approvals (per-hunk reviewed state for `lazy browse -i`)
  listHunkApprovals: (s, a) => s.listHunkApprovals(a.taskId as string),
  createHunkApproval: (s, a) => s.createHunkApproval(a.taskId as string, a.hunkHash as string, a.actor as any, a.lineage as any),

  // Review comments (anchored, threaded diff comments)
  createReviewComment: (s, a) => s.createReviewComment(a.taskId as string, a.input as any),
  getTaskReviewComments: (s, a) => s.getTaskReviewComments(a.taskId as string),
  updateReviewComment: (s, a) => s.updateReviewComment(a.taskId as string, a.commentId as string, a.update as any),

  // NOTE: review drafts are deliberately ABSENT from this table. A generic
  // storage call carries no caller identity, so an entry here would take the
  // reviewer key from a request field — letting any authenticated actor read
  // or overwrite another person's unsent words. Drafts reach storage only
  // through the `reviewGetDraft` / `reviewSaveDraft` verbs, which derive the
  // key from the token. See test/unit/review-draft-storage-rpc.test.ts.

  // Review sessions (task-scoped builder review conversations)
  createReviewSession: (s, a) => s.createReviewSession(a.taskId as string),
  getReviewSessionByTaskId: (s, a) => s.getReviewSessionByTaskId(a.taskId as string),
  updateReviewSession: (s, a) => s.updateReviewSession(a.sessionId as string, a.patch as any),
  appendReviewSessionMessage: (s, a) => s.appendReviewSessionMessage(a.sessionId as string, a.message as any),
  updateReviewSessionMessage: (s, a) =>
    s.updateReviewSessionMessage(a.sessionId as string, a.messageId as string, a.patch as any),
  listReviewSessionMessages: (s, a) => s.listReviewSessionMessages(a.sessionId as string),

  // Conversations
  // INVARIANT: capture never shortens a stored conversation. Enforced here, on the
  // daemon side, so EVERY client — the in-container builder capture monitor, the
  // CLI, importers — inherits it without having to remember. See
  // saveConversationWithoutRegression for why a prefix write is always wrong.
  saveConversation: async (s, a) => {
    await saveConversationWithoutRegression(s, a.conversation as any);
  },
  loadConversation: (s, a) => s.loadConversation(a.sessionId as string),
  listConversations: (s) => s.listConversations(),
  listConversationSummaries: (s) => s.listConversationSummaries(),
  isConversationImported: (s, a) => s.isConversationImported(a.sessionId as string),
  deleteConversation: (s, a) => s.deleteConversation(a.sessionId as string),

  // Agent session logs (raw Claude Code JSONL)
  saveAgentSessionLog: (s, a) => s.saveAgentSessionLog(a.taskId as string, a.sessionId as string, a.content as string),
  getAgentSessionLog: (s, a) => s.getAgentSessionLog(a.taskId as string),

  // Project settings overlay (docs/design/lazy-teams.md §11). Present here so
  // RemoteStorage — which reaches every Storage method through this proxy —
  // can carry the overlay too; the typed control-plane surface is the
  // getProjectSettings/setProjectSettings RPC pair, not these.
  getProjectSettings: (s) => s.getProjectSettings(),
  saveProjectSettings: (s, a) => s.saveProjectSettings(a.settings as any),

  // Builder resume intents (durable upgrade↔builder handshake)
  saveBuilderResumeIntent: (s, a) => s.saveBuilderResumeIntent(a.intent as any),
  takeBuilderResumeIntent: (s, a) => s.takeBuilderResumeIntent(a.builderId as string),
  listBuilderResumeIntents: (s, a) => s.listBuilderResumeIntents(a.projectRoot as string | undefined),

  // Builder Sessions (daemon-owned interactive builder registry)
  createBuilderSession: (s, a) => s.createBuilderSession(a.session as any),
  getBuilderSession: (s, a) => s.getBuilderSession(a.id as string),
  getActiveBuilderSessionForMember: (s, a) =>
    s.getActiveBuilderSessionForMember(a.projectRoot as string, a.memberEmail as string | null),
  listBuilderSessions: (s, a) => s.listBuilderSessions(a.projectRoot as string | undefined),
  updateBuilderSession: (s, a) =>
    s.updateBuilderSession(a.id as string, a.patch as any, a.expectedState as any, a.expectedBuilderId as any),

  // Tags
  addTaskTag: (s, a) => s.addTaskTag(a.taskId as string, a.tag as string, a.actor as any),
  removeTaskTag: (s, a) => s.removeTaskTag(a.taskId as string, a.tag as string, a.actor as any),
  getTagHistory: (s, a) => s.getTagHistory(a.taskId as string),

  // Builder scratch sandbox (captured from $LAZY_SCRATCH_DIR; see src/builder/scratch-sync.ts)
  saveScratchFile: (s, a) => s.saveScratchFile(a.input as any, a.actor as any),
  getScratchFile: (s, a) => s.getScratchFile(a.path as string),
  listScratchFiles: (s) => s.listScratchFiles(),
  deleteScratchFile: (s, a) => s.deleteScratchFile(a.path as string),

  // Memory (lazy-owned shared knowledge; append-only, actor-attributed history)
  saveMemory: (s, a) => s.saveMemory(a.input as any, a.actor as any),
  getMemory: (s, a) => s.getMemory(a.name as string),
  listMemories: (s, a) => s.listMemories(a.options as any),
  deleteMemory: (s, a) => s.deleteMemory(a.name as string, a.actor as any),
  getMemoryHistory: (s, a) => s.getMemoryHistory(a.name as string | undefined),

  // Memory compact (derived; regenerated from the records, never from itself)
  saveMemoryCompact: (s, a) => s.saveMemoryCompact(a.input as any, a.actor as any),
  getMemoryCompact: (s) => s.getMemoryCompact(),
  clearMemoryCompact: (s) => s.clearMemoryCompact(),

  // System messages (proactive system-to-human reports; append-only)
  createSystemMessage: (s, a) => s.createSystemMessage(a.input as any),
  listSystemMessages: (s, a) => s.listSystemMessages(a.options as any),
  getSystemMessage: (s, a) => s.getSystemMessage(a.id as string),
  markSystemMessageRead: (s, a) => s.markSystemMessageRead(a.id as string),
  dismissSystemMessage: (s, a) => s.dismissSystemMessage(a.id as string, a.actor as any),

  // Status History
  getStatusHistory: (s, a) => s.getStatusHistory(a.taskId as string),

  // Per-task tool stats (durable; the proxy writes, every surface reads)
  getToolStats: (s, a) => s.getToolStats(a.taskId as string),
  saveToolStats: (s, a) => s.saveToolStats(a.record as any),

  // Usage-limit readings ([usage_pause]) are DELIBERATELY absent: only the
  // daemon's own recorder writes them, in process (src/daemon/usage-readings.ts).
  // A reading decides whether turns may spend a credential, so a caller that
  // could write one could lift (or impose) a pause; and the list names every
  // member's credential. State goes out through the control-plane `usagePause`
  // and `usageLimits` commands instead.

  // Search
  search: (s, a) => s.search(a.query as string),

  // Tracing
  appendTraceSpans: (s, a) => s.appendTraceSpans(a.spans as SpanRecord[]),
  readTraceSpans: (s, a) => s.readTraceSpans(a.sinceMs as number | undefined),

  // Wait intervals
  recordWaitStart: (s, a) => s.recordWaitStart(a.start as any),
  recordWaitEnd: (s, a) => s.recordWaitEnd(a.id as string, a.endedAt as string, a.outcome as any),
  readWaitIntervals: (s, a) => s.readWaitIntervals(a.filter as any),
};

/**
 * Handle a generic Storage method call via RPC.
 *
 * Uses the daemon's long-lived Storage instance — no lock acquisition per call.
 * CLI processes never touch .storage-lock at all.
 */
export async function handleStorageCall(
  projectRoot: string,
  params: Record<string, unknown>,
  caller?: ActorIdentity,
) {
  const method = params.method;
  if (!method || typeof method !== 'string') {
    throw new RpcError(400, 'Storage RPC requires a "method" parameter');
  }

  // `args` is destructured by each STORAGE_METHODS entry, so a non-object here
  // (an array, a string) silently yields undefined for every field it reads —
  // a write with empty content instead of a rejected request.
  const rawArgs = params.args;
  if (rawArgs !== undefined && rawArgs !== null
      && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    throw new RpcError(
      400,
      `Storage RPC "args" must be a JSON object, got ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
    );
  }
  const args = (rawArgs as Record<string, unknown> | undefined) ?? {};

  const handler = STORAGE_METHODS[method];
  if (!handler) {
    throw new RpcError(404, `Unknown storage method: ${method}`);
  }

  // A builder session is its member's own view (./builder-sessions.ts):
  // wherever other members can exist (managed or team mode) these three reads
  // are re-scoped to the CALLER's member, derived from the caller's token —
  // never from a request field. The scoped call RETURNS the answer; `undefined`
  // falls through to the table entry below, which is what single-person
  // installs and operator callers take.
  if (BUILDER_SESSION_MEMBER_SCOPED_METHODS.has(method)) {
    const scoped = await (await import('./builder-sessions')).scopeBuilderSessionStorageRead(
      projectRoot,
      method,
      args,
      caller,
    );
    if (scoped !== undefined) return scoped;
  }
  // ...and a member does not WRITE these rows through the proxy at all: the
  // daemon writes them, and start/stop/end are the member's interface. A
  // member-written builderId or containerName reached `rm -rf` and `docker stop`.
  if (BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS.has(method)) {
    (await import('./builder-sessions')).refuseMemberSessionStorageWrite(method, caller);
  }

  const storage = await getOrCreateStorage();

  // INVARIANT: storage.createTask must not silently pin claude-code when the
  // caller omitted agentId — the project overlay (and lazy.toml) decide.
  if (method === 'createTask') {
    const [config, projectSettings] = await Promise.all([
      loadConfig(projectRoot),
      storage.getProjectSettings(),
    ]);
    args.agentId = await resolveAgentIdForStorageCreateTask(
      storage,
      args,
      config,
      projectSettings,
    );
    // INVARIANT: an agent this INSTALLATION cannot run is refused here, not at
    // launch. This route — not `./create-task` — is where `lazy create` and
    // Lazy Teams both land (the CLI reaches it through RemoteStorage, Teams
    // through `storage("createTask")`), so a gate that lived only on the
    // business route would miss every human surface there is. Managed hosts
    // only, bounded, and failing open: see `assertAgentProfileRunnable`.
    await assertAgentProfileRunnable(projectRoot, args.agentId as string);
  }

  const result = handler(storage, args);
  // Handle both sync (getStoragePath, getTaskDir) and async methods
  return result instanceof Promise ? await result : result;
}

/**
 * The Storage-proxy reads a member may only see its own rows through in team
 * mode — re-scoped in ./builder-sessions.ts, which derives the caller's member
 * from the CALLER (`handleStorageCall`'s third argument) and never from a
 * request field.
 *
 * Kept here rather than in builder-sessions.ts so the allowlist sits beside
 * the dispatch that honours it, the same reason BUILDER_STORAGE_METHODS lives
 * beside its own route. A method named here but absent from `STORAGE_METHODS`
 * would 404 on the full surface instead of scoping; a builder-session read
 * added to `STORAGE_METHODS` later must be added here too, or it silently
 * loses its scoping.
 */
export const BUILDER_SESSION_MEMBER_SCOPED_METHODS: ReadonlySet<string> = new Set([
  'getBuilderSession',
  'getActiveBuilderSessionForMember',
  'listBuilderSessions',
]);

/**
 * The Storage-proxy methods that WRITE a builder-session row, refused outright
 * for user-kind callers by ./builder-sessions.ts `refuseMemberSessionStorageWrite`
 * (only the daemon writes these rows). Every such method in `STORAGE_METHODS` belongs here — a builder-session write added
 * later without an entry is exactly the bypass this closes (see the invariant
 * test in test/unit/builder-session-write-scope.test.ts).
 */
export const BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS: ReadonlySet<string> = new Set([
  'createBuilderSession',
  'updateBuilderSession',
]);

/**
 * The ONLY Storage methods a builder container may call.
 *
 * WHY A SEPARATE, TINY LIST. `/rpc/storage` above exposes the WHOLE Storage
 * interface and is therefore gated on the shared daemon token — the credential
 * that also unlocks every `/rpc/<command>` CLI pass-through. A builder
 * container does not hold that token and must not: its mounted credential is a
 * per-identity MCP token, deliberately scoped to the narrow builder tool
 * surface. Handing it the shared token so its conversation capture could write
 * would give the container (and the agent running inside it) full CLI and full
 * storage authority to fix a logging path.
 *
 * So the builder surface gets exactly what its SUPERVISOR needs and nothing
 * else: persist captured conversations and scratch artifacts, and read/stamp
 * its own resume intent. Everything here is either a write the supervisor
 * already performs on the human's behalf or a read of state the builder owns.
 *
 * Adding an entry widens what a compromised builder container can do. Do not
 * add one to make an unrelated caller work — give that caller its own surface.
 */
export const BUILDER_STORAGE_METHODS: ReadonlySet<string> = new Set([
  // Connectivity probe + the path RemoteStorage needs for getTaskDir().
  'getStoragePath',
  // Conversation capture — the reason this surface exists.
  'saveConversation',
  // Scratch capture on the same cadence (src/builder/scratch-sync.ts). Scoped to
  // the builder scratch sandbox only — no task or agent data.
  'listScratchFiles',
  'saveScratchFile',
  // Resume-intent stamp on exit, so `lazy upgrade` can relaunch the same
  // conversation. Reads/writes only builder-resume-intents.
  'listBuilderResumeIntents',
  'saveBuilderResumeIntent',
]);

/**
 * Handle a storage call from a builder container (POST /builder/storage).
 *
 * Authentication happens in the route (a builder-kind MCP token, never the
 * shared daemon token); this is the AUTHORIZATION half — the allowlist above.
 * Dispatch deliberately delegates to handleStorageCall so the two surfaces can
 * never drift on argument validation or method semantics.
 */
export async function handleBuilderStorageCall(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const method = params.method;
  if (!method || typeof method !== 'string') {
    throw new RpcError(400, 'Builder storage call requires a "method" parameter');
  }
  if (!BUILDER_STORAGE_METHODS.has(method)) {
    throw new RpcError(
      403,
      `Storage method "${method}" is not available on the builder surface. ` +
      `A builder container may only call: ${[...BUILDER_STORAGE_METHODS].sort().join(', ')}. ` +
      `The full storage surface lives at /rpc/storage and requires the shared daemon token, ` +
      `which is deliberately not given to containers.`,
    );
  }
  return handleStorageCall(projectRoot, params);
}
