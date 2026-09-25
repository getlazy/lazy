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
  AcceptGateCommand,
  ReviewCommand,
  SupervisorStatus,
  SupervisorPhase,
  CompletedResponse,
  ErrorResponse,
  WorktreeRecovery,
  Response,
  CorrelatedCommand,
} from '../protocol/types';
import {
  attachCommandId,
  commandCorrelationId,
  PROTOCOL_VERSION,
} from '../protocol/types';
import type { MergeConflict, FileViolation, AgentTokenUsage } from '../types';
import { runSyncWithUpstream, runSyncWithRemote, type MergeTurnOptions, type SyncWithUpstreamResult, hasUnmergedFiles, abortMergeIfInProgress, settleConflictedWorktree } from './merge';
import { saveWorktreePatch } from './recovery-patch';
import { readWorktreeMergeState, describeMergeState, isMidMerge, hasUncommittedChanges } from '../git/operations';
import { runWork, CrashError, WatchdogTimeoutError, GracefulExitTimeoutError, FatalAgentError, CrashLoopError, turnErrorSessionId } from './work';
import { makeRetryStatusHandler } from './retry-status';
import askSystemPrompt from '../prompts/ask-system-prompt.md' with { type: 'text' };
import reviewSystemPrompt from '../prompts/review-system-prompt.md' with { type: 'text' };
import { runTurnHookCommand, formatHookOutput } from './post-turn-check';
import { resolveWatchdogTimeout } from './watchdog';
import { addAgentUsage, readUsage } from './usage';
import { getAgent, getAgentPackaging } from '../agent/registry';
import { log, logError, logWarn, resetTimer } from './log';
import { prepareTurnMcp } from './mcp-setup';
import { clearTurnHandoff, handoffField, handoffTurnEnding } from './turn-handoff';
import { createRunnerFromType } from '../runner';
import type { Runner, RunnerType } from '../runner/types';
import { VERSION } from '../version';
import { spawn } from '../utils/spawn';
import { startTestParentWatch, TEST_PARENT_PID_ENV } from '../daemon/test-parent-watch';
import { runGit } from '../utils/git';
import { elevatedResetHardHead, elevatedTag } from './elevated-git';
import { detectViolations, ViolationScanError } from './permissions';
import { runPermissionPushback } from './pushback';
import { runLowHighReview, runLowHighRevise, reviewApproved } from './low-high-loop';
import { renderMaintainContext } from './maintain';
import { renderReactContext } from './react';
import { runWrapUpSteps, computeBranchPointSha } from './wrap-up';
import { detectUncommittedPaths, MAX_REPORTED_PATHS } from './leftovers';
import { runReviewVerdictReask } from './review-reask';
import { parseReviewReport } from '../review/parse-report';
import { resolveReviewVerdict } from '../review/verdict';
import { clearFinalMarker, readFinalMarker } from '../protocol/final-marker';
import { runAcceptanceGate, DEFAULT_PRE_ACCEPT_TIMEOUT_SECS } from './accept-gate';
import type { CompletedResponseBundle, FinalDeclaration } from '../protocol/types';
import { truncateLog } from '../utils/log-truncate';

/** Write a response with the originating command's correlation id echoed back. */
function writeCorrelatedResponse(
  protocolDir: string,
  response: Response,
  command: CorrelatedCommand,
): void {
  writeResponse(protocolDir, attachCommandId(response, commandCorrelationId(command)));
}

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

/**
 * Harness assumed when a command carries neither `harness` nor `agent_id`.
 *
 * Only reachable for commands written by a daemon that predates those fields,
 * where claude-code is the historical answer.
 */
const DEFAULT_HARNESS = 'claude-code';

/**
 * Which agent BINARY this command's turn runs.
 *
 * The supervisor has no config and cannot resolve a profile, so the daemon does
 * it at dispatch and states the answer on the command. Everything here that
 * touches the agent REGISTRY — `getAgent`, `getAgentPackaging`, the per-agent
 * config writers in `prepareTurnMcp` — goes through this, because the registry
 * is keyed by harness and `cmd.agent_id` is a PROFILE name that need not be one.
 *
 * The `agent_id` fallback is exact for every project that has not defined a
 * custom profile (built-in profiles are named after their harnesses), which is
 * what lets an older daemon and a newer supervisor keep working together. See
 * the note above `CommandType` in src/protocol/types.ts.
 */
function commandHarness(cmd: { harness?: string; agent_id?: string }): string {
  return cmd.harness ?? cmd.agent_id ?? DEFAULT_HARNESS;
}

/**
 * Verify the COMMAND's agent binary exists before running its turn.
 *
 * The startup tool checks above cannot do this: they run before any command
 * has been read, on a runner built by createRunnerFromType with no agent set,
 * so they only ever cover the base environment (git, claude, lazy-agent). A
 * task whose agent is NOT baked into the image (e.g. a cursor task on a custom
 * Dockerfile without the install line) sailed past them and crash-looped in
 * the work phase with "spawn failed: binary 'cursor-agent' not found"
 * classified unknown. This check turns that into ONE actionable turn failure.
 *
 * Throws (handlers' catch writes the ErrorResponse) — a missing binary can
 * never heal by retrying.
 */
async function checkCommandAgentBinary(harness: string | undefined): Promise<void> {
  const pkg = getAgentPackaging(harness ?? DEFAULT_HARNESS);
  const binaryName = pkg.binaryName();
  const proc = spawn(['which', binaryName], { stdout: 'ignore', stderr: 'ignore' });
  if (await proc.exited !== 0) {
    const hint =
      pkg.supervisorToolChecks().find(c => c.cmd === binaryName || c.cmd.startsWith(`${binaryName} `))?.hint ??
      `Install the ${pkg.agentId} agent CLI.`;
    throw new Error(
      `Agent binary '${binaryName}' (agent "${pkg.agentId}") is not installed in this environment. ${hint}\n` +
      `If this task runs in a container built from a custom Dockerfile, add the agent's install ` +
      `line to that Dockerfile and rebuild (lazy only amends its own default image).`
    );
  }
}

/** Exit code used in one-shot mode to signal that a stop command was received. */
export const ONE_SHOT_STOP_EXIT_CODE = 42;

/**
 * Launch settings to stamp on a response so the reconciler can record them on
 * the turn it writes.
 *
 * `cmd.agent_id` is the agent the daemon dispatched this command to; it lands on
 * the response as `agent`. `cmd.model_id` is the REQUESTED model (the resolved
 * `--model` value the daemon sent — usually a tier alias); it lands on the
 * response as `model`. `reportedModelId` is what the agent said it actually ran,
 * and lands as `model_id`. Omitting a field is meaningful: it records that the
 * setting was not in force / not reported, rather than guessing a default —
 * which is how a command from a daemon predating one of these fields yields an
 * unlabelled turn instead of a turn labelled with a guess.
 *
 * Called per invocation, not per bundle: push-back and maintain are separate
 * agent runs and can report a different concrete model than the work phase.
 */
