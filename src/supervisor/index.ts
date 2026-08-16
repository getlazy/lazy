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
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
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
  AskCommand,
  SyncCommand,
  StopCommand,
  PreAcceptCommand,
  SupervisorStatus,
  SupervisorPhase,
  CompletedResponse,
  ErrorResponse,
  WorktreeRecovery,
} from '../protocol/types';
import type { MergeConflict } from '../types';
import { runSyncWithUpstream, runSyncWithRemote, type MergeGuardOptions, hasUnmergedFiles, abortMergeIfInProgress, settleConflictedWorktree } from './merge';
import { readWorktreeMergeState, describeMergeState, isMidMerge } from '../git/operations';
import { runWork, CrashError, WatchdogTimeoutError, GracefulExitTimeoutError, FatalAgentError } from './work';
import { makeRetryStatusHandler } from './retry-status';
import askSystemPrompt from '../prompts/ask-system-prompt.md' with { type: 'text' };
import { runPostTurnCheck } from './post-turn-check';
import { resolveWatchdogTimeout } from './watchdog';
import { readUsage } from './usage';
import { getAgent } from '../agent/registry';
import { log, logError, logWarn, resetTimer } from './log';
import { prepareTurnMcp } from './mcp-setup';
import { clearTurnHandoff, handoffField } from './turn-handoff';
import { createRunnerFromType } from '../runner';
import type { Runner, RunnerType } from '../runner/types';
import { PROTOCOL_VERSION } from '../protocol/types';
import { VERSION } from '../version';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { elevatedResetHardHead, elevatedTag } from './elevated-git';
import { detectViolations } from './permissions';
import { runPermissionPushback } from './pushback';
import { detectSkippedMaintainEntries, runMaintainFollowup, renderMaintainContext } from './maintain';
import { runPreAcceptGate, DEFAULT_PRE_ACCEPT_TIMEOUT_SECS } from './pre-accept';
import type { CompletedResponseBundle } from '../protocol/types';
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
async function checkRequiredTools(runner: Runner): Promise<void> {
  const checks = runner.supervisorToolChecks();

  for (const { cmd, name, hint } of checks) {
    // Async spawn (not spawnSync) so the supervisor event loop is never blocked.
    const proc = spawn(['which', cmd], { stdout: 'ignore', stderr: 'ignore' });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      logError(`[supervisor] ${hint}`);
      process.exit(1);
    }
    log(`[supervisor] Found ${name} ✓`);
  }
}

/** Exit code used in one-shot mode to signal that a stop command was received. */
export const ONE_SHOT_STOP_EXIT_CODE = 42;

/**
 * Launch settings to stamp on a response so the reconciler can record them on
 * the turn it writes.
 *
 * `cmd.model_id` is the REQUESTED model (the resolved `--model` value the daemon
 * sent — usually a tier alias); it lands on the response as `model`.
 * `reportedModelId` is what the agent said it actually ran, and lands as
 * `model_id`. Omitting a field is meaningful: it records that the setting was
 * not in force / not reported, rather than guessing a default.
 *
 * Called per invocation, not per bundle: push-back and maintain are separate
 * agent runs and can report a different concrete model than the work phase.
 */
function launchSettings(
  cmd: { model_id?: string; effort?: string },
  reportedModelId?: string,
): { model?: string; model_id?: string; effort?: string } {
  return {
    ...(cmd.model_id ? { model: cmd.model_id } : {}),
    ...(reportedModelId ? { model_id: reportedModelId } : {}),
    ...(cmd.effort ? { effort: cmd.effort } : {}),
  };
}

/**
 * Check whether the command's protocol_version matches the supervisor's own.
 * Returns null on match, or an error message describing the mismatch.
 *
 * INVARIANT: The supervisor must refuse commands whose wire-protocol version
 * does not match its own. This catches the case where a running container has
 * an older/newer supervisor that doesn't understand the host's command shape
 * or RPC signatures. Lazy versions (the package version) may differ freely as
 * long as the protocol versions agree — the engineer commonly runs different
 * lazy projects at different lazy versions on the same machine.
 *
 * v0.11 and earlier hosts don't send `protocol_version` at all. They land in
 * the `undefined` branch and get the same "rebuild containers" error they
 * would have under the previous lazy_version gate.
 */
