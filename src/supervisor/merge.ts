/**
 * Merge-and-fix phase.
 *
 * Runs as a supervised phase before the main work phase. Merges the parent
 * branch into the current branch, using Claude Code to resolve conflicts
 * if necessary.
 *
 * This replaces the previous approach where merge instructions were embedded
 * in the work prompt. The supervisor handles merge deterministically:
 *   1. Attempt git merge
 *   2. If conflicts, run Claude Code with a merge-only prompt
 *   3. Tag HEAD after merge (done by caller)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { MergeConflict, AgentResponse } from '../types';
import { log, logError, logWarn } from './log';
import { runGit, type GitResult } from '../utils/git';
import { elevatedMerge, elevatedMergeAbort, elevatedMergeCommit } from './elevated-git';
import {
  hasUpstreamChanges,
  readWorktreeMergeState,
  describeMergeState,
  isMidMerge,
} from '../git/operations';
import { safeArgvPrompt } from '../agent/argv-safety';
import { ClaudeCodeActivityStream } from '../agent/activity-stream';
import { extractModelId } from '../agent/claude-code';
import { execWithWatchdog } from './watchdog';
import mergeConflictResolutionTemplate from '../prompts/merge-conflict-resolution.md' with { type: 'text' };
import mergeConflictResolutionResumeTemplate from '../prompts/merge-conflict-resolution-resume.md' with { type: 'text' };
import remoteBranchMergeTemplate from '../prompts/remote-branch-merge.md' with { type: 'text' };
import remoteBranchMergeResumeTemplate from '../prompts/remote-branch-merge-resume.md' with { type: 'text' };

/** Maximum retries for Claude Code merge resolution failures */
const MERGE_MAX_RETRIES = 2;

/**
 * Build the CLI arguments for Claude Code merge conflict resolution.
 * Exported for testing — callers should use runSyncWithUpstream instead.
 *
 * Streams like the work phase (`stream-json --verbose`) so merge turns get the
 * same two guards: a no-progress guard while the agent resolves conflicts, and
 * a wind-down guard that can only arm once the agent's final result is in hand.
 * A merge turn is an ordinary agent turn — it edits files, runs tests, and
 * commits — so the single-blob format left it with no activity signal at all.
 *
 * @param prompt The merge prompt to use
 * @param modelId Optional model override
 * @param agentSessionId Optional session ID for --resume
 * @param useResume Whether to use --resume mode
 */
export function buildMergeClaudeArgs(
  prompt: string,
  modelId?: string,
  agentSessionId?: string,
  useResume: boolean = false,
): string[] {
  const args = [
    'claude', '-p', safeArgvPrompt(prompt, 'merge prompt'),
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (useResume && agentSessionId) {
    args.push('--resume', agentSessionId);
  }

  if (modelId) {
    args.push('--model', modelId);
  }

  return args;
}

/**
 * Guard timeouts for a merge turn, threaded from the supervisor command so
 * merge conflict resolution is bounded by exactly the same config the work
 * phase uses (`[agent] watchdog_output_timeout_ms` / `wind_down_timeout_ms`).
 *
 * Omitted (the default in tests and older callers) means unguarded, which is
 * how merge turns behaved before: `timeout: 0` and no watchdog at all.
 */
export interface MergeGuardOptions {
  /** Kill after this long without forward progress. 0/omitted disables. */
  noProgressTimeoutMs?: number;
  /** Kill this long after the final result lands. 0/omitted disables. */
  windDownTimeoutMs?: number;
}

interface MergeAgentRun {
  /** Bounded stdout tail — diagnostics only. Use `resultLine` for the response. */
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The agent's final result event, verbatim, if it emitted one. */
  resultLine?: string;
  sessionId?: string;
  /** True when the no-progress guard fired — the agent was genuinely stuck. */
  hung: boolean;
}

/**
 * Run one merge-resolution agent process under the two guards.
 *
 * A wind-down kill is deliberately NOT reported as a failure: the agent's
 * result was already captured, and the caller independently verifies the merge
 * landed (no unmerged files, no MERGE_HEAD, HEAD advanced). Only a no-progress
 * kill or a real non-zero exit is a failure.
 */
async function runMergeAgent(
  claudeArgs: string[],
  worktreePath: string,
  logPrefix: string,
  guards?: MergeGuardOptions,
): Promise<MergeAgentRun> {
  const activityStream = new ClaudeCodeActivityStream();
  const result = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    // 0 = unguarded, which is how merge turns ran before guards were threaded.
    timeoutMs: guards?.noProgressTimeoutMs ?? 0,
    activityStream,
    windDownTimeoutMs: guards?.windDownTimeoutMs ?? 0,
  });

  if (result.killedDuringWindDown) {
    log(
      `${logPrefix} Agent did not exit within ${guards?.windDownTimeoutMs}ms of its final result; ` +
      `killed during wind-down. Its resolution was captured — continuing with merge verification.`,
    );
    // The summary is in hand and the worktree state is what actually decides
    // whether the merge succeeded, so do not let the kill's exit code fail it.
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      resultLine: result.resultLine,
      sessionId: result.sessionId,
      hung: false,
    };
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    resultLine: result.resultLine,
    sessionId: result.sessionId,
    hung: result.killedByWatchdog,
  };
}

