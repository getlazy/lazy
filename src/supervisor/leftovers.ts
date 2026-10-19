/**
 * Leftover detection and the commit-or-discard follow-up — the last thing a
 * wrap-up chain does before the walkthrough.
 *
 * Every other end-of-turn scan in this directory reads the COMMITTED range:
 * protected-file violations (./permissions.ts) and the maintained-file sweep
 * (./maintain.ts) both diff `base..HEAD`, deliberately, because that is what
 * reaches the parent branch. The blind spot is the exact complement of that
 * choice — an edit the agent made and never committed is invisible to all of
 * them, and is dropped the moment the worktree is torn down.
 *
 * It is not a hypothetical. The maintained-file nudge asks the agent to "make
 * the update (and commit it)"; four children of one cluster made the update,
 * skipped the commit, and reported themselves finished. Each was caught only
 * because a human ran `git status` by hand. So the chain now ends by looking at
 * the WORKING TREE and, when something is loose in it, spending one invocation
 * asking the agent — still in session, still holding the context that wrote the
 * file — to commit it or say it is junk.
 *
 * Single-shot, exactly like the maintain and push-back exchanges: detect → one
 * follow-up → re-detect → record. There is no loop and no retry, and what
 * remains dirty afterwards is reported rather than fixed.
 *
 * THE SUPERVISOR NEVER COMMITS FOR THE AGENT. A leftover sweep that committed
 * whatever it found would put unreviewed content — scratch files, a half-edited
 * config, a key someone pasted into the worktree — on the branch under the
 * agent's name. Agents commit through `lazy_commit`; this step only asks.
 */

import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import type { AgentActivityStream } from '../agent/activity-stream';
import { listUncommittedPaths } from '../git/operations';
import { log, logError, logWarn } from './log';
import { execWithWatchdog } from './watchdog';
import commitLeftoversTemplate from '../prompts/commit-leftovers.md' with { type: 'text' };
import commitNudgeTemplate from '../prompts/commit-nudge.md' with { type: 'text' };
import backgroundNudgeTemplate from '../prompts/background-nudge.md' with { type: 'text' };

/**
 * How many paths a single report carries. A worktree with more loose files than
 * this has a different problem than the one this step exists for, and neither a
 * prompt nor a turn record is improved by the rest of the list.
 */
export const MAX_REPORTED_PATHS = 50;

/**
 * The uncommitted paths, or `null` when the scan failed — the SAME worktree
 * question `hasUncommittedChanges` (and therefore the accept gate) answers,
 * from the same exclusions, because this step must not nudge about a file
 * accept would happily merge past.
 *
 * Wrapped here only to put the supervisor's log line on the failure: a broken
 * `git status` is why a turn goes unchecked, and that must be visible in the
 * container log rather than inferred from a missing nudge.
 */
export async function detectUncommittedPaths(worktreePath: string): Promise<string[] | null> {
  const paths = await listUncommittedPaths(worktreePath);
  if (paths === null) {
    logWarn(
      `[leftovers] git status failed in ${worktreePath}; ` +
      'cannot tell whether work was left uncommitted',
    );
  }
  return paths;
}

/** Render the detected paths for a prompt or a message, capped and counted. */
export function renderUncommittedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_REPORTED_PATHS);
  const lines = shown.map(p => `- ${p}`);
  if (paths.length > shown.length) {
    lines.push(`- …and ${paths.length - shown.length} more`);
  }
  return lines.join('\n');
}

export interface LeftoversFollowupResult {
  /** The follow-up nudge prompt the supervisor sent to the agent. */
  prompt: string;
  /** The agent's text response to the follow-up nudge. */
  response: string;
  /** Agent session id the follow-up invocation reported (for session reconciliation). */
  session_id: string;
  /** Full token usage of the follow-up invocation (incl. cache tokens). */
  usage: AgentResponse['usage'];
  /** Concrete model id the agent reported for THIS invocation, when it reports one. */
  model_id?: string;
  /** Set when the agent exited with an error or its answer could not be parsed. */
  failed?: true;
}

/** Zero-usage fallback for a failed follow-up (no agent tokens were spent). */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/**
 * Resume the agent's session with a follow-up naming the uncommitted paths,
 * asking it to commit them or discard them.
 *
 * Single-shot — mirrors `runMaintainFollowup`. The caller re-detects afterwards
 * and reports what is left; it does not prompt again.
 */
export async function runLeftoversFollowup(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  paths: readonly string[],
  modelId?: string,
  effort?: string,
  /** Host OS-sandbox `--settings` (and any other argv), as the work phase gets. */
  extraArgs?: string[],
  /** Which question to ask: the final chain's commit-or-discard step, or the
   *  once-per-turn "have you committed all your work?" nudge. */
  template: string = commitLeftoversTemplate,
): Promise<LeftoversFollowupResult> {
  const prompt = template
    .replace('{{count}}', String(paths.length))
    .replace('{{paths}}', renderUncommittedPaths(paths));
  log(`[leftovers] Resuming session ${sessionId.substring(0, 8)}... with ${paths.length} uncommitted path(s)`);
  return runSessionNudge(agent, worktreePath, sessionId, prompt, 'Uncommitted-work follow-up', modelId, effort, extraArgs);
}

