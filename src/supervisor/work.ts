/**
 * Work phase.
 *
 * Wraps the agent launch/capture logic. Runs the agent with the task
 * prompt and captures the JSON response.
 *
 * This is the supervisor's private implementation detail for running the
 * coding agent. The agent abstraction (src/agent/) handles CLI arg building,
 * response parsing, and error detection. Swapping agents requires only
 * changing the agent_id in config.
 */

import type { RetryError } from '../protocol/types';
import { hasCommand } from '../protocol/io';
import { log, logError } from './log';
import type { Agent } from '../agent/interface';
import type { AgentFailure, AgentFailureClass } from '../agent/failure-taxonomy';
import { decideRetry, decideWatchdogRetry, appliesFastFailDetection } from './retry-policy';
import type { Runner } from '../runner/types';
import { execWithWatchdog, WatchdogTimeoutError, GracefulExitTimeoutError } from './watchdog';
import { findLatestSessionFile } from '../agent/session-discovery';
import { runGit } from '../utils/git';
import type { AgentTokenUsage } from '../types';
import { addAgentUsage, attachUsage, readUsage, usageFromRawOutput } from './usage';
import { hostname } from 'os';
import { McpToolsUnavailableError } from './mcp-setup';
import { formatMcpObservation, verifyInitMcpTools } from './mcp-verify';

export { WatchdogTimeoutError, GracefulExitTimeoutError };

export interface WorkResult {
  result: string;
  session_id: string;
  usage: AgentTokenUsage;
  /** Concrete model id the agent reported, when it reports one (see AgentResponse). */
  model_id?: string;
  /**
   * What the agent reported about its lazy MCP tools at session start, in the
   * compact `lazy=<status> tools=<n>` form. Recorded on the turn so `lazy show`
   * can answer "did that turn have its tools?" after the container is gone.
   * Undefined when the agent reported nothing to judge.
   */
  mcp_tools?: string;
}

/** Structured error from a Claude Code crash (exit code != 0) */
export class CrashError extends Error {
  exitCode: number;
  stderr: string;
  stdoutError: string | undefined;
  durationMs: number;
  /** Tokens the agent reported before it crashed, when any could be salvaged. */
  usage?: AgentTokenUsage;

  constructor(opts: {
    message: string;
    exitCode: number;
    stderr: string;
    stdoutError?: string;
    durationMs: number;
    usage?: AgentTokenUsage;
  }) {
    super(opts.message);
    this.name = 'CrashError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdoutError = opts.stdoutError;
    this.durationMs = opts.durationMs;
    this.usage = opts.usage;
  }
}

/**
 * A failure the retry policy decided is not worth retrying.
 *
 * Carries the classification so the supervisor can put it on the wire and the
 * reconciler can block the task (rather than auto-resuming into the same wall).
 */
export class FatalAgentError extends Error {
  failureClass: AgentFailureClass;
  failureReason: string;
  attempts: number;
  /**
   * Tokens spent across EVERY attempt in the turn that ended here — set by
   * runWork's ledger, not by a single launch. A turn that burned three retries
   * before giving up spent all three; attributing only the last would under-count.
   */
  usage?: AgentTokenUsage;

  constructor(opts: {
    message: string;
    failureClass: AgentFailureClass;
    failureReason: string;
    attempts: number;
    usage?: AgentTokenUsage;
  }) {
    super(opts.message);
    this.name = 'FatalAgentError';
    this.failureClass = opts.failureClass;
    this.failureReason = opts.failureReason;
    this.attempts = opts.attempts;
    this.usage = opts.usage;
  }
}

export interface RetryState {
  count: number;
  errors: RetryError[];
  consecutiveFastFails: number;
  lastLaunchTime?: number;
  /** Class of the most recent failure — surfaced in status.json for watch/show. */
  failureClass?: AgentFailureClass;
  /** Human-readable reason from the classifier, paired with failureClass. */
  failureReason?: string;
  /** Delay before the next attempt (ms), so the UI can say when it will retry. */
  nextDelayMs?: number;
}