/**
 * Result of the sync-with-upstream phase.
 * `merged: false` means there was nothing to merge (HEAD already contains
 * the target). Callers MUST distinguish this from a real merge when
 * reporting to the user — conflating the two caused the silent no-op
 * sync regression (fix-sync-no-merge).
 */
export interface SyncWithUpstreamResult {
  merged: boolean;
  preMergeSha: string;
  postMergeSha: string;
  /** SHA of the commit that was merged (or checked for reachability). */
  targetSha: string;
  conflicts: MergeConflict[];
  /**
   * The agent's conflict-resolution response, captured from `claude -p` when
   * the merge had conflicts the agent had to resolve. Absent for a clean merge
   * (no agent was invoked) and for a no-op. Carries the agent's own result
   * text, session id, and token usage so the reconciler can record it as a
   * discrete agent turn (the sync's conflict-resolution reply).
   */
  resolution?: AgentResponse;
}

/**
 * Run the sync-with-upstream phase (merge upstream and resolve conflicts).
 * @param worktreePath Working directory (the task's worktree)
 * @param parentBranch Branch to merge from (used for the merge commit message and logs)
 * @param modelId Optional model override
 * @param agentSessionId Optional existing agent session ID — when provided, conflict
 *   resolution uses `claude --resume` so the agent has full context from prior work.
 *   Falls back to standalone `claude -p` if resume fails or is not provided.
 * @param upstreamSha Optional SHA of the upstream ref resolved on the host before
 *   the supervisor was launched. When provided, the merge target is this SHA —
 *   not the ref — which avoids host/container ref-resolution discrepancies.
 * @returns Structured result describing whether a merge actually happened.
 * @throws If merge fails and cannot be resolved
 */
