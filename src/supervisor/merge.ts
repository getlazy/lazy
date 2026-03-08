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
import type { MergeConflict } from '../types';
import { log, logError } from './log';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import mergeConflictResolutionTemplate from '../prompts/merge-conflict-resolution.md' with { type: 'text' };
import remoteBranchMergeTemplate from '../prompts/remote-branch-merge.md' with { type: 'text' };

/** Maximum retries for Claude Code merge resolution failures */
const MERGE_MAX_RETRIES = 2;

/**
 * Run the sync-with-upstream phase (merge upstream and resolve conflicts).
 * @param worktreePath Working directory (the task's worktree)
 * @param parentBranch Branch to merge from
 * @param modelId Optional model override
 * @returns Array of merge conflicts captured before resolution (empty if clean merge)
 * @throws If merge fails and cannot be resolved
 */
export async function runSyncWithUpstream(
  worktreePath: string,
  parentBranch: string,
  modelId?: string,
): Promise<MergeConflict[]> {
  log(`[merge] Merging ${parentBranch} into current branch...`);

  // Check if parent branch has changes to merge
  const hasChanges = checkUpstreamChanges(parentBranch, worktreePath);
  if (!hasChanges) {
    log('[merge] No upstream changes to merge.');
    return [];
  }

  // Attempt a clean merge first
  const mergeResult = runGit(
    ['merge', parentBranch, '--no-ff', '-m', `Merge ${parentBranch}`],
    { cwd: worktreePath },
  );

  if (mergeResult.exitCode === 0) {
    log('[merge] Clean merge succeeded.');
    return [];
  }

  // Merge has conflicts — capture conflicted files before aborting
  log('[merge] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = captureConflicts(worktreePath, parentBranch);

  runGit(['merge', '--abort'], { cwd: worktreePath });

  // Run Claude Code with a scoped merge-only prompt (with retries)
  const mergePrompt = mergeConflictResolutionTemplate.replace(/\{\{parentBranch\}\}/g, parentBranch);

  const claudeArgs = [
    'claude', '-p', mergePrompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (modelId) {
    claudeArgs.push('--model', modelId);
  }

  // Record HEAD before Claude runs so we can verify it advanced
  const preMergeSha = getHeadSha(worktreePath);
  log(`[merge] Pre-merge HEAD: ${preMergeSha.substring(0, 8)}`);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MERGE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log(`[merge] Retrying Claude Code for conflict resolution (attempt ${attempt + 1}/${MERGE_MAX_RETRIES + 1})...`);
      // Ensure any stale merge state is cleaned up before retry
      abortMergeIfInProgress(worktreePath);
    } else {
      log('[merge] Running Claude Code for conflict resolution...');
    }

    const proc = spawn(claudeArgs, {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
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
      abortMergeIfInProgress(worktreePath);
      lastError = new Error(`Merge-and-fix Claude Code exited with code ${exitCode}`);
      continue;
    }

    // Verify the merge was actually completed:
    // 1. No unmerged files remain
    const statusResult = runGit(
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd: worktreePath },
    );

    const unmergedFiles = statusResult.stdout;
    if (unmergedFiles) {
      abortMergeIfInProgress(worktreePath);
      lastError = new Error(`Merge-and-fix incomplete. Unmerged files remain:\n${unmergedFiles}`);
      continue;
    }

    // 2. MERGE_HEAD should not exist (merge was committed, not left in progress)
    if (hasMergeInProgress(worktreePath)) {
      abortMergeIfInProgress(worktreePath);
      lastError = new Error('Merge-and-fix incomplete: merge is still in progress (MERGE_HEAD exists). Claude resolved conflicts but did not commit the merge.');
      continue;
    }

    // 3. HEAD must have advanced (a merge commit was actually created)
    const postMergeSha = getHeadSha(worktreePath);
    if (postMergeSha === preMergeSha) {
      lastError = new Error('Merge-and-fix incomplete: HEAD did not advance. Claude may have aborted the merge without committing.');
      continue;
    }

    log(`[merge] Post-merge HEAD: ${postMergeSha.substring(0, 8)}`);
    log('[merge] Merge-and-fix completed successfully.');
    return conflicts;
  }

  // All retries exhausted
  abortMergeIfInProgress(worktreePath);
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
 * @returns Array of merge conflicts captured before resolution (empty if clean merge)
 * @throws If merge fails and cannot be resolved
 */
export async function runSyncWithRemote(
  worktreePath: string,
  remoteBranch: string,
  modelId?: string,
): Promise<MergeConflict[]> {
  log(`[remote-sync] Merging ${remoteBranch} into current branch...`);

  // Check if remote branch has changes to merge
  const hasChanges = checkRemoteChanges(remoteBranch, worktreePath);
  if (!hasChanges) {
    log('[remote-sync] No remote changes to merge.');
    return [];
  }

  // Attempt a clean merge first
  const mergeResult = runGit(
    ['merge', remoteBranch, '--no-ff', '-m', `Merge ${remoteBranch}`],
    { cwd: worktreePath },
  );

  if (mergeResult.exitCode === 0) {
    log('[remote-sync] Clean merge succeeded.');
    return [];
  }

  // Merge has conflicts — capture conflicted files before aborting
  log('[remote-sync] Merge has conflicts. Using Claude Code to resolve...');
  const conflicts = captureConflicts(worktreePath, remoteBranch);

  runGit(['merge', '--abort'], { cwd: worktreePath });

  // Run Claude Code with a scoped merge-only prompt
  const mergePrompt = remoteBranchMergeTemplate.replace(/\{\{remoteBranch\}\}/g, remoteBranch);

  const claudeArgs = [
    'claude', '-p', mergePrompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (modelId) {
    claudeArgs.push('--model', modelId);
  }

  // Record HEAD before Claude runs so we can verify it advanced
  const preMergeSha = getHeadSha(worktreePath);
  log(`[remote-sync] Pre-merge HEAD: ${preMergeSha.substring(0, 8)}`);
  log('[remote-sync] Running Claude Code for conflict resolution...');

  const proc = spawn(claudeArgs, {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
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
    abortMergeIfInProgress(worktreePath);
    throw new Error(`Sync-with-remote Claude Code exited with code ${exitCode}`);
  }

  // Verify the merge was actually completed:
  // 1. No unmerged files remain
  const statusResult = runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd: worktreePath },
  );

  const unmergedFiles = statusResult.stdout;
  if (unmergedFiles) {
    abortMergeIfInProgress(worktreePath);
    throw new Error(`Sync-with-remote incomplete. Unmerged files remain:\n${unmergedFiles}`);
  }

  // 2. MERGE_HEAD should not exist (merge was committed, not left in progress)
  if (hasMergeInProgress(worktreePath)) {
    abortMergeIfInProgress(worktreePath);
    throw new Error('Sync-with-remote incomplete: merge is still in progress (MERGE_HEAD exists). Claude resolved conflicts but did not commit the merge.');
  }

  // 3. HEAD must have advanced (a merge commit was actually created)
  const postMergeSha = getHeadSha(worktreePath);
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
function captureConflicts(worktreePath: string, mergeSource: string): MergeConflict[] {
  const result = runGit(
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

function checkRemoteChanges(remoteBranch: string, cwd: string): boolean {
  const result = runGit(
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

function getHeadSha(cwd: string): string {
  const result = runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    return 'unknown';
  }
  return result.stdout;
}

/**
 * Check if a merge is in progress (MERGE_HEAD exists).
 */
export function hasMergeInProgress(cwd: string): boolean {
  const result = runGit(
    ['rev-parse', '--verify', 'MERGE_HEAD'],
    { cwd },
  );
  return result.exitCode === 0;
}

/**
 * Check if the worktree has unmerged files (conflict markers).
 */
export function hasUnmergedFiles(cwd: string): boolean {
  const result = runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd },
  );
  return result.exitCode === 0 && result.stdout.length > 0;
}

/**
 * Abort an in-progress merge if one exists. Returns true if a merge was aborted.
 */
export function abortMergeIfInProgress(cwd: string): boolean {
  if (!hasMergeInProgress(cwd)) {
    return false;
  }
  const result = runGit(['merge', '--abort'], { cwd });
  if (result.exitCode === 0) {
    log('[merge] Aborted in-progress merge.');
    return true;
  }
  logError(`[merge] Failed to abort merge: ${result.stderr}`);
  return false;
}

function checkUpstreamChanges(parentBranch: string, cwd: string): boolean {
  const currentBranch = runGit(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd },
  );

  if (currentBranch.exitCode !== 0) return false;

  const result = runGit(
    ['rev-list', '--count', `${currentBranch.stdout}..${parentBranch}`],
    { cwd },
  );

  if (result.exitCode !== 0) return false;

  const count = parseInt(result.stdout, 10);
  return count > 0;
}