/** Check whether an error message indicates the prompt/session is too large. */
function isPromptTooLongError(agent: Agent, errorMessage: string): boolean {
  return agent.isPromptTooLongError(errorMessage);
}

/**
 * Check whether an error message indicates the session ID is not found.
 * This happens when resuming a session that doesn't exist in the local agent
 * config — e.g. when switching from Docker mode (sandboxed config) to
 * host-process mode (real config), or after a clean install.
 * Retrying with the same session ID will always fail; we must start fresh.
 */
function isSessionNotFoundError(agent: Agent, errorMessage: string): boolean {
  return agent.isSessionNotFoundError(errorMessage);
}

/**
 * Ask the agent to classify a failed launch.
 *
 * A CrashError carries the exit code plus the stderr/stdout tails, which is
 * strictly more signal than the message alone — pass all of it through so the
 * agent can distinguish e.g. "binary missing" (exit 127) from a 429 body.
 *
 * A classifier that throws must never take the turn down with it: fall back to
 * `unknown`, which the policy retries conservatively.
 */
function classifyFailure(agent: Agent, err: unknown, errorMessage: string): AgentFailure {
  const input = err instanceof CrashError
    ? { message: errorMessage, exitCode: err.exitCode, stderr: err.stderr, stdoutError: err.stdoutError }
    : { message: errorMessage };
  try {
    return agent.classifyFailure(input);
  } catch (classifyErr) {
    logError(
      `[work] Agent ${agent.id} failed to classify its own error ` +
      `(${classifyErr instanceof Error ? classifyErr.message : String(classifyErr)}) — treating as unknown.`,
    );
    return { class: 'unknown', reason: 'classifier failed' };
  }
}

/**
 * Recover the tokens a dying turn already spent, so they can ride out on the
 * error and land on a turn record.
 *
 * A crashed or killed turn has usually paid for most of its context already —
 * dropping that is how sessions ended up with totals no turn accounts for. This
 * never throws and never blocks the failure path: when nothing is salvageable it
 * says so in the log and returns undefined, so the loss is visible rather than
 * silent (CLAUDE.md: never swallow).
 */
function salvageUsage(raw: string | undefined, context: string): AgentTokenUsage | undefined {
  return usageFromRawOutput(raw, (reason) => {
    log(`[work] No token usage recoverable after ${context}: ${reason}. This turn's tokens will not be attributed.`);
  });
}

/**
 * Execute the agent once and return the result or throw on error.
 * When watchdogTimeoutMs > 0, monitors output and kills hung processes.
 */
