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
import type { ResolvedConfig } from '../config/types';
import { resolveAgentModel } from '../utils/role-target';
import { resolveAgentChattiness, renderChattinessSnippet } from '../config/chattiness';
import { pathExists } from '../utils/fs';
import { createRunner } from '../runner';
import { stampSessionRunner } from '../runner/session-launch';
import { createDriver, LocalDriver, type MergeResult } from '../remote';
import {
  PhaseReporter,
  ACCEPT_PHASES,
  acceptPhasePlan,
  acceptReentryPhasePlan,
  type ProgressEmitter,
} from './progress';
import { regenerateFidelity } from '../synthesis/fidelity';
import { getSummarizer } from '../synthesis/summarizer';
import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { resolveAndPersistEffort } from './effort';
import { getAgent } from '../agent/registry';
import { readWorktreeMergeState, isMidMerge, describeMergeState } from '../git/operations';
import { hasUncommittedChanges, applyPatch, hasUpstreamChanges, getRemoteDefaultBranch, recoverMissingWorktreeWithFetch, createAcceptTag, getNewCommits, getMergeBase } from '../git/operations';
import { renderPreAcceptPrompt } from '../supervisor/pre-accept';
import type { DestinationRestoreConflict } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { checkPairingLock } from '../utils/pairing-lock';
import { protocolDir as getProtocolDir, writeCommand, writeResponse, consumeCommand, ensureProtocolDir, commonCommandFields, removeProtocolDir, waitForResponse, consumeResponse, clearStatus, completedResponses } from '../protocol';
import { shortId, displayId, displayIdFor, taskRef, getWorktreePath, getWorktreePathForRef, getBranchName, getBranchNameFromId } from '../cli/helpers';
import { buildNotesContext, buildSystemPrompt, buildPromptWithInstructions, buildTurnHistoryContext, getNewNotesSince, runSyncWithRemote, cleanupWorktree, cleanupWorktreeAndBranch, cleanupTaskContainer } from '../cli/commands/shared';
import { checkOrphanedChild, retargetOrphanedChild, getActiveChildren, reparentChildren, formatReparentWarning } from '../cli/orphan';
import { resetAutoReactCounters } from './auto-react-budget';
import {
  enforceEdgeGate,
  EdgeGateRefusedError,
  recordHumanApproval,
  peekHumanApproval,
  takeHumanApproval,
  type EdgeGateClearance,
} from '../protection/edge-gate';
import { enforceResurrectionGuard, ResurrectionRefusedError, stackedChildAdvisory } from '../protection/resurrection-guard';
import { enforceLfsGuard, LfsPointerRefusedError } from '../protection/lfs-guard';
import { createHumanTokenVerifier } from '../protection/verify-token';
import { isFeatureEnabled } from '../utils/features';
import { isTerminalStatus, isActiveStatus, isBlockedStatus } from '../types';
import { parentTaskIdOf, targetBranchOf, taskTarget, branchTarget } from '../task-target';
import { logger } from '../utils/logger';
import { getActor } from '../constants';
import { writeDaemonMcpConfig } from './task-launcher';
import { revokeTaskMcpTokens } from './mcp-tokens';
import { setupSandbox } from '../utils/sandbox';
import { hasDaemonContext } from './context';
import { runGit } from '../utils/git';
import { validateBranchInSyncWithRemote } from '../utils/git';
import { latestViolationTurn, findStickyModel, launchSettingsFromResponse } from '../utils/turns';
import { findPendingFeedback, buildFeedbackRedeliveryPrompt } from '../utils/feedback-redelivery';
import { isOfflineMode } from '../utils/offline';
import { readdir, readFile } from 'fs/promises';

import type { StartCommand, UnblockCommand, SyncCommand, AskCommand, PreAcceptCommand, CompletedResponse, ErrorResponse } from '../protocol';
import { PROTOCOL_VERSION } from '../protocol/types';
import type { FileViolation, Task, TokenUsage, Session, TaskStatus, Actor } from '../types';
import { toTurnUsage, rollUpSessionUsage } from '../utils/usage-recording';
import type { Storage } from '../storage';
import { sanitizeUserText } from '../utils/sanitize-text';
import { isWatchdogKill, watchdogTurnLines, WATCHDOG_TURN_HEADING } from '../utils/watchdog-turn';
import { buildMemorySection } from '../memory';

import lazyToolInstructions from '../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../prompts/goal-context-resume.md' with { type: 'text' };
import violationRevertNoticeText from '../prompts/violation-revert-notice.md' with { type: 'text' };

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
    throw new RpcError(
      409,
      `Task ${displayTaskId} has an unresolved merge in its worktree (${describeMergeState(mergeState)}). ` +
      `A sync did not finish. Run \`lazy sync ${displayTaskId}\` to complete it, ` +
      `then re-run ${commandName}.`,
    );
  }

  if (await hasUncommittedChanges(worktreePath)) {
    throw new RpcError(409, `Task ${displayTaskId} has uncommitted changes. Commit or stash changes before running ${commandName}.`);
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
  actor: Actor = getActor(),
): Promise<{ branch: string; warnings: string[] }> {
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
    let branch = (stored && !stored.startsWith('lazy/')) ? stored : '';
    if (!branch) {
      const cfg = await loadConfig(projectRoot);
      branch = await getRemoteDefaultBranch(projectRoot, cfg.remote.git_remote);
      if (stored) {
        await storage.updateTaskTarget(task.id, branchTarget(branch));
        warnings.push(`Corrected stale target branch from ${stored} to ${branch}.`);
      }
    }
    return { branch, warnings };
  }

  // Check if the direct parent is still alive
  const parentTask = await storage.getTask(directParentId);
  if (parentTask && !isTerminalStatus(parentTask.status)) {
    // Parent is alive — use its branch directly
    return {
      branch: await getBranchNameFromId(directParentId, storage),
      warnings,
    };
  }

  // Parent is terminal (or missing) — walk up to find a living ancestor
  let currentParentId: string | null = directParentId;
  const staleAncestors: string[] = [];

  while (currentParentId) {
    const ancestor = await storage.getTask(currentParentId);
    if (!ancestor) {
      // Ancestor not found — stop walking
      staleAncestors.push(currentParentId.substring(0, 8));
      break;
    }

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
        `[Re-parented] Stale parent chain detected during sync. Re-parented from ${staleList} to ${ancestorDisplay}.`,
        actor,
      );

      return {
        branch: await getBranchNameFromId(ancestor.id, storage),
        warnings,
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
    `[Re-parented] Stale parent chain detected during sync. All ancestors terminal (${staleList}). Re-parented to top-level, targeting ${fallbackBranch}.`,
    actor,
  );

  return {
    branch: fallbackBranch,
    warnings,
  };
}

// =====================================================================
// Unblock Task
// =====================================================================