export async function runSyncWithUpstream(
  worktreePath: string,
  parentBranch: string,
  modelId?: string,
  agentSessionId?: string,
  upstreamSha?: string,
  guards?: MergeGuardOptions,
): Promise<SyncWithUpstreamResult> {
  const target = upstreamSha ?? parentBranch;
  const targetLabel = upstreamSha
    ? `${parentBranch} @ ${upstreamSha.substring(0, 8)}`
    : parentBranch;
  log(`[merge] Merging ${targetLabel} into current branch...`);

  const preMergeSha = await getHeadSha(worktreePath);
  log(`[merge] Pre-merge HEAD: ${preMergeSha.substring(0, 8)}`);

  // Resolve the target to a concrete SHA so the response can report it honestly.
  // --verify ensures an unknown object fails hard instead of echoing the input.
  const resolvedTargetResult = await runGit(
    ['rev-parse', '--verify', `${target}^{commit}`],
    { cwd: worktreePath },
  );
  if (resolvedTargetResult.exitCode !== 0) {
    throw new Error(
      `Failed to resolve merge target ${target} in ${worktreePath}: ${resolvedTargetResult.stderr || 'unknown error'}`,
    );
  }
  const resolvedTargetSha = resolvedTargetResult.stdout.trim();

  // Check if the target has commits not reachable from HEAD. The shared
  // hasUpstreamChanges surfaces git errors (per CLAUDE.md "never swallow
  // errors") instead of quietly returning false on rev-list failure.
  const hasChanges = await hasUpstreamChanges(resolvedTargetSha, worktreePath);
  if (!hasChanges) {
    log(`[merge] No upstream changes to merge: HEAD (${preMergeSha.substring(0, 8)}) already contains ${resolvedTargetSha.substring(0, 8)}.`);
    return {
      merged: false,
      preMergeSha,
      postMergeSha: preMergeSha,
      targetSha: resolvedTargetSha,
      conflicts: [],
    };
  }

  // Attempt a clean merge first. The merge runs host-side (see elevated-git):
  // the container's git common dir is read-only, so no ref can move from in here.
  const mergeCommitMessage = `Merge ${parentBranch}`;
  const mergeResult = await elevatedMerge(worktreePath, target, mergeCommitMessage);

  if (mergeResult.exitCode === 0) {
    const postMergeSha = await getHeadSha(worktreePath);
    log(`[merge] Clean merge succeeded. Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
    return {
      merged: true,
      preMergeSha,
      postMergeSha,
      targetSha: resolvedTargetSha,
      conflicts: [],
    };
  }

  // Merge has conflicts. The conflicted merge is LEFT IN PLACE for the agent to
  // resolve: it cannot start the merge itself any more (moving HEAD needs the
  // read-only common dir), so aborting here would leave it with nothing to
  // resolve. It edits the conflicted files and concludes the merge with
  // lazy_commit, which runs host-side.
  log('[merge] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = await captureConflicts(worktreePath, parentBranch);

  // INVARIANT (fix-sync-silent-conflict): from here on the worktree is
  // half-merged, so EVERY exit from this function — including a throw from the
  // agent runner, from an elevated git call the daemon rejected, or from any
  // future code added below — must leave the worktree settled. That guarantee
  // lives in exactly one place rather than being re-derived at each throw site.
  try {
    return await resolveConflictsWithAgent();
  } catch (err) {
    throw await withSettledWorktree(worktreePath, err);
  }

  // Run Claude Code with a scoped merge-only prompt (with retries)
  async function resolveConflictsWithAgent(): Promise<SyncWithUpstreamResult> {
    // When resuming an existing session, use a shorter prompt that leverages prior context
    const standalonePrompt = mergeConflictResolutionTemplate.replace(/\{\{parentBranch\}\}/g, parentBranch);
    const resumePrompt = mergeConflictResolutionResumeTemplate.replace(/\{\{parentBranch\}\}/g, parentBranch);

    function buildClaudeArgs(shouldResume: boolean): string[] {
      const prompt = shouldResume ? resumePrompt : standalonePrompt;
      return buildMergeClaudeArgs(prompt, modelId, agentSessionId, shouldResume);
    }

    // Track whether we should try resuming. Start with resume if session exists.
    let useResume = !!agentSessionId;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MERGE_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log(`[merge] Retrying Claude Code for conflict resolution (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})...`);
      } else {
        log('[merge] Running Claude Code for conflict resolution...');
      }

      // INVARIANT: every resolution attempt is handed a worktree with the
      // conflicted merge actually in progress — the agent can only RESOLVE a
      // merge, never start one (moving HEAD needs the read-only common dir).
      // The condition is the worktree's state, NOT the attempt number: the
      // resume→standalone fallback below rewinds the counter, and when that
      // was tied to `attempt > 0` the fallback agent was handed a worktree
      // with nothing to merge and the sync failed with the baffling
      // "HEAD did not advance" (fix-sync-silent-conflict).
      if (!await hasMergeInProgress(worktreePath)) {
        const restarted = await restartConflictedMerge(worktreePath, target, mergeCommitMessage);
        if (restarted.exitCode === 0) {
          const postMergeSha = await getHeadSha(worktreePath);
          log(`[merge] Re-attempted merge applied cleanly. Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
          return { merged: true, preMergeSha, postMergeSha, targetSha: resolvedTargetSha, conflicts };
        }
        if (!await hasMergeInProgress(worktreePath)) {
          // Neither clean nor conflicted: the merge could not be re-created at
          // all (a rejected elevated call, a wedged index). Retrying would just
          // hand the agent an empty worktree again.
          throw new Error(
            `Could not re-create the conflicted merge of ${targetLabel} for conflict resolution: ` +
            `${restarted.stderr.trim() || `git merge exited ${restarted.exitCode}`}`,
          );
        }
      }

      if (useResume) {
        log(`[merge] Using --resume with existing session ${agentSessionId!.substring(0, 8)}...`);
      }

      const claudeArgs = buildClaudeArgs(useResume);
      const { stderr, exitCode, resultLine, sessionId, hung } = await runMergeAgent(
        claudeArgs,
        worktreePath,
        '[merge]',
        guards,
      );

      if (hung) {
        // No forward progress for the configured window. Retrying a wedged agent
        // just wedges again, so fail out rather than burning the retry budget.
        // (The worktree is settled by the caller's catch — see the INVARIANT above.)
        throw new Error(
          `Merge-and-fix agent made no forward progress for ${guards?.noProgressTimeoutMs}ms and was killed`,
        );
      }

      if (exitCode !== 0) {
        logError(`[merge] Claude Code failed with exit code ${exitCode} (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})`);
        logError(`[merge] stderr: ${stderr.slice(-500)}`);
        await abortMergeIfInProgress(worktreePath);

        // If we were using --resume and it failed, fall back to standalone mode
        // (session may be expired or not found) and don't count this as a retry.
        // The next iteration re-creates the conflicted merge, because that is
        // keyed on worktree state rather than on this rewound counter.
        if (useResume) {
          log('[merge] Resume failed — falling back to standalone Claude Code...');
          useResume = false;
          // Rewind attempt counter so this doesn't count against retries
          attempt--;
          continue;
        }

        lastError = new Error(`Merge-and-fix Claude Code exited with code ${exitCode}`);
        continue;
      }

      // Verify the merge was actually completed:
      // 1. No unmerged files remain
      const statusResult = await runGit(
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: worktreePath },
      );

      const unmergedFiles = statusResult.stdout;
      if (unmergedFiles) {
        await abortMergeIfInProgress(worktreePath);
        lastError = new Error(`Merge-and-fix incomplete. Unmerged files remain:\n${unmergedFiles}`);
        continue;
      }

      // 2. Conflicts are all resolved but the merge was never committed.
      //    Conclude it host-side instead of throwing the resolution away: the
      //    agent cannot create a merge commit from inside the container, and
      //    aborting here discards a COMPLETE resolution and asks for it again
      //    from scratch — which is how a 61-minute hub merge was lost and then
      //    silently rescued by a re-run (fix-sync-silent-conflict). The daemon
      //    re-checks both conditions before it will commit anything.
      if (await hasMergeInProgress(worktreePath)) {
        log('[merge] Conflicts resolved but merge left uncommitted — committing it host-side.');
        const committed = await elevatedMergeCommit(worktreePath);
        if (committed.exitCode !== 0) {
          await abortMergeIfInProgress(worktreePath);
          lastError = new Error(
            'Merge-and-fix incomplete: conflicts were resolved but the merge commit could not be ' +
            `created: ${committed.stderr.trim() || `git commit exited ${committed.exitCode}`}`,
          );
          continue;
        }
      }

      // 3. HEAD must have advanced (a merge commit was actually created)
      const postMergeSha = await getHeadSha(worktreePath);
      if (postMergeSha === preMergeSha) {
        lastError = new Error('Merge-and-fix incomplete: HEAD did not advance. Claude may have aborted the merge without committing.');
        continue;
      }

      log(`[merge] Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
      log('[merge] Merge-and-fix completed successfully.');

      // Capture the agent's conflict-resolution response so the reconciler can
      // record it as a discrete agent turn (its own text, session, and usage).
      // The result event is byte-identical to the old single-blob output, so it
      // parses the same way. Best-effort: if it is missing or unparseable, fall
      // back to a placeholder so a conflict merge always yields an agent turn
      // rather than silently dropping it. Deliberately NOT falling back to raw
      // stdout — under stream-json that is an NDJSON transcript, not a summary.
      let resolution: AgentResponse;
      try {
        if (!resultLine) throw new Error('agent emitted no result event');
        const parsed = JSON.parse(resultLine) as Record<string, unknown>;
        const reportedModelId = extractModelId(parsed);
        resolution = {
          ...(parsed as unknown as AgentResponse),
          ...(reportedModelId ? { model_id: reportedModelId } : {}),
        };
      } catch (err) {
        logWarn(
          `[merge] Could not read the agent's resolution summary ` +
          `(${err instanceof Error ? err.message : String(err)}); recording a placeholder turn.`,
        );
        resolution = {
          result: 'Resolved merge conflicts.',
          session_id: sessionId ?? agentSessionId ?? '',
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }

      return {
        merged: true,
        preMergeSha,
        postMergeSha,
        targetSha: resolvedTargetSha,
        conflicts,
        resolution,
      };
    }

    // All retries exhausted (the caller's catch settles the worktree).
    throw lastError ?? new Error('Merge-and-fix failed after all retries');
  }
}

