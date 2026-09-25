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
import { listUncommittedPaths } from '../git/operations';
import { log, logError, logWarn } from './log';
import { execWithWatchdog } from './watchdog';
import commitLeftoversTemplate from '../prompts/commit-leftovers.md' with { type: 'text' };

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
): Promise<LeftoversFollowupResult> {
  const prompt = commitLeftoversTemplate
    .replace('{{count}}', String(paths.length))
    .replace('{{paths}}', renderUncommittedPaths(paths));

  log(`[leftovers] Resuming session ${sessionId.substring(0, 8)}... with ${paths.length} uncommitted path(s)`);

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
    effort,
    extraArgs,
  });

  const { stdout, stderr, exitCode } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    // Committing is quick, but the honest answer to "is this junk?" can mean
    // re-reading the file or finishing the edit, so this gets the same budget
    // the maintain nudge has rather than a tight one that kills a real answer.
    timeoutMs: 600_000, // 10 minutes
  });

  if (exitCode !== 0) {
    logError(`[leftovers] Agent exited with code ${exitCode}`);
    logError(`[leftovers] stderr: ${stderr.slice(-500)}`);
    // Non-fatal: the re-detection still runs, so the turn still REPORTS what is
    // loose in the worktree even when nobody could be asked about it.
    return {
      prompt,
      response: 'Uncommitted-work follow-up failed: agent exited with an error.',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
    };
  }

  let responseText: string;
  let responseSessionId = sessionId;
  let usage: AgentResponse['usage'] = { ...ZERO_USAGE };
  let reportedModelId: string | undefined;
  try {
    const parsed = agent.parseResponse(stdout, { workingDir: worktreePath });
    responseText = parsed.result;
    responseSessionId = parsed.session_id;
    usage = parsed.usage;
    reportedModelId = parsed.model_id;
  } catch (err) {
    logError(`[leftovers] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    responseText = 'Uncommitted-work follow-up failed: could not parse agent response.';
  }

  log(`[leftovers] Agent responded (${responseText.length} chars)`);
  return { prompt, response: responseText, session_id: responseSessionId, usage, model_id: reportedModelId };
}