export interface UnblockTaskParams {
  taskId: string;
  message: string;
  modelOverride?: string;
  approvedFiles?: string[];
  /** CLI already confirmed orphan retargeting */
  retargetOrphan?: boolean;
  /** Whether notes were already shown in editor (skip re-injection) */
  notesInEditor?: boolean;
  /** CLI `--effort` override. Persists on the task so future turns use same value. */
  effortOverride?: string;
  /**
   * Agent permission mode for this turn. When 'plan', the agent is launched
   * read-only (Q&A against the session). Used by `lazy review -i` ask path.
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
  actor?: Actor;
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
}


export async function launchUnblockTask(
  projectRoot: string,
  params: UnblockTaskParams,
): Promise<UnblockTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask. Every actor-attributed write in this path
  // (the feedback turn, the status transitions, the escape-hatch comment) uses
  // the SAME value, so a reader never sees one command attributed two ways.
  const actor = params.actor ?? getActor();

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
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }

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

  // Merging → blocked escape hatch
  if (task.status === 'merging') {
    await storage.updateTaskStatus(task.id, 'blocked', actor);
    await storage.createComment(task.id, 'Task unblocked from merging state (manual escape hatch).', actor);
    task = (await storage.getTask(task.id))!;
    warnings.push('Task was in merging state. Moved back to blocked.');
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Runner pre-flight (honor per-task runner override) ---
  const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
  // Set agent on runner so auth uses the correct agent (not hardcoded ClaudeCodeAgent)
  if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
    (runner as any).setAgent(getAgent(task.agent_id));
  }
  await runner.checkAvailability();

  // --- Orphan detection/retargeting ---
  if (parentTaskIdOf(task)) {
    const orphanStatus = await checkOrphanedChild(task, storage, projectRoot);
    if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
      if (params.retargetOrphan) {
        await retargetOrphanedChild(task, storage, orphanStatus.retargetBranch);
        task = (await storage.getTask(task.id))!;
        warnings.push(`Retargeted to ${orphanStatus.retargetBranch}.`);
      } else {
        throw new RpcError(409, `Parent task was accepted and its branch deleted. Task needs retargeting to ${orphanStatus.retargetBranch}. Pass retargetOrphan=true to confirm.`);
      }
    }
  }

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

  // --- Launch feedback turn ---
  const tRef = taskRef(task);
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);

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

  const sandbox = await setupSandbox(worktreePath);

  try {
    // Restore snapshot if exists
    const snapshot = await storage.getLatestWorktreeSnapshot(sess.id);
    if (snapshot && !await hasUncommittedChanges(worktreePath)) {
      let patch = snapshot.uncommitted_diff;
      patch = patch.replace(/^--- STAGED CHANGES ---\n/gm, '');
      patch = patch.replace(/^--- UNSTAGED CHANGES ---\n/gm, '');

      if (await applyPatch(patch, worktreePath)) {
        warnings.push('Restored uncommitted changes from backup.');
      } else {
        warnings.push('Could not restore uncommitted changes from backup. Continuing without them.');
      }
    }

    // --- Revert rejected file violations (conflict tasks) ---
    let violationRevertInfo: string | undefined;
    // INTAKE BOUNDARY: escape non-printable control characters before this text
    // is persisted or built into a prompt. A raw NUL here becomes argv[2] of
    // `claude -p` and kills the spawn instantly, crash-looping the turn and
    // losing the feedback. Sanitize-and-deliver, never reject — see
    // src/utils/sanitize-text.ts.
    let message = sanitizeUserText(params.message);

    if (task.status === 'conflict') {
      const existingTurns = await storage.getSessionTurns(sess.id);
      // The FINAL violation set lives on the push-back turn (the last invocation
      // that re-detected them), NOT the work turn — use latestViolationTurn so the
      // reviewer resolves exactly what the agent left unresolved.
      const latestAgentTurn = latestViolationTurn(existingTurns);

      if (latestAgentTurn?.violations?.length) {
        const violations = latestAgentTurn.violations;
        const approvedSet = new Set(params.approvedFiles ?? []);

        const updatedViolations: FileViolation[] = violations.map(v => ({
          ...v,
          status: approvedSet.has(v.file) ? 'approved' as const : 'rejected' as const,
        }));

        const rejectedFiles = updatedViolations.filter(v => v.status === 'rejected');
        const approvedViolations = updatedViolations.filter(v => v.status === 'approved');

        if (rejectedFiles.length > 0) {
          for (const v of rejectedFiles) {
            const gitResult = await runGit(['checkout', v.base_sha, '--', v.file], { cwd: worktreePath });
            if (gitResult.exitCode !== 0) {
              throw new RpcError(500, `Failed to revert protected file ${v.file} to ${v.base_sha}: ${gitResult.stderr}`);
            }
          }

          const revertedPaths = rejectedFiles.map(v => v.file);
          await runGit(['add', ...revertedPaths], { cwd: worktreePath });
          await runGit(['commit', '-m', 'Revert protected file changes (rejected by reviewer)'], { cwd: worktreePath });
          warnings.push(`Reverted ${revertedPaths.length} protected file(s): ${revertedPaths.join(', ')}`);
        }

        if (approvedViolations.length > 0) {
          warnings.push(`Approved ${approvedViolations.length} protected file change(s): ${approvedViolations.map(v => v.file).join(', ')}`);
        }

        await storage.updateTurnViolations(task.id, latestAgentTurn.id, updatedViolations);

        // Build context for the agent prompt
        const revertedList = rejectedFiles.map(v => v.file);
        const approvedList = approvedViolations.map(v => v.file);
        const parts: string[] = [];
        if (revertedList.length > 0) {
          // WORDING IS LOAD-BEARING (fix-violation-turn-detection) — see
          // src/prompts/violation-revert-notice.md. The old text was an absolute
          // "do NOT modify them again", which covers only the common case: a
          // revert can leave the tree incoherent (e.g. restoring tests for code
          // the task deleted), and then a literal agent ships the breakage rather
          // than say so. The escape hatch is REPORT AND STOP, not re-apply — an
          // agent that re-applies unilaterally starts a revert ping-pong with the
          // reviewer. Re-approval is the reviewer's move: they re-unblock with
          // the files in --approve-file / approved_files.
          parts.push(
            violationRevertNoticeText
              .trim()
              .replace('{{files}}', revertedList.map(f => `  - ${f}`).join('\n'))
          );
        }
        if (approvedList.length > 0) {
          parts.push(`The following protected file changes were APPROVED by the reviewer:\n${approvedList.map(f => `  - ${f}`).join('\n')}`);
        }
        if (parts.length > 0) {
          violationRevertInfo = parts.join('\n\n');
        }
      }
    }

    // Load config from the worktree
    const config = await loadConfig(projectRoot, { cwd: worktreePath });

    // Determine model: CLI flag > previous turn's model (sticky) > task.model > config default
    let stickyModel: string | undefined;
    if (!params.modelOverride) {
      stickyModel = findStickyModel(await storage.getSessionTurns(sess.id));
    }
    // Per-role model resolution: a local backend (ollama/proxy) forces its
    // authoritative model; otherwise CLI flag > sticky > task.model > default.
    const modelName = resolveAgentModel(config, {
      preferredModel: params.modelOverride ?? stickyModel ?? task.model,
      agentId: task.agent_id,
    });
    const modelId = modelName;

    // An explicit --model override is a durable choice — persist it even when
    // task.model is already set, so auto-resume/auto-deliver (which read
    // task.model) relaunch on the new model. Without an override, only fill
    // an empty task.model (a plain unblock must not clobber the existing one).
    if (params.modelOverride || !task.model) {
      await storage.updateTaskModel(task.id, modelName);
      task.model = modelName;
    }

    const effortValue = await resolveAndPersistEffort(task, params.effortOverride, config.agent.effort, storage);

    // Determine parent branch (with stale-parent fallback)
    const parentResolution = await resolveParentBranchWithFallback(task, storage, projectRoot, actor);
    const parentBranch = parentResolution.branch;
    if (parentResolution.warnings.length > 0) {
      warnings.push(...parentResolution.warnings);
    }

    // Parent branch is still passed to the supervisor for context (protected
    // patterns, post-turn sync, etc.) but unblock no longer triggers merge.
    // Use `lazy sync <task>` for upstream merge as a separate operation.

    // Build turn history for fresh sessions (no Claude session to resume)
    let turnHistory: string | undefined;
    if (!canResume) {
      const turns = await storage.getSessionTurns(sess.id);
      if (turns.length > 0) {
        turnHistory = buildTurnHistoryContext(turns);
      }
    }

    // Fetch notes
    let notesCtx: string | undefined;
    if (!params.notesInEditor) {
      const allNotes = await storage.getTaskComments(task.id);
      if (allNotes.length > 0) {
        const turns = await storage.getSessionTurns(sess.id);
        const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
        const newNotes = lastAgentTurn
          ? getNewNotesSince(allNotes, lastAgentTurn.timestamp)
          : allNotes;
        if (newNotes.length > 0) {
          notesCtx = buildNotesContext(newNotes);
        }
      }
    }

    // Sync with remote
    const syncResult = await runSyncWithRemote(task, sess, projectRoot, storage, worktreePath);
    const remoteCommentsCtx = syncResult.remoteCommentsCtx;

    // Prepend violation revert info
    if (violationRevertInfo) {
      message = `## Protected File Resolution\n\n${violationRevertInfo}\n\n---\n\n${message}`;
    }

    // Build prompts
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }));
    const fullMessage = buildPromptWithInstructions(message.trim(), task.goal, projectRoot, turnHistory, notesCtx, remoteCommentsCtx);

    // --- Persist state BEFORE launching container ---
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: message.trim(),
      model: modelName,
      effort: effortValue,
      prompt: fullMessage,
      // Channel actor: MCP-relayed feedback is 'builder' even when it carries a
      // human's words — the actor records who submitted (the channel), not who
      // authored the content. Falls back to getActor() for CLI. See MCP_ACTOR.
      actor,
      // INVARIANT: this turn IS the human's feedback. If the work phase crashes
      // before the agent consumes it, resume must re-deliver it verbatim.
      carriesFeedback: true,
    });

    // Transition to working. Unblock is only semantically valid from these
    // four statuses; other live statuses are handled above (working/pairing/
    // merging) or caught by the ended_at check (terminal). A `backlog` task
    // is "never started" — the right command is `lazy start`, not unblock.
    // The transition itself is validated against the canonical table in
    // src/task-state-machine.ts inside storage.updateTaskStatus.
    if (task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted' || task.status === 'interrupted') {
      await storage.updateTaskStatus(task.id, 'working', actor);
    }

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
      system_prompt: systemPrompt,
      model_id: modelId,
      effort: effortValue,
      agent_session_id: canResume ? sess.agent_session_id! : undefined,
      parent_branch: parentBranch ?? undefined,
      sync_before_work: false,
      sync_after_work: autoSyncAfterTurn,
      remote_branch: syncResult.remoteBranch,
      permission_mode: params.permissionMode,
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, unblockCommand);

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
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', actor);
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName);
    await storage.updateSessionInteraction(sess.id, 0);

    const turnNumber = Math.floor(nextSeq / 2) + 1;

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
  message: string;
  effortOverride?: string;
  /** Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: Actor;
}

export interface AskTaskResult {
  sessionId: string;
  turnNumber: number;
  answer: string;
  usage?: TokenUsage;
  warnings: string[];
  /**
   * Latency breakdown (ms) for LAZY_VERBOSE telemetry. Populated even if the
   * supervisor didn't report agent_duration_ms (agent_ms will be undefined).
   *
   *   daemon_ms:  wall-clock of the daemon handler (entry → return)
   *   wait_ms:    time between writeCommand and waitForResponse returning
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

/**
 * Max wall-clock a reviewer waits for an ask turn to complete before the
 * daemon gives up and returns 504. Sized generously because the agent may
 * spend a minute chewing on a question before producing an answer.
 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Launch a read-only "ask turn" against an existing agent session and
 * return the agent's answer synchronously.
 *
 * Unlike unblock, an ask:
 *   - Always runs in plan mode (read-only, no writes, no commits).
 *   - Skips all integration machinery: no upstream sync, no pre/post-turn
 *     merge, no violation detection, no post-turn check.
 *   - Rejects with 409 unless the task is 'blocked' or 'conflict' (an ask only
 *     makes sense against a paused, reviewable task; 'conflict' is a blocked
 *     variant). The pre-ask status is restored when the ask completes, so a
 *     read-only ask never mutates task state.
 *   - Is daemon-owned end-to-end: the daemon waits for response.json, processes
 *     it, and returns the answer in the RPC result — so the CLI doesn't poll
 *     and can't race the reconciler.
 */
export async function launchAskTask(
  projectRoot: string,
  params: AskTaskParams,
): Promise<AskTaskResult> {
  const daemonStart = Date.now();
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  // --- Resolve task ---
  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }
  if (!sess.agent_session_id) {
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
  const askableStatus = task.status === 'blocked' || task.status === 'conflict';
  if (!askableStatus) {
    throw new RpcError(409,
      `Task ${displayId(task)} is '${task.status}', not 'blocked' or 'conflict'. ` +
      `Review questions only run while the task is paused (blocked/conflict) — the agent may have picked up autonomous work. Retry once it's paused again.`,
    );
  }
  // Preserve the pre-ask status so a read-only ask never mutates task state.
  const statusBeforeAsk = task.status;

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
  await acquireLock(worktreePath, 'lazy ask');

  try {
    // --- Model + effort resolution ---
    const config = await loadConfig(projectRoot, { cwd: worktreePath });

    const stickyModel = findStickyModel(await storage.getSessionTurns(sess.id));
    const modelName = resolveAgentModel(config, {
      preferredModel: stickyModel ?? task.model,
      agentId: task.agent_id,
    });
    const effortValue = await resolveAndPersistEffort(task, params.effortOverride, config.agent.effort, storage);

    // --- Build prompts ---
    // Asks always resume a live agent session, so no turn-history injection
    // is needed — the agent already has all prior context in its context window.
    // Notes are also skipped: an ask is a single reviewer question, not a
    // feedback delivery channel.
    const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
    if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
      (runner as any).setAgent(getAgent(task.agent_id));
    }
    await runner.checkAvailability();
    // Bridge/stamp the resolved runner onto the session before launch.
    await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }));
    const askMessage = sanitizeUserText(params.message); // INTAKE BOUNDARY — see handleUnblockTask
    const fullMessage = buildPromptWithInstructions(askMessage.trim(), task.goal, projectRoot);

    // --- Record the human turn BEFORE launching ---
    // INVARIANT (CLAUDE.md): human feedback must be durably saved before any
    // operation that might fail can discard it. For an ask, the question is
    // the feedback.
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: askMessage.trim(),
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

    // --- Transition blocked → working ---
    await storage.updateTaskStatus(task.id, 'working', actor);

    // --- Dispatch ask command to supervisor ---
    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    const askCommand: AskCommand = {
      type: 'ask',
      task_id: task.id,
      goal: task.goal,
      prompt: fullMessage,
      agent_id: task.agent_id,
      system_prompt: systemPrompt,
      model_id: modelName,
      effort: effortValue,
      agent_session_id: sess.agent_session_id,
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, askCommand);

    // --- Launch or reuse supervisor ---
    const containerName = runner.runNameForTask(tRef);
    const sandbox = await setupSandbox(worktreePath);

    let daemonConfigPath: string | null = null;
    // Skip when running outside the daemon (in-process RPC fallback) — there is
    // no daemon for the container to connect to, and getDaemonContext() throws.
    // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the ask command
    } else {
      await runner.removeRun(containerName);
      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', actor);
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }
    await storage.updateSessionContainerName(sess.id, containerName);

    // --- Wait synchronously for the supervisor's response ---
    const waitStart = Date.now();
    const response = await waitForResponse(protoDir, 500, ASK_TIMEOUT_MS);
    const waitMs = Date.now() - waitStart;
    if (!response) {
      // Timeout — leave the supervisor alone (it may still finish later and
      // be picked up by the reconciler); we just can't hand an answer back.
      throw new RpcError(504, `Ask timed out after ${Math.floor(ASK_TIMEOUT_MS / 1000)}s.`);
    }

    if (response.status === 'error') {
      await recordAskErrorTurn(storage, task.id, sess.id, response, protoDir);
      throw new RpcError(500, `Ask failed: ${response.error}`);
    }

    // An ask is always a single-invocation, read-only turn — never a bundle.
    // Normalize defensively to the primary response.
    const completed = completedResponses(response)[0];

    // --- Completed: record agent turn, restore the pre-ask status ---
    // An ask is read-only, so it must leave the task exactly as it found it
    // (e.g. a 'conflict' task stays 'conflict', not silently demoted to
    // 'blocked').
    const turnNumber = await recordAskCompletedTurn(storage, sess, completed, protoDir);
    await storage.updateTaskStatus(task.id, statusBeforeAsk, 'system');

    return {
      sessionId: sess.id,
      turnNumber,
      answer: completed.result,
      usage: completed.usage
        ? {
            inputTokens: completed.usage.input_tokens ?? 0,
            outputTokens: completed.usage.output_tokens ?? 0,
            cacheCreationTokens: completed.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: completed.usage.cache_read_input_tokens ?? 0,
          }
        : undefined,
      warnings,
      timings: {
        daemon_ms: Date.now() - daemonStart,
        wait_ms: waitMs,
        agent_ms: completed.agent_duration_ms,
      },
    };
  } finally {
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
    agentTurnSeq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({
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
    const seq = await storage.getNextTurnSequence(sessionId);
    // Tokens the ask had already spent before it died, salvaged by the
    // supervisor (src/supervisor/usage.ts). A crashed ask used to record none.
    const errorUsage = toTurnUsage(response.usage);
    await storage.createTurn({
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

// =====================================================================
// Pre-accept turn — accept-time validation ([automation.pre_accept])
// =====================================================================

/** Heading prefixed to the pre-accept agent turn so reviewers can identify it. */
const PRE_ACCEPT_HEADING = '## Pre-accept validation';

/**
 * Prefix of the warning emitted when the pre-accept step is configured but has
 * nothing to run against. Shared so the accept path can recognise it and report
 * the phase as SKIPPED rather than as having passed.
 */
const PRE_ACCEPT_SKIP_PREFIX = 'Pre-accept step skipped';

/**
 * Margin between the agent's own no-progress watchdog and the daemon's wait for
 * the pre-accept turn.
 *
 * DEADLINE ORDERING (deliberate, do not collapse): three independent clocks run
 * over a pre-accept turn —
 *   1. the supervisor's no-progress watchdog (`agent.watchdog_output_timeout_ms`),
 *   2. this wait for the turn's response,
 *   3. the calling MCP client's own stdio idle budget.
 * They measure different things, and if a turn goes quiet without dying, whichever
 * fires FIRST writes the story the human reads. The watchdog is the one that can
 * say something useful ("the agent stopped producing output"), so it must fire
 * first; this wait is a backstop for the case where the watchdog itself is wedged.
 * The client budget is kept fed by the heartbeat envelope (see daemon/heartbeat.ts),
 * so it comes last. Hence: watchdog < pre-accept wait < client budget.
 */
const PRE_ACCEPT_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;

/**
 * Max wall-clock the daemon waits for the whole pre-accept turn (agent work +
 * the gate re-run). Derived from the configured watchdog so the ordering above
 * holds for ANY watchdog setting, not just the default. On timeout the task
 * returns to its pre-accept status and the accept aborts.
 */
function preAcceptTimeoutMs(config: ResolvedConfig): number {
  return config.agent.watchdog_output_timeout_ms + PRE_ACCEPT_TIMEOUT_MARGIN_MS;
}

export interface PreAcceptOutcome {
  /** Warnings to surface to the accept caller (e.g. "skipped: no session"). */
  warnings: string[];
}

/**
 * Run the pre-accept validation turn synchronously, BEFORE the merge.
 *
 * Dispatches a `pre_accept` command to the supervisor (daemon-owned like an ask,
 * but a WRITE turn), waits for the response, records the agent turn + its
 * commits, then inspects the AUTHORITATIVE gate result the supervisor reported:
 *   - passed        → returns; the caller proceeds to merge (new commits land).
 *   - failed / crash → sets the task back to blocked with the failure surfaced
 *                      as a comment, and throws RpcError — the accept aborts.
 *                      Never a silent merge.
 *
 * Returns immediately (no turn) when the step is disabled or the task has no
 * agent session to resume.
 *
 * `priorStatus` is the status the task held when the accept began. Every exit
 * from this function restores it — see the INVARIANT in task-state-machine.ts.
 */
async function launchPreAcceptTurn(
  projectRoot: string,
  task: Task,
  sess: Session,
  worktreePath: string,
  config: ResolvedConfig,
  priorStatus: TaskStatus,
): Promise<PreAcceptOutcome> {
  const warnings: string[] = [];
  const preAccept = config.automation.pre_accept;

  if (!preAccept.enabled) {
    return { warnings };
  }
  if (!sess.agent_session_id) {
    // Can't resume a turn against an agent that never ran — skip rather than
    // block an otherwise-valid accept. (A blocked task with commits normally has
    // a session; this guards the rare recovered-branch case.)
    warnings.push(`${PRE_ACCEPT_SKIP_PREFIX}: task has no agent session to resume.`);
    return { warnings };
  }

  const storage = await getOrCreateStorage();
  const tRef = taskRef(task);

  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    throw new RpcError(409, `Cannot run pre-accept for ${displayId(task)}: worktree is locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
  }
  await acquireLock(worktreePath, 'lazy accept (pre-accept)');

  try {
    const runner = await createRunner(projectRoot);
    if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
      (runner as any).setAgent(getAgent(task.agent_id));
    }
    await runner.checkAvailability();

    const modelName = resolveAgentModel(config, { preferredModel: task.model, agentId: task.agent_id });
    const effortValue = await resolveAndPersistEffort(task, undefined, config.agent.effort, storage);
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }));

    const commands = preAccept.commands;
    const promptBody = renderPreAcceptPrompt(commands, config.automation.maintain);
    const fullPrompt = buildPromptWithInstructions(promptBody, task.goal, projectRoot);

    // Record a synthetic system turn so the pre-accept exchange reads as a
    // discrete human→agent pair (mirrors auto-deliver + ask).
    const humanSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: humanSeq,
      role: 'human',
      content: '[system] Pre-accept validation before merge',
      model: modelName,
      effort: effortValue,
      actor: 'system',
      autoTriggered: true,
    });

    await storage.updateTaskStatus(task.id, 'working', 'system');

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    const preAcceptCommand: PreAcceptCommand = {
      type: 'pre_accept',
      task_id: task.id,
      goal: task.goal,
      prompt: fullPrompt,
      agent_id: task.agent_id,
      system_prompt: systemPrompt,
      model_id: modelName,
      effort: effortValue,
      agent_session_id: sess.agent_session_id,
      pre_accept_commands: commands,
      pre_accept_timeout: preAccept.timeout,
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, preAcceptCommand);

    const containerName = runner.runNameForTask(tRef);
    const sandbox = await setupSandbox(worktreePath);
    let daemonConfigPath: string | null = null;
    // Skip when running outside the daemon (in-process RPC fallback) — there is
    // no daemon for the container to connect to, and getDaemonContext() throws.
    // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the pre_accept command.
    } else {
      await runner.removeRun(containerName);
      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
      } catch (err) {
        const message = `Pre-accept: failed to launch supervisor: ${err instanceof Error ? err.message : err}. Task returned to ${priorStatus}; accept aborted.`;
        await storage.updateTaskStatus(task.id, priorStatus, 'system');
        // Same reasoning as the timeout path below: the caller may be gone, so
        // the reason has to survive on the task itself.
        await storage.createComment(task.id, message, 'system');
        throw new RpcError(500, message);
      }
    }
    await storage.updateSessionContainerName(sess.id, containerName);

    const timeoutMs = preAcceptTimeoutMs(config);
    const response = await waitForResponse(protoDir, 500, timeoutMs);
    if (!response) {
      // Name the deadline. Three clocks can end a pre-accept turn (see
      // PRE_ACCEPT_TIMEOUT_MARGIN_MS); a message that does not say which one
      // fired sends the reader hunting through three different configs.
      const message =
        `Pre-accept validation hit the DAEMON's pre-accept wait (${Math.floor(timeoutMs / 1000)}s — ` +
        `agent.watchdog_output_timeout_ms + ${Math.floor(PRE_ACCEPT_TIMEOUT_MARGIN_MS / 1000)}s margin): ` +
        `the agent turn never reported back, and its own no-progress watchdog did not fire either. ` +
        `Task returned to ${priorStatus}; accept aborted. ` +
        `Re-accept when ready — a fresh pre-accept turn will run.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      // The RpcError below reaches the CALLER; this comment reaches the TASK,
      // and the two audiences are not the same one. This timeout is tens of
      // minutes — long enough that the caller may be gone by the time it fires
      // (an MCP client's own idle budget is the same order), and the field
      // incident that prompted this was exactly that: the accept aborted
      // correctly, the client never saw the 504, and the task was left sitting
      // in `blocked` with a pre-accept turn recorded and no explanation
      // anywhere for why the merge never happened. Every other abort path here
      // already leaves a comment; this one must too.
      await storage.createComment(task.id, message, 'system');
      throw new RpcError(504, message);
    }

    if (response.status === 'error') {
      const detail = response.error ?? 'unknown error';
      const crashMessage = `Pre-accept turn crashed: ${detail}. Task returned to ${priorStatus}; accept aborted.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, crashMessage, 'system');
      consumeResponse(protoDir);
      clearStatus(protoDir);
      throw new RpcError(500, crashMessage);
    }

    const completed = completedResponses(response)[0];
    await recordPreAcceptTurn(storage, sess, completed, worktreePath, protoDir);

    const gate = completed.pre_accept;
    if (gate && !gate.passed) {
      const cmdLabel = gate.failed_command ? `\`${gate.failed_command}\`` : 'a configured check';
      const exitLabel = gate.exit_code === -2 ? 'timed out' : `exited with ${gate.exit_code ?? 'a non-zero code'}`;
      const outputTail = gate.output ? `\n\n\`\`\`\n${gate.output.slice(-1500)}\n\`\`\`` : '';
      const message = `Pre-accept checks failed: ${cmdLabel} ${exitLabel}. Task returned to ${priorStatus}; accept aborted. Fix the issue, then re-accept.`;
      await storage.updateTaskStatus(task.id, priorStatus, 'system');
      await storage.createComment(task.id, `${message}${outputTail}`, 'system');
      throw new RpcError(409, message);
    }

    // Gate passed. Return the task to the status it had before the accept so the
    // merge that follows transitions from a valid state, and a mid-merge failure
    // leaves the task cleanly re-acceptable AS IT WAS.
    await storage.updateTaskStatus(task.id, priorStatus, 'system');
    return { warnings };
  } finally {
    await removeLock(worktreePath);
  }
}

/**
 * Record the pre-accept agent turn and any commits it made. Mirrors the ask
 * recorder but for a WRITE turn: it detects new commits and rolls up usage, and
 * it does NOT transition task status — the accept path owns status.
 */
async function recordPreAcceptTurn(
  storage: Storage,
  session: Session,
  response: CompletedResponse,
  worktreePath: string,
  protoDir: string,
): Promise<void> {
  // Reconcile the agent session id — a resume can rotate it, and the reported id
  // points at the JSONL that exists now.
  if (response.session_id && response.session_id !== session.agent_session_id) {
    await storage.updateSessionClaudeId(session.id, response.session_id);
  }

  const turnUsage = toTurnUsage(response.usage);

  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    const seq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({
      sessionId: session.id,
      sequence: seq,
      role: 'agent',
      content: `${PRE_ACCEPT_HEADING}\n\n${response.result}`,
      usage: turnUsage,
      ...launchSettingsFromResponse(response),
      startSha: response.start_sha_work,
      endSha: response.end_sha_work,
      startShaWork: response.start_sha_work,
      endShaWork: response.end_sha_work,
    });
    // INVARIANT: the session rollup shares the turn write's idempotency guard —
    // see recordAskCompletedTurn for what rolling up outside it produced.
    await rollUpSessionUsage(storage, session.id, turnUsage);
  }

  // Record commits the pre-accept turn made (fixes, CHANGELOG). They land in the
  // merge regardless, but recording keeps the task's commit history accurate.
  try {
    const existingCommits = await storage.getSessionCommits(session.id);
    const lastKnownSha = existingCommits.length > 0
      ? existingCommits[existingCommits.length - 1].sha
      : session.git_start_sha;
    const newCommits = await getNewCommits(lastKnownSha, worktreePath);
    for (const c of newCommits) {
      await storage.createCommit(session.id, c.sha, c.message);
    }
  } catch (err) {
    logger.debug(`Pre-accept: could not detect new commits: ${err instanceof Error ? err.message : err}`);
  }

  try {
    await storage.resetConsecutiveInterruptions(session.id);
  } catch {
    // Counter reset is best-effort.
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
}

// =====================================================================
// Reject Task
// =====================================================================

export interface RejectTaskParams {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: Actor;
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
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor: this runs INSIDE the daemon, where LAZY_ACTOR is never set,
  // so getActor() reports 'human' for every channel. The MCP boundary threads
  // the real channel through params; getActor() stays the CLI fallback.
  const actor = params.actor ?? getActor();

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolveResult.task;

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
  if (sess.ended_at) {
    throw new RpcError(409, `Session already ended (${sess.outcome ?? 'ended'}).`);
  }

  // --- Status validation ---
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, shortId(task.id), displayId(task));

  // --- State transitions ---

  // If working, stop runner and transition to interrupted first.
  // Monitor on the runner the session actually ran on (session.runner_type),
  // falling back to global config for legacy sessions.
  if (task.status === 'working') {
    const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
    const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
    await runner.stopRun(runName);
    await storage.updateTaskStatus(task.id, 'interrupted', actor);
  }

  // Mark as abandoned
  await storage.updateTaskStatus(task.id, 'abandoned', actor);

  // End session
  await storage.endSession(sess.id, 'rejected');

  // Clean up container
  await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
  await revokeTaskTokens(projectRoot, task.id);

  // Store rejection reason as comment
  await storage.createComment(task.id, `[Rejected] ${params.reason.trim()}`, actor);

  // Post reject review and close PR
  try {
    const config = await loadConfig(projectRoot);
    const driver = createDriver(config);
    const reviewWarning = await driver.postRejectReview(task, params.reason.trim());
    if (reviewWarning) {
      warnings.push(`Review warning: ${reviewWarning}`);
    }
    await driver.cleanup(sess.git_branch);
  } catch (err) {
    logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // Clean up lock and worktree (preserve branch). cleanupWorktree captures the
  // raw agent session JSONL before teardown.
  await removeLock(worktreePath);
  await cleanupWorktree(worktreePath, projectRoot, storage, task.id, sess.agent_session_id);

  // Clean up protocol dir
  removeProtocolDir(getProtocolDir(task.id));

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
  actor?: Actor;
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
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: getActor() cannot see the caller's channel
  // from inside the daemon, so MCP threads it through params.
  const actor = params.actor ?? getActor();

  // --- Resolve task ---
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    if (resolveResult.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'.`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolveResult.task;

  // --- Status check ---
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is already ${task.status}.`);
  }
  if (task.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
  }

  // --- Worktree uncommitted changes check ---
  const worktreePath = getWorktreePath(projectRoot, task);
  if (!params.acceptDirtyWorktree) {
    await checkUncommittedChangesOrThrow(worktreePath, displayId(task), 'close');
  }

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);

  // --- State transitions ---

  // If working, stop runner and transition to interrupted first.
  // Monitor on the session's recorded runner (fallback: global config).
  if (task.status === 'working') {
    if (sess) {
      const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
      const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
      await runner.stopRun(runName);
    }
    await storage.updateTaskStatus(task.id, 'interrupted', actor);
  }

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

  // Clean up container, remote resources, and worktree
  if (sess) {
    await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
    await revokeTaskTokens(projectRoot, task.id);

    try {
      const config = await loadConfig(projectRoot);
      const driver = createDriver(config);
      await driver.cleanup(sess.git_branch);
    } catch (err) {
      logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    await removeLock(worktreePath);
    await cleanupWorktree(worktreePath, projectRoot, storage, task.id, sess.agent_session_id);
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
  acceptDirtyWorktree?: boolean;
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
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }

  // --- Ended-session checks ---
  // These run BEFORE worktree recovery on purpose. A successful accept deletes
  // the worktree and the branch, so re-accepting would otherwise spend three
  // fetch retries hunting a branch that was merged away and then report
  // "Worktree is gone and branch ... not found" — burying the one fact the
  // user needs behind an unrelated, unactionable error.
  if (sess.outcome === 'accepted') {
    throw new RpcError(409, `Task ${displayId(task)} was already accepted (the merge has landed). Run 'lazy show ${displayId(task)}' to verify, or 'lazy reopen ${displayId(task)}' if you need to work on it further.`);
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
      throw new RpcError(409, `Task ${displayId(task)} is interrupted. Resume it first: lazy resume ${displayId(task)}`);
    } else if (task.status === 'working') {
      throw new RpcError(409, `Task ${displayId(task)} is still working. Wait for it to finish.`);
    } else {
      throw new RpcError(409, `Task ${displayId(task)} is in state '${task.status}' and cannot be accepted.`);
    }
  }

  // --- File violation checks ---
  // The FINAL violation set lives on the push-back turn (the last invocation that
  // re-detected them), not response #1 / the work turn — use latestViolationTurn.
  const turns = await storage.getSessionTurns(sess.id);
  const lastAgentTurn = latestViolationTurn(turns);
  if (lastAgentTurn?.violations?.some(v => v.status === 'pending')) {
    const pendingFiles = lastAgentTurn.violations
      .filter(v => v.status === 'pending')
      .map(v => v.file);

    const approvedFiles = params.approvedFiles ?? [];

    if (approvedFiles.length === 0) {
      throw new RpcError(409, `Task ${displayId(task)} has unresolved file permission violations: ${pendingFiles.join(', ')}. Use --approve-file to approve each file.`);
    }

    const approvedSet = new Set(approvedFiles);
    const missingFiles = pendingFiles.filter(f => !approvedSet.has(f));

    if (missingFiles.length > 0) {
      throw new RpcError(409, `Missing approval for violated file(s): ${missingFiles.join(', ')}. All violated files must be approved.`);
    }

    // Mark all pending violations as approved
    const updatedViolations: FileViolation[] = lastAgentTurn.violations.map(v => ({
      ...v,
      status: v.status === 'pending' ? 'approved' as const : v.status,
    }));
    await storage.updateTurnViolations(task.id, lastAgentTurn.id, updatedViolations);
    warnings.push(`Approved ${pendingFiles.length} protected file change(s): ${pendingFiles.join(', ')}`);
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Check for zero commits ---
  const commits = await storage.getSessionCommits(sess.id);
  if (commits.length === 0) {
    throw new RpcError(409, `Task ${displayId(task)} has no commits. Nothing to merge. Use 'lazy close' instead.`);
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
      throw new RpcError(409, `Parent task ${displayId(parentTask)} is currently ${parentTask.status}. Wait for it to become blocked.`);
    }

    parentDisplayId = displayId(parentTask);
    mergeTargetBranch = await getBranchNameFromId(childParentId, storage);
  } else {
    const { resolveDetachedHead } = await import('../git/operations');
    mergeTargetBranch = await resolveDetachedHead(targetBranchOf(task) ?? 'main', projectRoot, config.remote.git_remote);
  }

  // --- Branch sync validation (root tasks with remote driver) ---
  // Skip in offline mode — there's no remote to validate against, and the
  // accept will go through LocalDriver anyway.
  if (!isChildTask) {
    const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
    const driver = createDriver(config, undefined, { offline });
    if (driver.needsSync) {
      const syncCheck = await validateBranchInSyncWithRemote(mergeTargetBranch, config.remote.git_remote, projectRoot);
      if (!syncCheck.inSync) {
        throw new RpcError(409, `${syncCheck.error} Fix this before accepting to avoid a half-merged state.`);
      }
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
    warnings,
  };
}

// =====================================================================
// Accept Task — full orchestration (preflight + merge + cleanup)
// =====================================================================

export interface AcceptTaskParams {
  taskId: string;
  reason?: string;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
  /**
   * Channel actor (MCP builder → 'builder', MCP task agent → 'agent', CLI →
   * 'human'); falls back to getActor() when absent. Set at the MCP boundary
   * because the accept is executed in the daemon, where the env-var default
   * cannot see the caller's channel. See {@link MCP_ACTOR} / {@link AGENT_ACTOR}.
   */
  actor?: Actor;
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
 * 5. driver.merge() — attempt merge via remote driver
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
  return withTaskLifecycleLock(lockKey, () => acceptTaskInner(projectRoot, params));
}

/**
 * Task metadata key marking a LOCAL merge phase that is in flight, carrying the
 * status the task held before the accept began.
 *
 * WHY: `merging` means two different things. On the remote path it means "the
 * forge has the merge, we are waiting" — a durable state a later accept
 * re-enters to ask the forge what happened. Stamping `merging` at the START of
 * the local merge phase (which is what makes status honest during the minutes
 * the merge actually takes) would make a CRASHED local merge look exactly like
 * that, sending the next accept down the remote re-entry path for a merge no
 * forge ever heard of. This marker distinguishes them, and doubles as the record
 * of what to restore to.
 */
const ACCEPT_IN_FLIGHT_KEY = 'accept_in_flight_from';

/** Enter the merge phase: mark it in flight, then stamp `merging`. */
async function beginMergePhase(
  storage: Storage,
  task: Task,
  priorStatus: TaskStatus,
  actor: Actor,
): Promise<void> {
  // Marker first: a crash between the two writes leaves a marker on a
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

/** Leave the merge phase without a merge: restore the true prior status. */
async function abortMergePhase(
  storage: Storage,
  task: Task,
  priorStatus: TaskStatus,
  actor: Actor,
): Promise<void> {
  try {
    await storage.updateTaskStatus(task.id, priorStatus, actor);
    await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, '');
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
}

/**
 * Carries the edge-gate clearance out of the long accept body so the failure
 * path can say what happened to the human's one-shot approval.
 *
 * INVARIANT: approval consumption is atomic with accept completion. `spend()`
 * is called ONLY where the merge is durable; anywhere else the accept can die,
 * the approval is still pending and the human must be told so — otherwise they
 * re-approve out of doubt, which is exactly the friction the gate is meant to
 * spend deliberately.
 */
interface ApprovalReservation {
  clearance: EdgeGateClearance | null;
  spent: boolean;
}

/**
 * Consume the human approval now that the accept is durably finished. Call
 * ONLY where the merge has landed (or has been handed to the forge, which is
 * the state later accepts re-enter without re-checking the gate).
 *
 * Spends the reservation, and then clears any approval record still pending on
 * the task. The second half is what keeps the approval single-use across the
 * paths that never reserved anything — a `merging` re-entry skips the gate
 * entirely, so without this a leftover record from a crashed earlier attempt
 * would outlive the accept it belonged to.
 */
async function spendApproval(
  storage: Storage,
  taskId: string,
  reservation: ApprovalReservation,
): Promise<void> {
  try {
    if (reservation.clearance && !reservation.spent) {
      await reservation.clearance.commit();
      reservation.spent = true;
    }
    await takeHumanApproval(storage, taskId);
  } catch (err) {
    // The merge is durable at this point; failing the whole accept over the
    // approval bookkeeping would be worse than a loud warning. A surviving
    // record is caught by the same clear on the next accept of this task.
    logger.warn(
      `accept: failed to consume the human approval for task ${taskId} after a completed ` +
      `merge: ${err instanceof Error ? err.message : err}. Check \`lazy show ${taskId}\` — ` +
      `an approval left pending there should be treated as already used.`,
    );
  }
}

async function acceptTaskInner(
  projectRoot: string,
  params: AcceptTaskParams,
): Promise<AcceptTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'accept');
  const reservation: ApprovalReservation = { clearance: null, spent: false };
  try {
    return await acceptTaskRun(projectRoot, params, phases, reservation);
  } catch (err) {
    // Close whatever phase was open as failed, so the caller's last line says
    // WHERE the accept died rather than leaving a phase hanging mid-sentence.
    phases.fail(err instanceof Error ? err.message : String(err));
    // The accept died with a protected-merge approval reserved but not spent.
    // Say so explicitly: silence here is what made humans re-run `lazy approve`
    // after a failed accept that never touched their approval.
    if (reservation.clearance?.usesLocalApproval && !reservation.spent) {
      throw appendApprovalIntactNote(err);
    }
    throw err;
  }
}

