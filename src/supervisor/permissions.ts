/**
 * File permission violation detection.
 *
 * After each agent turn, checks whether the agent modified or deleted content
 * in protected files. Pure additions (new files, or only added lines) are
 * allowed — they don't violate permissions.
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
 * Detect file permission violations between two SHAs.
 *
 * Returns violations for protected files that were modified or had content deleted.
 * Pure additions (new files or only added lines) are allowed.
 */
export function detectViolations(
  worktreePath: string,
  startSha: string,
  endSha: string,
  protectedPatterns: string[],
): FileViolation[] {
  if (protectedPatterns.length === 0) {
    return [];
  }

  if (startSha === endSha) {
    return [];
  }

  // Get list of changed files with their status
  const result = runGit(
    ['diff', '--name-status', startSha, endSha],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    log(`[permissions] Failed to get diff: ${result.stderr}`);
    return [];
  }

  if (!result.stdout.trim()) {
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
    if (!matchesProtectedPattern(filePath, protectedPatterns)) {
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
