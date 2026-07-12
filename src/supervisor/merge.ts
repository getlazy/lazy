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
import { log, logError } from './log';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { hasUpstreamChanges } from '../git/operations';
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
    'claude', '-p', prompt,
    '--output-format', 'json',
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

  // Attempt a clean merge first
  const mergeResult = await runGit(
    ['merge', target, '--no-ff', '-m', `Merge ${parentBranch}`],
    { cwd: worktreePath },
  );

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

  // Merge has conflicts — capture conflicted files before aborting
  log('[merge] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = await captureConflicts(worktreePath, parentBranch);

  await runGit(['merge', '--abort'], { cwd: worktreePath });

  // Run Claude Code with a scoped merge-only prompt (with retries)
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
      // Ensure any stale merge state is cleaned up before retry
      await abortMergeIfInProgress(worktreePath);
    } else {
      log('[merge] Running Claude Code for conflict resolution...');
    }

    if (useResume) {
      log(`[merge] Using --resume with existing session ${agentSessionId!.substring(0, 8)}...`);
    }

    const claudeArgs = buildClaudeArgs(useResume);
    const proc = spawn(claudeArgs, {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 0, // Long-running: merge conflict resolution can take minutes
      env: process.env as Record<string, string>,
    });

    const outputPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const [output, stderr, exitCode] = await Promise.all([
      outputPromise,
      stderrPromise,
      proc.exited,
    ]);

    if (exitCode !== 0) {
      logError(`[merge] Claude Code failed with exit code ${exitCode} (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})`);
      logError(`[merge] stderr: ${stderr.slice(-500)}`);
      await abortMergeIfInProgress(worktreePath);

      // If we were using --resume and it failed, fall back to standalone mode
      // (session may be expired or not found) and don't count this as a retry
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

    // 2. MERGE_HEAD should not exist (merge was committed, not left in progress)
    if (await hasMergeInProgress(worktreePath)) {
      await abortMergeIfInProgress(worktreePath);
      lastError = new Error('Merge-and-fix incomplete: merge is still in progress (MERGE_HEAD exists). Claude resolved conflicts but did not commit the merge.');
      continue;
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
    // Best-effort: if the JSON doesn't parse, fall back to the raw stdout so a
    // conflict merge always yields an agent turn rather than silently dropping it.
    let resolution: AgentResponse;
    try {
      resolution = JSON.parse(output) as AgentResponse;
    } catch {
      resolution = {
        result: output.trim() || 'Resolved merge conflicts.',
        session_id: agentSessionId ?? '',
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

  // All retries exhausted
  await abortMergeIfInProgress(worktreePath);
  throw lastError ?? new Error('Merge-and-fix failed after all retries');
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
): Promise<MergeConflict[]> {
  log(`[remote-sync] Merging ${remoteBranch} into current branch...`);

  // Check if remote branch has changes to merge
  const hasChanges = await checkRemoteChanges(remoteBranch, worktreePath);
  if (!hasChanges) {
    log('[remote-sync] No remote changes to merge.');
    return [];
  }

  // Attempt a clean merge first
  const mergeResult = await runGit(
    ['merge', remoteBranch, '--no-ff', '-m', `Merge ${remoteBranch}`],
    { cwd: worktreePath },
  );

  if (mergeResult.exitCode === 0) {
    log('[remote-sync] Clean merge succeeded.');
    return [];
  }

  // Merge has conflicts — capture conflicted files before aborting
  log('[remote-sync] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = await captureConflicts(worktreePath, remoteBranch);

  await runGit(['merge', '--abort'], { cwd: worktreePath });

  // Run Claude Code with a scoped merge-only prompt
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

  const proc = spawn(claudeArgs, {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 0, // Long-running: merge conflict resolution can take minutes
    env: process.env as Record<string, string>,
  });

  const outputPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const [output, stderr, exitCode] = await Promise.all([
    outputPromise,
    stderrPromise,
    proc.exited,
  ]);

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

      const fallbackProc = spawn(claudeArgs, {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 0, // Long-running: merge conflict resolution can take minutes
        env: process.env as Record<string, string>,
      });

      const fallbackOutputPromise = new Response(fallbackProc.stdout).text();
      const fallbackStderrPromise = new Response(fallbackProc.stderr).text();

      const [fallbackOutput, fallbackStderr, fallbackExitCode] = await Promise.all([
        fallbackOutputPromise,
        fallbackStderrPromise,
        fallbackProc.exited,
      ]);

      if (fallbackExitCode !== 0) {
        logError(`[remote-sync] Fallback Claude Code failed with exit code ${fallbackExitCode}`);
        logError(`[remote-sync] stderr: ${fallbackStderr.slice(-500)}`);
        await abortMergeIfInProgress(worktreePath);
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
    await abortMergeIfInProgress(worktreePath);
    throw new Error(`Sync-with-remote incomplete. Unmerged files remain:\n${unmergedFiles}`);
  }

  // 2. MERGE_HEAD should not exist (merge was committed, not left in progress)
  if (await hasMergeInProgress(worktreePath)) {
    await abortMergeIfInProgress(worktreePath);
    throw new Error('Sync-with-remote incomplete: merge is still in progress (MERGE_HEAD exists). Claude resolved conflicts but did not commit the merge.');
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
  const result = await runGit(['merge', '--abort'], { cwd });
  if (result.exitCode === 0) {
    log('[merge] Aborted in-progress merge.');
    return true;
  }
  logError(`[merge] Failed to abort merge: ${result.stderr}`);
  return false;
}