/** Suffix appended to an accept failure when the approval was NOT consumed. */
const APPROVAL_INTACT_NOTE =
  'Your `lazy approve` approval was NOT consumed — it is still pending, ' +
  'so you can re-run the accept once the cause above is fixed without approving again.';

function appendApprovalIntactNote(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const combined = `${message}\n\n${APPROVAL_INTACT_NOTE}`;
  if (err instanceof RpcError) {
    return new RpcError(err.status, combined);
  }
  if (err instanceof Error) {
    const next = new Error(combined);
    next.name = err.name;
    next.stack = err.stack;
    return next;
  }
  return new Error(combined);
}

async function acceptTaskRun(
  projectRoot: string,
  params: AcceptTaskParams,
  phases: PhaseReporter,
  reservation: ApprovalReservation,
): Promise<AcceptTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Who is accepting. The status transitions and the [Accepted] comment below
  // are the audit trail of who decided this work should land, so a merge driven
  // by a parent agent must not read back as a human's call. The daemon's own
  // env cannot tell — the channel is threaded in from the caller.
  const acceptActor: Actor = params.actor ?? getActor();
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

  // --- Step 1: Pre-flight validation ---
  // Narrated as an unplanned prelude: preflight is what tells us WHICH plan
  // applies (fresh accept vs. remote-merge re-entry), so the plan is announced
  // immediately after it rather than guessed before it.
  phases.begin(ACCEPT_PHASES.preflight);
  const preflight = await acceptTaskPreflight(projectRoot, {
    taskId: params.taskId,
    approvedFiles: params.approvedFiles,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    callerTaskId: params.callerTaskId,
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

  const worktreePath = preflight.worktreePath;
  const mergeTargetBranch = preflight.mergeTargetBranch;
  const isChildTask = preflight.isChildTask;
  const reason = params.reason?.trim() || 'LGTM';

  // --- Which kind of accept is this, and what do we restore to on abort? ---
  // A `merging` task WITHOUT an in-flight marker is a genuine remote-pending
  // merge: re-entry asks the forge what happened. A `merging` task WITH one is
  // the wreckage of a local merge phase that died mid-flight — re-run it as a
  // fresh accept, restoring to the status recorded in the marker.
  const inFlightFrom = preflight.metadata[ACCEPT_IN_FLIGHT_KEY];
  const isRemoteMergeReentry = preflight.taskStatus === 'merging' && !inFlightFrom;
  const priorStatus = (inFlightFrom || preflight.taskStatus) as TaskStatus;
  if (preflight.taskStatus === 'merging' && inFlightFrom) {
    warnings.push(
      `A previous accept died during the merge phase (task was ${inFlightFrom} before it). ` +
      `Re-running the merge from that state.`,
    );
    await abortMergePhase(storage, task, priorStatus, acceptActor);
  }

  phases.announce(
    isRemoteMergeReentry
      ? acceptReentryPhasePlan()
      : acceptPhasePlan(config.automation.pre_accept.enabled),
    preflight.displayId,
  );

  // --- Step 1a: Branch-protection (edge-gate) check ---
  // INVARIANT: this runs for ALL drivers, including local, and regardless of
  // who called accept (CLI --yes, MCP, automation). It is the single decision
  // point that makes protected merges require a deliberate human act
  // (`lazy approve`) — see src/protection/edge-gate.ts and
  // docs/protected-branches.md.
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
    try {
      // RESERVES the approval; it is spent by spendApproval() below, at the
      // point the merge becomes durable. See the ApprovalReservation invariant.
      reservation.clearance = await enforceEdgeGate({
        storage,
        config,
        projectRoot,
        taskId: task.id,
        displayId: preflight.displayId,
        edge: { sourceBranch: sess.git_branch, targetBranch: mergeTargetBranch },
        forgeApproval,
      });
    } catch (err) {
      if (err instanceof EdgeGateRefusedError) {
        throw new RpcError(403, err.message);
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
        throw new RpcError(409, err.message);
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
        throw new RpcError(409, err.message);
      }
      throw err;
    }
  } else if (!isRemoteMergeReentry) {
    phases.skip(ACCEPT_PHASES.lfs, 'already passed when the merge started');
  }

  // --- Step 1b: Handle re-entry for tasks already in 'merging' state ---
  // When a task is already merging (from a previous accept), check if the
  // remote merge completed. This handles the common case where CI checks
  // pass and the PR merges while the user is away.
  if (isRemoteMergeReentry) {
    phases.begin(ACCEPT_PHASES.remoteState);
    const prState = await driver.getPRState(task);

    if (prState === 'MERGED') {
      phases.end('remote merge already landed');
      phases.begin(ACCEPT_PHASES.finalize);
      // Remote merge completed — fast-forward local and finalize
      const { resolveDetachedHead } = await import('../git/operations');
      const resolvedMergeTarget = await resolveDetachedHead(
        targetBranchOf(task) ?? mergeTargetBranch,
        projectRoot,
        config.remote.git_remote,
      );

      const ffResult = await driver.fastForwardLocal(resolvedMergeTarget, projectRoot);
      if (!ffResult.success) {
        throw new RpcError(500, `${ffResult.warning || 'Failed to fast-forward local branch'}. The remote merge succeeded, but the local ${resolvedMergeTarget} branch could not be updated.`);
      }
      if (ffResult.warning) {
        warnings.push(ffResult.warning);
      }

      // Authoritative accept marker — created BEFORE the status transition so a
      // crash here still leaves a recoverable signal for the zombie sweep.
      await createAcceptTag(task.id, resolvedMergeTarget, projectRoot);

      await storage.endSession(sess.id, 'accepted');
      await storage.updateTaskStatus(task.id, 'complete', acceptActor);
      phases.end();

      phases.begin(ACCEPT_PHASES.cleanup);
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) warnings.push(`${reparentMsg}.`);
      const stackAdvice = stackedChildAdvisory(reparented.length, mergeTargetBranch);
      if (stackAdvice) warnings.push(`${stackAdvice}.`);
      for (const child of reparented) {
        await storage.incrementTaskPendingSync(child.id);
      }

      // Child→parent fidelity (remote-merge re-entry paths).
      await regenerateParentFidelity(storage, task, driver, getSummarizer(config.models.default), warnings);

      await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
      await revokeTaskTokens(projectRoot, task.id);
      await removeLock(worktreePath);
      await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
      removeProtocolDir(getProtocolDir(task.id));
      phases.end();

      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'merged',
        prUrl: prUrl ?? undefined,
        warnings,
      };
    }

    if (prState === 'CLOSED') {
      throw new RpcError(409, `The merge request was closed externally. Use 'lazy close ${preflight.displayId}' to close the task, or reopen the MR/PR and re-run 'lazy accept ${preflight.displayId}'.`);
    }

    // PR is still open — check CI status
    const checksStatus = await driver.getChecksStatus(task);

    if (checksStatus.status === 'failed') {
      const failedDetails = checksStatus.failed
        .map(f => f.url ? `${f.name} (${f.url})` : f.name)
        .join('; ');
      await storage.updateTaskStatus(task.id, 'blocked', acceptActor);
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

    // Checks passed but merge didn't happen yet — retry merge
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
      phases.begin(ACCEPT_PHASES.finalize);
      const { resolveDetachedHead } = await import('../git/operations');
      const resolvedMergeTarget = await resolveDetachedHead(
        targetBranchOf(task) ?? mergeTargetBranch,
        projectRoot,
        config.remote.git_remote,
      );

      const ffResult = await driver.fastForwardLocal(resolvedMergeTarget, projectRoot);
      if (!ffResult.success) {
        throw new RpcError(500, `${ffResult.warning || 'Failed to fast-forward local branch'}`);
      }
      if (ffResult.warning) warnings.push(ffResult.warning);

      // Authoritative accept marker — created BEFORE the status transition so a
      // crash here still leaves a recoverable signal for the zombie sweep.
      await createAcceptTag(task.id, resolvedMergeTarget, projectRoot);

      await storage.endSession(sess.id, 'accepted');
      await storage.updateTaskStatus(task.id, 'complete', acceptActor);
      phases.end();

      phases.begin(ACCEPT_PHASES.cleanup);
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) warnings.push(`${reparentMsg}.`);
      const stackAdvice = stackedChildAdvisory(reparented.length, mergeTargetBranch);
      if (stackAdvice) warnings.push(`${stackAdvice}.`);
      for (const child of reparented) {
        await storage.incrementTaskPendingSync(child.id);
      }

      // Child→parent fidelity (remote-merge re-entry paths).
      await regenerateParentFidelity(storage, task, driver, getSummarizer(config.models.default), warnings);

      await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
      await revokeTaskTokens(projectRoot, task.id);
      await removeLock(worktreePath);
      await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
      removeProtocolDir(getProtocolDir(task.id));
      phases.end();

      const prUrl = await driver.getTaskUrl(task);
      return {
        taskId: task.id,
        displayId: preflight.displayId,
        status: 'merged',
        prUrl: prUrl ?? undefined,
        warnings,
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

    // Failed
    throw new RpcError(500, `Merge failed: ${retryResult.error}`);
  }

  // --- Step 1b-pre: Pre-accept validation turn ([automation.pre_accept]) ---
  // A final agent turn runs BEFORE the merge: it runs the configured gate
  // commands, fixes what they surface, updates maintained files (the CHANGELOG
  // written once against the final diff), and records a built-in post-mortem to
  // the journal. The supervisor then re-runs the gate commands authoritatively.
  // On failure the task returns to blocked and this throws — the merge never
  // happens (no silent merge). On success, the turn's commits are included by the
  // merge below. Only runs on the fresh accept path (not the 'merging' re-entry
  // handled above, where the merge is already in flight).
  if (config.automation.pre_accept.enabled) phases.begin(ACCEPT_PHASES.preAccept);
  const preAcceptOutcome = await launchPreAcceptTurn(projectRoot, task, sess, worktreePath, config, priorStatus);
  if (config.automation.pre_accept.enabled) {
    const skipReason = preAcceptOutcome.warnings.find(w => w.startsWith(PRE_ACCEPT_SKIP_PREFIX));
    if (skipReason) phases.skip(ACCEPT_PHASES.preAccept, 'no agent session to resume');
    else phases.end('checks passed');
  }
  warnings.push(...preAcceptOutcome.warnings);

  // Re-read the session: the pre-accept turn may have rotated the agent session
  // id (a resume) and advanced the branch. Downstream cleanup uses these.
  const refreshedSess = await storage.getSessionByTaskId(task.id);
  if (refreshedSess) Object.assign(sess, refreshedSess);

  // --- Step 1c: Protected branch gate ---
  // Check if the target branch has protection rules requiring approval.
  // This must happen before auto-creating a PR (step 2) to avoid creating
  // orphan PRs when the accept will be refused anyway.
  //
  // INVARIANT: subtask→parent merges into an intermediate `lazy/...` branch are
  // local git operations, never remote MRs. Such branches are NEVER protected,
  // so we short-circuit the network protection check entirely — it isn't needed
  // and a transient failure must not be able to misroute the merge.
  const targetIsLazyBranch = mergeTargetBranch.startsWith('lazy/');
  let targetIsProtected = false;
  if (driver.needsSync && !targetIsLazyBranch) {
    phases.begin(ACCEPT_PHASES.protection, mergeTargetBranch);
    targetIsProtected = await driver.isTargetBranchProtected(mergeTargetBranch);
    if (targetIsProtected && !config.remote.auto_approve) {
      // Without auto_approve, we need an existing external approval to proceed
      const hasApproval = driver.hasRemoteRef(task) && await driver.hasExternalApproval(task);
      if (!hasApproval) {
        throw new RpcError(409,
          `Branch \`${mergeTargetBranch}\` has protection rules requiring approval. ` +
          `Use \`lazy submit\` to create an MR for external review. ` +
          `After the MR is approved, run \`lazy accept\` to merge.`);
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
  const useLocalMerge = driver.needsSync && !targetIsProtected;
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

  // --- Step 2b: Auto-approve if configured and branch is protected ---
  // Submit an approving review before gate checks so the approval is visible.
  if (targetIsProtected && config.remote.auto_approve) {
    const approvalWarning = await driver.postAcceptReview(task, reason);
    if (approvalWarning) {
      warnings.push(`Auto-approve warning: ${approvalWarning}`);
    }
  }

  // --- Step 3: Check pre-merge gates ---
  phases.begin(ACCEPT_PHASES.mergeGates);
  // mergeDriver: a LocalDriver has no remote gates, so unprotected merges skip
  // CI/review gating entirely.
  const gateWarnings = await mergeDriver.checkAcceptGates(task);
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
  const summarizer = getSummarizer(config.models.default);
  let result: MergeResult;
  await beginMergePhase(storage, task, priorStatus, acceptActor);
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
    });

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
        throw new RpcError(409, `${result.error}\nThe agent needs to merge upstream and resolve conflicts first. Run: lazy sync ${preflight.displayId}`);
      } else {
        throw new RpcError(500, `Merge failed: ${result.error}`);
      }
    }
  } catch (err) {
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
    // INVARIANT: approval consumption is atomic with accept completion. This is
    // the other durable end-state — the forge now owns the merge and every
    // later accept of this task re-enters `merging` without re-checking the
    // gate, so the approval has done its job and must be spent here.
    await spendApproval(storage, task.id, reservation);
    await storage.createComment(task.id, `[Accepted] ${reason}`, acceptActor);

    const reviewWarning = await driver.postAcceptReview(task, reason);
    if (reviewWarning) {
      warnings.push(`Review warning: ${reviewWarning}`);
    }

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

  // --- Step 7: Merge succeeded — fast-forward local and finalize ---
  // Past this point the merge is DURABLE: every failure below is a
  // finish-the-job failure, and the task correctly stays `merging` (the accept
  // is resumable) rather than being restored to its pre-accept status.
  phases.begin(ACCEPT_PHASES.finalize);
  const { resolveDetachedHead } = await import('../git/operations');
  const resolvedMergeTarget = await resolveDetachedHead(
    targetBranchOf(task) ?? mergeTargetBranch,
    projectRoot,
    config.remote.git_remote,
  );

  const ffResult = await mergeDriver.fastForwardLocal(resolvedMergeTarget, projectRoot);
  if (!ffResult.success) {
    throw new RpcError(500, `${ffResult.warning || 'Failed to fast-forward local branch'}. The remote merge succeeded, but the local ${resolvedMergeTarget} branch could not be updated.`);
  }
  if (ffResult.warning) {
    warnings.push(ffResult.warning);
  }

  // --- Step 7b: Push the locally-merged parent branch to origin ---
  // INVARIANT (CLAUDE.md "Fail hard on remote failures" + "Before performing a
  // remote merge ... the parent branch's local commits MUST be pushed"): a LOCAL
  // squash merge writes the merge commit only to the local parent branch. If it
  // is never pushed, local <parent> drifts permanently ahead of origin/<parent>
  // (the "local-always-ahead" bug) AND `lazy sync` resolves upstream to a stale
  // origin/<parent> and falsely reports "Already up to date" — silently dropping
  // upstream delivery. So after a successful local merge we push the parent.
  //
  // We use the ORIGINAL `driver`, not `mergeDriver`: when the target is an
  // unprotected branch but a real GitHub/GitLab remote exists, `mergeDriver` was
  // swapped to a LocalDriver (whose pushBranch is a no-op), losing the knowledge
  // that there IS a remote to push to. `useLocalMerge` is `driver.needsSync &&
  // !targetIsProtected`, so `useLocalMerge === true` already implies a real
  // remote exists. When lazy is configured offline/local, `driver` is itself a
  // LocalDriver (needsSync === false), `useLocalMerge` is false, and we correctly
  // skip — there is no remote to push to.
  //
  // This is a plain branch push (driver.pushBranch wraps withRemoteRetry and
  // FAILS hard after retries), NEVER a PR/MR — opening one would regress
  // fix-mr-targets-main. Applies to `main` AND intermediate `lazy/...` parents.
  if (useLocalMerge) {
    try {
      await driver.pushBranch(resolvedMergeTarget);
    } catch (err) {
      throw new RpcError(500,
        `Local merge into ${resolvedMergeTarget} succeeded, but pushing it to ` +
        `${config.remote.git_remote} failed: ${err instanceof Error ? err.message : err}. ` +
        `Local ${resolvedMergeTarget} is now ahead of the remote — push it manually ` +
        `(git push ${config.remote.git_remote} ${resolvedMergeTarget}) to reconcile.`);
    }
  }

  // Authoritative accept marker — created BEFORE the status transition so a
  // crash in the window between merge and status update still leaves a
  // recoverable signal for the zombie sweep. Covers both the local squash
  // path (target HEAD is the squash commit) and the remote FF path.
  await createAcceptTag(task.id, resolvedMergeTarget, projectRoot);

  // INVARIANT: approval consumption is atomic with accept completion. The
  // merge is durable and the authoritative accept marker exists, so this is the
  // first moment the one-shot approval has actually bought something. Every
  // failure before this point — pre-flight, the gate's own siblings, the merge
  // itself — leaves the approval pending for a retry; every path past it has
  // spent it, so it can never unlock a second accept.
  await spendApproval(storage, task.id, reservation);

  // End session, create comment, post review
  await storage.endSession(sess.id, 'accepted');
  await storage.createComment(task.id, `[Accepted] ${reason}`, acceptActor);

  const reviewWarning = await mergeDriver.postAcceptReview(task, reason);
  if (reviewWarning) {
    warnings.push(`Review warning: ${reviewWarning}`);
  }

  // Transition: → merging → complete
  // Race: the remote-sync reconciler can observe the just-merged MR/PR and
  // transition the task to `complete` before we get here. Re-read the task
  // and skip transitions already applied. Without this guard the user sees
  // an opaque "Invalid status transition: 'complete' → 'merging'" even though
  // the merge succeeded.
  const currentForFinalize = await storage.getTask(task.id);
  const currentStatus = currentForFinalize?.status ?? task.status;
  if (currentStatus !== 'complete') {
    if (currentStatus !== 'merging') {
      await storage.updateTaskStatus(task.id, 'merging', acceptActor);
    }
    await storage.updateTaskStatus(task.id, 'complete', acceptActor);
  }
  await clearMergeInFlight(storage, task);
  phases.end();

  // --- Step 8: Cleanup and reparent children ---
  phases.begin(ACCEPT_PHASES.cleanup);
  const reparented = await reparentChildren(task, storage);
  // Mark reparented children for sync so the daemon merges the accepted
  // parent's changes into their worktrees. Without this, the branch
  // deletion after accept prevents detectParentBranchChanges() from
  // triggering a sync automatically.
  const reparentMsg = formatReparentWarning(reparented, task);
  if (reparentMsg) warnings.push(`${reparentMsg}.`);
  const stackAdvice = stackedChildAdvisory(reparented.length, resolvedMergeTarget);
  if (stackAdvice) warnings.push(`${stackAdvice}.`);
  for (const child of reparented) {
    await storage.incrementTaskPendingSync(child.id);
  }

  // Child→parent fidelity: this task's work just landed in its parent's branch,
  // so regenerate the parent/hub body to reflect the new child contribution.
  // Because the parent body is kept current as children land (read from
  // storage), by the time the parent merges to main it already reflects all
  // child work — no separate aggregation step is needed.
  await regenerateParentFidelity(storage, task, driver, summarizer, warnings);

  await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
  await revokeTaskTokens(projectRoot, task.id);
  await removeLock(worktreePath);
  await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
  removeProtocolDir(getProtocolDir(task.id));
  phases.end();

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
  };
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
      await launchUnblockTask(projectRoot, { taskId: plan.taskId, message: plan.feedback });
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
 */