/**
 * The one code path every end-of-turn NUDGE shares: resume the agent's
 * session with one question, return its answer. A question, not an
 * instruction — the agent may answer "no" — and single-shot: the caller asks
 * once per turn and never re-checks to ask again.
 */
export interface NudgeGuards {
  /** No-progress timeout (ms). Default: 10 minutes. */
  timeoutMs?: number;
  /** Parse the agent's stream, so only real progress counts and the result is isolated. */
  activityStream?: AgentActivityStream | null;
  /** Wind-down window after the result (ms); 0 disables. */
  windDownTimeoutMs?: number;
}

export async function runSessionNudge(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  prompt: string,
  /** Names the nudge in log lines and in a failed answer's text. */
  label: string,
  modelId?: string,
  effort?: string,
  extraArgs?: string[],
  guards?: NudgeGuards,
): Promise<LeftoversFollowupResult> {
  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
    effort,
    extraArgs,
  });

  const { stdout, stderr, exitCode, resultLine } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    activityStream: guards?.activityStream ?? undefined,
    windDownTimeoutMs: guards?.windDownTimeoutMs ?? 0,
    // Committing is quick, but the honest answer to "is this junk?" — or
    // re-running a stopped test suite — can take real work, so this gets the
    // same budget the maintain nudge has rather than a tight one that kills a
    // real answer.
    timeoutMs: guards?.timeoutMs ?? 600_000, // 10 minutes by default
  });

  if (exitCode !== 0) {
    logError(`[leftovers] ${label}: agent exited with code ${exitCode}`);
    logError(`[leftovers] stderr: ${stderr.slice(-500)}`);
    // Non-fatal: the caller still REPORTS what it found even when nobody could
    // be asked about it.
    return {
      prompt,
      response: `${label} failed: agent exited with an error.`,
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }

  let responseText: string;
  let responseSessionId = sessionId;
  let usage: AgentResponse['usage'] = { ...ZERO_USAGE };
  let reportedModelId: string | undefined;
  let failed = false;
  try {
    // With a stream, the isolated last result (usage summed) is the answer.
    const parsed = agent.parseResponse(resultLine ?? stdout, { workingDir: worktreePath });
    responseText = parsed.result;
    responseSessionId = parsed.session_id;
    usage = parsed.usage;
    reportedModelId = parsed.model_id;
  } catch (err) {
    logError(`[leftovers] ${label}: failed to parse response: ${err instanceof Error ? err.message : err}`);
    responseText = `${label} failed: could not parse agent response.`;
    failed = true;
  }

  log(`[leftovers] ${label}: agent responded (${responseText.length} chars)`);
  return { prompt, response: responseText, session_id: responseSessionId, usage, model_id: reportedModelId, ...(failed ? { failed: true as const } : {}) };
}

/**
 * The once-per-turn background nudge (engineer's decision, 2026-10-06). The
 * turn ended while background work the agent started was still running, and
 * it was stopped — Claude Code stops a background shell 5s after the turn's
 * result. Lazy does not know whether the agent needed that work to finish, so
 * it ASKS, gently: "are you sure you didn't need it?" Same rules as the commit
 * nudge, and run just before it.
 */
export function runBackgroundNudge(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  tasks: readonly string[],
  modelId?: string,
  effort?: string,
  extraArgs?: string[],
  guards?: NudgeGuards,
): Promise<LeftoversFollowupResult> {
  const prompt = renderBackgroundNudgePrompt(tasks);
  log(`[leftovers] Background nudge: ${tasks.length} background task(s) stopped at turn end`);
  return runSessionNudge(agent, worktreePath, sessionId, prompt, 'Background-work follow-up', modelId, effort, extraArgs, guards);
}

/** Longest command label the nudge quotes; the rest is elided. */
export const MAX_BACKGROUND_LABEL_CHARS = 200;

/**
 * The background nudge's prompt. Each label is the agent's raw backgrounded
 * command, so it is flattened to one line (a heredoc or multi-line chain would
 * break the inline code span) and capped, so one huge command cannot bloat
 * the prompt.
 */
export function renderBackgroundNudgePrompt(tasks: readonly string[]): string {
  const lines = tasks.map(t => {
    let label = t.replace(/\s+/g, ' ').trim().replace(/`/g, "'");
    if (label.length > MAX_BACKGROUND_LABEL_CHARS) label = label.slice(0, MAX_BACKGROUND_LABEL_CHARS - 1) + '…';
    return `- \`${label}\``;
  });
  return backgroundNudgeTemplate.replace('{{tasks}}', lines.join('\n'));
}

/**
 * The once-per-turn commit nudge (engineer's design, 2026-10-06): a work turn
 * about to end — final or parked — with a dirty worktree is asked ONE question
 * in the same session, "have you committed all your work?", before anything
 * else runs. It is a question, not an instruction: the agent may say why a
 * path should stay loose, and nothing is ever committed for it. At most one
 * per turn — the caller asks once and never re-checks to ask again; whatever
 * is still loose when the turn ends is announced by the daemon instead
 * (src/task/uncommitted-left-behind.ts).
 */
export function runCommitNudge(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  paths: readonly string[],
  modelId?: string,
  effort?: string,
  extraArgs?: string[],
): Promise<LeftoversFollowupResult> {
  return runLeftoversFollowup(agent, worktreePath, sessionId, paths, modelId, effort, extraArgs, commitNudgeTemplate);
}
