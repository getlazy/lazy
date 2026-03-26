/**
 * File permission violation detection.
 *
 * After each agent turn, checks whether the agent modified or deleted content
 * in protected files. Pure additions (new files, or only added lines) are
 * allowed — they don't violate permissions.
 *
 * Files created by the task itself (not present at the branch point) are also
 * exempt — the permission system protects pre-existing files, not agent-created ones.
 */

import type { FileViolation } from '../types';
import { runGit } from '../utils/git';
import { log } from './log';

/**
 * Check if a file path matches any of the given glob patterns.
 */
function matchesProtectedPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a file change is a pure addition (no modifications or deletions).
 *
 * A pure addition means either:
 * - The file is entirely new (status 'A' in git diff --name-status)
 * - All hunks in the diff are additions only (no '-' lines in the diff body)
 */
function isPureAddition(
  worktreePath: string,
  startSha: string,
  endSha: string,
  filePath: string,
  nameStatus: string,
): boolean {
  // New file — always a pure addition
  if (nameStatus === 'A') {
    return true;
  }

  // For modified files, check if all hunks are additions only
  const result = runGit(
    ['diff', startSha, endSha, '--', filePath],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    // Can't get diff — treat as violation to be safe
    return false;
  }

  const lines = result.stdout.split('\n');
  for (const line of lines) {
    // Skip diff headers: --- a/file, +++ b/file, diff --git, index, @@
    if (line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('@@') || line.startsWith('\\')) {
      continue;
    }

    // A '-' line in the diff body means content was removed or modified
    if (line.startsWith('-')) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a file existed at a given SHA (the task's branch point).
 * Returns true if the file was present, false if it was not (i.e., it was
 * created by the task itself after branching).
 */
function fileExistsAtSha(worktreePath: string, sha: string, filePath: string): boolean {
  const result = runGit(
    ['cat-file', '-e', `${sha}:${filePath}`],
    { cwd: worktreePath },
  );
  return result.exitCode === 0;
}

/**
 * Detect file permission violations between two SHAs.
 *
 * Returns violations for protected files that were modified or had content deleted.
 * Pure additions (new files or only added lines) are allowed.
 *
 * When branchPointSha is provided, files that did not exist at the branch point
 * (i.e., files created by the task itself) are exempt from violation checks.
 */
export function detectViolations(
  worktreePath: string,
  startSha: string,
  endSha: string,
  protectedPatterns: string[],
  branchPointSha?: string,
): FileViolation[] {
  log(`[permissions] detectViolations called: patterns=${JSON.stringify(protectedPatterns)}, startSha=${startSha.substring(0, 8)}, endSha=${endSha.substring(0, 8)}, branchPointSha=${branchPointSha?.substring(0, 8) ?? 'none'}`);

  if (protectedPatterns.length === 0) {
    log('[permissions] No protected patterns — skipping');
    return [];
  }

  if (startSha === endSha) {
    log('[permissions] startSha === endSha — no changes to check');
    return [];
  }

  // Get list of changed files with their status
  log(`[permissions] Running: git diff --name-status ${startSha.substring(0, 8)} ${endSha.substring(0, 8)}`);
  const result = runGit(
    ['diff', '--name-status', startSha, endSha],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    log(`[permissions] Failed to get diff (exit ${result.exitCode}): ${result.stderr}`);
    return [];
  }

  log(`[permissions] git diff output: "${result.stdout.trim()}"`);

  if (!result.stdout.trim()) {
    log('[permissions] No changed files');
    return [];
  }

  const violations: FileViolation[] = [];
  const lines = result.stdout.trim().split('\n');

  for (const line of lines) {
    // Format: "M\tpath/to/file" or "A\tpath/to/file" or "D\tpath/to/file"
    // Rename: "R100\told\tnew"
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const status = parts[0].charAt(0); // M, A, D, R, C, etc.
    const filePath = status === 'R' || status === 'C' ? parts[2] : parts[1];

    if (!filePath) continue;

    // Check if the file matches a protected pattern
    const matched = matchesProtectedPattern(filePath, protectedPatterns);
    log(`[permissions] File: ${filePath} (status=${status}) matched=${matched}`);
    if (!matched) {
      continue;
    }

    // If a branch point SHA is provided, check whether the file existed before the
    // task started. Files created by the task itself are exempt from violations —
    // the permission system protects pre-existing files, not agent-created ones.
    if (branchPointSha && !fileExistsAtSha(worktreePath, branchPointSha, filePath)) {
      log(`[permissions] Skipping ${filePath}: file did not exist at branch point ${branchPointSha.substring(0, 8)} (created by this task)`);
      continue;
    }

    // Deleted files always violate
    if (status === 'D') {
      log(`[permissions] Violation: ${filePath} was deleted`);
      violations.push({
        file: filePath,
        base_sha: startSha,
        status: 'pending',
      });
      continue;
    }

    // Check if the change is a pure addition
    if (!isPureAddition(worktreePath, startSha, endSha, filePath, status)) {
      log(`[permissions] Violation: ${filePath} was modified (not a pure addition)`);
      violations.push({
        file: filePath,
        base_sha: startSha,
        status: 'pending',
      });
    }
  }

  return violations;
}