async function regenerateParentFidelity(
  storage: Storage,
  task: Task,
  driver: ReturnType<typeof createDriver>,
  summarizer: ReturnType<typeof getSummarizer>,
  warnings: string[],
): Promise<void> {
  const parentId = parentTaskIdOf(task);
  if (!parentId) return;
  const parent = await storage.getTask(parentId);
  if (!parent) return;
  const parentFidelity = await regenerateFidelity(storage, parent, driver, summarizer);
  if (parentFidelity.warning) warnings.push(parentFidelity.warning);
}

// =====================================================================
// Sync Task — task-level upstream merge as standalone operation
// =====================================================================

export interface SyncTaskParams {
  taskId: string;
  /** Channel actor (MCP → 'builder', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: Actor;
}

export interface SyncTaskResult {
  taskId: string;
  displayId: string;
  status: 'up_to_date' | 'sync_launched' | 'pending_sync';
  message: string;
  warnings: string[];
}

/**
 * Sync a task's worktree with its upstream (parent) branch.
 *
 * Flow:
 * 1. Resolve task, validate it's in a syncable state (blocked/conflict/interrupted — not working)
 * 2. Determine parent branch (same logic as unblock)
 * 3. Attempt git fetch for the upstream ref
 * 4. If fetch fails → set pending_sync metadata, return warning
 * 5. If fetch succeeds and upstream has changes → launch supervisor with sync command
 * 6. If no upstream changes → clear pending_sync, return "Already up to date"
 * 7. On successful merge → clear pending_sync
 */
export async function syncTask(
  projectRoot: string,
  params: SyncTaskParams,
): Promise<SyncTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

