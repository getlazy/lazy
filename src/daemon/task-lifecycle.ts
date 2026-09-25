/**
 * Daemon-side lifecycle orchestration for unblock, accept, reject, close.
 *
 * Owns pre-flight validation and state transitions for lifecycle operations,
 * mirroring how task-launcher.ts owns start orchestration.
 *
 * The daemon enforces invariants (status checks, lock checks, orphan detection)
 * so that any client (CLI, MCP tool, future API) gets consistent behavior.
 *
 * This module must NOT:
 * - Call process.exit()
 * - Do interactive prompts (no TTY in daemon)
 * - Import CLI rendering/theme modules
 * - Call storage.close() — the daemon owns the Storage lifecycle
 * - NEVER spawn lazy CLI as a subprocess (use internal functions instead)
 *
 * CRITICAL: The daemon has direct access to storage, runners, and all task
 * lifecycle functions. Never use getLazyCommand() or spawn lazy CLI from
 * daemon code — it causes deadlocks and storage lock contention.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { loadConfig } from '../config/loader';
import type { EffortLevel, ResolvedConfig } from '../config/types';
import { resolveTurnLaunchIdentity, resolveOneOffTurnIdentity } from './launch-identity';
import { resolveAgentChattiness, renderChattinessSnippet } from '../config/chattiness';
import { pathExists } from '../utils/fs';
import { createRunner } from '../runner';
import type { Runner } from '../runner/types';
import { stampSessionRunner, removeTaskRun, mustRecreateForContainerAgent } from '../runner/session-launch';
import { pinnedCustomImage } from '../docker/worktree-image';
import {
  createDriver,
  LocalDriver,
  isIntermediateBranch,
  mergeLandsLocally,
  resolveUpstreamMergeRef,
  type MergeResult,
} from '../remote';
import { resolveUpstreamMergeRefForCommand } from './upstream-command-ref';
import {
  PhaseReporter,
  ACCEPT_PHASES,
  acceptPhasePlan,
  acceptReentryPhasePlan,
  UNBLOCK_PHASES,
  unblockPhasePlan,
  TERMINATE_PHASES,
  closePhasePlan,
  rejectPhasePlan,
  SYNC_PHASES,
  syncPhasePlan,
  REPARENT_PHASES,
  reparentPhasePlan,
  ASK_PHASES,
  askPhasePlan,
  claimedTurnWaitPhasePlan,
  REVIEW_PHASES,
  reviewPhasePlan,
  RESUME_PHASES,
  resumePhasePlan,
  STOP_PHASES,
  stopPhasePlan,
  type ProgressEmitter,
} from './progress';
import { resolveAskAvailability } from '../server/review-actions';
import { buildAskContext } from '../task/ask-context';
import { askTaskRecord } from '../task/record-ask';
import { regenerateFidelity } from '../synthesis/fidelity';
import { getSummarizer } from '../synthesis/summarizer';
import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { isUsagePauseRefusal } from './rpc-error';
import { runSelfSync, planSelfSyncSteps, type SelfSyncStep } from './self-sync';
import { memberInsideTask, memberInsideSyncMessage } from '../server/member-terminals';
import { beginWorktreeTeardown } from './member-entry';

/** The release a reject or close holds while it may tear the worktree down. */
interface WorktreeTeardown { release: () => void }
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { ACCEPT_IN_FLIGHT_KEY, escapeMergingForOperation } from './stranded-merge';
import {
  ACCEPT_INTENT_KEY,
  ACCEPT_RESUME_ATTEMPTS_KEY,
  ACCEPT_RESUME_NEXT_AT_KEY,
  ACCEPT_FOLLOWTHROUGH_KEY,
  FOLLOWTHROUGH_STEPS,
  followThroughBackoffMs,
  readAcceptIntent,
  readFollowThrough,
  type AcceptIntent,
  type AcceptFollowThrough,
  type FollowThroughStep,
} from './accept-intent';
import { markSyncRestoreStatus, clearSyncRestoreStatus } from '../task/sync-restore-status';
import { recordSessionCommits } from '../task/session-commits';
import { pinnedBaseOf, BASE_PIN_KEY } from '../task/base-pin';
import { isSyncDispatchable } from '../task/sync-dispatch';
import { resolveAndPersistLowHighLoop } from './effort';
import { switchTaskAgent, formatAgentSwitchAnnouncement } from './agent-switch';
import { resolveProjectModel } from './project-settings';
import { setRunnerAgentForTask } from './task-harness';
import { assertKnownAgentProfile } from './agent-profile-check';
import { readWorktreeMergeState, isMidMerge, describeMergeState } from '../git/operations';
import { hasUncommittedChanges, listUncommittedPaths, applyPatch, patchIsAlreadyApplied, snapshotFiles, patchPaths, hasUpstreamChanges, getRemoteDefaultBranch, recoverMissingWorktreeWithFetch, createAcceptTag, getNewCommits, getMergeBase } from '../git/operations';
import { DEFAULT_PRE_ACCEPT_TIMEOUT_SECS } from '../supervisor/accept-gate';
import type { DestinationRestoreConflict } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { checkPairingLock } from '../utils/pairing-lock';
import { protocolDir as getProtocolDir, reviewProtocolDir, acceptGateProtocolDir, writeCommand, writeResponse, consumeCommand, ensureProtocolDir, commonCommandFields, newCommandId, removeProtocolDir, consumeResponse, clearStatus, completedResponses, readResponse, inFlightResponseCorrelates } from '../protocol';
import { shortId, displayId, displayIdFor, taskRef, getWorktreePath, getWorktreePathForRef, getBranchName, getBranchNameFromId } from '../task/identity';
import { buildNotesContext, buildJournalNotice, buildArtifactNotice, buildSystemPrompt, buildPromptWithInstructions, buildTurnHistoryContext, resolveNotesCutoff, selectNotesForDelivery, getNewJournalSince } from '../task/turn-context';
import { typeConstraintsSection } from '../task/type-constraints';
import { snapshotIsRestorable } from '../task/worktree-snapshot';
import { runSyncWithRemote } from '../task/sync-remote';
import { cleanupWorktree, cleanupWorktreeAndBranch, cleanupTaskContainer } from '../task/cleanup';
import { buildAgentSwitchHandoffContext } from '../agent/switch-handoff';
import { rediscoverSessionIdForHarness } from '../agent/session-discovery';
import { checkOrphanedChild, retargetOrphanedChild, getActiveChildren, reparentChildren, formatReparentWarning } from '../task/orphan';
import { notifyParentOfAcceptedSubtask } from '../task/notify-parent-accepted';
import { notifyParentOfRemovedSubtask } from '../task/notify-parent-children';
import {
  FINAL_REVIEW_CAP,
  incrementFinalReviewRound,
  resetAutoReactCounters,
  resetFinalReviewRound,
} from './auto-react-budget';
import { getNonHumanTurnCount, incrementNonHumanTurnCount, resetNonHumanTurnCount, checkTurnBudget } from './turn-budget';
import { enforceEdgeGate, EdgeGateRefusedError, resolveEdgeGateDecision } from '../protection/edge-gate';
import { peekPendingAcceptReview, clearPendingAcceptReview } from '../protection/pending-review';
import { enforceResurrectionGuard, ResurrectionRefusedError, stackedChildAdvisory } from '../protection/resurrection-guard';
import { enforceLfsGuard, LfsPointerRefusedError } from '../protection/lfs-guard';
import {
  enforceAcceptCheck,
  AcceptCheckFailedError,
  acceptCheckOverriddenWarning,
  acceptCheckOverrideAvailable,
  ALLOW_BROKEN_FLAG,
} from '../protection/accept-check';
import { revertedProtectedFiles, revertedProtectedFilesNotice } from '../protection/reverted-files';
import { acceptRefusal, AcceptRefusedError, acceptWithApprovedFilesCommand, shellQuote } from './accept-refusal';
import {
  applyRaisedResolutions,
  buildRaisedResolvedNotice,
  materializePendingRaisedComments,
  openRaisedItems,
  allOpenRaisedItems,
  validateRaisedResolutions,
} from './raised-items';
import { createHumanTokenVerifier } from '../protection/verify-token';
import { isFeatureEnabled } from '../utils/features';
import { isTerminalStatus, isActiveStatus, isBlockedStatus, raisedStatusForAction } from '../types';
import { parentTaskIdOf, targetBranchOf, taskTarget, branchTarget } from '../task-target';
import { isLinkedTask } from '../task/linked';
import { logger } from '../utils/logger';
import { reviewerKey } from '../review-draft';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import type { OpenReview } from '../remote/driver';
import { mismatchedReviewBase, wrongReviewBaseRefusal, reviewComparisonTarget } from './review-base';
import { retargetReviewsAfterReparent } from './review-retarget';
import { clearLazyClosedReview, dropLazyClosedRecord, LAZY_CLOSED_REVIEW_KEY, markedRecordState, unconfirmedCloseRefusal } from './lazy-closed-review';
import {
  resolveSubmitTarget,
  mayOpenIntermediateReview,
  intermediateSubmitRefusal,
  baseNotOnRemoteRefusal,
  findUnrecordedReview,
  reviewBaseMismatch,
  reviewComparisonBranch,
  recordedReviewBase,
  recordedBaseUnreadableRefusal,
  recordedRetargetRefusal,
  linkedReviewBaseRefusal,
  mismatchedReviewRefusal,
  staleBaseWarning,
} from './submit-target';
import { getActor } from '../constants';
import { writeDaemonMcpConfig } from './task-launcher';
import { prepareTurnLaunch, assertNoMemberInside, releaseTurnCredential } from './turn-credentials';
import { assertBesideLaunchAllowed, assertTurnStartAllowed, usagePauseHold } from './usage-pause';
import { USAGE_PAUSE_PENDING_FIX_KEY } from '../usage-pause/hold';
import { createAgentTurn, createRecoveredAgentTurn, pendingTurnOwnerPerson, turnOwnerOfClaim } from './turn-owner';
import { revokeTaskMcpTokens } from './mcp-tokens';
import { clearTaskEnv } from './task-env';
import { revokeTaskCredentialGrants } from '../proxy/credential-broker';
import { setupSandbox } from '../utils/sandbox';
import { reviewContainerNameForTask, acceptGateContainerNameForTask } from '../capture/claude';
import { hasDaemonContext } from './context';
import { withSettleLock, isInFlightLive, IN_FLIGHT_ASYNC_BACKSTOP_MS, stoppableClaimOf, CLAIMING_PROCESS_ID } from './in-flight-turn';
import { runGit } from '../utils/git';
import { validateBranchInSyncWithRemote } from '../utils/git';
import { latestViolationTurn, launchSettingsFromResponse } from '../utils/turns';
import { parkTaskPaused } from '../utils/paused-status';
import { resolveOutstandingViolations } from '../protection/outstanding-resolver';
import { approvedFilesFromRecords, mergedViolationRecords } from '../protection/outstanding';
import { findPendingFeedback, buildFeedbackRedeliveryPrompt } from '../utils/feedback-redelivery';
import { isOfflineMode } from '../utils/offline';
import { waitForSupervisorAnswer, waitForSupervisorResponse, type SupervisorAnswerOutcome } from './supervisor-wait';

import type { StartCommand, UnblockCommand, SyncCommand, AskCommand, AcceptGateCommand, ReviewCommand, CompletedResponse, ErrorResponse } from '../protocol';
import { resolveWrapUpCommandFields } from './wrap-up-plan';
import { checkClusterFixRoundBudget, incrementClusterFixRound, resetClusterFixRound } from './cluster-fix-rounds';
import { docsSuffix } from '../docs/links';
import { journalWorktreeRecovery } from '../utils/reconcile';
import { PROTOCOL_VERSION } from '../protocol/types';
import type { FileViolation, Task, TokenUsage, Session, TaskStatus, Actor, ActorInput, RaisedItem, RaisedItemResolution, ReviewComment, InFlightTurn, InFlightTurnOutcome, InFlightTurnOwner, TurnType, ReviewReport, AgentTokenUsage } from '../types';
import { RETIRED_IN_FLIGHT_OWNERS } from '../types';
import { currentPromptOf } from '../task-prompt';
import { parseReviewReport, parseReviewReply } from '../review/parse-report';
import {
  isSuccessfulReviewReport,
  raisedItemIdsOf,
  resolveRaisedItemByIdOrPrefix,
  reviewIssueCount,
  reviewIssuesAwaitingWork,
  reviewDisregardedByGate,
  reviewReportHasGatingIssue,
  gatingFindingsOf,
} from '../review/success';
import { reviewSettingsOf } from '../review/mode';
import {
  REVIEW_CRASH_VERDICT_PREFIX,
  REVIEW_REASK_HEADING,
  chooseReviewReport,
  describeFailedReview,
  describeReviewFailureShort,
  reviewWasNeverDispatched,
  resolveReviewVerdict,
  reviewIsClean,
  reviewSweepsClaimUncoveredIssue,
  reviewVerdictLabel,
} from '../review/verdict';
import { recoverAndAttachReviewFindings } from '../review/recover-findings';
import { formatFindingForAutoFix, buildReviewAutoFixMessage } from '../review/auto-fix-message';
import { audienceOf } from '../task/audience';
import { isClusterTask } from '../types';
import { createdByOf } from '../protection/outstanding-resolver';
import reviewTurnScopePrompt from '../prompts/review-turn-scope.md' with { type: 'text' };
import reviewTurnFeaturePrompt from '../prompts/review-turn-feature.md' with { type: 'text' };
import { askAwaitsAgent, isHumanAsk, isPendingDelivery } from '../server/review-actions';
import {
  queuedHumanFeedbackCount,
  ACCEPTED_COMMENT_PREFIX,
  SUBMITTED_COMMENT_PREFIX,
  REPARENTED_COMMENT_PREFIX,
  STALE_PARENT_COMMENT_PREFIX,
} from '../task/queued-feedback';
import { buildUnblockPrompt } from '../review/unblock-prompt';
import { actorRole, withActorPerson } from '../actor-ref';
import { toTurnUsage, rollUpSessionUsage } from '../utils/usage-recording';
import type { Storage } from '../storage';
import { sanitizeUserText } from '../utils/sanitize-text';
import { isWatchdogKill, watchdogTurnLines, WATCHDOG_TURN_HEADING } from '../utils/watchdog-turn';
import { buildMemorySection } from '../memory';
import { buildLazyMdSection } from '../task/lazy-md';

import lazyToolInstructions from '../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../prompts/goal-context-resume.md' with { type: 'text' };

// =====================================================================
// Shared pre-flight helpers
// =====================================================================

/**
 * Check pairing lock on a task's worktree and throw RpcError if locked.
 * Daemon-side equivalent of CLI's rejectIfPairing (which calls process.exit).
 */
/**
 * Revoke the task's MCP bearer token — its session has ended.
 *
 * The token is what proves "I am this task" to the daemon (see
 * src/daemon/mcp-tokens.ts). Once the task is accepted, rejected, or closed the
 * agent must not be able to act at all, so the credential dies with the session
 * rather than lingering until the container is reaped.
 *
 * Best-effort by design: a token that outlives its session for a few seconds is
 * bad, but failing an accept that has already merged and pushed is worse.
 */
async function revokeTaskTokens(projectRoot: string, taskId: string): Promise<void> {
  try {
    const revoked = await revokeTaskMcpTokens(projectRoot, taskId);
    if (revoked > 0) logger.debug(`Revoked ${revoked} MCP token(s) for task ${shortId(taskId)}`);
  } catch (err) {
    logger.warn(
      `Failed to revoke MCP token for task ${shortId(taskId)}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The task's PLACEHOLDER credential dies with the same session: after this
  // point its container must not be able to spend the human's Anthropic or
  // Cursor credential through the proxy. Revoked separately from the MCP token
  // so one registry's failure cannot skip the other.
  try {
    const revoked = await revokeTaskCredentialGrants(projectRoot, taskId);
    if (revoked > 0) logger.debug(`Revoked ${revoked} proxy credential grant(s) for task ${shortId(taskId)}`);
  } catch (err) {
    logger.warn(
      `Failed to revoke the proxy credential grant for task ${shortId(taskId)}: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `It stays valid until the daemon is restarted.`,
    );
  }

  // The task's own env vars (`lazy env set`) are scoped to its lifetime — they
  // are the user's secrets, held only so that resumes and auto-resumes keep
  // working, so they die with the session rather than lingering on disk. Same
  // best-effort posture as the credentials above: a stale entry is bad, failing
  // an accept that has already merged and pushed is worse.
  try {
    const cleared = await clearTaskEnv(projectRoot, taskId);
    if (cleared > 0) logger.debug(`Cleared ${cleared} per-task env var(s) for task ${shortId(taskId)}`);
  } catch (err) {
    logger.warn(
      `Failed to clear per-task env for task ${shortId(taskId)}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The session-credential binding is what lets a team-mode placeholder resolve
  // through the proxy. Reconcile releases it when a task leaves `working`, but
  // reject/close on a still-working task never reaches reconcile — revoke it here
  // alongside the MCP token and credential grants so the binding cannot orphan.
  try {
    await releaseTurnCredential(projectRoot, taskId);
  } catch (err) {
    logger.warn(
      `Failed to release the session credential binding for task ${shortId(taskId)}: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `The task is terminal — a surviving binding will not be cleared by a later turn; ` +
      `the container's placeholder may keep resolving until the daemon restarts.`,
    );
  }
}

function checkPairingLockOrThrow(root: string, tRef: string, displayTaskId: string): void {
  const worktreePath = getWorktreePathForRef(root, tRef);
  const pairingLock = checkPairingLock(worktreePath);
  if (pairingLock) {
    throw new RpcError(409, `Task ${displayTaskId} is locked for pairing (PID ${pairingLock.pid}, started ${pairingLock.started_at}). Exit the pairing session first.`);
  }
}

/**
 * Check for uncommitted changes in a task's worktree and throw if found.
 */
async function checkUncommittedChangesOrThrow(worktreePath: string, displayTaskId: string, commandName: string): Promise<void> {
  if (!await pathExists(worktreePath)) return;

  // A half-merged worktree is NOT "uncommitted changes" and telling the human to
  // "commit or stash" is bad advice — stashing a conflicted merge fails, and
  // committing one records conflict markers. Name what actually happened and give
  // the one command that fixes it (fix-sync-silent-conflict).
  const mergeState = await readWorktreeMergeState(worktreePath);
  if (isMidMerge(mergeState)) {
    throw acceptRefusal(
      409,
      `Task ${displayTaskId} has an unresolved merge in its worktree (${describeMergeState(mergeState)}). ` +
      `A sync did not finish. Run \`lazy sync ${displayTaskId}\` to complete it, ` +
      `then re-run ${commandName}.`,
      {
        reason: 'mid-merge',
        next: `Finish the interrupted sync, then ${commandName} again.`,
        command: `lazy sync ${shellQuote(displayTaskId)}`,
        uiAction: 'sync',
      },
    );
  }

  if (await hasUncommittedChanges(worktreePath)) {
    // NAME THE PATHS. This refusal is the last thing standing between loose
    // work and a merge that silently drops it, and an unnamed "uncommitted
    // changes" reads like lint: the cheapest way past it is to discard and
    // try again, which is the loss itself. Four tasks left their end-of-turn
    // docs uncommitted and every one was caught by a human running `git
    // status` by hand — so the refusal runs it for them.
    //
    // Best-effort: a failed listing still refuses (hasUncommittedChanges
    // already said there IS something), just without the names.
    const paths = await listUncommittedPaths(worktreePath);
    const shown = (paths ?? []).slice(0, 20);
    const detail = shown.length > 0
      ? ` None of it is on the branch, so ${commandName} would not carry it:\n` +
        shown.map(p => `  ${p}`).join('\n') +
        (paths && paths.length > shown.length ? `\n  …and ${paths.length - shown.length} more` : '')
      : '';
    // No flag to offer: `lazy accept` has no --accept-dirty-worktree (only
    // reject/MCP do), so the honest remedy names the worktree and stops there
    // rather than inventing one.
    throw acceptRefusal(
      409,
      `Task ${displayTaskId} has uncommitted changes.${detail}\n` +
      `Commit or stash changes before running ${commandName}.`,
      {
        reason: 'dirty-worktree',
        next: `Check each uncommitted path in the task's worktree (${worktreePath}) — commit what belongs to the task, discard the rest — then ${commandName} again.`,
      },
    );
  }
}

/**
 * Resolve the upstream branch for a task, walking up past terminal parents.
 *
 * When a parent task is complete/closed/abandoned but the child wasn't
 * reparented (e.g., reparent-on-accept didn't fire, or the child was
 * created after the parent completed), this walks up the ancestor chain
 * until it finds a living parent or reaches top-level.
 *
 * Side effect: reparents the task to the living ancestor found (or top-level)
 * so future operations don't need to walk up again.
 *
 * Returns the resolved branch name and any warnings generated.
 */
export async function resolveParentBranchWithFallback(
  task: Task,
  storage: Storage,
  projectRoot: string,
  /**
   * Channel actor of the operation that triggered this resolution (unblock or
   * sync). The re-parent comments below are a side effect of THAT command, so
   * they carry its channel — not the daemon's env-var default, which reports
   * 'human' for every caller. See {@link MCP_ACTOR}.
   */
  actor: ActorInput = getActor(),
): Promise<{ branch: string; warnings: string[]; retargeted: boolean }> {
  const warnings: string[] = [];

  const directParentId = parentTaskIdOf(task);

  if (!directParentId) {
    // Top-level task: integrate into the named branch. An empty '' sentinel or a
    // stale 'lazy/...' ref (a task-branch reference that legacy data could hold
    // in the branch slot) means the stored branch needs runtime resolution —
    // heal to the repo's configured default integration branch (origin/HEAD →
    // 'main' fallback), NEVER to whatever the user currently has checked out at
    // sync time. Note: targetBranchOf does NOT strip 'lazy/', so the raw stored
    // branch is inspected here.
    const stored = task.target.kind === 'branch' ? task.target.branch : '';
    let branch = (stored && !looksLikeTaskBranch(stored)) ? stored : '';
    if (!branch) {
      const cfg = await loadConfig(projectRoot);
      branch = await getRemoteDefaultBranch(projectRoot, cfg.remote.git_remote);
      if (stored) {
        await storage.updateTaskTarget(task.id, branchTarget(branch));
        warnings.push(`Corrected stale target branch from ${stored} to ${branch}.`);
        return { branch, warnings, retargeted: true };
      }
    }
    return { branch, warnings, retargeted: false };
  }

  // Check if the direct parent is still alive
  const parentTask = await storage.getTask(directParentId);
  if (parentTask && !isTerminalStatus(parentTask.status)) {
    // Parent is alive — use its branch directly
    return {
      branch: await getBranchNameFromId(directParentId, storage),
      warnings,
      retargeted: false,
    };
  }

  // Parent is terminal (or missing) — walk up to find a living ancestor.
  //
  // INVARIANT: a corrupt store must never hang or crash the daemon. `visited`
  // is a cycle guard, mirroring `collectSubtreeIds` (src/task-target.ts):
  // without it a parent cycle among terminal tasks (A → B → A) spins this loop
  // forever inside the reconcile/sync path. A detected cycle is treated exactly
  // like "ancestor not found" — break out and fall through to the default
  // integration branch below.
  let currentParentId: string | null = directParentId;
  const staleAncestors: string[] = [];
  const visited = new Set<string>();

  while (currentParentId) {
    const ancestor = await storage.getTask(currentParentId);
    if (!ancestor) {
      // Ancestor not found — stop walking
      staleAncestors.push(currentParentId.substring(0, 8));
      break;
    }

    if (visited.has(ancestor.id)) {
      logger.error(
        `Corrupt task store: parent cycle detected while resolving the sync target of task ${displayId(task)}. ` +
        `Task ${ancestor.id} is its own ancestor via ${[...visited].join(' → ')}. ` +
        `Falling back to the default integration branch; repair the parent links of these tasks.`
      );
      break;
    }
    visited.add(ancestor.id);

    if (!isTerminalStatus(ancestor.status)) {
      // Found a living ancestor — reparent to it. The target becomes a
      // `{ kind: 'task' }` pointing at the ancestor; its branch is derived from
      // the ancestor at sync time, so there's no separate branch to keep in
      // step (the union can't hold a stale branch alongside a parent).
      const ancestorDisplay = displayId(ancestor);
      const staleList = staleAncestors.join(' → ');
      logger.info(`Task ${displayId(task)}: parent chain ${staleList} is terminal, reparenting to ${ancestorDisplay}`);
      warnings.push(`Parent task ${staleList} is complete. Reparented to ${ancestorDisplay}.`);

      await storage.updateTaskTarget(task.id, taskTarget(ancestor.id));
      await storage.createComment(
        task.id,
        `${STALE_PARENT_COMMENT_PREFIX}Stale parent chain detected during sync. Re-parented from ${staleList} to ${ancestorDisplay}.`,
        actor,
      );

      return {
        branch: await getBranchNameFromId(ancestor.id, storage),
        warnings,
        retargeted: true,
      };
    }

    // This ancestor is terminal too — keep walking
    staleAncestors.push(displayId(ancestor));
    currentParentId = parentTaskIdOf(ancestor);
  }

  // Reached top-level — all ancestors are terminal or missing. The old target
  // branch was set relative to the now-dead parent chain, so ignore it and
  // resolve to the repo's configured default integration branch.
  const staleList = staleAncestors.join(' → ');
  const cfg = await loadConfig(projectRoot);
  const fallbackBranch = await getRemoteDefaultBranch(projectRoot, cfg.remote.git_remote);
  logger.info(`Task ${displayId(task)}: entire parent chain ${staleList} is terminal, falling back to ${fallbackBranch}`);
  warnings.push(`Parent task ${staleList} is complete. Syncing with ${fallbackBranch} instead.`);

  await storage.updateTaskTarget(task.id, branchTarget(fallbackBranch));
  await storage.createComment(
    task.id,
    `${STALE_PARENT_COMMENT_PREFIX}Stale parent chain detected during sync. All ancestors terminal (${staleList}). Re-parented to top-level, targeting ${fallbackBranch}.`,
    actor,
  );

  return {
    branch: fallbackBranch,
    warnings,
    retargeted: true,
  };
}

// =====================================================================
// Unblock Task
// =====================================================================

export interface UnblockTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  message: string;
  /**
   * The DAEMON is starting this unblock by itself — a review's auto-fix, the
   * reconciliation of a destination worktree after somebody else's accept — so
   * no person asked for this turn, whatever `actor` it carries for attribution.
   * The usage-pause gate then judges it WITHOUT the one-shot override: that
   * belongs to the person who set it (src/daemon/usage-pause.ts). Callers
   * should also HOLD it with `usagePauseHold` beforehand, so it is retried
   * after the reset rather than refused.
   */
  daemonLaunch?: boolean;
  /**
   * WHOSE review draft this call spends, imposed by the daemon from the
   * CALLER's token (`applyCallerActor`), never read from a client.
   *
   * Separate from `actor` on purpose. `actor` answers "who did this", and on a
   * laptop that is now the git identity — but a draft is keyed by the CLIENT
   * that typed it, and every unattributed client there shares one key (`local`,
   * see reviewerKey in src/review-draft.ts). Deriving the key from `actor`
   * instead left the review page's own draft unclearable the moment writes
   * started carrying a person.
   */
  callerReviewerKey?: string;
  modelOverride?: string;
  /**
   * Optional resolutions for open raised items. Unlike accept, unblock does
   * NOT require a complete set — named items are resolved; others stay open
   * for the next accept gate. Never inferred from feedback prose.
   */
  raisedResolutions?: RaisedItemResolution[];
  /** CLI already confirmed orphan retargeting */
  retargetOrphan?: boolean;
  /** Whether notes were already shown in editor (skip re-injection) */
  notesInEditor?: boolean;
  /** CLI `--effort` override. Persists on the task so future turns use same value. */
  effortOverride?: string;
  /**
   * CLI/MCP `--agent` override. Switch to a different agent for this and future
   * turns. When switching agents, the session is reset (agent_session_id is
   * cleared) because sessions cannot be resumed across different agents.
   */
  agentOverride?: string;
  /**
   * Agent permission mode for this turn. When 'plan', the agent is launched
   * read-only (Q&A against the session). Used by `lazy browse -i` ask path.
   *
   * INVARIANT: when set to 'plan', the task MUST be exactly 'blocked' — this
   * is the only path that allows an interactive-review question to turn into
   * an agent turn. Any other status (working/pairing/conflict/merging/…)
   * rejects with 409 and the reviewer retains their typed question.
   */
  permissionMode?: 'plan' | 'default';
  /**
   * Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor()
   * when absent. Set by the MCP boundary because this turn is persisted in the
   * daemon, where the env-var default cannot see the caller's channel.
   * See {@link MCP_ACTOR}.
   */
  actor?: ActorInput;
  /**
   * True when this unblock is a HUMAN SUBMITTING THEIR REVIEW — the `unblock`
   * RPC behind `lazy unblock` / `lazy_unblock`, the review page's Unblock, and
   * the review auto-fix that the reviewer asked for when they started the
   * review. Those file the reviewer's answered asks (see `fileReviewAsks`).
   *
   * Stated by the caller, never inferred from the code path: the daemon starts
   * unblocks nobody submitted a review for — reconciling a destination
   * worktree after somebody ELSE's accept is the clearest case, where the
   * owning task's reviewer filed nothing and must not have their open
   * questions archived out from under them.
   */
  filesReview?: boolean;
  /**
   * True when the unblock text did NOT come from the reviewer's feedback box —
   * an Unblock pressed under an ask box (a line, report paragraph, verify step,
   * the Ask dialog). A delivered unblock then leaves the stored feedback draft
   * alone: the daemon clears only what it actually delivered, and those unsent
   * words are someone's feedback (CLAUDE.md: never lose human feedback).
   */
  keepFeedbackDraft?: boolean;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface UnblockTaskResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  turnNumber: number;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
  /**
   * How many queued web review comments (delivery_state 'pending_delivery')
   * were batched into this turn's prompt and marked delivered. Surfaces let
   * the human know their diff markup actually went with this unblock.
   */
  deliveredReviewComments: number;
}


/**
 * Drop the review draft whose words this operation just DELIVERED.
 *
 * Here, in the business logic, rather than in the web route that used to do it
 * — the daemon owns business logic and every client is equal in front of it. A
 * reviewer who types on the dashboard and then runs `lazy unblock` in a
 * terminal (or an agent calling `lazy_unblock`) must not get the stale feedback
 * back in the box on the next page load.
 *
 * `mode` decides how much goes: an unblock delivered the FEEDBACK only, so an
 * accept reason and viewed ticks typed alongside it are still unsent and stay.
 * An accepted task's review is over altogether, so the whole record goes.
 *
 * Only reached on success. A refused accept or a failed unblock throws before
 * this, which is what leaves the draft intact for the retry — the save-first
 * half of never losing human feedback.
 *
 * Best-effort by construction: failing to clear a draft must never turn a
 * delivered unblock or a durable merge into an error.
 */
async function clearDeliveredReviewDraft(
  taskId: string,
  callerReviewerKey: string | undefined,
  actor: ActorInput | undefined,
  mode: 'unblock' | 'accept',
): Promise<void> {
  try {
    const storage = await getOrCreateStorage();
    // The caller's own key when the daemon imposed one; `actor` only as the
    // fallback for an in-process caller that never crossed the RPC boundary.
    const reviewer = callerReviewerKey ?? reviewerKey(actor);
    if (mode === 'accept') {
      await storage.deleteReviewDraft(taskId, reviewer);
      return;
    }
    // Patch, not delete — and only when there is something to patch, so an
    // unblock never conjures an empty draft record for a task nobody drafted on.
    const existing = await storage.getReviewDraft(taskId, reviewer);
    if (!existing || !existing.feedback) return;
    // Only the feedback is spent by this unblock. There is no keep/revert half
    // to clear any more (move-file-approval-to-accept): unblock asks nothing
    // about protected files, so a draft holds no answer to a question that
    // could go stale.
    await storage.saveReviewDraft(taskId, reviewer, { feedback: '' });
  } catch (err) {
    logger.debug(
      `Could not clear the review draft for ${taskId} after ${mode}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * File the reviewer's asks: the unblock or accept that ended this review also
 * ends the questions that were part of it.
 *
 * Asks are answered the moment they are posted, so no state they already carry
 * says "that round of review is over" — which is why the Current review page
 * listed every question the reviewer had ever asked, forever. Filing is that
 * missing boundary, and it is the same moment the review draft is cleared: the
 * human has submitted their review.
 *
 * RECORDS, never discards (CLAUDE.md, "Never Lose Human Feedback"): the
 * message, its answer and its delivery state are untouched, the thread stays
 * readable, and a filed ask is still listed — under "Filed asks" rather than as
 * open business. An ask the agent has not consumed (in flight, or one whose
 * dispatch failed and is still waiting to be re-sent) is deliberately NOT
 * filed: its answer has not happened yet and the reviewer must keep seeing it.
 *
 * Best-effort by construction, like the draft clear beside it: failing to file
 * must never turn a delivered unblock or a durable merge into an error.
 */
async function fileReviewAsks(taskId: string, mode: 'unblock' | 'accept'): Promise<void> {
  try {
    const storage = await getOrCreateStorage();
    const comments = await storage.getTaskReviewComments(taskId);
    const now = Date.now();
    for (const c of comments) {
      if (!isHumanAsk(c) || c.filed_at != null) continue;
      if (askAwaitsAgent(c)) continue;
      await storage.updateReviewComment(taskId, c.id, { filedAt: now });
    }
  } catch (err) {
    logger.debug(
      `Could not file review asks for ${taskId} after ${mode}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function launchUnblockTask(
  projectRoot: string,
  params: UnblockTaskParams,
): Promise<UnblockTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'unblock');
  try {
    return await launchUnblockTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function launchUnblockTaskRun(
  projectRoot: string,
  params: UnblockTaskParams,
  phases: PhaseReporter,
): Promise<UnblockTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask. Every actor-attributed write in this path
  // (the feedback turn, the status transitions, the escape-hatch comment) uses
  // the SAME value, so a reader never sees one command attributed two ways.
  const actor = params.actor ?? getActor();

  phases.begin(UNBLOCK_PHASES.preflight);

  // --- Resolve task ---
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  let task = result.task;

  // --- Session check ---
  let sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }

  // --- Validate agent override (if provided) ---
  await assertKnownAgentProfile(projectRoot, params.agentOverride);

  // --- Status validation ---

  // INVARIANT: plan-mode turns (Q&A from `lazy review -i`) are only allowed
  // when the task is exactly 'blocked'. The daemon may autonomously transition
  // blocked → working on CI failures, comment arrival, upstream sync, etc. —
  // if that race loses the reviewer must retry, not stomp live work. Reject
  // with 409 so the CLI can preserve the typed question.
  if (params.permissionMode === 'plan' && task.status !== 'blocked') {
    throw new RpcError(409,
      `Task ${displayId(task)} is '${task.status}', not 'blocked'. ` +
      `Review questions only run while the task is blocked — the agent may have picked up autonomous work. Retry once it's blocked again.`,
    );
  }

  if (task.status === 'working') {
    throw new RpcError(409, `Task ${displayId(task)} is still working. Wait for it to finish.`);
  }
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }

  // --- Usage pause, judged BEFORE the first write below ---
  // (the merging escape, the `--agent` switch, orphan retargeting). On the task
  // as this unblock will run it, and without spending the one-shot override, so
  // a refused unblock leaves the task exactly as it was — stored agent
  // included. The gate after the turn budget takes the override.
  await assertTurnStartAllowed(projectRoot, {
    task: params.agentOverride ? { ...task, agent_id: params.agentOverride } : task,
    config: await loadConfig(projectRoot),
    actor,
    verb: 'unblock',
    peek: true,
    daemonLaunch: params.daemonLaunch,
    overrideEligible: params.usagePauseOverrideEligible === true,
  });

  // Merging → resting escape hatch. Parks as `conflict` if the task still owes a
  // decision on file-permission violations — see the violations-are-the-source-
  // of-truth invariant in src/utils/paused-status.ts.
  //
  // This used to park unconditionally, which would yank a task out from under an
  // accept that was genuinely mid-merge. It now goes through the shared recovery,
  // which refuses while a live accept owns the merge.
  if (task.status === 'merging') {
    task = await escapeMergingForOperation(storage, task, actor, 'unblock', projectRoot);
    warnings.push(`Task was in merging state. Moved back to ${task.status}.`);
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Agent switching (if requested) ---
  // When switching agents mid-task, update both task and session, and
  // re-resolve model/effort for the new agent (unless this call also supplied
  // overrides — those count as chosen for THIS agent). Sessions cannot be
  // resumed across different agents.
  // Local copies: the switch may consume co-supplied overrides so the later
  // resolve path does not treat them as a second durable write.
  let modelOverride = params.modelOverride;
  let effortOverride = params.effortOverride;
  // One read for both the switch and the runner pre-flight below, which needs
  // it to resolve the task's agent PROFILE to a harness.
  const unblockConfig = await loadConfig(projectRoot);

  // --- Cluster fix-round budget ---
  // A CLUSTER unblocking the SAME child over and over is the unbounded-spend shape
  // a driver has: nobody is watching, and every round is a full agent turn. The
  // refusal lands BEFORE anything is written — and only for an AGENT-actored
  // unblock, so a human's already-typed feedback is never what gets rejected
  // (src/daemon/cluster-fix-rounds.ts explains the exemptions).
  const clusterRounds = await checkClusterFixRoundBudget({
    storage,
    task,
    actor: actorRole(actor),
    budget: unblockConfig.cluster.max_child_fix_rounds,
  });
  if (clusterRounds.kind === 'refused') {
    throw new RpcError(429, clusterRounds.message + docsSuffix('cluster-tasks'));
  }

  if (params.agentOverride && params.agentOverride !== task.agent_id) {
    const projectSettings = await storage.getProjectSettings();
    const switchResult = await switchTaskAgent({
      storage,
      task,
      newAgentId: params.agentOverride,
      config: unblockConfig,
      projectModel: resolveProjectModel(projectSettings, unblockConfig),
      modelOverride,
      effortOverride,
    });
    task = (await storage.getTask(task.id))!;
    sess = (await storage.getSessionByTaskId(task.id))!;
    for (const line of formatAgentSwitchAnnouncement(switchResult)) {
      warnings.push(line);
    }
    // Already applied by the switch.
    modelOverride = undefined;
    effortOverride = undefined;
  }

  // --- Runner pre-flight (honor per-task runner override) ---
  const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
  // Set agent on runner so auth uses the correct agent (not hardcoded ClaudeCodeAgent).
  // Returns the HARNESS behind the task's profile — the command below carries it
  // so the supervisor need not resolve the profile itself.
  const harness = setRunnerAgentForTask(runner, unblockConfig, task);
  await runner.checkAvailability();

  // --- Orphan detection/retargeting ---
  if (parentTaskIdOf(task)) {
    const orphanStatus = await checkOrphanedChild(task, storage, projectRoot);
    if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
      if (params.retargetOrphan) {
        await retargetOrphanedChild(task, storage, orphanStatus.retargetBranch);
        task = (await storage.getTask(task.id))!;
        warnings.push(`Retargeted to ${orphanStatus.retargetBranch}.`);
        // Its open PR/MR follows the new target (./review-retarget.ts;
        // best-effort, never throws).
        warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, [task]));
      } else {
        throw new RpcError(409, `Parent task was accepted and its branch deleted. Task needs retargeting to ${orphanStatus.retargetBranch}. Pass retargetOrphan=true to confirm.`);
      }
    }
  }

  // --- Turn budget: cap consecutive turns without a human in the loop ---
  // Builder/agent-initiated unblocks count; a human unblock resets the count.
  const unblockTurnBudgetConfig = await loadConfig(projectRoot);
  if (actorRole(actor) !== 'human') {
    const nonHumanTurnCount = await getNonHumanTurnCount(storage, task.id);
    const budgetDecision = checkTurnBudget(nonHumanTurnCount, unblockTurnBudgetConfig.limits.max_turns_without_human);
    if (!budgetDecision.allowed) {
      throw new RpcError(409, `Task ${displayId(task)}: ${budgetDecision.reason}`);
    }
  }

  // --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---
  // The decision was already made (peek, before the first write); this call is
  // where a one-shot override it relied on is TAKEN — after the runner and
  // pairing preflights, so it is not spent on an unblock that fails there.
  // Still before the feedback turn and every counter reset; the caller holds
  // the feedback either way (the CLI's recovery file, the web page's draft).
  await assertTurnStartAllowed(projectRoot, {
    task, config: unblockTurnBudgetConfig, actor, verb: 'unblock', daemonLaunch: params.daemonLaunch,
    overrideEligible: params.usagePauseOverrideEligible === true,
  });

  // BUG FIX: these resets used to run unconditionally on every unblock, which let an
  // autonomous builder/agent unblock launder away its own budgets every turn. Only a
  // human taking over clears them; a builder/agent turn instead increments the new
  // turn-budget counter above.
  if (actorRole(actor) === 'human') {
    // --- Reset auto-react counters (human is taking over) ---
    try {
      await resetAutoReactCounters(storage, task.id);
    } catch {
      // Counter reset is best-effort — task unblock must proceed even if budget tracking fails
    }

    // Manual unblock re-arms auto-resume: clear circuit breaker and user-stop gate.
    // (resetConsecutiveInterruptions also clears session.user_stopped.)
    try {
      await storage.resetConsecutiveInterruptions(sess.id);
    } catch {
      // Counter reset is best-effort.
    }

    try {
      await resetNonHumanTurnCount(storage, task.id);
    } catch {
      // Counter reset is best-effort.
    }
  } else {
    try {
      await incrementNonHumanTurnCount(storage, task.id);
    } catch {
      // Counter increment is best-effort — task unblock must proceed even if budget tracking fails
    }
  }

  // §8.1/§8.2: the auto-review round counter resets on intervention by a
  // LAUNCHING actor — a human taking over, but also a cluster's driver handing a
  // capped child back (its MCP unblock IS the driver's decision;
  // src/task/audience.ts).
  // Only a daemon round's own auto-fix (actor 'system') leaves it standing,
  // or a daemon could launder its own cap every fix turn.
  if (actor !== 'system') {
    try {
      await resetFinalReviewRound(storage, task.id);
    } catch {
      // Round reset is best-effort — unblock must proceed even if it fails.
    }
  }

  // The cluster's per-child budget moves with the SAME decision: a human taking
  // over this child starts a fresh one, and each of the driver's own rounds
  // spends one. Counted here — after every refusal, so a rejected unblock never
  // burns a round the driver did not get.
  if (clusterRounds.kind === 'reset') {
    await resetClusterFixRound(storage, task.id);
  } else if (clusterRounds.kind === 'allowed') {
    try {
      const spent = await incrementClusterFixRound(storage, task.id);
      logger.info(
        `Task ${displayId(task)}: cluster fix round ${spent} of ${clusterRounds.budget}.`,
      );
    } catch {
      // Best-effort — an uncounted round fails in the permissive direction and
      // must never reject an unblock that was already allowed.
    }
  }

  phases.end(displayId(task));

  // --- Launch feedback turn ---
  const tRef = taskRef(task);
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);

  phases.announce(unblockPhasePlan(), displayId(task));

  phases.begin(UNBLOCK_PHASES.prepare);

  if (!await pathExists(worktreePath)) {
    // Worktree is gone — try to recover from local or remote branch
    const branchName = sess.git_branch;
    const unblockConfig = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, unblockConfig.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
      // Recreating someone's worktree is a side effect they didn't ask for —
      // say so rather than doing it silently.
      warnings.push(`Worktree was missing, recreated from branch ${branchName}.`);
      if (recovery.dirty) {
        warnings.push('Recovered worktree has uncommitted changes.');
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Check for concurrent session lock
  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Task ${shortId(task.id)} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }

  // Acquire lock
  await acquireLock(worktreePath, 'lazy unblock');

  // Bridge the agent session across a runner boundary if the task switched
  // runners since this session last ran, and stamp the resolved runner.
  await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

  const canResume = !!sess.agent_session_id;
  const containerName = runner.runNameForTask(tRef);

  const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

  try {
    // Restore snapshot if exists
    const snapshot = await storage.getLatestWorktreeSnapshot(sess.id);
    if (snapshot && !await hasUncommittedChanges(worktreePath)) {
      // ONLY THE LAST AGENT TURN'S SNAPSHOT. Nothing ever consumes or
      // supersedes one — `getLatestWorktreeSnapshot` returns the newest ever
      // taken in the session, and one is written only when a turn ends DIRTY.
      // So once a task has had a single dirty turn, that patch stayed the
      // candidate for every later unblock, forever.
      //
      // That was harmless only because the stored patch was unappliable (the
      // trim, fixed in this task). Now that a restore can actually write files,
      // an unbounded candidate is a way to RESURRECT work: a human reads an
      // edit at turn 3, decides against it, reverts the file — and at turn 9 an
      // unblock finds a clean worktree, the old patch still applies, and the
      // discarded edit is back, on its way into the next commit.
      //
      // A snapshot is restorable only while it describes the turn the worktree
      // is still sitting at the end of — the rule lives in
      // `snapshotIsRestorable` (src/task/worktree-snapshot.ts) with the full
      // reasoning. The remaining lifecycle (consume on apply, supersede on a
      // clean turn) is raised separately; this is the bound that must not ship
      // missing now that a restore can actually write files.
      const turns = await storage.getSessionTurns(sess.id);
      const isStale = !snapshotIsRestorable(snapshot.turn_sequence, turns);

      let patch = snapshot.uncommitted_diff;
      patch = patch.replace(/^--- STAGED CHANGES ---\n/gm, '');
      patch = patch.replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      patch = patch.replace(/^--- UNTRACKED FILES ---\n/gm, '');

      if (isStale) {
        logger.debug(
          `Task ${displayId(task)}: worktree snapshot is from turn ${snapshot.turn_sequence}, which ` +
          'a later agent turn has moved past — not restoring it over a worktree that went on without it.',
        );
      } else if (await applyPatch(patch, worktreePath)) {
        warnings.push('Restored uncommitted changes from backup.');
      } else if (await patchIsAlreadyApplied(patch, worktreePath)) {
        // THE COMMON CASE, AND IT IS NOT A FAILURE. The snapshot is from the
        // turn the worktree is still at (the gate above), the agent has since
        // been sent back and committed exactly those edits, and the unblock
        // after that finds a clean worktree and replays a patch whose content
        // is already in HEAD. Git refuses it, correctly.
        //
        // Reported as a loss, that warning sent a whole investigation after the
        // backup mechanism — it appeared on exactly the turns adjacent to work
        // that had gone missing, because it is the echo of that work being
        // COMMITTED. It says nothing now.
        logger.debug(
          `Task ${displayId(task)}: worktree snapshot from turn ${snapshot.turn_sequence} is ` +
          'already in the branch — nothing to restore.',
        );
      } else {
        // A genuine failure: the patch is neither appliable nor already in the
        // branch. Name the files, or the human is told something was lost
        // without being told what — but name them HONESTLY. The status capture
        // lists everything the worktree held; the patch skips an untracked file
        // that was binary or over the capture ceiling, and pointing somebody at
        // a snapshot for content it does not contain is worse than telling them
        // nothing.
        const named = snapshotFiles(snapshot.git_status);
        const stored = new Set(patchPaths(patch));
        const recoverable = named.filter(f => stored.has(f));
        const nameOnly = named.filter(f => !stored.has(f));

        let warning = 'Could not restore uncommitted changes from backup. Continuing without them';
        if (recoverable.length > 0) {
          warning += ` (${recoverable.join(', ')}). They are still in the task's snapshot for turn ${snapshot.turn_sequence}.`;
        } else {
          warning += '.';
        }
        if (nameOnly.length > 0) {
          warning += ` The snapshot records ${nameOnly.join(', ')} by name only — its content was not captured` +
            ' (binary, or over the capture ceiling), so it cannot be restored from the store.';
        }
        warnings.push(warning);
      }
    }

    phases.end();

    // INTAKE BOUNDARY: escape non-printable control characters before this text
    // is persisted or built into a prompt. A raw NUL here becomes argv[2] of
    // `claude -p` and kills the spawn instantly, crash-looping the turn and
    // losing the feedback. Sanitize-and-deliver, never reject — see
    // src/utils/sanitize-text.ts.
    let message = sanitizeUserText(params.message);

    // Protected-file approval is NOT an unblock concern (move-file-approval-to-accept):
    // unblock never reads an approval list and never reverts a file. The agents
    // own per-turn pushback (src/prompts/permission-pushback.md) asks it to revert
    // or justify each violated file while it still has the context, and `lazy
    // accept` stays the one all-or-nothing gate on what finally merges. A task in
    // `conflict` therefore unblocks exactly like a `blocked` one.

    // Optional raised-item resolutions on unblock (partial OK — unlike accept).
    // Never inferred from feedback prose; explicit params only.
    let raisedResolvedNotice: string | null = null;
    // Raised-item comments materialized here ride THIS unblock turn, but the
    // turn number is only claimed later — remember the ids so the delivered
    // turn can be stamped once it is known.
    let raisedDeliveredItemIds: string[] = [];
    {
      // The full input, not just its role: a raised-item decision made on an
      // unblock is as much a decision as one made on the review page, so it
      // records WHICH person made it wherever the caller's token knew.
      const raisedActor = withActorPerson(actorRole(actor) ?? 'human', actor);
      const raised = await applyRaisedResolutions(
        storage,
        task.id,
        displayId(task),
        params.raisedResolutions,
        raisedActor,
        { requireComplete: false },
      );
      warnings.push(...raised.warnings);
      const delivered = await materializePendingRaisedComments(storage, task.id, raisedActor);
      warnings.push(...delivered.warnings);
      raisedDeliveredItemIds = delivered.deliveredItemIds;
      raisedResolvedNotice = buildRaisedResolvedNotice(raised.resolved, displayId(task));
    }

    phases.begin(UNBLOCK_PHASES.feedback);

    // The PROJECT ROOT's config. Everything this turn is governed by —
    // protected patterns, post-turn checks, watchdog guards, maintain groups,
    // model and effort — comes from it, never from the task worktree's own
    // (agent-writable) lazy.toml. See findConfigDir in src/config/loader.ts.
    const config = await loadConfig(projectRoot);

    // Agent / model / effort: `--model`/`--effort` when this unblock names one,
    // otherwise what the previous turn ran on — which is what the task record
    // holds, since an override is persisted there. One rule for every turn
    // type; the ladder and both invariants (edited-task-model-wins,
    // turn-labels-are-not-launch-inputs) live in resolveTurnLaunchIdentity.
    const { model: modelName, effort: effortValue } = await resolveTurnLaunchIdentity({
      storage,
      task,
      config,
      modelOverride,
      effortOverride,
    });
    const modelId = modelName;

    // EXPERIMENTAL Low-high loop: metadata/config only on unblock (the CLI override
    // lives on `lazy start`). When on, the draft effort replaces the task effort
    // for this turn; the review effort rides on the command. Never active on a
    // read-only (plan-mode) turn — there is no draft work to review, and the
    // revise phase must not write in a review Q&A.
    const resolvedLowHighLoop = await resolveAndPersistLowHighLoop(
      // No per-unblock override: `lazy edit --review*` is the mid-flight route,
      // and it writes the same metadata this resolves from — so a change made
      // between turns governs this one without a second flag surface.
      task, undefined, config, storage, effortValue as EffortLevel,
    );
    const lowHighLoop = params.permissionMode !== 'plan' ? resolvedLowHighLoop : undefined;
    const turnEffort = lowHighLoop ? lowHighLoop.draftEffort : effortValue;

    // Determine parent branch (with stale-parent fallback)
    const parentResolution = await resolveParentBranchWithFallback(task, storage, projectRoot, actor);
    let parentBranch = parentResolution.branch;
    if (parentResolution.warnings.length > 0) {
      warnings.push(...parentResolution.warnings);
    }
    // A stale parent chain moved the task's target: its open PR/MR follows
    // (./review-retarget.ts; best-effort, never throws).
    if (parentResolution.retargeted) {
      warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, [task]));
    }

    // Resolve to the ref accept/sync use — NOT the raw branch name. When local
    // parent and origin diverge, merge artifacts match the resolved ref (often
    // origin/<parent>), and violation detection must compare against that ref.
    let upstreamMergeRef: string | undefined;
    if (parentBranch) {
      const upstreamResolution = await resolveUpstreamMergeRefForCommand(
        projectRoot,
        worktreePath,
        parentBranch,
        config,
      );
      warnings.push(...upstreamResolution.warnings);
      if (upstreamResolution.ref) {
        upstreamMergeRef = upstreamResolution.ref;
        parentBranch = upstreamResolution.ref;
      }
    }

    // Parent branch is still passed to the supervisor for context (protected
    // patterns, post-turn sync, etc.) but unblock no longer triggers merge.
    // Use `lazy sync <task>` for upstream merge as a separate operation.

    // Fresh session (agent switch, reopen, or other reset): inject distilled
    // handoff — turn history plus branch orientation. Sessions are not migrated
    // between agents; lazy's turn store + git tree carry the context
    // (docs/spikes/cross-agent-context-handoff.md).
    let turnHistory: string | undefined;
    if (!canResume) {
      const turns = await storage.getSessionTurns(sess.id);
      if (turns.length > 0) {
        try {
          turnHistory = await buildAgentSwitchHandoffContext({
            turns,
            branchName: sess.git_branch,
            gitStartSha: sess.git_start_sha,
            worktreePath,
          });
        } catch (err) {
          // Orientation is best-effort; never block unblock on git/prompt failure.
          // Fall back to turn history alone (still has truncation honesty).
          logger.warn(
            `Task ${displayId(task)}: agent-switch handoff failed (${err instanceof Error ? err.message : String(err)}); falling back to turn history only`,
          );
          turnHistory = buildTurnHistoryContext(turns);
        }
      }
    }

    // Fetch notes.
    //
    // INVARIANT: unblock is a DELIVERY point for comments, and the cutoff for
    // "new" is the last delivery — resolveNotesCutoff, not the last agent turn.
    // `lazy ask` and `lazy sync` record agent turns without delivering notes, so
    // a last-agent-turn cutoff dropped any comment written before one of them.
    // The mark advances only through the notes actually carried, so a comment
    // created while this prompt is being assembled rides the next turn.
    let notesCtx: string | undefined;
    {
      const allNotes = await storage.getTaskComments(task.id);
      if (allNotes.length > 0) {
        const turns = await storage.getSessionTurns(sess.id);
        const { newNotes, deliveredThrough } = selectNotesForDelivery(
          allNotes,
          resolveNotesCutoff(sess, turns),
        );
        if (newNotes.length > 0) {
          // `notesInEditor` means the human already read these notes in their
          // editor and their feedback text carries them — delivered either way,
          // so the mark advances in both branches. Not advancing it here would
          // re-deliver the same notes on every subsequent editor unblock.
          if (!params.notesInEditor) notesCtx = buildNotesContext(newNotes);
          if (deliveredThrough !== null) await storage.markNotesDelivered(sess.id, deliveredThrough);
        }
      }
    }

    // Journal notice — a COUNT of new entries, never their content. Deliberately
    // NOT gated on notesInEditor: that flag means the human already read the
    // notes in their editor, which says nothing about the journal.
    //
    // The last-agent-turn cutoff is deliberate here, unlike notes above: nothing
    // is consumed by showing a count, and every entry stays readable on demand
    // via lazy_show(sections=["journal"]). An undercount after an ask or sync
    // loses nothing; a dropped comment would lose human feedback.
    let journalNotice: string | undefined;
    {
      const allJournal = await storage.getTaskJournal(task.id);
      if (allJournal.length > 0) {
        const turns = await storage.getSessionTurns(sess.id);
        const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
        const newEntries = lastAgentTurn
          ? getNewJournalSince(allJournal, lastAgentTurn.timestamp)
          : allJournal;
        journalNotice = buildJournalNotice(newEntries.length, allJournal.length, task.code ?? shortId(task.id)) || undefined;
      }
    }

    // Artifact notice — names and sizes of the files setupSandbox materialized
    // into the worktree for this turn. Never their content.
    const artifactNotice =
      buildArtifactNotice(await storage.listTaskArtifacts(task.id), task.code ?? shortId(task.id)) || undefined;

    // Sync with remote
    const syncResult = await runSyncWithRemote(task, sess, projectRoot, storage, worktreePath);
    const remoteCommentsCtx = syncResult.remoteCommentsCtx;

    // --- Batch queued web review comments into this turn ---
    // A reviewer who marked up the diff on /review/:id queued comments in
    // delivery_state 'pending_delivery'. They ride the NEXT unblock work turn
    // whatever surface launches it — web, CLI, or MCP — as one batch wrapped
    // around the feedback message; a comment never becomes a turn on its own.
    // Skipped on plan-mode (read-only Q&A) turns: those cannot act on change
    // requests, and marking a comment delivered into one would be a lie.
    // Delivery is stamped only after the turn actually launches, further down.
    // Sanitized like the feedback itself: comment content becomes part of the
    // agent argv at the delivery seam, where a raw NUL is fatal.
    let pendingReviewComments: ReviewComment[] = [];
    if (params.permissionMode !== 'plan') {
      const allReviewComments = await storage.getTaskReviewComments(task.id);
      pendingReviewComments = allReviewComments.filter(isPendingDelivery);
      if (pendingReviewComments.length > 0) {
        message = sanitizeUserText(
          buildUnblockPrompt(pendingReviewComments, allReviewComments, message),
        );
        warnings.push(
          `Also delivering ${pendingReviewComments.length} queued review comment(s) from the web review page with this unblock.`,
        );
      }
    }

    if (raisedResolvedNotice) {
      message = `${raisedResolvedNotice}\n\n---\n\n${message}`;
    }
    // A cluster's constraints hold on EVERY turn it takes, not just its first —
    // the daemon enforces the other half of that contract
    // (restart-on-added-child). See src/task/type-constraints.ts.
    message = typeConstraintsSection(task) + message;

    // Build prompts
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }), await buildLazyMdSection(worktreePath));
    const fullMessage = buildPromptWithInstructions(message.trim(), task.goal, projectRoot, turnHistory, notesCtx, remoteCommentsCtx, journalNotice, artifactNotice);

    // --- Persist state and claim the task (serialized) ---
    // CONCURRENCY: the status checks at the top of this function are advisory —
    // runner preflight, worktree recovery and runSyncWithRemote sit between them
    // and this point, so the task may have been claimed since. The daemon runs
    // ask, sync and auto-delivery in the SAME process, and the worktree lock does
    // not separate them (checkLock is re-entrant by pid), so without this lock a
    // second dispatcher can land here mid-ask — and `writeCommand` DELETES any
    // pending response.json, destroying an answer the human is still waiting for.
    // Re-read the status inside the lock and bail BEFORE recording the feedback
    // turn, so a lost race leaves no half-dispatched turn behind (the caller
    // keeps the human's typed feedback and can retry).
    const claim = await withTaskLifecycleLock(task.id, async () => {
      const fresh = await storage.getTask(task.id);
      if (!fresh) {
        throw new RpcError(404, `Task not found: ${params.taskId}`);
      }
      if (params.permissionMode === 'plan' && fresh.status !== 'blocked') {
        throw new RpcError(409,
          `Task ${displayId(task)} is '${fresh.status}', not 'blocked'. ` +
          `Review questions only run while the task is blocked — the agent may have picked up autonomous work. Retry once it's blocked again.`,
        );
      }
      // Unblock is only semantically valid from these four statuses; other live
      // statuses are handled above (working/pairing/merging) or caught by the
      // ended_at check (terminal). A `backlog` task is "never started" — the
      // right command is `lazy start`, not unblock.
      if (fresh.status !== 'blocked' && fresh.status !== 'conflict' && fresh.status !== 'submitted' && fresh.status !== 'interrupted') {
        throw new RpcError(409,
          `Task ${displayId(task)} became '${fresh.status}' while the unblock was being prepared. ` +
          `Nothing was delivered — retry once it is paused again.`,
        );
      }
      // A member working in the task keeps turns off it. Refused BEFORE the
      // feedback turn is recorded, so nothing is half-dispatched.
      assertNoMemberInside(task.id);

      const nextSeq = await storage.getNextTurnSequence(sess.id);
      await storage.createTurn({
        sessionId: sess.id,
        sequence: nextSeq,
        role: 'human',
        content: message.trim(),
        agent: task.agent_id,
        model: modelName,
        effort: turnEffort,
        prompt: fullMessage,
        // Channel actor: MCP-relayed feedback is 'builder' even when it carries a
        // human's words — the actor records who submitted (the channel), not who
        // authored the content. Falls back to getActor() for CLI. See MCP_ACTOR.
        actor,
        // INVARIANT: this turn IS the human's feedback. If the work phase crashes
        // before the agent consumes it, resume must re-deliver it verbatim.
        carriesFeedback: true,
      });

      // Transition to working. The transition itself is validated against the
      // canonical table in src/task-state-machine.ts inside updateTaskStatus.
      // Bind this turn's credential BEFORE the status flip and the command write:
      // a supervisor that outlived its daemon acts on the command the moment it
      // lands, and must never start a turn on a revoked binding. See
      // prepareTurnLaunch in src/daemon/turn-credentials.ts.
      const { mustRecreateContainer } = await prepareTurnLaunch(projectRoot, {
        taskId: task.id,
        sessionId: sess.id,
        storage,
      });

      await storage.updateTaskStatus(task.id, 'working', actor);

      phases.end(`turn ${Math.floor(nextSeq / 2) + 1}`);

      phases.begin(UNBLOCK_PHASES.launch);

      // --- Write command and launch/reuse supervisor ---
      const protoDir = getProtocolDir(task.id);
      ensureProtocolDir(protoDir);

      const autoSyncAfterTurn = isFeatureEnabled('auto_sync_after_turn', config);

      const unblockCommand: UnblockCommand = {
        type: 'unblock',
        task_id: task.id,
        goal: task.goal,
        prompt: fullMessage,
        agent_id: task.agent_id,
        harness,
        system_prompt: systemPrompt,
        model_id: modelId,
        effort: turnEffort,
        agent_session_id: canResume ? sess.agent_session_id! : undefined,
        parent_branch: parentBranch ?? undefined,
        upstream_merge_ref: upstreamMergeRef,
        sync_before_work: false,
        sync_after_work: autoSyncAfterTurn && !isLinkedTask(task),
        remote_branch: syncResult.remoteBranch,
        permission_mode: params.permissionMode,
        ...(lowHighLoop ? { low_high_loop: { review_effort: lowHighLoop.reviewEffort } } : {}),
        // The wrap-up plan rides every work command: finality is declared DURING
        // the turn, after this write, so it cannot be sent later (§3.3).
        ...(await resolveWrapUpCommandFields({
          storage,
          task,
          sessionId: sess.id,
          session: sess,
          projectRoot,
          worktreePath,
          config,
        })),
        ...commonCommandFields(config),
      };
      writeCommand(protoDir, unblockCommand);

      return { nextSeq, mustRecreateContainer, protoDir };
    });
    const { nextSeq, mustRecreateContainer, protoDir } = claim;

    // --- Generate daemon MCP config ---
    // The daemon knows its own webPort — no health check, no fallback.
    let daemonConfigPath: string | null = null;
    // Skip when running outside the daemon (in-process RPC fallback) — there is
    // no daemon for the container to connect to, and getDaemonContext() throws.
    // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Launch or reuse supervisor
    const mustRecreateForAgent = mustRecreateForContainerAgent(sess, task.agent_id);
    if (mustRecreateForAgent) {
      phases.note(
        `recreating container: agent changed ` +
        `(${sess.container_agent_id} → ${task.agent_id}) — launch env is fixed at create time`,
      );
    }
    if (!mustRecreateContainer && !mustRecreateForAgent && (await runner.isRunning(containerName))) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
      phases.note(`reusing running container ${containerName}`);
    } else {
      await removeTaskRun(runner, storage, sess, containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, task.id, pinnedCustomImage(task), phases.notify);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', actor);
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName, task.agent_id);
    sess.container_agent_id = task.agent_id;
    await storage.updateSessionInteraction(sess.id, 0);

    const turnNumber = Math.floor(nextSeq / 2) + 1;

    // The turn carrying the materialized raised-item comments now has a
    // number — stamp it so review surfaces can say "delivered in turn N"
    // instead of only a timestamp. Best-effort: the comments themselves are
    // already durable, so a failed stamp only degrades the display.
    for (const itemId of raisedDeliveredItemIds) {
      try {
        await storage.markRaisedItemCommentDelivered(task.id, itemId, {
          delivered_turn: turnNumber,
        });
      } catch (err) {
        logger.error(
          `Could not stamp delivered turn on raised item ${itemId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Batched review comments are delivered — and only now, because the turn
    // actually launched (a failed launch threw above and left them pending, so
    // they ride the next unblock instead). Exactly the comments read into the
    // prompt are stamped: one posted since that read stays pending. Best-effort
    // like the raised-item stamp — the agent has the comment either way; a
    // failed write only risks a re-delivery next unblock, so log loudly.
    for (const c of pendingReviewComments) {
      try {
        await storage.updateReviewComment(task.id, c.id, {
          deliveryState: 'delivered',
          deliveredTurn: turnNumber,
          deliveredAt: Date.now(),
        });
      } catch (err) {
        logger.error(
          `Delivered review comment ${c.id} but could not mark it delivered: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    phases.end(containerName);

    // Delivered: the feedback is a turn now, so the draft of it must go — for
    // EVERY client, not just the review page that used to clear it.
    if (params.permissionMode !== 'plan') {
      if (!params.keepFeedbackDraft) await clearDeliveredReviewDraft(task.id, params.callerReviewerKey, actor, 'unblock');
      // Same moment, same reason — but only when a human actually submitted a
      // review here (`filesReview`). A daemon-started unblock delivers no
      // review, so it files nothing.
      if (params.filesReview) await fileReviewAsks(task.id, 'unblock');
    }

    return {
      sessionId: sess.id,
      containerName,
      worktreePath,
      branchName: sess.git_branch,
      turnNumber,
      runnerType: runner.type,
      runnerLabel: runner.runLabel,
      runnerDisplayName: runner.runDisplayName(containerName),
      warnings,
      deliveredReviewComments: pendingReviewComments.length,
    };
  } finally {
    await removeLock(worktreePath);
  }
}

// =====================================================================
// Ask Task (read-only Q&A against the agent session)
// =====================================================================

export interface AskTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  message: string;
  effortOverride?: string;
  /** Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface AskTaskResult {
  /**
   * `answered` — the whole answer is in this result and nothing is running.
   * Only the RECORD route ever returns it: a task whose live session cannot be
   * resumed is answered from what lazy stored, with no container involved.
   *
   * `started` — an agent turn is now in flight. The answer will land as an
   * `ask` turn at {@link turnSequence}; wait for it (`lazy wait`, or
   * {@link awaitClaimedTurn} on a surface that keeps a blocking UX) and read it
   * off the task. There is NO ceiling on that turn.
   */
  outcome: 'answered' | 'started';
  taskId: string;
  displayId: string;
  sessionId: string;
  /** Sequence the agent's answer will occupy. `started` only. */
  turnSequence?: number;
  /** Run the turn was launched in, so a caller can name it. `started` only. */
  containerName?: string;
  /**
   * Session turn number of the answering turn.
   *
   * Absent on a record-derived answer, which records no turn at all: an ended
   * session must not grow new turns, and a number invented for one would put a
   * turn on the page that does not exist in the session.
   */
  turnNumber?: number;
  /** The answer itself. `answered` only — a `started` ask has none yet. */
  answer?: string;
  /**
   * Where the answer came from: the agent's resumed live session, or the task's
   * stored record. Surfaces MUST show this — an answer read off the record must
   * never read as the live agent looking at a live worktree.
   */
  derivedFrom?: 'live-session' | 'stored-record';
  /** The sentence saying so, when `derivedFrom` is not the live session. */
  provenance?: string | null;
  usage?: TokenUsage;
  warnings: string[];
  /**
   * Latency breakdown (ms) for LAZY_VERBOSE telemetry. Populated even if the
   * supervisor didn't report agent_duration_ms (agent_ms will be undefined).
   *
   *   daemon_ms:  wall-clock of the daemon handler (entry → return)
   *   wait_ms:    time spent waiting for the agent (0 on a `started` ask, whose
   *               handler returns before the agent has done anything)
   *   agent_ms:   claude's own process time (from supervisor response)
   *
   * The CLI subtracts these from its total wall-clock to derive RPC and
   * supervisor overheads.
   */
  timings: {
    daemon_ms: number;
    wait_ms: number;
    agent_ms?: number;
  };
}

// =====================================================================
// Claimed turns: claim, settle, wait
// =====================================================================
//
// `ask` and `review` are the turns the daemon runs outside the ordinary
// fire-and-forget reconciliation, because each has a RESERVED turn sequence its
// answer must occupy. Both are ASYNCHRONOUS: the RPC starts the turn and
// returns, the answer lands as a turn of that type, and the caller waits for it
// (`lazy wait`, or `awaitClaimedTurn` for the CLI and web surfaces that keep a
// blocking UX).
//
// The MECHANICAL acceptance gate (see the section below) is synchronous too —
// `lazy accept` blocks on its verdict — but claims NOTHING: it records no turn,
// so there is no sequence to reserve and no record to settle. Its wait polls
// the gate's dedicated protocol dir directly (waitForSupervisorResponse).
//
// THERE IS NO CEILING ON AN ASK OR A REVIEW. A review of a large diff at high
// effort routinely runs 6–8 minutes, and the 10-minute ceiling this replaced
// did not merely time the RPC out: it tore the reviewer's container down and
// then left the task waiting for the answer that container was going to write,
// stranded in `working` with no live substate until a human ran `lazy stop`.
// The supervisor's no-progress watchdog is the guard against a hung reviewer,
// as it is for every work turn; run liveness is the guard against one that died
// without writing anything (see `abandonDeadClaimedTurn`).
//
// The helpers below are that mechanism end to end:
//
//   claimSyncTurn   — reserve the two turn sequences the exchange will occupy
//                     and record an InFlightTurn on the task, BEFORE the
//                     command is written, so no other writer can move the task
//                     underneath the turn.
//   settleInFlightTurnFromProtocol — consume `response.json`, record the turn
//                     at the RESERVED sequence, and write the outcome onto the
//                     record. For ask/review it also finishes the turn off:
//                     restore the status, clear the claim, drop the review
//                     mailbox and tear its run down. Called by the reconciler
//                     (the single reader of `response.json`), and by a waiter
//                     when there is no reconcile loop at all.
//   awaitInFlightOutcome — the liveness-aware wait on the RECORD's outcome.
//                     Only the wrap-up turn (finalize) uses it now; ask and
//                     review wait on the recorded TURN instead (see
//                     awaitClaimedTurn), which is durable and readable long
//                     after the claim is gone.

/**
 * Slack between a synchronous wait's own budget and the deadline stamped on its
 * in-flight record. The record must outlive the wait: expiring first would let
 * the reconciler treat a turn that is still legitimately running as debris.
 */
const IN_FLIGHT_CLAIM_MARGIN_MS = 2 * 60 * 1000;

interface SyncTurnClaim {
  /** Reserved sequence for the human/marker turn that opens the exchange. */
  humanSeq: number;
  /** Reserved sequence the agent's answer must occupy. */
  agentSeq: number;
  /** Correlation id written on the command and echoed on the response. */
  commandId: string;
  record: InFlightTurn;
}

/**
 * Reserve this exchange's turn sequences and claim the task's protocol slot.
 *
 * WHY RESERVE. `getNextTurnSequence` allocates at WRITE time — it reports the
 * next free sequence, it does not hold one. "My answer will be turn N+1" was
 * therefore identity by convention: any turn written in between took the
 * number, and the correlation silently pointed at someone else's turn.
 * `reserveTurnSequences` hands out a range and records it on the session, so
 * the answer's sequence is fixed before the command is even written.
 *
 * An aborted turn leaves its reserved agent sequence unused — a hole in the
 * numbering. That is deliberate: the sequence was promised to an answer that
 * may still arrive late, and reusing it would let that late answer be mistaken
 * for the next turn.
 */
async function claimSyncTurn(
  storage: Storage,
  task: Task,
  session: Session,
  opts: {
    owner: InFlightTurnOwner;
    turnType: TurnType;
    restoreStatus: TaskStatus;
    /**
     * How long the record speaks for the task. For the wrap-up turn this is
     * the waiter's own budget plus {@link IN_FLIGHT_CLAIM_MARGIN_MS}; for the
     * asynchronous ask/review it is {@link IN_FLIGHT_ASYNC_BACKSTOP_MS}, which
     * is a debris backstop and not a ceiling.
     */
    ttlMs: number;
    reviewFollowUp?: InFlightTurn['review_follow_up'];
  },
): Promise<SyncTurnClaim> {
  const first = await storage.reserveTurnSequences(session.id, 2);
  const now = Date.now();
  const commandId = newCommandId();
  // WHO ASKED, captured HERE rather than read back when this turn's ending is
  // recorded. An abandoned or stopped claim is settled by whoever ticks next,
  // and by then the session may belong to a later turn with a different owner
  // (src/daemon/turn-owner.ts). The claim is per turn, so it keeps the answer.
  const person = pendingTurnOwnerPerson(task.id);
  const record: InFlightTurn = {
    session_id: session.id,
    owner: opts.owner,
    turn_type: opts.turnType,
    command_id: commandId,
    turn_sequence: first + 1,
    human_turn_sequence: first,
    ...(person ? { turn_owner_email: person.email } : {}),
    ...(person?.name ? { turn_owner_name: person.name } : {}),
    restore_status: opts.restoreStatus,
    started_at: now,
    expires_at: now + opts.ttlMs,
    // Which process made it: a claim a LATER daemon finds can never finish
    // (its run's proxy died with this process) — see claimMadeByThisProcess.
    claimed_by_process: CLAIMING_PROCESS_ID,
    ...(opts.reviewFollowUp ? { review_follow_up: opts.reviewFollowUp } : {}),
  };
  const claimed = await storage.beginInFlightTurn(task.id, record);
  if (!claimed) {
    const current = await storage.getTask(task.id);
    const held = current?.in_flight_turn;
    throw new RpcError(409,
      `Task ${displayId(task)} already has a synchronous turn in flight` +
      `${held ? ` (${held.owner})` : ''} — wait for it to finish, then retry.`,
      // Somebody else's turn owns the task: transient, and the retry is the
      // caller's next tick. See RpcErrorCode.
      'task_busy',
    );
  }
  return { humanSeq: first, agentSeq: first + 1, commandId, record };
}

/** What a settle attempt did, for the reconciler's benefit. */
export type InFlightSettleVerdict =
  /** Nothing to do — no response yet, or the record is already settled. */
  | 'none'
  /** The response was this turn's answer (or its crash); the record now carries an outcome. */
  | 'settled'
  /**
   * A completed response arrived that is NOT this turn's answer. The record is
   * settled `foreign` so the waiter aborts, and `response.json` is deliberately
   * left in place — it is some other command's turn and belongs in the ordinary
   * reconciliation path, not filed under this record's heading.
   */
  | 'foreign';

/**
 * Settle a task's in-flight turn against whatever the supervisor has written.
 *
 * This is the ONE implementation of "turn a synchronous turn's response into
 * task state" — single reader by implementation, invoked by whoever ticks first.
 * Two callers drive it: the reconcile tick, and the waiter on each of its own
 * polls. The waiter drives it because otherwise the 5s reconcile interval would
 * become the floor on every `lazy ask`'s latency; `withSettleLock` makes the
 * two mutually exclusive (both run in one process — see its doc), and the
 * `record.outcome` early exit makes the loser a no-op.
 */
export async function settleInFlightTurnFromProtocol(
  storage: Storage,
  task: Task,
  session: Session,
  record: InFlightTurn,
  worktreePath: string,
  /**
   * Project root, so a settled REVIEW can finish itself off: tear its ephemeral
   * run down, post findings to the PR, and start the auto-fix turn. Omitted by
   * callers that cannot be the last word (none today) — the follow-up is then
   * skipped with a warning rather than half-run.
   */
  projectRoot?: string,
): Promise<InFlightSettleVerdict> {
  const verdict = await withSettleLock(task.id, () =>
    settleInFlightTurnLocked(storage, task, session, record, worktreePath));

  // Exactly one caller ever observes 'settled' for a given record — the lock
  // serializes them and the `record.outcome` early exit makes every loser a
  // no-op — so the follow-up runs exactly once. Outside the lock deliberately:
  // it posts to a forge and may launch a whole work turn.
  if (verdict === 'settled' && record.owner === 'review') {
    // Registered BEFORE it is awaited, with no await in between, so a waiter in
    // this same process can never observe the review turn without also seeing
    // that its follow-up is still running. Deliberately NOT inside the settle
    // lock: this posts to a forge and can launch a whole auto-fix turn, and the
    // reconcile tick must not queue behind a slow remote for that.
    const followUp = finishSettledReview(storage, task, record, projectRoot);
    reviewFollowUps.set(task.id, followUp);
    try {
      await followUp;
    } finally {
      if (reviewFollowUps.get(task.id) === followUp) reviewFollowUps.delete(task.id);
    }
  }
  return verdict;
}

/**
 * In-progress review follow-ups (PR posting, auto-fix), by task id.
 *
 * A waiter awaits this before reading the review turn back, so `lazy review`
 * still prints where the findings landed even when the RECONCILER — not the
 * waiter — was the one that settled the turn. Process-local and short-lived:
 * losing it costs a caller the posting note, never the posting.
 */
const reviewFollowUps = new Map<string, Promise<void>>();

async function settleInFlightTurnLocked(
  storage: Storage,
  task: Task,
  session: Session,
  record: InFlightTurn,
  worktreePath: string,
): Promise<InFlightSettleVerdict> {
  if (record.outcome) return 'none';

  // Re-read under the lock: the caller's copy of the record may predate a
  // settle that already ran, and settling twice would double-record the turn.
  const held = (await storage.getTask(task.id))?.in_flight_turn;
  if (held && held.turn_sequence === record.turn_sequence && held.outcome) return 'none';

  // Review uses a sibling mailbox so a live work supervisor cannot observe
  // (or consume) the review command. Every other owner reads the work dir.
  const protoDir = record.owner === 'review'
    ? reviewProtocolDir(task.id)
    : getProtocolDir(task.id);
  const response = readResponse(protoDir);
  if (!response) return 'none';

  const settledAt = Date.now();

  // Command↔response correlation: the protocol dir is still a single unaddressed
  // slot. A command written before the claim can still land its answer here, and
  // an ask response has no other payload discriminator. Version skew: a response
  // without command_id is never a positive match — a legacy `pre_accept` record
  // falls through to its abandon branch below.
  const correlation = inFlightResponseCorrelates(response, record.command_id);
  if (correlation === 'mismatch') {
    await storage.settleInFlightTurn(task.id, record.turn_sequence, {
      kind: 'foreign',
      message:
        'the response command id did not match the in-flight turn, so nothing was attributed to it',
      settled_at: settledAt,
    });
    // A foreign response is the end of an ask/review too: nobody will attribute
    // an answer to this claim now, and leaving it live would hold the task in
    // `working` until the backstop.
    await releaseAsyncClaim(storage, task.id, record);
    return 'foreign';
  }
  if (correlation === 'uncorrelated' && (record.owner === 'ask' || record.owner === 'review')) {
    return 'none';
  }

  // INVARIANT (retirement): a record whose owner is in RETIRED_IN_FLIGHT_OWNERS
  // is always legacy, and there is nobody left who can settle it.
  //
  //   - `pre_accept`: the pre-accept agent turn was replaced by the mechanical
  //     acceptance gate at accept. Its response carries a gate result that would
  //     validate a merge no daemon here performed.
  //   - `wrap_up`: the standalone wrap-up turn behind `lazy finalize` is gone —
  //     the closing steps run inside the turn that ends the work. Its response
  //     carries steps for a command this daemon no longer issues.
  //
  // Either way: abandon it. Consume the response, restore the task, release the
  // record, and log the retirement. NOTHING is recorded as a turn, and no
  // outcome is filed on the record — the release in the same breath would
  // delete it unread, which is what the warn says instead.
  //
  // This branch sits BEFORE the error/completed dispatch and owns every
  // response shape: while a record is live, all other writers are excluded, so
  // whatever the slot holds is that retired exchange's own output — even a
  // response with no command_id, which no positive-correlation check can claim.
  if (RETIRED_IN_FLIGHT_OWNERS.includes(record.owner)) {
    consumeResponse(protoDir);
    clearStatus(protoDir);
    const current = await storage.getTask(task.id);
    if (current?.status === 'working') {
      await storage.updateTaskStatus(task.id, record.restore_status, 'system');
    }
    await releaseAsyncClaim(storage, task.id, record);
    logger.warn(
      `Task ${displayId(task)}: a legacy ${record.owner} in-flight record was abandoned — ` +
      `that turn type is retired. The response it answered was consumed without ` +
      `being recorded; re-run the command that wanted it.`,
    );
    return 'settled';
  }

  let outcome: InFlightTurnOutcome;
  let restoreStatus = true;

  if (response.status === 'error') {
    if (correlation !== 'match') return 'none';
    if (record.owner === 'ask') {
      // recordAskErrorTurn deliberately parks the task `interrupted` so the
      // crashed ask is auto-resumable; do not restore over that.
      await recordAskErrorTurn(storage, task.id, session.id, response, protoDir, record.turn_sequence);
      restoreStatus = false;
    } else if (record.owner === 'review') {
      // A failed review is not work: record the error turn and restore the
      // status the review found (submitted stays submitted). Parking
      // `interrupted` would let auto-resume launch a work turn.
      await recordReviewErrorTurn(
        storage, session.id, task.id, response, protoDir, record.turn_sequence,
        record.review_follow_up?.auto_review ? 'auto' : 'manual',
      );
    } else {
      consumeResponse(protoDir);
      clearStatus(protoDir);
    }
    outcome = { kind: 'error', message: response.error ?? 'unknown error', settled_at: settledAt };
  } else {
    const completed = completedResponses(response)[0];

    if (record.owner === 'ask') {
      await recordAskCompletedTurn(storage, session, completed, protoDir, record.turn_sequence);
    } else {
      await recordReviewCompletedTurn(
        storage, session, task.id, completed, protoDir, record.turn_sequence,
        record.review_follow_up?.auto_review ? 'auto' : 'manual',
      );
    }
    outcome = {
      kind: 'completed',
      turn_sequence: record.turn_sequence,
      result: completed.result,
      usage: completed.usage,
      agent_duration_ms: completed.agent_duration_ms,
      settled_at: settledAt,
    };
  }

  await storage.settleInFlightTurn(task.id, record.turn_sequence, outcome);

  // Restore the status here, not in a waiter: an asynchronous ask/review has no
  // RPC caller left to do it, and a task in `working` with no turn running is
  // the stranded state this whole mechanism exists to prevent.
  if (restoreStatus) {
    const current = await storage.getTask(task.id);
    if (current?.status === 'working') {
      await storage.updateTaskStatus(task.id, record.restore_status, 'system');
    }
  }
  await releaseAsyncClaim(storage, task.id, record);
  return 'settled';
}

/**
 * Drop a claim and its mailbox now that the turn has ended.
 *
 * EVERY owner releases here, and the exclusion list that used to sit at the top
 * is gone. It existed for one reason: `lazy finalize`'s wrap-up turn was
 * synchronous and its RPC caller read the OUTCOME off the record, so releasing
 * early would have deleted the answer it was waiting for. That command is
 * retired, so no such waiter exists — a legacy `wrap_up` record reaching the
 * abandon branch was being consumed and then left behind, holding the task's
 * in-flight slot until its TTL expired and blocking auto-resume for that whole
 * window. `pre_accept` is retired for the same reason, and its gate always
 * waited on the response FILE rather than a record.
 *
 * Ask and review wait on the recorded TURN instead — durable, and written
 * before the outcome — so nothing is lost by releasing immediately, and holding
 * the claim would keep a finished review blocking every dispatcher for another
 * minute.
 */
async function releaseAsyncClaim(
  storage: Storage,
  taskId: string,
  record: InFlightTurn,
): Promise<void> {
  try {
    await storage.clearInFlightTurn(taskId, record.turn_sequence);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: failed to clear the in-flight ${record.owner} record — ` +
      `it will expire on its own. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (record.owner === 'review') {
    try {
      removeProtocolDir(reviewProtocolDir(taskId));
    } catch (err) {
      logger.warn(
        `Task ${taskId.substring(0, 8)}: failed to clear the review protocol dir: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Wait for THIS turn's outcome, aborting early if the supervisor dies.
 *
 * Polls storage the way `lazy wait` polls task status — but where `lazy wait`
 * can only see "the task left `working`", this sees "the turn at MY reserved
 * sequence settled", which is the distinction the whole task exists to make.
 */
async function awaitInFlightOutcome(opts: {
  storage: Storage;
  task: Task;
  session: Session;
  record: InFlightTurn;
  worktreePath: string;
  runner: Runner;
  runName: string;
  timeoutMs: number;
  alreadyRunning: boolean;
}): Promise<SupervisorAnswerOutcome<InFlightTurnOutcome>> {
  const { storage, task, session, record, worktreePath } = opts;
  return waitForSupervisorAnswer<InFlightTurnOutcome>({
    runner: opts.runner,
    runName: opts.runName,
    timeoutMs: opts.timeoutMs,
    intervalMs: 500,
    alreadyRunning: opts.alreadyRunning,
    readAnswer: async () => {
      // Drive the settle from here as well as from the reconcile tick. Waiting
      // for the tick alone would put a 5s floor under every ask; and with no
      // daemon (the in-process RPC fallback) there is no tick at all, so this
      // is the ONLY settler. The call is serialized against the reconciler and
      // is a no-op once the record is settled, so driving it is always safe.
      try {
        await settleInFlightTurnFromProtocol(storage, task, session, record, worktreePath);
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to settle the in-flight ${record.owner} turn: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const fresh = await storage.getTask(task.id);
      const held = fresh?.in_flight_turn;
      // Correlate: only an outcome recorded against MY reserved sequence is my
      // answer. Anything else means the slot was taken over.
      if (held && held.turn_sequence === record.turn_sequence && held.outcome) {
        return held.outcome;
      }
      return null;
    },
  });
}

/**
 * START a read-only "ask turn" against an existing agent session.
 *
 * ASYNCHRONOUS. This returns as soon as the question is durably recorded and
 * the agent has been launched; the answer lands as an `ask` turn at the
 * reserved sequence and is waited for separately (`lazy wait`, or
 * {@link awaitClaimedTurn}). There is no ceiling — see the section header above
 * for why the 10-minute one was removed rather than raised.
 *
 * The one exception is the RECORD route, which returns `outcome: 'answered'`
 * with the answer in hand: it starts nothing, so there is nothing to wait for.
 *
 * Unlike unblock, an ask:
 *   - Always runs in plan mode (read-only, no writes, no commits).
 *   - Skips all integration machinery: no upstream sync, no pre/post-turn
 *     merge, no violation detection, no post-turn check.
 *   - Rejects with 409 unless the task is 'blocked' or 'conflict' (an ask only
 *     makes sense against a paused, reviewable task; 'conflict' is a blocked
 *     variant). The pre-ask status is restored when the ask completes, so a
 *     read-only ask never mutates task state.
 *   - Is daemon-owned end-to-end: the daemon — through the reconciler — is the
 *     single reader of response.json and the only writer of the answering turn,
 *     so no client polls the protocol dir or races the reconciler.
 *
 * CONCURRENCY (fix: investigate-merge-and-fix-on-ask). Two daemon-internal
 * writers used to be able to stomp an ask mid-flight, because the guards that
 * looked like mutual exclusion are not:
 *
 *   - The worktree lock is RE-ENTRANT BY PID, and the ask handler, the
 *     reconcile loop, and the auto-sync signal delivery all run in the SAME
 *     daemon process — so it excluded nobody here.
 *   - The `blocked`/`conflict` status gate is a check-then-act with a long tail
 *     of awaits (config load, runner availability, credential prep, container
 *     launch) before the ask command lands.
 *
 * A concurrent `syncTask` — whose own status check happens BEFORE a network
 * fetch of the upstream ref — would clear that gate, then call `writeCommand`,
 * which DELETES response.json. Landing during the ask that silently destroyed
 * the agent's answer and queued a sync turn, so the reviewer saw the phase jump
 * from answering to `merge_and_fix` and their question was never answered.
 *
 * Two things fix it: the dispatch section below runs under
 * `withTaskLifecycleLock` and re-reads the task's status INSIDE the lock (so a
 * sync that queued behind us observes `working` and refuses), and the durable
 * in-flight turn record claimed inside that lock (see
 * `src/daemon/in-flight-turn.ts`) keeps the reconciler off our response.json.
 * The handler now returns at the end of that critical section, so the lock is
 * held only for the dispatch — never for the agent's whole thinking time.
 */
export async function launchAskTask(
  projectRoot: string,
  params: AskTaskParams,
): Promise<AskTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'ask');
  try {
    return await launchAskTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function launchAskTaskRun(
  projectRoot: string,
  params: AskTaskParams,
  phases: PhaseReporter,
): Promise<AskTaskResult> {
  const daemonStart = Date.now();
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  phases.begin(ASK_PHASES.preflight);

  // --- Resolve task ---
  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  // --- Route: live session, or the task's stored record ---
  //
  // The checks below (session, agent session id, worktree, status) used to be
  // four separate refusals. They are now ONE routing decision, taken by the
  // rule every ask surface shares (`resolveAskAvailability`): when the agent's
  // live session can be resumed we resume it, and when it cannot — the ordinary
  // state of a finished task — the question is answered from what lazy stored
  // instead of being refused with advice a completed task can never follow.
  //
  // The record route returns from here: it takes no worktree lock, creates no
  // turn, and never touches the task's status. See src/task/record-ask.ts.
  const availability = resolveAskAvailability(await buildAskContext(storage, task, { projectRoot }));
  if (availability.unavailable) {
    throw new RpcError(409, `Task ${displayId(task)}: ${availability.unavailable}`);
  }
  if (availability.route === 'record') {
    // --- Usage pause ([usage_pause]) ---
    // INVARIANT: an ask is somebody's question, so a paused credential REFUSES
    // it before anything runs. The record route runs a machine one-shot on the
    // builder role's credential, so that is the one judged.
    await assertBesideLaunchAllowed(projectRoot, {
      config: await loadConfig(projectRoot), actor, what: `the ask of ${displayId(task)}`,
      overrideEligible: params.usagePauseOverrideEligible === true,
    });
    phases.end(displayId(task));
    phases.announce(askPhasePlan('record'), displayId(task));
    phases.begin(ASK_PHASES.read_record);
    const record = await askTaskRecord(projectRoot, storage, task, sanitizeUserText(params.message).trim(), {
      onProgress: (message) => phases.note(message),
    });
    phases.end();
    return {
      outcome: 'answered',
      taskId: task.id,
      displayId: displayId(task),
      sessionId: (await storage.getSessionByTaskId(task.id))?.id ?? '',
      answer: record.answer,
      usage: record.usage,
      warnings: [...warnings, ...record.warnings],
      derivedFrom: 'stored-record',
      provenance: availability.provenance,
      timings: { daemon_ms: Date.now() - daemonStart, wait_ms: 0 },
    };
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }
  // Bound to a const so the null check narrows inside the dispatch closure below
  // (TS does not carry narrowing of a mutable property across a callback).
  const agentSessionId = sess.agent_session_id;
  if (!agentSessionId) {
    throw new RpcError(409, `Task ${displayId(task)} has no agent session to resume — cannot ask until the agent has run at least once.`);
  }

  // --- Status gate: only ask a task that's blocked or conflict ---
  // An ask is read-only (plan-mode resume, no worktree/commit changes), so it
  // is safe against any paused, reviewable task. `conflict` is a blocked
  // variant ("blocked, with a protected-file conflict to resolve") and must be
  // askable too — forcing the reviewer to unblock just to ask a question is a
  // surprise. The daemon may autonomously flip these → working at any moment
  // (CI trigger, comment arrival, upstream sync); if that race loses, the
  // reviewer must retry; we must not stomp live work with a read-only turn.
  //
  // This is the cheap early rejection. It is re-evaluated against a FRESH read
  // inside the lifecycle lock below — that re-read is the authoritative one;
  // this one just fails fast before the expensive setup.
  assertAskableStatus(task, task.status);
  // Preserve the pre-ask status so a read-only ask never mutates task state.
  // Seeded from the snapshot and overwritten by the authoritative in-lock
  // re-read, so the `finally` restores what the dispatch actually found.
  let statusBeforeAsk: TaskStatus = task.status;
  // The in-flight claim, once made. It is NOT released when this handler
  // returns — the turn it names is still running, and the settler releases it
  // (see releaseAsyncClaim). The `finally` only unwinds a dispatch that FAILED.
  let claim: SyncTurnClaim | null = null;
  let dispatched = false;
  /** Did THIS call take the task to `working`? See the same flag in launchReviewTaskRun. */
  let movedToWorking = false;

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Worktree lock ---
  const tRef = taskRef(task);
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);
  if (!await pathExists(worktreePath)) {
    throw new RpcError(400, `Worktree missing for task ${displayId(task)}. Run 'lazy sync ${displayId(task)}' to recover.`);
  }
  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Task ${shortId(task.id)} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }
  // --- Usage pause ([usage_pause]) ---
  // The live route resumes the task's own agent: its credential is judged,
  // before the worktree lock (the first write).
  await assertTurnStartAllowed(projectRoot, {
    task, config: await loadConfig(projectRoot), actor, verb: 'ask',
    overrideEligible: params.usagePauseOverrideEligible === true,
  });
  phases.end(displayId(task));
  phases.announce(askPhasePlan(), displayId(task));
  phases.begin(ASK_PHASES.prepare);

  await acquireLock(worktreePath, 'lazy ask');

  try {
    // --- Dispatch, serialized against every other turn dispatcher ---
    // See the CONCURRENCY note on this function. Everything from the
    // authoritative status re-read to the supervisor launch is one critical
    // section; the wait for the answer deliberately happens outside it.
    const dispatch = await withTaskLifecycleLock(task.id, async () => {
      // --- Authoritative status re-read ---
      // The early gate above read a snapshot; a concurrent dispatcher may have
      // taken the task to 'working' while we queued for this lock. Re-read and
      // re-gate before we touch anything.
      const fresh = await storage.getTask(task.id);
      if (!fresh) {
        throw new RpcError(404, `Task not found: ${params.taskId}`);
      }
      assertAskableStatus(task, fresh.status);
      // Before the question's turn is recorded — see assertNoMemberInside.
      assertNoMemberInside(task.id);
      statusBeforeAsk = fresh.status;

      // --- Model + effort resolution ---
      const config = await loadConfig(projectRoot);

      // An ask is a ONE-OFF, not an action on the task. Its agent and model come
      // from the task record — which is what keeps a reviewer's question on the
      // prompt cache the work turn just filled, and off whatever pool
      // `[models] default` names — and its `--effort` applies to this question
      // only. Nothing here is written back: the next work turn must run on what
      // the task said before the question was asked. Hence the read-only
      // resolver rather than resolveTurnLaunchIdentity.
      const { model: modelName, effort: effortValue } = await resolveOneOffTurnIdentity({
        storage,
        task,
        config,
        effortOverride: params.effortOverride,
      });

      // --- Build prompts ---
      // Asks always resume a live agent session, so no turn-history injection
      // is needed — the agent already has all prior context in its context window.
      // Notes are also skipped: an ask is a single reviewer question, not a
      // feedback delivery channel.
      const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
      const harness = setRunnerAgentForTask(runner, config, task);
      await runner.checkAvailability();
      // Bridge/stamp the resolved runner onto the session before launch.
      await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);
      const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }), await buildLazyMdSection(worktreePath));
      const askMessage = sanitizeUserText(params.message); // INTAKE BOUNDARY — see handleUnblockTask
      const fullMessage = buildPromptWithInstructions(askMessage.trim(), task.goal, projectRoot);

      // --- Record the human turn BEFORE launching ---
      // INVARIANT (CLAUDE.md): human feedback must be durably saved before any
      // operation that might fail can discard it. For an ask, the question is
      // the feedback.
      //
      // Claim the task's protocol slot FIRST — before the human turn, before the
      // status flip, before the command is written. Every other writer checks for
      // a live record, so from here on nothing can move this task underneath the
      // turn. (Also assigned to the outer `claim` so the `finally` can release it
      // however this exits.)
      const askClaim = await claimSyncTurn(storage, task, sess, {
        owner: 'ask',
        turnType: 'ask',
        restoreStatus: statusBeforeAsk,
        ttlMs: IN_FLIGHT_ASYNC_BACKSTOP_MS,
      });
      claim = askClaim;
      await storage.createTurn({
        sessionId: sess.id,
        sequence: askClaim.humanSeq,
        role: 'human',
        content: askMessage.trim(),
        agent: task.agent_id,
        model: modelName,
        effort: effortValue,
        prompt: fullMessage,
        // Channel actor: MCP-originated questions are 'builder', CLI 'human'.
        actor,
        turnType: 'ask',
        // INVARIANT: an unanswered question is unconsumed feedback — re-deliver
        // it if the ask crashes before the agent replies.
        carriesFeedback: true,
      });

      // Credential first — see the note in unblockTask.
      const { mustRecreateContainer } = await prepareTurnLaunch(projectRoot, {
        taskId: task.id,
        sessionId: sess.id,
        storage,
      });

      // --- Transition blocked → working ---
      await storage.updateTaskStatus(task.id, 'working', actor);
      movedToWorking = true;

      // --- Dispatch ask command to supervisor ---
      const protoDir = getProtocolDir(task.id);
      ensureProtocolDir(protoDir);

      const askCommand: AskCommand = {
        type: 'ask',
        task_id: task.id,
        goal: task.goal,
        prompt: fullMessage,
        agent_id: task.agent_id,
        harness,
        system_prompt: systemPrompt,
        model_id: modelName,
        effort: effortValue,
        agent_session_id: agentSessionId,
        ...commonCommandFields(config, { command_id: askClaim.commandId }),
      };
      writeCommand(protoDir, askCommand);

      // --- Launch or reuse supervisor ---
      phases.end();
      phases.begin(ASK_PHASES.launch);
      const containerName = runner.runNameForTask(tRef);
      const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

      let daemonConfigPath: string | null = null;
      // Skip when running outside the daemon (in-process RPC fallback) — there is
      // no daemon for the container to connect to, and getDaemonContext() throws.
      // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
      if (runner.usesSandbox() && hasDaemonContext()) {
        daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
      }

      // A container the turn-launch prep condemned (stale credential) is never
      // reused, so it also does not count as an already-running supervisor for
      // the in-flight wait below. Same for an agent-switch env mismatch.
      const mustRecreateForAgent = mustRecreateForContainerAgent(sess, task.agent_id);
      if (mustRecreateForAgent) {
        phases.note(
          `recreating container: agent changed ` +
          `(${sess.container_agent_id} → ${task.agent_id}) — launch env is fixed at create time`,
        );
      }
      const reusedExistingSupervisor =
        !mustRecreateContainer && !mustRecreateForAgent && (await runner.isRunning(containerName));
      if (reusedExistingSupervisor) {
        // Supervisor already running — it will pick up the ask command
        phases.note(`reusing running container ${containerName}`);
      } else {
        await removeTaskRun(runner, storage, sess, containerName);
        try {
          await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, task.id, pinnedCustomImage(task), phases.notify);
        } catch (err) {
          await storage.updateTaskStatus(task.id, 'interrupted', actor);
          movedToWorking = false;
          throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
        }
      }
      await storage.updateSessionContainerName(sess.id, containerName, task.agent_id);
      sess.container_agent_id = task.agent_id;

      // Stamp the run on the claim now that it exists. From here the task is
      // probeable: the reconciler can tell "still thinking" from "died without
      // answering", and `lazy stop` knows what to kill.
      await storage.stampInFlightTurnRun(task.id, askClaim.agentSeq, {
        runName: containerName,
        runnerType: runner.type,
      });

      return { askClaim, runner, containerName, reusedExistingSupervisor };
    });
    const { askClaim, containerName } = dispatch;
    // Re-published to the outer binding for the `finally`. The assignment inside
    // the closure is the one that matters when the dispatch throws after the
    // claim; this one is what TS's flow analysis can actually see.
    claim = askClaim;
    dispatched = true;

    // --- Started. The handler is done. ---
    //
    // No wait, and no ceiling. The agent is running with a claim naming the
    // sequence its answer must occupy; the reconciler is the single reader of
    // `response.json` and records that turn, restores the pre-ask status, and
    // releases the claim. The caller waits for the task to leave `working`
    // (`lazy wait`) or, on a surface that keeps a blocking UX, for the turn
    // itself (see awaitClaimedTurn).
    phases.end(containerName);
    return {
      outcome: 'started',
      taskId: task.id,
      displayId: displayId(task),
      sessionId: sess.id,
      turnSequence: askClaim.agentSeq,
      turnNumber: Math.floor(askClaim.agentSeq / 2) + 1,
      containerName,
      derivedFrom: 'live-session',
      warnings,
      timings: { daemon_ms: Date.now() - daemonStart, wait_ms: 0 },
    };
  } finally {
    // UNWIND A FAILED DISPATCH ONLY.
    //
    // On success there is nothing to unwind: the turn is still running, the
    // claim is what protects it, and the task is meant to be `working`. This
    // used to be the ask's whole cleanup because the handler owned the wait —
    // and that is precisely how a timed-out review stranded its task, by
    // tearing the turn's world down while still expecting its answer.
    //
    // A dispatch that THREW has no turn to protect: release the claim and put
    // back the status IF THIS CALL MOVED IT. `movedToWorking` is what makes "a
    // concurrent transition is not ours to stomp" true — reading the current
    // status instead reverted a `working` that belonged to another turn
    // entirely (see the same flag in launchReviewTaskRun, and the incident it
    // names). A supervisor launch failure deliberately parks the task
    // `interrupted` and clears the flag itself.
    if (!dispatched) {
      try {
        if (claim) await storage.clearInFlightTurn(task.id, claim.agentSeq);
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to clear the in-flight ask record — ` +
          `it will expire on its own. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (movedToWorking) {
        try {
          const current = await storage.getTask(task.id);
          if (current?.status === 'working') {
            await storage.updateTaskStatus(task.id, statusBeforeAsk, 'system');
          }
        } catch (err) {
          logger.warn(
            `Task ${displayId(task)}: failed to restore status '${statusBeforeAsk}' after the ask — ` +
            `it may be left as 'working'. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    await removeLock(worktreePath);
  }
}

/**
 * Throw the 409 an ask gets when the task is not paused.
 *
 * Split out because the check runs TWICE: once cheaply on the initial read, and
 * once authoritatively on a fresh read inside the lifecycle lock. `task` is only
 * used for the display id, so it may be the stale snapshot; `status` is the one
 * being judged and must be the fresh value at the call site.
 */
function assertAskableStatus(task: Task, status: TaskStatus): void {
  if (status === 'blocked' || status === 'conflict') return;
  throw new RpcError(409,
    `Task ${displayId(task)} is '${status}', not 'blocked' or 'conflict'. ` +
    `Review questions only run while the task is paused (blocked/conflict) — the agent may have picked up autonomous work. Retry once it's paused again.`,
    // Same split as assertReviewableStatus: `working`/`pairing` is somebody
    // else's turn right now and the retry is a tick away.
    status === 'working' || status === 'pairing' ? 'task_busy' : undefined,
  );
}

// =====================================================================
// Waiting for a claimed turn, and abandoning a dead one
// =====================================================================

/** How a wait on a claimed ask/review turn ended. */
export type ClaimedTurnWaitResult =
  /** The turn was recorded. `content` is the agent's answer or report text. */
  | {
      kind: 'settled';
      sequence: number;
      turnNumber: number;
      content: string;
      turnType: TurnType | null;
      review: ReviewReport | null;
      usage?: TokenUsage;
    }
  /** The claim is gone and no turn was ever recorded at its sequence. */
  | { kind: 'abandoned'; message: string }
  /** The caller's own budget ran out. The turn is still running. */
  | { kind: 'timeout' };

export interface AwaitClaimedTurnParams {
  taskId: string;
  sessionId: string;
  /** Sequence reserved for the answer — from the start result. */
  turnSequence: number;
  /**
   * The CALLER's budget, in ms. 0 waits indefinitely.
   *
   * This is not a ceiling on the turn: it only bounds how long THIS caller
   * blocks. Giving up here changes nothing about the agent, which keeps running
   * and whose answer still lands as a turn.
   */
  timeoutMs?: number;
  onProgress?: ProgressEmitter;
}

/**
 * Block until an asynchronous ask/review turn has been RECORDED.
 *
 * The predicate is the durable turn at the reserved sequence, not the in-flight
 * record's outcome: the record is released the moment the turn lands (see
 * releaseAsyncClaim), while the turn is permanent and readable by anyone,
 * whenever they ask. That is what lets a caller give up, come back, and still
 * find the verdict — and it is why nothing here has to keep a claim alive.
 *
 * Used by the surfaces that keep a blocking UX for a human: `lazy ask`,
 * `lazy review`, the TUI's ask, and the web review dialog. Agents do not use
 * it — they start the turn and wait with `lazy_wait`.
 *
 * In the DAEMONLESS in-process fallback there is no reconcile loop, so this
 * also drives the settle itself, exactly as the old synchronous waiter did.
 */
export async function awaitClaimedTurn(
  projectRoot: string,
  params: AwaitClaimedTurnParams,
): Promise<ClaimedTurnWaitResult> {
  const storage = await getOrCreateStorage();
  const start = Date.now();
  const timeoutMs = params.timeoutMs ?? 0;
  const phases = new PhaseReporter(params.onProgress, 'await-turn');
  phases.announce(claimedTurnWaitPhasePlan(), params.taskId);
  phases.begin(ASK_PHASES.answer);

  try {
  while (true) {
    const task = await storage.getTask(params.taskId);
    if (!task) {
      return { kind: 'abandoned', message: `Task not found: ${params.taskId}` };
    }
    const record = task.in_flight_turn;
    const mine = record && record.turn_sequence === params.turnSequence ? record : null;

    // Drive the settle when we may be the only settler (no reconcile loop).
    // Serialized against the reconciler and a no-op once settled, so calling it
    // unconditionally is safe — see settleInFlightTurnFromProtocol.
    if (mine && !mine.outcome) {
      try {
        const session = await storage.getSession(mine.session_id);
        if (session) {
          await settleInFlightTurnFromProtocol(
            storage, task, session, mine,
            getWorktreePathForRef(projectRoot, taskRef(task)),
            projectRoot,
          );
        }
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to settle the in-flight ${mine.owner} turn: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // A review's turn is written before its findings are posted. Let the
    // follow-up finish first so what we hand back carries `posted` (or the
    // note saying why it does not).
    const pendingFollowUp = reviewFollowUps.get(params.taskId);
    if (pendingFollowUp) await pendingFollowUp.catch(() => undefined);

    const turn = (await storage.getSessionTurns(params.sessionId)).find(
      (t) => t.sequence === params.turnSequence && t.role === 'agent',
    );
    if (turn) {
      return {
        kind: 'settled',
        sequence: turn.sequence,
        turnNumber: Math.floor(turn.sequence / 2) + 1,
        content: turn.content,
        turnType: turn.turn_type ?? null,
        review: turn.review ?? null,
        usage: turn.usage ?? undefined,
      };
    }

    // No turn, and no live claim naming our sequence: nothing is going to write
    // one. Whoever ended the turn — a stop, the reconciler abandoning a dead
    // run — has already recorded why and restored the status.
    if (!mine || !isInFlightLive(mine)) {
      return {
        kind: 'abandoned',
        message:
          `The ${mine?.owner ?? 'turn'} on ${displayId(task)} ended without recording an answer. ` +
          `Check the task's turns for what happened.`,
      };
    }

    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
      return { kind: 'timeout' };
    }
    await Bun.sleep(500);
  }
  } finally {
    phases.end();
  }
}

/**
 * Start an ask and block until its answer lands — for a DAEMON-INTERNAL caller
 * with a blocking UX (today: the web review dialog's per-comment ask).
 *
 * The two halves stay separate for everyone else. This exists because a web
 * request is a human sitting in front of an answer, exactly like `lazy ask`,
 * and it is not worth making that surface reimplement the pair. The turn still
 * has no ceiling: `timeoutMs` here would bound only this caller, and none is
 * passed.
 */
export async function launchAskTaskAwaited(
  projectRoot: string,
  params: AskTaskParams,
): Promise<{ answer: string; turnNumber?: number; provenance?: string | null }> {
  const started = await launchAskTask(projectRoot, params);
  if (started.outcome === 'answered') {
    return {
      answer: started.answer ?? '',
      turnNumber: started.turnNumber,
      provenance: started.provenance,
    };
  }
  const settled = await awaitClaimedTurn(projectRoot, {
    taskId: started.taskId,
    sessionId: started.sessionId,
    turnSequence: started.turnSequence!,
    onProgress: params.onProgress,
  });
  if (settled.kind !== 'settled') {
    throw new RpcError(500, settled.kind === 'abandoned'
      ? settled.message
      : `Gave up waiting for the ask on ${started.displayId}; it is still running.`);
  }
  return { answer: settled.content, turnNumber: settled.turnNumber };
}

/** Start a review and block until its report lands. See {@link launchAskTaskAwaited}. */
export async function launchReviewTaskAwaited(
  projectRoot: string,
  params: ReviewTaskParams,
): Promise<{ turnNumber: number; answer: string; report: ReviewReport | null; warnings: string[] }> {
  const started = await launchReviewTask(projectRoot, params);
  const settled = await awaitClaimedTurn(projectRoot, {
    taskId: started.taskId,
    sessionId: started.sessionId,
    turnSequence: started.turnSequence,
    onProgress: params.onProgress,
  });
  if (settled.kind !== 'settled') {
    throw new RpcError(500, settled.kind === 'abandoned'
      ? settled.message
      : `Gave up waiting for the review on ${started.displayId}; it is still running.`);
  }
  return {
    turnNumber: settled.turnNumber,
    answer: settled.content,
    report: settled.review,
    warnings: started.warnings,
  };
}

/**
 * End an ask/review whose run is gone without an answer.
 *
 * THE BUG THIS CLOSES. A review whose container died — or, before this change,
 * was torn down by the handler's own timeout — left the task `working` with a
 * claim naming an answer that could never arrive. `lazy_active` showed no
 * substate, no turn ever landed, and the only exit was a human running
 * `lazy stop`, which recorded a crash turn and left the task `interrupted`.
 *
 * So: record the abandonment as the answering turn (at the reserved sequence,
 * so any waiter returns), restore the status the turn found, release the claim
 * and drop the mailbox. Raises the reviewer already filed are untouched — they
 * are attributed to this sequence and are usually the most valuable thing a
 * review that died late produced.
 */
export async function abandonDeadClaimedTurn(
  storage: Storage,
  task: Task,
  record: InFlightTurn,
  detail: string,
): Promise<void> {
  const label = record.owner === 'review' ? 'Review' : 'Ask';
  const content = [
    `[${label} abandoned]`,
    '',
    detail,
    '',
    `Status restored to '${record.restore_status}'. Anything the ` +
    `${record.owner === 'review' ? 'reviewer' : 'agent'} already filed (Raises, comments) is kept.`,
  ].join('\n');

  // A REVIEWER THAT DIED IS A FAILED REVIEW, not a missing one — the same shape
  // `recordReviewErrorTurn` gives a reviewer that crashed loudly enough to write
  // an ErrorResponse, and `recordAutoReviewNotRun` gives one that never started.
  // Without the report this turn is not a review to any surface that reads them
  // (`isSuccessfulReviewReport` keys on the report's existence), so the task
  // read as simply un-reviewed: nothing in Reviews, nothing gating accept, and
  // for a cluster's child no handback to its driver. A reviewer killed mid-turn
  // by an org spend limit is exactly that shape — it never got to write a
  // response — and it is what left `teams-raised-cluster-row-one-size` with a
  // FAILED TO START record as its only review on 2026-09-20.
  //
  // It wears the CRASH prefix, not the never-dispatched one: this reviewer ran.
  // The distinction is load-bearing twice over — a driver reading the record
  // decides "retry, nothing read this work" from it, and the catchup's own
  // dedupe (`reviewWasNeverDispatched` / `reviewNotRunHeadline`) treats a
  // FAILED TO START record as its own and supersedable, which this is not.
  const abandonedReport: ReviewReport | undefined = record.owner === 'review'
    ? {
        verdict: `${REVIEW_CRASH_VERDICT_PREFIX} the reviewer did not finish — ${detail}`,
        security: 'unparsed',
        data_integrity: 'unparsed',
        findings: [],
      }
    : undefined;

  try {
    const turns = await storage.getSessionTurns(record.session_id);
    if (!turns.some((t) => t.sequence === record.turn_sequence)) {
      // The CLAIM's owner, not the session's: this ending is written by
      // whoever ticks next, and the session may already belong to a later turn.
      await createRecoveredAgentTurn(storage, {
        sessionId: record.session_id,
        sequence: record.turn_sequence,
        role: 'agent',
        content,
        turnType: record.turn_type,
        ...(abandonedReport ? { review: abandonedReport } : {}),
      }, turnOwnerOfClaim(record));
    }
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: failed to record the abandoned ${record.owner} turn: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const current = await storage.getTask(task.id);
    if (current?.status === 'working') {
      await storage.updateTaskStatus(task.id, record.restore_status, 'system');
    }
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: failed to restore status '${record.restore_status}' after ` +
      `abandoning the ${record.owner} turn: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await releaseAsyncClaim(storage, task.id, record);
}

// =====================================================================
// Review Task (read-only review turn in a NEW agent session)
// =====================================================================

export interface ReviewTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  modelOverride?: string;
  effortOverride?: string;
  /**
   * After a successful review that filed at least one Raise, start a work
   * turn (auto-fix) that injects those Raises into the agent's NOTES.
   * No-op when the review is null/unparsed or raised nothing.
   */
  autoFix?: boolean;
  /**
   * This review was DISPATCHED by the daemon after the task's final
   * declaration (final-turn design §8), so the settle runs the §8.1
   * round accounting: its Raises count toward the round cap, a blocking
   * finding parks the task, and a capped cluster child is handed back to its
   * driver. A manual `lazy review` never sets this and never counts toward
   * the cap.
   */
  autoReview?: boolean;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'). */
  actor?: ActorInput;
  onProgress?: ProgressEmitter;
}

/**
 * What STARTING a review returns. There is no report here and there is no
 * ceiling on producing one: the reviewer's verdict lands as a `review` turn at
 * {@link turnSequence}, carrying its parsed report, and the caller waits for it
 * (`lazy wait`, or `awaitClaimedTurn` on a surface that keeps a blocking UX).
 */
export interface ReviewTaskStartedResult {
  taskId: string;
  displayId: string;
  sessionId: string;
  /** Sequence the reviewer's report will occupy. */
  turnSequence: number;
  turnNumber: number;
  /** The ephemeral review run — what `lazy stop` would kill. */
  containerName: string;
  warnings: string[];
  timings: {
    daemon_ms: number;
    wait_ms: number;
  };
}

/**
 * Statuses a review may run against. Anything currently doing work, or with
 * no work to look at, is refused.
 *
 * `complete` and `abandoned` are deliberately out: their worktree is normally
 * gone, and "Worktree missing — run lazy sync" is the wrong advice for a
 * finished task. A review of finished work would need its own restore path;
 * until that exists, refuse.
 *
 * Exported because the daemon's auto-review catchup (§8 of the final-turn
 * design) dispatches over the same set — one rule, two readers.
 */
export const REVIEWABLE_STATUSES = new Set<TaskStatus>([
  'blocked',
  'conflict',
  'submitted',
  'interrupted',
]);

function assertReviewableStatus(task: Task, status: TaskStatus): void {
  if (REVIEWABLE_STATUSES.has(status)) return;
  throw new RpcError(409,
    `Task ${displayId(task)} is '${status}' — a review cannot run while the task is busy, ` +
    `has no work yet, or is already finished. Wait until it is paused ` +
    `(blocked, conflict, submitted, or interrupted).`,
    // `working` / `pairing` mean somebody else owns the task AT THIS INSTANT and
    // the answer will be different a tick later; `backlog` / `complete` /
    // `abandoned` mean it will not. Only the first is a `task_busy` refusal, so
    // the auto-review catchup retries the race it lost instead of recording a
    // FAILED TO START review against a task whose real review was starting.
    status === 'working' || status === 'pairing' ? 'task_busy' : undefined,
  );
}

export function renderReviewTurnPrompt(task: Task, audience: 'human' | 'agent' = 'human'): string {
  const prompt = currentPromptOf(task) ?? '(no prompt recorded)';
  // §8: the review prompt is audience-specific — a reviewer reporting to the
  // human is walked region by region through the diff; one reporting to a
  // parent agent reports scope and correctness only. Selected here and
  // nowhere else, exactly like the wrap-up plan's audience map.
  const body = audience === 'agent' ? reviewTurnScopePrompt : reviewTurnFeaturePrompt;
  return body
    .replaceAll('{{task_id}}', displayId(task))
    .replaceAll('{{goal}}', task.goal || '(no goal)')
    .replaceAll('{{prompt}}', prompt);
}

/**
 * Which audience the reviewer reports to (§8): derived from the same two
 * inputs every other audience derivation reads — the session's turns and the
 * task's creation actor — so the wrap-up, the outstanding-violations resolver
 * and the review prompt can never disagree about who this task is for.
 *
 * Best-effort like them: a task whose history cannot be read reviews for the
 * human audience (the safe default — the fuller prompt).
 */
async function resolveReviewAudience(
  storage: Storage,
  task: Task,
  sessionId: string,
): Promise<'human' | 'agent'> {
  try {
    const turns = await storage.getSessionTurns(sessionId);
    return audienceOf({ turns, createdBy: await createdByOf(storage, task) });
  } catch (err) {
    logger.debug(
      `Task ${task.id.substring(0, 8)}: turns unavailable for the review audience, ` +
      `falling back to the human prompt: ${err instanceof Error ? err.message : err}`,
    );
    return 'human';
  }
}

/**
 * START a read-only review turn in a NEW agent session.
 *
 * ASYNCHRONOUS, and with NO CEILING. This returns once the reviewer has been
 * launched; its verdict lands as a `review` turn at the reserved sequence,
 * carrying the parsed report and the Raises it filed, and the caller waits for
 * that turn. What the 10-minute ceiling it replaced actually did was tear the
 * reviewer's container down and then keep waiting for that container's answer,
 * leaving the task in `working` with no live substate until a human noticed.
 *
 * Follows the ask shape (claimSyncTurn, restore_status) with four load-bearing
 * differences:
 *   1. The supervisor command has no `agent_session_id` (no `--resume`).
 *   2. The reviewer's session id is never written back to the work session.
 *   3. Pending implementer feedback is not marked consumed.
 *   4. It runs in its OWN ephemeral run, never the implementer's container —
 *      which is exactly why the run name is stamped on the claim: it is the
 *      only place `lazy stop` and the reconciler can learn it.
 */
export async function launchReviewTask(
  projectRoot: string,
  params: ReviewTaskParams,
): Promise<ReviewTaskStartedResult> {
  const phases = new PhaseReporter(params.onProgress, 'review');
  try {
    return await launchReviewTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Everything a COMPLETED review still owes once its turn is recorded: tear the
 * ephemeral run down, post findings to the PR, and start the auto-fix turn.
 *
 * This used to be the tail of the RPC handler, which worked only for as long as
 * an RPC caller was guaranteed to be sitting on the answer. It no longer is, so
 * the work moved to whoever SETTLES the review — the reconciler in the daemon,
 * or the waiter itself in the daemonless in-process fallback where no reconcile
 * loop exists. `settleInFlightTurnFromProtocol` calls this exactly once per
 * record (the settle lock elects a single winner).
 *
 * Never throws: the review turn is already durable, and neither a forge outage
 * nor a failed auto-fix may undo it or wedge the reconcile tick.
 */
async function finishSettledReview(
  storage: Storage,
  task: Task,
  record: InFlightTurn,
  projectRoot: string | undefined,
): Promise<void> {
  // Tear the reviewer's run down first: it has written its answer and exited,
  // and it is ephemeral by design. Never removeTaskRun — that clears the work
  // session's container stamps, which point at the IMPLEMENTER's container.
  if (record.run_name && projectRoot) {
    try {
      const runner = await createRunner(projectRoot, record.runner_type ?? undefined);
      if (await runner.isRunning(record.run_name)) await runner.stopRun(record.run_name);
      if (await runner.runExists(record.run_name)) await runner.removeRun(record.run_name);
    } catch (err) {
      logger.warn(
        `Task ${displayId(task)}: failed to clean up review run ${record.run_name}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!projectRoot) {
    logger.warn(
      `Task ${displayId(task)}: review settled without a project root — skipping ` +
      `auto-fix. The review turn itself is recorded.`,
    );
    return;
  }

  const reviewTurn = await readRecordedReviewTurn(storage, record);
  if (!reviewTurn?.review) return;

  // INVARIANT: a review lands on the TASK and nowhere else. Lazy writes no
  // review comments to a PR/MR (engineer decision, 2026-09-21) — a forge
  // notification per review, times the fix rounds, was the noise people
  // complained about. The findings reach the implementer as fix feedback.
  const report = reviewTurn.review;
  // §8: a daemon-dispatched auto-review owns the §8.1 round accounting —
  // the cap, blocking findings and the driver hand-back live there. A manual
  // `lazy review --auto-fix` keeps the plain path a human asked for.
  if (record.review_follow_up?.auto_review) {
    await settleAutoReviewRound(projectRoot, storage, task, record, report);
    return;
  }
  await maybeAutoFixAfterReview(projectRoot, storage, task, record, report);
}

/**
 * §8.1 round accounting for an auto-review that came back with a report.
 *
 * THE VERDICT DECIDES, and it is a closed set (`resolveReviewVerdict`):
 *
 * - `clean` — the cycle achieved what it exists for. Reset the counter.
 *   WHAT COUNTS AS CLEAN IS `reviewIsClean`, THE PREDICATE THE ACCEPT GATE
 *   READS, and it has to be the same one: a report the gate holds and the
 *   accounting calls a clean pass is a dead end. Nothing resets it (the cycle
 *   is over), nothing can clear it (no findings for a fix turn to act on), and
 *   no journal is written — so a cluster's child sits refused at accept with no
 *   §8.2 hand-back saying why, and `--allow-review-issues` is CLI-only. A report whose SWEEP
 *   names an issue no finding covers is exactly that shape, and reading
 *   `verdict === clean && reviewIssueCount === 0` instead of the gate's own
 *   predicate is what put it there.
 * - `needs_work` — count the round and, while under the cap, hand the FINDINGS
 *   to the implementer as its next turn's feedback. No Raise is filed for a
 *   finding, so no human triages a defect that was fixed two turns later, and
 *   the fixer's next `lazy_final` is not refused by the reviewer's own raise.
 * - `needs_human` — the reviewer says the task cannot be completed without
 *   compromising security or data integrity, or its goal contradicts itself.
 *   The rounds end; the blocking Raise it filed parks the task for a decision.
 * - `unparsed` — a FAILED review, even after the supervisor's one re-ask. It
 *   gates accept exactly like `needs_work` and ends the rounds: nobody knows
 *   what it concluded, and a fix turn cannot act on that. This is the case the
 *   first driver under this flow hit and accepted anyway.
 *
 * Three of the four end the cycle WITHOUT an auto-fix turn, and all of them
 * leave accept gated (`review-issues-unaddressed`) — the hand-off is to a
 * person, or for a cluster's child to its driver (§8.2), never to silence.
 *
 * An open blocking Raise ends the rounds whatever the verdict says: no auto-fix
 * turn can clear one by working harder.
 *
 * Never throws: the review turn is already durable, and the accounting is
 * best-effort at every step.
 */
async function settleAutoReviewRound(
  projectRoot: string,
  storage: Storage,
  task: Task,
  record: InFlightTurn,
  report: ReviewReport,
): Promise<void> {
  const verdict = resolveReviewVerdict(report);

  if (reviewIsClean(report)) {
    try {
      await resetFinalReviewRound(storage, task.id);
    } catch (err) {
      logger.warn(
        `Task ${displayId(task)}: could not reset the review round counter: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (verdict === 'unparsed') {
    // TWO FAILURES WEAR THE SAME VERDICT, and the driver's decision differs
    // between them (§8.3): a reviewer that CRASHED should be retried — the
    // child's work was never read — while a reviewer that finished but would
    // not follow the output contract has been read, and the driver should decide
    // on the child's own report and diff. Saying "failed to parse ... even
    // after the one re-ask" about a provider outage is both wrong and a guessed
    // cause inside a message whose only job is explaining the cause
    // (CLAUDE.md, "never present a guessed cause as the explanation").
    //
    // `recordReviewErrorTurn` stamps `FAILED: the reviewer did not finish — …`
    // as the verdict of a crash, so the distinction is already in the record;
    // it only had to be read rather than assumed.
    await journalAutoReviewParked(storage, task, describeFailedReview(report), report);
    return;
  }

  // A blocking Raise — the `needs_human` decision, or one a legacy review
  // filed. Blocking-ness comes from the STORED rows: the report carries only
  // ids, and gating is decided at `lazy_raise` time, never re-derived from the
  // report text.
  let blocking: RaisedItem | undefined;
  const raiseIds = raisedItemIdsOf(report);
  if (raiseIds.length > 0) {
    try {
      const all = await storage.getTaskRaisedItems(task.id);
      const byId = new Map(all.map((r) => [r.id, r]));
      blocking = raiseIds
        .map((id) => resolveRaisedItemByIdOrPrefix(all, id) ?? byId.get(id))
        .find((r): r is RaisedItem => r?.blocking === true);
    } catch (err) {
      // Cannot tell whether the review filed a decision: neither count the
      // round nor auto-fix — parking is the conservative direction both ways.
      logger.warn(
        `Task ${displayId(task)}: could not read the review's Raises for the round accounting: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  if (verdict === 'needs_human' || blocking) {
    await journalAutoReviewParked(
      storage,
      task,
      blocking
        ? 'the review filed a blocking item — a decision a fix turn cannot make'
        : 'the review returned `needs_human` — a decision a fix turn cannot make',
      report,
    );
    return;
  }

  // Nothing to work on, by either route, and both are contradictions the safe
  // reading resolves the same way: park and hand back rather than launch a fix
  // turn with an empty brief.
  //
  // The REASON has to say which contradiction it was. A report whose sweep
  // named a security issue with no finding did not "say needs_work and record
  // no findings" — its verdict may well have been `clean` — and the driver
  // reading this entry decides under step 5 on the sentence it is given.
  if (reviewIssueCount(report) === 0) {
    await journalAutoReviewParked(
      storage,
      task,
      reviewSweepsClaimUncoveredIssue(report)
        ? 'the review named a security or data-integrity issue with no finding recorded for it'
        : 'the review said `needs_work` but recorded no findings',
      report,
    );
    return;
  }

  // AUTO-FIX IS ITS OWN SWITCH, and it is OFF by default (`[review] auto_fix`).
  // The review found something a fixer could act on; whether spending another
  // ~30-minute round on it is worth more than handing it to whoever is driving
  // is not a judgement the daemon is in a position to make. So the task parks
  // with its findings on the review turn, and the cluster hand-back below tells
  // the driver what was found and that the decision is theirs.
  //
  // The ROUND IS NOT COUNTED here, deliberately: the per-child budget bounds
  // rounds that actually RAN, and spending one on a round nobody started would
  // shorten the budget of a driver that later decides to fix by hand.
  if (!record.review_follow_up?.auto_fix) {
    await journalAutoReviewParked(
      storage, task, 'auto-fix is off, so the findings are yours to decide on', report,
    );
    return;
  }

  // [usage_pause]: HELD before the round is counted. The per-child budget
  // bounds rounds that RAN; one counted for a fix the pause kept from starting
  // would shorten it for nothing. The held fix is retried after the reset.
  if (await holdReviewFixForUsagePause(projectRoot, storage, task, record)) return;

  let round: number;
  try {
    round = await incrementFinalReviewRound(storage, task.id);
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: could not count the review round — no auto-fix will run: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (round >= FINAL_REVIEW_CAP) {
    await journalAutoReviewParked(storage, task, `the cap of ${FINAL_REVIEW_CAP} review rounds`, report);
    return;
  }

  // Still under the cap: the auto-fix turn runs with the findings as its
  // feedback, the agent re-declares final from it, and the dispatch side
  // starts the next round.
  await maybeAutoFixAfterReview(projectRoot, storage, task, record, report);
}

/**
 * Tell a CLUSTER parent that its child's auto-review cycle parked — §8.2: for
 * a cluster's child the driver is "the human", so the hand-back of a capped,
 * failed or decision-parked child goes to the driver with its findings, not to
 * a person.
 *
 * Journalled, never commented: a journal entry never triggers a turn and is
 * never injected into a prompt — the driver's OWN turn (already `lazy_wait`ing
 * on this child, among others) reads it on demand. Written at the SETTLE, once
 * per review, never per reconcile tick. Children of any other type get no
 * journal: their findings sit on the review turn for the human to read.
 *
 * CONCURRENCY-SAFE BY CONSTRUCTION, and that is why it survived the reversal of
 * the serial rule untouched: the entry is per CHILD, appended to the parent's
 * journal, and names the child it is about. Ten children parking at once append
 * ten entries the driver reads in its own time; nothing here holds a slot,
 * assumes a current child, or needs to know how many are running.
 */
async function journalAutoReviewParked(
  storage: Storage,
  task: Task,
  reason: string,
  report: ReviewReport,
): Promise<void> {
  try {
    logger.info(
      `Task ${displayId(task)}: auto-review cycle parked — ${reason} ` +
      `(verdict ${reviewVerdictLabel(resolveReviewVerdict(report))}, ` +
      `${report.findings.length} finding(s)).`,
    );
    const parent = parentTaskIdOf(task);
    if (!parent) return;
    const parentTask = await storage.getTask(parent);
    if (!parentTask || !isClusterTask(parentTask)) return;

    const findings = report.findings.length > 0
      ? report.findings.map((f, i) => formatFindingForAutoFix(f, i)).join('\n')
      : '_(none recorded on the report)_';
    const ids = raisedItemIdsOf(report);
    const raised = ids.length > 0
      ? `\n\nBlocking/raised items on the child: ${ids.map((id) => `\`${id.slice(0, 8)}\``).join(', ')}.`
      : '';

    // SAY WHETHER IT ACTUALLY GATES, rather than asserting it always does.
    // Only findings above medium (plus a failed review, an awaiting raise, or a
    // sweep naming an uncovered issue) hold accept now — so on a park whose
    // findings are all medium or low, "accept stays gated" would send a driver
    // to look for an override that is CLI-only and a refusal that never comes.
    const gates = reviewReportHasGatingIssue(report);
    await storage.appendJournalEntry(
      parent,
      `## Auto-review parked \`${displayId(task)}\` — ${reason}\n\n` +
        `Verdict: **${reviewVerdictLabel(resolveReviewVerdict(report))}**. ` +
        `Findings from this round:\n\n${findings}${raised}\n\n` +
        (gates
          ? `The child is parked and accept stays gated (\`review-issues-unaddressed\`) ` +
            `until this is handled. `
          : `The child is parked, but accept is NOT gated: nothing here is above medium ` +
            `severity, and findings at medium or below ride along on a merge you decide to ` +
            `make. `) +
        `As the driver, decide (step 5 of your contract): ` +
        `unblock the child with your own direction (which starts a fresh review ` +
        `cycle under your judgement), accept it, or close/defer it with a blocking ` +
        `raise of your own.`,
      'system',
    );
  } catch (err) {
    // Best-effort: the review turn is already durable on the child; a failed
    // hand-back note must not unwind the settle.
    logger.warn(
      `Task ${displayId(task)}: could not journal the auto-review hand-back to its cluster parent: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The agent turn a settled review recorded, read back at its reserved sequence. */
async function readRecordedReviewTurn(
  storage: Storage,
  record: InFlightTurn,
): Promise<{ id: string; review?: ReviewReport | null } | null> {
  try {
    const turns = await storage.getSessionTurns(record.session_id);
    return turns.find(
      (t) => t.sequence === record.turn_sequence && t.role === 'agent',
    ) ?? null;
  } catch (err) {
    logger.warn(
      `Could not read back the review turn at sequence ${record.turn_sequence}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * When the review was started with auto-fix and found something, start a normal
 * work unblock whose NOTES carry every FINDING (MCP-facing instructions — not
 * web UI jargon). Never unblocks on a failed review or a clean one.
 *
 * The findings ARE the feedback — this is the channel that replaced filing each
 * one as a Raise. Any Raises the review did file (the `needs_human` decision,
 * or a legacy review's findings) are listed after them.
 */
async function maybeAutoFixAfterReview(
  projectRoot: string,
  storage: Storage,
  task: Task,
  record: InFlightTurn,
  report: ReviewReport,
): Promise<void> {
  if (!record.review_follow_up?.auto_fix) return;
  if (resolveReviewVerdict(report) === 'unparsed') return;
  if (reviewIssueCount(report) === 0) return;
  // [usage_pause]: the plain (`lazy review --auto-fix`) path is held here; the
  // auto-review path already was, before it counted the round — holding again
  // after the count would count it a second time on the retry.
  if (!record.review_follow_up.auto_review && await holdReviewFixForUsagePause(projectRoot, storage, task, record)) {
    return;
  }

  const raiseIds = raisedItemIdsOf(report);
  let message: string;
  try {
    let ordered: RaisedItem[] = [];
    if (raiseIds.length > 0) {
      const all = await storage.getTaskRaisedItems(task.id);
      const byId = new Map(all.map((r) => [r.id, r]));
      // Preserve review order from raised_item_ids; skip ids that somehow vanished.
      ordered = raiseIds
        .map((id) => byId.get(id))
        .filter((r): r is RaisedItem => r != null);
    }
    message = buildReviewAutoFixMessage(report.findings, ordered);
    // Raises the review recorded but storage cannot resolve: still name the
    // ids so the agent can lazy_show them rather than never hearing about them.
    if (raiseIds.length > 0 && ordered.length === 0) {
      message = `${message}\n\n${reviewAutoFixFallbackMessage(raiseIds)}`;
    }
  } catch {
    message = buildReviewAutoFixMessage(report.findings);
    if (raiseIds.length > 0) {
      message = `${message}\n\n${reviewAutoFixFallbackMessage(raiseIds)}`;
    }
  }

  try {
    await launchUnblockTask(projectRoot, {
      taskId: task.id,
      message,
      actor: record.review_follow_up.actor,
      // The DAEMON starts this turn: the reviewer asked for auto-fix when they
      // started the review, not for this turn now. It never spends their (or
      // anyone's) one-shot usage-pause override.
      daemonLaunch: true,
      // Auto-fix FILES the review, deliberately: the reviewer asked for
      // "unblock the task if the review raises anything" when they started it,
      // and this turn carries their queued comments and clears their feedback
      // draft. Their review has gone to the agent; leaving their answered
      // questions listed as open business would be the original bug.
      filesReview: true,
    });
  } catch (err) {
    // The review itself succeeded and is durable — a failed auto-fix is a log
    // line, never an exception that could unwind the settle.
    logger.warn(
      `Review auto-fix for ${displayId(task)} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Hold a review's auto-fix turn while its credential is paused ([usage_pause]).
 *
 * The fix is a turn the daemon starts by itself, and a review settles exactly
 * once — so a fix refused at launch was simply never run (and, on the
 * auto-review path, its round was already counted). Held instead: the settled
 * review's claim is kept on the task (`USAGE_PAUSE_PENDING_FIX_KEY`) and
 * `resumeHeldReviewFix` re-runs the same settle from it once the reconciler's
 * usage-pause sweep sees the window has reset. Returns true when held.
 */
async function holdReviewFixForUsagePause(
  projectRoot: string,
  storage: Storage,
  task: Task,
  record: InFlightTurn,
): Promise<boolean> {
  const held = await usagePauseHold(projectRoot, storage, task, 'review auto-fix');
  if (!held) return false;
  await storage.updateTaskMetadata(task.id, USAGE_PAUSE_PENDING_FIX_KEY, JSON.stringify(record));
  logger.info(`Review auto-fix for ${displayId(task)} held by usage pause — ${held}`);
  return true;
}

/**
 * Re-run a review's settle whose auto-fix a usage pause held, now that the
 * pause has lifted (called by the usage-pause sweep in src/daemon/usage-pause.ts).
 *
 * The same code path as the original settle, from the same stored review, so
 * the round is counted and the fix launched exactly as they would have been.
 * The pending record is cleared FIRST — the settle writes it again if the pause
 * is back — so a fix whose launch then fails is logged once, like any auto-fix
 * failure, rather than retried every tick.
 *
 * Dropped, not run, when the task has moved on since the review: a newer turn
 * (somebody unblocked it, a sync ran) or a status the fix cannot start from.
 * The findings are still on the review turn for whoever is driving.
 */
export async function resumeHeldReviewFix(projectRoot: string, storage: Storage, task: Task): Promise<void> {
  const raw = await storage.getTaskMetadata(task.id, USAGE_PAUSE_PENDING_FIX_KEY);
  if (!raw) return;
  await storage.updateTaskMetadata(task.id, USAGE_PAUSE_PENDING_FIX_KEY, '');
  let record: InFlightTurn;
  try {
    record = JSON.parse(raw) as InFlightTurn;
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: the held review auto-fix record does not parse — dropped: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const fresh = (await storage.getTask(task.id)) ?? task;
  const turns = await storage.getSessionTurns(record.session_id);
  const movedOn = turns.some((t) => t.sequence > record.turn_sequence);
  if (movedOn || !['blocked', 'submitted', 'conflict'].includes(fresh.status)) {
    logger.info(
      `Task ${displayId(task)}: dropped the review auto-fix a usage pause held — the task has moved on ` +
      `since that review (${movedOn ? 'a newer turn' : `status ${fresh.status}`}); its findings stay on the review turn.`,
    );
    return;
  }
  const reviewTurn = await readRecordedReviewTurn(storage, record);
  if (!reviewTurn?.review) return;
  logger.info(`Task ${displayId(task)}: usage pause lifted — running the review auto-fix it held`);
  if (record.review_follow_up?.auto_review) {
    await settleAutoReviewRound(projectRoot, storage, fresh, record, reviewTurn.review);
  } else {
    await maybeAutoFixAfterReview(projectRoot, storage, fresh, record, reviewTurn.review);
  }
}

function reviewAutoFixFallbackMessage(raiseIds: string[]): string {
  const n = raiseIds.length;
  return (
    `The review also raised ${n} item${n === 1 ? '' : 's'} ` +
    `(ids: ${raiseIds.map((id) => id.slice(0, 8)).join(', ')}) whose content could not be read here. ` +
    `Re-read them with lazy_show (raised_items). ` +
    `For each, call lazy_raised_item_comment(item_id=..., content=...) ` +
    `to record how you handled it. You cannot dismiss or resolve Raises.`
  );
}

async function launchReviewTaskRun(
  projectRoot: string,
  params: ReviewTaskParams,
  phases: PhaseReporter,
): Promise<ReviewTaskStartedResult> {
  const daemonStart = Date.now();
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  const actor = params.actor ?? getActor();

  phases.begin(REVIEW_PHASES.preflight);

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }

  assertReviewableStatus(task, task.status);
  let statusBeforeReview: TaskStatus = task.status;
  // The claim is NOT released when this handler returns — the reviewer it names
  // is still running. Only a dispatch that FAILED unwinds here; a successful
  // one hands the claim to the settler.
  let claim: SyncTurnClaim | null = null;
  let dispatched = false;
  /**
   * Did THIS call take the task to `working`?
   *
   * The unwind below may only put back what it moved. Reading the current status
   * instead — "it is `working`, so restore it" — reverted a task whose `working`
   * belonged to a DIFFERENT review that had just won the race: the winner's task
   * dropped out of the reconciler's working sweep, so its answer was never
   * settled and its claim pinned the task (and every later auto-review) until
   * the 24h backstop. 2026-09-20, `teams-raised-cluster-row-one-size`.
   */
  let movedToWorking = false;
  /**
   * Did THIS call write the review command into the per-task review mailbox?
   *
   * Tracked separately from {@link movedToWorking} because the two stop being
   * the same fact the moment a launch fails: the supervisor-launch catch puts
   * the status back and clears `movedToWorking`, but the command is already
   * written, so keying the mailbox cleanup on that flag left this call's own
   * command sitting in the mailbox for whatever reads it next. Same rule in
   * both directions — clear only what this call wrote, because
   * `reviewProtocolDir` is per TASK and a concurrent reviewer's command lives
   * at the same path.
   */
  let wroteReviewCommand = false;

  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  const tRef = taskRef(task);
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);
  if (!await pathExists(worktreePath)) {
    throw new RpcError(400, `Worktree missing for task ${displayId(task)}. Run 'lazy sync ${displayId(task)}' to recover.`);
  }
  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Task ${shortId(task.id)} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`, 'task_busy');
  }

  // --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---
  // INVARIANT: a review somebody ASKED for — `lazy review`, `lazy_review`, a
  // driver's review of its child — is refused on a paused credential before
  // anything is written (the worktree lock below is the first write). The
  // automatic review after a final is not judged here: the catchup HELD it
  // before dispatching (src/daemon/auto-review.ts), and it must never take a
  // person's one-shot override.
  if (!params.autoReview) {
    await assertTurnStartAllowed(projectRoot, {
      task, config: await loadConfig(projectRoot), actor, verb: 'review',
      overrideEligible: params.usagePauseOverrideEligible === true,
    });
  }

  phases.end(displayId(task));
  phases.announce(reviewPhasePlan(), displayId(task));
  phases.begin(REVIEW_PHASES.prepare);

  await acquireLock(worktreePath, 'lazy review');

  try {
    const dispatch = await withTaskLifecycleLock(task.id, async () => {
      const fresh = await storage.getTask(task.id);
      if (!fresh) {
        throw new RpcError(404, `Task not found: ${params.taskId}`);
      }
      assertReviewableStatus(task, fresh.status);
      // Before the review's turn is recorded — see assertNoMemberInside.
      assertNoMemberInside(task.id);
      statusBeforeReview = fresh.status;

      const config = await loadConfig(projectRoot);
      const { model: modelName, effort: effortValue } = await resolveOneOffTurnIdentity({
        storage,
        task,
        config,
        modelOverride: params.modelOverride,
        effortOverride: params.effortOverride,
      });

      const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
      const harness = setRunnerAgentForTask(runner, config, task);
      await runner.checkAvailability();
      await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);
      const systemPrompt = buildSystemPrompt(
        runner.getAgentInstructions(),
        renderChattinessSnippet(resolveAgentChattiness(config)),
        await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }),
      );
      const audience = await resolveReviewAudience(storage, task, sess.id);
      const fullMessage = renderReviewTurnPrompt(task, audience);

      const reviewClaim = await claimSyncTurn(storage, task, sess, {
        owner: 'review',
        turnType: 'review',
        restoreStatus: statusBeforeReview,
        ttlMs: IN_FLIGHT_ASYNC_BACKSTOP_MS,
        // Carried on the record because the settle — which is where auto-fix
        // now happens — runs in the reconciler, long after this RPC caller
        // (who chose it) has returned.
        reviewFollowUp: {
          ...(params.autoFix ? { auto_fix: true } : {}),
          ...(params.autoReview ? { auto_review: true } : {}),
          actor: typeof actor === 'string' ? actor : actor.role,
        },
      });
      claim = reviewClaim;
      await storage.createTurn({
        sessionId: sess.id,
        sequence: reviewClaim.humanSeq,
        role: 'human',
        content: `[system] Agent review of this task's work`,
        agent: task.agent_id,
        model: modelName,
        effort: effortValue,
        prompt: fullMessage,
        actor,
        turnType: 'review',
        // A review request is not implementer feedback — do not re-deliver
        // it into the next work turn if this review crashes.
      });

      // Mint/refresh the turn credential grant. Ignore mustRecreateContainer for
      // the WORK container — review uses its own run name and never reuses or
      // removes the work agent's container.
      await prepareTurnLaunch(projectRoot, {
        taskId: task.id,
        sessionId: sess.id,
        storage,
      });

      await storage.updateTaskStatus(task.id, 'working', actor);
      movedToWorking = true;

      // INVARIANT: review command goes to a sibling protocol dir, never the
      // work mailbox. A paused task's work supervisor is usually still alive
      // and polling protocolDir(task.id); writing the review command there
      // lets it consume the turn before lazy-review-* finishes starting.
      const protoDir = reviewProtocolDir(task.id);
      ensureProtocolDir(protoDir);

      const reviewCommand: ReviewCommand = {
        type: 'review',
        task_id: task.id,
        goal: task.goal,
        prompt: fullMessage,
        agent_id: task.agent_id,
        harness,
        system_prompt: systemPrompt,
        model_id: modelName,
        effort: effortValue,
        ...commonCommandFields(config, { command_id: reviewClaim.commandId }),
      };
      writeCommand(protoDir, reviewCommand);
      wroteReviewCommand = true;

      phases.end();
      phases.begin(REVIEW_PHASES.launch);
      // INVARIANT: review gets its OWN container (same worktree mount), never
      // the work agent's run. Sharing the work name made review call
      // removeTaskRun — clearing container_agent_id — or reuse a mismatched env
      // after an agent switch — the "did review change it to Claude?" class.
      const containerName = reviewContainerNameForTask(tRef);
      const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

      let daemonConfigPath: string | null = null;
      if (runner.usesSandbox() && hasDaemonContext()) {
        daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
      }

      // Leftover from a crashed prior review only — never the work container,
      // and never removeTaskRun, which clears session.container_*.
      if (await runner.runExists(containerName)) {
        phases.note(`removing leftover review container ${containerName}`);
        await runner.removeRun(containerName);
      }
      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, task.id, pinnedCustomImage(task), phases.notify);
      } catch (err) {
        await storage.updateTaskStatus(task.id, statusBeforeReview, actor);
        movedToWorking = false;
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
      // Do NOT call updateSessionContainerName: the work session's container
      // stamp must stay pointing at the implementer's container (or null).
      //
      // The CLAIM is where the reviewer's run name is recorded instead, and it
      // is the only place anything else can learn it. Without this, `lazy stop`
      // during a review routed by the session and killed the IMPLEMENTER's
      // container while the reviewer kept running.
      await storage.stampInFlightTurnRun(task.id, reviewClaim.agentSeq, {
        runName: containerName,
        runnerType: runner.type,
      });

      return { reviewClaim, containerName };
    });
    const { reviewClaim, containerName } = dispatch;
    claim = reviewClaim;
    dispatched = true;

    // --- Started. The handler is done. ---
    //
    // No wait, and no ceiling: a review of a large diff at high effort
    // routinely runs 6-8 minutes and is allowed to run as long as it makes
    // progress. The reviewer's verdict lands as a `review` turn at the
    // reserved sequence, and the settler restores the status, releases the
    // claim, drops the mailbox and tears this run down.
    phases.end(containerName);
    return {
      taskId: task.id,
      displayId: displayId(task),
      sessionId: sess.id,
      turnSequence: reviewClaim.agentSeq,
      turnNumber: Math.floor(reviewClaim.agentSeq / 2) + 1,
      containerName,
      warnings,
      timings: { daemon_ms: Date.now() - daemonStart, wait_ms: 0 },
    };
  } finally {
    // UNWIND A FAILED DISPATCH ONLY — see the same block in launchAskTaskRun.
    // Tearing the reviewer's world down on the way out is what the ceiling used
    // to do while still waiting for that reviewer's answer.
    if (!dispatched) {
      try {
        if (claim) await storage.clearInFlightTurn(task.id, claim.agentSeq);
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to clear the in-flight review record — ` +
          `it will expire on its own. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // INVARIANT: put back only what THIS call moved. `movedToWorking` is the
      // whole guard — a refused dispatch that never touched the status must
      // leave it alone, because the `working` it would "restore" from can be
      // another review's, and reverting that one drops its task out of the
      // reconciler's working sweep, so its answer is never settled and its
      // claim wedges the task until the 24h backstop. The status re-read stays
      // as a second check against a transition that landed meanwhile.
      if (movedToWorking) {
        try {
          const current = await storage.getTask(task.id);
          if (current?.status === 'working') {
            await storage.updateTaskStatus(task.id, statusBeforeReview, 'system');
          }
        } catch (err) {
          logger.warn(
            `Task ${displayId(task)}: failed to restore status '${statusBeforeReview}' after the review — ` +
            `it may be left as 'working'. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Same rule for the mailbox, on its OWN flag: `reviewProtocolDir` is per
      // TASK, so a dispatch that never wrote a command there would be deleting
      // the review command a concurrent reviewer is about to read — while a
      // dispatch that DID write one must clear it even when the status was
      // already put back, which is exactly what the supervisor-launch failure
      // does before it rethrows.
      if (wroteReviewCommand) {
        try {
          removeProtocolDir(reviewProtocolDir(task.id));
        } catch (err) {
          logger.warn(
            `Task ${displayId(task)}: failed to clear review protocol dir: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    await removeLock(worktreePath);
  }
}

/**
 * Inline the slice of reconciler logic that applies to an ask's completed
 * response: capture Claude session ID, record the agent turn, roll up
 * usage, reset interruption counter, consume protocol files. Skips commit
 * detection, uncommitted snapshotting, and plan-content enrichment — a
 * read-only ask produces none of those.
 */
async function recordAskCompletedTurn(
  storage: Storage,
  session: { id: string; agent_session_id: string | null },
  response: CompletedResponse,
  protoDir: string,
  /** Sequence reserved for this answer by claimSyncTurn. */
  reservedSeq: number,
): Promise<number> {
  if (response.session_id && !session.agent_session_id) {
    await storage.updateSessionClaudeId(session.id, response.session_id);
  }

  const turnUsage = toTurnUsage(response.usage);

  // Idempotency: if a previous flush already recorded the agent turn, reuse it.
  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  let agentTurnSeq: number;
  if (lastTurn?.role === 'agent') {
    agentTurnSeq = lastTurn.sequence;
  } else {
    // The RESERVED sequence, not a freshly allocated one: this turn's identity
    // was fixed before the command went out (see claimSyncTurn).
    agentTurnSeq = reservedSeq;
    await createAgentTurn(storage, {
      sessionId: session.id,
      sequence: agentTurnSeq,
      role: 'agent',
      content: response.result,
      usage: turnUsage,
      ...launchSettingsFromResponse(response),
      turnType: 'ask',
    });
    // INVARIANT: the session rollup shares the turn write's idempotency guard.
    // Outside it, a re-flush of the same unconsumed response.json re-added the
    // usage without adding a turn, leaving the session total permanently above
    // the sum of its turns. See src/utils/usage-recording.ts.
    await rollUpSessionUsage(storage, session.id, turnUsage);
  }

  // INVARIANT (CLAUDE.md — never lose human feedback): the agent answered, so
  // the pending feedback backlog (this ask, plus anything queued before it) is
  // consumed and must not be re-delivered on a later resume. Outside the guard
  // above so a re-flush still converges. See src/utils/feedback-redelivery.ts.
  try {
    await storage.markFeedbackConsumed(session.id);
  } catch {
    // Best-effort: leaving feedback pending re-delivers it, which is the safe
    // direction to fail in — we never lose it, we might repeat it.
  }

  try {
    await storage.resetConsecutiveInterruptions(session.id);
  } catch {
    // Counter reset is best-effort.
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);

  return Math.floor(agentTurnSeq / 2) + 1;
}

async function recordAskErrorTurn(
  storage: Storage,
  taskId: string,
  sessionId: string,
  response: ErrorResponse,
  protoDir: string,
  /** Sequence reserved for this answer by claimSyncTurn. */
  reservedSeq: number,
): Promise<void> {
  const watchdogKill = isWatchdogKill(response);
  const lines: string[] = [watchdogKill ? WATCHDOG_TURN_HEADING : '[Agent crashed]', ''];
  if (watchdogKill) {
    lines.push(...watchdogTurnLines(response), '');
  }
  lines.push(`Error: ${response.error}`);
  if (response.exit_code !== undefined) lines.push(`Exit code: ${response.exit_code}`);
  if (response.duration_ms !== undefined) {
    lines.push(`Runtime: ${(response.duration_ms / 1000).toFixed(1)}s`);
  }
  lines.push(`Phase: ${response.phase}`);
  if (response.stdout_error && response.stdout_error !== response.error) {
    lines.push('', 'Stdout error:', response.stdout_error);
  }
  if (response.stderr) {
    lines.push('', 'Stderr:', response.stderr);
  }
  const turnContent = lines.join('\n');

  const existingTurns = await storage.getSessionTurns(sessionId);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    const seq = reservedSeq;
    // Tokens the ask had already spent before it died, salvaged by the
    // supervisor (src/supervisor/usage.ts). A crashed ask used to record none.
    const errorUsage = toTurnUsage(response.usage);
    await createAgentTurn(storage, {
      sessionId,
      sequence: seq,
      role: 'agent',
      content: turnContent,
      // A crashed ask is still an agent turn — record what it ran under.
      ...launchSettingsFromResponse(response),
      turnType: 'ask',
      ...(errorUsage ? { usage: errorUsage } : {}),
    });
    await rollUpSessionUsage(storage, sessionId, errorUsage);
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
  await storage.updateTaskStatus(taskId, 'interrupted', 'system');
}

/**
 * Record a completed review turn. Unlike ask: never write the reviewer's
 * session id onto the work session, and never mark pending feedback consumed
 * (that feedback belongs to the implementer's next work turn).
 *
 * The findings ARE the issue store (src/review/recover-findings.ts). Any
 * Raises attributed to this turn — the `needs_human` decision, or entries the
 * handoff file carried when MCP was down — are attached as ordered
 * `raised_item_ids`.
 *
 * THE RE-ASK. A verdict outside the closed set makes the whole review
 * unusable, so the supervisor asks the reviewer once more, in the same
 * session, for the JSON block alone (§2 of this pass; `review_reask` on the
 * response). The original prose stays the turn's content — it may be the only
 * place the reviewer's reasoning exists — and the re-asked block is parsed
 * INSTEAD only when it actually resolves to a verdict. Otherwise the first
 * parse stands and the review is recorded as FAILED, which gates accept like
 * `needs_work`.
 */
async function recordReviewCompletedTurn(
  storage: Storage,
  session: { id: string },
  taskId: string,
  response: CompletedResponse,
  protoDir: string,
  reservedSeq: number,
  /** How this review was started — see `reviewDispatch` on the created turn. */
  dispatch: 'auto' | 'manual' = 'manual',
): Promise<void> {
  const turnUsage = toTurnUsage(response.usage);
  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    let content = response.result ?? '';
    // The re-ask is parsed as a REPLY, not just a report: whether it stated a
    // `findings` key at all is what tells a withdrawal (`"findings": []`) from
    // silence, and only the parse can still see the difference.
    const reask = response.review_reask ? parseReviewReply(response.review_reask) : undefined;
    const { report, usedReask } = chooseReviewReport(
      parseReviewReport(content),
      reask?.report,
      reask?.statesFindings ?? false,
    );

    if (response.review_reask) {
      // Recorded whether or not it was USED: a reviewer that was re-asked leaves
      // a trace, and a reader must be able to see WHY a review is marked failed.
      content = `${content}\n\n---\n\n${REVIEW_REASK_HEADING}\n\n${response.review_reask}`;
      logger.info(
        `Task ${taskId.substring(0, 8)}: the review's first reply had no usable verdict; ` +
        (usedReask
          ? `the re-ask produced ${reviewVerdictLabel(resolveReviewVerdict(report))}.`
          : `the re-ask did not resolve one either — recording the review as FAILED.`),
      );
    }

    try {
      await recoverAndAttachReviewFindings({
        storage,
        taskId,
        sessionId: session.id,
        turnSequence: reservedSeq,
        report,
        agentHandoff: response.agent_handoff,
      });
    } catch (err) {
      logger.warn(
        `Task ${taskId.substring(0, 8)}: could not recover/attach findings for the review turn — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await createAgentTurn(storage, {
      sessionId: session.id,
      sequence: reservedSeq,
      role: 'agent',
      content,
      usage: turnUsage,
      ...launchSettingsFromResponse(response),
      turnType: 'review',
      review: report,
      // How this review was started, stamped where the answer is still known:
      // the in-flight record carries it from whoever asked. The accept gate
      // reads it back to tell a review the daemon dispatched (which follows the
      // mode) from one somebody ASKED for (which gates in any mode).
      reviewDispatch: dispatch,
    });
    await rollUpSessionUsage(storage, session.id, turnUsage);
  }

  try {
    await storage.resetConsecutiveInterruptions(session.id);
  } catch {
    // Best-effort: the interruption counter is a circuit-breaker hint, not a
    // correctness input. A failed reset leaves a higher count, which is the
    // safe direction (more likely to refuse auto-resume, never less).
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
}

async function recordReviewErrorTurn(
  storage: Storage,
  sessionId: string,
  taskId: string,
  response: ErrorResponse,
  protoDir: string,
  reservedSeq: number,
  /** How the review that crashed was started — see `reviewDispatch`. */
  dispatch: 'auto' | 'manual' = 'manual',
): Promise<void> {
  // A REVIEW THAT COULD NOT RUN IS A FAILED REVIEW, not a missing one. The
  // report below is attached to the turn so every surface that reads reviews
  // sees it: it gates accept like `needs_work` (its verdict is unparsed), it
  // is listed in Reviews with the failure banner, and for a cluster's child it
  // hands back through the same journal a capped or decision-parked child
  // does. Before this, a provider outage left the child parked with a crash
  // turn no gate read and no driver journal — the driver waited on it forever.
  const failedReport: ReviewReport = {
    verdict: 'unparsed',
    security: 'unparsed',
    data_integrity: 'unparsed',
    findings: [],
  };

  // Even a crashed review may have left raised handoff entries — persist them
  // attributed to this turn so findings are not lost with the crash.
  if (response.agent_handoff && response.agent_handoff.length > 0) {
    try {
      await recoverAndAttachReviewFindings({
        storage,
        taskId,
        sessionId,
        turnSequence: reservedSeq,
        report: failedReport,
        agentHandoff: response.agent_handoff,
      });
    } catch (err) {
      logger.warn(
        `Task ${taskId.substring(0, 8)}: could not persist review-error handoff entries — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const watchdogKill = isWatchdogKill(response);
  const lines: string[] = [watchdogKill ? WATCHDOG_TURN_HEADING : '[Agent crashed]', ''];
  if (watchdogKill) {
    lines.push(...watchdogTurnLines(response), '');
  }
  lines.push(`Error: ${response.error}`);
  if (response.exit_code !== undefined) lines.push(`Exit code: ${response.exit_code}`);
  if (response.duration_ms !== undefined) {
    lines.push(`Runtime: ${(response.duration_ms / 1000).toFixed(1)}s`);
  }
  lines.push(`Phase: ${response.phase}`);
  if (response.stdout_error && response.stdout_error !== response.error) {
    lines.push('', 'Stdout error:', response.stdout_error);
  }
  if (response.stderr) {
    lines.push('', 'Stderr:', response.stderr);
  }

  // The failure itself is the verdict statement, so a reader of the review
  // list sees WHY it failed without opening the turn.
  failedReport.verdict = `${REVIEW_CRASH_VERDICT_PREFIX} the reviewer did not finish — ${response.error}`;

  const existingTurns = await storage.getSessionTurns(sessionId);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    const errorUsage = toTurnUsage(response.usage);
    await createAgentTurn(storage, {
      sessionId,
      sequence: reservedSeq,
      role: 'agent',
      content: lines.join('\n'),
      ...launchSettingsFromResponse(response),
      turnType: 'review',
      review: failedReport,
      reviewDispatch: dispatch,
      ...(errorUsage ? { usage: errorUsage } : {}),
    });
    await rollUpSessionUsage(storage, sessionId, errorUsage);
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
}

// =====================================================================
// Acceptance gate — the mechanical merge gate ([automation.pre_accept])
// =====================================================================

/**
 * Margin between the agent's own no-progress watchdog and the daemon's wait for
 * a supervised synchronous run (the wrap-up turn; pure padding on the gate,
 * which runs no agent).
 *
 * DEADLINE ORDERING (deliberate, do not collapse): three independent clocks run
 * over the wrap-up turn —
 *   1. the supervisor's no-progress watchdog (`agent.watchdog_output_timeout_ms`),
 *   2. this wait for the turn's response,
 *   3. the calling MCP client's own stdio idle budget.
 * They measure different things, and if a turn goes quiet without dying, whichever
 * fires FIRST writes the story the human reads. The watchdog is the one that can
 * say something useful ("the agent stopped producing output"), so it must fire
 * first; this wait is a backstop for the case where the watchdog itself is wedged.
 * The client budget is kept fed by the heartbeat envelope (see daemon/heartbeat.ts),
 * so it comes last. Hence: watchdog < wrap-up wait < client budget. The
 * acceptance gate adds the same margin to its command budget as pure padding —
 * there is no agent behind it, so no watchdog to order against.
 */
const SYNC_TURN_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;

/**
 * The MECHANICAL acceptance gate ([automation.pre_accept]) — the independent,
 * agent-free run of the configured gate commands that decides whether an
 * accept may merge (final-turn design §5.3/§12.2).
 *
 * The gate runs in its own EPHEMERAL container against the task's worktree,
 * with its own protocol mailbox (acceptGateProtocolDir — never the work
 * mailbox, or a live work supervisor would consume the command). No agent
 * runs, no session is resumed, no turn is recorded: the supervisor executes
 * the configured commands and reports the verdict in the response's
 * `accept_gate` field, which this function alone reads. A failing command
 * leaves the task in the status it held when the accept began, comments the
 * failure on the task, and throws RpcError — the accept aborts, never a
 * silent merge.
 *
 * `priorStatus` is the status the task held when the accept began. Every exit
 * from this function restores it — see the INVARIANT in task-state-machine.ts.
 */
async function launchAcceptanceGate(
  projectRoot: string,
  task: Task,
  worktreePath: string,
  config: ResolvedConfig,
  priorStatus: TaskStatus,
): Promise<void> {
  const preAccept = config.automation.pre_accept;
  if (!preAccept.enabled) return;
  // A gate with no commands would launch a container to run nothing — and an
  // empty list is a trivial pass by the supervisor's own rule
  // (runAcceptanceGate). Skip the container entirely.
  if (preAccept.commands.length === 0) return;

  const storage = await getOrCreateStorage();

  const tRef = taskRef(task);

  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Cannot run the acceptance gate for ${displayId(task)}: worktree is locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }
  const whatLabel = 'Acceptance gate';
  await acquireLock(worktreePath, 'lazy accept (acceptance gate)');

  // Declared before the try so the finally can clean up a partially-set-up
  // gate: whichever of these exist when we exit gets torn down.
  let runner: Runner | null = null;
  let containerName: string | null = null;
  let gateProtoDir: string | null = null;

  try {
    // The gate reuses `lazy review`'s run machinery: a runner for the task's
    // own runner type, the task's agent profile (the gate container carries
    // the task's credential environment even though no agent runs), and an
    // availability check before anything else.
    runner = await createRunner(projectRoot, task.runner_type ?? undefined);
    setRunnerAgentForTask(runner, config, task);
    await runner.checkAvailability();

    const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

    // Flip to `working` while the gate runs — the same status the retired
    // pre-accept agent turn held while its validation ran. The restore to
    // `priorStatus` happens on every exit
    // path below (the finally deliberately does NOT touch status), which keeps
    // the failure message's "Task returned to <status>" TRUE and keeps
    // auto-deliver and auto-resume off the task while its worktree is locked
    // by the gate. The reconciler also never touches a `working` task whose
    // worktree is locked — the gate holds the lock for its whole duration.
    await storage.updateTaskStatus(task.id, 'working', 'system');

    gateProtoDir = acceptGateProtocolDir(task.id);
    // Named gateProtoDir, deliberately NOT protoDir: the credential-ordering
    // source scan (test/unit/turn-credential-ordering.test.ts) pairs every
    // task-mailbox command write with a prepareTurnLaunch credential bind.
    // The gate writes a mechanical command into its OWN sibling mailbox and
    // binds no credential — no agent runs — so the distinct local name keeps
    // that scan counting agent-turn writes only.
    // A response left by a PREVIOUS gate run would be read as this gate's
    // verdict — the one-shot supervisor waits for a command when a response is
    // already present, and the wait below would take the stale verdict
    // instantly. Clear the dedicated mailbox before writing.
    removeProtocolDir(gateProtoDir);
    ensureProtocolDir(gateProtoDir);

    const gateCommand: AcceptGateCommand = {
      type: 'accept_gate',
      task_id: task.id,
      accept_gate_commands: preAccept.commands,
      accept_gate_timeout: preAccept.timeout,
      // Inline version/id fields, NOT commonCommandFields(): the gate is a
      // mechanical command — no agent turn starts, so turn_started_at, the
      // watchdog/wind-down budgets, react and maintain fields are all
      // meaningless here.
      protocol_version: PROTOCOL_VERSION,
      command_id: newCommandId(),
    };
    writeCommand(gateProtoDir, gateCommand);

    containerName = acceptGateContainerNameForTask(tRef);
    // Leftover from a crashed prior gate run only — the work container has a
    // different name and is never touched here.
    if (await runner.runExists(containerName)) {
      await runner.removeRun(containerName);
    }
    try {
      // daemonConfigPath stays undefined: the gate container gets NO MCP
      // config — no agent runs, so there is nothing for MCP to configure.
      await runner.launchSupervisor(sandbox, containerName, gateProtoDir, false, undefined, tRef, task.id, pinnedCustomImage(task));
    } catch (err) {
      const message = `${whatLabel}: failed to launch supervisor: ${err instanceof Error ? err.message : err}. Task returned to ${priorStatus}; accept aborted.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      // Same reasoning as every abort path below: the caller may be gone, so
      // the reason has to survive on the task itself.
      await storage.createComment(task.id, message, 'system');
      throw new RpcError(500, message);
    }
    // The wait is bounded by the work itself: each command may take up to its
    // configured timeout, they run in order, plus a margin for supervisor
    // startup and shutdown. There is no agent here to watchdog — the agent
    // watchdog budget (watchdog_output_timeout_ms) does not apply.
    const timeoutMs = preAccept.commands.length * (preAccept.timeout ?? DEFAULT_PRE_ACCEPT_TIMEOUT_SECS) * 1000 + SYNC_TURN_TIMEOUT_MARGIN_MS;
    const outcome = await waitForSupervisorResponse({ protoDir: gateProtoDir, runner, runName: containerName, timeoutMs });

    if (outcome.kind === 'dead') {
      // The gate supervisor is gone and wrote nothing. Waiting out the full
      // budget for a response that can no longer arrive is what makes `lazy
      // accept` look hung with nothing running; abort on the same terms as
      // the timeout path.
      const detail = outcome.diagnostics ? ` (${outcome.diagnostics})` : '';
      const message =
        `${whatLabel} aborted: the supervisor for ${displayId(task)} is no longer running ` +
        `and never reported back${detail}. Task returned to ${priorStatus}; accept aborted. ` +
        `Check that the runner can launch a supervisor (\`lazy doctor\`), then re-accept.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, message, 'system');
      throw new RpcError(500, message);
    }

    if (outcome.kind === 'timeout') {
      // Name the deadline: commands × per-command timeout + margin. A message
      // that does not say which clock fired sends the reader hunting through
      // configs that do not apply here (no agent watchdog is running).
      const message =
        `${whatLabel} hit the daemon's wait budget (${Math.floor(timeoutMs / 1000)}s — ` +
        `${preAccept.commands.length} command(s) × ${preAccept.timeout ?? DEFAULT_PRE_ACCEPT_TIMEOUT_SECS}s + ${Math.floor(SYNC_TURN_TIMEOUT_MARGIN_MS / 1000)}s margin): ` +
        `the gate never reported back. Task returned to ${priorStatus}; accept aborted. ` +
        `Re-accept when ready — a fresh gate will run.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      // The RpcError below reaches the CALLER; this comment reaches the TASK,
      // and the two audiences are not the same one. This wait is tens of
      // minutes — long enough that the caller may be gone by the time it fires,
      // and the field incident behind the old pre-accept turn's identical
      // comment was exactly that: the accept aborted correctly, the client
      // never saw the 504, and the task sat there with no explanation anywhere
      // for why the merge never happened.
      await storage.createComment(task.id, message, 'system');
      throw new RpcError(504, message);
    }

    if (outcome.response.status === 'error') {
      const crashMessage = `${whatLabel} crashed: ${outcome.response.error ?? 'unknown error'}. Task returned to ${priorStatus}; accept aborted.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, crashMessage, 'system');
      throw new RpcError(500, crashMessage);
    }

    const completed = completedResponses(outcome.response)[0];
    // INVARIANT: a merge never proceeds on a response the gate did not write.
    // The gate mailbox is dedicated (acceptGateProtocolDir) — no other command
    // writes there — so an absent `accept_gate` field means the response came
    // from somewhere else entirely. Refuse loudly rather than merge on an
    // unvalidated answer.
    const gate = completed.accept_gate;
    if (!gate) {
      const message =
        `${whatLabel} aborted: the response the daemon received did not come from the ` +
        `gate (no gate result), so nothing was validated. Task returned to ${priorStatus}; ` +
        `accept aborted. Re-accept to run the gate again.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, message, 'system');
      throw new RpcError(409, message);
    }

    // The gate records no turn, so a worktree rollback its recovery performed
    // would otherwise be invisible — journal it here, where every other
    // recovery the daemon hears about is recorded.
    await journalWorktreeRecovery(storage, task.id, completed.worktree_recovery);

    if (!gate.passed) {
      const cmdLabel = gate.failed_command ? `\`${gate.failed_command}\`` : 'a configured check';
      const exitLabel = gate.exit_code === -2 ? 'timed out' : `exited with ${gate.exit_code ?? 'a non-zero code'}`;
      const outputTail = gate.output ? `\n\n\`\`\`\n${gate.output.slice(-1500)}\n\`\`\`` : '';
      // Keep the accept-side copy byte-identical to the historical message —
      // surfaces and suites match on it.
      const message = `Pre-accept checks failed: ${cmdLabel} ${exitLabel}. Task returned to ${priorStatus}; accept aborted. Fix the issue, then re-accept.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, `${message}${outputTail}`, 'system');
      throw new RpcError(409, message);
    }

    // Gate passed. Return the task to the status it had before the accept so
    // the merge that follows transitions from a valid state, and a mid-merge
    // failure leaves the task cleanly re-acceptable AS IT WAS.
    await storage.updateTaskStatus(task.id, priorStatus, 'system');
  } finally {
    // The gate container is EPHEMERAL (§12.2): torn down however the gate ends
    // — pass, fail, crash, abort. Teardown failure must not mask the verdict
    // (the throw or return the caller is about to reach), but it is never
    // silently dropped either.
    if (runner && containerName) {
      try {
        if (await runner.isRunning(containerName)) await runner.stopRun(containerName);
        if (await runner.runExists(containerName)) await runner.removeRun(containerName);
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to tear down the acceptance-gate container '${containerName}': ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (gateProtoDir) {
      try {
        removeProtocolDir(gateProtoDir);
      } catch (err) {
        logger.warn(
          `Task ${displayId(task)}: failed to remove the acceptance-gate protocol dir '${gateProtoDir}': ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await removeLock(worktreePath);
  }
}



export interface RejectTaskParams {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface RejectTaskResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function rejectTask(
  projectRoot: string,
  params: RejectTaskParams,
): Promise<RejectTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'reject');
  // Released however the run ends: see beginWorktreeTeardown.
  const teardown: WorktreeTeardown = { release: () => {} };
  try {
    return await rejectTaskRun(projectRoot, params, phases, teardown);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    teardown.release();
  }
}

async function rejectTaskRun(
  projectRoot: string,
  params: RejectTaskParams,
  phases: PhaseReporter,
  teardown: WorktreeTeardown,
): Promise<RejectTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor: this runs INSIDE the daemon, where LAZY_ACTOR is never set,
  // so getActor() reports 'human' for every channel. The MCP boundary threads
  // the real channel through params; getActor() stays the CLI fallback.
  const actor = params.actor ?? getActor();

  phases.begin(TERMINATE_PHASES.preflight);

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  // `let`: a task stranded in `merging` is recovered below, which replaces this
  // with the refreshed record.
  let task = resolveResult.task;

  // --- Worktree uncommitted changes check ---
  const worktreePath = getWorktreePath(projectRoot, task);
  if (!params.acceptDirtyWorktree) {
    await checkUncommittedChangesOrThrow(worktreePath, displayId(task), 'reject');
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session.`);
  }
  if (sess.outcome === 'rejected') {
    return { taskId: task.id, displayId: displayId(task), branchName: sess.git_branch, parentTaskId: parentTaskIdOf(task), warnings: ['Task was already rejected.'] };
  }
  // Preserve reject's idempotency above, but do not let a stale Reject form
  // replace a different terminal verdict (notably Close, which abandons the
  // task while intentionally retaining its session record).
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is already ${task.status}.`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session already ended (${sess.outcome ?? 'ended'}).`);
  }

  // --- Status validation ---
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }
  // A member with a terminal open on the task is working in the files this
  // would clean up: refuse, and keep members out until this run ends.
  teardown.release = await beginWorktreeTeardown(task.id);

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, shortId(task.id), displayId(task));

  // A task stranded in 'merging' by a dead accept used to be un-rejectable:
  // the FSM has no merging → abandoned edge, so the human's typed reason was
  // saved to .lazy/recovery/ and then thrown away by the refusal. Recover the
  // task to a real resting state first; the ordinary transition applies from
  // there, and the reason lands.
  task = await escapeMergingForOperation(storage, task, actor, 'reject', projectRoot);

  const wasWorking = task.status === 'working';
  phases.end(displayId(task));
  phases.announce(rejectPhasePlan(wasWorking), displayId(task));

  // --- State transitions ---

  // If working, stop runner and transition to interrupted first.
  // Monitor on the runner the session actually ran on (session.runner_type),
  // falling back to global config for legacy sessions.
  if (wasWorking) {
    phases.begin(TERMINATE_PHASES.stop);
    const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
    const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
    await runner.stopRun(runName);
    await storage.updateTaskStatus(task.id, 'interrupted', actor);
    phases.end();
  }

  phases.begin(TERMINATE_PHASES.finalize);

  // Tell the parent it lost this subtask, with the reason the human typed.
  // BEFORE the status flip on purpose: the parent-child tap announces any
  // transition into `abandoned` as a backstop, and its wording would be the
  // bare "abandoned". Last-state-wins idempotency then skips that one.
  await notifyParentOfRemovedSubtask(storage, task, `rejected: ${params.reason.trim()}`);

  // Mark as abandoned
  await storage.updateTaskStatus(task.id, 'abandoned', actor);

  // End session
  await storage.endSession(sess.id, 'rejected');

  // Clean up container
  await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
  await revokeTaskTokens(projectRoot, task.id);

  // Store rejection reason as comment
  await storage.createComment(task.id, `[Rejected] ${params.reason.trim()}`, actor);

  phases.end();

  phases.begin(TERMINATE_PHASES.remote);

  // Close the PR. INVARIANT: no requesting-changes review, no reject comment
  // (engineer decision, 2026-09-21) — lazy does not write reviews or comments
  // to a forge. The reason is recorded on the task as a `[Rejected]` comment.
  try {
    const config = await loadConfig(projectRoot);
    const driver = createDriver(config);
    await driver.cleanup(sess.git_branch);
    phases.end();
  } catch (err) {
    logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    phases.end('remote cleanup failed (non-fatal)');
  }

  phases.begin(TERMINATE_PHASES.cleanup);

  // Clean up lock and worktree (preserve branch). cleanupWorktree captures the
  // raw agent session JSONL before teardown.
  await removeLock(worktreePath);
  await cleanupWorktree(worktreePath, projectRoot, storage, task.id, sess.agent_session_id);

  // Clean up protocol dir
  removeProtocolDir(getProtocolDir(task.id));

  phases.end();

  return {
    taskId: task.id,
    displayId: displayId(task),
    branchName: sess.git_branch,
    parentTaskId: parentTaskIdOf(task),
    warnings,
  };
}

// =====================================================================
// Close Task
// =====================================================================

export interface CloseTaskParams {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface CloseTaskResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function closeTask(
  projectRoot: string,
  params: CloseTaskParams,
): Promise<CloseTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'close');
  // Released however the run ends: see beginWorktreeTeardown.
  const teardown: WorktreeTeardown = { release: () => {} };
  try {
    return await closeTaskRun(projectRoot, params, phases, teardown);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    teardown.release();
  }
}

async function closeTaskRun(
  projectRoot: string,
  params: CloseTaskParams,
  phases: PhaseReporter,
  teardown: WorktreeTeardown,
): Promise<CloseTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: getActor() cannot see the caller's channel
  // from inside the daemon, so MCP threads it through params.
  const actor = params.actor ?? getActor();

  phases.begin(TERMINATE_PHASES.preflight);

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  // `let`: a task stranded in `merging` is recovered below, which replaces this
  // with the refreshed record.
  let task = resolveResult.task;

  // --- Status check ---
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is already ${task.status}.`);
  }
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }
  // A member with a terminal open on the task is working in the files this
  // would clean up: refuse, and keep members out until this run ends.
  teardown.release = await beginWorktreeTeardown(task.id);

  // --- Worktree uncommitted changes check ---
  const worktreePath = getWorktreePath(projectRoot, task);
  if (!params.acceptDirtyWorktree) {
    await checkUncommittedChangesOrThrow(worktreePath, displayId(task), 'close');
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);

  // See rejectTask: a merge whose owner is gone must not swallow the close
  // reason the human typed. Recover to a resting state, then close normally.
  task = await escapeMergingForOperation(storage, task, actor, 'close', projectRoot);

  const wasWorking = task.status === 'working';
  phases.end(displayId(task));
  phases.announce(closePhasePlan(wasWorking, !!sess), displayId(task));

  // --- State transitions ---

  // If working, stop runner and transition to interrupted first.
  // Monitor on the session's recorded runner (fallback: global config).
  if (wasWorking) {
    phases.begin(TERMINATE_PHASES.stop);
    if (sess) {
      const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
      const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
      await runner.stopRun(runName);
    }
    await storage.updateTaskStatus(task.id, 'interrupted', actor);
    phases.end();
  }

  phases.begin(TERMINATE_PHASES.finalize);

  // Close task (persists reason)
  await storage.abandonTask(task.id, params.reason, actor);

  // Re-parent unfinished children to the grandparent (or top-level).
  // Same logic as accept: closing a parent orphans its children.
  const reparented = await reparentChildren(task, storage);
  const reparentMsg = formatReparentWarning(reparented, task);
  if (reparentMsg) {
    warnings.push(`${reparentMsg}.`);
    for (const child of reparented) {
      await storage.incrementTaskPendingSync(child.id);
    }
  }
  warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, reparented));

  // Revoke this task's secrets. Deliberately OUTSIDE the `if (sess)` below:
  // accept and reject always have a session, but close is the one terminal path
  // that also runs on a task which never started. Such a task can still hold
  // per-task env vars — `lazy env set` works on a backlog task, and
  // `lazy start --env` writes them before the launch it may then fail — and a
  // token left behind here would never be cleaned up by anything, since the
  // task is now terminal. Both revocations are idempotent, so a task that
  // genuinely had neither pays a no-op.
  await revokeTaskTokens(projectRoot, task.id);

  phases.end();

  // Clean up container, remote resources, and worktree
  if (sess) {
    phases.begin(TERMINATE_PHASES.cleanup);
    await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);

    try {
      const config = await loadConfig(projectRoot);
      const driver = createDriver(config);
      await driver.cleanup(sess.git_branch);
    } catch (err) {
      logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    await removeLock(worktreePath);
    await cleanupWorktree(worktreePath, projectRoot, storage, task.id, sess.agent_session_id);
    phases.end();
  } else {
    phases.skip(TERMINATE_PHASES.cleanup, 'no session');
  }

  // Clean up protocol dir
  removeProtocolDir(getProtocolDir(task.id));

  return {
    taskId: task.id,
    displayId: displayId(task),
    branchName: sess?.git_branch ?? null,
    parentTaskId: parentTaskIdOf(task),
    warnings,
  };
}

// =====================================================================
// Reopen Task
// =====================================================================

export interface ReopenTaskParams {
  taskId: string;
  /** Required for a `complete` task; recorded as a `[Reopened]` comment when given. */
  reason?: string;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
}

export interface ReopenTaskResult {
  taskId: string;
  displayId: string;
  previousStatus: TaskStatus;
  /** Where the task landed: 'blocked' when it has a session, 'backlog' when it never ran. */
  newStatus: 'blocked' | 'backlog';
  hadSession: boolean;
  /** The preserved branch a session-holding task will come back on, or null. */
  gitBranch: string | null;
  warnings: string[];
}

/**
 * Reopen a terminal task: back to 'blocked' when it had a session, 'backlog'
 * when it never ran.
 *
 * THE one implementation of the reopen storage sequence — `lazy reopen`,
 * `lazy_reopen` (MCP) and the web task page all call this. It deliberately
 * does NOT recreate the worktree: that is host-side git work the CLI performs
 * around this call, and every other caller defers to the next start/unblock,
 * which sets the worktree up itself.
 *
 * Order is save-first: the reason comment is durable before any transition, so
 * a failed transition cannot have discarded what the human typed.
 */
export async function reopenTask(
  projectRoot: string,
  params: ReopenTaskParams,
): Promise<ReopenTaskResult> {
  const storage = await getOrCreateStorage();
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  if (!isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is ${task.status} — only abandoned or complete tasks can be reopened.`);
  }
  const reason = params.reason?.trim();
  if (task.status === 'complete' && !reason) {
    throw new RpcError(400, 'A reason is required to reopen a completed task.');
  }

  if (reason) {
    await storage.createComment(task.id, `[Reopened] ${reason}`, actor);
  }

  // storage.reopenTask itself lands the task on 'blocked' (has a session) or
  // 'backlog' (never ran) and clears completed_at — no separate status write.
  await storage.reopenTask(task.id, actor);

  const session = await storage.getSessionByTaskId(task.id);
  if (session) {
    // Clear ended_at/outcome and the agent session id so the next turn starts
    // a fresh agent conversation rather than resuming the finished one.
    await storage.resetSession(session.id);
  }

  // A reopened child owes its cluster a fresh fix-round budget: the count is
  // "since it was last started or accepted", and reopening ends that episode.
  await resetClusterFixRound(storage, task.id);

  return {
    taskId: task.id,
    displayId: displayId(task),
    previousStatus: task.status,
    newStatus: session ? 'blocked' : 'backlog',
    hadSession: !!session,
    gitBranch: session?.git_branch ?? null,
    warnings: [],
  };
}

// =====================================================================
// Accept Task — pre-flight validation only
// =====================================================================

/**
 * Accept task pre-flight validation.
 *
 * Accept is the most complex lifecycle operation because it involves
 * remote driver merges, conflict detection, CI check polling, and
 * continuation task creation — all of which have heavy CLI interaction.
 *
 * Rather than moving the ENTIRE accept flow into daemon, we move just
 * the pre-flight validation and early state checks. The merge orchestration
 * stays CLI-side because it's deeply intertwined with interactive prompts
 * (sync-with-upstream confirmation, PR creation, wait-for-CI polling).
 */

/**
 * Parent statuses that an identity-matched caller may merge into despite
 * {@link isActiveStatus}. Both describe a worktree with exactly one actor in it,
 * and that actor is the one blocked inside this very call. See the use site in
 * {@link acceptTaskPreflight} for the full argument.
 */
const ACTIVE_PARENT_EXEMPT_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['working', 'pairing']);

export interface AcceptTaskPreflightParams {
  taskId: string;
  approvedFiles?: string[];
  /**
   * Resolutions for every open raised item. Required (all-or-nothing) when any
   * open items exist — same posture as approvedFiles for pending violations.
   * `--yes` does not invent these; the caller must supply them or the TTY walk.
   */
  raisedResolutions?: RaisedItemResolution[];
  acceptDirtyWorktree?: boolean;
  /**
   * Merge knowingly even though the latest review left issues outstanding or
   * failed outright (`--allow-review-issues` on the CLI; never set over MCP).
   * See AcceptTaskParams.allowReviewIssues.
   */
  allowReviewIssues?: boolean;
  /**
   * Merge knowingly even though comments a human wrote have not been delivered
   * to the agent (`--allow-queued-comments` on the CLI, a checkbox in the web
   * Accept dialog). Without it accept refuses: merging would end the task with
   * that feedback never read. See src/task/queued-feedback.ts.
   */
  allowQueuedComments?: boolean;
  /**
   * The task id of the CALLER, when the caller is a task agent accepting one of
   * its own subtasks (set at the MCP boundary from the tool context; never set
   * by the CLI or the builder).
   *
   * INVARIANT: this only ever RELAXES the "refuse to merge into an active
   * parent" check, and only for the exact task that is the merge destination —
   * the caller is that parent, it is idle-by-construction while blocked inside
   * this MCP call, and the merge lands on its own branch. It grants nothing
   * else; the ownership gate that decides WHICH tasks an agent may accept lives
   * at the MCP boundary (assertAgentMayTargetChildOnly).
   */
  callerTaskId?: string;
  /**
   * Channel actor for attributing raised-item resolutions. Falls back to
   * getActor() when absent.
   */
  actor?: ActorInput;
}

/**
 * Everything the CLI must know about branch protection BEFORE it prompts.
 *
 * Computed DAEMON-SIDE on purpose: a CLI-side enrollment check run from a task
 * worktree resolves the wrong project root and falsely reports not-enrolled
 * (the fix-approve-enroll-ux incident). And per CLAUDE.md, every failable
 * check runs before the human is asked to type — enrollment and the forge
 * probe both live here so the passphrase prompt can never be a dead end.
 */
export interface AcceptGateInfo {
  /** True when this accept needs a human approval (and is not a merging re-entry). */
  gated: boolean;
  /** Why the merge is protected. Empty when not gated. */
  reason: string;
  /** A human already approved the task's PR/MR on the forge — no prompt needed. */
  satisfiedByForge: boolean;
  /** Verifier enrollment probe; 'unknown' means "carry on and ask". */
  enrollment: 'enrolled' | 'not-enrolled' | 'unknown';
  /** Actionable enrollment instructions when enrollment is 'not-enrolled'. */
  enrollmentMessage: string | null;
  /** Where the human gets the token, for the interactive prompt. */
  sourceLabel: string | null;
  /**
   * A builder review captured when a gated accept refused it — review TEXT
   * only, it authorizes nothing (src/protection/pending-review.ts). Present
   * whenever one is recorded, gated or not, so it is never silently dropped.
   */
  pendingReview: {
    actor: string;
    recordedAt: string;
    atSha: string;
    /** Commits on the task branch since the review; null when uncountable. */
    staleBy: number | null;
    text: string;
  } | null;
}

export interface AcceptTaskPreflightResult {
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
  /** Task metadata (includes remote refs etc.) */
  metadata: Record<string, string>;
  gate: AcceptGateInfo;
  /**
   * Protected files a reviewer REJECTED during this task, which the daemon then
   * reverted out of the branch. They are absent from the diff, which reads
   * identically to "the task never touched them" — so accept names them
   * (src/protection/reverted-files.ts). Empty when nothing was reverted.
   */
  revertedProtectedFiles: string[];
  warnings: string[];
}

export async function acceptTaskPreflight(
  projectRoot: string,
  params: AcceptTaskPreflightParams,
): Promise<AcceptTaskPreflightResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  const config = await loadConfig(projectRoot);

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolveResult.task;

  // --- Session check (needed early for branch name during worktree recovery) ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw acceptRefusal(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`, {
      reason: 'no-session',
      next: 'Start the task — there is no work to merge yet.',
      command: `lazy start ${shellQuote(displayId(task))}`,
    });
  }

  // --- Ended-session checks ---
  // These run BEFORE worktree recovery on purpose. A successful accept deletes
  // the worktree and the branch, so re-accepting would otherwise spend three
  // fetch retries hunting a branch that was merged away and then report
  // "Worktree is gone and branch ... not found" — burying the one fact the
  // user needs behind an unrelated, unactionable error.
  if (sess.outcome === 'accepted') {
    throw acceptRefusal(409, `Task ${displayId(task)} was already accepted (the merge has landed). Run 'lazy show ${displayId(task)}' to verify, or 'lazy reopen ${displayId(task)}' if you need to work on it further.`, {
      reason: 'already-accepted',
      next: 'Nothing to do — the merge already landed. Reopen the task only if you need more work on it.',
      command: `lazy show ${shellQuote(displayId(task))}`,
    });
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session already ended (${sess.outcome ?? 'ended'}).`);
  }

  // --- Worktree recovery + uncommitted changes check ---
  const worktreePath = getWorktreePath(projectRoot, task);
  if (!await pathExists(worktreePath)) {
    // Worktree is gone — try to recover from local or remote branch
    const branchName = sess.git_branch;
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, config.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
      // Recreating someone's worktree is a side effect they didn't ask for —
      // say so rather than doing it silently.
      warnings.push(`Worktree was missing, recreated from branch ${branchName}.`);
      if (recovery.dirty) {
        warnings.push('Recovered worktree has uncommitted changes.');
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!params.acceptDirtyWorktree) {
    await checkUncommittedChangesOrThrow(worktreePath, displayId(task), 'accept');
  }

  // --- Status validation ---
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }

  if (!isBlockedStatus(task.status) && task.status !== 'merging') {
    if (task.status === 'interrupted') {
      throw acceptRefusal(409, `Task ${displayId(task)} is interrupted. Resume it first: lazy resume ${displayId(task)}`, {
        reason: 'interrupted',
        next: 'Resume the task so it can finish its turn, then accept.',
        command: `lazy resume ${shellQuote(displayId(task))}`,
      });
    } else if (task.status === 'working') {
      throw acceptRefusal(409, `Task ${displayId(task)} is still working. Wait for it to finish.`, {
        reason: 'working',
        next: 'Wait for the agent to finish this turn, then accept.',
      });
    } else {
      throw new RpcError(409, `Task ${displayId(task)} is in state '${task.status}' and cannot be accepted.`);
    }
  }

  // Turns in sequence order — the violation re-detection and the
  // review-issues gate below both read them.
  const turns = await storage.getSessionTurns(sess.id);

  // --- File violation checks ---
  // INVARIANT (the gate is whole-branch — move-file-approval-to-accept): the
  // outstanding set is re-detected over the task's DIFF BASE..HEAD, not read off
  // one turn's record. Detection is per-turn, and since the reviewer's decision
  // moved here a conflict task runs many turns before anyone decides: the newest
  // record replaces the older one, so reading it merged an earlier turn's
  // protected edit with nobody having approved it, and a later turn's
  // authoritative empty re-detect cleared a still-pending file outright. git
  // says what is in the merge; the records say what a human decided. See
  // src/protection/outstanding.ts.
  // INVARIANT (a dead accept is resumed, never refused back): a RESUME — a
  // `merging` task still carrying the in-flight marker — re-checks none of the
  // accept's policy gates (violations, raised items, review issues, branch
  // in-sync). They passed when the human's accept began; re-asking them can only
  // refuse an accept whose merge may already have landed, burn its resume
  // attempts, and reopen the escape over merged work. Safety checks that protect
  // DATA (dirty worktree, pairing lock, an active parent) still run.
  const isResume = task.status === 'merging' && !!task.metadata?.[ACCEPT_IN_FLIGHT_KEY];

  const violationState = await resolveOutstandingViolations(projectRoot, task, sess, turns, storage);
  if (!isResume && violationState.outstanding.length > 0) {
    const pendingFiles = violationState.outstanding.map(v => v.file);

    const approvedFiles = params.approvedFiles ?? [];

    if (approvedFiles.length === 0) {
      // The command enumerates every file. This is the refusal that motivated
      // structured remedies: a 43-file violation set is not something a human
      // should retype flag by flag.
      throw acceptRefusal(409, `Task ${displayId(task)} has unresolved file permission violations: ${pendingFiles.join(', ')}. Use --approve-file to approve each file.`, {
        reason: 'pending-violations',
        // NEVER offer unblock as the alternative: it no longer reverts anything,
        // so a reviewer who follows that advice spends a turn and lands back on
        // this same refusal. The only other way a protected file leaves the diff
        // is the agent reverting it, which is a request, not a lazy operation.
        next: 'Approve every protected file the agent changed — approval is all-or-nothing, and nothing is reverted for you. To drop one instead, unblock and ask the agent to revert it itself.',
        command: acceptWithApprovedFilesCommand(displayId(task), pendingFiles),
        files: pendingFiles,
      });
    }

    const approvedSet = new Set(approvedFiles);
    const missingFiles = pendingFiles.filter(f => !approvedSet.has(f));

    if (missingFiles.length > 0) {
      throw acceptRefusal(409, `Missing approval for violated file(s): ${missingFiles.join(', ')}. All violated files must be approved.`, {
        reason: 'pending-violations',
        next: 'Approve the remaining protected files — approval is all-or-nothing.',
        command: acceptWithApprovedFilesCommand(displayId(task), pendingFiles),
        files: missingFiles,
      });
    }

    // Persist the decisions onto ONE turn, as the complete ledger: every file
    // this session ever recorded plus anything the scan found that no record
    // covered. Writing the merged set is what stops a later read of that turn
    // from being a partial snapshot again.
    //
    // INVARIANT: NEVER report an approval that was not recorded. The outstanding
    // set can come purely from the git scan, so a session with no turn to hold
    // the ledger is reachable — and the warning below used to fire anyway,
    // telling a reviewer their decision had landed while nothing persisted it.
    // An approval nobody can audit is the one thing this gate exists to produce,
    // so when there is no turn to write to, lazy creates one rather than
    // skipping the write or refusing a merge the human has already authorised.
    const ledger = mergedViolationRecords(
      turns,
      violationState.detected,
      [...violationState.approved, ...pendingFiles],
    );
    const ledgerTurn = latestViolationTurn(turns) ?? [...turns].reverse().find(t => t.role === 'agent');
    if (ledgerTurn) {
      await storage.updateTurnViolations(task.id, ledgerTurn.id, ledger);
    } else {
      // A human-role turn actored by the accepting party: this IS a human
      // decision, and it is the only record of it. violationRecordsByFile reads
      // violations off any turn that carries them, precisely so this one counts.
      await storage.createTurn({
        sessionId: sess.id,
        sequence: await storage.getNextTurnSequence(sess.id),
        role: 'human',
        content:
          `Approved ${pendingFiles.length} protected file change(s) at accept: ${pendingFiles.join(', ')}`,
        violations: ledger,
        actor: params.actor ?? getActor(),
      });
    }
    warnings.push(`Approved ${pendingFiles.length} protected file change(s): ${pendingFiles.join(', ')}`);
  }

  // --- Raised-item gate (structural-agent-questions) ---
  // Accept-time FRICTION, not security: every open raised item must be
  // responded to, promoted, dismissed, or acknowledged. All-or-nothing, same
  // posture as pending file violations. Close/reject leave opens as historical
  // `open` — this gate only runs on accept.
  //
  // VALIDATE only here. CLI accept calls this preflight before the passphrase
  // prompt; persisting (or materializing comments / peer tasks) would make a
  // cancelled prompt irreversible. acceptTask applies and materializes after
  // preflight returns.
  const raisedItems = await storage.getTaskRaisedItems(task.id);
  if (!isResume) {
    // Gate on the blocking items; the caller may additionally name an open
    // non-blocking one, exactly as applyRaisedResolutions allows on accept.
    validateRaisedResolutions(
      openRaisedItems(raisedItems),
      params.raisedResolutions,
      displayId(task),
      allOpenRaisedItems(raisedItems),
    );
  }

  // --- Review-with-issues gate ---
  // THE LATEST REVIEW ON THE CURRENT HEAD IS NOT CLEAN. Findings are the issue
  // store now, so what blocks is the review itself: findings still to fix
  // (`needs_work`), a raise still awaiting work (`needs_human`, or a legacy
  // review's findings), or a review that FAILED — a verdict outside the closed
  // set, or a missing sweep statement. A failed review gates exactly like
  // `needs_work`: nobody knows what it concluded, and "nobody knows" may not
  // read as clean.
  //
  // It clears when a later *work* agent turn runs (which un-finals the task, so
  // the next final dispatches a fresh review), when the human decides each
  // remaining raise on the record, or when a human overrides with
  // `lazy accept --allow-review-issues`. Note the items read here are the pre-resolution
  // state — resolutions passed to THIS accept are applied after preflight, and
  // the block below accounts for them.
  // The task's own pinned review settings — read once, used by BOTH the gate
  // below and the disregarded-review notice further down, so the two can never
  // disagree about what this task's settings are.
  const reviewSettings = reviewSettingsOf(task.metadata, config.review);

  if (!isResume) {
    const resolvedNow = params.raisedResolutions ?? [];
    // Resolve each resolution to the ONE item it names, rather than letting
    // every item go looking for a resolution that prefixes it. A short prefix
    // matching several items named none of them, and the per-item search would
    // hand that same resolution to EACH of them — marking items nobody resolved
    // as resolved, and opening this gate on a live review issue.
    // `resolveRaisedItemByIdOrPrefix` treats an ambiguous prefix as no match,
    // so the gate stays closed, which is the only direction it may fail in.
    const resolutionByItemId = new Map<string, typeof resolvedNow[number]>();
    for (const r of resolvedNow) {
      const target = resolveRaisedItemByIdOrPrefix(raisedItems, r.id);
      if (target) resolutionByItemId.set(target.id, r);
    }
    const gateItems = raisedItems.map(item => {
      // A resolution arriving with THIS accept resolves the item moments from
      // now (applyRaisedResolutions and materializePendingRaisedComments both
      // run after preflight, and a promotion CREATES its task there). Refusing
      // on the state it is about to leave would make
      // `lazy accept --promote-raised-subtask …` impossible to satisfy in one
      // command. The comment rides this accept, so it counts as delivered.
      const res = resolutionByItemId.get(item.id);
      if (!res) return item;
      return {
        ...item,
        status: raisedStatusForAction(res.action),
        comment_delivered_at: Date.now(),
      };
    });
    // `--allow-review-issues` OVERRIDES this gate, and something must. Under
    // the raise-per-finding contract a human could clear it by deciding each
    // Raise on the record; findings have no rows to dismiss or promote, so
    // without an override a human facing a FAILED review would have no way to
    // accept at all except spending another agent turn. CLI-only, so no agent
    // can wave away a review of its own work.
    // THE GATE FOLLOWS THE TASK'S REVIEW SETTINGS, not the project's: resolved
    // read-only from what the task pinned, so an accept can never move a task
    // between arms. Under the default `auto` gate only a `separate` task's
    // DISPATCHED review holds the merge — plus any review somebody ASKED for,
    // in any mode, because nobody spends a review turn they did not want.
    const awaiting = params.allowReviewIssues
      ? null
      : reviewIssuesAwaitingWork(turns, gateItems, reviewSettings);
    if (awaiting) {
      // Name WHICH failure this was. The blanket "FAILED to parse (… or …)"
      // made the reader guess, and for a review written under the PREVIOUS
      // contract — verdict `approve`, both sweeps present — it was untrue:
      // nothing failed to parse, the vocabulary changed underneath it. Six of
      // the nine verdict spellings that contract produced now land here.
      const what = awaiting.verdict === 'unparsed'
        ? describeReviewFailureShort(awaiting.review)
        : awaiting.raiseCount === 0
          // The only way to reach zero outstanding and still hold the gate: the
          // report's own security / data-integrity statement names something no
          // finding covers. "left 0 unaddressed issues" would read as a bug.
          ? 'named a security or data-integrity issue with no finding recorded for it'
          : `left ${awaiting.raiseCount} unaddressed issue${awaiting.raiseCount === 1 ? '' : 's'}`;
      // THE REMEDY FOLLOWS THE FAILURE. "Unblock so the agent can address the
      // review" is right when a reviewer read the work and left findings — and
      // useless when no reviewer ever ran: there are no findings to address, an
      // unblock un-finals the task, and its next final meets the same obstacle.
      // The record names that obstacle and how to clear it, so this points
      // there instead of at an action that changes nothing.
      const neverRan = reviewWasNeverDispatched(awaiting.review);
      throw acceptRefusal(
        409,
        `Task ${displayId(task)} has a formal review (turn #${awaiting.sequence}) that ${what}, ` +
        `and no work turn has run since. ` +
        (neverRan
          ? `Clear what stopped it — turn #${awaiting.sequence} says what and how — and the ` +
            `review dispatches by itself, or accept with --allow-review-issues if you have ` +
            `decided the work is done.`
          : `Unblock so the agent can address the review, or ` +
            `accept with --allow-review-issues if you have decided the work is done.`),
        {
          reason: 'review-issues-unaddressed',
          next: neverRan
            ? `No reviewer ever ran for this task. Clear what stopped it (turn #${awaiting.sequence} names it and says how) and the review dispatches on the next tick, or accept with --allow-review-issues once you have decided the work is done.`
            : 'Unblock the task so the agent can address the review findings, or accept with --allow-review-issues once you have decided the work is done.',
          command: neverRan
            ? `lazy show ${shellQuote(displayId(task))} --full`
            : `lazy unblock ${shellQuote(displayId(task))} -m "Address the review findings"`,
        },
      );
    }

    // --- Undelivered human feedback gate ---
    // Comments a human wrote that no prompt has carried yet. Accepting now ends
    // the task with that feedback never read (CLAUDE.md, "Never Lose Human
    // Feedback"), so accept refuses unless the human says they mean it. A
    // policy gate: a resumed accept already passed it and never re-checks.
    // The same count backs the "Before you can accept" row every surface shows.
    if (!params.allowQueuedComments) {
      const queuedFeedback = queuedHumanFeedbackCount({
        session: sess,
        turns,
        comments: await storage.getTaskComments(task.id),
        pendingReviewComments: (await storage.getTaskReviewComments(task.id)).filter(isPendingDelivery).length,
      });
      if (queuedFeedback > 0) {
        const n = `${queuedFeedback} queued comment${queuedFeedback === 1 ? '' : 's'}`;
        throw acceptRefusal(
          409,
          `Task ${displayId(task)} has ${n} that ${queuedFeedback === 1 ? 'has' : 'have'} not been delivered to the agent. ` +
          `Unblock to deliver ${queuedFeedback === 1 ? 'it' : 'them'}, or accept with --allow-queued-comments to merge without the agent reading ${queuedFeedback === 1 ? 'it' : 'them'}.`,
          {
            reason: 'queued-comments-undelivered',
            next: 'Unblock the task so the agent reads the queued comments, or accept with --allow-queued-comments if you have decided they no longer matter.',
            command: `lazy unblock ${shellQuote(displayId(task))} -m "Address the queued comments"`,
          },
        );
      }
    }
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Check for zero commits ---
  const commits = await storage.getSessionCommits(sess.id);
  if (commits.length === 0) {
    throw acceptRefusal(409, `Task ${displayId(task)} has no commits. Nothing to merge. Use 'lazy close' instead.`, {
      reason: 'no-commits',
      next: 'There is nothing to merge — close the task instead of accepting it.',
      command: `lazy close ${shellQuote(displayId(task))} --reason "no work to merge"`,
    });
  }

  // --- Determine merge target ---
  let mergeTargetBranch: string;
  let parentDisplayId: string | null = null;
  let parentTask: Task | null = null;
  const childParentId = parentTaskIdOf(task);
  const isChildTask = !!childParentId;

  if (childParentId) {
    parentTask = await storage.getTask(childParentId);
    if (!parentTask) {
      throw new RpcError(400, `Parent task ${childParentId} not found`);
    }

    // Refuse to merge into active parent — EXCEPT when the caller IS the parent
    // whose worktree is the merge destination.
    //
    // INVARIANT: a task-scoped caller accepting its own subtask is the one
    // legitimate merge into an active parent. The parent is "active" precisely
    // BECAUSE it is sitting inside this MCP call waiting for the answer; nothing
    // else is touching that worktree, and the merge lands on the caller's own
    // branch. Requiring 'blocked' here is what made the agent self-orchestration
    // loop impossible to close (agents resorted to raw `git merge` instead).
    //
    // Two statuses qualify, on the same quiescence argument:
    //   - 'working': the parent's agent is the caller, blocked inside this call.
    //   - 'pairing': a human is driving that session interactively and is the
    //     sole actor in the worktree; an accept issued from it IS the human's
    //     decision. (Attribution still records 'agent' — channel-based, and
    //     knowingly imprecise for pairing.)
    // 'merging' and 'interrupted' still refuse: neither implies a single quiet
    // actor waiting on this call.
    //
    // The exemption stays narrow on the other axis: an identity match on the
    // merge DESTINATION. Only the MCP boundary sets callerTaskId (from the tool
    // context, never from client input), so CLI and builder callers can never
    // reach it — see test/e2e/accept-working-parent.test.ts.
    const callerIsParentAgent =
      !!params.callerTaskId &&
      params.callerTaskId === parentTask.id &&
      ACTIVE_PARENT_EXEMPT_STATUSES.has(parentTask.status);
    if (isActiveStatus(parentTask.status) && !callerIsParentAgent) {
      throw acceptRefusal(409, `Parent task ${displayId(parentTask)} is currently ${parentTask.status}. Wait for it to become blocked.`, {
        reason: 'parent-active',
        next: `Wait for the parent task ${displayId(parentTask)} to stop working, then accept.`,
      });
    }

    parentDisplayId = displayId(parentTask);
    mergeTargetBranch = await getBranchNameFromId(childParentId, storage);
  } else {
    const { resolveDetachedHead } = await import('../git/operations');
    mergeTargetBranch = await resolveDetachedHead(targetBranchOf(task) ?? 'main', projectRoot, config.remote.git_remote);
  }

  // --- Branch sync validation (root tasks with remote driver) ---
  // Skip in offline mode — there's no remote to validate against, and the
  // accept will go through LocalDriver anyway. Skipped on a resume (see
  // isResume above): it fetches, and a network blip must not refuse it.
  if (!isChildTask && !isResume) {
    const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
    const driver = createDriver(config, undefined, { offline });
    if (driver.needsSync) {
      const syncCheck = await validateBranchInSyncWithRemote(mergeTargetBranch, config.remote.git_remote, projectRoot);
      if (!syncCheck.inSync) {
        throw acceptRefusal(409, `${syncCheck.error} Fix this before accepting to avoid a half-merged state.`, {
          reason: 'out-of-sync',
          next: `Bring ${mergeTargetBranch} back in step with the remote before merging into it.`,
        });
      }
    }
  }

  // --- Branch-protection pre-flight ---
  // Answers "will this accept need a passphrase?" BEFORE the CLI prompts, so
  // the prompt is never a dead end (CLAUDE.md: failable checks run first).
  // 'merging' is exempt like the gate itself: re-entry completes an already
  // authorized merge.
  const gate: AcceptGateInfo = {
    gated: false,
    reason: '',
    satisfiedByForge: false,
    enrollment: 'unknown',
    enrollmentMessage: null,
    sourceLabel: null,
    pendingReview: null,
  };

  if (task.status !== 'merging') {
    const decision = await resolveEdgeGateDecision(
      { sourceBranch: sess.git_branch, targetBranch: mergeTargetBranch },
      config,
      projectRoot,
      storage,
    );
    if (decision.gated) {
      gate.gated = true;
      gate.reason = decision.reason;

      const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
      const gateDriver = createDriver(config, { storage, lazyRoot: projectRoot }, { offline });
      if (gateDriver.needsSync && gateDriver.hasRemoteRef(task)) {
        try {
          gate.satisfiedByForge = await gateDriver.hasExternalApproval(task);
        } catch (err) {
          // Fail CLOSED, same as enforcement: an unreachable forge never opens
          // the gate — the human can still approve at the passphrase prompt.
          logger.warn(
            `Branch protection pre-flight: could not check for a PR/MR approval on task ` +
            `${displayId(task)} (${err instanceof Error ? err.message : err}) — treating it as unapproved.`,
          );
        }
      }

      const verifier = createHumanTokenVerifier(projectRoot);
      const probe = await verifier.probeEnrollment();
      gate.enrollment = probe.status;
      gate.enrollmentMessage = probe.status === 'not-enrolled' ? probe.message : null;
      gate.sourceLabel = verifier.sourceLabel;
    }
  }

  // The captured builder review is surfaced whether or not the edge is still
  // gated — protection being turned off later must not silently discard it.
  try {
    const review = await peekPendingAcceptReview(storage, task.id);
    if (review) {
      let staleBy: number | null = null;
      if (review.at_sha) {
        try {
          // INVARIANT: first-parent. "Stale by N commits" means N commits the
          // TASK made since the review — a sync or a child accept merged in
          // since then contributes its merge commit, never the whole line it
          // merged, which would report a months-old upstream as this task's drift.
          staleBy = (await getNewCommits(review.at_sha, worktreePath, { firstParent: true })).length;
        } catch {
          // SHA no longer reachable (rebase, recovered worktree): stale, but
          // by an uncountable amount — reported as null, never as fresh.
        }
      }
      gate.pendingReview = {
        actor: review.actor,
        recordedAt: review.recorded_at,
        atSha: review.at_sha,
        staleBy,
        text: review.text,
      };
    }
  } catch (err) {
    warnings.push(
      `Could not read the pending builder review: ${err instanceof Error ? err.message : err}`,
    );
  }

  // INVARIANT (the final is not an accept gate): accept is allowed from ANY
  // NORMAL PARK — reviewable, needs-input, or plain blocked — with every open
  // blocking item resolved in this same call. A human accepting with those
  // items in hand IS the declaration, so requiring a separate one made them
  // run a command purely to unlock the command they had already decided on.
  // What stays refused is `interrupted` (the status check above): a turn that
  // was killed has an unknown ending, and resume or unblock comes first.
  //
  // The `final` record itself is NOT gone — it still decides whether the
  // daemon dispatches a review, and it still carries the "head has since
  // moved" label. It just gates nothing here.

  // ACCEPT NEVER SILENTLY DISREGARDS A REVIEW (engineer, 2026-09-21). The gate
  // above may have let this merge through while a recorded review sits on the
  // task with findings in it — because the task is in a mode whose dispatched
  // review does not gate, or because the gate is `never`. That is a legitimate
  // outcome and an invisible one, so it is said out loud here rather than left
  // for a human to discover in a report nobody opened.
  //
  // A clean review is not mentioned: "I ignored a review that found nothing" is
  // noise. Nor is a review that DOES gate — that path refuses, and the refusal
  // is its own notice.
  {
    const disregarded = reviewDisregardedByGate(turns, reviewSettings);
    if (disregarded) {
      const count = gatingFindingsOf(disregarded.review).length;
      warnings.push(
        `A review (turn #${disregarded.sequence}) is NOT holding this accept because ` +
        `${disregarded.reason}` +
        (count > 0
          ? ` — it left ${count} finding${count === 1 ? '' : 's'} above medium. `
          : ' — read it before you merge. ') +
        `See \`lazy show ${displayId(task)}\`.`,
      );
    }
  }

  return {
    taskId: params.taskId,
    fullTaskId: task.id,
    displayId: displayId(task),
    worktreePath,
    branchName: sess.git_branch,
    sessionId: sess.id,
    parentTaskId: parentTaskIdOf(task),
    mergeTargetBranch,
    isChildTask,
    parentDisplayId,
    taskStatus: task.status,
    commitCount: commits.length,
    metadata: task.metadata ?? {},
    gate,
    // Read from the turns already loaded above — no extra storage round-trip.
    revertedProtectedFiles: revertedProtectedFiles(turns),
    warnings,
  };
}

// =====================================================================
// Accept Task — full orchestration (preflight + merge + cleanup)
// =====================================================================

export interface AcceptTaskParams {
  taskId: string;
  reason?: string;
  /**
   * WHOSE review draft this call spends, imposed by the daemon from the
   * CALLER's token (`applyCallerActor`), never read from a client.
   *
   * Separate from `actor` on purpose. `actor` answers "who did this", and on a
   * laptop that is now the git identity — but a draft is keyed by the CLIENT
   * that typed it, and every unattributed client there shares one key (`local`,
   * see reviewerKey in src/review-draft.ts). Deriving the key from `actor`
   * instead left the review page's own draft unclearable the moment writes
   * started carrying a person.
   */
  callerReviewerKey?: string;
  /**
   * The approval passphrase for a protected merge, collected by the CLI at its
   * own TTY prompt and verified inline by the edge gate. Never set over MCP —
   * the MCP boundary has no parameter that can express it, which is what makes
   * "--yes skips prompts, not the gate" structural rather than a convention.
   */
  token?: string;
  approvedFiles?: string[];
  /**
   * Resolutions for every open raised item (all-or-nothing). See
   * {@link AcceptTaskPreflightParams.raisedResolutions}.
   */
  raisedResolutions?: RaisedItemResolution[];
  acceptDirtyWorktree?: boolean;
  /**
   * Merge knowingly even though the `[automation] accept_check` gate failed
   * (`--allow-broken` on the CLI). The failure is still reported as a warning —
   * this suppresses the refusal, never the fact.
   */
  allowBroken?: boolean;
  /**
   * The human overruling the `review-issues-unaddressed` gate
   * (`--allow-review-issues`; CLI-only — see AcceptTaskPreflightParams).
   *
   * CLI-only for the same reason `--final` was before it: findings are fix feedback,
   * and letting an agent wave away a review of its own work would make the
   * review advisory. A human who has read the work decides.
   */
  allowReviewIssues?: boolean;
  /** See {@link AcceptTaskPreflightParams.allowQueuedComments}. */
  allowQueuedComments?: boolean;
  /**
   * Channel actor (MCP builder → 'builder', MCP task agent → 'agent', CLI →
   * 'human'); falls back to getActor() when absent. Set at the MCP boundary
   * because the accept is executed in the daemon, where the env-var default
   * cannot see the caller's channel. See {@link MCP_ACTOR} / {@link AGENT_ACTOR}.
   */
  actor?: ActorInput;
  /** See {@link AcceptTaskPreflightParams.callerTaskId}. */
  callerTaskId?: string;
  /**
   * Phase-narration sink (see daemon/progress.ts). Supplied by the transport —
   * the daemon's heartbeat envelope on the RPC/MCP path, the CLI itself on the
   * in-process fallback path. Absent means nobody is listening; the accept runs
   * identically either way.
   */
  onProgress?: ProgressEmitter;
}

export interface AcceptTaskResult {
  taskId: string;
  displayId: string;
  status: 'merged' | 'pending';
  reason?: string;
  prUrl?: string;
  warnings: string[];
  /**
   * Set when the merge landed and the task is `complete`, but post-accept
   * follow-through (fast-forward, parent push, tag, reparent, cleanup) failed
   * and is still owed. Surfaces report it as a FAILURE; the daemon retries it.
   */
  followThroughPending?: { steps: FollowThroughStep[]; error: string };
}

/**
 * Surface a driver merge failure without stacking "Merge failed:" prefixes.
 * Drivers (and the squash path) already produce a complete sentence; wrapping
 * again was what produced "Merge failed: Merge failed: Squash merge failed: …".
 */
function formatAcceptMergeFailure(error: string | undefined): string {
  const msg = (error ?? 'unknown error').trim();
  if (!msg) return 'Merge failed: unknown error';
  if (/^(merge failed:|could not squash-merge|git could not update the index|cannot proceed:|squash merge)/i.test(msg)) {
    return msg;
  }
  return `Merge failed: ${msg}`;
}

/**
 * Accept a task: validate, merge to parent/target, and complete.
 *
 * This is the full accept orchestration — everything commandAccept does minus
 * interactive prompts and console output. Follows the reference implementation
 * in src/cli/commands/accept.ts.
 *
 * Flow:
 * 1. Run preflight validation (status, session, uncommitted, violations, etc.)
 * 2. Auto-create remote ref if needed (push branch + create PR)
 * 3. Check pre-merge gates (CI status, required reviews, etc.)
 * 4. Push parent branch local commits to remote (INVARIANT)
 * 5. driver.merge() — attempt merge via driver
 * 6. Handle result: failed (conflict → error with sync hint), pending (set merging status), merged (cleanup)
 * 7. Fast-forward local branch, end session, post review
 * 8. Reparent children, cleanup worktree/container/protocol
 *
 * CONCURRENCY: the entire orchestration runs under a per-task lifecycle lock
 * (see task-lifecycle-lock.ts). The daemon serves RPCs concurrently, so without
 * this lock a human accept and a builder accept on the same task interleave at
 * every await, both clear the preflight TOCTOU, and both run the merge — which
 * is the field bug that left a task `blocked` while its merge was applied. The
 * lock makes the loser re-run preflight after the winner commits, see the
 * accepted session outcome, and return a clean "already accepted".
 */
export async function acceptTask(
  projectRoot: string,
  params: AcceptTaskParams,
): Promise<AcceptTaskResult> {
  // Resolve to the canonical task id BEFORE taking the lock so two accepts that
  // name the same task by different forms (code / short id / full id) serialize
  // against the same key. Resolution failures fall through to the inner function,
  // which throws the proper RpcError.
  const storageForResolve = await getOrCreateStorage();
  const resolved = await storageForResolve.resolveTask(params.taskId);
  const lockKey = resolved.task?.id ?? params.taskId;
  // A child's merge lands in its PARENT's worktree. A member working there
  // refuses the accept (409, naming them) — checked under the parent's
  // lifecycle lock, the one the member's entry takes, FIRST: before any step of
  // the accept has run, so a refused accept has no effect anywhere (no check or
  // gate command, no push, no PR/MR, no forge write) — and members stay out of
  // the parent until the accept has returned. Claimed BEFORE this task's lock and never inside it: taking
  // one task's lock while holding another's could deadlock against a path
  // that takes them the other way round.
  const parentId = resolved.task ? parentTaskIdOf(resolved.task) : null;
  const releaseParent = parentId ? await beginWorktreeTeardown(parentId) : null;
  let result: AcceptTaskResult;
  try {
    result = await withTaskLifecycleLock(lockKey, () => acceptTaskInner(projectRoot, params));
  } finally {
    releaseParent?.();
  }
  // Reached only when the accept was NOT refused (a refusal throws, and must
  // leave the draft where it is). The review is over: the reason has been
  // delivered, and nothing about this task is still in progress.
  await clearDeliveredReviewDraft(lockKey, params.callerReviewerKey, params.actor, 'accept');
  await fileReviewAsks(lockKey, 'accept');
  return result;
}

/**
 * Files already marked ✅ on the task, plus any named on this accept.
 *
 * The protection-gate command has to list them: a conflict task's stored
 * approvals are not implied by a bare `lazy accept <id>`.
 */
async function approvedFilesForAcceptCommand(
  storage: Storage,
  taskId: string,
  fromParams?: readonly string[],
): Promise<string[]> {
  const session = await storage.getSessionByTaskId(taskId);
  // Across ALL turns, latest decision per file — an approval made several turns
  // ago is still an approval, and reading only the newest violation turn dropped
  // it from the command the human is told to re-run.
  const fromTurn = session
    ? approvedFilesFromRecords(await storage.getSessionTurns(session.id))
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...fromTurn, ...(fromParams ?? [])]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** Enter the merge phase: mark it in flight, then stamp `merging`. */
async function beginMergePhase(
  storage: Storage,
  task: Task,
  priorStatus: TaskStatus,
  actor: ActorInput,
  intent: AcceptIntent,
  fresh: boolean,
): Promise<void> {
  // A FRESH accept starts its own resume budget: leftovers from an earlier dead
  // accept of this task (exhausted attempts, a backoff time) would otherwise
  // stop the sweep from ever resuming this one. A resume keeps its count — the
  // sweep bumps it before calling in, and resetting it would retry forever.
  if (fresh) {
    await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_ATTEMPTS_KEY, '');
    await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_NEXT_AT_KEY, '');
  }
  // The human's decision is durable before anything in the merge phase runs:
  // a daemon killed from here on RESUMES the accept from this record (Sweep 9,
  // src/daemon/stranded-merge.ts) instead of restoring the task to `blocked`.
  await storage.updateTaskMetadata(task.id, ACCEPT_INTENT_KEY, JSON.stringify(intent));
  // Marker next: a crash between the two writes leaves a marker on a
  // non-merging task, which is inert. The reverse order would leave a `merging`
  // task with no marker — indistinguishable from a real remote-pending merge.
  await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, priorStatus);

  // Same race the finalize step guards (see "Transition: → merging → complete"):
  // the remote-sync reconciler can observe the merged MR/PR and complete the
  // task from under us. Stamping `merging` on a task that is already complete
  // (or already merging) throws a state-machine error over a merge that
  // actually succeeded, so re-read and skip what no longer applies.
  const live = (await storage.getTask(task.id))?.status ?? task.status;
  if (live === 'complete' || live === 'merging') return;
  await storage.updateTaskStatus(task.id, 'merging', actor);
}

/**
 * Leave the merge phase without a merge: restore the true prior status.
 *
 * INVARIANT: only a LIVE accept that fails BEFORE its merge lands may call
 * this. A dead accept is resumed, never restored (stranded-merge.ts), and
 * nothing after the merge may restore — the merge is the commit point.
 */
async function abortMergePhase(
  storage: Storage,
  task: Task,
  priorStatus: TaskStatus,
  actor: ActorInput,
): Promise<void> {
  try {
    await storage.updateTaskStatus(task.id, priorStatus, actor);
    await clearMergeInFlight(storage, task);
  } catch (err) {
    // The original failure is what the caller must see; losing the status
    // restore on top of it is bad but must not mask it. Log and move on — the
    // marker left behind is what a re-accept reads to recover.
    logger.warn(`accept: failed to restore status '${priorStatus}' after an aborted merge phase: ${err instanceof Error ? err.message : err}`);
  }
}

/** The merge is no longer in flight (it landed, or the forge owns it now). */
async function clearMergeInFlight(storage: Storage, task: Task): Promise<void> {
  await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, '');
  await storage.updateTaskMetadata(task.id, ACCEPT_INTENT_KEY, '');
  await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_ATTEMPTS_KEY, '');
  await storage.updateTaskMetadata(task.id, ACCEPT_RESUME_NEXT_AT_KEY, '');
}

/**
 * THE COMMIT POINT of an accept: the merge has landed, so the task becomes
 * accepted NOW, before anything else is attempted.
 *
 * INVARIANT (accept-merge-is-commit-point, engineer 2026-09-22): the git merge
 * is the LAST fallible step before `complete`. Only store writes run here. The
 * fast-forward, the parent push, the accept tag, reparenting and cleanup used to
 * sit between the merge and this transition, and each of them failing left
 * merged work on a task the store called `merging` or `blocked` — it bit in the
 * field repeatedly. They are follow-through now ({@link runAcceptFollowThrough}).
 *
 * Order: the follow-through record is written FIRST, so a crash anywhere after
 * it still leaves the daemon a record of what is owed; the `[Accepted]`
 * comment precedes ending the session (see below); the in-flight marker is
 * cleared LAST, so a crash before the status write leaves a marked `merging`
 * task that the stranded-merge sweep resumes (the idempotent squash answers
 * "already landed") rather than restores.
 */
export async function commitAcceptTransition(
  storage: Storage,
  task: Task,
  opts: {
    reason: string;
    actor: ActorInput;
    /** Who decided the accept — the original caller when this is a resume. */
    commentActor: ActorInput;
    /** Write the `[Accepted]` comment (false where the pending path already did). */
    writeComment: boolean;
    /** A resume may have written the comment before dying — don't write it twice. */
    dedupeComment: boolean;
    followThrough: AcceptFollowThrough;
  },
): Promise<void> {
  await storage.updateTaskMetadata(task.id, ACCEPT_FOLLOWTHROUGH_KEY, JSON.stringify(opts.followThrough));

  // The human's reason lands BEFORE the session ends. An ended `accepted`
  // session is what storage's self-heal reads to flip a non-terminal task to
  // `complete` on its own — killed after endSession, the task completes
  // without us; the reason must already be on it by then.
  if (opts.writeComment) {
    const content = `${ACCEPTED_COMMENT_PREFIX}${opts.reason}`;
    const already = opts.dedupeComment
      && (await storage.getTaskComments(task.id)).some((c) => c.content === content);
    if (!already) await storage.createComment(task.id, content, opts.commentActor);
  }

  const sess = await storage.getSessionByTaskId(task.id);
  if (sess && sess.ended_at === null) {
    await storage.endSession(sess.id, 'accepted');
  }

  // Race: the remote-sync reconciler can observe a just-merged MR/PR and
  // complete the task from under us. Re-read and skip what already applied —
  // otherwise the human sees "Invalid status transition: 'complete' → 'merging'"
  // over a merge that succeeded.
  const live = (await storage.getTask(task.id))?.status ?? task.status;
  if (live !== 'complete') {
    if (live !== 'merging') await storage.updateTaskStatus(task.id, 'merging', opts.actor);
    await storage.updateTaskStatus(task.id, 'complete', opts.actor);
  }
  // From here the task IS complete: nothing below may turn a completed
  // transition into a thrown error (the caller would report a failed accept and
  // skip this run's follow-through). Each is housekeeping; log and move on.
  try {
    await clearMergeInFlight(storage, task);
  } catch (err) {
    // Inert on a `complete` task (the sweep lists `merging` only), and
    // follow-through clears it on its next run.
    logger.warn(`Task ${displayId(task)}: could not clear the in-flight marker after accept: ${err instanceof Error ? err.message : err}`);
  }
  try {
    // The captured builder review is now attached to the comment — its job is done.
    await clearPendingAcceptReview(storage, task.id);
  } catch (err) {
    logger.warn(`Task ${displayId(task)}: could not clear the pending accept review after accept: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await resetRoundBudgetsOnAccept(storage, task.id);
  } catch (err) {
    logger.warn(`Task ${displayId(task)}: could not reset round budgets after accept: ${err instanceof Error ? err.message : err}`);
  }
}

/** Result of one follow-through run. `pending` is empty when everything is done. */
export interface FollowThroughOutcome {
  pending: FollowThroughStep[];
  error?: string;
  /**
   * Cleanup is waiting for this member's terminal session to end — not a
   * failure: it is not counted, backed off or reported, and the next pass
   * after their session ends runs it.
   */
  waitingForMember?: string;
}

/**
 * Run whatever post-accept follow-through a `complete` task still owes.
 *
 * Every step is idempotent and recorded as done the moment it succeeds, so the
 * accept itself and the daemon's retry sweep (`sweepAcceptFollowThrough`, stranded-merge.ts)
 * run the SAME function and pick up where the last attempt stopped. The first
 * failing step stops the run (later steps may depend on it — the tag reads the
 * fast-forwarded target) and is recorded with its error.
 *
 * INVARIANT: nothing here changes task status. A task that reached `complete`
 * stays there whatever fails below.
 *
 * INVARIANT (CLAUDE.md "Fail hard on remote failures", unchanged): a parent push
 * that fails after its retries is a FAILURE — reported in the accept result, on
 * every retry, and in a system message when it persists. It is never softened
 * into success. It simply no longer un-accepts work that has already merged.
 */
export async function runAcceptFollowThrough(
  projectRoot: string,
  taskId: string,
  ctx: {
    warnings?: string[];
    driver?: ReturnType<typeof createDriver>;
    config?: ResolvedConfig;
    /** The record the transition just wrote (the accept's own run); read from the task otherwise. */
    record?: AcceptFollowThrough;
    /** The caller's storage handle (remote-sync passes its own); the daemon's otherwise. */
    storage?: Storage;
  } = {},
): Promise<FollowThroughOutcome> {
  const storage = ctx.storage ?? await getOrCreateStorage();
  const task = await storage.getTask(taskId);
  if (!task) return { pending: [] };
  // Killed inside the transition after the session ended, a task can be healed
  // to `complete` by storage with the in-flight marker still on it. Inert (the
  // stranded-merge sweep lists `merging` only), but misleading — clear it.
  if (task.status === 'complete' && task.metadata?.[ACCEPT_IN_FLIGHT_KEY]) {
    await clearMergeInFlight(storage, task);
  }
  const record = ctx.record ?? readFollowThrough(task);
  if (!record) {
    if (task.metadata?.[ACCEPT_FOLLOWTHROUGH_KEY]) {
      // Unreadable record: say so once and drop it, rather than have the sweep
      // find it every tick and silently do nothing.
      logger.warn(`Task ${displayId(task)}: unreadable post-accept follow-through record dropped: ${task.metadata[ACCEPT_FOLLOWTHROUGH_KEY]}`);
      await storage.updateTaskMetadata(task.id, ACCEPT_FOLLOWTHROUGH_KEY, '');
    }
    return { pending: [] };
  }
  const warnings = ctx.warnings ?? [];

  const config = ctx.config ?? await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  const driver = ctx.driver ?? createDriver(config, { storage, lazyRoot: projectRoot }, { offline });
  const { resolveDetachedHead } = await import('../git/operations');
  const target = await resolveDetachedHead(record.targetBranch, projectRoot, config.remote.git_remote);

  const steps: Record<FollowThroughStep, () => Promise<void>> = {
    reparent: async () => {
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) warnings.push(`${reparentMsg}.`);
      const stackAdvice = stackedChildAdvisory(reparented.length, target);
      if (stackAdvice) warnings.push(`${stackAdvice}.`);
      // Mark reparented children for sync: the branch deletion in cleanup
      // prevents detectParentBranchChanges() from triggering one on its own.
      for (const child of reparented) {
        await storage.incrementTaskPendingSync(child.id);
      }
      // A child's open PR/MR still names this task's branch as its base:
      // retarget it onto the child's new target, or close it (never throws).
      warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, reparented));
    },
    'notify-parent': async () => {
      await notifyParentOfAcceptedSubtask(storage, task, projectRoot);
    },
    'fast-forward': async () => {
      if (!record.viaForge) return;
      const ff = await driver.fastForwardLocal(target, projectRoot);
      if (!ff.success) {
        throw new Error(`${ff.warning || 'failed to fast-forward'} — the remote merge landed, but local ${target} could not be updated`);
      }
      if (ff.warning) warnings.push(ff.warning);
      // Pin the forge merge for the tag NOW, persisted before the tag step: a
      // tag written on a later retry would otherwise name whatever the target
      // holds by then, later merges included.
      if (!record.mergeSha) {
        record.mergeSha = await readTargetSha(target, projectRoot);
        await persist();
      }
    },
    'push-parent': async () => {
      // A LOCAL squash writes the merge commit only to the local parent; unpushed,
      // local <parent> drifts ahead of origin and `lazy sync` resolves to a stale
      // origin/<parent>. Plain branch push (withRemoteRetry, fails hard), never
      // a PR/MR. Uses the ORIGINAL driver: the merge driver for an unprotected
      // target is a LocalDriver whose push is a no-op.
      if (!record.pushParent) return;
      if (offline || !driver.needsSync) {
        throw new Error(`lazy is offline, so ${target} cannot be pushed to ${config.remote.git_remote} yet`);
      }
      try {
        await driver.pushBranch(target);
      } catch (err) {
        throw new Error(
          `pushing ${target} to ${config.remote.git_remote} failed: ${err instanceof Error ? err.message : err}. ` +
          `Local ${target} is ahead of the remote until it is pushed (git push ${config.remote.git_remote} ${target}).`,
        );
      }
    },
    'close-review': async () => {
      // INVARIANT (CLAUDE.md "PRs only for protected branches"): a PR/MR a
      // person submitted into a branch accept merges LOCALLY is closed once the
      // merge lands — never left open to claim the work has not landed, and
      // never merged through the forge instead (mergeLandsLocally stays the one
      // routing predicate). Closing writes no comment and no review. Idempotent:
      // a PR/MR that is no longer open is left alone.
      if (!record.closeReview || record.viaForge) return;
      if (offline || !driver.needsSync) {
        throw new Error(`lazy is offline, so the PR/MR for ${displayId(task)} cannot be closed on the forge yet`);
      }
      const sess = await storage.getSessionByTaskId(task.id);
      if (!sess?.git_branch) return;
      const state = await driver.getPRState(task);
      if (state === 'MERGED' || state === 'CLOSED') return;
      // OPEN, or unknown (null): cleanup is itself a lookup-and-close-if-open.
      await driver.cleanup(sess.git_branch);
      // Only a forge that SAYS the PR is closed or merged confirms it. cleanup
      // only warns when its close fails, and a state the forge cannot report
      // (null) is not "closed": marking the step done on it left the PR open
      // for good. Throw, so the follow-through sweep retries.
      const after = await driver.getPRState(task);
      if (after !== 'CLOSED' && after !== 'MERGED') {
        const url = await driver.getTaskUrl(task);
        throw new Error(after === 'OPEN'
          ? `the PR/MR ${url ?? `for ${sess.git_branch}`} is still open after lazy tried to close it — close it on the forge`
          : `lazy asked the forge to close the PR/MR ${url ?? `for ${sess.git_branch}`} but could not confirm it closed; retrying`);
      }
    },
    'accept-tag': async () => {
      await createAcceptTag(task.id, record.mergeSha ?? target, projectRoot);
    },
    'parent-fidelity': async () => {
      // Child→parent fidelity: the parent body is kept current as children land,
      // so by the time the parent merges it already reflects all child work.
      await regenerateParentFidelity(storage, task, driver, config, projectRoot, warnings);
    },
    cleanup: async () => {
      const sess = await storage.getSessionByTaskId(task.id);
      const worktreePath = getWorktreePath(projectRoot, task);
      if (sess) await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
      await revokeTaskTokens(projectRoot, task.id);
      await removeLock(worktreePath);
      if (sess) {
        await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
      }
      removeProtocolDir(getProtocolDir(task.id));
    },
  };

  // A failing step blocks only the steps that DEPEND on it; everything
  // independent still runs. In particular cleanup — container teardown and MCP
  // token revocation — must never wait on a parent push that keeps failing: an
  // accepted task's credentials would otherwise stay live while it reads
  // `complete`.
  const persist = () => storage.updateTaskMetadata(task.id, ACCEPT_FOLLOWTHROUGH_KEY, JSON.stringify(record));
  const errors: string[] = [];
  let waitingForMember: string | null = null;
  for (const step of FOLLOWTHROUGH_STEPS) {
    if (record.done.includes(step)) continue;
    // A step with nothing to do is done whatever its prerequisites did: held
    // behind a failing dependency it would be reported as owed, which it is not.
    const applies: ((r: AcceptFollowThrough) => boolean) | undefined = FOLLOWTHROUGH_APPLIES[step];
    if (applies && !applies(record)) {
      record.done.push(step);
      await persist();
      continue;
    }
    if ((FOLLOWTHROUGH_DEPENDS_ON[step] ?? []).some((dep) => !record.done.includes(dep))) continue;
    // A member working in the task's files keeps them: a merge the forge made
    // while they were inside (their task was `submitted`) is committed, but
    // the worktree, branch, container and tokens are not removed under them.
    // Cleanup stays pending — not a failure — and the next pass after their
    // session ends (the daemon's follow-through sweep) runs it.
    if (step === 'cleanup') {
      const holder = memberInsideTask(task.id);
      if (holder) {
        waitingForMember = holder;
        continue;
      }
    }
    try {
      await steps[step]();
    } catch (err) {
      errors.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    record.done.push(step);
    await persist();
  }
  if (errors.length > 0) {
    record.attempts += 1;
    record.lastError = errors.join('; ');
    record.nextAttemptAt = Date.now() + followThroughBackoffMs(record.attempts);
    await persist();
    const pending = FOLLOWTHROUGH_STEPS.filter((s) => !record.done.includes(s));
    logger.warn(`Task ${displayId(task)}: accepted, but post-accept follow-through failed at ${record.lastError} (attempt ${record.attempts}; still pending: ${pending.join(', ')})`);
    return { pending, error: record.lastError, ...(waitingForMember ? { waitingForMember } : {}) };
  }
  if (waitingForMember) {
    await persist();
    logger.debug(`Task ${displayId(task)}: accepted; its worktree is cleaned up once ${waitingForMember} has closed their terminals.`);
    return {
      pending: ['cleanup'],
      error: `cleanup waits for ${waitingForMember}'s terminal session to end`,
      waitingForMember,
    };
  }
  await storage.updateTaskMetadata(task.id, ACCEPT_FOLLOWTHROUGH_KEY, '');
  if (record.attempts > 0) {
    logger.info(`Task ${displayId(task)}: post-accept follow-through completed after ${record.attempts} failed attempt(s).`);
  }
  return { pending: [] };
}

/**
 * Refuse a forge accept whose recorded PR/MR merges into a branch other than
 * the accept's target (./review-base.ts). A forge that cannot be asked is a
 * refusal too: this check exists because a wrong merge is not undoable.
 */
async function refuseWrongReviewBase(
  driver: ReturnType<typeof createDriver>,
  task: Task,
  mergeTargetBranch: string,
  display: string,
  projectRoot: string,
  remote: string,
): Promise<void> {
  // A root task with no named target has its PR on the remote's DEFAULT
  // branch, not on the literal `main` the merge target falls back to.
  const targetBranch = await reviewComparisonTarget(task, mergeTargetBranch, projectRoot, remote);
  let base: string | null;
  try {
    base = await mismatchedReviewBase(driver, task, targetBranch);
  } catch (err) {
    throw new RpcError(502,
      `Could not read the base branch of ${display}'s PR/MR, so it is not merged: ${err instanceof Error ? err.message : err}. ` +
      `Retry the accept once the forge answers.`);
  }
  if (base === null) return;
  throw acceptRefusal(409, wrongReviewBaseRefusal(task, base, targetBranch, await driver.getTaskUrl(task)), {
    reason: 'review-base-mismatch',
    next: `Change the PR/MR's base to ${targetBranch} on the forge, or close it and submit the task again.`,
  });
}

/**
 * Does a LOCAL merge of `task` owe closing its PR/MR (the `close-review`
 * follow-through step)? Only when the task records one under the CONFIGURED
 * forge and it is not a linked task's (that PR belongs to someone else).
 *
 * INVARIANT: asked of the configured driver, never the accept's own driver —
 * offline that one is a LocalDriver, which records no PR for anyone, so an
 * offline accept used to owe nothing and the PR stayed open for good after
 * lazy came back online. Constructing a driver makes no network call.
 */
function closeReviewOwed(
  config: ResolvedConfig,
  storage: Storage,
  projectRoot: string,
  task: Task,
  mergedLocally: boolean,
): boolean {
  if (!mergedLocally || isLinkedTask(task)) return false;
  const configured = createDriver(config, { storage, lazyRoot: projectRoot });
  return configured.needsSync && configured.hasRemoteRef(task);
}

/**
 * Steps that only apply to some records. One that does not apply is marked
 * done up front, so a dependency failing never makes it read as owed.
 */
const FOLLOWTHROUGH_APPLIES: Partial<Record<FollowThroughStep, (record: AcceptFollowThrough) => boolean>> = {
  'close-review': (record) => !!record.closeReview && !record.viaForge,
};

/**
 * Real dependencies between follow-through steps — the only ordering a failure
 * may block. The tag reads the fast-forwarded target; the parent notify names
 * the merge by reading the tag.
 */
const FOLLOWTHROUGH_DEPENDS_ON: Partial<Record<FollowThroughStep, FollowThroughStep[]>> = {
  'accept-tag': ['fast-forward'],
  // A PR closed before the parent push lands reads as settled while the base
  // branch on the forge still lacks the work. push-parent is a no-op when
  // nothing needs pushing, so this only ever waits on a real push.
  'close-review': ['push-parent'],
  // NOT notify-parent → accept-tag: the notify runs after the tag so it can name
  // the merge, but it posts SHA-less when the tag is missing (and dedupes
  // against a later SHA'd notify), so a target that keeps failing to
  // fast-forward must not hold the parent's [Subtask accepted] comment back.
};

/**
 * The branch an accept of `task` merges into, in its unresolved spelling: the
 * parent task's branch for a child, else the task's own target. A root task with
 * no recorded target is `HEAD`, which follow-through resolves to the remote's
 * default branch — never a hardcoded name.
 */
export async function acceptTargetBranchOf(task: Task, storage: Storage): Promise<string> {
  const parentId = parentTaskIdOf(task);
  if (parentId) return await getBranchNameFromId(parentId, storage);
  return targetBranchOf(task) ?? 'HEAD';
}

/**
 * Finish an accept that died INSIDE `commitAcceptTransition` (session already
 * `accepted`, status still `merging`). The merge landed; nothing is merged
 * again — the transition completes and follow-through runs.
 */
async function finishInterruptedTransition(
  storage: Storage,
  projectRoot: string,
  task: Task,
  acceptActor: ActorInput,
  ctx: { warnings: string[]; driver: ReturnType<typeof createDriver>; config: ResolvedConfig; phases: PhaseReporter },
  /** Set when the trees proved the work landed (the session was not yet ended). */
  landedRecord?: AcceptFollowThrough,
): Promise<AcceptTaskResult> {
  const display = displayId(task);
  const intent = readAcceptIntent(task);
  let record = landedRecord ?? readFollowThrough(task);
  if (!record) {
    // The transition writes this record BEFORE ending the session, so an
    // accepted session without one should not exist. Rebuild what can be known
    // rather than refuse; a missed parent push shows up as local-ahead in sync.
    logger.warn(`Task ${display}: accepted session with no follow-through record — rebuilding it.`);
    record = { targetBranch: await acceptTargetBranchOf(task, storage), viaForge: false, pushParent: false, done: [], attempts: 0 };
  }
  ctx.warnings.push(
    `A previous accept of ${display} died after its merge landed. Finishing it — nothing is merged again.`,
  );
  ctx.phases.announce([ACCEPT_PHASES.finalize, ACCEPT_PHASES.cleanup], display);
  const outcome = await finishLandedAccept(storage, projectRoot, task, display, {
    reason: intent?.reason ?? 'Accept finished by the daemon after the accepting process died (original reason was not recorded).',
    actor: acceptActor,
    commentActor: intent?.actor ?? acceptActor,
    writeComment: true,
    dedupeComment: true,
    followThrough: record,
  }, ctx);
  return { taskId: task.id, displayId: display, status: 'merged', warnings: ctx.warnings, ...followThroughPendingField(outcome) };
}

/**
 * Is this task's work already on the branch its accept merges into?
 *
 * Asked of the TREES (a clean 3-way merge of the task branch into the target
 * that changes nothing), never of a tag or marker. Checks the local target
 * first, then — after a best-effort fetch — the remote-tracking ref, since a
 * forge merge lands there. Never throws: any failure answers `null` ("cannot
 * tell"), and the caller takes its ordinary path.
 *
 * A NET-EMPTY branch (no changes against its merge base with the target)
 * answers `null`, not "landed": the trees cannot tell it from landed work, and
 * calling it landed would make the escape refuse a human's reject/close of a
 * task that never had anything to merge.
 */
export async function acceptWorkLanded(
  storage: Storage,
  projectRoot: string,
  task: Task,
  config: ResolvedConfig,
): Promise<{ where: 'local' | 'remote'; target: string } | null> {
  try {
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess?.git_branch) return null;
    const { resolveDetachedHead, branchChangesAlreadyIn } = await import('../git/operations');
    const { runGit } = await import('../utils/git');
    const exists = async (ref: string) =>
      (await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot })).exitCode === 0;
    if (!await exists(sess.git_branch)) return null;
    const target = await resolveDetachedHead(await acceptTargetBranchOf(task, storage), projectRoot, config.remote.git_remote);
    const netEmpty = async (ref: string) => {
      const base = await runGit(['merge-base', ref, sess.git_branch], { cwd: projectRoot });
      if (base.exitCode !== 0) return false;
      return (await runGit(['diff', '--quiet', base.stdout.trim(), sess.git_branch], { cwd: projectRoot })).exitCode === 0;
    };
    if (await exists(target) && await netEmpty(target)) return null;
    if (await exists(target) && await branchChangesAlreadyIn(sess.git_branch, target, projectRoot)) {
      return { where: 'local', target };
    }
    if (config.remote.driver !== 'local') {
      const remote = config.remote.git_remote;
      const fetched = await runGit(['fetch', remote, target], { cwd: projectRoot, timeout: 60_000 });
      if (fetched.exitCode !== 0) logger.debug(`acceptWorkLanded: fetch ${remote} ${target} failed: ${fetched.stderr}`);
      const remoteRef = `${remote}/${target}`;
      if (await exists(remoteRef) && await branchChangesAlreadyIn(sess.git_branch, remoteRef, projectRoot)) {
        return { where: 'remote', target };
      }
    }
    return null;
  } catch (err) {
    logger.debug(`acceptWorkLanded(${displayId(task)}): cannot tell — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** The loud line an accept result carries when follow-through is still owed. */
function followThroughPendingWarning(display: string, outcome: FollowThroughOutcome): string {
  return (
    `FAILED after the merge: ${display} is accepted and its work has landed, but post-accept ` +
    `follow-through failed at ${outcome.error}. Still pending: ${outcome.pending.join(', ')}. ` +
    `The daemon retries automatically and files a system message if it keeps failing; ` +
    `\`lazy show ${display}\` shows the task.`
  );
}

/**
 * Transition + follow-through, shared by every accept exit that merged.
 * Follow-through failures come back in the outcome; they never throw, because
 * by the time this runs the accept has happened.
 */
async function finishLandedAccept(
  storage: Storage,
  projectRoot: string,
  task: Task,
  display: string,
  transition: Parameters<typeof commitAcceptTransition>[2],
  ctx: { warnings: string[]; driver: ReturnType<typeof createDriver>; config: ResolvedConfig; phases: PhaseReporter },
): Promise<FollowThroughOutcome> {
  ctx.phases.begin(ACCEPT_PHASES.finalize);
  await commitAcceptTransition(storage, task, transition);
  ctx.phases.end();

  ctx.phases.begin(ACCEPT_PHASES.cleanup);
  let outcome: FollowThroughOutcome;
  try {
    outcome = await runAcceptFollowThrough(projectRoot, task.id, {
      ...ctx,
      record: { ...transition.followThrough, done: [...transition.followThrough.done] },
    });
  } catch (err) {
    // Even the bookkeeping of follow-through failed (e.g. a store write). The
    // task is complete; the record written by the transition is still there,
    // so the daemon sweep retries it.
    outcome = {
      pending: FOLLOWTHROUGH_STEPS.filter((s) => !transition.followThrough.done.includes(s)),
      error: `follow-through: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (outcome.pending.length > 0) {
    ctx.phases.end(`FAILED at ${outcome.error} — task is accepted; the daemon retries`);
    ctx.warnings.push(followThroughPendingWarning(display, outcome));
  } else {
    ctx.phases.end();
  }
  return outcome;
}

/** The target branch HEAD right after a local merge — null if unreadable. */
async function readTargetSha(branch: string, projectRoot: string): Promise<string | undefined> {
  const { runGit } = await import('../utils/git');
  const r = await runGit(['rev-parse', '--verify', `${branch}^{commit}`], { cwd: projectRoot });
  return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/**
 * The per-task round budgets an accept starts fresh, at all three accept exits.
 *
 * Two counters, one rule: an accepted task's next episode — should it ever be
 * reopened — is owed a full budget, because the rounds it spent were spent on
 * work that has now LANDED.
 *
 * - The auto-review round counter (§8.1), so a reopened task gets a fresh
 *   review cycle rather than a cap inherited from its previous life.
 * - The cluster's per-child fix-round counter, which is documented as counting
 *   "since this child was last STARTED OR ACCEPTED" (`[cluster]
 *   max_child_fix_rounds` in src/config/types.ts and lazy.toml.example). It
 *   reset on start, on reopen and on a human unblock, but not on accept —
 *   so the documented sentence was a claim the code did not keep, and a
 *   reopened-then-re-accepted child could be refused on a budget it had
 *   already been granted afresh.
 *
 * Both are best-effort: losing a reset costs rounds the next episode was
 * entitled to, which fails in the restrictive direction, and neither may fail
 * an accept whose merge has already landed.
 */
async function resetRoundBudgetsOnAccept(storage: Storage, taskId: string): Promise<void> {
  try {
    await resetFinalReviewRound(storage, taskId);
  } catch (err) {
    logger.debug(
      `Task ${taskId.substring(0, 8)}: could not reset the review round counter at accept: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Swallows its own failures (see cluster-fix-rounds.ts).
  await resetClusterFixRound(storage, taskId);
}

async function acceptTaskInner(
  projectRoot: string,
  params: AcceptTaskParams,
): Promise<AcceptTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'accept');
  try {
    return await acceptTaskRun(projectRoot, params, phases);
  } catch (err) {
    // Close whatever phase was open as failed, so the caller's last line says
    // WHERE the accept died rather than leaving a phase hanging mid-sentence.
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function acceptTaskRun(
  projectRoot: string,
  params: AcceptTaskParams,
  phases: PhaseReporter,
): Promise<AcceptTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];

  // Who is accepting. The status transitions and the [Accepted] comment below
  // are the audit trail of who decided this work should land, so a merge driven
  // by a parent agent must not read back as a human's call. The daemon's own
  // env cannot tell — the channel is threaded in from the caller.
  const acceptActor: ActorInput = params.actor ?? getActor();
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  // Pass a DriverContext so hosted-driver CLI calls (e.g. gh pr edit for
  // commit/PR fidelity) run against the project root and can read storage.
  const driver = createDriver(config, { storage, lazyRoot: projectRoot }, { offline });
  if (offline) {
    const configuredDriver = config.remote.driver;
    if (configuredDriver === 'gitlab' || configuredDriver === 'github') {
      const isGitlab = configuredDriver === 'gitlab';
      const prKind = isGitlab ? 'an MR on GitLab' : 'a PR on GitHub';
      const refKind = isGitlab ? 'MR' : 'PR';
      warnings.push(
        `Warning: lazy is in offline mode. This accept will NOT create ${prKind} — ` +
        `it will squash-merge locally and push directly. Run \`lazy accept\` again after ` +
        `going online to create the ${refKind}, or set [remote] driver = "local" in ` +
        `lazy.toml if this is intentional.`,
      );
    } else {
      warnings.push('Offline mode: using local merge (remote operations skipped)');
    }
  }

  // --- Step 0: an accept that died INSIDE its transition ---
  // INVARIANT (a dead accept never restores): `commitAcceptTransition` writes
  // the follow-through record, then ends the session `accepted`, then the
  // status. Killed between those writes, the task is `merging` + marked with an
  // ACCEPTED session — the merge has landed. Preflight refuses any accept whose
  // session says accepted ("already-accepted"), so without this every resume
  // failed until the escape restored the task to `blocked` over merged work.
  // Finish the transition instead; nothing here merges.
  {
    const early = (await storage.resolveTask(params.taskId)).task;
    if (early && early.status === 'merging' && early.metadata?.[ACCEPT_IN_FLIGHT_KEY]) {
      const earlySess = await storage.getSessionByTaskId(early.id);
      if (earlySess?.outcome === 'accepted') {
        return await finishInterruptedTransition(storage, projectRoot, early, acceptActor, {
          warnings, driver, config, phases,
        });
      }
      // INVARIANT (ask the trees first): an accept that died AFTER its merge
      // landed is finished here, before preflight and every gate — none of them
      // may refuse an accept whose work is already on the target. Only when the
      // trees say the work is NOT there does the resume re-run the merge below.
      const landed = await acceptWorkLanded(storage, projectRoot, early, config);
      if (landed) {
        let pushParent = false;
        if (landed.where === 'local' && driver.needsSync && !offline) {
          try {
            pushParent = isIntermediateBranch(landed.target) || !(await driver.isTargetBranchProtected(landed.target));
          } catch (err) {
            // Unknown protection: do not push a branch that may be protected.
            // Sync reports local-ahead if this was wrong; nothing is lost.
            logger.warn(`Task ${displayId(early)}: could not tell whether ${landed.target} is protected, so it is not pushed: ${err instanceof Error ? err.message : err}`);
          }
        }
        return await finishInterruptedTransition(storage, projectRoot, early, acceptActor, {
          warnings, driver, config, phases,
        }, {
          targetBranch: await acceptTargetBranchOf(early, storage),
          viaForge: landed.where === 'remote',
          pushParent,
          closeReview: closeReviewOwed(config, storage, projectRoot, early, landed.where === 'local'),
          done: [],
          attempts: 0,
        });
      }
    }
  }

  // --- Step 1: Pre-flight validation ---
  // Narrated as an unplanned prelude: preflight is what tells us WHICH plan
  // applies (fresh accept vs. remote-merge re-entry), so the plan is announced
  // immediately after it rather than guessed before it.
  phases.begin(ACCEPT_PHASES.preflight);
  const preflight = await acceptTaskPreflight(projectRoot, {
    taskId: params.taskId,
    approvedFiles: params.approvedFiles,
    raisedResolutions: params.raisedResolutions,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    callerTaskId: params.callerTaskId,
    actor: params.actor,
    allowReviewIssues: params.allowReviewIssues,
    allowQueuedComments: params.allowQueuedComments,
  });
  phases.end(`${preflight.commitCount} commit(s) → ${preflight.mergeTargetBranch}`);

  warnings.push(...preflight.warnings);

  // Resolve task (need full object for driver operations)
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolveResult.task;

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${preflight.displayId} has no session.`);
  }

  // Persist raised-item resolutions and deliver pending comments HERE, not in
  // preflight. CLI accept calls preflight first to collect the passphrase;
  // writing there would land comments and create peer tasks even if the human
  // then cancels. This is the point of no undo — comments are append-only.
  //
  // INVARIANT: save first. Comments (human feedback) land before the merge,
  // which can fail.
  {
    const raisedActor = withActorPerson(actorRole(acceptActor) ?? getActor(), acceptActor);
    const raised = await applyRaisedResolutions(
      storage,
      task.id,
      preflight.displayId,
      params.raisedResolutions,
      raisedActor,
      // A resume re-applies nothing new; the gate passed when the accept began.
      { requireComplete: !(preflight.taskStatus === 'merging' && !!preflight.metadata[ACCEPT_IN_FLIGHT_KEY]) },
    );
    warnings.push(...raised.warnings);
    const delivered = await materializePendingRaisedComments(storage, task.id, raisedActor);
    warnings.push(...delivered.warnings);
  }

  // A member working in the task's files keeps a fresh accept from doing
  // ANYTHING to it: refused here, before the first step with an effect beyond
  // the store — the accept check and the `[automation.pre_accept]` gate (which
  // run project commands in those files), the branch push, PR/MR creation,
  // approveForMerge and the forge's gates. Only the raised-item resolutions
  // above come first: they are the human's own words, saved before anything
  // that can refuse. This whole accept runs under the task's lifecycle lock —
  // the lock a member's entry takes — and once `merging` is stamped the entry
  // refuses the task, so the check holds for the whole accept. A `merging`
  // task (a resume, or a forge merge re-entering) cannot have a member inside.
  if (preflight.taskStatus !== 'merging') {
    const holder = memberInsideTask(task.id);
    if (holder) throw new RpcError(409, memberInsideSyncMessage(holder));
  }

  const worktreePath = preflight.worktreePath;
  const mergeTargetBranch = preflight.mergeTargetBranch;
  const isChildTask = preflight.isChildTask;

  // --- Compose the accept reason ---
  // A gated accept refused over MCP left the builder's review on the task
  // (src/protection/pending-review.ts). Attach it here, attributed — the
  // human's line comes first, the review is never silently replaced or
  // dropped, and a stale review is included and LABELED, not discarded.
  const pendingReview = preflight.gate.pendingReview;
  const humanReason = params.reason?.trim() || '';
  let reason: string;
  if (pendingReview) {
    const staleLabel =
      pendingReview.staleBy === null
        ? ' — recorded against an earlier state of the branch'
        : pendingReview.staleBy > 0
          ? ` — recorded before ${pendingReview.staleBy} later commit(s)`
          : '';
    const attributed =
      `Review by ${pendingReview.actor} (recorded ${pendingReview.recordedAt}${staleLabel}):\n\n` +
      pendingReview.text;
    reason = humanReason ? `${humanReason}\n\n---\n\n${attributed}` : attributed;
  } else {
    reason = humanReason || 'LGTM';
  }

  // --- Which kind of accept is this, and what do we restore to on abort? ---
  // A `merging` task WITHOUT an in-flight marker is a genuine remote-pending
  // merge: re-entry asks the forge what happened. A `merging` task WITH one is
  // the wreckage of a local merge phase that died mid-flight — re-run it as a
  // fresh accept, restoring to the status recorded in the marker.
  //
  // INVARIANT (a dead accept never restores): a marked `merging` task is an
  // accept the human already authorized whose process died — before OR after
  // the merge landed. It is RESUMED from the persisted intent, with the merge
  // made idempotent (a merge that would change nothing means it already
  // landed), never restored to its prior status first. Restoring is what put
  // merged work on a `blocked` task that no later accept could reconcile.
  const inFlightFrom = preflight.metadata[ACCEPT_IN_FLIGHT_KEY];
  const isRemoteMergeReentry = preflight.taskStatus === 'merging' && !inFlightFrom;
  const isResume = preflight.taskStatus === 'merging' && !!inFlightFrom;
  const priorStatus = (inFlightFrom || preflight.taskStatus) as TaskStatus;
  const persistedIntent = isResume ? readAcceptIntent(task) : null;
  if (isResume) {
    warnings.push(
      `A previous accept of this task died before it finished (task was ${inFlightFrom} before it). ` +
      `Resuming it${persistedIntent ? ` with the original reason, as ${actorRole(persistedIntent.actor) ?? 'the original actor'}` : ''}.`,
    );
    if (persistedIntent) reason = persistedIntent.reason;
  }
  const intent: AcceptIntent = persistedIntent ?? {
    reason,
    actor: acceptActor,
    ...(params.approvedFiles?.length ? { approvedFiles: params.approvedFiles } : {}),
    ...(params.acceptDirtyWorktree ? { acceptDirtyWorktree: true } : {}),
    ...(params.allowBroken ? { allowBroken: true } : {}),
    ...(params.allowReviewIssues ? { allowReviewIssues: true } : {}),
    recordedAt: new Date().toISOString(),
  };

  phases.announce(
    isRemoteMergeReentry
      ? acceptReentryPhasePlan()
      : acceptPhasePlan(config.automation.pre_accept.enabled),
    preflight.displayId,
  );

  // A protected file the reviewer rejected was reverted out of the branch, so
  // the diff reads identically to "the task never touched it". Every surface
  // that reports accept warnings therefore says so — the CLI additionally
  // prints it BEFORE the merge, where the decision is still open.
  if (preflight.revertedProtectedFiles.length > 0) {
    warnings.push(revertedProtectedFilesNotice(preflight.revertedProtectedFiles));
  }

  // --- Step 1a: Branch-protection (edge-gate) check ---
  // INVARIANT: this runs for ALL drivers, including local, and regardless of
  // who called accept (CLI --yes, MCP, automation). It is the single decision
  // point that makes protected merges require a deliberate human act — the
  // passphrase typed at the CLI's own prompt, verified inline here. `--yes`
  // skips prompts, not this gate: there is no parameter that can express
  // "skip it". See src/protection/edge-gate.ts and public-docs/protected-branches.md.
  //
  // A human's approval on the task's PR/MR is a SATISFIER of this same gate,
  // not a second mechanism: it is handed to enforceEdgeGate as a probe rather
  // than checked on a parallel code path, so the local driver and the forge
  // drivers reach the identical decision. The probe is omitted entirely when
  // there is no forge to ask (local driver, or no PR/MR opened yet), which
  // keeps accept free of a pointless remote round-trip.
  //
  // 'merging' re-entry is exempt: entering that state already passed (and
  // consumed) the gate; re-entry only completes a merge a human authorized.
  if (preflight.taskStatus !== 'merging') {
    phases.begin(ACCEPT_PHASES.edgeGate);
    const forgeApproval = driver.needsSync && driver.hasRemoteRef(task)
      ? () => driver.hasExternalApproval(task)
      : undefined;
    const commandFiles = await approvedFilesForAcceptCommand(
      storage,
      task.id,
      params.approvedFiles,
    );
    const acceptCommand = acceptWithApprovedFilesCommand(
      preflight.displayId,
      commandFiles,
      { reason: params.reason },
    );
    try {
      await enforceEdgeGate({
        storage,
        config,
        projectRoot,
        taskId: task.id,
        displayId: preflight.displayId,
        edge: { sourceBranch: sess.git_branch, targetBranch: mergeTargetBranch },
        forgeApproval,
        token: params.token,
        acceptCommand,
      });
    } catch (err) {
      if (err instanceof EdgeGateRefusedError) {
        // The one refusal a HUMAN surface can clear in place: supplying the
        // approval passphrase is what `lazy accept` prompts for at a terminal.
        //
        // A passphrase that was typed and simply did not match is a different
        // remedy from "this merge needs approval at all" — the human retypes
        // rather than going off to enroll — so it carries its own reason. Both
        // re-offer the same form: a typo is retryable, not a dead end.
        //
        // The command enumerates every already-approved file and the typed
        // --reason: a bare `lazy accept <id>` is wrong for a conflict task.
        throw acceptRefusal(403, err.message, {
          reason: err.tokenRejected ? 'approval-invalid' : 'approval-required',
          next: err.tokenRejected
            ? 'That passphrase did not match — try again.'
            : 'This merge is protected — approve it with the approval passphrase, then it proceeds.',
          command: acceptCommand,
          uiAction: 'passphrase',
          ...(commandFiles.length > 0 ? { files: commandFiles } : {}),
        });
      }
      throw err;
    }
    phases.end();
  } else if (!isRemoteMergeReentry) {
    // Only worth saying when the gate was in the announced plan; the re-entry
    // plan never lists it.
    phases.skip(ACCEPT_PHASES.edgeGate, 'already passed when the merge started');
  }

  // --- Step 1a': Deleted-file resurrection guard ---
  // INVARIANT: like the edge gate, this is a single decision point that runs for
  // ALL drivers and every caller (CLI --yes, MCP, automation, builder). It
  // refuses an accept that would silently re-add files the target branch
  // deliberately deleted — the defect class that let the v0.12 release put the
  // dead SSE module back for eight releases. See
  // src/protection/resurrection-guard.ts for the mechanism, and
  // docs/spikes/v012-release-resurrection-audit.md for the incident.
  //
  // Placed AFTER the edge gate on purpose: "a human must approve this merge at
  // all" is the more fundamental refusal, and asking a builder to reason about
  // resurrected files on a merge it may not be allowed to make at all would bury
  // the actionable message.
  //
  // 'merging' is exempt for the same reason the edge gate is: the merge was
  // already authorized when that state was entered.
  if (preflight.taskStatus !== 'merging') {
    phases.begin(ACCEPT_PHASES.resurrection);
    try {
      const guard = await enforceResurrectionGuard({
        projectRoot,
        sourceBranch: sess.git_branch,
        targetBranch: mergeTargetBranch,
        displayId: preflight.displayId,
        approvedFiles: params.approvedFiles,
      });
      warnings.push(...guard.warnings);
      phases.end(guard.approved.length > 0
        ? `${guard.approved.length} approved re-addition(s)`
        : undefined);
    } catch (err) {
      if (err instanceof ResurrectionRefusedError) {
        const files = err.resurrections.map((r) => r.path);
        throw acceptRefusal(409, err.message, {
          reason: 'resurrection',
          next: 'Confirm each file you really do mean to bring back, or drop those changes from the branch.',
          command: acceptWithApprovedFilesCommand(preflight.displayId, files),
          files,
        });
      }
      throw err;
    }
  } else if (!isRemoteMergeReentry) {
    phases.skip(ACCEPT_PHASES.resurrection, 'already passed when the merge started');
  }

  // --- Step 1a'': Git LFS pointer guard ---
  // INVARIANT: an accept never merges raw file content onto an LFS-tracked
  // path. With `filter.lfs.required=false` git commits raw bytes SILENTLY when
  // the LFS filter is broken, so a 335 MB blob can reach a task branch with
  // nothing having errored (see src/git/lfs.ts for the incident). Once it is an
  // ancestor of the target branch the branch is unpushable and only history
  // surgery removes it — so the refusal has to happen here, while the damage is
  // still confined to one disposable task branch.
  //
  // This is the backstop for the start-time environment check in
  // task-launcher.ts, and it is deliberately independent of it: it inspects
  // what was COMMITTED, so it also catches a config that broke mid-task, a
  // `lazy pair` commit from a differently-configured host, and commits that
  // predate lazy's involvement with the branch.
  //
  // Same placement rationale and same 'merging' exemption as the resurrection
  // guard directly above.
  if (preflight.taskStatus !== 'merging') {
    phases.begin(ACCEPT_PHASES.lfs);
    try {
      const mergeBase = await getMergeBase(mergeTargetBranch, sess.git_branch, projectRoot);
      const guard = await enforceLfsGuard({
        projectRoot,
        sourceBranch: sess.git_branch,
        targetBranch: mergeTargetBranch,
        mergeBase,
        displayId: preflight.displayId,
        approvedFiles: params.approvedFiles,
      });
      warnings.push(...guard.warnings);
      phases.end(guard.approved.length > 0
        ? `${guard.approved.length} approved raw blob(s) on LFS paths`
        : undefined);
    } catch (err) {
      if (err instanceof LfsPointerRefusedError) {
        const files = err.violations.map((v) => v.path);
        throw acceptRefusal(409, err.message, {
          reason: 'lfs-raw-blob',
          next: 'Fix the LFS setup and re-commit these paths as pointers; approve them only if the raw content is genuinely intended.',
          command: acceptWithApprovedFilesCommand(preflight.displayId, files),
          files,
        });
      }
      throw err;
    }
  } else if (!isRemoteMergeReentry) {
    phases.skip(ACCEPT_PHASES.lfs, 'already passed when the merge started');
  }

  // --- Step 1a''': Accept check — does the task's own tree still build? ---
  // INVARIANT (nothing-that-says-a-task-is-broken-is-load-bearing): a turn
  // titled "Blocked: the reverted state does not compile" did not stop an
  // accept, because no accept-path code reads a turn title. This gate is the
  // one that does stop it: it RUNS the project's configured check in the task's
  // worktree, at the moment of the merge, and refuses on a non-zero exit.
  //
  // Placed after the resurrection and LFS guards: those are cheap reads of git
  // history, this spends a process. Refuse for the cheap reasons first.
  //
  // Same 'merging' exemption as the guards above — the merge was already
  // authorized (and, for a remote re-entry, already made) when that state was
  // entered, so re-running a build there would gate work that has landed.
  if (preflight.taskStatus !== 'merging') {
    phases.begin(ACCEPT_PHASES.acceptCheck);
    try {
      const outcome = await enforceAcceptCheck({
        worktreePath,
        command: config.automation.accept_check,
        timeoutSecs: config.automation.accept_check_timeout,
        displayId: preflight.displayId,
        targetBranch: mergeTargetBranch,
        allowBroken: params.allowBroken === true,
        overrideAvailable: acceptCheckOverrideAvailable(params.actor),
        logSink: {
          info: (message) => logger.info(`[accept] ${message}`),
          warn: (message) => logger.warn(`[accept] ${message}`),
        },
      });
      if (!outcome.ran) {
        // Never invent a command: say the gate did not run and why.
        phases.skip(
          ACCEPT_PHASES.acceptCheck,
          outcome.skippedReason ?? 'no `[automation] accept_check` is configured for this project',
        );
      } else if (outcome.overridden) {
        warnings.push(acceptCheckOverriddenWarning(preflight.displayId, outcome.exitCode ?? -1));
        phases.end(`FAILED, overridden with ${ALLOW_BROKEN_FLAG}`);
      } else {
        phases.end(`passed in ${((outcome.elapsedMs ?? 0) / 1000).toFixed(1)}s`);
      }
    } catch (err) {
      if (err instanceof AcceptCheckFailedError) {
        // The remedy is surface-conditional: `--allow-broken` is CLI-only, so
        // over MCP the refusal must not hand back a command that surface cannot
        // run (docs/surface-asymmetries.md §14).
        const canOverride = acceptCheckOverrideAvailable(params.actor);
        throw acceptRefusal(409, err.message, {
          reason: 'check-failed',
          next: canOverride
            ? 'Fix the build in the task and re-run the accept, or accept it knowingly with --allow-broken.'
            : 'Fix the build in the task and re-run the accept — this surface has no override.',
          ...(canOverride
            ? { command: `lazy accept ${shellQuote(preflight.displayId)} ${ALLOW_BROKEN_FLAG}` }
            : {}),
        });
      }
      throw err;
    }
  } else if (!isRemoteMergeReentry) {
    phases.skip(ACCEPT_PHASES.acceptCheck, 'already passed when the merge started');
  }

  // --- Step 1b: Handle re-entry for tasks already in 'merging' state ---
  // When a task is already merging (from a previous accept), check if the
  // remote merge completed. This handles the common case where CI checks
  // pass and the PR merges while the user is away.
  if (isRemoteMergeReentry) {
    phases.begin(ACCEPT_PHASES.remoteState);
    const prState = await driver.getPRState(task);

    if (prState === 'MERGED') {
      // A PR merged into a base that is not this task's target did not land
      // the work where the task integrates: never record it as accepted.
      await refuseWrongReviewBase(driver, task, mergeTargetBranch, preflight.displayId, projectRoot, config.remote.git_remote);
      phases.end('remote merge already landed');
      // Transition first, follow-through after (accept-merge-is-commit-point):
      // the forge merged it while we were away; fast-forwarding the local target is follow-through.
      const outcome = await finishLandedAccept(storage, projectRoot, task, preflight.displayId, {
        reason,
        actor: acceptActor,
        commentActor: acceptActor,
        // The pending path already wrote `[Accepted]` when it handed the merge
        // to the forge.
        writeComment: false,
        dedupeComment: false,
        followThrough: { targetBranch: targetBranchOf(task) ?? mergeTargetBranch, viaForge: true, pushParent: false, done: [], attempts: 0 },
      }, { warnings, driver, config, phases });

      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'merged',
        prUrl: prUrl ?? undefined,
        warnings,
        ...followThroughPendingField(outcome),
      };
    }

    if (prState === 'CLOSED') {
      throw acceptRefusal(409, `The merge request was closed externally. Use 'lazy close ${preflight.displayId}' to close the task, or reopen the MR/PR and re-run 'lazy accept ${preflight.displayId}'.`, {
        reason: 'mr-closed',
        next: 'Reopen the merge request and accept again, or close the task if the work is being dropped.',
        command: `lazy close ${shellQuote(preflight.displayId)} --reason "merge request closed"`,
      });
    }

    // PR is still open — check CI status
    const checksStatus = await driver.getChecksStatus(task);

    if (checksStatus.status === 'failed') {
      const failedDetails = checksStatus.failed
        .map(f => f.url ? `${f.name} (${f.url})` : f.name)
        .join('; ');
      await parkTaskPaused(storage, task.id, acceptActor, { projectRoot });
      await storage.createComment(task.id, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked.`, acceptActor);
      throw new RpcError(409, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked. Fix the issue, then re-accept.`);
    }

    if (checksStatus.status === 'pending') {
      // If --wait was requested, the CLI can poll. For the RPC, just report pending.
      phases.end('CI checks still running — merge stays pending');
      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'pending',
        reason: 'CI checks still running',
        prUrl: prUrl ?? undefined,
        warnings,
      };
    }

    // Checks passed but merge didn't happen yet — retry merge. Same base check
    // as a fresh accept: the PR may have been re-based since it was handed over.
    await refuseWrongReviewBase(driver, task, mergeTargetBranch, preflight.displayId, projectRoot, config.remote.git_remote);
    phases.end('checks passed, merge not applied yet');
    phases.begin(ACCEPT_PHASES.merge, 'retrying the remote merge');
    const retryResult = await driver.merge({
      sourceBranch: sess.git_branch,
      targetBranch: mergeTargetBranch,
      task,
      taskShortId: taskRef(task),
      root: projectRoot,
    });

    if (retryResult.metadata) {
      for (const [key, value] of Object.entries(retryResult.metadata)) {
        await storage.updateTaskMetadata(task.id, key, value);
      }
      if (!task.metadata) task.metadata = {};
      Object.assign(task.metadata, retryResult.metadata);
    }

    if (retryResult.status === 'merged') {
      phases.end();
      // Transition first, follow-through after (accept-merge-is-commit-point):
      // the retried forge merge landed; everything after it is follow-through.
      const outcome = await finishLandedAccept(storage, projectRoot, task, preflight.displayId, {
        reason,
        actor: acceptActor,
        commentActor: acceptActor,
        // The pending path already wrote `[Accepted]` when it handed the merge
        // to the forge.
        writeComment: false,
        dedupeComment: false,
        followThrough: { targetBranch: targetBranchOf(task) ?? mergeTargetBranch, viaForge: true, pushParent: false, done: [], attempts: 0 },
      }, { warnings, driver, config, phases });

      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'merged',
        prUrl: prUrl ?? undefined,
        warnings,
        ...followThroughPendingField(outcome),
      };
    }

    if (retryResult.status === 'pending') {
      phases.end(retryResult.reason ?? 'merge still pending on the remote');
      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'pending',
        reason: retryResult.reason,
        prUrl: prUrl ?? undefined,
        warnings,
      };
    }

    // Failed — pass the driver's error through. Prefixing "Merge failed:" here
    // on top of LocalDriver's former "Merge failed:" and the squash path's own
    // wording produced the triple-nested message humans saw in the wild.
    throw new RpcError(500, formatAcceptMergeFailure(retryResult.error));
  }

  // --- Step 1b-pre: the mechanical acceptance gate ([automation.pre_accept]) ---
  // The configured gate commands run in their own ephemeral container, with no
  // agent and no turn — an independent re-run of the checks, NOT a chance for
  // the agent to fix anything first (that chance was every work turn; see the
  // final-turn design §5.3). On failure the task returns to the status it held
  // when the accept began and this throws — the merge never happens (no silent
  // merge). Only runs on the fresh accept path (not the 'merging' re-entry
  // handled above, where the merge is already in flight).
  // INVARIANT: never on a resume. The gate moves the task to `working` while it
  // runs, which a `merging` task cannot do, and it already passed when the
  // dead accept began — like every other gate above, re-entry skips it.
  if (isResume) {
    if (config.automation.pre_accept.enabled) phases.skip(ACCEPT_PHASES.preAccept, 'already passed when the merge started');
  } else {
    if (config.automation.pre_accept.enabled) phases.begin(ACCEPT_PHASES.preAccept);
    await launchAcceptanceGate(projectRoot, task, worktreePath, config, priorStatus);
    if (config.automation.pre_accept.enabled) phases.end('checks passed');
  }

  // --- Step 1c: Protected branch gate ---
  // Check if the target branch has protection rules requiring approval.
  // This must happen before auto-creating a PR (step 2) to avoid creating
  // orphan PRs when the accept will be refused anyway.
  //
  // INVARIANT: subtask→parent merges into an intermediate `lazy/...` branch are
  // local git operations, never remote MRs. Such branches are NEVER protected,
  // so we short-circuit the network protection check entirely — it isn't needed
  // and a transient failure must not be able to misroute the merge.
  const targetIsLazyBranch = isIntermediateBranch(mergeTargetBranch);
  let targetIsProtected = false;
  if (driver.needsSync && !targetIsLazyBranch) {
    phases.begin(ACCEPT_PHASES.protection, mergeTargetBranch);
    targetIsProtected = await driver.isTargetBranchProtected(mergeTargetBranch);
    // A resume never re-asks: the approval gated the accept that died.
    if (targetIsProtected && !config.remote.auto_approve && !isResume) {
      // Without auto_approve, we need an existing external approval to proceed
      const hasApproval = driver.hasRemoteRef(task) && await driver.hasExternalApproval(task);
      if (!hasApproval) {
        throw acceptRefusal(409,
          `Branch \`${mergeTargetBranch}\` has protection rules requiring approval. ` +
          `Use \`lazy submit\` to create an MR for external review. ` +
          `After the MR is approved, run \`lazy accept\` to merge.`,
          {
            reason: 'forge-approval-required',
            next: `${mergeTargetBranch} requires review on the forge — submit a PR/MR, get it approved, then accept.`,
            command: `lazy submit ${shellQuote(preflight.displayId)}`,
          });
      }
    }
    phases.end(targetIsProtected ? `${mergeTargetBranch} is protected` : `${mergeTargetBranch} is unprotected`);
  } else {
    phases.skip(
      ACCEPT_PHASES.protection,
      targetIsLazyBranch ? `${mergeTargetBranch} is an intermediate branch (never protected)` : 'no remote to ask',
    );
  }

  // --- Merge routing decision (INVARIANT: PRs only for protected branches) ---
  // When the merge target is NOT protected — every intermediate `lazy/...`
  // parent branch, and any other unprotected named branch — the merge is a
  // LOCAL git operation. We route it through a LocalDriver so accept performs an
  // immediate squash merge into the parent branch and NEVER pushes the branch,
  // creates an MR/PR, or parks the task in `merging`. Only a protected target
  // (e.g. `main`) goes through the remote driver's MR path below.
  //
  // `mergeLandsLocally` is the SHARED predicate — sync resolves its merge ref
  // through the same function (src/remote/upstream-ref.ts) so the two cannot
  // drift apart and disagree about which ref the parent lives on. A driver with
  // no remote already merges locally, so only `needsSync` drivers need the
  // LocalDriver wrapper.
  const useLocalMerge = driver.needsSync
    && mergeLandsLocally({ needsSync: driver.needsSync, targetIsProtected });
  const mergeDriver = useLocalMerge
    ? new LocalDriver({ storage, lazyRoot: projectRoot })
    : driver;
  if (useLocalMerge) {
    logger.debug(
      `acceptTask: target '${mergeTargetBranch}' is not protected — performing a local merge (no remote MR/PR).`,
    );
  }

  // --- Step 2: Auto-create remote ref if needed ---
  // Uses mergeDriver: for an unprotected target this is a LocalDriver whose
  // validateAccept always passes, so the whole remote-ref creation block is
  // skipped and no MR/PR is ever opened.
  const acceptError = mergeDriver.validateAccept(task);
  if (acceptError) {
    logger.debug('No remote reference found — pushing branch and creating PR...');
    phases.begin(ACCEPT_PHASES.remoteRef, sess.git_branch);

    try {
      await mergeDriver.pushBranch(sess.git_branch);
    } catch (err) {
      throw new RpcError(500, `Failed to push branch ${sess.git_branch}: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const prResult = await mergeDriver.markReadyForReview(task);
      if (prResult.metadata) {
        for (const [key, value] of Object.entries(prResult.metadata)) {
          await storage.updateTaskMetadata(task.id, key, value);
        }
        if (!task.metadata) task.metadata = {};
        Object.assign(task.metadata, prResult.metadata);
      }
      const retryError = mergeDriver.validateAccept(task);
      if (retryError) {
        // PR creation returned no error but also no metadata the acceptor can
        // use. This shouldn't happen in practice (markReadyForReview now throws
        // on gh failures), but guard against it to give a concrete message.
        throw new Error('markReadyForReview did not produce remote reference metadata');
      }
    } catch (err) {
      throw new RpcError(500, `Branch ${sess.git_branch} was pushed, but PR creation failed: ${err instanceof Error ? err.message : err}`);
    }
    phases.end();
  } else {
    phases.skip(
      ACCEPT_PHASES.remoteRef,
      // Three distinct reasons, and saying the wrong one is worse than saying
      // nothing: a local-driver project has no forge at all, an unprotected
      // target merges locally by choice, and only the remaining case is an
      // actual PR/MR that is already open.
      !driver.needsSync
        ? 'local driver — no forge to open a PR/MR on'
        : useLocalMerge
          ? 'unprotected target — merging locally, no PR/MR needed'
          : 'PR/MR already exists',
    );
  }

  // --- Step 2a: the recorded PR/MR must merge where this accept is going ---
  // INVARIANT (./review-base.ts): a forge merge lands in the PR's BASE, which
  // is fixed at creation and can disagree with the task's target — a subtask
  // submitted into its parent's branch and then reparented when the parent was
  // accepted. Merging it anyway put the work in the old parent branch and
  // called the task complete. Refuse before anything is merged or approved.
  if (!useLocalMerge && driver.needsSync) {
    await refuseWrongReviewBase(driver, task, mergeTargetBranch, preflight.displayId, projectRoot, config.remote.git_remote);
  }

  // --- Step 2b: Auto-approve if configured and branch is protected ---
  // Submit an approving review before gate checks so the approval is visible.
  // INVARIANT: this is the ONLY write lazy makes to a PR/MR besides creating
  // it and keeping its lazy-owned description section current. It is gated on
  // `[remote] auto_approve` (default false) and only on a protected target,
  // where the forge refuses the merge without an approval — the write is the
  // merge mechanism, not narration. Everything else lazy used to post (review
  // findings, accept/reject reviews) was removed on 2026-09-21.
  if (targetIsProtected && config.remote.auto_approve) {
    const approvalWarning = await driver.approveForMerge(task, reason);
    if (approvalWarning) {
      warnings.push(`Auto-approve warning: ${approvalWarning}`);
    }
  }

  // --- Step 3: Check pre-merge gates ---
  phases.begin(ACCEPT_PHASES.mergeGates);
  // mergeDriver: a LocalDriver has no remote gates, so unprotected merges skip
  // CI/review gating entirely. A resume skips them too (they gated the accept
  // that died); the forge still enforces its own rules at merge time.
  const gateWarnings = isResume ? [] : await mergeDriver.checkAcceptGates(task);
  // When auto_approve is set and we've just submitted an approval, skip the
  // reviews gate — the approval may not have propagated to the API yet.
  const effectiveWarnings = (targetIsProtected && config.remote.auto_approve)
    ? gateWarnings.filter(w => w.gate !== 'reviews')
    : gateWarnings;
  if (effectiveWarnings.length > 0) {
    const prUrl = await driver.getTaskUrl(task);
    const gateMessages = effectiveWarnings.map(w => w.message).join('; ');
    throw new RpcError(409, `Merge blocked by pre-merge gates: ${gateMessages}. ${prUrl ? `Resolve on PR: ${prUrl}` : ''}`);
  }
  phases.end('all gates clear');

  // --- The merge phase starts HERE, and so does `merging` ---
  // Everything above was validation, from which the task's real status (blocked
  // /conflict/submitted) is the honest answer. Everything below either lands the
  // merge or aborts it, and takes MINUTES: a parent push, an LLM-synthesized
  // description, the merge itself. Stamping `merging` only at the very end (as
  // this used to) meant every read surface reported `blocked` throughout the one
  // window where the task was genuinely mid-merge and must not be touched.
  // Synthesis is a machine one-shot, so it runs on the BUILDER role target —
  // not this task's agent/model, and not `[models] default` (INVARIANT
  // oneshot-runs-on-builder, src/oneshot/types.ts). The task ref is still passed:
  // the run is ABOUT this task and its usage is attributed to it. Read-only —
  // an accept is not the human choosing a model, so nothing is written back.
  const summarizer = getSummarizer(projectRoot, taskRef(task));
  let result: MergeResult;
  let mergeLanded = false;
  // (No member can be inside: refused at the top of the fresh accept, under
  // this same lock.)
  await beginMergePhase(storage, task, priorStatus, acceptActor, intent, !isResume);
  let fidelity: Awaited<ReturnType<typeof regenerateFidelity>>;
  try {
    // --- Step 4: Push parent branch local commits (INVARIANT) ---
    // If the parent has local-only commits and the remote merge succeeds without them,
    // the remote parent will have the merge commit but not the local commits, causing divergence.
    // Only relevant for the remote-merge path: a local merge into an unprotected
    // parent (mergeDriver.needsSync === false) needs no push.
    if (mergeDriver.needsSync) {
      phases.begin(ACCEPT_PHASES.pushParent, mergeTargetBranch);
      try {
        await mergeDriver.pushBranch(mergeTargetBranch);
      } catch (err) {
        throw new RpcError(500, `Failed to push ${mergeTargetBranch} to remote: ${err instanceof Error ? err.message : err}. The parent branch has local commits that must be pushed before merging.`);
      }
      phases.end();
    } else {
      phases.skip(ACCEPT_PHASES.pushParent, 'local merge — nothing to push yet');
    }

    // --- Step 4b: Regenerate the fidelity record before merge ---
    // Synthesize a faithful summary of what the work actually became (pivots,
    // human feedback, child contributions) from storage. For hosted drivers this
    // updates the lazy-owned section of the PR/MR body, which is what the squash
    // commit is built from at merge time. For the local driver the summary is
    // carried into the squash message via MergeOptions.fidelityBody below.
    // Never blocks the merge: synthesis failure falls back to deterministic
    // output, and a remote-write failure is surfaced as a warning.
    phases.begin(ACCEPT_PHASES.description);
    fidelity = await regenerateFidelity(storage, task, mergeDriver, summarizer);
    if (fidelity.warning) warnings.push(fidelity.warning);
    phases.end();

    // --- Step 5: Attempt merge via driver ---
    phases.begin(ACCEPT_PHASES.merge, `${sess.git_branch} → ${mergeTargetBranch}`);
    result = await mergeDriver.merge({
      sourceBranch: sess.git_branch,
      targetBranch: mergeTargetBranch,
      task,
      taskShortId: taskRef(task),
      root: projectRoot,
      fidelityBody: fidelity.fidelityBody,
      resume: isResume,
    });
    mergeLanded = result.status === 'merged';

    // Always persist metadata immediately
    if (result.metadata) {
      for (const [key, value] of Object.entries(result.metadata)) {
        await storage.updateTaskMetadata(task.id, key, value);
      }
      if (!task.metadata) task.metadata = {};
      Object.assign(task.metadata, result.metadata);
    }

    // --- Step 6: Handle merge result ---
    if (result.status === 'failed') {
      if (result.isConflict) {
        // Conflict detected — agent needs to sync and resolve
        throw acceptRefusal(409, `${result.error}\nThe agent needs to merge upstream and resolve conflicts first. Run: lazy sync ${preflight.displayId}`, {
          reason: 'merge-conflict',
          next: 'Sync the task with its parent so the agent resolves the conflicts, then accept.',
          command: `lazy sync ${shellQuote(preflight.displayId)}`,
          uiAction: 'sync',
        });
      } else {
        throw new RpcError(500, formatAcceptMergeFailure(result.error));
      }
    }
  } catch (err) {
    // INVARIANT (accept-merge-is-commit-point): never restore once the merge
    // landed. If merge() said merged
    // (e.g. a store write of its metadata failed afterwards) the task stays
    // marked `merging` and the stranded-merge sweep resumes it — the resume's
    // idempotent merge answers "already landed" and finishes the accept.
    if (mergeLanded) throw err;
    // INVARIANT (a dead accept never restores): on a RESUME the dead attempt's
    // merge may already have landed even though THIS run's did not — e.g. a
    // sibling accept since edited the same lines, so the idempotence check sees
    // a conflict. Restoring here put merged work on a `blocked` task (the
    // 2026-09-08 incident). Leave it marked `merging`: the sweep retries with
    // backoff, and once resumes are exhausted the human's escape decides.
    if (isResume) throw err;
    // Nothing landed: put the task back exactly as we found it. Restoring to a
    // hardcoded `blocked` here is what used to silently erase a `conflict`.
    await abortMergePhase(storage, task, priorStatus, acceptActor);
    throw err;
  }

  if (result.status === 'pending') {
    // Merge is pending (waiting for CI, manual merge, etc.). The task stays
    // `merging`, but the merge is now the FORGE's to finish, not ours — drop the
    // in-flight marker so a later accept takes the remote re-entry path.
    phases.end(result.reason ?? 'merge handed to the remote');
    await clearMergeInFlight(storage, task);
    await storage.createComment(task.id, `${ACCEPTED_COMMENT_PREFIX}${reason}`, acceptActor);

    // INVARIANT: no approving review is posted here (engineer decision,
    // 2026-09-21) — lazy writes no reviews or comments to a forge. The accept
    // reason lives on the task comment above and in the merge commit. The one
    // exception is the `[remote] auto_approve` approval in step 2b, which is
    // what makes a protected-branch merge possible at all.
    // The captured builder review is now attached to the comment — its job is done.
    await clearPendingAcceptReview(storage, task.id);

    const prUrl = await driver.getTaskUrl(task);
    return {
      taskId: task.id,
      displayId: preflight.displayId,
      status: 'pending',
      reason: result.reason,
      prUrl: prUrl ?? undefined,
      warnings,
    };
  }

  // The merge committed durably. If the destination/parent worktree had
  // uncommitted work that couldn't be auto-restored after the stash-merge, the
  // accept STILL succeeds — we hand reconciliation to that worktree's owner
  // below (Step 9), after the child accept is fully finalized.
  const restoreConflict = result.restoreConflict;
  phases.end('merge committed');

  // --- Step 7: THE COMMIT POINT — the merge landed, so the task is accepted ---
  // INVARIANT (accept-merge-is-commit-point): nothing fallible runs between the
  // merge above and the transition below. Fast-forward, the parent push, the
  // accept tag, reparenting and cleanup are FOLLOW-THROUGH: they run after the
  // task is `complete`, are idempotent, are retried by the daemon until done,
  // and a failure among them is reported loudly as a failure — it never moves
  // the task out of `complete`. "Fail hard on remote failures" still holds for
  // the parent push: it is reported as failed, just no longer by un-accepting
  // work that has already merged.
  if (result.alreadyLanded) {
    const note = `The resumed accept found ${sess.git_branch}'s changes already on ${mergeTargetBranch} — the ` +
      `earlier accept's merge had landed, so nothing was merged again.`;
    warnings.push(note);
    // Also the shape of a net-empty task whose first accept died before its
    // squash: indistinguishable from the tree alone, and harmless — nothing is
    // lost, there was nothing to land. Logged, not refused.
    logger.warn(`Task ${preflight.displayId}: ${note}`);
  }
  const followTarget = targetBranchOf(task) ?? mergeTargetBranch;
  const followThrough: AcceptFollowThrough = {
    targetBranch: followTarget,
    viaForge: mergeDriver.needsSync,
    pushParent: useLocalMerge,
    // A local merge of a task with an open PR/MR (a person submitted it into
    // an unprotected or intermediate branch): close it once merged. Never a
    // linked task's — that PR/MR belongs to someone else.
    // Decided from the CONFIGURED forge, never `driver`: offline that is a
    // LocalDriver, which records no PR for anyone, and the close would never
    // be owed at all. Offline the step itself refuses and is retried online.
    closeReview: closeReviewOwed(config, storage, projectRoot, task, !mergeDriver.needsSync),
    // Read-only and non-throwing: the tag must point at the merge itself, not
    // at whatever the parent holds when a retried follow-through gets to it.
    ...(!mergeDriver.needsSync ? { mergeSha: await readTargetSha(followTarget, projectRoot) } : {}),
    done: [],
    attempts: 0,
  };
  const outcome = await finishLandedAccept(storage, projectRoot, task, preflight.displayId, {
    reason,
    actor: acceptActor,
    commentActor: persistedIntent?.actor ?? acceptActor,
    writeComment: true,
    dedupeComment: isResume,
    followThrough,
  }, { warnings, driver, config, phases });

  // --- Step 9: Hand off any destination-worktree restore conflict ---
  // The merge is durable and the child accept has succeeded. If the merged-into
  // worktree's stashed work couldn't be auto-restored, reconcile it via the
  // worktree's owning task (its agent) — or, failing that, surface loud,
  // actionable recovery steps. Never blocks or fails the child accept.
  if (restoreConflict) {
    await handleDestinationRestoreConflict(projectRoot, storage, restoreConflict, displayId(task), warnings);
  }

  // mergeDriver: a local merge has no remote URL, so this is null — correct,
  // there is no MR/PR to point at.
  const prUrl = await mergeDriver.getTaskUrl(task);
  return {
    taskId: task.id,
    displayId: preflight.displayId,
    status: 'merged',
    prUrl: prUrl ?? undefined,
    warnings,
    ...followThroughPendingField(outcome),
  };
}

function followThroughPendingField(outcome: FollowThroughOutcome): Pick<AcceptTaskResult, 'followThroughPending'> {
  return outcome.pending.length > 0
    ? { followThroughPending: { steps: outcome.pending, error: outcome.error ?? 'unknown error' } }
    : {};
}

/** Statuses from which `launchUnblockTask` can deliver feedback and resume the agent. */
const UNBLOCKABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'blocked', 'interrupted', 'conflict', 'submitted',
]);

/**
 * Compose the mode-specific recovery steps for a destination restore conflict.
 * Shared between the parent-agent feedback and the human-facing fallback so both
 * always describe exactly what git did and how to finish reconciling.
 */
function restoreConflictRecoverySteps(rc: DestinationRestoreConflict): string {
  if (rc.mode === 'conflict-markers') {
    return (
      `Git re-applied your stashed changes but they conflict with the merged changes — the working tree ` +
      `now contains conflict markers. Resolve the conflicts, \`git add\` the results, then ` +
      `\`git stash drop ${rc.stashSha}\` to discard the retained safety copy.`
    );
  }
  // pop-refused
  return (
    `Git refused to restore your stashed changes because doing so would overwrite untracked files produced ` +
    `by the merge. Nothing was applied; the worktree is at the clean merged state. Move or remove the ` +
    `conflicting files, then run \`git stash pop\` (stash ${rc.stashSha}) to restore your work.`
  );
}

/**
 * Find the task that owns a git branch by matching `session.git_branch`.
 * Storage has no branch index, so we scan tasks — the idiomatic pattern here.
 */
async function findTaskByBranch(
  storage: Storage,
  branch: string,
): Promise<{ task: Task; session: Session } | null> {
  const tasks = await storage.listTasks();
  for (const t of tasks) {
    const session = await storage.getSessionByTaskId(t.id);
    if (session && session.git_branch === branch) {
      return { task: t, session };
    }
  }
  return null;
}

/** Feedback handed to the destination worktree's agent to reconcile the stash. */
function buildRestoreConflictFeedback(rc: DestinationRestoreConflict, childDisplayId: string): string {
  return (
    `Accepting ${childDisplayId} squash-merged its work into this branch (${rc.targetBranch}). Before ` +
    `merging, your worktree had uncommitted changes, which I stashed so the merge could run safely. Git ` +
    `could not automatically restore them afterward.\n\n${restoreConflictRecoverySteps(rc)}\n\n` +
    `Your work is preserved in git stash ${rc.stashSha} (labeled "${rc.stashLabel}"). Please reconcile ` +
    `it in your worktree and commit or clean up as appropriate.`
  );
}

/**
 * Decide how to reconcile a destination restore conflict — PURE (reads storage,
 * no side effects), so it's unit-testable without launching a supervisor.
 *
 * The Case-2 destination IS the parent task's worktree, and accept is only
 * permitted when that parent is idle. So when an owning task exists with a live
 * session in an unblockable state, hand the conflict to its agent. Otherwise
 * (no owning task — e.g. a raw branch checkout — or a non-idle owner) fall back
 * to a human-facing message. The stash is retained either way.
 */
export type RestoreConflictPlan =
  | { kind: 'unblock'; taskId: string; taskDisplayId: string; feedback: string }
  | { kind: 'fallback' };

export async function planRestoreConflictReconciliation(
  storage: Storage,
  rc: DestinationRestoreConflict,
  childDisplayId: string,
): Promise<RestoreConflictPlan> {
  const owner = await findTaskByBranch(storage, rc.targetBranch);
  if (owner && owner.session.ended_at === null && UNBLOCKABLE_STATUSES.has(owner.task.status)) {
    return {
      kind: 'unblock',
      taskId: owner.task.id,
      taskDisplayId: displayId(owner.task),
      feedback: buildRestoreConflictFeedback(rc, childDisplayId),
    };
  }
  return { kind: 'fallback' };
}

/**
 * Reconcile a destination worktree whose stashed work couldn't be auto-restored
 * after a durable squash merge (see {@link DestinationRestoreConflict}). Hands
 * the conflict to the worktree's owning agent via the same internal unblock
 * machinery the `unblock` RPC uses, or surfaces a loud, actionable fallback.
 * Never blocks or fails the (already-durable) child accept.
 */
async function handleDestinationRestoreConflict(
  projectRoot: string,
  storage: Storage,
  rc: DestinationRestoreConflict,
  childDisplayId: string,
  warnings: string[],
): Promise<void> {
  const plan = await planRestoreConflictReconciliation(storage, rc, childDisplayId);

  if (plan.kind === 'unblock') {
    try {
      // No `filesReview`: this unblock is the daemon reconciling a worktree
      // after somebody ELSE's accept. The owning task's reviewer submitted
      // nothing, so their open questions are not archived by it.
      // The daemon's own launch (nobody asked for it): never spends a person's
      // one-shot usage-pause override. A pause refuses it into the loud
      // fallback below, which keeps the stash and says how to reconcile.
      await launchUnblockTask(projectRoot, { taskId: plan.taskId, message: plan.feedback, daemonLaunch: true });
      warnings.push(
        `The destination worktree for ${rc.targetBranch} (task ${plan.taskDisplayId}) had uncommitted ` +
        `changes that could not be auto-restored after the merge (${rc.mode}); its agent was unblocked to ` +
        `reconcile the preserved stash ${rc.stashSha}. The accept itself succeeded.`
      );
      return;
    } catch (err) {
      // Unblock failed — fall through to the loud human-facing fallback so the
      // preserved work is never silently stranded.
      warnings.push(
        `Could not unblock task ${plan.taskDisplayId} to reconcile the destination worktree for ` +
        `${rc.targetBranch}: ${err instanceof Error ? err.message : err}.`
      );
    }
  }

  // Fallback: no owning task, owner not unblockable, or unblock failed.
  warnings.push(
    `Merged into ${rc.targetBranch}, but its worktree at ${rc.worktreePath} had uncommitted changes that ` +
    `could not be auto-restored after the merge (${rc.mode}). Your work is preserved in git stash ` +
    `${rc.stashSha} (labeled "${rc.stashLabel}"). To recover it manually in that worktree: ${restoreConflictRecoverySteps(rc)}`
  );
}

/**
 * If `task` was a child merged into its parent, regenerate the parent's
 * fidelity record so the parent/hub PR/MR body reflects the newly-landed child.
 * No-op when the task has no parent. Never throws (regenerateFidelity is safe).
 *
 * The summarizer is built HERE, from the PARENT, deliberately: this run
 * synthesizes the parent's body, so it must be attributed to the PARENT and not
 * to the child whose accept triggered it. Taking a ready-made summarizer as a
 * parameter is what let the child's accept attribute this run to the child.
 * What it RUNS on is not a choice made here — a machine one-shot always runs on
 * the builder role target (INVARIANT oneshot-runs-on-builder,
 * src/oneshot/types.ts).
 */
async function regenerateParentFidelity(
  storage: Storage,
  task: Task,
  driver: ReturnType<typeof createDriver>,
  config: ResolvedConfig,
  projectRoot: string,
  warnings: string[],
): Promise<void> {
  const parentId = parentTaskIdOf(task);
  if (!parentId) return;
  const parent = await storage.getTask(parentId);
  if (!parent) return;
  const summarizer = getSummarizer(projectRoot, taskRef(parent));
  const parentFidelity = await regenerateFidelity(storage, parent, driver, summarizer);
  if (parentFidelity.warning) warnings.push(parentFidelity.warning);
}

// =====================================================================
// Sync Task — task-level upstream merge as standalone operation
// =====================================================================

export interface SyncTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  /** Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
  /**
   * A caller's own reporter to narrate INTO, instead of opening one. Reparent
   * uses this: it announces a plan that already contains sync's phases, so a
   * second `announce` here would restart the client's checklist mid-operation.
   * When supplied, `onProgress` is ignored and the caller owns failure reporting.
   */
  reporter?: PhaseReporter;
  /**
   * The task whose OWN agent is making this call, when one is.
   *
   * Set by the MCP boundary from the authenticated per-task context — never from
   * a tool argument — and it is the ONLY thing that lets a sync run against a
   * `working` task. When it equals the target, sync merges in place instead of
   * dispatching a supervisor (see src/daemon/self-sync.ts).
   */
  callerTaskId?: string;
  /**
   * An EXPLICIT sync by a human or the builder, which lifts a pinned base
   * (`lazy clone --same-base`, src/task/base-pin.ts). Every automatic caller —
   * the auto-sync after an upstream accept, the retry loop — leaves it unset,
   * and so does an agent's own `lazy_sync`: a pinned task is not synced by them.
   */
  liftPin?: boolean;
  /**
   * An AUTOMATIC sync (the auto-sync after an upstream accept, the pending-sync
   * retry loop). While a member has a terminal open on the task such a sync is
   * QUEUED (`pending_sync`) instead of refused: nobody is waiting on it, and the
   * retry loop merges it once the member's session has ended. Every other
   * caller — a person, the builder, an agent — is refused with a 409 naming
   * the member.
   */
  queueIfMemberInside?: boolean;
  /**
   * The DAEMON is starting this sync by itself — the auto-sync after an
   * upstream change, the pending-sync retry loop. Only a conflict runs an
   * agent, and on a credential the usage pause stops that conflict resolution
   * is HELD (queued, retried after the reset) rather than refused, and never
   * takes a person's one-shot override (src/daemon/usage-pause.ts).
   */
  daemonLaunch?: boolean;
}

export interface SyncTaskResult {
  taskId: string;
  displayId: string;
  /**
   * `merged` / `conflict` occur only on the self-sync route, which performs the
   * merges inline rather than launching a supervisor to do them.
   */
  /**
   * `held_by_member`: a member has a terminal open on the task and the caller
   * asked to queue rather than be refused (`queueIfMemberInside`). Nothing was
   * fetched or merged; the sync stays on the pending counter.
   */
  status: 'up_to_date' | 'sync_launched' | 'pending_sync' | 'merged' | 'conflict' | 'pinned' | 'held_by_member';
  message: string;
  warnings: string[];
  /** Self-sync only: what each of the two steps did. */
  steps?: SelfSyncStep[];
  /** Self-sync only, on `conflict`: what the calling agent must do next. */
  instructions?: string;
  /**
   * Set with `pending_sync` when the merge conflicts and a usage pause holds
   * the agent that would resolve it ([usage_pause]). The queued sync
   * (`pending_sync`) owns the retry from here, so a caller holding its own
   * reason to sync (an upstream signal) can let that go.
   */
  usagePauseHeld?: boolean;
}

/**
 * Sync a task's worktree with its upstream (parent) branch.
 *
 * Flow:
 * 1. Resolve task, validate it's in a syncable state — `SYNC_DISPATCHABLE_STATUSES`
 *    (blocked/conflict/submitted/interrupted), never `working`
 * 2. Determine parent branch (same logic as unblock)
 * 3. Attempt git fetch for the upstream ref
 * 4. If fetch fails → set pending_sync metadata, return warning
 * 5. If fetch succeeds and upstream has changes → launch supervisor with sync command
 * 6. If no upstream changes → clear pending_sync, return "Already up to date"
 * 7. On successful merge → clear pending_sync
 *
 * CONCURRENCY
 * -----------
 * The status check in step 1 is ADVISORY only: minutes of network work (parent
 * resolution, `git fetch`) sit between it and the moment this function actually
 * claims the task by writing `command.json`. Auto-sync calls this from the
 * daemon's own signal delivery, so a `lazy ask` (or another sync, or an unblock)
 * can start and claim the task inside that window — and `writeCommand` DELETES
 * any pending `response.json`, so a late sync command silently destroys the
 * answer the human is still waiting for. That is exactly how a task being asked
 * a question ended up in `working:(harness:merge_and_fix)` with the answer never
 * arriving.
 *
 * The dispatch — fresh status re-read, `working` transition, command write — is
 * therefore serialized under `withTaskLifecycleLock` and re-reads the task from
 * storage inside the lock. The fetch stays OUTSIDE the lock: it is the slow part
 * and holding a per-task lock across it would block every other dispatcher for
 * the duration. Losing the race is not an error — the task is simply no longer
 * dispatchable, so we put the sync back on the pending_sync counter and let the
 * retry loop pick it up once the task is paused again. That re-read is a
 * WHITELIST of the four paused statuses, matching ask's and unblock's gates: a
 * blacklist would let `pairing` and `merging` through, and neither can legally
 * transition to `working`.
 */
/** "origin/lazy/x and main", or just whichever step actually has commits. */
function mergeTargetsLabel(remoteBranch?: string, parentBranch?: string): string {
  const targets = [remoteBranch, parentBranch].filter((t): t is string => Boolean(t));
  return targets.length === 2 ? `${targets[0]} and ${targets[1]}` : (targets[0] ?? 'nothing');
}

/**
 * Decide whether sync's FIRST step has anything to merge: has someone pushed
 * commits to the task's own branch that this worktree lacks?
 *
 * Returns the remote-tracking ref to merge (`origin/lazy/<task>`), or undefined
 * when the step is skipped — every skip reason is narrated as one line on the
 * `origin` phase, because "the driver is local" and "nobody has pushed" are
 * different answers and the reader must be able to tell them apart.
 *
 * Never throws: a fetch failure here must not block the parent step, which is
 * the behaviour sync has always had. It downgrades to a warning and a skip.
 */
async function resolveOriginTaskBranch(args: {
  config: ResolvedConfig;
  offline: boolean;
  branch: string;
  worktreePath: string;
  phases: PhaseReporter;
  warnings: string[];
}): Promise<string | undefined> {
  const { config, offline, branch, worktreePath, phases, warnings } = args;

  if (config.remote.driver === 'local') {
    phases.skip(SYNC_PHASES.origin, 'remote driver is "local" — the task branch has no origin');
    return undefined;
  }
  if (offline) {
    phases.skip(SYNC_PHASES.origin, 'offline mode — not fetching the task branch');
    return undefined;
  }

  const driver = createDriver(config, undefined, { offline });
  let hasNewCommits: boolean;
  try {
    hasNewCommits = await driver.fetchBranch(branch, worktreePath);
  } catch (err) {
    // The common cause is the branch simply not existing on origin (nobody has
    // pushed it yet), which `git fetch <remote> <branch>` reports as a failure.
    // Either way the parent step is unaffected, so this is a notice, not a stop.
    const detail = err instanceof Error ? err.message : String(err);
    logger.debug(`Sync could not fetch ${config.remote.git_remote}/${branch}: ${detail}`);
    phases.skip(SYNC_PHASES.origin, `${config.remote.git_remote}/${branch} could not be fetched (not on origin yet?)`);
    warnings.push(`Could not fetch ${config.remote.git_remote}/${branch}: ${detail}`);
    return undefined;
  }

  const remoteBranch = `${config.remote.git_remote}/${branch}`;
  if (!hasNewCommits) {
    phases.skip(SYNC_PHASES.origin, `${remoteBranch} has no new commits`);
    return undefined;
  }
  phases.end(`${remoteBranch} has new commits`);
  return remoteBranch;
}

export async function syncTask(
  projectRoot: string,
  params: SyncTaskParams,
): Promise<SyncTaskResult> {
  if (params.reporter) {
    // Someone else owns the checklist (reparent) — narrate into theirs and let
    // them report the failure, so one operation never emits two plans.
    return await syncTaskRun(projectRoot, params, params.reporter, false);
  }
  const phases = new PhaseReporter(params.onProgress, 'sync');
  try {
    return await syncTaskRun(projectRoot, params, phases, true);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * A member has a terminal open on the task (src/server/member-terminals.ts):
 * sync must not merge into, or move HEAD of, the worktree they are working
 * in. Called under the task's lifecycle lock, next to the dispatchable-status
 * check, so a member's entry cannot interleave. Returns true when the sync was
 * queued instead (automatic callers); throws 409 for everyone else.
 */
export async function standDownForMember(
  storage: Pick<Storage, 'incrementTaskPendingSync'>,
  task: Pick<Task, 'id'> & { pending_sync?: number },
  params: Pick<SyncTaskParams, 'queueIfMemberInside'>,
): Promise<string | null> {
  const holder = memberInsideTask(task.id);
  if (!holder) return null;
  if (!params.queueIfMemberInside) throw new RpcError(409, memberInsideSyncMessage(holder));
  // Queued once: a sync already on the counter (the retry loop's own case)
  // is not counted again on every pass while the member stays inside.
  if (!task.pending_sync) await storage.incrementTaskPendingSync(task.id);
  return holder;
}

async function syncTaskRun(
  projectRoot: string,
  params: SyncTaskParams,
  phases: PhaseReporter,
  /** False when a caller announced a plan that already contains sync's phases. */
  announcePlan: boolean,
): Promise<SyncTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  if (announcePlan) phases.begin(SYNC_PHASES.preflight);

  // --- Resolve task ---
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = result.task;

  // INVARIANT: sync/merge into a linked branch is only an explicit human or
  // builder act. An agent calling lazy_sync on a linked child would merge
  // upstream into someone else's branch.
  if (isLinkedTask(task) && actorRole(actor) === 'agent') {
    throw new RpcError(
      403,
      `Task ${displayId(task)} is linked to someone else's branch. ` +
      `An agent cannot sync a linked task — that would merge upstream into that branch. ` +
      `A human or builder can run lazy sync explicitly.`,
    );
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Cannot sync a completed task.`);
  }

  // --- Status validation ---
  // A `working` task is syncable by exactly one caller: its OWN running agent
  // (see src/daemon/self-sync.ts). `callerTaskId` is set by the MCP boundary
  // from the authenticated per-task context, never from a tool argument, so the
  // exception cannot be claimed by a human, the builder, or another task's agent
  // — all of whom still get the 409 below, because a merge under a turn they are
  // not inside would land in a worktree nobody is watching.
  const selfSync = !!params.callerTaskId && params.callerTaskId === task.id;
  if (task.status === 'working' && !selfSync) {
    throw new RpcError(409, `Task ${displayId(task)} is currently working. Cannot sync while agent is running.`);
  }
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is ${task.status}. Cannot sync a terminal task.`);
  }
  if (task.status === 'backlog') {
    throw new RpcError(409, `Task ${displayId(task)} is in backlog. Start it first with: lazy start ${displayId(task)}`);
  }

  // --- Pinned base ---
  // INVARIANT: a task pinned to a base commit (lazy clone --same-base / --base)
  // never has its parent merged in by anything but an explicit human or builder
  // `lazy sync` — not the auto-sync after an upstream accept, not the retry
  // loop, not its own agent's lazy_sync. A pinned clone is a like-for-like
  // re-run of another task, and one silent merge destroys the comparison with
  // nobody noticing. The explicit sync lifts the pin: from then on it is an
  // ordinary task. (Auto-resume's pre-turn merge honours the same pin.)
  const pinnedBase = pinnedBaseOf(task);
  if (pinnedBase) {
    if (!params.liftPin) {
      // Drop any queued retry: the pin, not a fetch failure, is why nothing merged.
      await storage.resetTaskPendingSync(task.id);
      if (announcePlan) phases.end(`pinned to ${pinnedBase.substring(0, 12)}`);
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: 'pinned',
        message:
          `Task ${displayId(task)} is pinned to ${pinnedBase.substring(0, 12)} and is not synced automatically. ` +
          `A human can run \`lazy sync ${displayId(task)}\` to merge its parent in and lift the pin.`,
        warnings,
      };
    }
    // The pin is lifted below, once every refusal (pairing lock, worktree,
    // session lock, parent resolution) has passed — a refused sync must leave
    // the task pinned, or the next automatic sync would merge it silently.
  }

  // --- Pairing lock check ---
  const tRef = taskRef(task);
  checkPairingLockOrThrow(projectRoot, tRef, displayId(task));

  // --- Worktree check ---
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);
  if (!await pathExists(worktreePath)) {
    // Worktree is gone — try to recover from local or remote branch
    const branchName = sess.git_branch;
    const syncConfig = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, syncConfig.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
      // Recreating someone's worktree is a side effect they didn't ask for —
      // say so rather than doing it silently.
      warnings.push(`Worktree was missing, recreated from branch ${branchName}.`);
      if (recovery.dirty) {
        warnings.push('Recovered worktree has uncommitted changes.');
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Check for concurrent session lock
  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Task ${shortId(task.id)} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }

  // --- Determine parent branch (with stale-parent fallback) ---
  const parentResolution = await resolveParentBranchWithFallback(task, storage, projectRoot, actor);
  const parentBranch = parentResolution.branch;
  warnings.push(...parentResolution.warnings);
  // A stale parent chain moved the task's target: its open PR/MR follows
  // (./review-retarget.ts; best-effort, never throws).
  if (parentResolution.retargeted) {
    warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, [task]));
  }

  if (!parentBranch) {
    throw new RpcError(400, `Cannot determine parent branch for task ${displayId(task)}.`);
  }

  if (pinnedBase) {
    await storage.updateTaskMetadata(task.id, BASE_PIN_KEY, '');
    warnings.push(`Lifted the pin to ${pinnedBase.substring(0, 12)} — this task now follows its parent like any other.`);
  }

  if (announcePlan) {
    phases.end(displayId(task));
    phases.announce(syncPhasePlan(), displayId(task));
  }

  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  if (offline && (config.remote.driver === 'gitlab' || config.remote.driver === 'github')) {
    warnings.push(
      'lazy is in offline mode. Sync will merge upstream changes from the local ' +
      'branch only — no remote fetch will be performed.',
    );
  }

  // --- Step 1: has anyone pushed to the task's OWN branch? ---
  // A colleague pushing to `origin/<task-branch>` used to be unreachable without
  // pairing and merging by hand. Sync reconciles it on the TASK's branch, in the
  // worktree, with the task's agent resolving conflicts — the parent branch is
  // never touched by this (or by any other) step.
  //
  // Detection is `driver.fetchBranch`, the same call the start/unblock path makes
  // (see runSyncWithRemote in src/task/sync-remote.ts): fetch, then compare
  // HEAD with the remote-tracking ref. It is deliberately NOT the daemon's
  // remote-sync `detectExternalChanges`, which answers a different question
  // (was a PR/MR merged or closed on the forge).
  phases.begin(SYNC_PHASES.origin, sess.git_branch);
  let remoteBranch = await resolveOriginTaskBranch({
    config,
    offline,
    branch: sess.git_branch,
    worktreePath,
    phases,
    warnings,
  });

  phases.begin(SYNC_PHASES.upstream, parentBranch);

  // --- Step 2: attempt to fetch upstream ref (unchanged) ---
  // Resolve to the ref `lazy accept` will actually merge into — NOT
  // unconditionally `origin/<parent>`. An unprotected parent (every `lazy/...`
  // task branch) is merged into LOCALLY, and a parent task's own agent commits
  // can never be on origin, so syncing against origin reported "Already up to
  // date" while accept refused with conflicts. See src/remote/upstream-ref.ts.
  let resolvedParentBranch = parentBranch;
  try {
    const driver = createDriver(config, undefined, { offline });
    const resolution = await resolveUpstreamMergeRef(driver, parentBranch, worktreePath, {
      remoteName: config.remote.git_remote,
    });
    resolvedParentBranch = resolution.ref;
    warnings.push(...resolution.warnings);
  } catch (err) {
    // Fetch failed — increment pending_sync so retry loop picks it up.
    // LocalDriver.resolveUpstreamRef resolves locally without fetching, so
    // a throw here is a real failure even when offline.
    logger.warn(`Sync fetch failed for ${parentBranch}: ${err instanceof Error ? err.message : err}`);
    await storage.incrementTaskPendingSync(task.id);
    // Settled as SKIPPED, not failed: sync exits 0 here and reports
    // `pending_sync` — the retry loop owns it from now on. A ✗ row above a
    // zero exit status tells the reader the command broke when it did not.
    phases.skip(SYNC_PHASES.upstream, `fetch failed for ${parentBranch} — queued for retry`);
    phases.skip(SYNC_PHASES.compare, 'upstream unresolved');
    phases.skip(SYNC_PHASES.prepare, 'nothing to merge');
    phases.skip(SYNC_PHASES.launch, 'nothing to merge');
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'pending_sync',
      message: `Fetch failed for upstream branch ${parentBranch}. Marked for retry.`,
      warnings: [`Fetch failed: ${err instanceof Error ? err.message : err}`],
    };
  }

  // --- Resolve upstream SHA so the supervisor merges an immutable commit ---
  // Resolve the upstream to a SHA on the host, right after resolveUpstreamRef
  // fetched it, and pass that SHA to the supervisor. The original silent
  // no-op sync regression (fix-sync-no-merge) had the supervisor short-circuit
  // with "no upstream changes" even though the daemon saw commits; the root
  // cause of the short-circuit is still unidentified — it was hidden behind a
  // silent `return false` in the rev-list error path. Pinning the merge
  // target to a SHA is correctness-preserving regardless of the underlying
  // cause, and the SHA-disagreement warning in handleSyncCommand will surface
  // any actual ref-state divergence if it recurs.
  phases.end(resolvedParentBranch);
  phases.begin(SYNC_PHASES.compare, resolvedParentBranch);

  const upstreamShaResult = await runGit(['rev-parse', resolvedParentBranch], { cwd: worktreePath });
  if (upstreamShaResult.exitCode !== 0) {
    throw new RpcError(
      500,
      `Failed to resolve SHA for ${resolvedParentBranch} in ${worktreePath}: ${upstreamShaResult.stderr || 'unknown error'}`,
    );
  }
  const resolvedUpstreamSha = upstreamShaResult.stdout.trim();

  // --- Check if upstream has changes ---
  // Use the SHA we just resolved — it's guaranteed to exist in the worktree's
  // object store (we fetched it and rev-parse succeeded), so we don't need
  // to re-resolve the ref. hasUpstreamChanges now throws on git failure per
  // CLAUDE.md "errors are actionable"; a real rev-list failure here must
  // surface to the RPC caller instead of silently returning "up to date".
  let upstreamHasChanges: boolean;
  try {
    upstreamHasChanges = await hasUpstreamChanges(resolvedUpstreamSha, worktreePath);
  } catch (err) {
    throw new RpcError(
      500,
      `Failed to check for upstream changes in ${worktreePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  // Nothing to do only when BOTH steps are no-ops. An origin-only sync (the
  // colleague pushed to the task branch, the parent has not moved) still has to
  // launch — returning "already up to date" here is what left those commits
  // unreachable without pairing.
  if (!upstreamHasChanges && !remoteBranch) {
    // No changes — reset counter (we've checked, nothing to do)
    await storage.resetTaskPendingSync(task.id);
    phases.end('already up to date');
    phases.skip(SYNC_PHASES.prepare, 'nothing to merge');
    phases.skip(SYNC_PHASES.launch, 'nothing to merge');
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'up_to_date',
      message: 'Already up to date.',
      warnings,
    };
  }

  // --- At least one step has changes: launch supervisor with sync command ---
  // Reset counter to 0 ("acting on everything up to now"). If new signals arrive
  // while the merge is running, they'll increment the counter above 0, telling the
  // completion handler that another sync is needed.
  await storage.resetTaskPendingSync(task.id);

  phases.end(upstreamHasChanges ? `${resolvedParentBranch} has new commits` : 'already up to date');

  // --- Self-sync: the task's own running agent merges in place ---
  // Same two steps, in the same order, against the same refs this function just
  // resolved — only the execution differs: no supervisor, no second session, and
  // the conflict resolver is the agent already parked inside this tool call.
  // See src/daemon/self-sync.ts.
  if (selfSync) {
    phases.skip(SYNC_PHASES.prepare, 'self-sync — merging in place, no supervisor');
    phases.begin(SYNC_PHASES.launch, 'merging in the running agent’s worktree');
    await acquireLock(worktreePath, 'lazy sync (self)');
    try {
      const outcome = await runSelfSync({
        storage,
        taskId: task.id,
        sessionId: sess.id,
        displayId: displayId(task),
        worktreePath,
        plan: planSelfSyncSteps({
          ...(remoteBranch ? { remoteBranch } : {}),
          parentRef: resolvedParentBranch,
          parentSha: resolvedUpstreamSha,
          parentHasChanges: upstreamHasChanges,
        }),
      });
      phases.end(outcome.status === 'conflict'
        ? 'conflicts left for the running agent to resolve'
        : outcome.status === 'merged' ? 'merged in place' : 'nothing to merge');
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: outcome.status,
        message: outcome.message,
        steps: outcome.steps,
        ...(outcome.instructions ? { instructions: outcome.instructions } : {}),
        warnings,
      };
    } finally {
      await removeLock(worktreePath);
    }
  }

  phases.begin(SYNC_PHASES.prepare);

  await acquireLock(worktreePath, 'lazy sync');

  // Reassigned from the authoritative re-read inside the lifecycle lock below —
  // the status this function saw on entry may be minutes stale by then.
  let priorStatus = task.status;
  // Set when the in-lock re-read finds the task no longer dispatchable, so the
  // caller is told WHICH status it stood down for rather than a vague "busy".
  let standDownStatus: TaskStatus | null = null;
  // Set when a member has a terminal open on the task and this (automatic)
  // sync was queued instead of merging under them.
  let standDownMember: string | null = null;

  try {
    // Attempt both merges on the host before asking a runner for anything. A
    // clean sync is deterministic git work and needs no agent container. Only
    // a conflict is handed to the supervisor for agent-assisted resolution.
    const hostMerge = await withTaskLifecycleLock(task.id, async () => {
      const fresh = await storage.getTask(task.id);
      if (!fresh) {
        throw new RpcError(404, `Task not found: ${params.taskId}`);
      }
      if (!isSyncDispatchable(fresh.status)) {
        standDownStatus = fresh.status;
        await storage.incrementTaskPendingSync(task.id);
        return null;
      }
      standDownMember = await standDownForMember(storage, fresh, params);
      if (standDownMember) return null;
      const outcome = await runSelfSync({
        storage,
        taskId: task.id,
        sessionId: sess.id,
        displayId: displayId(task),
        worktreePath,
        plan: planSelfSyncSteps({
          ...(remoteBranch ? { remoteBranch } : {}),
          parentRef: resolvedParentBranch,
          parentSha: resolvedUpstreamSha,
          parentHasChanges: upstreamHasChanges,
        }),
        leaveConflictInProgress: false,
      });
      // INVARIANT: a host merge's commits are RECORDED before sync returns.
      // No turn runs around a host-side sync, so nothing else records them
      // until the next turn finalizes — and until then an unrecorded merge
      // commit reads, to stranded-completion recovery, as proof that a crashed
      // turn had finished, parking it `blocked` behind a "[Recovered]" turn for
      // work nobody did instead of resuming it. Same resolver as every other
      // recording path (first-parent, anchored at git_start_sha), so this adds
      // the merge commit and never the merged-in line. A running agent's own
      // `lazy_sync` does not come through here: its work turn spans the merge.
      if (outcome.steps.some(step => step.outcome === 'merged')) {
        await recordSessionCommits(storage, sess, worktreePath, displayId(task));
      }
      return outcome;
    });

    if (!hostMerge && standDownMember) {
      phases.skip(SYNC_PHASES.launch, `${standDownMember} has a terminal open — sync stays queued`);
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: 'held_by_member',
        message: `${standDownMember} has a terminal open on task ${displayId(task)}. The sync stays queued and will merge ${resolvedParentBranch} once their session has ended.`,
        warnings,
      };
    }
    if (!hostMerge) {
      phases.skip(SYNC_PHASES.launch, `task became '${standDownStatus}' — sync stays queued`);
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: 'pending_sync',
        message: `Task ${displayId(task)} became '${standDownStatus}' before the sync could start. It stays queued and will merge ${resolvedParentBranch} once the task is paused again.`,
        warnings,
      };
    }

    if (hostMerge.status === 'merged' || hostMerge.status === 'up_to_date') {
      phases.skip(SYNC_PHASES.prepare, 'merged on the host — no agent needed');
      phases.skip(SYNC_PHASES.launch, 'no conflicts to resolve');
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: hostMerge.status,
        message: hostMerge.message,
        steps: hostMerge.steps,
        warnings,
      };
    }

    const conflict = hostMerge.steps.find(step => step.outcome === 'conflict');
    if (!conflict) {
      throw new RpcError(500, `Sync for ${displayId(task)} reported a conflict without a conflicting merge step.`);
    }
    // Earlier clean steps are already committed and recorded. Give the
    // supervisor only the conflicting step and anything after it.
    if (conflict.step === 2) {
      remoteBranch = undefined;
    }
    upstreamHasChanges = conflict.step <= 2 && upstreamHasChanges;

    // --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---
    // A clean sync is git work and spends nothing, so the gate sits HERE: the
    // first point that is going to run the task's agent. The host merge above
    // left the worktree clean (it aborts a conflicted merge), and any clean
    // step it committed is recorded — both stand whatever is decided below.
    const mergedSoFar = hostMerge.steps.some(step => step.outcome === 'merged')
      ? ' The merge steps that applied cleanly are committed; only the conflicting one is left.'
      : '';
    if (params.daemonLaunch) {
      // INVARIANT: an automatic sync that hits a conflict on a paused
      // credential is HELD, never dropped. The pending-sync counter (reset
      // above, before the merges) is put back, and it alone owns the retry:
      // the retry loop re-offers it with backoff, and the first offer after the
      // window resets launches the agent. The result says `usagePauseHeld`, so
      // auto-delivery consumes the upstream signal rather than re-fetching and
      // re-merging on every pass for the whole pause.
      const held = await usagePauseHold(projectRoot, storage, task, 'conflict sync');
      if (held) {
        await storage.incrementTaskPendingSync(task.id);
        phases.skip(SYNC_PHASES.launch, 'held by the usage pause');
        return {
          taskId: task.id,
          displayId: displayId(task),
          status: 'pending_sync',
          message:
            `The merge into ${displayId(task)} conflicts, and resolving it runs the task's agent: held until the ` +
            `usage pause lifts, then retried. ${held}${mergedSoFar}`,
          warnings,
          usagePauseHeld: true,
        };
      }
    } else {
      // INVARIANT: a sync somebody ASKED for is refused, like any other turn
      // they ask for, before the agent is launched or the task claimed.
      try {
        await assertTurnStartAllowed(projectRoot, {
          task,
          config,
          actor,
          verb: 'sync',
          note: `The merge conflicts, and resolving it runs the task's agent.${mergedSoFar}`,
          overrideEligible: params.usagePauseOverrideEligible === true,
        });
      } catch (err) {
        // The counter was reset above on the way in. A sync the DAEMON had
        // queued before this one must survive the refusal, so it is put back
        // for the retry loop, which holds it until the reset.
        if (task.pending_sync > 0) await storage.incrementTaskPendingSync(task.id);
        throw err;
      }
    }

    const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
    // Set agent on runner so auth uses the correct agent (not hardcoded ClaudeCodeAgent)
    const harness = setRunnerAgentForTask(runner, config, task);
    await runner.checkAvailability();
    // Bridge/stamp the resolved runner onto the session before launch.
    await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

    const containerName = runner.runNameForTask(tRef);
    const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    phases.end();
    phases.begin(SYNC_PHASES.launch);

    // --- Persist state BEFORE launching supervisor ---
    // No synthetic turn is pre-created here. Turn recording for sync is owned by
    // the reconciler (handleCompletedResponses → recordSyncTurns), where the
    // merge OUTCOME is known: a real merge becomes a `supervisor`-actored turn
    // (plus the agent's conflict-resolution reply when there were conflicts),
    // while a no-op merge records NO turn at all. Pre-creating a turn here — before
    // the supervisor reports whether it actually merged anything — is exactly what
    // made no-op syncs leave a spurious turn pair, so we defer it to the reconciler.
    // (Upstream's per-channel actor refinement for the old synthetic turn is
    // superseded: the sync turn is now `supervisor`-actored, not human/builder.
    // SyncTaskParams.actor is retained on the interface for cross-command parity.)

    // --- Claim the task (serialized) ---
    // Everything from the authoritative status re-read through the command
    // write runs under the per-task lifecycle lock, so no other dispatcher can
    // interleave and no ask's pending response.json gets deleted out from under
    // it. See the CONCURRENCY note on syncTask. The slow fetch is already done;
    // this section is storage writes and one file write.
    const dispatch = await withTaskLifecycleLock(task.id, async () => {
      const fresh = await storage.getTask(task.id);
      if (!fresh) {
        throw new RpcError(404, `Task not found: ${params.taskId}`);
      }
      // WHITELIST, not a blacklist: a sync turn may only be dispatched from the
      // four paused statuses (matching ask's and unblock's gates). Enumerating
      // the statuses to REJECT would let anything else through — `pairing` and
      // `merging` both become reachable during the fetch window, and neither has
      // a `→ working` edge in TASK_TRANSITIONS, so we would bind a turn
      // credential in prepareTurnLaunch and then die on an invalid-transition
      // error for a turn that never launches. Standing down is the correct
      // response to EVERY non-dispatchable status, not just the busy ones.
      //
      // The list itself lives in src/task/sync-dispatch.ts, shared with the
      // daemon's retry loop — which had its own copy, missing `submitted`.
      if (!isSyncDispatchable(fresh.status)) {
        // Someone claimed the task while we were resolving/fetching (an ask, an
        // unblock, another sync, a human starting a pairing session). Do NOT
        // write a command over theirs — put the sync back on the counter for the
        // retry loop and report it as pending.
        standDownStatus = fresh.status;
        await storage.incrementTaskPendingSync(task.id);
        return null;
      }
      standDownMember = await standDownForMember(storage, fresh, params);
      if (standDownMember) return null;
      priorStatus = fresh.status;

      // The id this sync's command and its restore marker share. Allocated here
      // rather than inline on the command below because the marker is written
      // AGAINST it: only the turn carrying this id may claim the status back.
      const syncCommandId = newCommandId();

      // Transition to 'working' so the reconciler picks up the supervisor's
      // response.json and records the agent turn / status transition when the
      // merge completes. Without this, the supervisor runs but the response
      // sits in protocol/ forever and the task stays in its prior status.
      // Credential first — see the note in unblockTask.
      const { mustRecreateContainer } = await prepareTurnLaunch(projectRoot, {
        taskId: task.id,
        sessionId: sess.id,
        storage,
      });

      await storage.updateTaskStatus(task.id, 'working', actor);

      // A sync's conflict-resolution turn follows the previous turn's
      // agent/model/effort like every other turn type — resolved through the
      // one helper rather than shipping the raw `task.model`, which skipped the
      // local-backend rule and sent nothing at all when task.model was empty.
      const { model: syncModel, effort: syncEffort } = await resolveTurnLaunchIdentity({
        storage,
        task,
        config,
      });

      // Write a sync command — semantically distinct from start/unblock
      const syncCommand: SyncCommand = {
        type: 'sync',
        task_id: task.id,
        command_id: syncCommandId,
        protocol_version: PROTOCOL_VERSION,
        parent_branch: resolvedParentBranch,
        upstream_sha: resolvedUpstreamSha,
        // Present only when the host's fetch found commits on the task's own
        // branch that the worktree lacks. The supervisor merges it FIRST, then
        // the parent — both onto the task branch, never onto the parent.
        ...(remoteBranch ? { remote_branch: remoteBranch } : {}),
        agent_session_id: sess.agent_session_id ?? undefined,
        model_id: syncModel,
        effort: syncEffort,
        // The conflict-resolution turn runs the TASK'S agent. It must travel with
        // the model and session above: those are only valid for the agent that
        // issued them, and a sync that shipped a cursor task's pair to a
        // hardcoded `claude` failed instantly on every retry.
        agent_id: task.agent_id,
        harness,
        ...(config.agent.watchdog_output_timeout_ms !== 0 && {
          watchdog_output_timeout_ms: config.agent.watchdog_output_timeout_ms,
        }),
        // Sent even when 0 so the supervisor sees the explicit opt-out rather
        // than falling back to a default.
        wind_down_timeout_ms: config.agent.wind_down_timeout_ms,
      };
      // Record what this sync FOUND, against this sync's command id, so its
      // end-of-turn park can put the status back instead of parking the task
      // `blocked`. This is the only moment that knows it: the park happens in
      // the reconciler, a turn later, with no caller left. Only `submitted` is
      // ever restored, and only by the turn running THIS command — see
      // src/task/sync-restore-status.ts for both rules.
      //
      // Written as LATE as the dispatch allows, immediately before the command:
      // anything that throws on the way here (a credential bind, the status
      // transition, launch-identity resolution) then leaves no marker behind at
      // all, rather than one whose turn never ran.
      await markSyncRestoreStatus(storage, task.id, priorStatus, syncCommandId);
      writeCommand(protoDir, syncCommand);

      return { mustRecreateContainer };
    });

    if (!dispatch && standDownMember) {
      phases.skip(SYNC_PHASES.launch, `${standDownMember} has a terminal open — sync stays queued`);
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: 'held_by_member',
        message: `${standDownMember} has a terminal open on task ${displayId(task)}. The sync stays queued and will merge ${resolvedParentBranch} once their session has ended.`,
        warnings,
      };
    }
    if (!dispatch) {
      phases.skip(SYNC_PHASES.launch, `task became '${standDownStatus}' — sync stays queued`);
      return {
        taskId: task.id,
        displayId: displayId(task),
        status: 'pending_sync',
        message: `Task ${displayId(task)} became '${standDownStatus}' before the sync could start. It stays queued and will merge ${resolvedParentBranch} once the task is paused again.`,
        warnings,
      };
    }
    const { mustRecreateContainer } = dispatch;

    // Generate daemon MCP config if needed
    let daemonConfigPath: string | null = null;
    // Skip when running outside the daemon (in-process RPC fallback) — there is
    // no daemon for the container to connect to, and getDaemonContext() throws.
    // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Launch or reuse supervisor
    const mustRecreateForAgent = mustRecreateForContainerAgent(sess, task.agent_id);
    if (mustRecreateForAgent) {
      phases.note(
        `recreating container: agent changed ` +
        `(${sess.container_agent_id} → ${task.agent_id}) — launch env is fixed at create time`,
      );
    }
    if (!mustRecreateContainer && !mustRecreateForAgent && (await runner.isRunning(containerName))) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
      phases.note(`reusing running container ${containerName}`);
    } else {
      await removeTaskRun(runner, storage, sess, containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, task.id, pinnedCustomImage(task), phases.notify);
      } catch (err) {
        // Supervisor failed to launch — revert the working transition so the
        // task doesn't get stuck waiting for a supervisor that never started.
        // Going back to the prior status is safer than 'interrupted' because
        // no work has happened yet; the user can simply retry sync.
        try {
          await storage.updateTaskStatus(task.id, priorStatus, actor);
        } catch (revertErr) {
          logger.warn(`Failed to revert status for ${displayId(task)} after supervisor launch failure: ${revertErr instanceof Error ? revertErr.message : revertErr}`);
        }
        // The revert above already put the status back, so the marker has
        // nothing left to restore — drop it rather than leave it for a later
        // sync's park to find.
        await clearSyncRestoreStatus(storage, task.id);
        // Clean up the command file — there's no supervisor to consume it,
        // so a stale sync command shouldn't linger in protoDir.
        try {
          consumeCommand(protoDir);
        } catch (cleanupErr) {
          logger.warn(`Failed to clean up sync command file for ${displayId(task)} after supervisor launch failure: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
        }
        throw new RpcError(500, `Failed to launch supervisor for sync: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Record container name and reset interaction timer so the reconciler's
    // grace period applies (prevents a premature 'interrupted' transition
    // before the supervisor picks up the command).
    await storage.updateSessionContainerName(sess.id, containerName, task.agent_id);
    sess.container_agent_id = task.agent_id;
    await storage.updateSessionInteraction(sess.id, 0);

    // NOTE: pending_sync is NOT cleared here. It stays true until:
    // - The supervisor completes the merge and writes a 'completed' response
    // - The daemon's turn-completion handler clears it
    // This ensures that if the supervisor crashes, pending_sync stays true for retry.

    phases.end(containerName);

    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'sync_launched',
      message: `Merging ${mergeTargetsLabel(remoteBranch, upstreamHasChanges ? resolvedParentBranch : undefined)} into the task branch in the background. Check progress with: lazy watch ${displayId(task)}`,
      warnings,
    };
  } finally {
    await removeLock(worktreePath);
  }
}

// =====================================================================
// Reparent Task — repoint a task to a new parent and sync
// =====================================================================

export interface ReparentTaskParams {
  taskId: string;
  /** New parent: a task code, short ID, or a raw branch name (e.g. "main"). */
  parent: string;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface ReparentTaskResult {
  taskId: string;
  displayId: string;
  /**
   * - 'noop': task is already parented on the requested target — nothing changed
   * - 'reparented': parent repointed and a sync ran (see syncStatus)
   * - 'reparented_no_sync': parent repointed but the task has no live session
   *   yet (e.g. backlog), so there is nothing to merge — it will branch from
   *   the new parent when started
   */
  status: 'noop' | 'reparented' | 'reparented_no_sync';
  /** Underlying sync status when a sync ran. */
  syncStatus?: SyncTaskResult['status'];
  /** Human-readable description of the new parent. */
  newParent: string;
  message: string;
  warnings: string[];
}

/**
 * Repoint a task to a new parent and merge the new parent into its branch.
 *
 * Reparent does exactly two things — it does NOT create a new task, reset the
 * session, or touch the task's history:
 *   1. Repoint the task's canonical integration target (a single TaskTarget —
 *      either { kind: 'task' } or { kind: 'branch' }) through the Storage interface.
 *   2. Run the existing `lazy sync` machinery so the task's own agent merges
 *      the new parent into its branch and resolves any conflicts in place.
 *
 * The task keeps its identity: same session, same turns, same commits, same
 * branch. Only its parent pointer (and therefore its sync/accept/diff base)
 * changes.
 */
export async function reparentTask(
  projectRoot: string,
  params: ReparentTaskParams,
): Promise<ReparentTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'reparent');
  try {
    return await reparentTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function reparentTaskRun(
  projectRoot: string,
  params: ReparentTaskParams,
  phases: PhaseReporter,
): Promise<ReparentTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  phases.begin(REPARENT_PHASES.preflight);

  // --- Resolve task ---
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = result.task;

  // --- Status validation ---
  // Don't pull the branch out from under a running agent.
  if (task.status === 'working') {
    throw new RpcError(409, `Task ${displayId(task)} is currently working. Wait for it to finish or interrupt it before reparenting.`);
  }
  // A terminal task's branch may already be merged or deleted — reopen first.
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is ${task.status}. Reopen it first with: lazy reopen ${displayId(task)}`);
  }

  // --- Resolve the new parent (task code / short ID, or raw branch name) ---
  let newParentTaskId: string | null = null;
  let targetBranch: string;
  let newParentLabel: string;

  const parentResult = await storage.resolveTask(params.parent);
  if (parentResult.task) {
    const parentTask = parentResult.task;

    if (parentTask.id === task.id) {
      throw new RpcError(400, `Cannot reparent ${displayId(task)} onto itself.`);
    }
    if (isTerminalStatus(parentTask.status)) {
      throw new RpcError(409, `Cannot use ${displayId(parentTask)} as parent: it is ${parentTask.status}.`);
    }
    // Cycle check: the new parent must not be a descendant of this task.
    const parentAncestry = await storage.getTaskAncestry(parentTask.id);
    if (parentAncestry.some(a => a.id === task.id)) {
      throw new RpcError(400, `Cannot reparent ${displayId(task)} onto ${displayId(parentTask)}: that would create a cycle (the target is a descendant of this task).`);
    }

    newParentTaskId = parentTask.id;
    targetBranch = await getBranchNameFromId(parentTask.id, storage);
    newParentLabel = `${displayId(parentTask)} (${targetBranch})`;
  } else if (parentResult.ambiguousMatches?.length) {
    throw new RpcError(409, `Ambiguous parent '${params.parent}'. Matches: ${parentResult.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
  } else {
    // Not a task — treat it as a raw branch name. Verify it resolves locally
    // (boundary check); sync's resolveUpstreamRef handles the remote fetch.
    const branch = params.parent;
    const verify = await runGit(['rev-parse', '--verify', '--quiet', branch], { cwd: projectRoot });
    if (verify.exitCode !== 0) {
      throw new RpcError(404, `Could not resolve '${params.parent}' as a task or a git branch.`);
    }
    newParentTaskId = null;
    targetBranch = branch;
    newParentLabel = `branch ${branch}`;
  }

  // --- No-op detection (already on that parent) ---
  const currentParentId = parentTaskIdOf(task);
  let isNoop = false;
  if (newParentTaskId !== null) {
    isNoop = currentParentId === newParentTaskId;
  } else if (currentParentId === null) {
    // Both top-level: compare the effective tracked branch.
    const cur = targetBranchOf(task);
    const cfg = await loadConfig(projectRoot);
    const curBranch = cur ?? await getRemoteDefaultBranch(projectRoot, cfg.remote.git_remote);
    isNoop = curBranch === targetBranch;
  }

  if (isNoop) {
    // Nothing is announced yet — the plan only makes sense once we know there
    // is a reparent to do, so the pre-flight row is the whole narration here.
    phases.end(`already parented on ${newParentLabel}`);
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'noop',
      newParent: newParentLabel,
      message: `Task ${displayId(task)} is already parented on ${newParentLabel}. Nothing to do.`,
      warnings,
    };
  }

  phases.end(displayId(task));
  // ONE plan for the whole operation: reparent's own repoint step followed by
  // sync's phases, which syncTask then walks by narrating into this reporter.
  phases.announce(reparentPhasePlan(), displayId(task));
  phases.begin(REPARENT_PHASES.repoint, newParentLabel);

  // --- Step 1: repoint the target through the Storage interface ---
  const oldParentLabel = currentParentId
    ? await displayIdFor(storage, currentParentId)
    : (targetBranchOf(task) ? `branch ${targetBranchOf(task)}` : 'top-level');

  // A single canonical target — either stacked on a task or pointed at a branch.
  // There is no separate parent/branch pair to keep consistent.
  //
  // A member working in the task's files refuses the reparent BEFORE anything
  // is written: the sync below merges the new parent into those files and
  // refuses while they are inside, and a repoint recorded ahead of that
  // refusal would leave the task on a parent it was never synced with. Checked
  // and written under the lifecycle lock a member's entry takes; released
  // before the sync, which takes it itself.
  await withTaskLifecycleLock(task.id, async () => {
    const holder = memberInsideTask(task.id);
    if (holder) throw new RpcError(409, memberInsideSyncMessage(holder));
    await storage.updateTaskTarget(
      task.id,
      newParentTaskId !== null ? taskTarget(newParentTaskId) : branchTarget(targetBranch),
    );

    await storage.createComment(
      task.id,
      `${REPARENTED_COMMENT_PREFIX}Parent changed from ${oldParentLabel} to ${newParentLabel}.`,
      actor,
    );
  });

  // An open PR/MR a person submitted must follow the new target — retargeted
  // on the forge, or closed if it cannot be (./review-retarget.ts). Before the
  // sync, so the status the sync records is the one the task now has.
  warnings.push(...await retargetReviewsAfterReparent(projectRoot, storage, [task]));

  // Children stack on THIS task's branch, not on its parent. Repointing this
  // task doesn't change its own branch — children remain based on it and pick
  // up the new parent's changes the next time they sync. So we don't block or
  // orphan them; just inform the caller.
  const activeChildren = await getActiveChildren(task.id, storage);
  if (activeChildren.length > 0) {
    const plural = activeChildren.length === 1 ? 'child task remains' : 'child tasks remain';
    warnings.push(
      `${activeChildren.length} active ${plural} based on this task's branch (${getBranchName(task)}). ` +
      `They are unaffected by the reparent and will pick up the new parent's changes the next time they sync.`,
    );
  }

  // --- Step 2: merge the new parent into the task branch via existing sync ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess || sess.ended_at || task.status === 'backlog') {
    // No live session (e.g. backlog / never started). Nothing to merge — the
    // task will branch from the new parent when it starts.
    phases.end(newParentLabel);
    for (const phase of syncPhasePlan()) {
      phases.skip(phase, 'no session yet — nothing to merge');
    }
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'reparented_no_sync',
      newParent: newParentLabel,
      message: `Reparented ${displayId(task)} onto ${newParentLabel}. Task has no active session yet; it will branch from the new parent when started.`,
      warnings,
    };
  }

  // Reuse the existing sync machinery — do NOT reimplement merge logic. The
  // task's own agent rides along to resolve any conflicts in place.
  phases.end(newParentLabel);
  let syncResult: SyncTaskResult;
  try {
    syncResult = await syncTask(projectRoot, { taskId: task.id, reporter: phases, liftPin: true });
  } catch (err) {
    // The usage pause refusing the conflict resolution does not undo the
    // reparent, which has happened — and the task now OWES a sync against its
    // new parent. So it is queued: the retry loop holds it while the pause
    // stands and runs it after the reset, as for any automatic sync. (The sync
    // put back a counter that was already set when it began, so this only
    // queues one where none is queued.)
    if (!isUsagePauseRefusal(err)) throw err;
    if (!((await storage.getTask(task.id))?.pending_sync)) {
      await storage.incrementTaskPendingSync(task.id);
    }
    warnings.push(
      `${(err as Error).message}\nThe task is reparented, and its sync is queued: lazy runs it by itself ` +
      `once the pause lifts.`,
    );
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'reparented',
      syncStatus: 'pending_sync',
      newParent: newParentLabel,
      message: `Reparented ${displayId(task)} onto ${newParentLabel}. The sync was not run: its merge conflicts, and new turns on this credential are paused. It is queued and runs by itself once the pause lifts.`,
      warnings,
    };
  }
  warnings.push(...syncResult.warnings);

  return {
    taskId: task.id,
    displayId: displayId(task),
    status: 'reparented',
    syncStatus: syncResult.status,
    newParent: newParentLabel,
    message: `Reparented ${displayId(task)} onto ${newParentLabel}. ${syncResult.message}`,
    warnings,
  };
}

// =====================================================================
// Submit Task — create/update PR and transition to submitted
// =====================================================================

export interface SubmitTaskParams {
  taskId: string;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
}

export interface SubmitTaskResult {
  taskId: string;
  displayId: string;
  prUrl: string | null;
  warnings: string[];
}

/**
 * Submit a task for review by creating/updating a PR on the remote.
 *
 * Pre-conditions:
 * - Task must be in blocked or conflict status
 * - Task must have at least one session commit (non-empty diff)
 * - Remote driver must be configured (not local-only)
 *
 * Side effects:
 * - Pushes the task branch to remote
 * - Creates or updates a PR via driver.markReadyForReview()
 * - Transitions task from blocked/conflict → submitted
 */
export async function submitTask(
  projectRoot: string,
  params: SubmitTaskParams,
): Promise<SubmitTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  // `let`: a task stranded in `merging` is recovered below, which replaces this
  // with the refreshed record.
  let task = resolveResult.task;

  // --- Offline check (before any other validation) ---
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  if (offline) {
    throw new RpcError(400, 'Cannot submit while in offline mode. Run `lazy system online` to restore remote operations, then retry.');
  }

  // A task stranded in `merging` by a dead accept used to hit the guard below
  // and be told "only blocked or conflict tasks can be submitted" — while the
  // FSM's own refusal from reject/close advertised `submitted` as a valid exit
  // from `merging`. Both messages were true and neither was usable. The edge in
  // the transition table is real but belongs to the accept ABORT path (restore a
  // task that was `submitted` before the accept began), not to a user submit, so
  // the guard stays: recover the stranded task to its resting state first and
  // submit from there.
  task = await escapeMergingForOperation(storage, task, actor, 'submit', projectRoot);
  if (task.status === 'submitted') {
    // The recovery restored a task that already had an open PR before the accept.
    return {
      taskId: task.id,
      displayId: displayId(task),
      prUrl: null,
      warnings: [
        `Task was stranded in merging by an accept that is no longer running. It was already submitted ` +
        `before that accept, so it has been restored to submitted — its existing PR still stands.`,
      ],
    };
  }

  // --- Status validation ---
  if (task.status !== 'blocked' && task.status !== 'conflict') {
    throw new RpcError(
      409,
      `Task ${displayId(task)} is ${task.status}. Only blocked or conflict tasks can be submitted. ` +
      `Run \`lazy show ${displayId(task)}\` to see where it stands.`,
    );
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session.`);
  }

  // --- Non-empty diff check ---
  const commits = await storage.getSessionCommits(sess.id);
  if (commits.length === 0) {
    throw new RpcError(400, `Task ${displayId(task)} has no commits. Nothing to submit for review.`);
  }

  // --- Remote driver check ---
  let driver;
  try {
    driver = createDriver(config);
  } catch {
    throw new RpcError(400, 'No remote driver configured. Set [remote] driver in lazy.toml to use submit.');
  }

  if (!driver.needsSync) {
    throw new RpcError(400, 'Submit requires a remote driver (e.g., github). Local driver has no remote to create PRs on.');
  }

  // --- Intermediate-parent routing (INVARIANT: PRs only for protected branches) ---
  // A child task stacked on another task integrates into an intermediate
  // `lazy/...` parent branch, which is NEVER a protected integration branch.
  // By DEFAULT such tasks never get a remote MR/PR — `lazy accept` merges them
  // locally into the parent, and no automatic path opens one. An explicit
  // submit by a PERSON is the exception (engineer decision 2026-09-24): that is
  // the request, and it is honoured with the parent's branch as the base —
  // never by silently retargeting to main, which would let the forge evaluate
  // the change against the wrong base. Agents and the builder keep the refusal
  // (./submit-target.ts). Determined structurally — no network call, so a
  // transient forge failure can never misroute this.
  const submitTarget = await resolveSubmitTarget(task, storage);
  const { targetBranch: submitTargetBranch, intermediate } = submitTarget;
  if (intermediate && !mayOpenIntermediateReview(actor)) {
    throw new RpcError(400, intermediateSubmitRefusal(task, submitTargetBranch));
  }

  // --- A PR lazy closed itself is never reused ---
  // INVARIANT (./lazy-closed-review.ts): a marked record is resolved against
  // the forge BEFORE submit reuses it. Clearing the marker unconditionally and
  // keeping a record whose PR reads CLOSED left an unmarked close on a live
  // task, which the next remote-sync pass read as somebody else's and
  // abandoned. CLOSED/MERGED → the record is dead: drop it and fall through to
  // adoption, the base check and a NEW PR against the current target. OPEN →
  // the close never happened; the marker goes and the PR stands. Unreadable →
  // refuse and keep the marker, because the PR may still be open against the
  // old branch.
  const marked = await markedRecordState(driver, task);
  if (marked === 'unknown') {
    throw new RpcError(502, unconfirmedCloseRefusal(displayId(task), task.metadata?.[LAZY_CLOSED_REVIEW_KEY] ?? ''));
  }
  if (marked === 'closed') await dropLazyClosedRecord(storage, task);
  else if (marked === 'open') await clearLazyClosedReview(storage, task);

  // --- Push branch ---
  // Before the forge lookups below: a push failure is the clearest thing to
  // report, and pushing the task's OWN branch is what the daemon does after
  // every turn anyway. The parent is never pushed here.
  try {
    await driver.pushBranch(sess.git_branch);
  } catch (err) {
    throw new RpcError(500, `Failed to push branch ${sess.git_branch}: ${err instanceof Error ? err.message : err}`);
  }

  // --- Adopt a PR/MR opened by hand ---
  // "The PR exists but lazy does not know about it" must not end in a failed
  // create (the forge refuses a second PR for the same head) or in a second
  // PR. Adopt it — but only if it merges where this task integrates.
  let adopted: OpenReview | null = null;
  try {
    adopted = await findUnrecordedReview(driver, task, sess.git_branch);
  } catch (err) {
    throw new RpcError(502, `Could not check the forge for an existing PR/MR for ${sess.git_branch}: ${err instanceof Error ? err.message : err}`);
  }
  if (adopted?.baseBranch) {
    // A root task with no named target integrates into the remote's default
    // branch: compare against its real name, as the forge accept will.
    const comparison = await reviewComparisonBranch(submitTarget, projectRoot, config.remote.git_remote);
    if (reviewBaseMismatch(adopted, comparison)) {
      throw new RpcError(409, mismatchedReviewRefusal(task, adopted, comparison));
    }
  }

  // --- A recorded PR/MR must merge where the task integrates NOW ---
  // INVARIANT (./submit-target.ts): submit never reports `submitted` with a PR
  // whose base is not the task's current target. A reparent's retarget can be
  // skipped (offline, unreadable state), refused, or end in a close the forge
  // never confirmed that later reads OPEN — and markReadyForReview never
  // changes an existing PR's base. So the recorded PR's base is read here:
  // a mismatch is moved onto the current target, a refused move refuses the
  // submit (never a second PR for the same head), and an unreadable base
  // refuses too, fail-closed like an unconfirmed close. A reviewer merging the
  // old-base PR would land the work in a branch the task no longer goes to.
  const recorded = await recordedReviewBase(driver, task, submitTarget, projectRoot, config.remote.git_remote);
  if (recorded.kind === 'unreadable') {
    throw new RpcError(502, recordedBaseUnreadableRefusal(task, recorded.comparison, recorded.reason));
  }
  if (recorded.kind === 'mismatch') {
    // INVARIANT: a LINKED task's PR (`lazy link`) is someone else's, and lazy
    // never changes its base — the same rule the reparent retarget and the
    // close-review step keep. Moving it would re-point a colleague's PR.
    if (isLinkedTask(task)) {
      throw new RpcError(409, linkedReviewBaseRefusal(task, recorded.base, recorded.comparison));
    }
    if (intermediate) {
      let remoteHead: string | null;
      try {
        remoteHead = await driver.remoteBranchHead(recorded.comparison);
      } catch (err) {
        throw new RpcError(502, `Could not check whether \`${recorded.comparison}\` is on ${config.remote.git_remote}: ${err instanceof Error ? err.message : err}`);
      }
      if (!remoteHead) {
        throw new RpcError(409, baseNotOnRemoteRefusal(task, recorded.comparison, config.remote.git_remote));
      }
    }
    try {
      await driver.retargetReview(task, recorded.comparison);
    } catch (err) {
      throw new RpcError(409, recordedRetargetRefusal(task, recorded.base, recorded.comparison, err instanceof Error ? err.message : String(err)));
    }
    warnings.push(`Moved the PR/MR's base from \`${recorded.base}\` to \`${recorded.comparison}\`, where the task integrates now.`);
  }

  // --- The base must be on the remote (intermediate targets only) ---
  // A root task's target is a real integration branch, which the forge always
  // has. A parent task's branch is pushed after each of its turns, so it
  // normally is there too — but submit NEVER pushes the parent to make it so.
  if (intermediate && !adopted && !driver.hasRemoteRef(task)) {
    let remoteHead: string | null;
    try {
      remoteHead = await driver.remoteBranchHead(submitTargetBranch);
    } catch (err) {
      throw new RpcError(502, `Could not check whether \`${submitTargetBranch}\` is on ${config.remote.git_remote}: ${err instanceof Error ? err.message : err}`);
    }
    if (!remoteHead) {
      throw new RpcError(409, baseNotOnRemoteRefusal(task, submitTargetBranch, config.remote.git_remote));
    }
    const stale = await staleBaseWarning(projectRoot, sess.git_branch, submitTargetBranch, remoteHead, config.remote.git_remote);
    if (stale) warnings.push(stale);
  }

  if (adopted) {
    for (const [key, value] of Object.entries(adopted.metadata)) {
      await storage.updateTaskMetadata(task.id, key, value);
    }
    if (!task.metadata) task.metadata = {};
    Object.assign(task.metadata, adopted.metadata);
    warnings.push(`Adopted the existing PR/MR for ${sess.git_branch}: ${adopted.url}`);
  }

  // --- Create/update PR ---
  let prUrl: string | null = null;
  try {
    const prResult = await driver.markReadyForReview(
      task,
      intermediate ? { baseBranch: submitTargetBranch } : undefined,
    );
    if (prResult.metadata) {
      for (const [key, value] of Object.entries(prResult.metadata)) {
        await storage.updateTaskMetadata(task.id, key, value);
      }
      // Update in-memory metadata for getTaskUrl
      if (!task.metadata) task.metadata = {};
      Object.assign(task.metadata, prResult.metadata);
    }

    // Safety net: ensure remote ref metadata was persisted. If markReadyForReview
    // created a PR but failed to return its ID (e.g., glab output parsing failure),
    // the task would be stuck in submitted with no way to detect merge completion.
    if (!driver.hasRemoteRef(task)) {
      const recovered = await driver.recoverRemoteRef(task);
      if (recovered) {
        for (const [key, value] of Object.entries(recovered)) {
          await storage.updateTaskMetadata(task.id, key, value);
        }
        if (!task.metadata) task.metadata = {};
        Object.assign(task.metadata, recovered);
        logger.warn(`submitTask ${displayId(task)}: recovered missing remote ref metadata after markReadyForReview`);
      } else {
        logger.warn(`submitTask ${displayId(task)}: no remote ref metadata after markReadyForReview — merge detection will not work until next sync`);
      }
    }

    prUrl = await driver.getTaskUrl(task);
  } catch (err) {
    throw new RpcError(500, `Failed to create/update PR: ${err instanceof Error ? err.message : err}`);
  }

  // --- Transition to submitted ---
  await storage.updateTaskStatus(task.id, 'submitted', actor);
  await storage.createComment(task.id, `${SUBMITTED_COMMENT_PREFIX}Task submitted for review${prUrl ? `: ${prUrl}` : ''}`, actor);

  return {
    taskId: task.id,
    displayId: displayId(task),
    prUrl,
    warnings,
  };
}

// =====================================================================
// Resume Task — restart an interrupted task
// =====================================================================

export interface ResumeTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  modelOverride?: string;
  /** CLI `--effort` override. Persists on the task so future turns use same value. */
  effortOverride?: string;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface ResumeTaskResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
}

/**
 * Build the static system prompt for task resume (after interruption).
 */
export function buildSystemPromptForResume(runnerInstructions?: string, chattinessSnippet?: string, memorySection?: string, lazyMdSection?: string): string {
  let prompt = lazyToolInstructions + '\n' + systemInstructionsResumeText;
  if (runnerInstructions) {
    prompt += '\n' + runnerInstructions;
  }
  // Shared-memory index (see src/memory) — same injection as a fresh launch, so
  // a resumed agent doesn't lose the project's curated knowledge.
  if (memorySection) {
    prompt += '\n\n' + memorySection;
  }
  // The project's LAZY.md instructions (see src/task/lazy-md), for the same
  // reason: a resumed turn is still a turn on this project, and an agent that
  // lost the project's own instructions on resume would work to different rules
  // than the turn before it.
  if (lazyMdSection) {
    prompt += '\n\n' + lazyMdSection;
  }
  if (chattinessSnippet) {
    prompt = chattinessSnippet + '\n\n' + prompt;
  }
  return prompt;
}

/**
 * Build the dynamic user prompt for resuming after interruption.
 *
 * INVARIANT (CLAUDE.md — never lose human feedback): when `redeliveredFeedback`
 * is present it REPLACES the generic "you were interrupted, carry on" context,
 * which would otherwise leave unconsumed feedback available only implicitly via
 * turn history. Mirrors buildResumePrompt in src/utils/auto-resume.ts.
 */
export function buildResumePrompt(goal: string, redeliveredFeedback?: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = (redeliveredFeedback ?? resumeContextText) + '\n';
  return goalContext + resumeContext;
}

/**
 * Resume an interrupted task.
 *
 * Pre-conditions:
 * - Task must be in 'interrupted' status
 * - Task must have an active (non-ended) session
 *
 * Side effects:
 * - Recovers worktree if missing
 * - Sets up sandbox, resolves model, discovers Claude session ID
 * - Creates synthetic human turn for the resume
 * - Transitions task to 'working'
 * - Writes protocol command and launches supervisor
 * - Resets circuit breaker and auto-react counters
 */
export async function resumeTask(
  projectRoot: string,
  params: ResumeTaskParams,
): Promise<ResumeTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'resume');
  try {
    return await resumeTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function resumeTaskRun(
  projectRoot: string,
  params: ResumeTaskParams,
  phases: PhaseReporter,
): Promise<ResumeTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  phases.begin(RESUME_PHASES.preflight);

  // --- Resolve task ---
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = result.task;

  // --- Status validation ---
  // `lazy resume` resumes a task with no new feedback (use `lazy unblock
  // --message` to send guidance instead). After unifying `lazy stop` to
  // transition tasks to 'blocked' (with user_stopped=true) rather than
  // 'interrupted', resume must also accept blocked-by-stop tasks. Other
  // statuses still reject.
  // `conflict` resumes like `blocked` (move-file-approval-to-accept): it now
  // means only that a protected-file decision is owed at ACCEPT. No turn
  // reverts anything, so continuing the work cannot destroy an undecided file.
  if (task.status !== 'interrupted' && task.status !== 'blocked' && task.status !== 'conflict') {
    if (task.status === 'working') {
      throw new RpcError(409, `Task ${displayId(task)} is still working. Use 'lazy blocked' to check when it finishes.`);
    } else {
      throw new RpcError(409, `Task ${displayId(task)} cannot be resumed (status: ${task.status}).`);
    }
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session.`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): a
  // pending protected-file violation does NOT refuse a resume. Resume routes
  // through the unblock path, which no longer reverts anything, so the decision
  // the reviewer still owes is safely deferred to `lazy accept` — the one gate.
  // The old refusal existed only because that path used to revert every file
  // the caller could not name here.

  // --- Turn budget: cap consecutive turns without a human in the loop ---
  // Builder/agent-initiated resumes count; a human resume resets the count.
  const resumeTurnBudgetConfig = await loadConfig(projectRoot);
  if (actorRole(actor) !== 'human') {
    const nonHumanTurnCount = await getNonHumanTurnCount(storage, task.id);
    const budgetDecision = checkTurnBudget(nonHumanTurnCount, resumeTurnBudgetConfig.limits.max_turns_without_human);
    if (!budgetDecision.allowed) {
      throw new RpcError(409, `Task ${displayId(task)}: ${budgetDecision.reason}`);
    }
  }

  const tRef = taskRef(task);

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, tRef, displayId(task));

  // --- Runner pre-flight (honor per-task runner override) ---
  const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
  const harness = setRunnerAgentForTask(runner, resumeTurnBudgetConfig, task);
  await runner.checkAvailability();

  // --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---
  // After every preflight that can refuse on its own, so a one-shot override is
  // not spent on a resume that was going to fail anyway; before any write.
  await assertTurnStartAllowed(projectRoot, {
    task, config: resumeTurnBudgetConfig, actor, verb: 'resume',
    overrideEligible: params.usagePauseOverrideEligible === true,
  });

  // --- Worktree recovery ---
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);

  if (!await pathExists(worktreePath)) {
    const branchName = sess.git_branch;
    const resumeConfig = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, resumeConfig.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
      // Recreating someone's worktree is a side effect they didn't ask for —
      // say so rather than doing it silently.
      warnings.push(`Worktree was missing, recreated from branch ${branchName}.`);
      if (recovery.dirty) {
        warnings.push('Recovered worktree has uncommitted changes.');
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- Lock check ---
  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Task ${shortId(task.id)} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }

  phases.end(displayId(task));
  phases.announce(resumePhasePlan(), displayId(task));
  phases.begin(RESUME_PHASES.prepare);

  await acquireLock(worktreePath, 'lazy resume');

  // Bridge/stamp the resolved runner onto the session before launch.
  await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

  const containerName = runner.runNameForTask(tRef);

  try {
    const config = await loadConfig(projectRoot);

    const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

    // --- Agent / model / effort resolution ---
    // A resume continues the interrupted turn, so it continues its agent, model
    // and effort unless this resume names new ones. One rule for every turn
    // type — see resolveTurnLaunchIdentity (which is also where the Ollama rule
    // lives: a local backend forces its own model, because task model names
    // like "claude-opus-4-8" do not exist in Ollama's registry).
    const { model: modelName, effort: effortValue } = await resolveTurnLaunchIdentity({
      storage,
      task,
      config,
      modelOverride: params.modelOverride,
      effortOverride: params.effortOverride,
    });
    const modelId = modelName;

    // EXPERIMENTAL Low-high loop: a manual resume relaunches a work turn, so it
    // stays in the task's experiment arm (metadata > config, no CLI override).
    const lowHighLoop = await resolveAndPersistLowHighLoop(
      task, undefined, config, storage, effortValue as EffortLevel,
    );
    const turnEffort = lowHighLoop ? lowHighLoop.draftEffort : effortValue;

    // --- Agent session id + distilled handoff ---
    //
    // After an agent switch, switchTaskAgent clears agent_session_id (harness
    // change). Do NOT rediscover a session for a harness that cannot use it —
    // that would pass a Claude resume id to Cursor/Codex and skip the turn-
    // history handoff the new agent needs. The harness switch inside the
    // discovery helper decides which layouts are resumable (Claude and pi).
    // INVARIANT (fix-agent-switching-on-tasks): fresh session with prior turns
    // gets the same distilled handoff unblock uses.
    //
    // Rediscovery is not a rare path: `agent_session_id` is only written when a
    // turn FINALIZES, so a task whose turn was killed before finalize (a `lazy
    // upgrade` stopping every container, a daemon restart, a crash) has none
    // stored and would otherwise resume as a brand-new conversation. Discovery
    // goes through the one module that knows each harness's session layout,
    // asking the RUNNER where that directory is — the sandbox for docker, the
    // host HOME for host-process. A private copy here scanned for `.json` files
    // inside the sandbox and so matched nothing, ever.
    let agentSessionId = sess.agent_session_id;
    if (!agentSessionId) {
      agentSessionId = await rediscoverSessionIdForHarness(harness, runner, worktreePath);
      if (agentSessionId) {
        await storage.updateSessionClaudeId(sess.id, agentSessionId);
        sess.agent_session_id = agentSessionId;
      }
    }
    const canResume = !!agentSessionId;

    // --- Build prompts ---
    const systemPrompt = buildSystemPromptForResume(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }), await buildLazyMdSection(worktreePath));
    // INVARIANT (CLAUDE.md — never lose human feedback): a manual resume has the
    // same gap as auto-resume — if the interrupted turn crashed before the agent
    // consumed its feedback, re-deliver that feedback verbatim.
    const pendingFeedback = findPendingFeedback(await storage.getSessionTurns(sess.id));
    let fullPrompt = buildResumePrompt(
      task.goal,
      pendingFeedback ? buildFeedbackRedeliveryPrompt(pendingFeedback) : undefined,
    );
    if (!canResume) {
      const turns = await storage.getSessionTurns(sess.id);
      if (turns.length > 0) {
        try {
          const handoff = await buildAgentSwitchHandoffContext({
            turns,
            branchName: sess.git_branch,
            gitStartSha: sess.git_start_sha,
            worktreePath,
          });
          fullPrompt = `${handoff}\n\n${fullPrompt}`;
        } catch (err) {
          logger.warn(
            `Task ${displayId(task)}: resume agent-switch handoff failed (${err instanceof Error ? err.message : String(err)}); falling back to turn history only`,
          );
          fullPrompt = `${buildTurnHistoryContext(turns)}\n\n${fullPrompt}`;
        }
      }
    }

    // --- Persist state BEFORE launch ---
    // The resume notice deliberately does NOT carry feedback: it is not new
    // feedback, and the re-delivered turn stays 'pending' until an agent turn
    // actually completes, so a crash mid-resume re-delivers it again.
    // Credential first — see the note in unblockTask. This is the path the
    // incident came in on: daemon dies mid-turn, its supervisor survives, the
    // human clicks Restart, and the resumed turn 401s on request one.
    //
    // UNDER THE TASK'S LIFECYCLE LOCK, like every launch path, and the notice
    // turn with it: a member's entry into this task (src/daemon/member-entry.ts)
    // takes the same lock, so either this launch sees the member inside and
    // refuses BEFORE writing anything, or the entry sees this task `working`
    // and is refused — never a member working in the worktree while a turn
    // runs on it, and never a notice turn for a resume that did not happen.
    const { mustRecreateContainer } = await withTaskLifecycleLock(task.id, async () => {
      assertNoMemberInside(task.id);
      const nextSeq = await storage.getNextTurnSequence(sess.id);
      await storage.createTurn({
        sessionId: sess.id,
        sequence: nextSeq,
        role: 'human',
        content: pendingFeedback
          ? '[system] Session interrupted and resumed (unconsumed feedback re-delivered)'
          : '[system] Session interrupted and resumed',
        agent: task.agent_id,
        model: modelName,
        effort: turnEffort,
        actor,
      });
      const prepared = await prepareTurnLaunch(projectRoot, {
        taskId: task.id,
        sessionId: sess.id,
        storage,
      });
      await storage.updateTaskStatus(task.id, 'working', actor);
      return prepared;
    });

    // --- Write command and launch supervisor ---
    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    phases.end();
    phases.begin(RESUME_PHASES.launch);

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      // A cluster's constraints hold on EVERY turn it takes — a resume is a turn.
      // Same injection unblockTask makes; see src/task/type-constraints.ts.
      prompt: typeConstraintsSection(task) + fullPrompt,
      agent_id: task.agent_id,
      harness,
      system_prompt: systemPrompt,
      model_id: modelId,
      effort: turnEffort,
      agent_session_id: canResume ? agentSessionId! : undefined,
      ...(lowHighLoop ? { low_high_loop: { review_effort: lowHighLoop.reviewEffort } } : {}),
      // The wrap-up plan rides every work command: finality is declared DURING
      // the turn, after this write, so it cannot be sent later (§3.3).
      ...(await resolveWrapUpCommandFields({
        storage,
        task,
        sessionId: sess.id,
        session: sess,
        projectRoot,
        worktreePath,
        config,
      })),
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, unblockCommand);

    // Generate daemon MCP config
    let daemonConfigPath: string | null = null;
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Launch or reuse supervisor
    const mustRecreateForAgent = mustRecreateForContainerAgent(sess, task.agent_id);
    if (mustRecreateForAgent) {
      phases.note(
        `recreating container: agent changed ` +
        `(${sess.container_agent_id} → ${task.agent_id}) — launch env is fixed at create time`,
      );
    }
    if (!mustRecreateContainer && !mustRecreateForAgent && (await runner.isRunning(containerName))) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
      phases.note(`reusing running container ${containerName}`);
    } else {
      await removeTaskRun(runner, storage, sess, containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, task.id, pinnedCustomImage(task), phases.notify);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', actor);
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }

    phases.end(containerName);

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName, task.agent_id);
    sess.container_agent_id = task.agent_id;

    // BUG FIX: these resets used to run unconditionally on every resume, which let an
    // autonomous builder/agent resume launder away its own budgets every turn. Only a
    // human taking over clears them; a builder/agent turn instead increments the new
    // turn-budget counter checked above.
    if (actorRole(actor) === 'human') {
      // Manual resume resets the circuit breaker
      await storage.resetConsecutiveInterruptions(sess.id);

      // Manual resume resets auto-react counters (human is taking over)
      try {
        await resetAutoReactCounters(storage, task.id);
      } catch {
        // Non-critical
      }

      try {
        await resetNonHumanTurnCount(storage, task.id);
      } catch {
        // Non-critical
      }
    } else {
      try {
        await incrementNonHumanTurnCount(storage, task.id);
      } catch {
        // Counter increment is best-effort — task resume must proceed even if budget tracking fails
      }
    }

    // Update last interaction timestamp
    await storage.updateSessionInteraction(sess.id, 0);

    return {
      sessionId: sess.id,
      containerName,
      worktreePath,
      branchName: sess.git_branch,
      runnerType: runner.type,
      runnerLabel: runner.runLabel,
      runnerDisplayName: runner.runDisplayName(containerName),
      warnings,
    };
  } finally {
    await removeLock(worktreePath);
  }
}

// =====================================================================
// Stop Task
// =====================================================================

export interface StopTaskParams {
  taskId: string;
  reason: string;
  /** Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: ActorInput;
  /** Phase-narration sink (see ./progress.ts). CLI and the web dialog both consume it. */
  onProgress?: ProgressEmitter;
}

export interface StopTaskResult {
  taskId: string;
  displayId: string;
  reason: string;
  /**
   * WHICH ENDING THIS STOP TOOK — the two are not interchangeable, and only the
   * daemon knows which one ran.
   *
   * `task`: the work turn was halted, the task is `blocked`, the user-stopped
   * gate is set and an unblock is needed to continue. `claim`: an ask or review
   * was shown out; the status it found is restored, no gate is set, and the
   * task needs nothing to be usable.
   *
   * Sent as the ANSWER rather than left for a client to re-derive: the CLI used
   * to pick its message from its own pre-flight snapshot, taken before a
   * possibly long reason prompt, so a claim that settled in that window had it
   * announcing "the task itself was not stopped" about a task it had just
   * stopped with auto-resume disabled.
   */
  ended: 'task' | 'claim';
}

/**
 * Halt a running task without auto-resume.
 *
 * Save first, act second: the user_stopped gate and human turn are persisted
 * BEFORE stopping the supervisor. If we crash mid-way, the reconciler will
 * not auto-resume because the gate is already set.
 */
export async function stopTask(
  projectRoot: string,
  params: StopTaskParams,
): Promise<StopTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'stop');
  try {
    return await stopTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function stopTaskRun(
  projectRoot: string,
  params: StopTaskParams,
  phases: PhaseReporter,
): Promise<StopTaskResult> {
  if (!params.reason || !params.reason.trim()) {
    throw new RpcError(400, 'reason is required');
  }
  const reason = params.reason.trim();

  const storage = await getOrCreateStorage();
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  phases.begin(STOP_PHASES.preflight);

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  // ROUTE BY THE IN-FLIGHT CLAIM, not by the session — and BEFORE the status
  // gate below. See {@link stoppableClaimOf} for why the claim outranks it.
  const stoppableClaim = stoppableClaimOf(task);

  if (task.status !== 'working' && !stoppableClaim) {
    throw new RpcError(
      409,
      `Task ${displayId(task)} is ${task.status}, not working. ` +
      `Only running tasks can be stopped. ` +
      `To close a task that is not running, use \`lazy close\`.`,
    );
  }

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session.`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session already ended (${sess.outcome ?? 'ended'}).`);
  }

  if (stoppableClaim) {
    return stopClaimedTurn(projectRoot, storage, task, stoppableClaim, reason, actor, phases);
  }

  phases.announce(stopPhasePlan(), displayId(task));
  phases.end();

  // SAVE FIRST: persist the user's intent before halting the runner.
  phases.begin(STOP_PHASES.record);
  const turnSeq = await storage.getNextTurnSequence(sess.id);
  await storage.createTurn({
    sessionId: sess.id,
    sequence: turnSeq,
    role: 'human',
    content: `[built-in] Stopped by user: ${reason}`,
    // Channel actor: MCP-originated stop is 'builder', CLI 'human'.
    actor,
  });
  await storage.setUserStopped(sess.id, true);
  phases.end();

  // Now halt the supervisor and transition. Monitor on the session's recorded
  // runner (fallback: global config) so a host task isn't missed by a
  // docker-configured stop, and vice versa.
  phases.begin(STOP_PHASES.halt);
  const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
  const containerName = sess.container_name ?? runner.runNameForTask(taskRef(task));
  await runner.stopRun(containerName);

  // INVARIANT: lazy stop writes an ErrorResponse to response.json uniformly
  // regardless of command_type. This unblocks any in-flight daemon RPC waiting
  // on response.json (e.g. launchAskTask polling for an ask answer) — its poll
  // wakes within its interval and returns a clean RPC error to the caller
  // instead of hitting the long ask/turn timeout. For work/sync turns nobody
  // is waiting on response.json, so the file is just there for posterity.
  //
  // Ordering: the write happens AFTER stopRun so the supervisor's death cannot
  // race our write. A dying supervisor may also attempt a response.json write
  // from its catch blocks; our post-kill write is authoritative and overwrites
  // any partial state — correct, because "human stopped me" is truer than
  // whatever the dying supervisor saw.
  const protoDir = getProtocolDir(task.id);
  const stopResponse: ErrorResponse = {
    status: 'error',
    error: `Stopped by user: ${reason}`,
    phase: 'work',
  };
  try {
    writeResponse(protoDir, stopResponse);
  } catch (err) {
    // The write itself failing is unexpected (atomic temp+rename to a dir we
    // own). Log loudly but don't fail the stop — the supervisor is already
    // dead; the task transition below is the load-bearing effect.
    logger.warn(`[stop] failed to write ErrorResponse to ${protoDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  phases.end();

  // Unify with `lazy unblock`: stopped tasks become 'blocked' (with
  // user_stopped=true), not 'interrupted'. The `[STOPPED]` chip and the
  // reconciler's auto-resume guard both key on user_stopped, not status —
  // see shouldSkipAutoResumeForUserStop in src/utils/reconcile.ts.
  // 'interrupted' is reserved for ungraceful interruptions (crash, watchdog
  // kill, supervisor died) which should auto-resume.
  //
  // Parks as `conflict` when the task still owes a decision on file-permission
  // violations: a stop must not clear the label the pending set earns (see
  // src/utils/paused-status.ts).
  phases.begin(STOP_PHASES.finalize);
  await parkTaskPaused(storage, task.id, actor, { sessionId: sess.id, projectRoot });
  await storage.recordInterrupt(sess.id, {
    reason: `Stopped by user: ${reason}`,
    exit_code: null,
    logs: null,
  });
  await storage.updateSessionContainerName(sess.id, null);

  try {
    await runner.removeRun(containerName);
  } catch {
    // Best-effort — the reconciler also sweeps orphaned runs.
  }
  try {
    clearStatus(protoDir);
  } catch {
    // Best-effort — protocol files are not user-visible.
  }

  phases.end();
  return {
    taskId: task.id,
    displayId: displayId(task),
    reason,
    ended: 'task',
  };
}


/**
 * Stop an in-flight ask or review — the claim-routed half of `lazy stop`.
 *
 * Symmetric with {@link abandonDeadClaimedTurn}, which handles the same ending
 * arriving on its own rather than being asked for: kill the run the CLAIM
 * names, record the stop as the answering turn at the reserved sequence (so any
 * waiter returns immediately instead of polling a turn that will never come),
 * restore the status the turn found, release the claim and drop the mailbox.
 *
 * Deliberately NOT the ordinary stop path's ending. That path parks the task
 * with `user_stopped` set, which suppresses auto-resume for the IMPLEMENTER —
 * wrong here, because nothing of the implementer's was running. An ask and a
 * review are both read-only visitors: stopping one must leave the task exactly
 * as they found it.
 */
async function stopClaimedTurn(
  projectRoot: string,
  storage: Storage,
  task: Task,
  record: InFlightTurn,
  reason: string,
  actor: ActorInput,
  phases: PhaseReporter,
): Promise<StopTaskResult> {
  const label = record.owner === 'review' ? 'Review' : 'Ask';
  phases.announce(stopPhasePlan(), displayId(task));
  phases.end();

  // SAVE FIRST (CLAUDE.md): the operator's reason is persisted before anything
  // that can fail. It lands at the RESERVED sequence — this IS the turn's
  // ending, not a note beside it.
  phases.begin(STOP_PHASES.record);
  try {
    const turns = await storage.getSessionTurns(record.session_id);
    if (!turns.some((t) => t.sequence === record.turn_sequence)) {
      // THIS ROW RECORDS THE STOP, so it names the person who STOPPED it —
      // `actor`, exactly as the caller supplied it, with no owner applied.
      //
      // It sits at the stopped turn's reserved sequence and ends that turn, so
      // it is tempting to attribute it to whoever asked for the turn (the
      // claim's owner, as `abandonDeadClaimedTurn` correctly does). But its
      // CONTENT is "Stopped by user: <reason>" — a human act, performed by
      // someone who may not be the person whose turn it ends. Naming the claim
      // owner there says ivan stopped something pete stopped, on an
      // append-only row. The claim owner belongs on the settled turn's own
      // attribution and usage, not on this.
      await createRecoveredAgentTurn(storage, {
        sessionId: record.session_id,
        sequence: record.turn_sequence,
        role: 'agent',
        content:
          `[${label} stopped]\n\n` +
          `Stopped by user: ${reason}\n\n` +
          `Status restored to '${record.restore_status}'. Anything the ` +
          `${record.owner === 'review' ? 'reviewer' : 'agent'} already filed (Raises, comments) is kept.`,
        turnType: record.turn_type,
        actor,
      }, null);
    }
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: failed to record the stopped ${record.owner} turn: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  phases.end();

  // Halt the run the CLAIM names. For a review that is its ephemeral container;
  // for an ask it is the work container the agent's session was resumed in.
  phases.begin(STOP_PHASES.halt);
  const runName = record.run_name;
  if (runName) {
    try {
      const runner = await createRunner(projectRoot, record.runner_type ?? undefined);
      if (await runner.isRunning(runName)) await runner.stopRun(runName);
      if (await runner.runExists(runName)) await runner.removeRun(runName);
      // An ASK runs in the work container, so the session's stamp now points at
      // a run that no longer exists. A review's run was never stamped there, so
      // there is nothing to clear (and clearing would erase the implementer's).
      if (record.owner === 'ask') {
        const sess = await storage.getSessionByTaskId(task.id);
        if (sess?.container_name === runName) {
          await storage.updateSessionContainerName(sess.id, null);
        }
      }
    } catch (err) {
      logger.warn(
        `Task ${displayId(task)}: failed to stop ${record.owner} run ${runName}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    // No run stamped: the claim was made but the launch had not returned yet.
    // The status restore and claim release below are still the right ending —
    // a launch that does come up finds its claim gone and its response foreign.
    logger.warn(
      `Task ${displayId(task)}: stopping a ${record.owner} turn that had not recorded a run yet.`,
    );
  }
  phases.end();

  phases.begin(STOP_PHASES.finalize);
  try {
    const current = await storage.getTask(task.id);
    if (current?.status === 'working') {
      await storage.updateTaskStatus(task.id, record.restore_status, actor);
    }
  } catch (err) {
    logger.warn(
      `Task ${displayId(task)}: failed to restore status '${record.restore_status}' after ` +
      `stopping the ${record.owner} turn: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await releaseAsyncClaim(storage, task.id, record);
  // An ask shares the work mailbox, so a late response has to be cleared out of
  // it — otherwise the reconciler flushes the stopped agent's answer as if it
  // were an ordinary work turn. (A review's whole mailbox was just removed.)
  if (record.owner === 'ask') {
    try {
      const protoDir = getProtocolDir(task.id);
      consumeResponse(protoDir);
      clearStatus(protoDir);
    } catch (err) {
      logger.warn(
        `Task ${displayId(task)}: failed to clear the ask mailbox after stopping: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  phases.end();

  return { taskId: task.id, displayId: displayId(task), reason, ended: 'claim' };
}