async function executeAgent(
  agent: Agent,
  runner: Runner,
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
  watchdogTimeoutMs?: number,
  effort?: string,
  permissionMode?: 'plan' | 'default',
  _protocolDir?: string,
  windDownTimeoutMs?: number,
  extraArgs?: string[],
): Promise<WorkResult> {
  const claudeArgs = agent.buildExecArgs({
    prompt,
    systemPrompt,
    modelId,
    sessionId: claudeSessionId,
    dangerouslySkipPermissions: true,
    effort,
    permissionMode,
    extraArgs,
  });

  const launchTime = Date.now();
  const effectiveTimeout = watchdogTimeoutMs ?? 0;
  const effectiveWindDownMs = windDownTimeoutMs ?? 0;
  const activityStream = agent.activityStream();

  // What the agent reported about its own lazy tools at session start, kept so
  // it can ride out on the successful turn as well as on the failure.
  let mcpObservation: string | undefined;

  const {
    stdout: output,
    stderr,
    exitCode,
    killedByWatchdog,
    killedDuringWindDown,
    windDownElapsedMs,
    resultLine,
    sessionId: streamSessionId,
    abortReason,
  } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    timeoutMs: effectiveTimeout,
    activityStream,
    windDownTimeoutMs: effectiveWindDownMs,
    // Line 1 of the agent's own stream is the only place that says whether THIS
    // turn actually has its lazy tools. `prepareTurnMcp` proves we wrote a
    // config; this proves the agent loaded one. See supervisor/mcp-verify.ts.
    abortOnSessionStart: (event) => {
      const verdict = verifyInitMcpTools(event);
      if (verdict.outcome === 'unknown') {
        // Absence of evidence is not evidence of absence: a future agent
        // release that stops reporting these fields, or an agent that never
        // did, must not have its turns killed. Log so the blind spot is at
        // least visible, and let the turn run.
        log(`[work] Could not verify this turn's lazy MCP tools — ${verdict.reason}. Letting the turn run.`);
        return null;
      }
      mcpObservation = formatMcpObservation(verdict.observation);
      if (verdict.outcome === 'ok') {
        log(`[work] Agent reports its lazy MCP tools at session start (${mcpObservation}).`);
        return null;
      }
      return verdict.reason;
    },
  });

  const runtime = Date.now() - launchTime;

  // Positive evidence the turn had NO lazy tools. Kill first, then fail the
  // turn with the same error prepareTurnMcp uses, so both blind spots land in
  // the one human-visible path. Checked before the guard branches below: the
  // abort is why the process died, and reporting it as a timeout would send
  // the human looking at watchdog settings for an MCP problem.
  if (abortReason) {
    throw new McpToolsUnavailableError(
      `This turn's agent started with NO lazy_* tools — ${abortReason}. Killed it after ` +
      `${runtime}ms rather than letting it run.\n` +
      `  Container/host: ${hostname()}\n` +
      `  Observed at session start: ${mcpObservation ?? 'unavailable'}\n` +
      `An agent without lazy tools cannot read task history, record follow-ups, or reach any ` +
      `lazy state, so its turn is not trustworthy. Note that \`claude mcp list\` printing ` +
      `"✔ Connected" does NOT contradict this: it proves only that the MCP server process ` +
      `starts and answers \`initialize\`, never that it registered any tools or that the agent ` +
      `loaded them. Run \`lazy-agent doctor\` inside the agent container to find out which ` +
      `link is broken, and \`lazy daemon status\` on the host.`,
    );
  }

  // No-progress kill. Whether this is retriable is decided by the caller (see
  // the WatchdogTimeoutError branch in runWork) — it needs the turn's start SHA
  // to answer "did this turn capture anything?". What executeAgent knows, and
  // passes along, is whether a result was ever on the wire.
  if (killedByWatchdog) {
    throw new WatchdogTimeoutError(effectiveTimeout, runtime, {
      progressBased: !!activityStream,
      capturedResult: !!resultLine,
      usage: salvageUsage(resultLine ?? output, 'no-progress watchdog kill'),
    });
  }

  // Wind-down kill: the agent produced its final result and then failed to
  // exit. The summary is already in hand, so this is a SUCCESSFUL turn — the
  // only thing lost is the CLI's own teardown. Returning the result here is
  // what keeps a killed wind-down from destroying a turn's summary (and from
  // aborting an accept whose pre-accept validation already committed).
  if (killedDuringWindDown) {
    if (resultLine) {
      try {
        const parsed = agent.parseResponse(resultLine, { workingDir: worktreePath }) as WorkResult;
        log(
          `[work] Agent did not exit within ${effectiveWindDownMs}ms of its final result; killed ` +
          `during wind-down. Summary was captured — treating the turn as successful.`,
        );
        return { ...parsed, ...(mcpObservation ? { mcp_tools: mcpObservation } : {}) };
      } catch (parseErr) {
        log(
          `[work] Wind-down kill: captured result could not be parsed ` +
          `(${parseErr instanceof Error ? parseErr.message : String(parseErr)}).`,
        );
      }
    }
    // No usable result. Fall back to the error path, still carrying the session
    // id so the human can resume the conversation.
    const recoveredSessionId = streamSessionId ?? await recoverSessionIdForGracefulExit(
      runner,
      worktreePath,
      claudeSessionId,
      launchTime,
    );
    throw new GracefulExitTimeoutError({
      timeoutMs: effectiveWindDownMs,
      durationMs: runtime,
      elapsedSinceSignalMs: windDownElapsedMs ?? effectiveWindDownMs,
      sessionId: recoveredSessionId,
      usage: salvageUsage(resultLine ?? output, 'wind-down kill with an unparseable result'),
    });
  }

  if (exitCode !== 0) {
    // Try to extract error from stdout JSON (Claude Code puts errors in stdout sometimes)
    let stdoutError: string | undefined;
    // Prefer the isolated result line: with a streaming agent, `output` is a
    // bounded tail of NDJSON and won't parse as a single object.
    const errorSource = resultLine ?? output;
    if (errorSource.trim()) {
      try {
        const parsed = JSON.parse(errorSource);
        // Claude Code may return { error: { message: "..." } } or { error: "..." }
        if (parsed.error) {
          stdoutError = typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error.message ?? JSON.stringify(parsed.error);
        } else if (parsed.result) {
          stdoutError = typeof parsed.result === 'string' ? parsed.result : undefined;
        }
      } catch {
        // stdout isn't JSON — capture last few lines as-is
        const trimmed = output.trim();
        if (trimmed.length > 0) {
          stdoutError = trimmed.split('\n').slice(-5).join('\n').substring(0, 500);
        }
      }
    }

    const stderrTail = stderr ? stderr.trim().split('\n').slice(-10).join('\n').substring(0, 500) : '';
    const errorMsg = stdoutError ?? stderrTail ?? `exit code ${exitCode}`;

    throw new CrashError({
      message: errorMsg,
      exitCode,
      stderr: stderrTail,
      stdoutError,
      durationMs: runtime,
      usage: salvageUsage(errorSource, `agent crash (exit ${exitCode})`),
    });
  }

  // Delegate parsing and validation to the agent.
  // Wrap in try-catch so parse/validation errors become CrashErrors with
  // proper metadata. Without this, a throw from parseResponse would propagate
  // as a plain Error and the retry loop in runWork would retry it with backoff
  // — but parse failures (exitCode 0, garbled output) are not transient and
  // retrying won't help.
  //
  // Prefer the result line the watchdog isolated: with a streaming agent
  // `output` holds only a bounded tail of the stream, but the result line is
  // always retained in full.
  try {
    const parsed = agent.parseResponse(resultLine ?? output, { workingDir: worktreePath }) as WorkResult;
    return { ...parsed, ...(mcpObservation ? { mcp_tools: mcpObservation } : {}) };
  } catch (parseErr) {
    throw new CrashError({
      message: parseErr instanceof Error ? parseErr.message : String(parseErr),
      exitCode: 0,
      stderr: '',
      stdoutError: output.substring(0, 500),
      durationMs: Date.now() - launchTime,
      usage: salvageUsage(resultLine ?? output, 'unparseable agent response'),
    });
  }
}

