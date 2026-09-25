/**
 * Merge-and-fix phase.
 *
 * Runs as a supervised phase before the main work phase. Merges the parent
 * branch into the current branch, using the TASK'S OWN AGENT to resolve
 * conflicts if necessary.
 *
 * This replaces the previous approach where merge instructions were embedded
 * in the work prompt. The supervisor handles merge deterministically:
 *   1. Attempt git merge
 *   2. If conflicts, run the task's agent with a merge-only prompt
 *   3. Tag HEAD after merge (done by caller)
 *
 * INVARIANT: the merge turn launches through the SAME `Agent` abstraction as
 * the work phase (`getAgent(harness).buildExecArgs`), never a hardcoded
 * binary. This file used to spell `claude` itself while still appending the
 * TASK's `--model` and `--resume <agent_session_id>` — so a Cursor task ran
 * `claude --model auto --resume <cursor-session-id>`, which exits 1 instantly.
 * Every retry did the same, the agent never saw the conflicts, and the
 * worktree was left wedged mid-merge. Model and session are only ever valid
 * for the agent that produced them; binding all three to one harness makes
 * that mismatch unrepresentable rather than merely unlikely.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { MergeConflict, AgentResponse } from '../types';
import { log, logError, logWarn } from './log';
import { runGit, type GitResult } from '../utils/git';
import {
  elevatedMerge,
  elevatedMergeAbort,
  elevatedMergeCommit,
  elevatedResetHardHead,
} from './elevated-git';
import {
  hasUpstreamChanges,
  readWorktreeMergeState,
  describeMergeState,
  isMidMerge,
} from '../git/operations';
import { getAgent, agentDisplayName } from '../agent/registry';
import type { Agent } from '../agent/interface';
import { saveWorktreePatch } from './recovery-patch';
import { execWithWatchdog } from './watchdog';
import mergeConflictResolutionTemplate from '../prompts/merge-conflict-resolution.md' with { type: 'text' };
import mergeConflictResolutionResumeTemplate from '../prompts/merge-conflict-resolution-resume.md' with { type: 'text' };
import remoteBranchMergeTemplate from '../prompts/remote-branch-merge.md' with { type: 'text' };
import remoteBranchMergeResumeTemplate from '../prompts/remote-branch-merge-resume.md' with { type: 'text' };

/** Maximum retries for merge resolution failures */
const MERGE_MAX_RETRIES = 2;

/** The harness (agent binary) a merge turn runs when the command did not name one. */
export const DEFAULT_MERGE_HARNESS = 'claude-code';

/**
 * Build the CLI arguments for a merge-conflict-resolution turn.
 * Exported for testing — callers should use runSyncWithUpstream instead.
 *
 * Delegates to the agent's own `buildExecArgs`, so the merge turn is launched
 * exactly the way the work phase launches that agent — same binary, same
 * output format, same flag spellings. For Claude Code this is byte-identical
 * to the argv this function used to hand-roll; for every other agent it is the
 * difference between running and exiting 1 (see the file header).
 *
 * @param agent The task's agent — the one whose model and session these are
 * @param prompt The merge prompt to use
 * @param modelId Optional model override (valid only for THIS agent)
 * @param agentSessionId Optional session ID to resume (issued by THIS agent)
 * @param useResume Whether to resume the existing session
 * @param effort Optional reasoning effort — the task's, threaded from the command
 */
export function buildMergeAgentArgs(
  agent: Agent,
  prompt: string,
  modelId?: string,
  agentSessionId?: string,
  useResume: boolean = false,
  effort?: string,
): string[] {
  return agent.buildExecArgs({
    prompt,
    modelId,
    effort,
    // A session id is only meaningful to the agent that issued it, and the
    // caller already scoped both to one agent — but resume is opt-in per
    // attempt (the retry loop falls back to standalone), so honour the flag.
    ...(useResume && agentSessionId ? { sessionId: agentSessionId } : {}),
    dangerouslySkipPermissions: true,
  });
}