  // --- Resolve task ---
  const result = await storage.resolveTask(params.taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = result.task;

  // --- Session check ---
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session has ended. Cannot sync a completed task.`);
  }

  // --- Status validation ---
  if (task.status === 'working') {
    throw new RpcError(409, `Task ${displayId(task)} is currently working. Cannot sync while agent is running.`);
  }
  if (isTerminalStatus(task.status)) {
    throw new RpcError(409, `Task ${displayId(task)} is ${task.status}. Cannot sync a terminal task.`);
  }
  if (task.status === 'backlog') {
    throw new RpcError(409, `Task ${displayId(task)} is in backlog. Start it first with: lazy start ${displayId(task)}`);
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

  if (!parentBranch) {
    throw new RpcError(400, `Cannot determine parent branch for task ${displayId(task)}.`);
  }

  // --- Attempt to fetch upstream ref ---
  const config = await loadConfig(projectRoot, { cwd: worktreePath });
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  if (offline && (config.remote.driver === 'gitlab' || config.remote.driver === 'github')) {
    warnings.push(
      'lazy is in offline mode. Sync will merge upstream changes from the local ' +
      'branch only — no remote fetch will be performed.',
    );
  }
  let resolvedParentBranch = parentBranch;
  try {
    const driver = createDriver(config, undefined, { offline });
    resolvedParentBranch = await driver.resolveUpstreamRef(parentBranch, worktreePath);
  } catch (err) {
    // Fetch failed — increment pending_sync so retry loop picks it up.
    // LocalDriver.resolveUpstreamRef resolves locally without fetching, so
    // a throw here is a real failure even when offline.
    logger.warn(`Sync fetch failed for ${parentBranch}: ${err instanceof Error ? err.message : err}`);
    await storage.incrementTaskPendingSync(task.id);
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
  if (!upstreamHasChanges) {
    // No changes — reset counter (we've checked, nothing to do)
    await storage.resetTaskPendingSync(task.id);
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'up_to_date',
      message: 'Already up to date.',
      warnings,
    };
  }

  // --- Upstream has changes: launch supervisor with sync command ---
  // Reset counter to 0 ("acting on everything up to now"). If new signals arrive
  // while the merge is running, they'll increment the counter above 0, telling the
  // completion handler that another sync is needed.
  await storage.resetTaskPendingSync(task.id);

  await acquireLock(worktreePath, 'lazy sync');

  const priorStatus = task.status;

  try {
    const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
    // Set agent on runner so auth uses the correct agent (not hardcoded ClaudeCodeAgent)
    if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
      (runner as any).setAgent(getAgent(task.agent_id));
    }
    await runner.checkAvailability();
    // Bridge/stamp the resolved runner onto the session before launch.
    await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

    const containerName = runner.runNameForTask(tRef);
    const sandbox = await setupSandbox(worktreePath);

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

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

    // Transition to 'working' so the reconciler picks up the supervisor's
    // response.json and records the agent turn / status transition when the
    // merge completes. Without this, the supervisor runs but the response
    // sits in protocol/ forever and the task stays in its prior status.
    await storage.updateTaskStatus(task.id, 'working', actor);

    // Write a sync command — semantically distinct from start/unblock
    const syncCommand: SyncCommand = {
      type: 'sync',
      task_id: task.id,
      protocol_version: PROTOCOL_VERSION,
      parent_branch: resolvedParentBranch,
      upstream_sha: resolvedUpstreamSha,
      agent_session_id: sess.agent_session_id ?? undefined,
      model_id: task.model ?? undefined,
      ...(config.agent.watchdog_output_timeout_ms !== 0 && {
        watchdog_output_timeout_ms: config.agent.watchdog_output_timeout_ms,
      }),
      // Sent even when 0 so the supervisor sees the explicit opt-out rather
      // than falling back to a default.
      wind_down_timeout_ms: config.agent.wind_down_timeout_ms,
    };
    writeCommand(protoDir, syncCommand);

    // Generate daemon MCP config if needed
    let daemonConfigPath: string | null = null;
    // Skip when running outside the daemon (in-process RPC fallback) — there is
    // no daemon for the container to connect to, and getDaemonContext() throws.
    // Mirrors the guard in task-launcher.ts (start) and auto-deliver.ts.
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Launch or reuse supervisor
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef);
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
    await storage.updateSessionContainerName(sess.id, containerName);
    await storage.updateSessionInteraction(sess.id, 0);

    // NOTE: pending_sync is NOT cleared here. It stays true until:
    // - The supervisor completes the merge and writes a 'completed' response
    // - The daemon's turn-completion handler clears it
    // This ensures that if the supervisor crashes, pending_sync stays true for retry.

    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'sync_launched',
      message: `Merging ${resolvedParentBranch} into the task branch in the background. Check progress with: lazy watch ${displayId(task)}`,
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
  actor?: Actor;
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
  syncStatus?: 'up_to_date' | 'sync_launched' | 'pending_sync';
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
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

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
    return {
      taskId: task.id,
      displayId: displayId(task),
      status: 'noop',
      newParent: newParentLabel,
      message: `Task ${displayId(task)} is already parented on ${newParentLabel}. Nothing to do.`,
      warnings,
    };
  }

  // --- Step 1: repoint the target through the Storage interface ---
  const oldParentLabel = currentParentId
    ? await displayIdFor(storage, currentParentId)
    : (targetBranchOf(task) ? `branch ${targetBranchOf(task)}` : 'top-level');

  // A single canonical target — either stacked on a task or pointed at a branch.
  // There is no separate parent/branch pair to keep consistent.
  await storage.updateTaskTarget(
    task.id,
    newParentTaskId !== null ? taskTarget(newParentTaskId) : branchTarget(targetBranch),
  );

  await storage.createComment(
    task.id,
    `[Reparented] Parent changed from ${oldParentLabel} to ${newParentLabel}.`,
    actor,
  );

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
  const syncResult = await syncTask(projectRoot, { taskId: task.id });
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
  actor?: Actor;
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
  const task = resolveResult.task;

  // --- Offline check (before any other validation) ---
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  if (offline) {
    throw new RpcError(400, 'Cannot submit while in offline mode. Run `lazy system online` to restore remote operations, then retry.');
  }

  // --- Status validation ---
  if (task.status !== 'blocked' && task.status !== 'conflict') {
    throw new RpcError(409, `Task ${displayId(task)} is ${task.status}. Only blocked or conflict tasks can be submitted.`);
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
  // `lazy/...` parent branch, which is NEVER a protected integration branch. Such
  // tasks must NOT open a remote MR/PR — `lazy accept` merges them locally into
  // the parent. Refuse to submit rather than silently retargeting the MR to main
  // (which would let the forge evaluate conflicts against the wrong base).
  // Determined structurally — no network call, so a transient forge failure can
  // never misroute this. Root tasks targeting a real named branch fall through to
  // the normal push/MR-creation flow below.
  const submitParentId = parentTaskIdOf(task);
  const submitTargetBranch = submitParentId
    ? await getBranchNameFromId(submitParentId, storage)
    : (targetBranchOf(task) ?? 'main');
  if (submitParentId || submitTargetBranch.startsWith('lazy/')) {
    throw new RpcError(400,
      `Task ${displayId(task)} integrates into \`${submitTargetBranch}\`, an intermediate task branch — ` +
      `lazy does not open merge requests for it. ` +
      `Run \`lazy accept ${displayId(task)}\` to merge it locally into \`${submitTargetBranch}\`.`);
  }

  // --- Push branch ---
  try {
    await driver.pushBranch(sess.git_branch);
  } catch (err) {
    throw new RpcError(500, `Failed to push branch ${sess.git_branch}: ${err instanceof Error ? err.message : err}`);
  }

  // --- Create/update PR ---
  let prUrl: string | null = null;
  try {
    const prResult = await driver.markReadyForReview(task);
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
  await storage.createComment(task.id, `[Submitted] Task submitted for review${prUrl ? `: ${prUrl}` : ''}`, actor);

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
  modelOverride?: string;
  /** CLI `--effort` override. Persists on the task so future turns use same value. */
  effortOverride?: string;
  /** Channel actor (MCP → 'builder'/'agent', CLI → 'human'); falls back to getActor(). See {@link MCP_ACTOR}. */
  actor?: Actor;
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
 * Search the sandbox .claude directory for a Claude session ID.
 * Claude Code stores session data in ~/.claude/projects/<hash>/ as JSON files.
 * Returns the most recent session ID found, or null if none.
 */
async function findClaudeSessionId(sandboxPath: string): Promise<string | null> {
  const claudeDir = join(sandboxPath, '.claude');
  if (!await pathExists(claudeDir)) return null;

  try {
    const projectsDir = join(claudeDir, 'projects');
    if (!await pathExists(projectsDir)) return null;

    const allEntries = await readdir(projectsDir);
    const projectDirs: string[] = [];
    for (const d of allEntries) {
      try {
        const entries = await readdir(join(projectsDir, d));
        if (entries.length > 0) projectDirs.push(d);
      } catch { /* skip unreadable dirs */ }
    }

    for (const projDir of projectDirs) {
      const projPath = join(projectsDir, projDir);
      const allFiles = await readdir(projPath);
      const jsonFiles = allFiles.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const content = await readFile(join(projPath, file), 'utf-8');
          const data = JSON.parse(content);
          if (data.sessionId) return data.sessionId;
          if (data.session_id) return data.session_id;
          if (data.id && typeof data.id === 'string') return data.id;
        } catch {
          // Skip files that can't be parsed
        }
      }
    }
  } catch {
    // Ignore errors searching
  }

  return null;
}