function launchSettings(
  cmd: { agent_id?: string; model_id?: string; effort?: string },
  reportedModelId?: string,
  effortOverride?: string,
): { agent?: string; model?: string; model_id?: string; effort?: string } {
  const effort = effortOverride ?? cmd.effort;
  return {
    ...(cmd.agent_id ? { agent: cmd.agent_id } : {}),
    ...(cmd.model_id ? { model: cmd.model_id } : {}),
    ...(reportedModelId ? { model_id: reportedModelId } : {}),
    ...(effort ? { effort } : {}),
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

  // Test-only: a supervisor spawned by an e2e run must die with that run.
  //
  // The host-process runner spawns `lazy supervise` DETACHED and `unref()`s it,
  // so it is not a child of `bun test` and nothing in that process reaps it by
  // parentage. The harness now kills supervisors by root in cleanup and in its
  // process-death net (test/helpers/daemon-registry.ts), but both of those live
  // inside the `bun test` process — a SIGKILL of that process skips them, and
  // the leaked supervisor then keeps rewriting the shared ~/.claude.json MCP
  // entry, which is exactly how one hijacked another agent's tool channel.
  // This watch is the only layer that survives that, mirroring the daemon's.
  // No-op unless LAZY_TEST_PARENT_PID is set — see daemon/test-parent-watch.ts.
  startTestParentWatch(() => {
    logWarn(
      `[supervisor] ${TEST_PARENT_PID_ENV} process ${process.env[TEST_PARENT_PID_ENV]} exited — ` +
      `exiting (PID ${process.pid})`,
    );
    process.exit(0);
  });

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

    const turnStartedAt = (command.type === 'start' || command.type === 'unblock' || command.type === 'ask')
      ? (command as StartCommand | UnblockCommand | AskCommand | ReviewCommand).turn_started_at
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
      writeCorrelatedResponse(protocolDir, versionErrorResponse, command);
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
      writeCorrelatedResponse(protocolDir, errorResponse, command);
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

  const saved = await saveWorktreePatch(worktreePath, 'merge-rollback');
  const patchPath = saved.outcome === 'saved' ? saved.path : null;
  if (patchPath) {
    logWarn(`[supervisor] Saved the discarded worktree state to ${patchPath}`);
  } else if (saved.outcome === 'failed') {
    // The rollback still has to happen — a turn cannot start on a half-merged
    // worktree — but the human must be told the discard was unwitnessed rather
    // than being left to assume there was nothing in it.
    logError(
      `[supervisor] Could NOT capture the worktree diff before rolling back (${saved.reason}). ` +
      `Anything uncommitted here is being discarded without a recovery patch.`,
    );
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
    (saved.outcome === 'failed'
      ? `. WARNING: the worktree diff could not be captured first (${saved.reason}), so anything ` +
        'uncommitted was discarded without a recovery patch'
      : '') +
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
 * Per-turn options for merge-resolution agent turns.
 *
 * A merge turn is an ordinary agent turn — it edits files, runs tests, and
 * commits — so it runs the TASK'S agent and gets the same two guards as the
 * work phase, from the same config. The "0 = use the agent default" fallback
 * therefore resolves against that same agent: cursor declares a non-zero
 * default precisely because it is known to hang, and resolving against
 * claude-code (which declares 0) would have left a cursor merge turn unguarded.
 *
 * It also carries the command's `effort` for the same reason it carries the
 * model: a merge turn runs on the task's own agent, model and effort (INVARIANT
 * turn-launch-continuity, src/daemon/launch-identity.ts). Neither is resolved
 * here — both arrive on the command, already resolved from the task record.
 */
function mergeTurnOptions(cmd: {
  watchdog_output_timeout_ms?: number;
  wind_down_timeout_ms?: number;
  harness?: string;
  agent_id?: string;
  effort?: string;
}): MergeTurnOptions {
  const harness = commandHarness(cmd);
  return {
    harness,
    noProgressTimeoutMs: resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      getAgent(harness).defaultWatchdogTimeoutMs(),
    ),
    windDownTimeoutMs: cmd.wind_down_timeout_ms ?? 0,
    ...(cmd.effort ? { effort: cmd.effort } : {}),
  };
}

/** Default pre-turn hook timeout (seconds) when the command omits one. */
const DEFAULT_PRE_TURN_TIMEOUT_SECS = 120;

interface PreTurnHookOutcome {
  /** Set when the hook ran; mirrors the post-turn check's exit-code convention. */
  exitCode?: number;
  /** Captured, labelled output — recorded on the turn. Only set on failure. */
  output?: string;
  /** One-line-plus-detail failure summary to prepend to the agent's prompt. */
  promptPrefix?: string;
  /** When set, the turn must not run: write this response and return. */
  abort?: ErrorResponse;
}

/**
 * Run the `[automation] pre_turn` setup hook, if configured.
 *
 * Failure policy (engineer decision): NON-FATAL, but loud. The default is that
 * a failing hook does not cost the turn — the agent may well be able to work,
 * or to fix the setup itself — but it is never swallowed: the failure is logged,
 * recorded on the turn for the reviewer, and prepended to the agent's prompt so
 * it starts out knowing the environment is degraded. Projects whose turns are
 * worthless without their services set `pre_turn_required = true` to fail the
 * turn instead.
 */
async function runPreTurnHook(
  cmd: StartCommand | UnblockCommand,
  worktreePath: string,
  status: SupervisorStatus,
  protocolDir: string,
  config: SupervisorConfig,
): Promise<PreTurnHookOutcome> {
  if (!cmd.pre_turn_hook) return {};

  const timeoutSecs = cmd.pre_turn_timeout ?? DEFAULT_PRE_TURN_TIMEOUT_SECS;
  const required = cmd.pre_turn_required === true;
  log(`[supervisor] Pre-turn hook: "${cmd.pre_turn_hook}" (timeout: ${timeoutSecs}s, required: ${required})`);

  // §3.5: on the host-process runner the hook runs on the HOST, unsandboxed,
  // and whatever it starts outlives the turn with nothing to sweep it up. That
  // is a real change in blast radius from the container runners, so it is
  // announced every turn rather than mentioned once in the docs.
  if ((config.runnerType ?? 'docker') === 'dangerously-host-process-without-any-isolation') {
    logWarn(
      `[supervisor] Pre-turn hook runs on the HOST (host-process runner), not in a container: ` +
        `"${cmd.pre_turn_hook}" in ${worktreePath}. Anything it starts keeps running after this turn ` +
        `and after the task ends — nothing sweeps it up. Stop it yourself when you are done.`,
    );
  }

  updatePhase(status, 'pre_turn_hook', protocolDir);
  let exitCode: number;
  let detail: string;
  try {
    const result = await runTurnHookCommand(
      cmd.pre_turn_hook,
      worktreePath,
      timeoutSecs * 1000,
      'Pre-turn hook',
    );
    exitCode = result.exitCode;
    if (result.timedOut) {
      detail =
        `Pre-turn hook timed out after ${timeoutSecs}s ` +
        `(killed with ${result.killSignal ?? 'SIGTERM'} after ${result.elapsedMs}ms)\n\n` +
        `--- output at timeout ---\n${truncateLog(formatHookOutput(result))}`;
    } else {
      detail = truncateLog(formatHookOutput(result));
    }
  } catch (err) {
    exitCode = -1;
    detail = err instanceof Error ? err.message : String(err);
  } finally {
    updatePhase(status, 'pre_turn_hook_done', protocolDir);
  }

  if (exitCode === 0) {
    log('[supervisor] Pre-turn hook succeeded');
    return {};
  }

  const headline = `Pre-turn hook failed (exit ${exitCode}): ${cmd.pre_turn_hook}`;
  logWarn(`[supervisor] ${headline}`);
  const output = `${headline}\n\n${detail}`;

  if (required) {
    return {
      exitCode,
      output,
      abort: {
        status: 'error',
        error:
          `${headline}\n\n${detail}\n\n` +
          `The turn was not run because [automation] pre_turn_required = true. ` +
          `Fix the setup command, or set pre_turn_required = false to run turns anyway.`,
        phase: 'pre_turn_hook',
        // Classified fatal on purpose: a required setup hook that fails is an
        // environment/config problem only a human can fix, and it fails the
        // same way every time. Left unclassified the task would land in
        // `interrupted` and auto-resume would re-run the same failing hook on
        // a timer. `fatal_config` lands it in the human's queue instead.
        failure_class: 'fatal_config',
        failure_reason: `[automation] pre_turn failed and pre_turn_required = true`,
      },
    };
  }

  return {
    exitCode,
    output,
    promptPrefix:
      `## Environment warning: the pre-turn setup hook failed\n\n` +
      `${headline}\n\n` +
      `Your environment may be missing services this project expects to be running. ` +
      `Take this into account before concluding that something is broken in the code, ` +
      `and fix the setup if you can.\n\n` +
      `\`\`\`\n${detail}\n\`\`\``,
  };
}

/**
 * Per-turn capture of the agent's turn-ending declaration (final-turn design
 * §2.4), shared by the work path and the wrap-up command — both drive multiple
 * agent invocations, and each invocation gets its own chance to declare and
 * its own claim.
 *
 * Read-and-clear: returns the pencils-down claim when THIS invocation made
 * one, so it rides home on THAT invocation's response and the reconciler
 * records it on the turn that made it. A `needs_input` mark sets `wasDeclared`
 * — which is how this supervisor knows the invocation reached the daemon, and
 * so that the MCP-down handoff file is not worth re-reading — but is not
 * carried, because the raise itself is already in the store.
 *
 * INVARIANT (§13.10): the marker is read and cleared on EVERY capture, so a
 * stale `final.json` can never make an unfinished turn look declared-done.
 */
function makeTurnEndingCapture(protocolDir: string): {
  captureTurnEnding: () => Promise<FinalDeclaration | undefined>;
  /** Whether ANY invocation so far said how it was ending. */
  wasDeclared: () => boolean;
  /** Record a declaration that arrived outside a marker (the handoff fallback). */
  markDeclared: () => void;
} {
  let declaredTurnEnding = false;
  return {
    captureTurnEnding: async (): Promise<FinalDeclaration | undefined> => {
      const marker = await readFinalMarker(protocolDir, log);
      await clearFinalMarker(protocolDir, log);
      if (!marker) return undefined;
      declaredTurnEnding = true;
      if (!marker.final) return undefined;
      log(`[supervisor] Agent declared final at ${marker.final.sha.substring(0, 8)}`);
      return {
        sha: marker.final.sha,
        declared_at: marker.final.declared_at,
        ...(marker.final.note ? { note: marker.final.note } : {}),
      };
    },
    wasDeclared: () => declaredTurnEnding,
    markDeclared: () => {
      declaredTurnEnding = true;
    },
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

  // Acceptance-gate commands are MECHANICAL: run the configured gate commands
  // in the worktree and report the outcome. No agent runs, no session, no
  // turn — the daemon drives the merge from the response's `accept_gate` field.
  if (command.type === 'accept_gate') {
    await handleAcceptGateCommand(command as AcceptGateCommand, config);
    return;
  }

  // Review commands are ask-shaped (read-only, no integration) but start a
  // NEW agent session — never --resume the implementer's context.
  if (command.type === 'review') {
    await handleReviewCommand(command as ReviewCommand, config, runner);
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
      const remoteResult = await runSyncWithRemote(
        worktreePath,
        cmd.remote_branch,
        cmd.model_id,
        remoteSyncSessionId,
        mergeTurnOptions(cmd),
      );
      allMergeConflicts.push(...remoteResult.conflicts);
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
      writeCorrelatedResponse(protocolDir, errorResponse, command);
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
        mergeTurnOptions(cmd),
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
      writeCorrelatedResponse(protocolDir, errorResponse, command);
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

  // Phase 2b: Pre-turn setup hook (`[automation] pre_turn`).
  //
  // Runs in the worktree AFTER the upstream merge and BEFORE the agent starts,
  // so the agent finds a working environment (dev server, database, queue) on
  // its first tool call rather than discovering it is missing halfway through.
  //
  // It runs on EVERY work turn, including resumes. Nothing restarts services
  // between turns any more — agent-started processes survive turn boundaries —
  // so the hook's job is "ensure services are up" (first turn of a fresh
  // container, or one that crashed since), not "restart after the per-turn
  // kill". That makes idempotence a hard requirement for hook scripts, and it
  // is documented as such in lazy.toml.example and docs/lazy-toml.md.
  //
  // Deliberately NOT run for `ask` (read-only, no work) or the mechanical
  // acceptance gate (no agent, no work).
  const preTurn = await runPreTurnHook(cmd, worktreePath, status, protocolDir, config);
  if (preTurn.abort) {
    writeCorrelatedResponse(protocolDir, preTurn.abort, cmd);
    return;
  }

  // Write this turn's MCP server config + permissions so Claude Code discovers
  // the lazy tools. Write mode — this turn may commit, journal, and run subtasks.
  await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: false, harness: commandHarness(cmd), model: cmd.model_id });

  // Start the turn with an empty handoff file, so anything collected afterwards
  // is unambiguously from THIS turn's agent.
  await clearTurnHandoff(worktreePath, log);

  // ...and with no turn-ending marker, for the same reason and a sharper one:
  // INVARIANT (final-turn design §13.10) — a stale `final.json` must never make
  // an unfinished turn look declared-done. It is cleared before EVERY agent
  // invocation below, not just this one, because each invocation gets its own
  // chance to declare and its own claim.
  await clearFinalMarker(protocolDir, log);

  /** Per-turn capture of the marker each invocation leaves (§2.4). */
  const turnEnding = makeTurnEndingCapture(protocolDir);

  // Phase 3: Work (actual task work via Claude Code)
  updatePhase(status, 'work', protocolDir);

  try {
    const claudeSessionId = command.type === 'unblock'
      ? (command as UnblockCommand).agent_session_id
      : undefined;

    // Callback to update status when entering retry mode
    const onRetryStateChange = makeRetryStatusHandler(status, protocolDir);

    // Resolve the harness from the command (defaults to claude-code for backward compat)
    const harness = commandHarness(cmd);
    const agent = getAgent(harness);
    log(`[supervisor] Using agent: ${agent.id}${cmd.agent_id && cmd.agent_id !== agent.id ? ` (profile "${cmd.agent_id}")` : ''}`);
    await checkCommandAgentBinary(harness);

    // Resolve effective watchdog timeout: config value (0 = use agent default)
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const permissionMode = command.type === 'unblock'
      ? (command as UnblockCommand).permission_mode
      : undefined;

    // Up-front maintained-file + reactive-automation context: tell the agent
    // which files this project expects kept up to date / which path matches
    // trigger a follow-up reaction. No-op when unconfigured.
    const maintainContext = renderMaintainContext(cmd.maintain);
    const reactContext = renderReactContext(cmd.react);
    const automationContext = [maintainContext, reactContext].filter(Boolean).join('\n\n');
    const systemPromptForWork = automationContext
      ? `${cmd.system_prompt ?? ''}\n\n${automationContext}`
      : cmd.system_prompt;

    // A non-fatal pre-turn hook failure is prepended to the prompt so the agent
    // knows its environment is degraded before it starts assuming otherwise.
    const promptForWork = preTurn.promptPrefix
      ? `${preTurn.promptPrefix}\n\n${cmd.prompt}`
      : cmd.prompt;

    const result = await runWork(
      agent,
      runner,
      worktreePath,
      promptForWork,
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
      undefined, // _sleepOverride
      { taskId: cmd.task_id, agentId: cmd.agent_id },
    );

    updatePhase(status, 'work_done', protocolDir);
    log(`[supervisor] Agent result: session_id=${result.session_id?.substring(0, 8)}, result_length=${result.result.length}`);

    // How the WORK invocation ended, read before any follow-up invocation can
    // clear the marker. Carried on the work response further down. Reassigned
    // only by the handoff fallback below, which is the same claim arriving on
    // the other channel.
    let workFinalDeclared = await turnEnding.captureTurnEnding();

    // Record agent's work endpoint (before any post-turn sync)
    const postWorkSha = await getHeadSha(worktreePath);
    log(`[supervisor] Post-work SHA: ${postWorkSha.substring(0, 8)}`);
    status.post_work_sha = postWorkSha;
    writeStatus(protocolDir, status);

    const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-work/${postWorkSha.substring(0, 8)}`;
    await tagHead(worktreePath, tagName);
    log(`[supervisor] Tagged HEAD: ${tagName}`);

    // Supervised follow-up invocations (low-high loop phases, push-back, maintain
    // nudge). Each is a SEPARATE `claude -p` invocation and becomes a FULL
    // CompletedResponse in the bundle — its own commits/SHAs, usage (incl.
    // cache), per-invocation effort, and (for push-back) its own re-detected
    // violation set. The work turn's response stays clean; the reconciler
    // materializes each as a discrete supervisor→agent turn pair.
    //
    // INVARIANT: status.post_work_sha stays pinned at the WORK end (postWorkSha)
    // — it is NOT advanced past supervised commits. That kills the double-count:
    // the work turn's diff covers only work commits; each supervised response
    // carries its OWN start/end SHA window so its commits attribute to ITS turn.
    const supervisedResponses: CompletedResponse[] = [];
    let lastInvocationSha = postWorkSha;
    // The session the next supervised invocation resumes from. Starts at the work
    // session; advances through each supervised invocation (each resume can
    // rotate the session id) so every follow-up continues ONE conversation.
    let lastSessionId = result.session_id;

    // Phase 3a-2 (EXPERIMENTAL low-high loop): one bounded review→revise cycle.
    // The work phase above was the DRAFT (it ran at the command's low effort);
    // now a high-effort read-only self-review produces revision instructions,
    // and unless it approved, one revise invocation back at the draft effort
    // applies them. Runs BEFORE violation detection/push-back so the final
    // violation scan covers revise commits too.
    if (cmd.low_high_loop) {
      updatePhase(status, 'low_high_review', protocolDir);
      log(`[supervisor] Low-high loop: reviewing draft at effort=${cmd.low_high_loop.review_effort}`);
      const review = await runLowHighReview(agent, worktreePath, lastSessionId, {
        modelId: cmd.model_id,
        effort: cmd.low_high_loop.review_effort,
        watchdogTimeoutMs: effectiveWatchdogMs,
        extraArgs: cmd.agent_extra_args,
      });
      // The review is read-only (plan mode) — its SHA window is empty by
      // construction, but read HEAD anyway so an unexpected write is attributed
      // rather than hidden.
      const postReviewSha = await getHeadSha(worktreePath);
      const reviewFinal = await turnEnding.captureTurnEnding();
      supervisedResponses.push({
        status: 'completed',
        result: review.response,
        session_id: review.session_id,
        usage: review.usage,
        ...launchSettings(cmd, review.model_id, cmd.low_high_loop.review_effort),
        start_sha_work: lastInvocationSha,
        end_sha_work: postReviewSha,
        ...(reviewFinal ? { final: reviewFinal } : {}),
        supervised: { kind: 'low_high_review', prompt: review.prompt },
      });
      lastInvocationSha = postReviewSha;
      lastSessionId = review.session_id;
      updatePhase(status, 'low_high_review_done', protocolDir);

      const approved = reviewApproved(review.response);
      if (!review.ok) {
        log('[supervisor] Low-high loop: review failed — skipping the revise phase, draft work stands.');
      } else if (approved) {
        log('[supervisor] Low-high loop: review approved the draft — no revise phase.');
      } else {
        updatePhase(status, 'low_high_revise', protocolDir);
        log(`[supervisor] Low-high loop: applying review instructions at effort=${cmd.effort ?? 'default'}`);
        const revise = await runLowHighRevise(agent, worktreePath, lastSessionId, {
          modelId: cmd.model_id,
          effort: cmd.effort ?? 'low',
          watchdogTimeoutMs: effectiveWatchdogMs,
          extraArgs: cmd.agent_extra_args,
        });
        const postReviseSha = await getHeadSha(worktreePath);
        const reviseFinal = await turnEnding.captureTurnEnding();
        supervisedResponses.push({
          status: 'completed',
          result: revise.response,
          session_id: revise.session_id,
          usage: revise.usage,
          ...launchSettings(cmd, revise.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postReviseSha,
          ...(reviseFinal ? { final: reviseFinal } : {}),
          supervised: { kind: 'low_high_revise', prompt: revise.prompt },
        });
        if (postReviseSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postReviseSha.substring(0, 8)}`);
        }
        lastInvocationSha = postReviseSha;
        lastSessionId = revise.session_id;
        updatePhase(status, 'low_high_revise_done', protocolDir);
      }
    }

    // Phase 3b: The wrap-up chain. Protected-file push-back runs on every work
    // turn so each turn persists the same violation set the whole-branch scan
    // derives. The maintained-file and reactive nudges remain final-only.
    //
    // The PRESENTATION is the exception, and it is why the daemon sends two
    // lists. A walkthrough exists to inform the human's accept decision, so it
    // is owed on every human-facing park — needs-input and plain blocked
    // included — not only when the agent declared done. Gating it on the
    // declaration made the human ask for it by hand at exactly the moment they
    // were being asked to decide. So `park_steps` runs permission push-back
    // plus the presentation when the turn parked without a final.
    //
    // The chain is skipped in plan mode: a plan-mode agent cannot revert a
    // protected edit, so the push-back exchange could not resolve anything, and
    // a whole-branch scan would flag work the mode exists to preview. The final
    // declaration still rides home on the work response; a human accepting a
    // plan-mode task gets the accept-time remedies instead.
    const protectedPatterns = cmd.protected_patterns ?? [];
    const startShaWork = status.post_merge_sha ?? status.pre_turn_sha ?? preTurnSha;
    const upstreamMergeRef = 'upstream_merge_ref' in cmd
      ? (cmd as { upstream_merge_ref?: string }).upstream_merge_ref ?? cmd.parent_branch
      : cmd.parent_branch;
    // The handoff file is the MCP-down fallback for both declared endings, and
    // it is consulted BEFORE the wrap-up decision: a turn whose tools died and
    // which said pencils down in a file has declared its ending, and that
    // declaration must select the FULL chain exactly as a marker declaration
    // would. The claim SHA is read at the post-LOOP head — the head the agent
    // declared at — rather than after the wrap-up steps have committed.
    // Consulted only when no marker declared, and once per turn: a handoff
    // entry written by a wrap-up step's own invocation is collected onto the
    // work response by handoffField below, but no longer re-decides the ending
    // — the wrap-up steps run with a working MCP channel and their own marker
    // capture.
    const handoffEnding = turnEnding.wasDeclared() ? null : await handoffTurnEnding(worktreePath);
    if (handoffEnding) {
      log(`[supervisor] Turn ending declared via the handoff file (${handoffEnding.ending})`);
      turnEnding.markDeclared();
      if (handoffEnding.ending === 'final') {
        workFinalDeclared = {
          sha: await getHeadSha(worktreePath),
          declared_at: new Date().toISOString(),
          ...(handoffEnding.note ? { note: handoffEnding.note } : {}),
        };
      }
    }

    // HOW THE TURN ENDED picks the list. Declared final → the full chain;
    // parked without one → the park plan. Both come from the daemon on the
    // command, because the ending is not knowable when the command is written.
    const declaredFinal = workFinalDeclared !== undefined;
    const wrapUpSteps = declaredFinal
      ? cmd.wrap_up?.steps ?? []
      : cmd.wrap_up?.park_steps ?? [];

    let violations: FileViolation[] = [];
    let pushedBack = false;
    if (wrapUpSteps.length > 0 && permissionMode !== 'plan') {
      // Branch point = the commit before the task created any files — files not
      // present there are the task's own and exempt from permission violations.
      // Computed in the shared resolver (wrap-up.ts) so the wrap-up command's
      // scans exempt exactly the same file set as this one.
      const branchPointSha = await computeBranchPointSha({
        worktreePath,
        parentBranch: cmd.parent_branch,
        hasProtectedPatterns: protectedPatterns.length > 0,
        fallbackSha: cmd.branch_point_sha,
      });

      log(
        `[supervisor] Wrap-up phase: ${declaredFinal ? 'final declared' : 'parked without a final'}, ` +
        `${wrapUpSteps.length} step(s) [${wrapUpSteps.join(', ')}], ` +
        `scan window ${startShaWork.substring(0, 8)}..${lastInvocationSha.substring(0, 8)}`,
      );
      // Across the seam for `lazy_final`'s walkthrough-step refusal: set on a
      // declared turn, CLEARED on a park, so a claim from an earlier turn can
      // never answer this one. Written before the phase update, which is what
      // flushes the status file.
      status.declared_final = workFinalDeclared
        ? { sha: workFinalDeclared.sha, declared_at: workFinalDeclared.declared_at }
        : undefined;
      updatePhase(status, 'wrap_up', protocolDir);
      const outcome = await runWrapUpSteps({
        agent,
        worktreePath,
        protocolDir,
        status,
        updatePhase: (phase) => updatePhase(status, phase, protocolDir),
        cmd,
        steps: wrapUpSteps,
        startSha: startShaWork,
        startSessionId: lastSessionId,
        protectedPatterns,
        branchPointSha,
        upstreamMergeRef,
        maintainEntries: cmd.maintain ?? [],
        reactEntries: cmd.react ?? [],
        captureTurnEnding: turnEnding.captureTurnEnding,
        supervisedResponses,
        presentedSha: cmd.wrap_up?.presented_sha,
        declaredFinal,
      });
      violations = outcome.violations;
      pushedBack = outcome.pushedBack;
      lastInvocationSha = outcome.lastInvocationSha;
      lastSessionId = outcome.lastSessionId;
      updatePhase(status, 'wrap_up_done', protocolDir);
      log(`[supervisor] Wrap-up phase done: violations=${violations.length}, pushedBack=${pushedBack}, supervised=${supervisedResponses.length}`);
    } else if (wrapUpSteps.length > 0 && permissionMode === 'plan') {
      log('[supervisor] Plan mode — wrap-up skipped (a plan-mode agent cannot resolve violations); accept-time remedies apply');
    } else {
      log(`[supervisor] No wrap-up steps for this ending (${declaredFinal ? 'final' : 'parked'}) — nothing to run`);
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
        const result = await runTurnHookCommand(
          cmd.post_turn_check,
          worktreePath,
          timeoutSecs * 1000,
        );
        checkExitCode = result.exitCode;
        // Both streams, separately labelled: service-style scripts routinely
        // report failure on stdout and say nothing on stderr.
        const truncatedOutput = truncateLog(formatHookOutput(result));
        if (result.timedOut) {
          checkOutput =
            `Post-turn check timed out after ${timeoutSecs}s ` +
            `(killed with ${result.killSignal ?? 'SIGTERM'} after ${result.elapsedMs}ms)\n\n` +
            `--- output at timeout ---\n${truncatedOutput}`;
          logWarn(
            `[supervisor] Post-turn check timed out after ${timeoutSecs}s ` +
              `(killSignal=${result.killSignal}, elapsedMs=${result.elapsedMs})`,
          );
        } else {
          checkOutput = truncatedOutput;
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
          mergeTurnOptions(cmd),
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

    // What is still loose in the worktree now the turn is over — after the
    // wrap-up chain, the post-turn check and the post-turn sync, so this is the
    // state the task is actually parked in. None of it is on the branch.
    //
    // Recorded on EVERY work turn, whatever the plan said: the
    // `commit_leftovers` step belongs to finals, but a park that quietly holds
    // an edit nobody has seen is exactly what cost four tasks their end-of-turn
    // docs. A scan is one `git status`; the step is a model invocation.
    // A failed scan (null) writes nothing rather than an empty set — "I could
    // not look" must not reach a reviewer as "there was nothing there".
    const leftoverPaths = await detectUncommittedPaths(worktreePath);
    if (leftoverPaths && leftoverPaths.length > 0) {
      logWarn(
        `[supervisor] Turn ending with ${leftoverPaths.length} uncommitted path(s), none of them on the branch: ` +
        leftoverPaths.slice(0, MAX_REPORTED_PATHS).join(', '),
      );
    }

    const workResponse: CompletedResponse = {
      status: 'completed',
      result: result.result,
      session_id: result.session_id,
      usage: result.usage,
      ...launchSettings(cmd, result.model_id),
      ...(result.mcp_tools ? { mcp_tools: result.mcp_tools } : {}),
      ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
      ...handoff,
      // Pencils down, when the WORK invocation declared it (or the handoff
      // fallback did). A claim made during a follow-up rides on that
      // follow-up's own response instead — the claim belongs to the invocation
      // that made it.
      ...(workFinalDeclared ? { final: workFinalDeclared } : {}),
      ...(allMergeConflicts.length > 0 ? { merge_conflicts: allMergeConflicts } : {}),
      ...(pushedBack ? { pushed_back: true } : {}),
      ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
      ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
      ...(preTurn.exitCode !== undefined ? { pre_turn_exit_code: preTurn.exitCode } : {}),
      ...(preTurn.output !== undefined ? { pre_turn_output: preTurn.output } : {}),
      ...(leftoverPaths && leftoverPaths.length > 0
        ? { uncommitted: leftoverPaths.slice(0, MAX_REPORTED_PATHS) }
        : {}),
    };

    const bundle: CompletedResponseBundle = {
      status: 'completed',
      responses: [workResponse, ...supervisedResponses],
    };
    log(`[supervisor] Response written: ${bundle.responses.length} invocation response(s), final violations=${violations.length}`);
    writeCorrelatedResponse(protocolDir, bundle, cmd);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Work phase failed: ${errorMessage}`);

    // Detect whether the agent had any effect on the branch. If the turn failed
    // AND there are no new commits AND the worktree is clean, the agent provably
    // did not influence the branch — downstream consumers can skip mechanisms
    // that only make sense when work was done (e.g., a wrap-up step).
    let agentHadNoEffect: boolean | undefined;
    // And WHICH paths are loose, from the same scan. A crashed or
    // watchdog-killed turn never reaches the wrap-up, so nothing asks it to
    // commit what it wrote — this is the case where loose work is most at risk
    // and, until now, the only one that recorded nothing about it.
    let failedTurnPaths: string[] | null = null;
    try {
      const currentSha = await getHeadSha(worktreePath);
      const hasNewCommits = currentSha !== preTurnSha && preTurnSha !== 'unknown' && currentSha !== 'unknown';
      failedTurnPaths = await detectUncommittedPaths(worktreePath);
      // `null` is "could not look", which must not read as "clean" in either
      // answer: fall back to the predicate, which is allowed to say false.
      const hasUncommitted = failedTurnPaths !== null
        ? failedTurnPaths.length > 0
        : await hasUncommittedChanges(worktreePath);
      agentHadNoEffect = !hasNewCommits && !hasUncommitted;
      if (agentHadNoEffect) {
        log('[supervisor] Agent had no effect on the branch (no commits, clean worktree).');
      }
      if (failedTurnPaths && failedTurnPaths.length > 0) {
        logWarn(
          `[supervisor] Failed turn left ${failedTurnPaths.length} uncommitted path(s) in the worktree: ` +
          failedTurnPaths.slice(0, MAX_REPORTED_PATHS).join(', '),
        );
      }
    } catch (detectErr) {
      logWarn(`[supervisor] Could not detect if agent had effect: ${detectErr instanceof Error ? detectErr.message : detectErr}`);
    }

    // Collect the handoff on the failure path too: a watchdog kill or a crash is
    // exactly when the agent's own account of the turn is most worth keeping.
    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Work phase failed: ${errorMessage}`,
      phase: 'work',
      ...launchSettings(cmd),
      ...(turnRecovery ? { worktree_recovery: turnRecovery } : {}),
      ...(await handoffField(worktreePath, log)),
      ...(agentHadNoEffect !== undefined ? { agent_had_no_effect: agentHadNoEffect } : {}),
      ...(failedTurnPaths && failedTurnPaths.length > 0
        ? { uncommitted: failedTurnPaths.slice(0, MAX_REPORTED_PATHS) }
        : {}),
    };

    describeTurnFailure(errorResponse, err);

    writeCorrelatedResponse(protocolDir, errorResponse, cmd);
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
  log(`[supervisor] Sync command: pre-turn SHA ${preTurnSha.substring(0, 8)}, parent_branch=${cmd.parent_branch}, remote_branch=${cmd.remote_branch ?? '(none)'}`);

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
  // means editing and committing. The harness matters: the conflict-resolution
  // turn runs the TASK'S agent (src/supervisor/merge.ts), and cursor discovers
  // MCP servers from a different file — without it a cursor merge turn has no
  // `lazy_commit`, which is the only way it can conclude the merge.
  await prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: false, harness: commandHarness(cmd), model: cmd.model_id });
  await clearTurnHandoff(worktreePath, log);

  const allMergeConflicts: MergeConflict[] = [];

  // The sync response is a bundle of per-STEP pairs, in the order the steps ran:
  // each step contributes a `supervisor`-authored merge announcement (marked with
  // `sync`) and, only when that step hit conflicts, the agent's resolution reply
  // right after it. The reconciler reads that structure positionally — see
  // recordSyncTurns — so a step's reply must always follow its own announcement.
  const responses: CompletedResponse[] = [];
  let firstStep = true;

  function pushStep(label: string, result: SyncWithUpstreamResult): void {
    // Never claim a merge that did not happen (fix-sync-no-merge).
    const resultMessage = result.merged
      ? (result.conflicts.length > 0
        ? `Merged ${label} @ ${result.targetSha.substring(0, 8)} with ${result.conflicts.length} resolved conflict(s). HEAD: ${result.preMergeSha.substring(0, 8)} → ${result.postMergeSha.substring(0, 8)}.`
        : `Merged ${label} @ ${result.targetSha.substring(0, 8)}. HEAD: ${result.preMergeSha.substring(0, 8)} → ${result.postMergeSha.substring(0, 8)}.`)
      : `Already up to date: HEAD (${result.preMergeSha.substring(0, 8)}) already contains ${label} @ ${result.targetSha.substring(0, 8)}. No merge performed.`;

    responses.push({
      status: 'completed',
      result: resultMessage,
      session_id: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      sync: { merged: result.merged, conflicts: result.conflicts.length },
      // Deliberately NO launchSettings: a clean merge invokes no agent at all, so
      // this announcement ran no model and must not be labelled with one. The
      // conflict-resolution response below is the invocation, and carries them.
      // A rollback performed before this sync is reported on the first response
      // even when the sync itself succeeded — the reconciler journals it against
      // the task so a discarded resolution is never invisible (fix-sync-silent-conflict).
      ...(firstStep && syncRecovery ? { worktree_recovery: syncRecovery } : {}),
      ...(result.conflicts.length > 0 ? { merge_conflicts: result.conflicts } : {}),
      // For a CLEAN merge the merge commit belongs to the announcement turn (SHA
      // window attached here); for a conflict merge the commit is the agent's and
      // is attributed to the resolution turn instead.
      ...(result.merged && result.conflicts.length === 0
        ? { start_sha_work: result.preMergeSha, end_sha_work: result.postMergeSha }
        : {}),
    });
    firstStep = false;

    if (result.merged && result.resolution) {
      responses.push({
        status: 'completed',
        result: result.resolution.result,
        session_id: result.resolution.session_id,
        usage: result.resolution.usage,
        // A sync command carries the task's agent, model and effort, so the
        // conflict-resolution turn is labelled with all three — the same
        // launch settings the merge turn actually ran on.
        ...launchSettings(cmd, result.resolution.model_id),
        start_sha_work: result.preMergeSha,
        end_sha_work: result.postMergeSha,
      });
    }
  }

  // Step 1: reconcile the task's OWN branch with origin — a colleague may have
  // pushed to it. Runs before the parent merge for the same reason the
  // start/unblock path orders them this way: settle what the branch is meant to
  // contain, then merge approved upstream work on top. The host has already
  // fetched; `remote_branch` is only set when it found new commits.
  if (cmd.remote_branch) {
    updatePhase(status, 'sync_with_remote', protocolDir);
    try {
      const remoteResult = await runSyncWithRemote(
        worktreePath,
        cmd.remote_branch,
        cmd.model_id,
        cmd.agent_session_id,
        mergeTurnOptions(cmd),
      );
      allMergeConflicts.push(...remoteResult.conflicts);
      pushStep(cmd.remote_branch, remoteResult);

      const postRemoteSyncSha = await getHeadSha(worktreePath);
      status.post_remote_sync_sha = postRemoteSyncSha;
      updatePhase(status, 'sync_with_remote_done', protocolDir);
      await tagHead(
        worktreePath,
        `turn/${cmd.task_id.substring(0, 8)}/post-remote-sync/${postRemoteSyncSha.substring(0, 8)}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`[supervisor] Sync-with-remote failed: ${errorMessage}`);

      // INVARIANT (fix-sync-silent-conflict): a failed merge phase never returns
      // with a half-merged worktree, and the parent step does NOT run on top of
      // an unreconciled branch — the whole sync fails, loudly and re-runnably.
      const mergeState = await settleConflictedWorktree(worktreePath);
      const errorResponse: ErrorResponse = {
        status: 'error',
        error: `Sync-with-remote failed: ${errorMessage}${mergeState.settled ? '' : ` — ${mergeState.detail}`}`,
        phase: 'sync_with_remote',
        merge_state: mergeState,
        ...(syncRecovery ? { worktree_recovery: syncRecovery } : {}),
        ...(await handoffField(worktreePath, log)),
      };
      writeCorrelatedResponse(protocolDir, errorResponse, cmd);
      return;
    }
  }

  // Step 2: merge the parent/upstream branch (unchanged behaviour).
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
      mergeTurnOptions(cmd),
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
    writeCorrelatedResponse(protocolDir, errorResponse, cmd);
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
    writeCorrelatedResponse(protocolDir, errorResponse, cmd);
    return;
  }

  const postMergeSha = syncResult.postMergeSha;
  status.post_merge_sha = postMergeSha;
  updatePhase(status, 'merge_and_fix_done', protocolDir);

  const tagName = `turn/${cmd.task_id.substring(0, 8)}/post-merge/${postMergeSha.substring(0, 8)}`;
  await tagHead(worktreePath, tagName);

  // Write completed response
  updatePhase(status, 'writing_response', protocolDir);
  log(`[supervisor] Sync complete. merged=${syncResult.merged} pre=${syncResult.preMergeSha.substring(0, 8)} post=${postMergeSha.substring(0, 8)} target=${syncResult.targetSha.substring(0, 8)} conflicts=${allMergeConflicts.length}`);

  pushStep(cmd.parent_branch, syncResult);

  // Any handoff the sync's agent turns left belongs to the LAST agent this
  // command ran — the announcements run no agent at all, so a handoff on one of
  // them would attribute an agent's note to the supervisor.
  const handoff = await handoffField(worktreePath, log);
  if (Object.keys(handoff).length > 0) {
    const lastAgentResponse = [...responses].reverse().find(r => !r.sync);
    if (lastAgentResponse) Object.assign(lastAgentResponse, handoff);
  }

  const bundle: CompletedResponseBundle = { status: 'completed', responses };
  writeCorrelatedResponse(protocolDir, bundle, cmd);
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
    const harness = commandHarness(cmd);
    const agent = getAgent(harness);
    await checkCommandAgentBinary(harness);
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
    delete process.env.LAZY_MCP_REVIEW;

    // An ask is still an agent turn, and it needs the READ-ONLY lazy tools to
    // answer questions about live task state. Without this the turn ran with
    // whatever ~/.claude.json the container happened to have — nothing at all
    // after a container relaunch, which is how asks lost their lazy tools.
    await prepareTurnMcp(runner, cmd.task_id, worktreePath, { toolset: 'read', harness: commandHarness(cmd), model: cmd.model_id });

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
      undefined, // _sleepOverride
      { taskId: cmd.task_id, agentId: cmd.agent_id },
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
    writeCorrelatedResponse(protocolDir, response, cmd);
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
    writeCorrelatedResponse(protocolDir, errorResponse, cmd);
  }
}

/**
 * Handle a review command: a read-only review turn in a NEW agent session.
 *
 * Same lockdown as ask (plan mode, read-only MCP, no integration phases).
 * The difference that must not regress: we pass no session id to runWork, so
 * the agent binary does not get `--resume` and cannot inherit the
 * implementer's conversation.
 */
async function handleReviewCommand(cmd: ReviewCommand, config: SupervisorConfig, runner: Runner): Promise<void> {
  const { protocolDir, worktreePath } = config;

  log(`[supervisor] Review command for task ${cmd.task_id.substring(0, 8)} (effort=${cmd.effort ?? 'default'}, new session)`);

  const reviewNow = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'work',
    task_id: cmd.task_id,
    command_type: 'review',
    started_at: reviewNow,
    updated_at: reviewNow,
    phase_started_at: reviewNow,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  try {
    const harness = commandHarness(cmd);
    const agent = getAgent(harness);
    await checkCommandAgentBinary(harness);
    const effectiveWatchdogMs = resolveWatchdogTimeout(
      cmd.watchdog_output_timeout_ms ?? 0,
      agent.defaultWatchdogTimeoutMs(),
    );

    const onRetryStateChange = makeRetryStatusHandler(status, protocolDir);

    // Review lockdown: worktree writes stay blocked (plan mode / disallowed
    // tools), but lazy_raise is advertised so findings land as Raises.
    // LAZY_MCP_READ_ONLY + LAZY_MCP_REVIEW gate the in-process handlers;
    // --review on the MCP argv withholds every other write before proxying.
    process.env.LAZY_MCP_READ_ONLY = '1';
    process.env.LAZY_MCP_REVIEW = '1';
    await prepareTurnMcp(runner, cmd.task_id, worktreePath, { toolset: 'review', harness: commandHarness(cmd), model: cmd.model_id });

    // Same handoff clear as work/ask: if MCP dies mid-review the
    // agent writes raised entries to turn-handoff.jsonl; a stale file from a
    // prior turn must not be attributed to this one.
    await clearTurnHandoff(worktreePath, log);

    const reviewPrompt = cmd.system_prompt
      ? `${reviewSystemPrompt}\n\n---\n\n${cmd.system_prompt}`
      : reviewSystemPrompt;

    const agentStart = Date.now();
    const result = await runWork(
      agent,
      runner,
      worktreePath,
      cmd.prompt,
      reviewPrompt,
      cmd.model_id,
      // INVARIANT: a review never resumes the work session. Passing undefined
      // here is what keeps `--resume` off the agent argv.
      undefined,
      protocolDir,
      onRetryStateChange,
      undefined,
      effectiveWatchdogMs,
      cmd.effort,
      'plan',
      undefined,
      cmd.agent_extra_args,
      undefined,
      { taskId: cmd.task_id, agentId: cmd.agent_id },
    );
    const agentDurationMs = Date.now() - agentStart;

    // THE ONE RE-ASK. A report the daemon cannot act on is unusable — it can
    // neither auto-fix, park nor gate on it — so ask the same session once more
    // for the JSON block alone. Single-shot, like the maintain follow-up; the answer
    // rides home separately so the first reply stays the turn's content. See
    // ./review-reask.ts.
    //
    // INVARIANT: the trigger is `resolveReviewVerdict`, the SAME predicate the
    // daemon fails a review by — never the verdict word alone. A report whose
    // `security` or `data_integrity` statement is missing is unparsed too
    // (src/review/parse-report.ts), and gating on the word let exactly that case
    // skip the recovery: `{"verdict":"clean"}` with no sweeps parsed its verdict,
    // got no re-ask, and was then recorded FAILED with a park reason claiming a
    // re-ask had happened. A forgotten sweep line is the cheapest failure there
    // is to recover from, and it is precisely what one re-ask exists for.
    let reask: Awaited<ReturnType<typeof runReviewVerdictReask>> | undefined;
    let reaskUsage: AgentTokenUsage | undefined;
    if (resolveReviewVerdict(parseReviewReport(result.result)) === 'unparsed') {
      updatePhase(status, 'review_reask', protocolDir);
      reask = await runReviewVerdictReask(
        agent,
        worktreePath,
        result.session_id,
        cmd.model_id,
        cmd.effort,
        cmd.agent_extra_args,
      );
      reaskUsage = reask.usage;
      updatePhase(status, 'review_reask_done', protocolDir);
    }

    updatePhase(status, 'writing_response', protocolDir);
    const response: CompletedResponse = {
      status: 'completed',
      result: result.result,
      session_id: result.session_id,
      // The re-ask is part of this turn's spend: one response, one turn, so its
      // tokens are rolled into the review's usage rather than being lost.
      usage: addAgentUsage(result.usage, reaskUsage) ?? result.usage,
      ...launchSettings(cmd, result.model_id),
      ...(result.mcp_tools ? { mcp_tools: result.mcp_tools } : {}),
      ...(reask && !reask.failed && reask.response ? { review_reask: reask.response } : {}),
      agent_duration_ms: agentDurationMs,
      // Collect raises the agent could not file via lazy_raise (MCP down).
      ...(await handoffField(worktreePath, log)),
    };
    writeCorrelatedResponse(protocolDir, response, cmd);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supervisor] Review work phase failed: ${errorMessage}`);

    const errorResponse: ErrorResponse = {
      status: 'error',
      error: `Work phase failed: ${errorMessage}`,
      phase: 'work',
      ...launchSettings(cmd),
      // Still collect: a crash after the agent wrote the handoff must not lose
      // findings that never reached lazy_raise.
      ...(await handoffField(worktreePath, log)),
    };
    describeTurnFailure(errorResponse, err);
    writeCorrelatedResponse(protocolDir, errorResponse, cmd);
  }
}