export function checkProtocolVersion(commandVersion: number | undefined, supervisorVersion: number): string | null {
  if (commandVersion === supervisorVersion) return null;
  const got = commandVersion === undefined ? 'unknown' : String(commandVersion);
  return `Protocol version mismatch (got ${got}, expected ${supervisorVersion}). Run \`lazy upgrade\` to rebuild containers.`;
}

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
  await checkRequiredTools(runner);

  // A half-merged worktree left by a previous crash is REPORTED here, not
  // rolled back. Startup is the one moment with no command to attribute a
  // rollback to, and a supervisor is (re)started for every turn — so rolling
  // back here quietly consumed the evidence before the per-command recovery
  // below could record it. That is how a stranded merge once vanished between
  // two commands leaving only "reset: moving to HEAD" in the reflog
  // (fix-sync-silent-conflict). The next command's recovery cleans it up and
  // says so on its response.
  const startupMergeState = await readWorktreeMergeState(worktreePath);
  if (isMidMerge(startupMergeState)) {
    logWarn(
      `[supervisor] Worktree is mid-merge on startup (${describeMergeState(startupMergeState)}). ` +
      `Leaving it in place; the next command will recover it and record what it discarded.`,
    );
  }

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

    const turnStartedAt = (command.type === 'start' || command.type === 'unblock' || command.type === 'ask' || command.type === 'pre_accept')
      ? (command as StartCommand | UnblockCommand | AskCommand | PreAcceptCommand).turn_started_at
      : undefined;
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

    // INVARIANT: Reject commands whose wire protocol doesn't match this supervisor.
    // When the protocol changes between releases, an older supervisor running in a
    // stale container can't safely execute commands written by a newer host (and
    // vice versa). Refuse and tell the user to rebuild containers. The full lazy
    // version is logged for debugging but is NOT part of the gate — different
    // projects on one machine may run different lazy versions concurrently.
    const cmd = command as StartCommand | UnblockCommand | SyncCommand;
    const versionError = checkProtocolVersion(cmd.protocol_version, PROTOCOL_VERSION);
    if (versionError) {
      logError(`[supervisor] ${versionError} (supervisor lazy v${VERSION})`);
      const versionErrorResponse: ErrorResponse = {
        status: 'error',
        error: versionError,
        phase: 'reading_command',
      };
      writeResponse(protocolDir, versionErrorResponse);
      log('[supervisor] Turn complete (protocol version mismatch).');
      if (oneShot) {
        log('[supervisor] One-shot mode: exiting with code 0 (turn done).');
        break;
      }
      continue;
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
 * Save the worktree's current diff against HEAD so a rollback is recoverable.
 *
 * Rolling back a mid-merge worktree destroys whatever resolution was in it.
 * CLAUDE.md's recovery-file rule exists for exactly this: work that cannot be
 * kept must at least be retrievable. `.lazy/recovery/` is gitignored, so writing
 * here never dirties the worktree the caller is about to clean.
 *
 * Returns the patch path, or null when nothing could be saved — saving is
 * best-effort and must never stop the recovery it precedes.
 */
async function saveWorktreeRollbackPatch(worktreePath: string): Promise<string | null> {
  try {
    const diff = await runGit(['diff', 'HEAD'], { cwd: worktreePath });
    if (diff.exitCode !== 0 || !diff.stdout.trim()) return null;
    const dir = join(worktreePath, '.lazy', 'recovery');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const patchPath = join(dir, `merge-rollback-${stamp}.patch`);
    await writeFile(patchPath, diff.stdout.endsWith('\n') ? diff.stdout : `${diff.stdout}\n`, 'utf-8');
    return patchPath;
  } catch (err) {
    logWarn(
      `[supervisor] Could not save a rollback patch before recovering the worktree: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Recover worktree state from a previous crash. Aborts any in-progress
 * merge and ensures the worktree is clean before work begins.
 *
 * INVARIANT (fix-sync-silent-conflict): this rollback is never silent. A
 * mid-merge worktree may hold a real, in-progress resolution — a human's or an
 * agent's — and discarding it used to leave nothing behind but a `logWarn` in a
 * container log and a bare "reset: moving to HEAD" in the reflog. Now the
 * discarded state is saved to `.lazy/recovery/` first and the caller puts the
 * returned report on the response, where the reconciler journals it against the
 * task. Returns null when there was nothing to recover (the normal case).
 */
async function recoverWorktreeState(
  worktreePath: string,
  context: string,
): Promise<WorktreeRecovery | null> {
  const state = await readWorktreeMergeState(worktreePath);
  if (!isMidMerge(state)) return null;

  const found: WorktreeRecovery['found'] = state.mergeInProgress
    ? 'merge_in_progress'
    : 'unmerged_files';
  logWarn(
    `[supervisor] Found a half-merged worktree before the ${context} command ` +
    `(${describeMergeState(state)}). Rolling it back — any resolution in it is being discarded.`,
  );

  const patchPath = await saveWorktreeRollbackPatch(worktreePath);
  if (patchPath) {
    logWarn(`[supervisor] Saved the discarded worktree state to ${patchPath}`);
  }

  if (state.mergeInProgress) {
    await abortMergeIfInProgress(worktreePath);
  }
  if (await hasUnmergedFiles(worktreePath)) {
    // Unmerged paths with no MERGE_HEAD (or an abort that did not clear them):
    // nothing but a hard reset settles this.
    logWarn('[supervisor] Unmerged files remain after abort. Resetting the worktree to HEAD.');
    await elevatedResetHardHead(worktreePath);
  }

  const after = await readWorktreeMergeState(worktreePath);
  const settled = !isMidMerge(after);
  const summary =
    `Rolled back a half-merged worktree found before the ${context} command ` +
    `(${describeMergeState(state)})` +
    (patchPath ? `. The discarded changes were saved to ${patchPath}` : '') +
    (settled ? '.' : `. WARNING: the worktree is STILL mid-merge (${describeMergeState(after)}).`);
  if (!settled) logError(`[supervisor] ${summary}`);

  return {
    found,
    summary,
    files: state.unmergedFiles,
    ...(patchPath ? { patch_path: patchPath } : {}),
    context,
  };
}

/**
 * Guard timeouts for merge-resolution agent turns.
 *
 * A merge turn is an ordinary agent turn — it edits files, runs tests, and
 * commits — so it gets the same two guards as the work phase, from the same
 * config. The merge phase shells out to `claude` directly rather than through
 * the agent abstraction, so the "0 = use the agent default" fallback resolves
 * against claude-code.
 */
function mergeGuards(cmd: {
  watchdog_output_timeout_ms?: number;
  wind_down_timeout_ms?: number;
}): MergeGuardOptions {
  return {
    noProgressTimeoutMs: resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      getAgent('claude-code').defaultWatchdogTimeoutMs(),
    ),
    windDownTimeoutMs: cmd.wind_down_timeout_ms ?? 0,
  };
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

  // Ask commands run only the work + writing_response phases. No integration
  // machinery (sync, merge, violation check, post-turn check) runs — this is
  // a read-only Q&A turn owned end-to-end by the daemon.
  if (command.type === 'ask') {
    await handleAskCommand(command as AskCommand, config, runner);
    return;
  }

  // Pre-accept commands run the agent's final validation turn (write mode), then
  // re-run the configured gate commands as the authoritative merge gate. No
  // upstream/post-turn sync or violation detection — the daemon owns this turn
  // end-to-end and drives the merge from the response.
  if (command.type === 'pre_accept') {
    await handlePreAcceptCommand(command as PreAcceptCommand, config, runner);
    return;
  }

  const cmd = command as StartCommand | UnblockCommand;
  const isResume = command.type === 'unblock' && !!(command as UnblockCommand).agent_session_id;
  log(`[supervisor] Command fields: protected_patterns=${JSON.stringify(cmd.protected_patterns)}, post_turn_check=${JSON.stringify(cmd.post_turn_check)}, parent_branch=${cmd.parent_branch}, agent_id=${cmd.agent_id}`);

  // Pre-turn worktree health check: ensure no leftover merge state
  const turnRecovery = await recoverWorktreeState(worktreePath, cmd.type);

  // Record pre-turn SHA for deterministic turn diff
  const preTurnSha = await getHeadSha(worktreePath);
  log(`[supervisor] Pre-turn SHA: ${preTurnSha.substring(0, 8)}`);

  // Initialize status
  const initialNow = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'reading_command',
    task_id: cmd.task_id,
    command_type: cmd.type,
    started_at: initialNow,
    updated_at: initialNow,
    phase_started_at: initialNow,
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
      const conflicts = await runSyncWithRemote(
        worktreePath,
        cmd.remote_branch,
        cmd.model_id,
        remoteSyncSessionId,
        mergeGuards(cmd),
      );
      allMergeConflicts.push(...conflicts);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Sync-with-remote failed: ${errorMessage}`);

      // INVARIANT (fix-sync-silent-conflict): a failed merge phase never returns
      // with a half-merged worktree. Settle it first, and report what settling
      // did (or could not do) on the response itself.
      const mergeState = await settleConflictedWorktree(worktreePath);
      const errorResponse: ErrorResponse = {
        status: 'error',
        error: `Sync-with-remote failed: ${errorMessage}${mergeState.settled ? '' : ` — ${mergeState.detail}`}`,
        phase: 'sync_with_remote',
        merge_state: mergeState,
        ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
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
      const syncResult = await runSyncWithUpstream(
        worktreePath,
        cmd.parent_branch,
        cmd.model_id,
        mergeSessionId,
        undefined,
        mergeGuards(cmd),
      );
      allMergeConflicts.push(...syncResult.conflicts);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Pre-turn sync-with-upstream failed: ${errorMessage}`);

      // INVARIANT (fix-sync-silent-conflict): see the sync-with-remote catch above.
      const mergeState = await settleConflictedWorktree(worktreePath);
      const errorResponse: ErrorResponse = {
        status: 'error',
        error: `Merge-and-fix failed: ${errorMessage}${mergeState.settled ? '' : ` — ${mergeState.detail}`}`,
        phase: 'merge_and_fix',
        merge_state: mergeState,
        ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
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

  // Write this turn's MCP server config + permissions so Claude Code discovers
  // the lazy tools. Write mode — this turn may commit, journal, and run subtasks.
  await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: false });

  // Start the turn with an empty handoff file, so anything collected afterwards
  // is unambiguously from THIS turn's agent.
  await clearTurnHandoff(worktreePath, log);

  // Phase 3: Work (actual task work via Claude Code)
  updatePhase(status, 'work', protocolDir);

  try {
    const claudeSessionId = command.type === 'unblock'
      ? (command as UnblockCommand).agent_session_id
      : undefined;

    // Callback to update status when entering retry mode
    const onRetryStateChange = makeRetryStatusHandler(status, protocolDir);

    // Resolve the agent from the command (defaults to claude-code for backward compat)
    const agent = getAgent(cmd.agent_id ?? 'claude-code');
    log(`[supervisor] Using agent: ${agent.id}`);

    // Resolve effective watchdog timeout: config value (0 = use agent default)
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const permissionMode = command.type === 'unblock'
      ? (command as UnblockCommand).permission_mode
      : undefined;

    // Up-front maintained-file context: tell the agent which files this project
    // expects kept up to date (and why) while it works. No-op when unconfigured.
    const maintainContext = renderMaintainContext(cmd.maintain);
    const systemPromptForWork = maintainContext
      ? `${cmd.system_prompt ?? ''}\n\n${maintainContext}`
      : cmd.system_prompt;

    const result = await runWork(
      agent,
      runner,
      worktreePath,
      cmd.prompt,
      systemPromptForWork,
      cmd.model_id,
      claudeSessionId,
      protocolDir,
      onRetryStateChange,
      undefined, // _executeOverride
      effectiveWatchdogMs,
      cmd.effort,
      permissionMode,
      cmd.wind_down_timeout_ms,
      cmd.agent_extra_args,
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

    // Compute branch point SHA: the point before the task created any files.
    // Files not present at the branch point were created by the task itself and are
    // exempt from permission violations (they're not pre-existing files).
    //
    // Primary: merge-base with parent branch (accounts for upstream merges).
    // Fallback: cmd.branch_point_sha (the session's git_start_sha, always available).
    let branchPointSha: string | undefined = cmd.branch_point_sha;
    if (cmd.parent_branch && protectedPatterns.length > 0) {
      const mergeBaseResult = await runGit(
        ['merge-base', cmd.parent_branch, 'HEAD'],
        { cwd: worktreePath },
      );
      if (mergeBaseResult.exitCode === 0 && mergeBaseResult.stdout.trim()) {
        branchPointSha = mergeBaseResult.stdout.trim();
        log(`[supervisor] Branch point SHA (merge-base with ${cmd.parent_branch}): ${branchPointSha.substring(0, 8)}`);
      } else {
        log(`[supervisor] Could not compute merge-base with ${cmd.parent_branch} — using branch_point_sha fallback`);
      }
    }
    if (branchPointSha) {
      log(`[supervisor] Using branch point SHA: ${branchPointSha.substring(0, 8)}${!cmd.parent_branch ? ' (from command)' : ''}`);
    }

    log(`[supervisor] Checking permissions: ${protectedPatterns.length} pattern(s) [${protectedPatterns.join(', ')}], diff ${startShaWork.substring(0, 8)}..${postWorkSha.substring(0, 8)}`);
    log(`[supervisor] status.post_merge_sha=${status.post_merge_sha?.substring(0, 8)}, status.pre_turn_sha=${status.pre_turn_sha?.substring(0, 8)}, preTurnSha=${preTurnSha.substring(0, 8)}`);
    let violations = await detectViolations(worktreePath, startShaWork, postWorkSha, protectedPatterns, branchPointSha);
    log(`[supervisor] Violations detected: ${violations.length}`);

    // Supervised follow-up invocations (push-back, maintain nudge). Each is a
    // SEPARATE `claude -p` invocation and becomes a FULL CompletedResponse in the
    // bundle — its own commits/SHAs, usage (incl. cache), and (for push-back) its
    // own re-detected violation set. The work turn's response stays clean; the
    // reconciler materializes each as a discrete supervisor→agent turn pair.
    //
    // INVARIANT: status.post_work_sha stays pinned at the WORK end (postWorkSha)
    // — it is NOT advanced past supervised commits. That kills the double-count:
    // the work turn's diff covers only work commits; each supervised response
    // carries its OWN start/end SHA window so its commits attribute to ITS turn.
    const supervisedResponses: CompletedResponse[] = [];
    let lastInvocationSha = postWorkSha;
    // The session the next supervised invocation resumes from. Starts at the work
    // session; advances to the push-back session so the maintain nudge continues the
    // conversation AFTER the push-back exchange rather than branching off the work turn.
    let lastSessionId = result.session_id;
    // Whether the push-back exchange ran this command. Tracked explicitly (not derived
    // from the FINAL violation set) so it stays true even when the agent RESOLVED the
    // violations. The maintain step reads it to guarantee it never loops back into a
    // second push-back round.
    let pushedBack = false;

    // Push-back: give the agent one chance to self-correct before blocking
    if (violations.length > 0) {
      pushedBack = true;
      log(`[supervisor] Detected ${violations.length} file permission violation(s). Pushing back...`);
      updatePhase(status, 'permission_pushback', protocolDir);

      const pushbackResult = await runPermissionPushback(
        agent,
        worktreePath,
        result.session_id,
        violations,
        cmd.model_id,
        cmd.effort,
        cmd.agent_extra_args,
      );

      // Re-check violations on the new HEAD (agent may have reverted some files).
      const postPushbackSha = await getHeadSha(worktreePath);
      violations = await detectViolations(worktreePath, startShaWork, postPushbackSha, protectedPatterns, branchPointSha);
      log(`[supervisor] After push-back: ${violations.length} violation(s) remaining`);
      updatePhase(status, 'permission_pushback_done', protocolDir);

      // The push-back response owns exactly the commits made during ITS invocation
      // (lastInvocationSha..postPushbackSha) and carries the FINAL violation set
      // (empty array when the agent resolved them — so the reconciler sees "checked,
      // none remain" rather than falling back to the work response's stale set).
      supervisedResponses.push({
        status: 'completed',
        result: pushbackResult.response,
        session_id: pushbackResult.session_id,
        usage: pushbackResult.usage,
        ...launchSettings(cmd, pushbackResult.model_id),
        start_sha_work: lastInvocationSha,
        end_sha_work: postPushbackSha,
        violations,
        supervised: { kind: 'permission_pushback', prompt: pushbackResult.prompt },
      });

      if (postPushbackSha !== lastInvocationSha) {
        const pushbackTagName = `turn/${cmd.task_id.substring(0, 8)}/post-work/${postPushbackSha.substring(0, 8)}`;
        await tagHead(worktreePath, pushbackTagName);
      }
      lastInvocationSha = postPushbackSha;
      // Resume the maintain nudge from the push-back session so it lands AFTER the
      // push-back exchange in one continuous conversation.
      lastSessionId = pushbackResult.session_id;
    }

    // Phase 3b-2: Maintained-file skip check. The inverse of protected files —
    // groups the project expects kept up to date. When the turn touched none of
    // a group's files, nudge the agent once to update or justify skipping.
    //
    // PRECEDENCE INVARIANT (maintain-nudge-violation-precedence): the maintain
    // nudge runs AFTER the push-back exchange and is INDEPENDENT of its outcome.
    //   - It fires whether push-back left violations or the agent resolved them —
    //     it is NOT gated on `violations.length === 0`. (Rationale: lazy.toml is
    //     itself a protected file, so every turn that edits it would otherwise
    //     never get a maintain nudge, making the feature look inert.)
    //   - It must NEVER re-trigger push-back. Push-back is single-shot and already
    //     ran above when `pushedBack` is set; this step only ever sends a maintain
    //     nudge, so there is no second push-back round. `pushedBack` is referenced
    //     here to document that the ordering (work → push-back → maintain) is
    //     deliberate and that re-running push-back is structurally impossible.
    //   - Sequencing: this nudge resumes `lastSessionId`, which advanced to the
    //     push-back session above, so the nudge lands after the push-back reply.
    //   - The maintain response carries NO `violations` field, so the reconciler's
    //     "last response with violations wins" rule still reads the push-back set —
    //     a still-violating turn stays `conflict` even though it also got nudged.
    const maintainEntries = cmd.maintain ?? [];
    if (maintainEntries.length > 0) {
      const maintainEndSha = await getHeadSha(worktreePath);
      const { skipped, turnHadChanges } = await detectSkippedMaintainEntries(
        worktreePath,
        startShaWork,
        maintainEndSha,
        maintainEntries,
      );
      log(`[supervisor] Maintained-file check: ${maintainEntries.length} group(s), turnHadChanges=${turnHadChanges}, skipped=${skipped.length}, violationsRemaining=${violations.length}, pushedBack=${pushedBack}`);

      if (skipped.length > 0) {
        log(`[supervisor] ${skipped.length} maintained group(s) skipped — prompting agent...`);
        const followup = await runMaintainFollowup(
          agent,
          worktreePath,
          lastSessionId,
          skipped,
          cmd.model_id,
          cmd.effort,
        );

        // The follow-up may have committed updates (it can do real work). Those
        // commits belong to the maintain turn — attribute them via its own SHA
        // window (lastInvocationSha..postFollowupSha), not the work turn.
        const postFollowupSha = await getHeadSha(worktreePath);
        supervisedResponses.push({
          status: 'completed',
          result: followup.response,
          session_id: followup.session_id,
          usage: followup.usage,
          ...launchSettings(cmd, followup.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postFollowupSha,
          supervised: { kind: 'maintain', prompt: followup.prompt },
        });

        if (postFollowupSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postFollowupSha.substring(0, 8)}`);
        }
        lastInvocationSha = postFollowupSha;
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
        const result = await runPostTurnCheck(
          cmd.post_turn_check,
          worktreePath,
          timeoutSecs * 1000,
        );
        checkExitCode = result.exitCode;
        const truncatedStderr = truncateLog(result.stderr);
        if (result.timedOut) {
          checkOutput =
            `Post-turn check timed out after ${timeoutSecs}s ` +
            `(killed with ${result.killSignal ?? 'SIGTERM'} after ${result.elapsedMs}ms)\n\n` +
            `--- stderr at timeout ---\n${truncatedStderr}`;
          logWarn(
            `[supervisor] Post-turn check timed out after ${timeoutSecs}s ` +
              `(killSignal=${result.killSignal}, elapsedMs=${result.elapsedMs})`,
          );
        } else {
          checkOutput = truncatedStderr;
          log(
            `[supervisor] Post-turn check exited with code ${checkExitCode} (elapsedMs=${result.elapsedMs})`,
          );
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
        const postTurnSync = await runSyncWithUpstream(
          worktreePath,
          cmd.parent_branch,
          cmd.model_id,
          result.session_id,
          undefined,
          mergeGuards(cmd),
        );
        allMergeConflicts.push(...postTurnSync.conflicts);
        updatePhase(status, 'post_turn_sync_done', protocolDir);
      } catch (err) {
        // Post-turn sync failure is non-fatal — agent's work is already done
        const errorMessage = err instanceof Error ? err.message : String(err);
        logWarn(`[supervisor] Post-turn sync failed: ${errorMessage}. Skipping.`);

        // Leave the branch settled. A failed abort used to be swallowed here,
        // which is one of the ways a half-merged worktree survived a turn that
        // reported success (fix-sync-silent-conflict).
        const settled = await settleConflictedWorktree(worktreePath);
        if (!settled.settled) {
          logError(`[supervisor] Post-turn sync left the worktree unsettled: ${settled.detail}`);
        }
      }
    }

    // Write response
    updatePhase(status, 'writing_response', protocolDir);
    log(`[supervisor] Writing response: violations=${violations.length}, supervised=${supervisedResponses.length}, check_exit_code=${checkExitCode}, merge_conflicts=${allMergeConflicts.length}`);

    // The WORK response (responses[0]) is kept CLEAN — supervised follow-ups are
    // NOT appended to it. Turn-level outputs (merge conflicts from pre-work merges,
    // the single post-turn check) attach here. Violations are NOT on the work
    // response: when present they were re-detected and carried on the push-back
    // response (the FINAL set). `pushed_back` records that the supervisor gave the
    // agent a chance to self-correct — true whenever push-back RAN, independent of
    // whether violations remained (so a resolved push-back still reports it).
    // Whatever the agent left in its handoff file because the lazy tools were
    // unreachable. Absent in the normal case.
    const handoff = await handoffField(worktreePath, log);

    const workResponse: CompletedResponse = {
      status: 'completed',
      result: result.result,
      session_id: result.session_id,
      usage: result.usage,
      ...launchSettings(cmd, result.model_id),
      ...(result.mcp_tools ? { mcp_tools: result.mcp_tools } : {}),
      ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
      ...handoff,
      ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
      ...(pushedBack ? { pushed_back: true } : {}),
      ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
      ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
    };

    const bundle: CompletedResponseBundle = {
      status: 'completed',
      responses: [workResponse, ...supervisedResponses],
    };
    log(`[supervisor] Response written: ${bundle.responses.length} invocation response(s), final violations=${violations.length}`);
    writeResponse(protocolDir, bundle);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Work phase failed: ${errorMessage}`);

    // Collect the handoff on the failure path too: a watchdog kill or a crash is
    // exactly when the agent's own account of the turn is most worth keeping.
    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Work phase failed: ${errorMessage}`,
      phase: 'work',
      ...launchSettings(cmd),
      ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
    };

    describeTurnFailure(errorResponse, err);

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
  const syncRecovery = await recoverWorktreeState(worktreePath, 'sync');

  const preTurnSha = await getHeadSha(worktreePath);
  log(`[supervisor] Sync command: pre-turn SHA ${preTurnSha.substring(0, 8)}, parent_branch=${cmd.parent_branch}`);

  const syncNow = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'reading_command',
    task_id: cmd.task_id,
    command_type: 'sync',
    started_at: syncNow,
    updated_at: syncNow,
    phase_started_at: syncNow,
    pre_turn_sha: preTurnSha,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  // MCP config for the conflict-resolution agent. Write mode: resolving a merge
  // means editing and committing.
  await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: false });
  await clearTurnHandoff(worktreePath, log);

  const allMergeConflicts: MergeConflict[] = [];

  // Merge upstream branch
  updatePhase(status, 'merge_and_fix', protocolDir);

  // Prefer the host-resolved SHA so the supervisor merges the exact commit
  // the daemon saw. If the supervisor's own ref lookup disagrees, the
  // warning below surfaces the mismatch — that warning is what will finally
  // pin down the original silent no-op sync root cause if it ever recurs.
  const commandUpstreamSha = cmd.upstream_sha;
  const branchResolvedSha = await getBranchSha(worktreePath, cmd.parent_branch);
  if (commandUpstreamSha) {
    status.upstream_merge_sha = commandUpstreamSha;
  } else if (branchResolvedSha) {
    status.upstream_merge_sha = branchResolvedSha;
  }
  writeStatus(protocolDir, status);

  if (commandUpstreamSha && branchResolvedSha && commandUpstreamSha !== branchResolvedSha) {
    // Loud warning: the daemon and the supervisor disagree about what the
    // parent branch points to. Per CLAUDE.md "errors are actionable", this
    // mismatch must not be silent — it's the exact class of bug that caused
    // the sync regression. We still merge the daemon's SHA (that's the one
    // the user asked about), but we surface the disagreement.
    logWarn(
      `[supervisor] Upstream ref disagreement for ${cmd.parent_branch}: ` +
      `daemon resolved ${commandUpstreamSha.substring(0, 8)} but container ` +
      `sees ${branchResolvedSha.substring(0, 8)}. Merging daemon's SHA.`,
    );
  }

  let syncResult;
  try {
    // INVARIANT: Pass agent_session_id so conflict resolution reuses the existing
    // agent session (add-session-merge) instead of cold-starting a fresh one.
    syncResult = await runSyncWithUpstream(
      worktreePath,
      cmd.parent_branch,
      cmd.model_id,
      cmd.agent_session_id,
      commandUpstreamSha,
      mergeGuards(cmd),
    );
    allMergeConflicts.push(...syncResult.conflicts);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Sync merge failed: ${errorMessage}`);

    // INVARIANT (fix-sync-silent-conflict): a sync ends in exactly one of three
    // states, all loud — merged and committed, conflicted with a resolution turn
    // recorded, or aborted with an actionable error. This is the third: settle the
    // worktree before reporting, so a failed sync can never return leaving UU
    // files behind with no resolution in flight.
    const mergeState = await settleConflictedWorktree(worktreePath);
    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Sync merge failed: ${errorMessage}${mergeState.settled ? '' : ` — ${mergeState.detail}`}`,
      phase: 'merge_and_fix',
      merge_state: mergeState,
      ...(syncRecovery ? { worktree_recovery: syncRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
    };
    writeResponse(protocolDir, errorResponse);
    return;
  }

  // INVARIANT (fix-sync-silent-conflict): a sync NEVER reports success over a
  // half-merged worktree. This is the backstop for the incident that motivated
  // this fix — the merge path returned a result while `UU` files were still on
  // disk, the task went back to `blocked`, and nothing anywhere said so. If the
  // tree is not settled here, that is a bug in the merge path, so we settle it
  // and fail loudly rather than papering over it with a success response.
  const postSyncState = await readWorktreeMergeState(worktreePath);
  if (isMidMerge(postSyncState)) {
    logError(
      `[supervisor] Sync reported success but the worktree is still mid-merge ` +
      `(${describeMergeState(postSyncState)}). Settling it and failing the sync.`,
    );
    const mergeState = await settleConflictedWorktree(worktreePath);
    const errorResponse: ErrorResponse = {
      status: 'error',
      error:
        `Sync merge left an unresolved merge in the worktree ` +
        `(${describeMergeState(postSyncState)}). ${mergeState.settled
          ? 'The merge was aborted; re-run `lazy sync` to retry it.'
          : mergeState.detail}`,
      phase: 'merge_and_fix',
      merge_state: mergeState,
      ...(syncRecovery ? { worktree_recovery: syncRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
    };
    writeResponse(protocolDir, errorResponse);
    return;
  }

  const postMergeSha = syncResult.postMergeSha;
  status.post_merge_sha = postMergeSha;
  updatePhase(status, 'merge_and_fix_done', protocolDir);

  const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-merge/${postMergeSha.substring(0, 8)}`;
  await tagHead(worktreePath, tagName);

  // Write completed response
  updatePhase(status, 'writing_response', protocolDir);
  log(`[supervisor] Sync complete. merged=${syncResult.merged} pre=${syncResult.preMergeSha.substring(0, 8)} post=${postMergeSha.substring(0, 8)} target=${syncResult.targetSha.substring(0, 8)}`);

  // Build an honest result message — never claim "Sync merge completed
  // successfully" when no merge actually happened (fix-sync-no-merge).
  const resultMessage = syncResult.merged
    ? (syncResult.conflicts.length > 0
      ? `Merged ${cmd.parent_branch} @ ${syncResult.targetSha.substring(0, 8)} with ${syncResult.conflicts.length} resolved conflict(s). HEAD: ${syncResult.preMergeSha.substring(0, 8)} → ${postMergeSha.substring(0, 8)}.`
      : `Merged ${cmd.parent_branch} @ ${syncResult.targetSha.substring(0, 8)}. HEAD: ${syncResult.preMergeSha.substring(0, 8)} → ${postMergeSha.substring(0, 8)}.`)
    : `Already up to date: HEAD (${syncResult.preMergeSha.substring(0, 8)}) already contains ${cmd.parent_branch} @ ${syncResult.targetSha.substring(0, 8)}. No merge performed.`;

  // The sync response is a bundle: the `supervisor`-authored merge announcement,
  // plus (only when the merge had conflicts) the agent's conflict-resolution reply
  // as a second full response. The `sync` marker tells the reconciler how to
  // record turns — a no-op merge (merged: false) records NO turn at all. For a
  // CLEAN merge the merge commit belongs to the announcement turn (SHA window
  // attached here); for a conflict merge the commit is the agent's and is
  // attributed to the resolution turn instead.
  const mergeResponse: CompletedResponse = {
    status: 'completed',
    result: resultMessage,
    session_id: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    sync: { merged: syncResult.merged, conflicts: syncResult.conflicts.length },
    // A rollback performed before this sync is reported on the response even
    // when the sync itself succeeded — the reconciler journals it against the
    // task so a discarded resolution is never invisible (fix-sync-silent-conflict).
    ...(syncRecovery ? { worktree_recovery: syncRecovery } : {}),
    ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
    ...(syncResult.merged && syncResult.conflicts.length === 0
      ? { start_sha_work: syncResult.preMergeSha, end_sha_work: postMergeSha }
      : {}),
  };

  const responses: CompletedResponse[] = [mergeResponse];
  if (syncResult.merged && syncResult.resolution) {
    responses.push({
      status: 'completed',
      result: syncResult.resolution.result,
      session_id: syncResult.resolution.session_id,
      usage: syncResult.resolution.usage,
      // A SyncCommand carries no `effort` (the daemon never resolves one for a
      // merge), so the conflict-resolution turn honestly records model only —
      // `effort` stays absent rather than being invented from the task default.
      ...launchSettings(cmd, syncResult.resolution.model_id),
      start_sha_work: syncResult.preMergeSha,
      end_sha_work: postMergeSha,
      // The conflict-resolution agent is the only agent this command runs, so
      // any handoff it left belongs to this turn.
      ...(await handoffField(worktreePath, log)),
    });
  }

  const bundle: CompletedResponseBundle = { status: 'completed', responses };
  writeResponse(protocolDir, bundle);
}

/**
 * Handle an ask command: run the work phase in plan mode, write response, return.
 *
 * An ask is a read-only Q&A turn. It skips every integration phase — no
 * sync, no merge, no violation detection, no post-turn check. The daemon
 * waits synchronously for response.json, so it owns the response file;
 * the CLI never polls.
 */
async function handleAskCommand(cmd: AskCommand, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  log(`[supervisor] Ask command for task ${cmd.task_id.substring(0, 8)} (effort=${cmd.effort ?? 'default'})`);

  const askNow = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'work',
    task_id: cmd.task_id,
    command_type: 'ask',
    started_at: askNow,
    updated_at: askNow,
    phase_started_at: askNow,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  try {
    const agent = getAgent(cmd.agent_id ?? 'claude-code');
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const onRetryStateChange = makeRetryStatusHandler(status, protocolDir);

    // Ask mode locks down write tools at four layers (defense in depth):
    //   1. --disallowedTools Bash/Write/Edit (see ClaudeCodeAgent.buildExecArgs)
    //   2. A read-only MCP server: the config written below spawns the in-agent
    //      MCP server with --read-only, so the write tools are never advertised
    //      and are refused before they can be proxied. This is the layer that
    //      holds for containerized agents — see prepareTurnMcp.
    //   3. LAZY_MCP_READ_ONLY=1 env var — write MCP tools (lazy_commit,
    //      lazy_comment) reject any call. The PID-1 wrapper
    //      restarts the supervisor per turn, so this env override is per-turn.
    //      Only effective when tools execute locally (host-process runner);
    //      under the daemon proxy the handlers run in the daemon, which never
    //      sees this variable. Layer 2 is what covers that case.
    //   4. Stern ask-system-prompt steering the agent to answer in text only.
    process.env.LAZY_MCP_READ_ONLY = '1';

    // An ask is still an agent turn, and it needs the READ-ONLY lazy tools to
    // answer questions about live task state. Without this the turn ran with
    // whatever ~/.claude.json the container happened to have — nothing at all
    // after a container relaunch, which is how asks lost their lazy tools.
    await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: true });

    const askPrompt = cmd.system_prompt
      ? `${askSystemPrompt}\n\n---\n\n${cmd.system_prompt}`
      : askSystemPrompt;

    const agentStart = Date.now();
    const result = await runWork(
      agent,
      runner,
      worktreePath,
      cmd.prompt,
      askPrompt,
      cmd.model_id,
      cmd.agent_session_id,
      protocolDir,
      onRetryStateChange,
      undefined,
      effectiveWatchdogMs,
      cmd.effort,
      'plan',
      undefined, // windDownTimeoutMs — n/a for read-only ask turns
      cmd.agent_extra_args,
    );
    const agentDurationMs = Date.now() - agentStart;

    updatePhase(status, 'writing_response', protocolDir);
    const response: CompletedResponse = {
      status: 'completed',
      result: result.result,
      session_id: result.session_id,
      usage: result.usage,
      ...launchSettings(cmd, result.model_id),
      ...(result.mcp_tools ? { mcp_tools: result.mcp_tools } : {}),
      agent_duration_ms: agentDurationMs,
    };
    writeResponse(protocolDir, response);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Ask work phase failed: ${errorMessage}`);

    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Work phase failed: ${errorMessage}`,
      phase: 'work',
      ...launchSettings(cmd),
    };
    describeTurnFailure(errorResponse, err);
    writeResponse(protocolDir, errorResponse);
  }
}

/**
 * Handle a pre-accept command: run the agent's final validation turn (WRITE
 * mode — it may fix failures, update maintained files, and commit), then re-run
 * the configured gate commands as the AUTHORITATIVE merge gate.
 *
 * The agent's self-report is NOT trusted for the gate decision: after its turn,
 * the supervisor runs `pre_accept_commands` itself and reports the outcome in
 * `response.pre_accept`. The daemon aborts the merge when `passed` is false.
 * Like ask, this is daemon-owned end-to-end — no upstream/post-turn sync, no
 * violation detection.
 */
async function handlePreAcceptCommand(cmd: PreAcceptCommand, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  log(`[supervisor] Pre-accept command for task ${cmd.task_id.substring(0, 8)} (${cmd.pre_accept_commands.length} gate command(s), effort=${cmd.effort ?? 'default'})`);

  // Pre-turn worktree health + SHA so the daemon can attribute this turn's commits.
  const preAcceptRecovery = await recoverWorktreeState(worktreePath, 'pre-accept');
  const preTurnSha = await getHeadSha(worktreePath);

  const now = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'work',
    task_id: cmd.task_id,
    command_type: 'pre_accept',
    started_at: now,
    updated_at: now,
    phase_started_at: now,
    pre_turn_sha: preTurnSha,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  try {
    const agent = getAgent(cmd.agent_id ?? 'claude-code');
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const onRetryStateChange = makeRetryStatusHandler(status, protocolDir);

    // WRITE mode: no plan-mode lockdown, no LAZY_MCP_READ_ONLY — the agent must
    // be able to run commands, edit files, commit, and journal the post-mortem.
    // Which is exactly why this turn needs its own MCP config written: like ask,
    // it can be the first turn in a freshly launched container.
    await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: false });
    await clearTurnHandoff(worktreePath, log);

    const agentStart = Date.now();
    const result = await runWork(
      agent,
      runner,
      worktreePath,
      cmd.prompt,
      cmd.system_prompt,
      cmd.model_id,
      cmd.agent_session_id,
      protocolDir,
      onRetryStateChange,
      undefined,
      effectiveWatchdogMs,
      cmd.effort,
      undefined, // permissionMode: default (write)
      cmd.wind_down_timeout_ms,
    );
    const agentDurationMs = Date.now() - agentStart;

    const postWorkSha = await getHeadSha(worktreePath);
    log(`[supervisor] Pre-accept post-work SHA: ${postWorkSha.substring(0, 8)}`);
    status.post_work_sha = postWorkSha;
    writeStatus(protocolDir, status);

    // Authoritative gate: re-run the configured commands. Empty list passes.
    updatePhase(status, 'post_turn_check', protocolDir);
    const gate = await runPreAcceptGate(
      cmd.pre_accept_commands,
      worktreePath,
      cmd.pre_accept_timeout ?? DEFAULT_PRE_ACCEPT_TIMEOUT_SECS,
    );
    updatePhase(status, 'post_turn_check_done', protocolDir);
    log(`[supervisor] Pre-accept gate: ${gate.passed ? 'PASSED' : `FAILED (${gate.failedCommand})`}`);

    updatePhase(status, 'writing_response', protocolDir);
    const response: CompletedResponse = {
      status: 'completed',
      result: result.result,
      session_id: result.session_id,
      usage: result.usage,
      ...launchSettings(cmd, result.model_id),
      ...(result.mcp_tools ? { mcp_tools: result.mcp_tools } : {}),
      agent_duration_ms: agentDurationMs,
      start_sha_work: preTurnSha,
      end_sha_work: postWorkSha,
      ...(preAcceptRecovery ? { worktree_recovery: preAcceptRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
      pre_accept: {
        passed: gate.passed,
        ...(gate.failedCommand !== undefined ? { failed_command: gate.failedCommand } : {}),
        ...(gate.exitCode !== undefined ? { exit_code: gate.exitCode } : {}),
        ...(gate.output !== undefined ? { output: gate.output } : {}),
      },
    };
    writeResponse(protocolDir, response);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Pre-accept work phase failed: ${errorMessage}`);

    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Pre-accept turn failed: ${errorMessage}`,
      phase: 'work',
      ...launchSettings(cmd),
      ...(preAcceptRecovery ? { worktree_recovery: preAcceptRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
    };
    describeTurnFailure(errorResponse, err);
    writeResponse(protocolDir, errorResponse);
  }
}

// --- Helpers ---

/**
 * Put everything we know about a failed turn onto its ErrorResponse.
 *
 * One function for every failure path (work, ask, pre-accept) on purpose: this
 * used to be three near-identical copies, and they had already drifted — only
 * the work copy handled a wind-down kill, so an ask or pre-accept killed that
 * way lost its recovered session id. A detail added to one copy and not the
 * others is exactly the class of hole this consolidation closes.
 *
 * INVARIANT: salvaged token usage is applied for EVERY error class, outside the
 * branch chain. A turn that spent tokens and then died must be able to put those
 * tokens on a turn record regardless of how it died — attributing them to the
 * session alone is what produced `session.total_usage > sum(turns)` gaps.
 */
function describeTurnFailure(errorResponse: ErrorResponse, err: unknown): void {
  if (err instanceof FatalAgentError) {
    // The retry policy gave up on purpose. Put the classification on the wire
    // so the reconciler blocks the task (reason visible to the human) instead
    // of auto-resuming into the same unrecoverable condition.
    errorResponse.failure_class = err.failureClass;
    errorResponse.failure_reason = err.failureReason;
    errorResponse.failure_attempts = err.attempts;
  } else if (err instanceof CrashError) {
    errorResponse.exit_code = err.exitCode;
    errorResponse.stderr = err.stderr;
    errorResponse.stdout_error = err.stdoutError;
    errorResponse.duration_ms = err.durationMs;
  } else if (err instanceof WatchdogTimeoutError) {
    // Presence of watchdog_timeout_ms is what makes the recorded turn say
    // "killed by the watchdog after 30m" instead of a bare "agent crashed".
    errorResponse.duration_ms = err.durationMs;
    errorResponse.watchdog_timeout_ms = err.timeoutMs;
    errorResponse.watchdog_attempts = err.attempts;
    errorResponse.watchdog_captured_work = err.capturedWork;
  } else if (err instanceof GracefulExitTimeoutError) {
    // The agent already committed its work — the marker that triggered this
    // kill is written by lazy_commit. The commit is preserved in git either
    // way. The agent's JSON response (summary) is lost, but the session_id
    // is recovered when possible (resume case or jsonl tail) so the human
    // can `lazy unblock` to resume the conversation cleanly.
    errorResponse.duration_ms = err.durationMs;
    if (err.sessionId) {
      errorResponse.session_id = err.sessionId;
    } else {
      logWarn('[supervisor] GracefulExitTimeoutError: no session_id recovered — agent likely died before writing any JSONL.');
    }
  }

  const salvaged = readUsage(err);
  if (salvaged) {
    errorResponse.usage = salvaged;
    log(
      `[supervisor] Recovered ${salvaged.input_tokens + salvaged.output_tokens} reported tokens ` +
      `from the failed turn — recording them on its turn.`,
    );
  }
}

function updatePhase(status: SupervisorStatus, phase: SupervisorPhase, dir: string): void {
  const now = new Date().toISOString();
  status.phase = phase;
  status.updated_at = now;
  status.phase_started_at = now;
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
  // Best-effort tagging — don't fail the turn if tagging fails.
  // Tags are refs, so this goes host-side (the container's refs are read-only).
  const result = await elevatedTag(cwd, tagName);
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to create tag ${tagName}: ${result.stderr}`);
  } else {
    log(`[supervisor] Tagged HEAD as ${tagName}`);
  }
}