/**
 * Per-turn options for a merge-resolution turn.
 *
 * The guard timeouts are threaded from the supervisor command so merge
 * conflict resolution is bounded by exactly the same config the work phase
 * uses (`[agent] watchdog_output_timeout_ms` / `wind_down_timeout_ms`).
 * Omitted (the default in tests and older callers) means unguarded, which is
 * how merge turns behaved before: `timeout: 0` and no watchdog at all.
 *
 * This is a trailing options bag, and `harness` was added to it rather than as
 * a new positional parameter ON PURPOSE: every existing call site passes
 * `modelId`/`agentSessionId`/`upstreamSha` positionally, several of them as
 * bare `undefined`, so a new positional in the middle would silently shift
 * arguments at call sites the compiler cannot always catch.
 */
export interface MergeTurnOptions {
  /** Kill after this long without forward progress. 0/omitted disables. */
  noProgressTimeoutMs?: number;
  /** Kill this long after the final result lands. 0/omitted disables. */
  windDownTimeoutMs?: number;
  /**
   * Reasoning effort for the conflict-resolution turn — the TASK's effort,
   * threaded from the sync command alongside `modelId`. A merge turn follows
   * the task's previous turn like every other turn type (INVARIANT
   * turn-launch-continuity, src/daemon/launch-identity.ts); omitted means the
   * command carried none, which is only true for a supervisor older than the
   * field, and leaves the agent binary's own default in force.
   */
  effort?: string;
  /**
   * The task's HARNESS — which agent binary to run — not its profile name. The
   * merge turn runs THIS binary, because `modelId` and `agentSessionId` came
   * from it and mean nothing to another one. Defaults to claude-code for
   * callers that predate multi-agent tasks.
   *
   * A harness rather than a profile because every use below is a registry
   * lookup (`getAgent`, `agentDisplayName`), and the registry is keyed by
   * harness; the supervisor resolves it from the command. See
   * `commandHarness` in src/supervisor/index.ts.
   */
  harness?: string;
}

