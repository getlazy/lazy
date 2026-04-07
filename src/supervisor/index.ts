/**
 * Supervisor loop.
 *
 * Runs inside the Docker container, mediating between the lazy host and the
 * coding agent (Claude Code).
 *
 * Lifecycle (one-shot mode — default in containers):
 *   1. Start up, recover state from protocol directory
 *   2. Wait for command.json
 *   3. Consume command.json (data is in memory; early consume prevents retry false-positives)
 *   4. Execute phases: sync-with-remote → sync-with-upstream → work → post-turn sync
 *   5. Write response.json, exit with code 0 (PID-1 wrapper restarts the process)
 *
 * The PID-1 wrapper script restarts the supervisor between turns so that
 * Bun's allocator (mimalloc) releases all memory back to the OS. On a stop
 * command the supervisor exits with code 42, which tells the wrapper to stop.
 *
 * Legacy loop mode (without --one-shot) is still supported for backward
 * compatibility: the supervisor stays alive and returns to step 2.
 */

import { existsSync } from 'fs';
import {
  readCommand,
  consumeCommand,
  writeResponse,
  writeStatus,
  clearStatus,
  readStatus,
  hasCommand,
  waitForCommand,
  readResponse,
} from '../protocol/io';
import type {
  Command,
  StartCommand,
  UnblockCommand,
  SyncCommand,
  StopCommand,
  SupervisorStatus,
  SupervisorPhase,
  CompletedResponse,
  ErrorResponse,
} from '../protocol/types';
import type { MergeConflict } from '../types';
import { runSyncWithUpstream, runSyncWithRemote, hasMergeInProgress, hasUnmergedFiles, abortMergeIfInProgress } from './merge';
import { runWork, CrashError, WatchdogTimeoutError, type RetryState } from './work';
import { resolveWatchdogTimeout } from './watchdog';
import { getAgent } from '../agent/registry';
import { log, logError, logWarn, resetTimer } from './log';
import { writeMcpConfig, writeToolPermissions } from '../mcp/config';
import { allTools } from '../mcp/tools';
import { createRunnerFromType } from '../runner';
import type { Runner, RunnerType } from '../runner/types';
import { spawn, spawnSync } from '../utils/spawn';
import { runGit } from '../utils/git';
import { detectViolations } from './permissions';
import { runPermissionPushback } from './pushback';
import { truncateLog } from '../utils/log-truncate';

export interface SupervisorConfig {
  /** Protocol directory path (shared via volume) */
  protocolDir: string;
  /** Worktree path (working directory for the agent) */
  worktreePath: string;
  /** Poll interval for watching command.json (ms) */
  pollIntervalMs?: number;
  /**
   * One-shot mode: process exactly one command then exit.
   * Exit code 0 = turn completed (wrapper restarts).
   * Exit code 42 = stop command received (wrapper exits cleanly).
   * This allows the OS to reclaim memory between turns.
   */
  oneShot?: boolean;
  /** Runner type — determines tool checks and MCP config. Defaults to 'docker'. */
  runnerType?: RunnerType;
}

/**
 * Check that required tools are available.
 * Uses the runner to determine which tools are needed for this environment.
 */
function checkRequiredTools(runner: Runner): void {
  const checks = runner.supervisorToolChecks();

  for (const { cmd, name, hint } of checks) {
    const result = spawnSync(['which', cmd], { stdout: 'ignore', stderr: 'ignore' });
    if (result.exitCode !== 0) {
      logError(`[supervisor] ${hint}`);
      process.exit(1);
    }
    log(`[supervisor] Found ${name} ✓`);
  }
}

/** Exit code used in one-shot mode to signal that a stop command was received. */
export const ONE_SHOT_STOP_EXIT_CODE = 42;

/**
 * Main supervisor entry point. Blocks until a stop command is received
 * or the process is killed.
 *
 * In one-shot mode, processes exactly one command then exits:
 *   - Exit 0 on normal turn completion (wrapper restarts the process).
 *   - Exit 42 on stop command (wrapper exits cleanly).
 */