/**
 * Run the sync-with-remote phase (merge remote branch and resolve conflicts).
 * Merges the already-fetched origin/<branch> ref into the current branch.
 * The host has already run `git fetch origin <branch>` before writing the command.
 *
 * @param worktreePath Working directory (the task's worktree)
 * @param remoteBranch Remote tracking ref to merge (e.g., "origin/lazy/abc12345")
 * @param modelId Optional model override
 * @param agentSessionId Optional existing agent session ID — when provided, conflict
 *   resolution uses `claude --resume` so the agent has full context from prior work.
 *   Falls back to standalone `claude -p` if resume fails or is not provided.
 * @returns Array of merge conflicts captured before resolution (empty if clean merge)
 * @throws If merge fails and cannot be resolved
 */
export async function runSyncWithRemote(
  worktreePath: string,
  remoteBranch: string,
  modelId?: string,
  agentSessionId?: string,
  guards?: MergeGuardOptions,
): Promise<MergeConflict[]> {
  log(`[remote-sync] Merging ${remoteBranch} into current branch...`);

  // Check if remote branch has changes to merge
  const hasChanges = await checkRemoteChanges(remoteBranch, worktreePath);
  if (!hasChanges) {
    log('[remote-sync] No remote changes to merge.');
    return [];
  }

  // Attempt a clean merge first (host-side — see elevated-git).
  const mergeCommitMessage = `Merge ${remoteBranch}`;
  const mergeResult = await elevatedMerge(worktreePath, remoteBranch, mergeCommitMessage);

  if (mergeResult.exitCode === 0) {
    log('[remote-sync] Clean merge succeeded.');
    return [];
  }

  // Conflicted merge is left in place for the agent to resolve and conclude
  // with lazy_commit — see the equivalent comment in runSyncWithUpstream.
  log('[remote-sync] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = await captureConflicts(worktreePath, remoteBranch);

  // INVARIANT (fix-sync-silent-conflict): see runSyncWithUpstream — from here
  // the worktree is half-merged, and no exit from this function may leave it
  // that way.
  try {
    return await resolveRemoteConflictsWithAgent();
  } catch (err) {
    throw await withSettledWorktree(worktreePath, err);
  }

  // Run Claude Code with a scoped merge-only prompt
  async function resolveRemoteConflictsWithAgent(): Promise<MergeConflict[]> {
    // When resuming an existing session, use a shorter prompt that leverages prior context
    const standalonePrompt = remoteBranchMergeTemplate.replace(/\{\{remoteBranch\}\}/g, remoteBranch);
    const resumePrompt = remoteBranchMergeResumeTemplate.replace(/\{\{remoteBranch\}\}/g, remoteBranch);

    // Record HEAD before Claude runs so we can verify it advanced
    const preMergeSha = await getHeadSha(worktreePath);
    log(`[remote-sync] Pre-merge HEAD: ${preMergeSha.substring(0, 8)}`);

    let useResume = !!agentSessionId;

    if (useResume) {
      log(`[remote-sync] Using --resume with existing session ${agentSessionId!.substring(0, 8)}...`);
    }
    log('[remote-sync] Running Claude Code for conflict resolution...');

    const prompt = useResume ? resumePrompt : standalonePrompt;
    let claudeArgs = buildMergeClaudeArgs(prompt, modelId, agentSessionId, useResume);

    const { stderr, exitCode, hung } = await runMergeAgent(
      claudeArgs,
      worktreePath,
      '[remote-sync]',
      guards,
    );

    if (hung) {
      throw new Error(
        `Sync-with-remote agent made no forward progress for ${guards?.noProgressTimeoutMs}ms and was killed`,
      );
    }

    if (exitCode !== 0) {
      logError(`[remote-sync] Claude Code failed with exit code ${exitCode}`);
      logError(`[remote-sync] stderr: ${stderr.slice(-500)}`);
      await abortMergeIfInProgress(worktreePath);

      // If we were using --resume and it failed, fall back to standalone mode
      if (useResume) {
        log('[remote-sync] Resume failed — falling back to standalone Claude Code...');
        useResume = false;
        const fallbackPrompt = standalonePrompt;
        claudeArgs = buildMergeClaudeArgs(fallbackPrompt, modelId, undefined, false);

        // Re-create the conflicted merge the fallback attempt is meant to resolve
        // (the failure path above aborted it). The agent can only RESOLVE a
        // merge, never start one — handing it a worktree with no merge in
        // progress is the defect this whole file was audited for.
        const restarted = await restartConflictedMerge(worktreePath, remoteBranch, mergeCommitMessage);
        if (restarted.exitCode === 0) {
          log('[remote-sync] Re-attempted merge applied cleanly.');
          return conflicts;
        }
        if (!await hasMergeInProgress(worktreePath)) {
          throw new Error(
            `Could not re-create the conflicted merge of ${remoteBranch} for conflict resolution: ` +
            `${restarted.stderr.trim() || `git merge exited ${restarted.exitCode}`}`,
          );
        }

        const {
          stderr: fallbackStderr,
          exitCode: fallbackExitCode,
          hung: fallbackHung,
        } = await runMergeAgent(claudeArgs, worktreePath, '[remote-sync]', guards);

        if (fallbackHung) {
          throw new Error(
            `Sync-with-remote agent made no forward progress for ${guards?.noProgressTimeoutMs}ms and was killed`,
          );
        }

        if (fallbackExitCode !== 0) {
          logError(`[remote-sync] Fallback Claude Code failed with exit code ${fallbackExitCode}`);
          logError(`[remote-sync] stderr: ${fallbackStderr.slice(-500)}`);
          throw new Error(`Sync-with-remote Claude Code exited with code ${fallbackExitCode}`);
        }
      } else {
        throw new Error(`Sync-with-remote Claude Code exited with code ${exitCode}`);
      }
    }

    // Verify the merge was actually completed:
    // 1. No unmerged files remain
    const statusResult = await runGit(
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd: worktreePath },
    );

    const unmergedFiles = statusResult.stdout;
    if (unmergedFiles) {
      throw new Error(`Sync-with-remote incomplete. Unmerged files remain:\n${unmergedFiles}`);
    }

    // 2. Conflicts resolved but merge left uncommitted — conclude it host-side
    //    rather than discarding a complete resolution (see runSyncWithUpstream).
    if (await hasMergeInProgress(worktreePath)) {
      log('[remote-sync] Conflicts resolved but merge left uncommitted — committing it host-side.');
      const committed = await elevatedMergeCommit(worktreePath);
      if (committed.exitCode !== 0) {
        throw new Error(
          'Sync-with-remote incomplete: conflicts were resolved but the merge commit could not be ' +
          `created: ${committed.stderr.trim() || `git commit exited ${committed.exitCode}`}`,
        );
      }
    }

    // 3. HEAD must have advanced (a merge commit was actually created)
    const postMergeSha = await getHeadSha(worktreePath);
    if (postMergeSha === preMergeSha) {
      throw new Error('Sync-with-remote incomplete: HEAD did not advance. Claude may have aborted the merge without committing.');
    }

    log(`[remote-sync] Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
    log('[remote-sync] Sync-with-remote completed successfully.');
    return conflicts;
  }
}

/**
 * Capture conflicted files from the worktree while a merge is in progress.
 * Must be called AFTER a failed git merge and BEFORE git merge --abort.
 * Reads files listed by `git diff --name-only --diff-filter=U` which contain
 * conflict markers (<<<<<<< / ======= / >>>>>>>).
 */
async function captureConflicts(worktreePath: string, mergeSource: string): Promise<MergeConflict[]> {
  const result = await runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  const filePaths = result.stdout.split('\n').filter(Boolean);
  const conflicts: MergeConflict[] = [];

  for (const filePath of filePaths) {
    try {
      const fullPath = join(worktreePath, filePath);
      const content = readFileSync(fullPath, 'utf-8');
      conflicts.push({ path: filePath, content, merge_source: mergeSource });
    } catch (err) {
      log(`[merge] Could not read conflicted file ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  log(`[merge] Captured ${conflicts.length} conflicted file(s)`);
  return conflicts;
}

async function checkRemoteChanges(remoteBranch: string, cwd: string): Promise<boolean> {
  const result = await runGit(
    ['rev-list', '--count', `HEAD..${remoteBranch}`],
    { cwd },
  );

  if (result.exitCode !== 0) return false;

  const count = parseInt(result.stdout, 10);
  if (count > 0) {
    log(`[remote-sync] ${remoteBranch} has ${count} new commit(s) to merge`);
  }
  return count > 0;
}

async function getHeadSha(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    // 'unknown' is a reporting placeholder — callers use this SHA for log lines
    // and result payloads, and a merge that then fails for the same underlying
    // reason surfaces its own error. But it must not be SILENT: when git is
    // broken for the whole worktree (a dubious-ownership refusal, say) this call
    // is the first casualty, and staying quiet here is why such a failure used
    // to appear as a confusing error several git commands later.
    logWarn(`[merge] Could not read HEAD in ${cwd}: ${result.stderr || 'git rev-parse HEAD failed'}`);
    return 'unknown';
  }
  return result.stdout;
}

/**
 * Check if a merge is in progress (MERGE_HEAD exists).
 */
export async function hasMergeInProgress(cwd: string): Promise<boolean> {
  const result = await runGit(
    ['rev-parse', '--verify', 'MERGE_HEAD'],
    { cwd },
  );
  return result.exitCode === 0;
}

/**
 * Check if the worktree has unmerged files (conflict markers).
 */
export async function hasUnmergedFiles(cwd: string): Promise<boolean> {
  const result = await runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd },
  );
  return result.exitCode === 0 && result.stdout.length > 0;
}

