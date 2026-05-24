/**
 * Poll-based state reconciliation for async task execution.
 *
 * When tasks are in 'working' status, this module checks the supervisor's
 * protocol state to determine if the agent has finished, crashed, or is still running.
 *
 * The supervisor writes response.json when a turn completes. Reconciliation
 * reads this response and transitions the task to 'blocked' or 'interrupted'.
 *
 * Called automatically by list/blocked commands before displaying results.
 */

import { join } from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import type { Storage } from '../storage';
import { TERMINAL_STATUSES } from '../types';
import type { TokenUsage } from '../types';
import { createRunner } from '../runner';
import type { Runner } from '../runner';
import { protocolDir as getProtocolDir, readResponse, readStatus, consumeResponse, clearStatus } from '../protocol';
import type { CompletedResponse, ErrorResponse } from '../protocol';
import { getNewCommits, hasUncommittedChanges, getUncommittedDiff, getCurrentSha, branchExists, isBranchMergedInto, findCommitByMessage, getTaskTargetBranch } from '../git/operations';
import { checkLock } from './lock';
import { checkPairingLock, removePairingLock } from './pairing-lock';
import { logger } from './logger';
import { tmuxSessionName, killTmuxWatchSession } from '../terminal';
import { getDataDir } from '../cli/init';
import { shortId as shortIdHelper, taskRef, taskRefFromId, getWorktreePathForRef } from '../cli/helpers';
import { autoResumeTask, exitCodeToReason, MAX_CONSECUTIVE_INTERRUPTIONS } from './auto-resume';
import { shouldAutoReact, recordAutoReact } from '../daemon/auto-react-budget';
import type { AutoReactTrigger } from '../daemon/auto-react-budget';
import { loadConfig } from '../config/loader';
import { runGit } from './git';
import { reparentChildren, formatReparentWarning } from '../cli/orphan';

/**
 * Grace period in milliseconds for newly-working tasks.
 * When a task transitions to 'working', we skip reconciliation for this duration
 * to give the container time to start up. This prevents a race where the reconciler
 * sees a working task with no running container and marks it interrupted before
 * the container finishes launching.
 *
 * In test mode, we set this to 0 to allow tests to run quickly without waiting.
 */
// Evaluated at call time (not module load) so that LAZY_TEST=1 set after import takes effect.
function getWorkingGracePeriodMs(): number {
  return process.env.LAZY_TEST === '1' ? 0 : 30000; // 30 seconds (0 in tests)
}


/**
 * Decide whether the stored agent_session_id should be replaced with the one
 * the agent reported in the just-completed turn response.
 *
 * Rules:
 *  - Empty/missing reported ID (e.g. sync-only turns with no agent call): skip.
 *  - Reported ID matches what's stored: no-op.
 *  - Otherwise (first turn with no stored ID, OR Claude Code rotated the session
 *    ID via auto-compact / --resume fallback / cross-machine drift): update.
 *
 * Exported for unit testing.
 */
/**
 * Reconciler gate for `lazy stop`: when a session was explicitly stopped by a
 * user (or builder), the reconciler must NOT auto-resume it. A crash-interrupted
 * session (user_stopped !== true) continues through auto-resume as usual.
 *
 * Exported for unit testing — `maybeAutoResume` calls this and returns early
 * when it returns true. Manual `lazy resume` / `lazy unblock` clears the flag
 * via `resetConsecutiveInterruptions`, re-arming auto-resume.
 */
export function shouldSkipAutoResumeForUserStop(
  session: { user_stopped?: boolean },
): boolean {
  return session.user_stopped === true;
}

export function shouldReconcileAgentSessionId(
  storedId: string | null,
  reportedId: string | undefined,
): boolean {
  if (!reportedId) return false;
  return reportedId !== storedId;
}

function shortId(id: string): string {
  return id.substring(0, 8);
}

// TERMINAL_STATUSES imported from ../types

/**
 * Yield to the event loop so pending HTTP requests and microtasks get served.
 * Used between reconcile steps for cooperative scheduling.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Reconcile all tasks in 'working' status, plus:
 * - Process stale responses for interrupted tasks (race condition fix)
 * - Clean up orphaned containers for terminal-state tasks
 *
 * For each working task:
 * 1. If supervisor has written response.json -> parse response, record turn, transition to 'blocked'
 * 2. If container is still running and no response -> leave as 'working'
 * 3. If container stopped without response -> check status.json for context, transition to 'interrupted'
 * 4. If no container and no response -> transition to 'interrupted'
 */