export async function runSupervisor(config: SupervisorConfig): Promise<void> {
  const { protocolDir, worktreePath, pollIntervalMs = 500, oneShot = false, runnerType = 'docker' } = config;

  const runner = createRunnerFromType(runnerType);

  log(`[supervisor] Starting. Protocol dir: ${protocolDir}`);
  log(`[supervisor] Worktree: ${worktreePath}`);
  log(`[supervisor] Runner: ${runnerType}`);
  if (oneShot) {
    log('[supervisor] Running in one-shot mode (will exit after one command)');
  }

  // Check required tools before doing any work
  checkRequiredTools(runner);

  // Recovery: clean up any in-progress merge left by a previous crash
  await recoverWorktreeState(worktreePath);

  // Recovery: check if there's an in-progress status from a previous supervisor
  const prevStatus = readStatus(protocolDir);
  if (prevStatus) {
    log(`[supervisor] Found previous status: phase=${prevStatus.phase}, task=${prevStatus.task_id}`);
    // If there was an unfinished command, it will still be in command.json
    // The previous response.json (if any) was already cleared when command was written
  }

  // Recovery: check if there's already a response waiting (previous supervisor completed
  // but host hasn't consumed it yet). In that case, just wait for next command.
  const existingResponse = readResponse(protocolDir);
  if (existingResponse) {
    log(`[supervisor] Found existing response (previous turn completed). Waiting for next command.`);
  }

  // Main loop
  while (true) {
    log('[supervisor] Waiting for command...');
    const command = await waitForCommand(protocolDir, pollIntervalMs);
    if (!command) continue; // timeout (shouldn't happen with default 0 timeout)

    const turnStartedAt = (command.type === 'start' || command.type === 'unblock') ? (command as StartCommand | UnblockCommand).turn_started_at : undefined;
    resetTimer(turnStartedAt);
    log(`[supervisor] Received command: ${command.type} for task ${command.task_id}`);

    // Consume the command file immediately after reading it into memory.
    // The command data is in the `command` variable; the file is just the
    // delivery mechanism. Consuming early prevents the retry loop's
    // hasCommand() check from seeing the stale file and aborting retries.
    consumeCommand(protocolDir);

    if (command.type === 'stop') {
      log(`[supervisor] Stop command received. Reason: ${(command as StopCommand).reason ?? 'none'}`);
      clearStatus(protocolDir);
      if (oneShot) {
        log('[supervisor] One-shot mode: exiting with code 42 (stop).');
        process.exit(ONE_SHOT_STOP_EXIT_CODE);
      }
      break;
    }

    try {
      await handleTurnCommand(command, config, runner);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Error handling command: ${errorMessage}`);

      const errorResponse: ErrorResponse = {
        status: 'error',
        error: errorMessage,
        phase: 'reading_command',
      };
      writeResponse(protocolDir, errorResponse);
    }

    log(`[supervisor] Turn complete.`);

    if (oneShot) {
      log('[supervisor] One-shot mode: exiting with code 0 (turn done).');
      break;
    }
  }

  log('[supervisor] Shutting down.');
}

/**
 * Recover worktree state from a previous crash. Aborts any in-progress
 * merge and ensures the worktree is clean before work begins.
 */
async function recoverWorktreeState(worktreePath: string): Promise<void> {
  // Check for in-progress merge (MERGE_HEAD exists)
  if (await hasMergeInProgress(worktreePath)) {
    logWarn('[supervisor] Detected in-progress merge from previous crash. Aborting merge to recover clean state.');
    await abortMergeIfInProgress(worktreePath);
  }

  // Check for unmerged files (conflict markers without MERGE_HEAD — shouldn't happen but be safe)
  if (await hasUnmergedFiles(worktreePath)) {
    logWarn('[supervisor] Detected unmerged files in worktree. Resetting to clean state.');
    await runGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath });
  }
}

/**
 * Handle a start, unblock, or sync command: run phases and write response.
 */
async function handleTurnCommand(command: Command, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  if (command.type === 'stop') return; // handled by caller

  // Sync commands run only the merge phase — no agent work.
  if (command.type === 'sync') {
    await handleSyncCommand(command as SyncCommand, config, runner);
    return;
  }

  const cmd = command as StartCommand | UnblockCommand;
  const isResume = command.type === 'unblock' && !!(command as UnblockCommand).agent_session_id;
  log(`[supervisor] Command fields: protected_patterns=${JSON.stringify(cmd.protected_patterns)}, post_turn_check=${JSON.stringify(cmd.post_turn_check)}, parent_branch=${cmd.parent_branch}, agent_id=${cmd.agent_id}`);

  // Pre-turn worktree health check: ensure no leftover merge state
  await recoverWorktreeState(worktreePath);

  // Record pre-turn SHA for deterministic turn diff
  const preTurnSha = await getHeadSha(worktreePath);
  log(`[supervisor] Pre-turn SHA: ${preTurnSha.substring(0, 8)}`);

  // Initialize status
  const status: SupervisorStatus = {
    phase: 'reading_command',
    task_id: cmd.task_id,
    command_type: cmd.type,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pre_turn_sha: preTurnSha,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  // Collect merge conflicts from all merge phases
  const allMergeConflicts: MergeConflict[] = [];

  // Phase 1: Sync-with-remote (merge origin/<branch> — remote WIP from others)
  // Runs before sync-with-upstream so we figure out what we want on our branch
  // before merging approved upstream changes.
  if (cmd.remote_branch) {
    updatePhase(status, 'sync_with_remote', protocolDir);

    try {
      const remoteSyncSessionId = command.type === 'unblock'
        ? (command as UnblockCommand).agent_session_id
        : undefined;
      const conflicts = await runSyncWithRemote(worktreePath, cmd.remote_branch, cmd.model_id, remoteSyncSessionId);
      allMergeConflicts.push(...conflicts);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Sync-with-remote failed: ${errorMessage}`);

      const errorResponse: ErrorResponse = {
        status: 'error',
        error: `Sync-with-remote failed: ${errorMessage}`,
        phase: 'sync_with_remote',
      };
      writeResponse(protocolDir, errorResponse);
      return;
    }

    const postRemoteSyncSha = await getHeadSha(worktreePath);
    status.post_remote_sync_sha = postRemoteSyncSha;
    updatePhase(status, 'sync_with_remote_done', protocolDir);

    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-remote-sync/${postRemoteSyncSha.substring(0, 8)}`;
    await tagHead(worktreePath, tagName);
  }

  // Phase 2: Pre-turn sync-with-upstream (only when explicitly requested).
  // Sync commands set sync_before_work=true; unblock commands set it to false.
  // Default to false — unblock no longer triggers upstream merge automatically.
  const syncBeforeWork = cmd.sync_before_work ?? false;
  if (cmd.parent_branch && syncBeforeWork) {
    updatePhase(status, 'merge_and_fix', protocolDir);

    // Capture the upstream branch SHA before merging for accurate diff scope
    const upstreamSha = await getBranchSha(worktreePath, cmd.parent_branch);
    if (upstreamSha) {
      status.upstream_merge_sha = upstreamSha;
      writeStatus(protocolDir, status);
    }

    try {
      const mergeSessionId = command.type === 'unblock'
        ? (command as UnblockCommand).agent_session_id
        : undefined;
      const conflicts = await runSyncWithUpstream(worktreePath, cmd.parent_branch, cmd.model_id, mergeSessionId);
      allMergeConflicts.push(...conflicts);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Pre-turn sync-with-upstream failed: ${errorMessage}`);

      const errorResponse: ErrorResponse = {
        status: 'error',
        error: `Merge-and-fix failed: ${errorMessage}`,
        phase: 'merge_and_fix',
      };
      writeResponse(protocolDir, errorResponse);
      return;
    }

    // Tag HEAD after merge for deterministic turn diff
    const postMergeSha = await getHeadSha(worktreePath);
    status.post_merge_sha = postMergeSha;
    updatePhase(status, 'merge_and_fix_done', protocolDir);

    // Create a deterministic tag for the merge point
    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-merge/${postMergeSha.substring(0, 8)}`;
    await tagHead(worktreePath, tagName);
  }

  // Write MCP server config so Claude Code discovers lazy tools
  try {
    const mcpConfig = runner.mcpServerConfig(cmd.task_id, worktreePath);
    await writeMcpConfig(mcpConfig);
    log(`[supervisor] Wrote MCP config for task ${cmd.task_id.substring(0, 8)}`);
  } catch (err) {
    // Non-fatal: Claude Code will work without MCP tools (they just won't be available)
    logWarn(`[supervisor] Failed to write MCP config: ${err instanceof Error ? err.message : err}`);
  }

  // Pre-approve lazy MCP tools so Claude Code doesn't prompt for permission
  try {
    const toolNames = allTools.map(t => t.name);
    await writeToolPermissions(toolNames);
    log(`[supervisor] Pre-approved ${toolNames.length} MCP tools`);
  } catch (err) {
    logWarn(`[supervisor] Failed to write tool permissions: ${err instanceof Error ? err.message : err}`);
  }

  // Phase 3: Work (actual task work via Claude Code)
  updatePhase(status, 'work', protocolDir);

  try {
    const claudeSessionId = command.type === 'unblock'
      ? (command as UnblockCommand).agent_session_id
      : undefined;

    // Callback to update status when entering retry mode
    const onRetryStateChange = (retryState: RetryState | null) => {
      if (retryState) {
        // Entering or updating retry state
        status.phase = 'retrying';
        status.retryCount = retryState.count;
        status.errors = retryState.errors;
        status.updated_at = new Date().toISOString();
        writeStatus(protocolDir, status);
        log(`[supervisor] Phase: retrying (attempt ${retryState.count})`);
      } else {
        // Exiting retry state (success)
        delete status.retryCount;
        delete status.errors;
      }
    };

    // Resolve the agent from the command (defaults to claude-code for backward compat)
    const agent = getAgent(cmd.agent_id ?? 'claude-code');
    log(`[supervisor] Using agent: ${agent.id}`);

    // Resolve effective watchdog timeout: config value (0 = use agent default)
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const result = await runWork(
      agent,
      worktreePath,
      cmd.prompt,
      cmd.system_prompt,
      cmd.model_id,
      claudeSessionId,
      protocolDir,
      onRetryStateChange,
      undefined, // _executeOverride
      effectiveWatchdogMs,
    );

    updatePhase(status, 'work_done', protocolDir);
    log(`[supervisor] Agent result: session_id=${result.session_id?.substring(0, 8)}, result_length=${result.result.length}`);

    // Record agent's work endpoint (before any post-turn sync)
    const postWorkSha = await getHeadSha(worktreePath);
    log(`[supervisor] Post-work SHA: ${postWorkSha.substring(0, 8)}`);
    status.post_work_sha = postWorkSha;
    writeStatus(protocolDir, status);

    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-work/${postWorkSha.substring(0, 8)}`;
    await tagHead(worktreePath, tagName);
    log(`[supervisor] Tagged HEAD: ${tagName}`);

    // Phase 3b: Check for file permission violations and push back if needed
    const protectedPatterns = cmd.protected_patterns ?? [];
    const startShaWork = status.post_merge_sha ?? status.pre_turn_sha ?? preTurnSha;

    // Compute branch point SHA: the merge-base with the parent branch.
    // Files created after this point were created by the task itself and are
    // exempt from permission violations (they're not pre-existing files).
    let branchPointSha: string | undefined;
    if (cmd.parent_branch && protectedPatterns.length > 0) {
      const mergeBaseResult = await runGit(
        ['merge-base', cmd.parent_branch, 'HEAD'],
        { cwd: worktreePath },
      );
      if (mergeBaseResult.exitCode === 0 && mergeBaseResult.stdout.trim()) {
        branchPointSha = mergeBaseResult.stdout.trim();
        log(`[supervisor] Branch point SHA (merge-base with ${cmd.parent_branch}): ${branchPointSha.substring(0, 8)}`);
      } else {
        log(`[supervisor] Could not compute merge-base with ${cmd.parent_branch} — all protected-pattern changes will be checked`);
      }
    }

    log(`[supervisor] Checking permissions: ${protectedPatterns.length} pattern(s) [${protectedPatterns.join(', ')}], diff ${startShaWork.substring(0, 8)}..${postWorkSha.substring(0, 8)}`);
    log(`[supervisor] status.post_merge_sha=${status.post_merge_sha?.substring(0, 8)}, status.pre_turn_sha=${status.pre_turn_sha?.substring(0, 8)}, preTurnSha=${preTurnSha.substring(0, 8)}`);
    let violations = await detectViolations(worktreePath, startShaWork, postWorkSha, protectedPatterns, branchPointSha);
    log(`[supervisor] Violations detected: ${violations.length}`);

    // Push-back: give the agent one chance to self-correct before blocking
    let pushbackResponse: string | undefined;
    if (violations.length > 0) {
      log(`[supervisor] Detected ${violations.length} file permission violation(s). Pushing back...`);
      updatePhase(status, 'permission_pushback', protocolDir);

      const pushbackResult = await runPermissionPushback(
        agent,
        worktreePath,
        result.session_id,
        violations,
        cmd.model_id,
      );
      pushbackResponse = pushbackResult.response;

      // Re-check violations on the new HEAD (agent may have reverted some files)
      const postPushbackSha = await getHeadSha(worktreePath);
      violations = await detectViolations(worktreePath, startShaWork, postPushbackSha, protectedPatterns, branchPointSha);
      log(`[supervisor] After push-back: ${violations.length} violation(s) remaining`);
      updatePhase(status, 'permission_pushback_done', protocolDir);

      // Update the post-work SHA and tag to reflect the push-back
      if (postPushbackSha !== postWorkSha) {
        status.post_work_sha = postPushbackSha;
        writeStatus(protocolDir, status);

        const pushbackTagName = `turn/${cmd.task_id.substring(0, 8)}/post-work/${postPushbackSha.substring(0, 8)}`;
        await tagHead(worktreePath, pushbackTagName);
      }
    }

    // Phase 3c: Post-turn check (run configurable command and capture output)
    let checkExitCode: number | undefined;
    let checkOutput: string | undefined;
    log(`[supervisor] Post-turn check: ${cmd.post_turn_check ? `"${cmd.post_turn_check}"` : 'not configured'}`);
    if (cmd.post_turn_check) {
      const timeoutSecs = cmd.post_turn_timeout ?? 300;
      log(`[supervisor] Running post-turn check (timeout: ${timeoutSecs}s)`);
      updatePhase(status, 'post_turn_check', protocolDir);
      try {
        const proc = spawn(['sh', '-c', cmd.post_turn_check], {
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 0, // Long-running: post_turn_timeout in lazy.toml controls this (default 300s)
        });

        // Race the process against the timeout
        const timeoutMs = timeoutSecs * 1000;
        const timeout = new Promise<'timeout'>(resolve =>
          setTimeout(() => resolve('timeout'), timeoutMs),
        );
        const exited = proc.exited.then(() => 'exited' as const);
        const winner = await Promise.race([exited, timeout]);

        if (winner === 'timeout') {
          proc.kill();
          checkExitCode = -2;
          checkOutput = `Post-turn check timed out after ${timeoutSecs}s`;
          logWarn(`[supervisor] Post-turn check timed out after ${timeoutSecs}s`);
        } else {
          checkExitCode = proc.exitCode ?? undefined;
          const stderr = await new Response(proc.stderr).text();
          checkOutput = truncateLog(stderr);
          log(`[supervisor] Post-turn check exited with code ${checkExitCode}`);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logWarn(`[supervisor] Post-turn check failed to execute: ${errorMessage}`);
        checkExitCode = -1;
        checkOutput = errorMessage;
      }
      updatePhase(status, 'post_turn_check_done', protocolDir);
    }

    // Phase 4: Post-turn sync-with-upstream (if requested and parent_branch is specified)
    if (cmd.parent_branch && cmd.sync_after_work) {
      updatePhase(status, 'post_turn_sync', protocolDir);

      // Capture the upstream branch SHA before merging (updates the stored SHA for future diffs)
      const upstreamSha = await getBranchSha(worktreePath, cmd.parent_branch);
      if (upstreamSha) {
        status.upstream_merge_sha = upstreamSha;
        writeStatus(protocolDir, status);
      }

      try {
        const postTurnConflicts = await runSyncWithUpstream(worktreePath, cmd.parent_branch, cmd.model_id, result.session_id);
        allMergeConflicts.push(...postTurnConflicts);
        updatePhase(status, 'post_turn_sync_done', protocolDir);
      } catch (err) {
        // Post-turn sync failure is non-fatal — agent's work is already done
        const errorMessage = err instanceof Error ? err.message : String(err);
        logWarn(`[supervisor] Post-turn sync failed: ${errorMessage}. Skipping.`);

        // Abort any in-progress merge to leave the branch clean
        await runGit(['merge', '--abort'], { cwd: worktreePath });
      }
    }

    // Write response
    updatePhase(status, 'writing_response', protocolDir);
    log(`[supervisor] Writing response: violations=${violations.length}, check_exit_code=${checkExitCode}, merge_conflicts=${allMergeConflicts.length}`);

    // Violations are stored in response.violations (structured field) and
    // rendered by the display layer — do NOT prepend them into resultText.
    // The pushback response IS appended so reviewers can see the agent's justification.
    let resultText = result.result;
    if (pushbackResponse) {
      resultText += '\n\n---\n\n## Permission Violation Review\n\n' + pushbackResponse;
    }

    const response: CompletedResponse = {
      status: 'completed',
      result: resultText,
      session_id: result.session_id,
      usage: result.usage,
      ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
      ...(violations.length > 0 ? { violations, pushed_back: true } : {}),
      ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
      ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
    };
    log(`[supervisor] Response written: status=${response.status}, pushed_back=${response.pushed_back}`);
    writeResponse(protocolDir, response);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Work phase failed: ${errorMessage}`);

    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Work phase failed: ${errorMessage}`,
      phase: 'work',
    };

    // Enrich with crash details if available
    if (err instanceof CrashError) {
      errorResponse.exit_code = err.exitCode;
      errorResponse.stderr = err.stderr;
      errorResponse.stdout_error = err.stdoutError;
      errorResponse.duration_ms = err.durationMs;
    } else if (err instanceof WatchdogTimeoutError) {
      errorResponse.duration_ms = err.durationMs;
    }

    writeResponse(protocolDir, errorResponse);
  }
}