/**
 * Abort an in-progress merge if one exists. Returns true if a merge was aborted.
 */
export async function abortMergeIfInProgress(cwd: string): Promise<boolean> {
  if (!await hasMergeInProgress(cwd)) {
    return false;
  }
  const result = await elevatedMergeAbort(cwd);
  if (result.exitCode === 0) {
    log('[merge] Aborted in-progress merge.');
    return true;
  }
  logError(`[merge] Failed to abort merge: ${result.stderr}`);
  return false;
}

/**
 * Bring a worktree back to a settled state after a failed merge attempt, and
 * describe — always — what was found and what was done about it.
 *
 * INVARIANT (fix-sync-silent-conflict): a sync must never return, successfully
 * or not, with a half-applied merge in the worktree. Every failure path in the
 * merge phase goes through here, and the description it returns is appended to
 * the error the caller raises, so the failure the human sees names the actual
 * state of their worktree instead of leaving them to discover UU files later.
 *
 * A failed abort is NOT swallowed: it comes back as `settled: false` with an
 * actionable message, because a worktree we could not settle is precisely the
 * situation that has to be shouted about.
 */
export async function settleConflictedWorktree(
  cwd: string,
): Promise<{ settled: boolean; detail: string }> {
  const before = await readWorktreeMergeState(cwd);
  if (!isMidMerge(before)) {
    return { settled: true, detail: 'Worktree is settled (no merge in progress).' };
  }

  let abortStderr = '';
  if (before.mergeInProgress) {
    const aborted = await elevatedMergeAbort(cwd);
    if (aborted.exitCode !== 0) {
      abortStderr = aborted.stderr.trim();
      logError(`[merge] Failed to abort merge: ${abortStderr}`);
    }
  }

  const after = await readWorktreeMergeState(cwd);
  if (!isMidMerge(after)) {
    log('[merge] Aborted in-progress merge; worktree is settled.');
    return {
      settled: true,
      detail: `Aborted the in-progress merge (${describeMergeState(before)}); the worktree is back to its pre-merge state.`,
    };
  }

  return {
    settled: false,
    detail:
      `The worktree is STILL mid-merge and could not be settled automatically ` +
      `(${describeMergeState(after)})${abortStderr ? `; git merge --abort said: ${abortStderr}` : ''}. ` +
      `Run \`git merge --abort\` in ${cwd} — nothing else will touch it.`,
  };
}

/**
 * Wrap an error raised inside the merge phase with the settled state of the
 * worktree, so no merge failure can reach a caller without saying what happened
 * to the files on disk.
 */
async function withSettledWorktree(cwd: string, err: unknown): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);
  let detail: string;
  try {
    detail = (await settleConflictedWorktree(cwd)).detail;
  } catch (settleErr) {
    detail =
      `Could not even determine the worktree's merge state afterwards ` +
      `(${settleErr instanceof Error ? settleErr.message : String(settleErr)}). ` +
      `Inspect ${cwd} by hand.`;
  }
  return new Error(`${message}\n${detail}`);
}

/**
 * Clear any in-progress merge and start it again, host-side.
 *
 * Needed on every conflict-resolution retry: the agent can only RESOLVE an
 * in-progress merge (it has no way to move HEAD from inside the container), so
 * each attempt must be handed a freshly conflicted worktree.
 */
async function restartConflictedMerge(
  worktreePath: string,
  target: string,
  message: string,
): Promise<GitResult> {
  await abortMergeIfInProgress(worktreePath);
  return elevatedMerge(worktreePath, target, message);
}