/**
 * Handle an acceptance-gate command: run the configured gate commands in the
 * worktree, mechanically, and report the outcome. This is the supervisor-side
 * of the MECHANICAL gate at accept — there is deliberately NO agent here: no
 * session, no model, no MCP config, no handoff, no retry/watchdog machinery.
 * The daemon drives the merge from the response's `accept_gate` field.
 *
 * A half-merged worktree is rolled back first (the same per-command recovery
 * every command gets), and the recovery report rides the response so the daemon
 * can journal it — the gate records no turn, so nothing else would surface it.
 */
async function handleAcceptGateCommand(cmd: AcceptGateCommand, config: SupervisorConfig): Promise<void> {
  const { protocolDir, worktreePath } = config;

  log(`[supervisor] Acceptance gate for task ${cmd.task_id.substring(0, 8)} (${cmd.accept_gate_commands.length} command(s))`);

  const gateRecovery = await recoverWorktreeState(worktreePath, 'acceptance gate');

  const now = new Date().toISOString();
  const status: SupervisorStatus = {
    phase: 'accept_gate',
    task_id: cmd.task_id,
    command_type: 'accept_gate',
    started_at: now,
    updated_at: now,
    phase_started_at: now,
    pid: process.pid,
  };
  writeStatus(protocolDir, status);

  const gate = await runAcceptanceGate(
    cmd.accept_gate_commands,
    worktreePath,
    cmd.accept_gate_timeout ?? DEFAULT_PRE_ACCEPT_TIMEOUT_SECS,
  );
  log(`[supervisor] Acceptance gate: ${gate.passed ? 'PASSED' : `FAILED (${gate.failedCommand})`}`);

  updatePhase(status, 'writing_response', protocolDir);
  // session_id/usage: no agent ran, but CompletedResponse requires both. The
  // sentinel and zero usage are the mechanical gate's honest shape — nothing
  // reads them (no turn is recorded from this response).
  const response: CompletedResponse = {
    status: 'completed',
    result: gate.passed
      ? `Acceptance gate passed (${cmd.accept_gate_commands.length} command(s)).`
      : `Acceptance gate failed: ${gate.failedCommand ?? 'a configured check'}`,
    session_id: 'mechanical-gate',
    usage: { input_tokens: 0, output_tokens: 0 },
    accept_gate: {
      passed: gate.passed,
      ...(gate.failedCommand !== undefined ? { failed_command: gate.failedCommand } : {}),
      ...(gate.exitCode !== undefined ? { exit_code: gate.exitCode } : {}),
      ...(gate.output !== undefined ? { output: gate.output } : {}),
    },
    ...(gateRecovery ? { worktree_recovery: gateRecovery } : {}),
  };
  writeCorrelatedResponse(protocolDir, response, cmd);
}