/**
 * Handle a sync command: merge upstream branch, write response, return.
 * No agent work phase runs — this is purely a merge operation.
 */
async function handleSyncCommand(cmd: SyncCommand, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  // Pre-turn worktree health check
  await recoverWorktreeState(worktreePath);

  const preTurnSha = await getHeadSha(worktreePath);
  log(`[supervisor] Sync command: pre-turn SHA ${preTurnSha.substring(0, 8)}, parent_branch=${cmd.parent_branch}`);

  const status: SupervisorStatus = {
    phase: 'reading_command',
    task_id: cmd.task_id,
    command_type: 'sync',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pre_turn_sha: preTurnSha,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  // Write MCP server config so Claude Code discovers lazy tools during conflict resolution
  try {
    const mcpConfig = runner.mcpServerConfig(cmd.task_id, worktreePath);
    await writeMcpConfig(mcpConfig);
    log(`[supervisor] Wrote MCP config for task ${cmd.task_id.substring(0, 8)}`);
  } catch (err) {
    // Non-fatal: Claude Code will work without MCP tools (they just won't be available)
    logWarn(`[supervisor] Failed to write MCP config: ${err instanceof Error ? err.message : err}`);
  }

  // Pre-approve lazy MCP tools so Claude Code doesn't prompt for permission
  try {
    const toolNames = allTools.map(t => t.name);
    await writeToolPermissions(toolNames);
    log(`[supervisor] Pre-approved ${toolNames.length} MCP tools`);
  } catch (err) {
    logWarn(`[supervisor] Failed to write tool permissions: ${err instanceof Error ? err.message : err}`);
  }

  const allMergeConflicts: MergeConflict[] = [];

  // Merge upstream branch
  updatePhase(status, 'merge_and_fix', protocolDir);

  const upstreamSha = await getBranchSha(worktreePath, cmd.parent_branch);
  if (upstreamSha) {
    status.upstream_merge_sha = upstreamSha;
    writeStatus(protocolDir, status);
  }

  try {
    // INVARIANT: Pass agent_session_id so conflict resolution reuses the existing
    // agent session (add-session-merge) instead of cold-starting a fresh one.
    const conflicts = await runSyncWithUpstream(worktreePath, cmd.parent_branch, cmd.model_id, cmd.agent_session_id);
    allMergeConflicts.push(...conflicts);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Sync merge failed: ${errorMessage}`);

    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Sync merge failed: ${errorMessage}`,
      phase: 'merge_and_fix',
    };
    writeResponse(protocolDir, errorResponse);
    return;
  }

  const postMergeSha = await getHeadSha(worktreePath);
  status.post_merge_sha = postMergeSha;
  updatePhase(status, 'merge_and_fix_done', protocolDir);

  const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-merge/${postMergeSha.substring(0, 8)}`;
  await tagHead(worktreePath, tagName);

  // Write completed response
  updatePhase(status, 'writing_response', protocolDir);
  log(`[supervisor] Sync complete. Post-merge SHA: ${postMergeSha.substring(0, 8)}`);

  const response: CompletedResponse = {
    status: 'completed',
    result: 'Sync merge completed successfully.',
    session_id: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
  };
  writeResponse(protocolDir, response);
}

// --- Helpers ---

function updatePhase(status: SupervisorStatus, phase: SupervisorPhase, dir: string): void {
  status.phase = phase;
  status.updated_at = new Date().toISOString();
  writeStatus(dir, status);
  log(`[supervisor] Phase: ${phase}`);
}

async function getHeadSha(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    return 'unknown';
  }
  return result.stdout;
}

async function getBranchSha(cwd: string, branch: string): Promise<string | null> {
  const result = await runGit(['rev-parse', branch], { cwd });
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to get SHA for branch ${branch}: ${result.stderr}`);
    return null;
  }
  return result.stdout;
}

async function tagHead(cwd: string, tagName: string): Promise<void> {
  // Best-effort tagging — don't fail the turn if tagging fails
  const result = await runGit(['tag', '-f', tagName], { cwd });
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to create tag ${tagName}: ${result.stderr}`);
  } else {
    log(`[supervisor] Tagged HEAD as ${tagName}`);
  }
}