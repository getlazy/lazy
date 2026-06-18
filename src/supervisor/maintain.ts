/**
 * Maintained-file skip detection and follow-up — the inverse of protected-file
 * violations (see ./permissions.ts).
 *
 * Protected patterns flag files agents must NOT touch. Maintained patterns are
 * files agents are *expected* to keep up to date (docs, CHANGELOG, architecture
 * diagrams). When a turn's changes touch NONE of a maintained group's files, the
 * supervisor nudges the agent once — "you didn't update <title>, are you sure?"
 * — so a silent omission becomes a deliberate, recorded decision.
 *
 * This is a single-shot mechanism: detect skipped groups → one follow-up →
 * record. No loop. The follow-up's response is appended to the turn so reviewers
 * can tell a justified skip from a forgotten one.
 */

import type { MaintainEntry } from '../config/types';
import type { AgentResponse } from '../types';
import type { Agent } from '../agent/interface';
import { runGit } from '../utils/git';
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';
import maintainFollowupTemplate from '../prompts/maintain-followup.md' with { type: 'text' };
import maintainContextTemplate from '../prompts/maintain-context.md' with { type: 'text' };

/** Heading the reconciler uses to label the maintained-files nudge turn. */
export const MAINTAIN_REVIEW_HEADING = '## Maintained Files Review';

/** Path prefix for the agent's sandbox, excluded from "did the turn change anything" checks. */
const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Check if a file path matches any maintained pattern. Uses the same Bun.Glob
 * matcher as protected-file detection (permissions.ts) for consistency.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(filePath);
}

/**
 * Collect the set of files the turn changed: the committed diff
 * (startSha..endSha), excluding the agent sandbox.
 *
 * COMMITTED ONLY — this mirrors protected-file `detectViolations`, which also
 * scans the committed range only. Uncommitted working-tree changes never reach
 * the parent branch (agents commit via lazy_commit; the supervisor has no
 * leftover-commit sweep), so a maintained file edited but not committed will NOT
 * land — and the agent SHOULD still be nudged (to actually commit it). Scanning
 * the working tree would wrongly suppress that nudge.
 */
async function getTurnChangedFiles(
  worktreePath: string,
  startSha: string,
  endSha: string,
): Promise<Set<string>> {
  const files = new Set<string>();
  if (startSha === endSha) return files;

  // `--name-only` emits BARE paths (one per line) — robust to whitespace
  // trimming, unlike `git status --porcelain`'s fixed status columns.
  const result = await runGit(
    ['diff', '--name-only', startSha, endSha, '--', ':!' + SANDBOX_DIR],
    { cwd: worktreePath },
  );
  if (result.exitCode === 0) {
    for (const line of result.stdout.split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  }

  return files;
}

export interface SkipDetectionResult {
  /** Maintained groups whose pattern matched none of the turn's changed files. */
  skipped: MaintainEntry[];
  /** Whether the turn produced any committed change at all (sandbox excluded). */
  turnHadChanges: boolean;
}

/**
 * Determine which maintained groups the turn skipped.
 *
 * Returns `skipped: []` when there are no maintained groups OR the turn produced
 * no changes at all (a no-op/hub turn is never nagged about docs). Otherwise,
 * a group is "skipped" when none of the turn's changed files match its pattern.
 */
export async function detectSkippedMaintainEntries(
  worktreePath: string,
  startSha: string,
  endSha: string,
  entries: MaintainEntry[],
): Promise<SkipDetectionResult> {
  if (entries.length === 0) {
    return { skipped: [], turnHadChanges: false };
  }

  const changedFiles = await getTurnChangedFiles(worktreePath, startSha, endSha);
  const turnHadChanges = changedFiles.size > 0;

  // No-op turn: skip the whole check. A turn that changed nothing has nothing
  // to maintain alongside — nagging would be noise on hub/no-op turns.
  if (!turnHadChanges) {
    log('[maintain] Turn produced no changes — skipping maintained-file check');
    return { skipped: [], turnHadChanges: false };
  }

  const skipped: MaintainEntry[] = [];
  for (const entry of entries) {
    const touched = [...changedFiles].some(f => matchesPattern(f, entry.pattern));
    log(`[maintain] Group "${entry.title}" (${entry.pattern}): ${touched ? 'touched' : 'SKIPPED'}`);
    if (!touched) skipped.push(entry);
  }

  return { skipped, turnHadChanges };
}

/** Render a maintained group as a bulleted "- <title> (<pattern>): <instructions>" line. */
function renderEntries(entries: MaintainEntry[]): string {
  return entries
    .map(e => `- ${e.title} (${e.pattern}): ${e.instructions}`)
    .join('\n');
}

/**
 * Render up-front maintained-file context to append to the agent's system
 * prompt. Returns '' when there are no maintained groups so the prompt is
 * unchanged in the common (opt-out) case.
 */
export function renderMaintainContext(entries: MaintainEntry[] | undefined): string {
  if (!entries || entries.length === 0) return '';
  return maintainContextTemplate.replace('{{entries}}', renderEntries(entries));
}

export interface MaintainFollowupResult {
  /** The follow-up nudge prompt the supervisor sent to the agent. */
  prompt: string;
  /** The agent's text response to the follow-up nudge. */
  response: string;
  /** Agent session id the follow-up invocation reported (for session reconciliation). */
  session_id: string;
  /** Full token usage of the follow-up invocation (incl. cache tokens). */
  usage: AgentResponse['usage'];
}

/** Zero-usage fallback for a failed follow-up (no agent tokens were spent). */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/**
 * Resume the agent's session with a follow-up nudge naming the skipped
 * maintained groups, asking it to either make the update or justify skipping.
 *
 * Single-shot — mirrors runPermissionPushback. The supervisor does NOT re-detect
 * and re-prompt; after this returns the turn proceeds to block regardless.
 */
export async function runMaintainFollowup(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  skipped: MaintainEntry[],
  modelId?: string,
  effort?: string,
): Promise<MaintainFollowupResult> {
  const prompt = maintainFollowupTemplate
    .replace('{{count}}', String(skipped.length))
    .replace('{{entries}}', renderEntries(skipped));

  log(`[maintain] Resuming session ${sessionId.substring(0, 8)}... with ${skipped.length} skipped group(s)`);

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
    effort,
  });

  const { stdout, stderr, exitCode } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    // The nudge can ask the agent to do real work (update docs/CHANGELOG), so it
    // needs a watchdog — without one a hung follow-up hangs the supervisor forever.
    timeoutMs: 600_000, // 10 minutes
  });

  if (exitCode !== 0) {
    logError(`[maintain] Agent exited with code ${exitCode}`);
    logError(`[maintain] stderr: ${stderr.slice(-500)}`);
    // Follow-up failure is non-fatal — record that it failed and move on.
    return { prompt, response: 'Maintained-files follow-up failed: agent exited with an error.', session_id: sessionId, usage: { ...ZERO_USAGE } };
  }

  let responseText: string;
  let responseSessionId = sessionId;
  let usage: AgentResponse['usage'] = { ...ZERO_USAGE };
  try {
    const parsed = agent.parseResponse(stdout, { workingDir: worktreePath });
    responseText = parsed.result;
    responseSessionId = parsed.session_id;
    usage = parsed.usage;
  } catch (err) {
    logError(`[maintain] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    responseText = 'Maintained-files follow-up failed: could not parse agent response.';
  }

  log(`[maintain] Agent responded (${responseText.length} chars)`);
  return { prompt, response: responseText, session_id: responseSessionId, usage };
}