/**
 * Build the static system prompt for task resume (after interruption).
 */
export function buildSystemPromptForResume(runnerInstructions?: string, chattinessSnippet?: string, memorySection?: string): string {
  let prompt = lazyToolInstructions + '\n' + systemInstructionsResumeText;
  if (runnerInstructions) {
    prompt += '\n' + runnerInstructions;
  }
  // Shared-memory index (see src/memory) — same injection as a fresh launch, so
  // a resumed agent doesn't lose the project's curated knowledge.
  if (memorySection) {
    prompt += '\n\n' + memorySection;
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
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor — see rejectTask: a daemon-side getActor() cannot see the
  // caller's channel, so the MCP boundary threads it through params.
  const actor = params.actor ?? getActor();

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
  // `lazy resume` is deprecated in favor of `lazy unblock`. After unifying
  // `lazy stop` to transition tasks to 'blocked' (with user_stopped=true)
  // rather than 'interrupted', resume must also accept blocked-by-stop tasks
  // so the alias keeps working. Other statuses still reject.
  if (task.status !== 'interrupted' && task.status !== 'blocked') {
    if (task.status === 'working') {
      throw new RpcError(409, `Task ${displayId(task)} is still working. Use 'lazy blocked' to check when it finishes.`);
    } else if (task.status === 'conflict') {
      throw new RpcError(409, `Task ${displayId(task)} is in conflict. Use 'lazy unblock ${displayId(task)}' to resolve.`);
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

  const tRef = taskRef(task);

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, tRef, displayId(task));

  // --- Runner pre-flight (honor per-task runner override) ---
  const runner = await createRunner(projectRoot, task.runner_type ?? undefined);
  if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
    (runner as any).setAgent(getAgent(task.agent_id));
  }
  await runner.checkAvailability();

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

  await acquireLock(worktreePath, 'lazy resume');

  // Bridge/stamp the resolved runner onto the session before launch.
  await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

  const containerName = runner.runNameForTask(tRef);

  try {
    const config = await loadConfig(projectRoot, { cwd: worktreePath });

    const sandbox = await setupSandbox(worktreePath);
    const sandboxPath = sandbox.sandboxPath;

    // --- Model resolution ---
    let stickyModel: string | undefined;
    if (!params.modelOverride) {
      stickyModel = findStickyModel(await storage.getSessionTurns(sess.id));
    }
    // When Ollama is enabled for Claude Code, always use the Ollama model — task/sticky
    // model names (e.g. "claude-opus-4-8") don't exist in Ollama's model registry.
    const modelName = resolveAgentModel(config, {
      preferredModel: params.modelOverride ?? stickyModel ?? task.model,
      agentId: task.agent_id,
    });
    const modelId = modelName;

    // An explicit --model override is a durable choice — persist it even when
    // task.model is already set, so auto-resume/auto-deliver (which read
    // task.model) relaunch on the new model. Without an override, only fill
    // an empty task.model (a plain resume must not clobber the existing one).
    if (params.modelOverride || !task.model) {
      await storage.updateTaskModel(task.id, modelName);
      task.model = modelName;
    }

    const effortValue = await resolveAndPersistEffort(task, params.effortOverride, config.agent.effort, storage);

    // --- Claude session ID discovery ---
    let claudeSessionId = sess.agent_session_id;
    if (!claudeSessionId) {
      claudeSessionId = await findClaudeSessionId(sandboxPath);
      if (claudeSessionId) {
        await storage.updateSessionClaudeId(sess.id, claudeSessionId);
      }
    }

    // --- Build prompts ---
    const systemPrompt = buildSystemPromptForResume(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }));
    // INVARIANT (CLAUDE.md — never lose human feedback): a manual resume has the
    // same gap as auto-resume — if the interrupted turn crashed before the agent
    // consumed its feedback, re-deliver that feedback verbatim.
    const pendingFeedback = findPendingFeedback(await storage.getSessionTurns(sess.id));
    const fullPrompt = buildResumePrompt(
      task.goal,
      pendingFeedback ? buildFeedbackRedeliveryPrompt(pendingFeedback) : undefined,
    );

    // --- Persist state BEFORE launch ---
    // The resume notice deliberately does NOT carry feedback: it is not new
    // feedback, and the re-delivered turn stays 'pending' until an agent turn
    // actually completes, so a crash mid-resume re-delivers it again.
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: pendingFeedback
        ? '[system] Session interrupted and resumed (unconsumed feedback re-delivered)'
        : '[system] Session interrupted and resumed',
      model: modelName,
      effort: effortValue,
      actor,
    });

    await storage.updateTaskStatus(task.id, 'working', actor);

    // --- Write command and launch supervisor ---
    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      prompt: fullPrompt,
      agent_id: task.agent_id,
      system_prompt: systemPrompt,
      model_id: modelId,
      effort: effortValue,
      agent_session_id: claudeSessionId ?? undefined,
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, unblockCommand);

    // Generate daemon MCP config
    let daemonConfigPath: string | null = null;
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Launch or reuse supervisor
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command. The
      // config written just above still reaches it (in-place write, pinned
      // inode); a container whose FIRST launch had none stays without one, but
      // now reports itself instead of running toolless. See the "CONTAINER
      // REUSE" note on writeDaemonMcpConfig in src/daemon/task-launcher.ts.
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', actor);
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName);

    // Manual resume resets the circuit breaker
    await storage.resetConsecutiveInterruptions(sess.id);

    // Manual resume resets auto-react counters (human is taking over)
    try {
      await resetAutoReactCounters(storage, task.id);
    } catch {
      // Non-critical
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
  actor?: Actor;
}