// --- Helpers ---

/**
 * Put everything we know about a failed turn onto its ErrorResponse.
 *
 * One function for every failure path (work, ask, review, wrap-up) on purpose: this
 * used to be several near-identical copies, and they had already drifted — only
 * the work copy handled a wind-down kill, so an ask or pre-accept turn killed that
 * way lost its recovered session id. A detail added to one copy and not the
 * others is exactly the class of hole this consolidation closes.
 *
 * INVARIANT: salvaged token usage is applied for EVERY error class, outside the
 * branch chain. A turn that spent tokens and then died must be able to put those
 * tokens on a turn record regardless of how it died — attributing them to the
 * session alone is what produced `session.total_usage > sum(turns)` gaps.
 */
export function describeTurnFailure(errorResponse: ErrorResponse, err: unknown): void {
  // INVARIANT: a session id the turn's own stream reported is recorded on the
  // error response for EVERY failure class, before anything else — it is what
  // lets auto-resume (and `lazy unblock`) continue the conversation instead of
  // starting a new one. The 2026-09-16 pi incident lost exactly this: the
  // crashed turn knew its session id, the response dropped it, and the
  // auto-resume an hour later re-sent the full prompt to a brand-new session.
  // A newer turn's completion later overwrites it via
  // shouldReconcileAgentSessionId, so a stale id cannot outlive the truth.
  const errSessionId = turnErrorSessionId(err);
  if (errSessionId && !errorResponse.session_id) {
    errorResponse.session_id = errSessionId;
  }

  if (err instanceof CrashLoopError) {
    // The fast-crash-loop backstop. It carries the same three fields, but the
    // class is always `unknown` (the detector runs for nothing else), and the
    // reconciler deliberately keeps `unknown` on the interrupted + auto-resume
    // path — see handleErrorResponse. This is diagnosis reaching the human, not
    // a verdict that the task needs one.
    errorResponse.failure_class = err.failureClass;
    errorResponse.failure_reason = err.failureReason;
    errorResponse.failure_attempts = err.attempts;
  } else if (err instanceof FatalAgentError) {
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
    // was recovered when possible (resume case or jsonl tail) and is assigned
    // generically at the top of this function.
    errorResponse.duration_ms = err.durationMs;
    if (!err.sessionId) {
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
    // Placeholder for reporting only — but never silent. See the twin in
    // src/supervisor/merge.ts: when git is refusing the whole worktree this is
    // the first call to fail, and swallowing it pushes the visible error several
    // git commands downstream where it no longer names the real cause.
    logWarn(`[supervisor] Could not read HEAD in ${cwd}: ${result.stderr || 'git rev-parse HEAD failed'}`);
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
