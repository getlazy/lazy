/**
 * Reactive-automation match detection and follow-up — the generalized case of
 * protected-file push-back (see ./permissions.ts), with user-authored
 * instructions instead of revert/justify.
 *
 * When a turn's commits *touch* a configured `[[automation.react]]` pattern,
 * the supervisor nudges the agent once with that entry's instructions (e.g.
 * "take UI screenshots"). Inverse trigger of maintained-files
 * (`./maintain.ts`): maintain fires on skip; react fires on match.
 *
 * Single-shot: detect matched groups → one follow-up → record. No loop. The
 * nudge itself is not a gate and never re-triggers push-back; after the
 * follow-up the supervisor re-detects protected-file violations so edits made
 * during react can still park the turn in conflict.
 */

import type { ReactEntry } from '../config/types';
import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import { runGit } from '../utils/git';
import { log, logError, logWarn } from './log';
import { execWithWatchdog } from './watchdog';
import reactFollowupTemplate from '../prompts/react-followup.md' with { type: 'text' };
import reactContextTemplate from '../prompts/react-context.md' with { type: 'text' };

/** Heading the reconciler uses to label the reactive-automation nudge turn. */
export const REACT_REVIEW_HEADING = '## Reactive Automation';

/** Path prefix for the agent's sandbox, excluded from change scans. */
const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Check if a file path matches a react pattern. Same Bun.Glob matcher as
 * protected-file / maintain detection for consistency.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(filePath);
}

/**
 * Collect files the turn changed: committed diff (startSha..endSha), excluding
 * the agent sandbox. COMMITTED ONLY — mirrors maintain / detectViolations.
 *
 * A failed `git diff` is logged and treated as "no changes" so a broken scan
 * never looks identical to a clean miss without a warning in the supervisor log.
 */
async function getTurnChangedFiles(
  worktreePath: string,
  startSha: string,
  endSha: string,
): Promise<Set<string>> {
  const files = new Set<string>();
  if (startSha === endSha) return files;

  const result = await runGit(
    ['diff', '--name-only', startSha, endSha, '--', ':!' + SANDBOX_DIR],
    { cwd: worktreePath },
  );
  if (result.exitCode === 0) {
    for (const line of result.stdout.split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  } else {
    // INVARIANT: a failed scan must not silently look like "no match".
    logWarn(
      `[react] git diff --name-only failed (exit ${result.exitCode}) for ` +
      `${startSha.substring(0, 8)}..${endSha.substring(0, 8)}; treating as no changed files. ` +
      `stderr: ${result.stderr.slice(-300)}`,
    );
  }

  return files;
}

export interface MatchDetectionResult {
  /** React groups whose pattern matched at least one of the turn's changed files. */
  matched: ReactEntry[];
  /** Whether the turn produced any committed change at all (sandbox excluded). */
  turnHadChanges: boolean;
}

/**
 * Determine which reactive groups the turn matched.
 *
 * Returns `matched: []` when there are no react groups OR the turn produced no
 * changes. Otherwise a group is "matched" when any changed file matches its
 * pattern.
 */
export async function detectMatchedReactEntries(
  worktreePath: string,
  startSha: string,
  endSha: string,
  entries: ReactEntry[],
): Promise<MatchDetectionResult> {
  if (entries.length === 0) {
    return { matched: [], turnHadChanges: false };
  }

  const changedFiles = await getTurnChangedFiles(worktreePath, startSha, endSha);
  const turnHadChanges = changedFiles.size > 0;

  if (!turnHadChanges) {
    log('[react] Turn produced no changes — skipping reactive-automation check');
    return { matched: [], turnHadChanges: false };
  }

  const matched: ReactEntry[] = [];
  for (const entry of entries) {
    const touched = [...changedFiles].some(f => matchesPattern(f, entry.pattern));
    log(`[react] Group "${entry.title}" (${entry.pattern}): ${touched ? 'MATCHED' : 'untouched'}`);
    if (touched) matched.push(entry);
  }

  return { matched, turnHadChanges };
}

/** Render a react group as a bulleted "- <title> (<pattern>): <instructions>" line. */
function renderEntries(entries: ReactEntry[]): string {
  return entries
    .map(e => `- ${e.title} (${e.pattern}): ${e.instructions}`)
    .join('\n');
}

/**
 * Render up-front reactive-automation context to append to the agent's system
 * prompt. Returns '' when there are no react groups.
 */
export function renderReactContext(entries: ReactEntry[] | undefined): string {
  if (!entries || entries.length === 0) return '';
  return reactContextTemplate.replace('{{entries}}', renderEntries(entries));
}

export interface ReactFollowupResult {
  /** The follow-up nudge prompt the supervisor sent to the agent. */
  prompt: string;
  /** The agent's text response to the follow-up nudge. */
  response: string;
  /** Agent session id the follow-up invocation reported. */
  session_id: string;
  /** Full token usage of the follow-up invocation. */
  usage: AgentResponse['usage'];
  /** Concrete model id the agent reported for THIS invocation, when present. */
  model_id?: string;
}

/** Zero-usage fallback for a failed follow-up (no agent tokens were spent). */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/**
 * Resume the agent's session with a follow-up naming the matched react groups
 * and their instructions.
 *
 * Single-shot — mirrors runMaintainFollowup / runPermissionPushback. The
 * supervisor does NOT re-detect and re-prompt; after this returns the turn
 * proceeds to block regardless.
 */
export async function runReactFollowup(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  matched: ReactEntry[],
  modelId?: string,
  effort?: string,
  /**
   * Host OS-sandbox `--settings` (and any other argv) from
   * `commonCommandFields.agent_extra_args`. Same path work/push-back use —
   * Playwright/demo follow-ups must not silently drop the host sandbox.
   */
  extraArgs?: string[],
): Promise<ReactFollowupResult> {
  const prompt = reactFollowupTemplate
    .replace('{{count}}', String(matched.length))
    .replace('{{entries}}', renderEntries(matched));

  log(`[react] Resuming session ${sessionId.substring(0, 8)}... with ${matched.length} matched group(s)`);

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
    // The reaction can ask the agent to do real work (screenshots, demos), so it
    // needs a watchdog — without one a hung follow-up hangs the supervisor forever.
    timeoutMs: 600_000, // 10 minutes
  });

  if (exitCode !== 0) {
    logError(`[react] Agent exited with code ${exitCode}`);
    logError(`[react] stderr: ${stderr.slice(-500)}`);
    return {
      prompt,
      response: 'Reactive-automation follow-up failed: agent exited with an error.',
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
    logError(`[react] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    responseText = 'Reactive-automation follow-up failed: could not parse agent response.';
  }

  log(`[react] Agent responded (${responseText.length} chars)`);
  return { prompt, response: responseText, session_id: responseSessionId, usage, model_id: reportedModelId };
}