export interface StopTaskResult {
  taskId: string;
  displayId: string;
  reason: string;
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
  if (!params.reason || !params.reason.trim()) {
    throw new RpcError(400, 'reason is required');
  }
  const reason = params.reason.trim();

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

  if (task.status !== 'working') {
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

  // SAVE FIRST: persist the user's intent before halting the runner.
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

  // Now halt the supervisor and transition. Monitor on the session's recorded
  // runner (fallback: global config) so a host task isn't missed by a
  // docker-configured stop, and vice versa.
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

  // Unify with `lazy unblock`: stopped tasks become 'blocked' (with
  // user_stopped=true), not 'interrupted'. The `[STOPPED]` chip and the
  // reconciler's auto-resume guard both key on user_stopped, not status —
  // see shouldSkipAutoResumeForUserStop in src/utils/reconcile.ts.
  // 'interrupted' is reserved for ungraceful interruptions (crash, watchdog
  // kill, supervisor died) which should auto-resume.
  await storage.updateTaskStatus(task.id, 'blocked', actor);
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

  return {
    taskId: task.id,
    displayId: displayId(task),
    reason,
  };
}

// =====================================================================
// Approve Task — record a one-shot human approval for the edge gate
// =====================================================================

export interface ApproveTaskParams {
  taskId: string;
  /** The human-supplied token (e.g. the static passphrase). Verified via the verifyHumanToken seam. */
  token: string;
}

export interface ApproveTaskResult {
  taskId: string;
  displayId: string;
  /** True when a pending (unconsumed) approval already existed and was replaced. */
  replacedPending: boolean;
}

export interface ApproveTaskPreflightParams {
  taskId: string;
}

export interface ApproveTaskPreflightResult {
  /**
   * Whether a token could possibly verify right now. 'unknown' means the
   * mechanism cannot tell without a token (e.g. TOTP) — the caller must carry
   * on and ask, never treat it as a failure.
   */
  enrollment: 'enrolled' | 'not-enrolled' | 'unknown';
  /** Actionable enrollment instructions when enrollment is 'not-enrolled'. */
  message: string | null;
  /** Where the human gets the token, for the interactive prompt. */
  sourceLabel: string | null;
}

/**
 * Everything `lazy approve` can check BEFORE asking a human for a passphrase:
 * the task exists, and the verifier has something enrolled to check against.
 *
 * Exists because prompting first and failing after is the exact anti-pattern
 * CLAUDE.md forbids — the human typed a secret into a prompt that could not
 * possibly succeed. No token is involved here, so this is safe to call blind.
 */
export async function approveTaskPreflight(
  projectRoot: string,
  params: ApproveTaskPreflightParams,
): Promise<ApproveTaskPreflightResult> {
  const storage = await getOrCreateStorage();

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }

