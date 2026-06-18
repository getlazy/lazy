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
import { resolveAgentModel } from '../utils/role-target';
import { resolveAgentChattiness, renderChattinessSnippet } from '../config/chattiness';
import { pathExists } from '../utils/fs';
import { createRunner } from '../runner';
import { createDriver, LocalDriver } from '../remote';
import { regenerateFidelity } from '../synthesis/fidelity';
import { getSummarizer } from '../synthesis/summarizer';
import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { resolveAndPersistEffort } from './effort';
import { getAgent } from '../agent/registry';
import { hasUncommittedChanges, applyPatch, hasUpstreamChanges, getRemoteDefaultBranch, recoverMissingWorktreeWithFetch, createAcceptTag } from '../git/operations';
import type { DestinationRestoreConflict } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { checkPairingLock } from '../utils/pairing-lock';
import { protocolDir as getProtocolDir, writeCommand, writeResponse, consumeCommand, ensureProtocolDir, commonCommandFields, removeProtocolDir, waitForResponse, consumeResponse, clearStatus, completedResponses } from '../protocol';
import { shortId, displayId, displayIdFor, taskRef, getWorktreePath, getWorktreePathForRef, getBranchName, getBranchNameFromId } from '../cli/helpers';
import { buildNotesContext, buildSystemPrompt, buildPromptWithInstructions, buildTurnHistoryContext, getNewNotesSince, runSyncWithRemote, cleanupWorktree, cleanupWorktreeAndBranch, cleanupTaskContainer } from '../cli/commands/shared';
import { checkOrphanedChild, retargetOrphanedChild, getActiveChildren, reparentChildren, formatReparentWarning } from '../cli/orphan';
import { resetAutoReactCounters } from './auto-react-budget';
import { isFeatureEnabled } from '../utils/features';
import { isTerminalStatus, isActiveStatus, isBlockedStatus } from '../types';
import { parentTaskIdOf, targetBranchOf, taskTarget, branchTarget } from '../task-target';
import { logger } from '../utils/logger';
import { getActor } from '../constants';
import { writeDaemonMcpConfig } from './task-launcher';
import { setupSandbox } from '../utils/sandbox';
import { hasDaemonContext } from './context';
import { runGit } from '../utils/git';
import { validateBranchInSyncWithRemote } from '../utils/git';
import { latestViolationTurn } from '../utils/turns';
import { isOfflineMode } from '../utils/offline';
import { readdir, readFile } from 'fs/promises';