/**
 * Recover the Claude session id after a wind-down kill, so the human can
 * `lazy unblock` to resume the conversation instead of orphaning it.
 *
 * INVARIANT: GracefulExitTimeoutError must carry session_id whenever it is
 * recoverable. Two paths:
 *
 *   1. Resumed turn — the daemon already passed `agent_session_id` to the
 *      supervisor, which forwarded it as `--resume`. We have it locally.
 *   2. Fresh first turn — Claude writes `<session-id>.jsonl` into the runner's
 *      agent session project dir (`runner.agentSessionProjectDir`) from the
 *      moment it starts (same path `lazy watch` discovers). Pick the file
 *      modified after `launchTime` so we ignore stale sessions from previous
 *      turns.
 *
 * Returns undefined only when neither path yields anything (e.g. claude died
 * before writing any jsonl). The caller logs that case so it is debuggable.
 */
export async function recoverSessionIdForGracefulExit(
  runner: Runner,
  worktreePath: string,
  claudeSessionId: string | undefined,
  launchTime: number,
): Promise<string | undefined> {
  if (claudeSessionId) return claudeSessionId;
  try {
    const info = await findLatestSessionFile(runner.agentSessionProjectDir(worktreePath), launchTime);
    if (info) {
      log(`[work] Recovered session id ${info.sessionId.substring(0, 8)} from ${info.path} after wind-down kill.`);
      return info.sessionId;
    }
    log('[work] No JSONL session file found in worktree after wind-down kill — response will omit session_id (agent likely died before writing).');
    return undefined;
  } catch (err) {
    log(`[work] Failed to discover session id after wind-down kill: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Add or update an error in the deduplicated error log.
 */
function recordError(errors: RetryError[], errorMessage: string, failureClass?: AgentFailureClass): RetryError[] {
  const now = new Date().toISOString();
  const existing = errors.find(e => e.message === errorMessage);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    if (failureClass) existing.failure_class = failureClass;
    return errors;
  }

  const newError: RetryError = {
    message: errorMessage,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    ...(failureClass ? { failure_class: failureClass } : {}),
  };

  const updated = [...errors, newError];

  // Keep only last 10 errors (FIFO eviction)
  if (updated.length > 10) {
    return updated.slice(updated.length - 10);
  }

  return updated;
}

/**
 * HEAD of the worktree, or undefined if it cannot be read.
 *
 * Best-effort by design: this is only used to answer "did this turn commit
 * anything?", and a git failure must never take a turn down.
 */
async function tryHeadSha(worktreePath: string): Promise<string | undefined> {
  try {
    const res = await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath });
    if (res.exitCode !== 0) return undefined;
    const sha = res.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    // Unreadable git state — the caller falls back to "no commits observed",
    // which only makes the turn MORE likely to be retried. Logged by the caller.
    return undefined;
  }
}

/**
 * Whether the branch gained commits since `sinceSha`.
 *
 * Returns false when it cannot tell (no baseline SHA, or git failed). That
 * direction is deliberate: "we could not prove work was captured" resolves to
 * retriable, and a retry resumes the same agent session, so nothing already on
 * disk is lost or redone by it.
 */
async function gainedCommitsSince(worktreePath: string, sinceSha: string | undefined): Promise<boolean> {
  if (!sinceSha) return false;
  try {
    const res = await runGit(['rev-list', '--count', `${sinceSha}..HEAD`], { cwd: worktreePath });
    if (res.exitCode !== 0) return false;
    return parseInt(res.stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Sleep with periodic checks for new commands (every 2 seconds).
 * Returns true if a new command arrived, false if timeout completed.
 */
async function sleepWithCommandCheck(protocolDir: string, delayMs: number): Promise<boolean> {
  const checkIntervalMs = 2000;
  const endTime = Date.now() + delayMs;

  while (Date.now() < endTime) {
    if (hasCommand(protocolDir)) {
      log('[work] New command detected during retry backoff. Canceling retry.');
      return true;
    }
    await Bun.sleep(Math.min(checkIntervalMs, endTime - Date.now()));
  }

  return false;
}

/**
 * Run the work phase: execute Claude Code with the given prompt.
 * Automatically retries on failure with exponential backoff.
 *
 * @param agent The agent to use for execution
 * @param runner The runner — authoritative for where the agent's session log lives
 * @param worktreePath Working directory
 * @param prompt Full prompt to send to the agent
 * @param systemPrompt Optional static system prompt
 * @param modelId Optional model override
 * @param claudeSessionId Optional session ID to resume
 * @param protocolDir Protocol directory for checking new commands
 * @param onRetryStateChange Callback when retry state changes
 * @param _executeOverride Optional override for executeAgent (for testing)
 * @param watchdogTimeoutMs Output watchdog timeout in ms (0 = disabled)
 * @param agentExtraArgs Extra `claude` args for the agent launch (host OS-sandbox `--settings`)
 * @returns Parsed agent JSON response
 */
export async function runWork(
  agent: Agent,
  runner: Runner,
  worktreePath: string,
  prompt: string,
  systemPrompt?: string,
  modelId?: string,
  claudeSessionId?: string,
  protocolDir?: string,
  onRetryStateChange?: (state: RetryState | null) => void,
  _executeOverride?: (worktreePath: string, prompt: string, systemPrompt?: string, modelId?: string, claudeSessionId?: string, effort?: string, permissionMode?: 'plan' | 'default') => Promise<WorkResult>,
  watchdogTimeoutMs?: number,
  effort?: string,
  permissionMode?: 'plan' | 'default',
  windDownTimeoutMs?: number,
  agentExtraArgs?: string[],
  /**
   * Optional override for the retry backoff sleep (for testing) — same
   * test-seam convention as `_executeOverride`. When set, the command-check
   * sleep is bypassed, so the retry cadence can be asserted without burning
   * real wall-clock.
   */
  _sleepOverride?: (ms: number) => Promise<void>,
): Promise<WorkResult> {
  const execute = _executeOverride
    ? _executeOverride
    : (wt: string, p: string, sp?: string, mid?: string, sid?: string, eff?: string, pm?: 'plan' | 'default') =>
        executeAgent(agent, runner, wt, p, sp, mid, sid, watchdogTimeoutMs, eff, pm, protocolDir, windDownTimeoutMs, agentExtraArgs);
  let currentSessionId = claudeSessionId;

  let retryState: RetryState = {
    count: 0,
    errors: [],
    consecutiveFastFails: 0,
  };

  // Baseline for "did this turn commit anything?". Read once, before the first
  // launch, so a commit made by ANY attempt in this turn counts as captured work.
  const turnStartSha = await tryHeadSha(worktreePath);
  if (!turnStartSha) {
    log('[work] Could not read HEAD before launching — a watchdog kill will not be able to see this turn\'s commits.');
  }
  /** Watchdog kills in this turn, counted separately from ordinary crashes. */
  let watchdogKills = 0;

  /**
   * Tokens spent by attempts that FAILED, accumulated across the retry loop.
   *
   * INVARIANT: retries are internal to one turn, so every attempt's tokens
   * belong to that turn's record. Before this ledger existed, a turn that
   * crashed twice and then succeeded recorded only the successful attempt's
   * usage — the rest was spent, billed, and attributed to nothing.
   */
  let failedAttemptUsage: AgentTokenUsage | undefined;

  /**
   * Throw out of the retry loop with the turn's accumulated usage attached, so
   * the supervisor can put it on the wire no matter which exit path ended the
   * turn.
   */
  // Annotated on the VARIABLE, not just the arrow: TypeScript only treats a
  // function expression as never-returning for control-flow analysis when the
  // binding itself is explicitly typed.
  const fail: (err: unknown) => never = (err) => {
    throw attachUsage(err, failedAttemptUsage);
  };

  while (true) {
    const isRetry = retryState.count > 0;
    log(`[work] ${isRetry ? `Retry ${retryState.count}: ` : ''}Running ${agent.id}${currentSessionId ? ' (resume)' : ''}...`);

    const launchTime = Date.now();

    try {
      const result = await execute(worktreePath, prompt, systemPrompt, modelId, currentSessionId, effort, permissionMode);

      // Success! Reset retry state
      if (retryState.count > 0) {
        log(`[work] Success after ${retryState.count} retries.`);
        if (onRetryStateChange) {
          onRetryStateChange(null);
        }
      } else {
        log(`[work] ${agent.id} completed. Parsing response...`);
      }

      log(`[work] Response captured. Session: ${result.session_id.substring(0, 8)}...`);

      // Fold in what the failed attempts of THIS turn cost, so the turn record
      // reflects the whole turn rather than just its last launch.
      if (failedAttemptUsage) {
        log(`[work] Attributing ${retryState.count} failed attempt(s) of this turn to its turn record.`);
        return { ...result, usage: addAgentUsage(failedAttemptUsage, result.usage)! };
      }
      return result;

    } catch (err) {
      const runtime = Date.now() - launchTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Bank this attempt's tokens before deciding what to do with the failure —
      // every path out of here (retry, give up, rethrow) must keep them.
      failedAttemptUsage = addAgentUsage(failedAttemptUsage, readUsage(err));

      logError(`[work] ${agent.id} failed after ${runtime}ms: ${errorMessage}`);

      // INVARIANT: a turn that provably started with no lazy tools is NEVER
      // retried. Nothing about relaunching the same container with the same
      // config would give it tools; retrying would just burn three more turns
      // and bury the diagnosis under backoff noise. The human has to fix the
      // wiring, so fail straight out to them.
      if (err instanceof McpToolsUnavailableError) {
        retryState.nextDelayMs = undefined;
        if (onRetryStateChange) onRetryStateChange(retryState);
        fail(err);
      }

      // INVARIANT: a watchdog kill that CAPTURED WORK is never retried — the
      // agent's work is already on disk, so relaunching would either repeat it
      // or wedge the same way. A kill that captured NOTHING is retried: that
      // rationale does not apply to it (there is nothing on disk to repeat), and
      // it is exactly the shape of a hung first model call, which heals by
      // relaunching. See decideWatchdogRetry in retry-policy.ts.
      if (err instanceof WatchdogTimeoutError) {
        watchdogKills++;
        const gainedCommits = await gainedCommitsSince(worktreePath, turnStartSha);
        const capturedWork = err.capturedResult || gainedCommits;
        const decision = decideWatchdogRetry(capturedWork, watchdogKills);

        retryState.errors = recordError(retryState.errors, errorMessage);
        retryState.count++;
        retryState.lastLaunchTime = launchTime;
        retryState.consecutiveFastFails = 0;
        err.attempts = watchdogKills;
        err.capturedWork = capturedWork;

        if (decision.action === 'stop') {
          logError(
            `[work] Watchdog kill is not retriable — ${decision.reason} ` +
            `(captured_result=${err.capturedResult}, new_commits=${gainedCommits}).`,
          );
          retryState.nextDelayMs = undefined;
          if (onRetryStateChange) onRetryStateChange(retryState);
          fail(err);
        }

        retryState.nextDelayMs = decision.delayMs;
        if (onRetryStateChange) onRetryStateChange(retryState);
        log(`[work] ${decision.reason}. Relaunching in ${decision.delayMs / 1000}s...`);

        if (_sleepOverride) {
          await _sleepOverride(decision.delayMs);
        } else if (protocolDir) {
          if (await sleepWithCommandCheck(protocolDir, decision.delayMs)) {
            fail(new Error('Retry canceled: new command arrived'));
          }
        } else {
          await Bun.sleep(decision.delayMs);
        }
        continue;
      }

      // INVARIANT: Wind-down kills are never retried. The agent had already
      // emitted its final result — its work is on disk. Re-running would
      // either redo committed work or wedge on the same stuck tool call.
      // (Reaching here at all means the captured result was unparseable; a
      // parseable one is returned as a successful turn — see executeAgent.)
      if (err instanceof GracefulExitTimeoutError) {
        fail(err);
      }

      // Handle 'Prompt is too long' as a non-retriable session error.
      // Clear the session so the next attempt starts fresh (turn history
      // injection provides sufficient context for sessionless starts).
      if (isPromptTooLongError(agent, errorMessage)) {
        if (currentSessionId) {
          // Was resuming a session — clear it and retry fresh immediately
          log('[work] Session too large, starting fresh session with turn history.');
          currentSessionId = undefined;

          // Record the error but don't count toward crash-loop — this is expected
          retryState.errors = recordError(retryState.errors, errorMessage);
          retryState.count++;
          retryState.lastLaunchTime = launchTime;
          // Reset fast-fail counter since this isn't a transient crash
          retryState.consecutiveFastFails = 0;

          if (onRetryStateChange) {
            onRetryStateChange(retryState);
          }

          // Retry immediately — no backoff needed for session reset
          continue;
        }

        // Already running without a session — prompt/turn-history itself is too large.
        // Retrying won't help since the prompt won't get shorter.
        logError('[work] Prompt too long even without session resume. Cannot recover.');
        fail(new Error('Prompt is too long even without session resume. The prompt or turn history may need to be truncated.'));
      }

      // Handle 'No conversation found with session ID' — the session doesn't exist
      // in the local Claude config. This is unrecoverable with the same session ID;
      // drop it and start fresh with the turn history prompt instead.
      if (isSessionNotFoundError(agent, errorMessage) && currentSessionId) {
        log('[work] Session not found, starting fresh session with turn history.');
        currentSessionId = undefined;

        retryState.errors = recordError(retryState.errors, errorMessage);
        retryState.count++;
        retryState.lastLaunchTime = launchTime;
        retryState.consecutiveFastFails = 0;

        if (onRetryStateChange) {
          onRetryStateChange(retryState);
        }

        // Retry immediately — no backoff needed for session reset
        continue;
      }

      // Ask the AGENT what went wrong. The supervisor never reads error strings
      // itself — it branches on the returned class only (see retry-policy.ts).
      const failure: AgentFailure = classifyFailure(agent, err, errorMessage);
      log(`[work] Failure classified as ${failure.class}: ${failure.reason}`);

      // Track fast failures for crash loop detection.
      // Only for `unknown`: a 429 or a refused connection fails in milliseconds,
      // so counting those as a "crash loop" would abort a turn that is about to
      // recover. See appliesFastFailDetection.
      if (appliesFastFailDetection(failure.class)) {
        if (runtime < 10000) {
          retryState.consecutiveFastFails++;
        } else {
          retryState.consecutiveFastFails = 0;
        }

        // Fast-fail detection: 3 consecutive crashes under 10s = crash loop
        if (retryState.consecutiveFastFails >= 3) {
          logError('[work] Detected crash loop (3 fast failures). Stopping retries.');
          fail(new Error(`Crash loop detected: ${errorMessage}`));
        }
      } else {
        retryState.consecutiveFastFails = 0;
      }

      // Record the error
      retryState.errors = recordError(retryState.errors, errorMessage, failure.class);
      retryState.count++;
      retryState.lastLaunchTime = launchTime;
      retryState.failureClass = failure.class;
      retryState.failureReason = failure.reason;

      const decision = decideRetry(failure, retryState.count);

      if (decision.action === 'stop') {
        // Unrecoverable (or escalated after bounded retries): end the turn now.
        // The supervisor puts the classification on the wire and the reconciler
        // blocks the task, so nothing keeps burning time on a dead condition.
        logError(`[work] Not retrying — ${decision.reason}`);
        retryState.nextDelayMs = undefined;
        if (onRetryStateChange) {
          onRetryStateChange(retryState);
        }
        throw new FatalAgentError({
          message: `${decision.reason}. Last error: ${errorMessage}`,
          failureClass: failure.class,
          failureReason: failure.reason,
          attempts: retryState.count,
          usage: failedAttemptUsage,
        });
      }

      const delay = decision.delayMs;
      retryState.nextDelayMs = delay;

      // Notify caller of retry state change
      if (onRetryStateChange) {
        onRetryStateChange(retryState);
      }

      log(`[work] Retrying in ${delay / 1000}s (retry ${retryState.count}, ${decision.reason})...`);

      // Sleep with periodic checks for new commands
      if (_sleepOverride) {
        await _sleepOverride(delay);
      } else if (protocolDir) {
        const newCommandArrived = await sleepWithCommandCheck(protocolDir, delay);
        if (newCommandArrived) {
          fail(new Error('Retry canceled: new command arrived'));
        }
      } else {
        await Bun.sleep(delay);
      }
    }
  }
}