export async function reconcileTasks(
  storage: Storage,
  lazyRoot: string,
): Promise<void> {
  const runner = await createRunner(lazyRoot);
  // Primary sweep: reconcile working tasks
  const workingTasks = await storage.listTasksWithOptions({ workingOnly: true });

    for (const task of workingTasks) {
      try {
        await reconcileTask(storage, task.id, lazyRoot, runner);
      } catch (err) {
        logger.debug(`Failed to reconcile task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
      // Yield to event loop between tasks so pending HTTP requests get served
      await yieldToEventLoop();
    }

    // Sweep 2: process stale responses for interrupted tasks
    // This handles the race where the supervisor writes a new response AFTER
    // reconciliation already moved the task to interrupted.
    try {
      await sweepInterruptedResponses(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep interrupted responses failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 3: clean up orphaned runs for terminal-state tasks
    // This catches containers/processes that survived a failed cleanup during accept/close/reject.
    try {
      await sweepTerminalContainers(storage, lazyRoot, runner);
    } catch (err) {
      logger.warn(`Sweep terminal containers failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 4: detect tasks whose branch was already merged into their target
    // This catches the zombie scenario where accept squash-merged the branch
    // but crashed before updating session/task metadata.
    try {
      await sweepMergedBranches(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep merged branches failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 5: recover stale pairing states
    // If a task is in 'pairing' state but the pairing process has exited,
    // transition it back to 'blocked'. This handles: terminal closed,
    // machine rebooted, process killed.
    try {
      await sweepStalePairing(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep stale pairing failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 6: recover backlog tasks that actually have committed work.
    // The durable proof of work is the task's git branch — sessions and
    // worktrees are local on-disk state that doesn't travel between machines.
    // If a `backlog` task's branch has commits beyond its base, real work
    // exists and the task belongs in `blocked` so it surfaces in
    // `lazy blocked` and downstream commands can act on it.
    try {
      await recoverBacklogWithCommits(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Recover backlog with commits failed: ${err instanceof Error ? err.message : err}`);
    }
}

async function reconcileTask(storage: Storage, taskId: string, lazyRoot: string, runner: Runner): Promise<void> {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return;

  const task = await storage.getTask(taskId);
  if (!task) return;
  const tRef = taskRef(task);
  const taskShortId = shortId(taskId);

  // Skip tasks that are being actively worked on by another process (e.g., lazy start/unblock)
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
  if (await checkLock(worktreePath)) {
    logger.debug(`Task ${taskShortId}: worktree locked by another process, skipping reconciliation`);
    return;
  }

  // Skip tasks that are locked for pairing (human is working interactively)
  if (checkPairingLock(worktreePath)) {
    logger.debug(`Task ${taskShortId}: locked for pairing, skipping reconciliation`);
    return;
  }

  const containerName = session.container_name ?? runner.runNameForTask(tRef);

  // Step 1: Check if supervisor has written a response
  const protoDir = getProtocolDir(taskId);
  const response = readResponse(protoDir);

  // If there's a response file, process it immediately (no grace period applies).
  // The grace period only matters when there's NO response yet - we want to give
  // the container time to start before checking if it's running.
  if (response) {
    if (response.status === 'completed') {
      logger.info(`Task ${taskShortId} finished turn, transitioning to blocked`);
      await handleCompletedResponse(storage, taskId, session, response, worktreePath, protoDir);

      // Note: push and PR operations moved out of reconciler.
      // Read commands (list, show, blocked, active) should be fast and local.
      // Push happens in: lazy start (publish), lazy sync (explicit), lazy accept (merge flow).
      return;
    } else {
      // Error response — record as an agent error turn so crash details are visible
      logger.info(`Task ${taskShortId} crashed (phase: ${response.phase}): ${response.error}`);
      await handleErrorResponse(storage, taskId, session, response, protoDir, lazyRoot);
      return;
    }
  }

  // Step 2: No response yet — apply grace period before checking container status.
  // Skip tasks that just transitioned to 'working' to give the container time to start.
  // This prevents a race where reconciliation runs before the container is fully launched
  // and incorrectly marks the task as interrupted.
  if (session.last_interaction_at) {
    const lastInteractionTime = new Date(session.last_interaction_at).getTime();
    const now = Date.now();
    const timeSinceTransition = now - lastInteractionTime;

    if (timeSinceTransition >= 0 && timeSinceTransition < getWorkingGracePeriodMs()) {
      logger.debug(`Task ${taskShortId}: within grace period (${Math.round(timeSinceTransition / 1000)}s), skipping reconciliation`);
      return;
    }
  }

  // Step 3: Grace period expired — check if run is still alive
  if (runner.isRunning(containerName)) {
    logger.debug(`Task ${taskShortId}: run ${containerName} still running, no response yet`);
    return; // Still working
  }

  // Step 4: Run not active and no response — check status.json for context
  if (runner.runExists(containerName)) {
    const exitCode = runner.getRunExitCode(containerName);
    const logs = runner.getRunLogs(containerName, 50);
    const status = readStatus(protoDir);
    const reason = exitCodeToReason(exitCode);

    logger.info(`Task ${taskShortId} crashed: run stopped (exit: ${exitCode}, phase: ${status?.phase ?? 'unknown'})`);

    // Run stopped without writing response — interrupted
    await storage.updateTaskStatus(taskId, 'interrupted', 'system');
    await storage.recordInterrupt(session.id, { reason, exit_code: exitCode, logs });
    await storage.updateSessionContainerName(session.id, null);
    killTmuxWatchSession(tmuxSessionName(taskShortId));
    clearStatus(protoDir);
    runner.removeRun(containerName);

    // Auto-resume if circuit breaker allows
    await maybeAutoResume(storage, taskId, session.id, lazyRoot);
    return;
  }

  // Step 5: No run found at all — interrupted
  logger.info(`Task ${taskShortId} crashed: run disappeared (no container found)`);
  await storage.updateTaskStatus(taskId, 'interrupted', 'system');
  await storage.recordInterrupt(session.id, {
    reason: 'Container disappeared (no exit code)',
    exit_code: null,
    logs: null,
  });
  await storage.updateSessionContainerName(session.id, null);
  killTmuxWatchSession(tmuxSessionName(taskShortId));
  clearStatus(protoDir);

  // Auto-resume if circuit breaker allows
  await maybeAutoResume(storage, taskId, session.id, lazyRoot);
}

/**
 * Check circuit breaker, auto-react budget, and auto-resume an interrupted task if allowed.
 * Re-reads the session to get the updated consecutive_interruptions count.
 *
 * @param trigger - The auto-react trigger type (defaults to 'crash' for interrupt recovery).
 */
async function maybeAutoResume(
  storage: Storage,
  taskId: string,
  sessionId: string,
  lazyRoot: string,
  trigger: AutoReactTrigger = 'crash',
): Promise<void> {
  const taskShortId = shortId(taskId);

  // Re-read session to get updated consecutive_interruptions from recordInterrupt
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return;

  // Don't auto-resume if session has ended
  if (session.ended_at) {
    logger.debug(`Task ${taskShortId}: session ended, skipping auto-resume`);
    return;
  }

  // INVARIANT: A user-initiated `lazy stop` must NOT be undone by the reconciler.
  // Crash-interrupted sessions (user_stopped=false) continue through auto-resume
  // as before; only an explicit human/builder stop sets this flag, and it is
  // cleared by manual resume/unblock (resetConsecutiveInterruptions).
  if (shouldSkipAutoResumeForUserStop(session)) {
    logger.debug(`Task ${taskShortId}: user-stopped, skipping auto-resume`);
    return;
  }

  // Circuit breaker: stop auto-resuming after too many consecutive interruptions
  if (session.consecutive_interruptions >= MAX_CONSECUTIVE_INTERRUPTIONS) {
    logger.warn(`Task ${taskShortId}: circuit breaker triggered (${session.consecutive_interruptions} consecutive interruptions), not auto-resuming`);
    return;
  }

  // Re-read the task to get the current state
  const task = (await storage.listTasks()).find(t => t.id === taskId);
  if (!task) return;

  // Only auto-resume interrupted tasks
  if (task.status !== 'interrupted') return;

  // Auto-react budget gate: check per-task limits, backoff, and daily budget
  try {
    const config = await loadConfig(lazyRoot, { cwd: lazyRoot });
    const dataDir = join(lazyRoot, '.lazy');
    const decision = await shouldAutoReact(storage, taskId, trigger, config, dataDir);

    if (!decision.allowed) {
      if (decision.backoffRemainingMs) {
        // Backoff not elapsed — the reconcile loop will retry on the next tick
        logger.debug(`Task ${taskShortId}: auto-react blocked by backoff (${decision.reason})`);
      } else {
        // Hard limit reached — log as warning so it's visible
        logger.warn(`Task ${taskShortId}: auto-react blocked: ${decision.reason}`);
      }
      return;
    }
  } catch (err) {
    // Budget check failure should not prevent auto-resume — fail open
    logger.debug(`Task ${taskShortId}: auto-react budget check failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const success = await autoResumeTask(storage, task, session, lazyRoot);
    if (success) {
      // Record the auto-react consumption (counter + daily budget)
      try {
        const dataDir = join(lazyRoot, '.lazy');
        await recordAutoReact(storage, taskId, trigger, dataDir);
      } catch (err) {
        logger.debug(`Task ${taskShortId}: failed to record auto-react: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      logger.debug(`Task ${taskShortId}: auto-resume failed, task remains interrupted`);
    }
  } catch (err) {
    logger.debug(`Task ${taskShortId}: auto-resume error: ${err instanceof Error ? err.message : err}`);
  }
}

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Read plan file content from the Claude Code sandbox's .claude/plans/ directory.
 * Claude Code writes plan files as .md files in this location when entering plan mode.
 * Returns the content of the most recently modified plan file, or null if none found.
 */
export function readPlanContent(worktreePath: string): string | null {
  const plansDir = join(worktreePath, SANDBOX_DIR, '.claude', 'plans');
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return null;

    // Find the most recently modified plan file
    let newest: { file: string; mtime: number } | null = null;
    for (const file of files) {
      const filePath = join(plansDir, file);
      const st = statSync(filePath);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { file, mtime: st.mtimeMs };
      }
    }

    if (!newest) return null;

    const content = readFileSync(join(plansDir, newest.file), 'utf-8').trim();
    if (!content) return null;

    return content;
  } catch {
    return null;
  }
}

/**
 * Enrich the agent's response with plan content from the sandbox.
 *
 * When Claude Code enters plan mode, it writes the plan to a .md file in the
 * sandbox's .claude/plans/ directory, but the JSON response only contains a
 * brief summary like "The plan is ready for review." This function detects
 * plan files and appends their content to the response so the plan is captured
 * in the turn record.
 */
export function enrichResponseWithPlanContent(result: string, worktreePath: string): string {
  const planContent = readPlanContent(worktreePath);
  if (!planContent) return result;

  logger.debug('Found plan content in sandbox, enriching turn response');
  return result + '\n\n--- Plan File Content ---\n\n' + planContent;
}

/**
 * Handle a completed response from the supervisor.
 * Records the agent turn, captures commits, snapshots, etc.
 */
async function handleCompletedResponse(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null },
  response: CompletedResponse,
  worktreePath: string,
  protoDir: string,
): Promise<void> {
  const taskShortId = shortId(taskId);

  // Reconcile Claude session ID with what the agent actually wrote.
  // Claude Code rotates session IDs (auto-compact, --resume fallback, etc.)
  // and machine switches can leave the stored ID pointing at a JSONL that
  // doesn't exist in this sandbox. Always trust the ID the agent reported
  // for the just-completed turn — that's the JSONL that exists right now.
  if (shouldReconcileAgentSessionId(session.agent_session_id, response.session_id)) {
    await storage.updateSessionClaudeId(session.id, response.session_id);
  }

  // Extract token usage from protocol response
  const turnUsage: TokenUsage | undefined = response.usage ? {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  } : undefined;

  // Enrich response with plan content from the sandbox (if any)
  const enrichedResult = enrichResponseWithPlanContent(response.result, worktreePath);

  // Read supervisor status to get per-turn SHAs before it's cleared
  // Four-SHA model: start_sha, start_sha_work, end_sha_work, end_sha
  //   start_sha:      HEAD at absolute start of turn (before pre-turn sync)
  //   start_sha_work: HEAD where agent work begins (after pre-turn sync, or same as start_sha)
  //   end_sha_work:   HEAD where agent work ends (before post-turn sync)
  //   end_sha:        HEAD at absolute end of turn (after post-turn sync, or same as end_sha_work)
  const status = readStatus(protoDir);
  let turnStartSha: string | undefined;
  let turnStartShaWork: string | undefined;
  let turnEndShaWork: string | undefined;
  let turnEndSha: string | undefined;
  if (status) {
    turnStartSha = status.pre_turn_sha;
    turnStartShaWork = status.post_merge_sha ?? status.pre_turn_sha;
    turnEndShaWork = status.post_work_sha;
    try {
      turnEndSha = await getCurrentSha(worktreePath);
    } catch {
      logger.debug(`Task ${taskShortId}: could not get current SHA for turn end`);
    }

    // Store the upstream merge SHA for accurate diff scope
    if (status.upstream_merge_sha) {
      try {
        await storage.updateSessionUpstreamMergeSha(session.id, status.upstream_merge_sha);
      } catch {
        logger.debug(`Task ${taskShortId}: could not store upstream merge SHA`);
      }
    }
  }

  // Record agent turn (idempotent: check last turn isn't already an agent turn)
  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  let agentTurnSeq: number;
  if (lastTurn?.role === 'agent') {
    logger.debug(`Task ${taskShortId}: agent turn already recorded, skipping`);
    agentTurnSeq = lastTurn.sequence;
  } else {
    agentTurnSeq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({
      sessionId: session.id,
      sequence: agentTurnSeq,
      role: 'agent',
      content: enrichedResult,
      usage: turnUsage,
      startSha: turnStartSha,
      endSha: turnEndSha,
      startShaWork: turnStartShaWork,
      endShaWork: turnEndShaWork,
      mergeConflicts: response.merge_conflicts,
      violations: response.violations,
      ...(response.check_exit_code !== undefined ? { checkExitCode: response.check_exit_code } : {}),
      ...(response.check_output !== undefined ? { checkOutput: response.check_output } : {}),
    });
  }

  // Accumulate token usage into session totals
  if (turnUsage) {
    try {
      await storage.updateSessionUsage(session.id, turnUsage);
    } catch {
      logger.debug(`Task ${taskShortId}: could not capture token usage`);
    }
  }

  // Detect and record new commits
  const existingCommits = await storage.getSessionCommits(session.id);
  const lastKnownSha = existingCommits.length > 0
    ? existingCommits[existingCommits.length - 1].sha
    : session.git_start_sha;

  try {
    const newCommits = await getNewCommits(lastKnownSha, worktreePath);
    logger.debug(`Task ${taskShortId}: detected ${newCommits.length} new commit(s) since ${lastKnownSha.substring(0, 8)} in ${worktreePath}`);
    for (const c of newCommits) {
      await storage.createCommit(session.id, c.sha, c.message);
    }
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not detect new commits: ${err instanceof Error ? err.message : err}`);
  }

  // Capture uncommitted changes
  try {
    if (await hasUncommittedChanges(worktreePath)) {
      const uncommittedDiff = await getUncommittedDiff(worktreePath);
      const gitStatus = (await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath })).stdout;
      await storage.createWorktreeSnapshot(session.id, agentTurnSeq, uncommittedDiff, gitStatus);
    }
  } catch {
    logger.debug(`Task ${taskShortId}: could not capture uncommitted changes`);
  }

  // Transition to blocked (or conflict if there are file permission violations)
  const nextStatus = (response.violations && response.violations.length > 0) ? 'conflict' : 'blocked';
  await storage.updateTaskStatus(taskId, nextStatus, 'system');

  // pending_sync is managed by the daemon sync retry loop (src/daemon/sync-retry.ts).
  // The reconciler does not touch the counter — only syncTask resets it on launch.

  // Reset consecutive interruptions counter — a successful turn means the agent is healthy
  await storage.resetConsecutiveInterruptions(session.id);

  // Reset auto-react counters — a successful turn means recovery worked
  try {
    const { resetAutoReactCounters } = await import('../daemon/auto-react-budget');
    await resetAutoReactCounters(storage, taskId);
  } catch {
    // Non-critical — counters can accumulate but won't cause harm
  }

  // Clean up protocol files for this turn (response consumed)
  consumeResponse(protoDir);
  clearStatus(protoDir);

  // Don't remove container or clear container name — supervisor stays alive between turns
  // The container name stays in the session so we can detect if it dies
}

/**
 * Handle an error response from the supervisor.
 * Records an agent error turn so crash details are visible in lazy show,
 * then transitions the task to 'interrupted'.
 */
async function handleErrorResponse(
  storage: Storage,
  taskId: string,
  session: { id: string },
  response: ErrorResponse,
  protoDir: string,
  lazyRoot?: string,
): Promise<void> {
  const taskShortId = shortId(taskId);

  // Build a human-readable error turn content
  const lines: string[] = ['[Agent crashed]', ''];
  lines.push(`Error: ${response.error}`);
  if (response.exit_code !== undefined) {
    lines.push(`Exit code: ${response.exit_code}`);
  }
  if (response.duration_ms !== undefined) {
    const secs = (response.duration_ms / 1000).toFixed(1);
    lines.push(`Runtime: ${secs}s`);
  }
  lines.push(`Phase: ${response.phase}`);
  if (response.stdout_error && response.stdout_error !== response.error) {
    lines.push('');
    lines.push('Stdout error:');
    lines.push(response.stdout_error);
  }
  if (response.stderr) {
    lines.push('');
    lines.push('Stderr:');
    lines.push(response.stderr);
  }

  const turnContent = lines.join('\n');

  // Record error turn (idempotent: check last turn isn't already an agent turn)
  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    const seq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({
      sessionId: session.id,
      sequence: seq,
      role: 'agent',
      content: turnContent,
    });
    logger.debug(`Task ${taskShortId}: recorded agent error turn`);
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);
  await storage.updateTaskStatus(taskId, 'interrupted', 'system');

  // Record interrupt diagnostics
  const reason = response.exit_code !== undefined
    ? exitCodeToReason(response.exit_code)
    : `Agent error: ${response.error}`;
  await storage.recordInterrupt(session.id, {
    reason,
    exit_code: response.exit_code ?? null,
    logs: response.stderr ?? null,
  });

  // Do NOT auto-resume if the error was during merge_and_fix — the task cannot
  // make progress without a successful upstream merge. Resuming would start
  // a new turn on a stale branch, diverging further from upstream.
  if (response.phase === 'merge_and_fix') {
    logger.warn(`Task ${taskShortId}: merge-and-fix failed, not auto-resuming (task needs human investigation)`);
  } else if (lazyRoot) {
    // Auto-resume if called from reconciler (lazyRoot provided) and circuit breaker allows
    await maybeAutoResume(storage, taskId, session.id, lazyRoot);
  }
  // Don't remove container — supervisor may still be alive for next turn
}

/**
 * Sweep interrupted tasks for stale responses.
 *
 * Race condition fix: when the reconciler moves a task to 'interrupted' due to a
 * supervisor error, the supervisor may have already picked up the next command
 * (written by resume/unblock) and completed it. The new response.json sits
 * unconsumed because the reconciler only looked at working tasks.
 *
 * This sweep finds interrupted tasks that have a valid response.json and processes them.
 */
async function sweepInterruptedResponses(storage: Storage, lazyRoot: string): Promise<void> {
  const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true });

  for (const task of interruptedTasks) {
    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const tRef = taskRef(task);
      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePathForRef(lazyRoot, tRef);

      // Skip tasks with active worktree locks (another process is working on them)
      if (await checkLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: worktree locked, skipping interrupted sweep`);
        continue;
      }

      // Skip tasks locked for pairing (human is working interactively)
      if (checkPairingLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: locked for pairing, skipping interrupted sweep`);
        continue;
      }

      const protoDir = getProtocolDir(task.id);
      const response = readResponse(protoDir);
      if (!response) continue;

      if (response.status === 'completed') {
        logger.debug(`Task ${taskShortId}: found stale completed response for interrupted task, processing`);
        await handleCompletedResponse(storage, task.id, session, response, worktreePath, protoDir);
      } else {
        // Error response on an already-interrupted task — record the error turn
        logger.debug(`Task ${taskShortId}: found stale error response for interrupted task, recording`);
        await handleErrorResponse(storage, task.id, session, response, protoDir);
      }
    } catch (err) {
      logger.debug(`Failed to sweep interrupted task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sweep terminal-state tasks for orphaned containers.
 *
 * When accept/close/reject calls removeContainer(), the docker rm -f can silently
 * fail. Since the reconciler previously only looked at working tasks, these containers
 * would run forever. This sweep finds and removes them.
 */
async function sweepTerminalContainers(storage: Storage, lazyRoot: string, runner: Runner): Promise<void> {
  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!TERMINAL_STATUSES.has(task.status)) continue;

    try {
      const taskShortId = shortId(task.id);
      const session = await storage.getSessionByTaskId(task.id);

      // Skip tasks with no session or no tracked container — cleanup already happened
      if (!session?.container_name) continue;

      const containerName = session.container_name;

      if (runner.runExists(containerName)) {
        logger.warn(`Task ${taskShortId}: removing orphaned run ${containerName} for ${task.status} task`);
        runner.removeRun(containerName);
      }

      // Clear container_name so future sweeps skip this task
      await storage.updateSessionContainerName(session.id, null);
    } catch (err) {
      logger.debug(`Failed to clean up run for terminal task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sweep non-terminal tasks whose branch was already merged into their target.
 *
 * This detects the "zombie" scenario where `lazy accept` successfully squash-merged
 * the task branch into main (or parent's branch) but crashed before updating the
 * session outcome and task status. The code is merged but the task stays stuck as
 * "blocked" or "interrupted" with an active session.
 *
 * Detection:
 * 1. For each non-terminal task with a session that has a git_branch:
 *    a. Determine the merge target (main for root tasks, parent's branch for child tasks)
 *    b. If the branch still exists: check `git merge-base --is-ancestor <branch> <target>`
 *    c. If the branch was deleted (cleanup succeeded): look for a squash-merge commit
 *       on the target mentioning the task's short ID
 * 2. If merged → fix: set session outcome to "accepted", set ended_at, set task status to "complete"
 */
async function sweepMergedBranches(storage: Storage, lazyRoot: string): Promise<void> {
  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (TERMINAL_STATUSES.has(task.status)) continue;

    // Never auto-accept a working task — the agent is actively running.
    // A working task's branch may appear "merged" if it was just created
    // from the target and the agent hasn't committed yet.
    if (task.status === 'working') continue;

    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session?.git_branch) continue;

      // Skip if session already has an outcome (self-healing in listTasksWithOptions handles that case)
      if (session.outcome) continue;

      const taskShortId = shortId(task.id);

      // Guard: skip tasks where the agent never ran. If there are zero agent turns,
      // the task has no work to accept — auto-accepting would lose the task's intent.
      // This is defense-in-depth against false positives from isBranchMergedInto.
      const turns = await storage.getSessionTurns(session.id);
      const hasAgentWork = turns.some(t => t.role === 'agent');
      if (!hasAgentWork) {
        logger.debug(`Task ${taskShortId}: skipping zombie sweep — no agent turns (only ${turns.length} turns, all human/system)`);
        continue;
      }

      // Determine merge target: child tasks merge into parent's branch, root tasks into main
      let mergeTarget: string;
      if (task.parent_task_id) {
        const parentRef = await taskRefFromId(task.parent_task_id, storage);
        mergeTarget = `lazy/${parentRef}`;
        // If parent's branch doesn't exist, we can't check — skip
        if (!await branchExists(mergeTarget, lazyRoot)) continue;
      } else {
        mergeTarget = await getTaskTargetBranch(task, lazyRoot) ?? 'main';
      }

      let isMerged = false;

      if (await branchExists(session.git_branch, lazyRoot)) {
        // Branch still exists — check if all its commits are reachable from the target
        isMerged = await isBranchMergedInto(session.git_branch, mergeTarget, lazyRoot);
        logger.debug(`Task ${taskShortId}: branch ${session.git_branch} exists, isBranchMergedInto(${mergeTarget}) = ${isMerged}`);
      } else {
        // Branch was deleted (cleanup ran after merge) — look for the squash-merge
        // commit message pattern: "Accept task <shortId>: ..."
        isMerged = await findCommitByMessage(mergeTarget, `Accept task ${taskShortId}`, lazyRoot);
        logger.debug(`Task ${taskShortId}: branch ${session.git_branch} deleted, findCommitByMessage = ${isMerged}`);
      }

      if (!isMerged) continue;

      // Zombie detected: branch is merged but task/session not updated
      logger.warn(`Task ${taskShortId}: branch ${session.git_branch} already merged into ${mergeTarget}, fixing zombie state (${turns.length} turns, ${turns.filter(t => t.role === 'agent').length} agent)`);

      await storage.endSession(session.id, 'accepted');
      await storage.updateTaskStatus(task.id, 'zombie', 'system');
      await storage.updateTaskStatus(task.id, 'complete', 'system');

      // Re-parent unfinished children to the grandparent
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) {
        logger.info(`${reparentMsg} of ${shortIdHelper(task.id)}.`);
      }
    } catch (err) {
      logger.debug(`Failed to check merged branch for task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sweep tasks stuck in 'pairing' state where the pairing process has exited.
 *
 * When `lazy pair` transitions a task to 'pairing', it stores the pairing PID
 * in task metadata. If the process exits abnormally (terminal closed, machine
 * rebooted, process killed), the task stays in 'pairing' forever. This sweep
 * detects that the PID is no longer alive and transitions the task back to 'blocked'.
 *
 * Also handles the file-based pairing lock as a secondary check: if the lock file
 * exists but the PID is dead, the lock is cleaned up by readPairingLock().
 */
async function sweepStalePairing(storage: Storage, lazyRoot: string): Promise<void> {
  try {
    const pairingTasks = await storage.listTasksWithOptions({ pairingOnly: true });

    for (const task of pairingTasks) {
      try {
        const taskShortId = shortId(task.id);
        const pairingPidStr = task.metadata?.pairing_pid;

        if (pairingPidStr) {
          const pid = parseInt(pairingPidStr, 10);
          if (!isNaN(pid) && pid > 0) {
            // Check if the pairing process is still alive
            try {
              process.kill(pid, 0);
              // Process is alive — skip
              continue;
            } catch {
              // Process is dead — stale pairing state
            }
          }
        }

        // No valid PID or process is dead — transition back to blocked
        logger.warn(`Task ${taskShortId}: stale pairing state detected, transitioning back to blocked`);
        await storage.updateTaskStatus(task.id, 'blocked', 'system');
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');

        // Also clean up the file-based pairing lock if it exists
        const tRef = taskRef(task);
        const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
        removePairingLock(worktreePath);
      } catch (err) {
        logger.debug(`Failed to recover stale pairing task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to sweep stale pairing tasks: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Recover `backlog` tasks whose git branch already has committed work.
 *
 * Backlog means "never started — no work exists." But the durable proof of
 * work is the task's git branch (sessions and worktrees are local on-disk
 * state that doesn't travel between machines; branches do). A task can end
 * up in `backlog` despite having real work in two known scenarios:
 *
 *   1. Historical bug: an over-aggressive `migrateBlockedToBacklog` sweep
 *      (introduced in #33 as a one-time migration, removed in this fix)
 *      demoted blocked-with-no-local-session tasks to backlog. Tasks where
 *      the post-turn check exited non-zero hit this path and got stuck.
 *   2. Machine move: a task's session blob lives only on the machine where
 *      it ran, but the branch (with all its commits) travels with the repo.
 *      A `backlog` task whose branch already has commits should be `blocked`.
 *
 * Recovery strategy: for each `backlog` task, check if `lazy/<ref>` exists
 * and has any commits beyond `branched_from_sha`. If yes, transition to
 * `blocked` so the task is recoverable via `lazy unblock` or `lazy resume`.
 * The transition itself is validated by the canonical state-machine table
 * in `src/task-state-machine.ts`.
 */
export async function recoverBacklogWithCommits(storage: Storage, lazyRoot: string): Promise<void> {
  try {
    const backlogTasks = await storage.listTasksWithOptions({ backlogOnly: true });

    for (const task of backlogTasks) {
      try {
        const taskShortId = shortId(task.id);

        // We need a base SHA to ask "are there commits beyond it?". Without
        // branched_from_sha (very old tasks), skip — we can't make a safe call.
        if (!task.branched_from_sha) continue;

        const tRef = await taskRefFromId(task.id, storage);
        const branch = `lazy/${tRef}`;

        // Single git call: count commits on the branch beyond the base.
        // If the branch doesn't exist, rev-list exits non-zero and we skip.
        // (We deliberately avoid a separate `branchExists` precheck — both for
        // efficiency and because some tests globally mock that helper.)
        const result = await runGit(
          ['rev-list', '--count', `${task.branched_from_sha}..${branch}`],
          { cwd: lazyRoot },
        );
        if (result.exitCode !== 0) continue;
        const ahead = parseInt(result.stdout.trim(), 10) || 0;
        if (ahead === 0) continue;

        logger.warn(`Task ${taskShortId}: backlog task has ${ahead} commit(s) on ${branch}, recovering to blocked`);
        await storage.updateTaskStatus(task.id, 'blocked', 'system');
      } catch (err) {
        logger.debug(`Failed to check backlog recovery for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to list backlog tasks for recovery: ${err instanceof Error ? err.message : err}`);
  }
}