import type { StartCommand, UnblockCommand, SyncCommand, AskCommand, CompletedResponse, ErrorResponse } from '../protocol';
import { PROTOCOL_VERSION } from '../protocol/types';
import type { FileViolation, Task, TokenUsage, Session, TaskStatus } from '../types';
import type { Storage } from '../storage';

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
  if (await pathExists(worktreePath) && await hasUncommittedChanges(worktreePath)) {
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
        getActor(),
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
    getActor(),
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
    await storage.updateTaskStatus(task.id, 'blocked', getActor());
    await storage.createComment(task.id, 'Task unblocked from merging state (manual escape hatch).', getActor());
    task = (await storage.getTask(task.id))!;
    warnings.push('Task was in merging state. Moved back to blocked.');
  }

  // --- Pairing lock check ---
  checkPairingLockOrThrow(projectRoot, taskRef(task), displayId(task));

  // --- Runner pre-flight ---
  const runner = await createRunner(projectRoot);
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
    let message = params.message;

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
          parts.push(`The following protected files were REVERTED (do NOT modify them again):\n${revertedList.map(f => `  - ${f}`).join('\n')}`);
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
      const existingTurns = await storage.getSessionTurns(sess.id);
      for (let i = existingTurns.length - 1; i >= 0; i--) {
        if (existingTurns[i].model) {
          stickyModel = existingTurns[i].model;
          break;
        }
      }
    }
    // Per-role model resolution: a local backend (ollama/proxy) forces its
    // authoritative model; otherwise CLI flag > sticky > task.model > default.
    const modelName = resolveAgentModel(config, {
      preferredModel: params.modelOverride ?? stickyModel ?? task.model,
      agentId: task.agent_id,
    });
    const modelId = modelName;

    if (!task.model) {
      await storage.updateTaskModel(task.id, modelName);
      task.model = modelName;
    }

    const effortValue = await resolveAndPersistEffort(task, params.effortOverride, config.agent.effort, storage);

    // Determine parent branch (with stale-parent fallback)
    const parentResolution = await resolveParentBranchWithFallback(task, storage, projectRoot);
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
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)));
    const fullMessage = buildPromptWithInstructions(message.trim(), task.goal, null, projectRoot, turnHistory, notesCtx, remoteCommentsCtx);

    // --- Persist state BEFORE launching container ---
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: message.trim(),
      model: modelName,
      prompt: fullMessage,
      actor: getActor(),
    });

    // Transition to working. Unblock is only semantically valid from these
    // four statuses; other live statuses are handled above (working/pairing/
    // merging) or caught by the ended_at check (terminal). A `backlog` task
    // is "never started" — the right command is `lazy start`, not unblock.
    // The transition itself is validated against the canonical table in
    // src/task-state-machine.ts inside storage.updateTaskStatus.
    if (task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted' || task.status === 'interrupted') {
      await storage.updateTaskStatus(task.id, 'working', getActor());
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
    if (runner.usesSandbox()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, config.data.path);
    }

    // Launch or reuse supervisor
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', getActor());
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

    let stickyModel: string | undefined;
    const existingTurns = await storage.getSessionTurns(sess.id);
    for (let i = existingTurns.length - 1; i >= 0; i--) {
      if (existingTurns[i].model) {
        stickyModel = existingTurns[i].model;
        break;
      }
    }
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
    const runner = await createRunner(projectRoot);
    if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
      (runner as any).setAgent(getAgent(task.agent_id));
    }
    await runner.checkAvailability();
    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)));
    const fullMessage = buildPromptWithInstructions(params.message.trim(), task.goal, null, projectRoot);

    // --- Record the human turn BEFORE launching ---
    // INVARIANT (CLAUDE.md): human feedback must be durably saved before any
    // operation that might fail can discard it. For an ask, the question is
    // the feedback.
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: params.message.trim(),
      model: modelName,
      prompt: fullMessage,
      actor: getActor(),
      turnType: 'ask',
    });

    // --- Transition blocked → working ---
    await storage.updateTaskStatus(task.id, 'working', getActor());

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
    if (runner.usesSandbox()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, config.data.path);
    }

    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the ask command
    } else {
      await runner.removeRun(containerName);
      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', getActor());
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

  const turnUsage: TokenUsage | undefined = response.usage ? {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  } : undefined;

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
      turnType: 'ask',
    });
  }

  if (turnUsage) {
    try {
      await storage.updateSessionUsage(session.id, turnUsage);
    } catch {
      // Token-usage rollup is best-effort — do not fail the ask over it.
    }
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
  const lines: string[] = ['[Agent crashed]', ''];
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
    await storage.createTurn({
      sessionId,
      sequence: seq,
      role: 'agent',
      content: turnContent,
      turnType: 'ask',
    });
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
  await storage.updateTaskStatus(taskId, 'interrupted', 'system');
}

// =====================================================================
// Reject Task
// =====================================================================

export interface RejectTaskParams {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
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

  // If working, stop runner and transition to interrupted first
  if (task.status === 'working') {
    const runner = await createRunner(projectRoot);
    const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
    await runner.stopRun(runName);
    await storage.updateTaskStatus(task.id, 'interrupted', getActor());
  }

  // Mark as abandoned
  await storage.updateTaskStatus(task.id, 'abandoned', getActor());

  // End session
  await storage.endSession(sess.id, 'rejected');

