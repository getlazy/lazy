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
import { spawnSync } from '../utils/spawn';
import { runGit } from '../utils/git';
import { detectViolations } from './permissions';

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
  recoverWorktreeState(worktreePath);

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

    const turnStartedAt = command.type !== 'stop' ? (command as StartCommand | UnblockCommand).turn_started_at : undefined;
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
function recoverWorktreeState(worktreePath: string): void {
  // Check for in-progress merge (MERGE_HEAD exists)
  if (hasMergeInProgress(worktreePath)) {
    logWarn('[supervisor] Detected in-progress merge from previous crash. Aborting merge to recover clean state.');
    abortMergeIfInProgress(worktreePath);
  }

  // Check for unmerged files (conflict markers without MERGE_HEAD — shouldn't happen but be safe)
  if (hasUnmergedFiles(worktreePath)) {
    logWarn('[supervisor] Detected unmerged files in worktree. Resetting to clean state.');
    runGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath });
  }
}

/**
 * Handle a start or unblock command: run phases and write response.
 */
async function handleTurnCommand(command: Command, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  if (command.type === 'stop') return; // handled by caller

  const cmd = command as StartCommand | UnblockCommand;
  const isResume = command.type === 'unblock' && !!(command as UnblockCommand).agent_session_id;

  // Pre-turn worktree health check: ensure no leftover merge state
  recoverWorktreeState(worktreePath);

  // Record pre-turn SHA for deterministic turn diff
  const preTurnSha = getHeadSha(worktreePath);

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
      const conflicts = await runSyncWithRemote(worktreePath, cmd.remote_branch, cmd.model_id);
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

    const postRemoteSyncSha = getHeadSha(worktreePath);
    status.post_remote_sync_sha = postRemoteSyncSha;
    updatePhase(status, 'sync_with_remote_done', protocolDir);

    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-remote-sync/${postRemoteSyncSha.substring(0, 8)}`;
    tagHead(worktreePath, tagName);
  }

  // Phase 2: Pre-turn sync-with-upstream (if requested and parent_branch is specified)
  // Backward compat: if sync_before_work is undefined but parent_branch is set,
  // default to true (old behavior where parent_branch alone triggered pre-turn sync)
  const syncBeforeWork = cmd.sync_before_work ?? (cmd.parent_branch ? true : false);
  if (cmd.parent_branch && syncBeforeWork) {
    updatePhase(status, 'merge_and_fix', protocolDir);

    // Capture the upstream branch SHA before merging for accurate diff scope
    const upstreamSha = getBranchSha(worktreePath, cmd.parent_branch);
    if (upstreamSha) {
      status.upstream_merge_sha = upstreamSha;
      writeStatus(protocolDir, status);
    }

    try {
      const conflicts = await runSyncWithUpstream(worktreePath, cmd.parent_branch, cmd.model_id);
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
    const postMergeSha = getHeadSha(worktreePath);
    status.post_merge_sha = postMergeSha;
    updatePhase(status, 'merge_and_fix_done', protocolDir);

    // Create a deterministic tag for the merge point
    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-merge/${postMergeSha.substring(0, 8)}`;
    tagHead(worktreePath, tagName);
  }

  // Write MCP server config so Claude Code discovers lazy tools
  try {
    const mcpConfig = runner.mcpServerConfig(cmd.task_id, worktreePath);
    writeMcpConfig(mcpConfig);
    log(`[supervisor] Wrote MCP config for task ${cmd.task_id.substring(0, 8)}`);
  } catch (err) {
    // Non-fatal: Claude Code will work without MCP tools (they just won't be available)
    logWarn(`[supervisor] Failed to write MCP config: ${err instanceof Error ? err.message : err}`);
  }

  // Pre-approve lazy MCP tools so Claude Code doesn't prompt for permission
  try {
    const toolNames = allTools.map(t => t.name);
    writeToolPermissions(toolNames);
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

    // Record agent's work endpoint (before any post-turn sync)
    const postWorkSha = getHeadSha(worktreePath);
    status.post_work_sha = postWorkSha;
    writeStatus(protocolDir, status);

    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-work/${postWorkSha.substring(0, 8)}`;
    tagHead(worktreePath, tagName);

    // Phase 3b: Check for file permission violations
    const protectedPatterns = cmd.protected_patterns ?? [];
    const startShaWork = status.post_merge_sha ?? status.pre_turn_sha ?? preTurnSha;
    const violations = detectViolations(worktreePath, startShaWork, postWorkSha, protectedPatterns);
    if (violations.length > 0) {
      log(`[supervisor] Detected ${violations.length} file permission violation(s)`);
    }

    // Phase 4: Post-turn sync-with-upstream (if requested and parent_branch is specified)
    if (cmd.parent_branch && cmd.sync_after_work) {
      updatePhase(status, 'post_turn_sync', protocolDir);

      // Capture the upstream branch SHA before merging (updates the stored SHA for future diffs)
      const upstreamSha = getBranchSha(worktreePath, cmd.parent_branch);
      if (upstreamSha) {
        status.upstream_merge_sha = upstreamSha;
        writeStatus(protocolDir, status);
      }

      try {
        const postTurnConflicts = await runSyncWithUpstream(worktreePath, cmd.parent_branch, cmd.model_id);
        allMergeConflicts.push(...postTurnConflicts);
        updatePhase(status, 'post_turn_sync_done', protocolDir);
      } catch (err) {
        // Post-turn sync failure is non-fatal — agent's work is already done
        const errorMessage = err instanceof Error ? err.message : String(err);
        logWarn(`[supervisor] Post-turn sync failed: ${errorMessage}. Skipping.`);

        // Abort any in-progress merge to leave the branch clean
        runGit(['merge', '--abort'], { cwd: worktreePath });
      }
    }

    // Write response
    updatePhase(status, 'writing_response', protocolDir);

    // Build result text, prepending violations if any
    let resultText = result.result;
    if (violations.length > 0) {
      const violationList = violations.map(v => `  - ${v.file}`).join('\n');
      resultText = `**FILE PERMISSION VIOLATIONS**\n\nThe following protected files were modified or deleted:\n${violationList}\n\n${resultText}`;
    }

    const response: CompletedResponse = {
      status: 'completed',
      result: resultText,
      session_id: result.session_id,
      usage: result.usage,
      ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
      ...(violations.length > 0 ? { violations } : {}),
    };
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

// --- Helpers ---

function updatePhase(status: SupervisorStatus, phase: SupervisorPhase, dir: string): void {
  status.phase = phase;
  status.updated_at = new Date().toISOString();
  writeStatus(dir, status);
  log(`[supervisor] Phase: ${phase}`);
}

function getHeadSha(cwd: string): string {
  const result = runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    return 'unknown';
  }
  return result.stdout;
}

function getBranchSha(cwd: string, branch: string): string | null {
  const result = runGit(['rev-parse', branch], { cwd });
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to get SHA for branch ${branch}: ${result.stderr}`);
    return null;
  }
  return result.stdout;
}

function tagHead(cwd: string, tagName: string): void {
  // Best-effort tagging — don't fail the turn if tagging fails
  const result = runGit(['tag', '-f', tagName], { cwd });
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to create tag ${tagName}: ${result.stderr}`);
  } else {
    log(`[supervisor] Tagged HEAD as ${tagName}`);
  }
}