  const config = await loadConfig(projectRoot);
  const verifier = createHumanTokenVerifier(config, projectRoot);
  const probe = await verifier.probeEnrollment();

  return {
    enrollment: probe.status,
    message: probe.status === 'not-enrolled' ? probe.message : null,
    sourceLabel: verifier.sourceLabel,
  };
}

/**
 * Verify a human-supplied token and record a one-shot approval that the next
 * gated accept of this task consumes (see src/protection/edge-gate.ts).
 *
 * INVARIANT: this is reachable only from the CLI (`lazy approve`) via daemon
 * RPC — there is deliberately NO MCP tool for it. Exposing it over MCP would
 * let the builder satisfy its own gate, defeating the entire friction model.
 */
export async function approveTask(
  projectRoot: string,
  params: ApproveTaskParams,
): Promise<ApproveTaskResult> {
  const storage = await getOrCreateStorage();

  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const task = resolved.task;

  if (!params.token || !params.token.trim()) {
    throw new RpcError(400, 'An approval passphrase is required.');
  }

  const config = await loadConfig(projectRoot);
  const verifier = createHumanTokenVerifier(config, projectRoot);
  const verdict = await verifier.verify(params.token);
  if (!verdict.ok) {
    throw new RpcError(403, verdict.message);
  }

  const existing = await peekHumanApproval(storage, task.id);
  const approval = await recordHumanApproval(storage, task.id);

  // Audit trail: record the human act on the task itself.
  await storage.createComment(
    task.id,
    `Human approval recorded (${approval.approved_at}). ` +
    `It will be consumed by the next accept into a protected branch.`,
    'human',
  );

  return {
    taskId: task.id,
    displayId: displayId(task),
    replacedPending: existing !== null,
  };
}