interface MergeAgentRun {
  /** Bounded stdout tail — diagnostics only. Use `resultLine` for the response. */
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The agent's final result event, verbatim, if it emitted one. */
  resultLine?: string;
  sessionId?: string;
  /**
   * The concrete model the agent reported at session start, when it did.
   * Cursor's result line has no model, so this is its only report.
   */
  initModel?: string;
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
  agent: Agent,
  agentArgs: string[],
  worktreePath: string,
  logPrefix: string,
  guards?: MergeTurnOptions,
): Promise<MergeAgentRun> {
  // The agent's own stream, not Claude's: an agent that emits a single blob at
  // exit (cursor) has no incremental events, and handing the watchdog a parser
  // for events that never arrive would make every one of its turns look silent.
  const activityStream = agent.activityStream();
  const result = await execWithWatchdog(agentArgs, {
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
      initModel: result.sessionStartEvent?.model,
      hung: false,
    };
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    resultLine: result.resultLine,
    sessionId: result.sessionId,
    initModel: result.sessionStartEvent?.model,
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
 * @param modelId Optional model override — must be a model of `opts.harness`
 * @param agentSessionId Optional existing agent session ID — when provided, conflict
 *   resolution resumes that session so the agent has full context from prior work.
 *   Falls back to a standalone turn if resume fails or is not provided. The id
 *   must have been issued by `opts.harness`.
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
  opts?: MergeTurnOptions,
): Promise<SyncWithUpstreamResult> {
  const guards = opts;
  const harness = opts?.harness ?? DEFAULT_MERGE_HARNESS;
  const agent = getAgent(harness);
  const agentName = agentDisplayName(harness);
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
  log(`[merge] Merge has conflicts. Using ${agentName} to resolve...`);
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

  // Run the task's agent with a scoped merge-only prompt (with retries)
  async function resolveConflictsWithAgent(): Promise<SyncWithUpstreamResult> {
    // When resuming an existing session, use a shorter prompt that leverages prior context
    const standalonePrompt = mergeConflictResolutionTemplate.replace(/\{\{parentBranch\}\}/g, parentBranch);
    const resumePrompt = mergeConflictResolutionResumeTemplate.replace(/\{\{parentBranch\}\}/g, parentBranch);

    function buildAgentArgs(shouldResume: boolean): string[] {
      const prompt = shouldResume ? resumePrompt : standalonePrompt;
      return buildMergeAgentArgs(agent, prompt, modelId, agentSessionId, shouldResume, opts?.effort);
    }

    // Track whether we should try resuming. Start with resume if session exists.
    let useResume = !!agentSessionId;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MERGE_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log(`[merge] Retrying ${agentName} for conflict resolution (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})...`);
      } else {
        log(`[merge] Running ${agentName} for conflict resolution...`);
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

      const agentArgs = buildAgentArgs(useResume);
      const { stdout, stderr, exitCode, resultLine, sessionId, initModel, hung } = await runMergeAgent(
        agent,
        agentArgs,
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
        logError(`[merge] ${agentName} failed with exit code ${exitCode} (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})`);
        logError(`[merge] stderr: ${stderr.slice(-500)}`);
        await abortMergeIfInProgress(worktreePath);

        // If we were resuming and it failed, fall back to standalone mode
        // (session may be expired or not found) and don't count this as a retry.
        // The next iteration re-creates the conflicted merge, because that is
        // keyed on worktree state rather than on this rewound counter.
        if (useResume) {
          log(`[merge] Resume failed — falling back to a standalone ${agentName} turn...`);
          useResume = false;
          // Rewind attempt counter so this doesn't count against retries
          attempt--;
          continue;
        }

        lastError = new Error(`Merge-and-fix ${agentName} exited with code ${exitCode}`);
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
        lastError = new Error(
          `Merge-and-fix incomplete: HEAD did not advance. ${agentName} may have aborted the merge without committing.`,
        );
        continue;
      }

      log(`[merge] Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
      log('[merge] Merge-and-fix completed successfully.');

      // Capture the agent's conflict-resolution response so the reconciler can
      // record it as a discrete agent turn (its own text, session, and usage).
      // Best-effort: if it is missing or unparseable, fall back to a placeholder
      // so a conflict merge always yields an agent turn rather than silently
      // dropping it.
      const resolution = parseResolution({
        agent,
        agentName,
        resultLine,
        stdout,
        worktreePath,
        fallbackSessionId: sessionId ?? agentSessionId,
      initModel,
      });

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
 * @param modelId Optional model override — must be a model of `opts.harness`
 * @param agentSessionId Optional existing agent session ID — when provided, conflict
 *   resolution resumes that session so the agent has full context from prior work.
 *   Falls back to a standalone turn if resume fails or is not provided. The id
 *   must have been issued by `opts.harness`.
 * @returns The same structured result shape as `runSyncWithUpstream` — whether a
 *   merge actually happened, the SHA window it moved HEAD through, the resolved
 *   target commit, the conflicts captured before resolution, and the agent's
 *   conflict-resolution reply when one was needed. `lazy sync` records this step
 *   as its own turn, so it needs the same honest facts the parent step reports.
 * @throws If merge fails and cannot be resolved
 */
export async function runSyncWithRemote(
  worktreePath: string,
  remoteBranch: string,
  modelId?: string,
  agentSessionId?: string,
  opts?: MergeTurnOptions,
): Promise<SyncWithUpstreamResult> {
  const guards = opts;
  const harness = opts?.harness ?? DEFAULT_MERGE_HARNESS;
  const agent = getAgent(harness);
  const agentName = agentDisplayName(harness);
  log(`[remote-sync] Merging ${remoteBranch} into current branch...`);

  const preMergeSha = await getHeadSha(worktreePath);

  // Resolve the target to a concrete SHA so the result can report it honestly
  // (the same reason runSyncWithUpstream does it). --verify fails hard rather
  // than echoing an unknown ref back.
  const resolvedTargetResult = await runGit(
    ['rev-parse', '--verify', `${remoteBranch}^{commit}`],
    { cwd: worktreePath },
  );
  if (resolvedTargetResult.exitCode !== 0) {
    throw new Error(
      `Failed to resolve merge target ${remoteBranch} in ${worktreePath}: ${resolvedTargetResult.stderr || 'unknown error'}`,
    );
  }
  const resolvedTargetSha = resolvedTargetResult.stdout.trim();

  // Check if remote branch has changes to merge
  const hasChanges = await checkRemoteChanges(remoteBranch, worktreePath);
  if (!hasChanges) {
    log('[remote-sync] No remote changes to merge.');
    return {
      merged: false,
      preMergeSha,
      postMergeSha: preMergeSha,
      targetSha: resolvedTargetSha,
      conflicts: [],
    };
  }

  // Attempt a clean merge first (host-side — see elevated-git).
  const mergeCommitMessage = `Merge ${remoteBranch}`;
  const mergeResult = await elevatedMerge(worktreePath, remoteBranch, mergeCommitMessage);

  if (mergeResult.exitCode === 0) {
    const postMergeSha = await getHeadSha(worktreePath);
    log('[remote-sync] Clean merge succeeded.');
    return {
      merged: true,
      preMergeSha,
      postMergeSha,
      targetSha: resolvedTargetSha,
      conflicts: [],
    };
  }

  // Conflicted merge is left in place for the agent to resolve and conclude
  // with lazy_commit — see the equivalent comment in runSyncWithUpstream.
  log(`[remote-sync] Merge has conflicts. Using ${agentName} to resolve...`);
  const conflicts = await captureConflicts(worktreePath, remoteBranch);

  // INVARIANT (fix-sync-silent-conflict): see runSyncWithUpstream — from here
  // the worktree is half-merged, and no exit from this function may leave it
  // that way.
  try {
    return await resolveRemoteConflictsWithAgent();
  } catch (err) {
    throw await withSettledWorktree(worktreePath, err);
  }

  // Run the task's agent with a scoped merge-only prompt
  async function resolveRemoteConflictsWithAgent(): Promise<SyncWithUpstreamResult> {
    // When resuming an existing session, use a shorter prompt that leverages prior context
    const standalonePrompt = remoteBranchMergeTemplate.replace(/\{\{remoteBranch\}\}/g, remoteBranch);
    const resumePrompt = remoteBranchMergeResumeTemplate.replace(/\{\{remoteBranch\}\}/g, remoteBranch);

    log(`[remote-sync] Pre-merge HEAD: ${preMergeSha.substring(0, 8)}`);

    let useResume = !!agentSessionId;

    if (useResume) {
      log(`[remote-sync] Using --resume with existing session ${agentSessionId!.substring(0, 8)}...`);
    }
    log(`[remote-sync] Running ${agentName} for conflict resolution...`);

    const prompt = useResume ? resumePrompt : standalonePrompt;
    let agentArgs = buildMergeAgentArgs(agent, prompt, modelId, agentSessionId, useResume, opts?.effort);

    let { stdout, stderr, exitCode, resultLine, sessionId, initModel, hung } = await runMergeAgent(
      agent,
      agentArgs,
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
      logError(`[remote-sync] ${agentName} failed with exit code ${exitCode}`);
      logError(`[remote-sync] stderr: ${stderr.slice(-500)}`);
      await abortMergeIfInProgress(worktreePath);

      // If we were resuming and it failed, fall back to standalone mode
      if (useResume) {
        log(`[remote-sync] Resume failed — falling back to a standalone ${agentName} turn...`);
        useResume = false;
        const fallbackPrompt = standalonePrompt;
        agentArgs = buildMergeAgentArgs(agent, fallbackPrompt, modelId, undefined, false, opts?.effort);

        // Re-create the conflicted merge the fallback attempt is meant to resolve
        // (the failure path above aborted it). The agent can only RESOLVE a
        // merge, never start one — handing it a worktree with no merge in
        // progress is the defect this whole file was audited for.
        const restarted = await restartConflictedMerge(worktreePath, remoteBranch, mergeCommitMessage);
        if (restarted.exitCode === 0) {
          log('[remote-sync] Re-attempted merge applied cleanly.');
          return {
            merged: true,
            preMergeSha,
            postMergeSha: await getHeadSha(worktreePath),
            targetSha: resolvedTargetSha,
            conflicts,
          };
        }
        if (!await hasMergeInProgress(worktreePath)) {
          throw new Error(
            `Could not re-create the conflicted merge of ${remoteBranch} for conflict resolution: ` +
            `${restarted.stderr.trim() || `git merge exited ${restarted.exitCode}`}`,
          );
        }

        const fallback = await runMergeAgent(agent, agentArgs, worktreePath, '[remote-sync]', guards);

        if (fallback.hung) {
          throw new Error(
            `Sync-with-remote agent made no forward progress for ${guards?.noProgressTimeoutMs}ms and was killed`,
          );
        }

        if (fallback.exitCode !== 0) {
          logError(`[remote-sync] Fallback ${agentName} failed with exit code ${fallback.exitCode}`);
          logError(`[remote-sync] stderr: ${fallback.stderr.slice(-500)}`);
          throw new Error(`Sync-with-remote ${agentName} exited with code ${fallback.exitCode}`);
        }

        // The fallback turn is the invocation that resolved the merge, so its
        // output — not the failed resume's — is what the resolution turn reports.
        ({ stdout, resultLine, sessionId, initModel } = fallback);
      } else {
        throw new Error(`Sync-with-remote ${agentName} exited with code ${exitCode}`);
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
      throw new Error(
        `Sync-with-remote incomplete: HEAD did not advance. ${agentName} may have aborted the merge without committing.`,
      );
    }

    log(`[remote-sync] Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
    log('[remote-sync] Sync-with-remote completed successfully.');

    // Same best-effort capture as the upstream path: the agent's own account of
    // the resolution becomes a discrete agent turn on the task.
    const resolution = parseResolution({
      agent,
      agentName,
      resultLine,
      stdout,
      worktreePath,
      fallbackSessionId: sessionId ?? agentSessionId,
      initModel,
    });

    return {
      merged: true,
      preMergeSha,
      postMergeSha,
      targetSha: resolvedTargetSha,
      conflicts,
      resolution,
    };
  }
}

/**
 * Read the agent's own summary of the resolution it just made.
 *
 * `resultLine` is the isolated final event, which only exists for an agent with
 * an incremental activity stream; an agent that emits one blob at exit (cursor)
 * has none, and for it the complete stdout IS the response. Both go through the
 * agent's own `parseResponse`, which is the only thing that knows its dialect.
 *
 * Never throws: a merge that actually landed must not be reported as a failure
 * because its summary was unreadable, so an unparseable response degrades to a
 * placeholder turn (with a warning) rather than losing the merge.
 */
function parseResolution(args: {
  agent: Agent;
  agentName: string;
  resultLine?: string;
  stdout: string;
  worktreePath: string;
  fallbackSessionId?: string;
  /** The model the stream's session-start event reported (see MergeAgentRun). */
  initModel?: string;
}): AgentResponse {
  const raw = args.resultLine ?? args.stdout;
  try {
    if (!raw.trim()) throw new Error(`${args.agentName} produced no output to parse`);
    const parsed = args.agent.parseResponse(raw, { workingDir: args.worktreePath });
    // The isolated result line is what is parsed here, and Cursor's carries no
    // model: the init line is its only report, as on the work turn.
    return !parsed.model_id && args.initModel ? { ...parsed, model_id: args.initModel } : parsed;
  } catch (err) {
    logWarn(
      `[merge] Could not read the agent's resolution summary ` +
      `(${err instanceof Error ? err.message : String(err)}); recording a placeholder turn.`,
    );
    return {
      result: 'Resolved merge conflicts.',
      session_id: args.fallbackSessionId ?? '',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
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
 *
 * Retries once after refreshing the index, for the same reason
 * `settleConflictedWorktree` does: git refuses to abort while a tracked file is
 * stat-stale ("Entry 'bun.lock' not uptodate"), which a post-turn `bun install`
 * routinely produces. The refresh only re-stats — it never changes file
 * content — so this stays lossless. The destructive last resort deliberately
 * lives ONLY in settle, so a mid-retry abort can never throw work away.
 */
export async function abortMergeIfInProgress(cwd: string): Promise<boolean> {
  if (!await hasMergeInProgress(cwd)) {
    return false;
  }
  let result = await elevatedMergeAbort(cwd);
  if (result.exitCode !== 0) {
    logWarn(`[merge] git merge --abort failed (${result.stderr.trim()}); refreshing the index and retrying.`);
    await runGit(['update-index', '-q', '--refresh'], { cwd });
    result = await elevatedMergeAbort(cwd);
  }
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
 * `git merge --abort` alone does NOT satisfy that invariant, which is what
 * wedged four real syncs: git refuses to abort when a tracked file the merge
 * touches is dirty or merely stat-stale in the index —
 *
 *     error: Entry 'bun.lock' not uptodate. Cannot merge.
 *     fatal: Could not reset index file to revision 'HEAD'.
 *
 * — and a post-turn check that runs `bun install` produces exactly that state.
 * So settling is a LADDER, cheapest and most conservative first:
 *
 *   1. `git merge --abort`.
 *   2. If that failed: `git update-index --refresh` (re-stat the worktree,
 *      which clears a purely stat-stale entry and changes no content at all),
 *      then abort again. Completely lossless. It is often a no-op HERE, because
 *      the state read above (`git diff --diff-filter=U`) already re-stats and
 *      rewrites the index — but only when it can take the index lock and the
 *      read succeeds, and `abortMergeIfInProgress` (which reaches for the same
 *      rung mid-retry) does no such read at all. Cheap belt to that suspenders.
 *   3. If that also failed: save the worktree's diff against HEAD to
 *      `.lazy/recovery/` and then `git reset --hard HEAD`, which clears
 *      MERGE_HEAD and unmerged paths regardless of dirt.
 *
 * Rung 3 is the only one that discards anything, and it never discards
 * anything unrecoverable: the patch is written BEFORE the reset, is named in
 * the returned detail, and `.lazy/recovery/` is gitignored (CLAUDE.md's
 * recovery-file rule). It is the same trade the pre-turn rollback already
 * makes — a worktree nobody can settle is not a safer outcome than a patch
 * file, it is the outcome that stalls the task and needs a human with a
 * terminal.
 *
 * That trade holds only while the save is TRUSTWORTHY, so it may destroy only
 * what it provably saved or provably confirmed empty. `saveWorktreePatch` is
 * three-valued for exactly this reason: "nothing to save" and "the save failed"
 * are indistinguishable from a null return, and resetting on the latter would
 * destroy real work while reporting there was none — plausible precisely here,
 * in the broken worktree states this rung exists for. On a failed save the
 * reset does NOT run and the ladder ends at `settled: false` with the manual
 * commands: a wedge a human can walk into and inspect beats a silent,
 * unrecoverable discard.
 *
 * NOT `git stash`, at any rung: the stash stack is shared across every task's
 * worktree in this repo, so stashing here can drop foreign changes on another
 * task (CLAUDE.md).
 *
 * A ladder that runs out is still NOT swallowed: it comes back as
 * `settled: false` with an actionable message, because a worktree we could not
 * settle is precisely the situation that has to be shouted about.
 */
export async function settleConflictedWorktree(
  cwd: string,
): Promise<{ settled: boolean; detail: string }> {
  const before = await readWorktreeMergeState(cwd);
  if (!isMidMerge(before)) {
    return { settled: true, detail: 'Worktree is settled (no merge in progress).' };
  }

  let abortStderr = '';
  let refreshed = false;
  if (before.mergeInProgress) {
    let aborted = await elevatedMergeAbort(cwd);

    if (aborted.exitCode !== 0) {
      abortStderr = aborted.stderr.trim();
      logWarn(`[merge] git merge --abort failed: ${abortStderr}`);
      // Rung 2. `--refresh` only re-stats tracked files; a file whose content
      // genuinely differs from the index stays dirty, so this can lose
      // nothing. `-q` because a file that is really modified is expected here
      // and is not an error for us. The per-worktree index is writable even
      // under the container's split git mount (src/capture/git-mounts.ts), so
      // this runs locally rather than needing the daemon.
      log('[merge] Refreshing the index and retrying the abort...');
      await runGit(['update-index', '-q', '--refresh'], { cwd });
      refreshed = true;
      aborted = await elevatedMergeAbort(cwd);
      if (aborted.exitCode !== 0) {
        abortStderr = aborted.stderr.trim();
        logError(`[merge] git merge --abort still failed after refreshing the index: ${abortStderr}`);
      }
    }
  }

  let after = await readWorktreeMergeState(cwd);
  if (!isMidMerge(after)) {
    log('[merge] Aborted in-progress merge; worktree is settled.');
    return {
      settled: true,
      detail:
        `Aborted the in-progress merge (${describeMergeState(before)})` +
        (refreshed
          ? ' — the first abort was refused because a tracked file was stale in the index, so the ' +
            'index was refreshed and the abort retried; no file content was changed'
          : '') +
        '; the worktree is back to its pre-merge state.',
    };
  }

  // Rung 3: the abort cannot get us out. Preserve, then force.
  logWarn(
    '[merge] The merge could not be aborted; saving the worktree diff and resetting to HEAD ' +
    'so the task is not left wedged mid-merge.',
  );
  const saved = await saveWorktreePatch(cwd, 'merge-settle');

  // The reset may only run over state we PROVABLY saved or PROVABLY confirmed
  // empty. A failed save means we do not know what is on disk, and resetting on
  // that is a silent destruction of work — worse than the wedge, which a human
  // can at least walk into and inspect.
  if (saved.outcome === 'failed') {
    logError(
      `[merge] Could not capture the worktree diff (${saved.reason}), so the worktree was NOT ` +
      `reset — refusing to discard state we could not save.`,
    );
    return {
      settled: false,
      detail:
        `The in-progress merge (${describeMergeState(before)}) could not be aborted` +
        `${abortStderr ? ` — git said: ${abortStderr}` : ''}, and the worktree diff could not be ` +
        `captured either (${saved.reason}), so nothing was discarded: resetting without a ` +
        `recovery patch could have destroyed uncommitted work. The worktree is STILL mid-merge ` +
        `(${describeMergeState(after)}). Inspect ${cwd} by hand — \`git status\` there, save ` +
        `anything you want to keep, then \`git merge --abort\` (or \`git reset --hard HEAD\`).`,
    };
  }

  const patchPath = saved.outcome === 'saved' ? saved.path : null;
  const reset = await elevatedResetHardHead(cwd);
  after = await readWorktreeMergeState(cwd);

  if (!isMidMerge(after)) {
    const savedNote = patchPath
      ? `The uncommitted state was saved to ${patchPath} first (apply it with \`git apply\`).`
      : 'There was nothing uncommitted to save.';
    log(`[merge] Reset the worktree to HEAD; it is settled. ${savedNote}`);
    return {
      settled: true,
      detail:
        `The in-progress merge (${describeMergeState(before)}) could not be aborted` +
        `${abortStderr ? ` — git said: ${abortStderr}` : ''}, so the worktree was reset to HEAD. ` +
        savedNote,
    };
  }

  return {
    settled: false,
    detail:
      `The worktree is STILL mid-merge and could not be settled automatically ` +
      `(${describeMergeState(after)})${abortStderr ? `; git merge --abort said: ${abortStderr}` : ''}` +
      `${reset.exitCode !== 0 && reset.stderr.trim() ? `; git reset --hard HEAD said: ${reset.stderr.trim()}` : ''}. ` +
      (patchPath ? `The uncommitted state was saved to ${patchPath}. ` : '') +
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