  // Clean up container
  await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);

  // Store rejection reason as comment
  await storage.createComment(task.id, `[Rejected] ${params.reason.trim()}`, getActor());

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

  // If working, stop runner and transition to interrupted first
  if (task.status === 'working') {
    if (sess) {
      const runner = await createRunner(projectRoot);
      const runName = sess.container_name ?? runner.runNameForTask(taskRef(task));
      await runner.stopRun(runName);
    }
    await storage.updateTaskStatus(task.id, 'interrupted', getActor());
  }

  // Close task (persists reason)
  await storage.abandonTask(task.id, params.reason, getActor());

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

export interface AcceptTaskPreflightParams {
  taskId: string;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
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
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!params.acceptDirtyWorktree) {
    await checkUncommittedChangesOrThrow(worktreePath, displayId(task), 'accept');
  }
  if (sess.outcome === 'accepted') {
    throw new RpcError(409, `Task ${displayId(task)} was already accepted (the merge has landed). Run 'lazy show ${displayId(task)}' to verify, or 'lazy reopen ${displayId(task)}' if you need to work on it further.`);
  }
  if (sess.ended_at) {
    throw new RpcError(409, `Session already ended (${sess.outcome ?? 'ended'}).`);
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

    // Refuse to merge into active parent
    if (isActiveStatus(parentTask.status)) {
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
    const offline = await isOfflineMode(join(projectRoot, '.lazy'));
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
 */
export async function acceptTask(
  projectRoot: string,
  params: AcceptTaskParams,
): Promise<AcceptTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'));
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
  const preflight = await acceptTaskPreflight(projectRoot, {
    taskId: params.taskId,
    approvedFiles: params.approvedFiles,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
  });

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

  // --- Step 1b: Handle re-entry for tasks already in 'merging' state ---
  // When a task is already merging (from a previous accept), check if the
  // remote merge completed. This handles the common case where CI checks
  // pass and the PR merges while the user is away.
  if (preflight.taskStatus === 'merging') {
    const prState = await driver.getPRState(task);

    if (prState === 'MERGED') {
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
      await storage.updateTaskStatus(task.id, 'complete', getActor());

      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) warnings.push(`${reparentMsg}.`);
      for (const child of reparented) {
        await storage.incrementTaskPendingSync(child.id);
      }

      // Child→parent fidelity (remote-merge re-entry paths).
      await regenerateParentFidelity(storage, task, driver, getSummarizer(config.models.default), warnings);

      await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
      await removeLock(worktreePath);
      await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
      removeProtocolDir(getProtocolDir(task.id));

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
      await storage.updateTaskStatus(task.id, 'blocked', getActor());
      await storage.createComment(task.id, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked.`, getActor());
      throw new RpcError(409, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked. Fix the issue, then re-accept.`);
    }

    if (checksStatus.status === 'pending') {
      // If --wait was requested, the CLI can poll. For the RPC, just report pending.
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
      await storage.updateTaskStatus(task.id, 'complete', getActor());

      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) warnings.push(`${reparentMsg}.`);
      for (const child of reparented) {
        await storage.incrementTaskPendingSync(child.id);
      }

      // Child→parent fidelity (remote-merge re-entry paths).
      await regenerateParentFidelity(storage, task, driver, getSummarizer(config.models.default), warnings);

      await cleanupTaskContainer(storage, sess, taskRef(task), projectRoot);
      await removeLock(worktreePath);
      await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
      removeProtocolDir(getProtocolDir(task.id));

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

  // --- Step 4: Push parent branch local commits (INVARIANT) ---
  // If the parent has local-only commits and the remote merge succeeds without them,
  // the remote parent will have the merge commit but not the local commits, causing divergence.
  // Only relevant for the remote-merge path: a local merge into an unprotected
  // parent (mergeDriver.needsSync === false) needs no push.
  if (mergeDriver.needsSync) {
    try {
      await mergeDriver.pushBranch(mergeTargetBranch);
    } catch (err) {
      throw new RpcError(500, `Failed to push ${mergeTargetBranch} to remote: ${err instanceof Error ? err.message : err}. The parent branch has local commits that must be pushed before merging.`);
    }
  }

  // --- Step 4b: Regenerate the fidelity record before merge ---
  // Synthesize a faithful summary of what the work actually became (pivots,
  // human feedback, child contributions) from storage. For hosted drivers this
  // updates the lazy-owned section of the PR/MR body, which is what the squash
  // commit is built from at merge time. For the local driver the summary is
  // carried into the squash message via MergeOptions.fidelityBody below.
  // Never blocks the merge: synthesis failure falls back to deterministic
  // output, and a remote-write failure is surfaced as a warning.
  const summarizer = getSummarizer(config.models.default);
  const fidelity = await regenerateFidelity(storage, task, mergeDriver, summarizer);
  if (fidelity.warning) warnings.push(fidelity.warning);

  // --- Step 5: Attempt merge via driver ---
  let result = await mergeDriver.merge({
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

  if (result.status === 'pending') {
    // Merge is pending (waiting for CI, manual merge, etc.)
    await storage.updateTaskStatus(task.id, 'merging', getActor());
    await storage.createComment(task.id, `[Accepted] ${reason}`, getActor());

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

  // --- Step 7: Merge succeeded — fast-forward local and finalize ---
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

  // End session, create comment, post review
  await storage.endSession(sess.id, 'accepted');
  await storage.createComment(task.id, `[Accepted] ${reason}`, getActor());

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
      await storage.updateTaskStatus(task.id, 'merging', getActor());
    }
    await storage.updateTaskStatus(task.id, 'complete', getActor());
  }

  // --- Step 8: Cleanup and reparent children ---
  const reparented = await reparentChildren(task, storage);
  // Mark reparented children for sync so the daemon merges the accepted
  // parent's changes into their worktrees. Without this, the branch
  // deletion after accept prevents detectParentBranchChanges() from
  // triggering a sync automatically.
  const reparentMsg = formatReparentWarning(reparented, task);
  if (reparentMsg) warnings.push(`${reparentMsg}.`);
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
  await removeLock(worktreePath);
  await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, projectRoot, storage, task.id, sess.agent_session_id);
  removeProtocolDir(getProtocolDir(task.id));

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
  const parentResolution = await resolveParentBranchWithFallback(task, storage, projectRoot);
  const parentBranch = parentResolution.branch;
  warnings.push(...parentResolution.warnings);

  if (!parentBranch) {
    throw new RpcError(400, `Cannot determine parent branch for task ${displayId(task)}.`);
  }

  // --- Attempt to fetch upstream ref ---
  const config = await loadConfig(projectRoot, { cwd: worktreePath });
  const offline = await isOfflineMode(join(projectRoot, '.lazy'));
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
    const runner = await createRunner(projectRoot);
    // Set agent on runner so auth uses the correct agent (not hardcoded ClaudeCodeAgent)
    if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
      (runner as any).setAgent(getAgent(task.agent_id));
    }
    await runner.checkAvailability();

    const containerName = runner.runNameForTask(tRef);
    const sandbox = await setupSandbox(worktreePath);

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    // --- Persist state BEFORE launching supervisor ---
    // Record a synthetic human turn so the supervisor's completed response
    // doesn't collide with the idempotency check in handleCompletedResponse
    // (which skips when the last turn is already an agent turn). This also
    // gives users a visible record in `lazy show` that sync was requested.
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: `[built-in] Upstream merge requested (parent: ${resolvedParentBranch} @ ${resolvedUpstreamSha.substring(0, 8)})`,
      actor: getActor(),
    });

    // Transition to 'working' so the reconciler picks up the supervisor's
    // response.json and records the agent turn / status transition when the
    // merge completes. Without this, the supervisor runs but the response
    // sits in protocol/ forever and the task stays in its prior status.
    await storage.updateTaskStatus(task.id, 'working', getActor());

    // Write a sync command — semantically distinct from start/unblock
    const syncCommand: SyncCommand = {
      type: 'sync',
      task_id: task.id,
      protocol_version: PROTOCOL_VERSION,
      parent_branch: resolvedParentBranch,
      upstream_sha: resolvedUpstreamSha,
      agent_session_id: sess.agent_session_id ?? undefined,
      model_id: task.model ?? undefined,
    };
    writeCommand(protoDir, syncCommand);

    // Generate daemon MCP config if needed
    let daemonConfigPath: string | null = null;
    if (runner.usesSandbox()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, config.data.path);
    }

    // Launch or reuse supervisor
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
      } catch (err) {
        // Supervisor failed to launch — revert the working transition so the
        // task doesn't get stuck waiting for a supervisor that never started.
        // Going back to the prior status is safer than 'interrupted' because
        // no work has happened yet; the user can simply retry sync.
        try {
          await storage.updateTaskStatus(task.id, priorStatus, getActor());
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
    getActor(),
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
  const offline = await isOfflineMode(join(projectRoot, '.lazy'));
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
  const config = await loadConfig(projectRoot);

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
  await storage.updateTaskStatus(task.id, 'submitted', getActor());
  await storage.createComment(task.id, `[Submitted] Task submitted for review${prUrl ? `: ${prUrl}` : ''}`, getActor());

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
export function buildSystemPromptForResume(runnerInstructions?: string, chattinessSnippet?: string): string {
  let prompt = lazyToolInstructions + '\n' + systemInstructionsResumeText;
  if (runnerInstructions) {
    prompt += '\n' + runnerInstructions;
  }
  if (chattinessSnippet) {
    prompt = chattinessSnippet + '\n\n' + prompt;
  }
  return prompt;
}

/**
 * Build the dynamic user prompt for resuming after interruption.
 */
export function buildResumePrompt(goal: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = resumeContextText + '\n';
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

  // --- Runner pre-flight ---
  const runner = await createRunner(projectRoot);
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

  const containerName = runner.runNameForTask(tRef);

  try {
    const config = await loadConfig(projectRoot, { cwd: worktreePath });

    const sandbox = await setupSandbox(worktreePath);
    const sandboxPath = sandbox.sandboxPath;

    // --- Model resolution ---
    let stickyModel: string | undefined;
    if (!params.modelOverride) {
      const existingTurns = await storage.getSessionTurns(sess.id);
      for (let i = existingTurns.length - 1; i >= 0; i--) {
        if (existingTurns[i].model) {
          stickyModel = existingTurns[i].model;
          break;
        }
      }
    }
    // When Ollama is enabled for Claude Code, always use the Ollama model — task/sticky
    // model names (e.g. "claude-opus-4-8") don't exist in Ollama's model registry.
    const modelName = resolveAgentModel(config, {
      preferredModel: params.modelOverride ?? stickyModel ?? task.model,
      agentId: task.agent_id,
    });
    const modelId = modelName;

    if (!task.model) {
      await storage.updateTaskModel(task.id, modelName);
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
    const systemPrompt = buildSystemPromptForResume(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)));
    const fullPrompt = buildResumePrompt(task.goal);

    // --- Persist state BEFORE launch ---
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: '[system] Session interrupted and resumed',
      model: modelName,
      actor: getActor(),
    });

    await storage.updateTaskStatus(task.id, 'working', getActor());

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
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, config.data.path);
    }

    // Launch or reuse supervisor
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command
    } else {
      await runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
      } catch (err) {
        await storage.updateTaskStatus(task.id, 'interrupted', getActor());
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
    actor: getActor(),
  });
  await storage.setUserStopped(sess.id, true);

  // Now halt the supervisor and transition.
  const runner = await createRunner(projectRoot);
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
  await storage.updateTaskStatus(task.id, 'blocked', getActor());
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
