/**
 * Unit tests for merge-conflict DETECTION (checkMergeConflicts /
 * checkMergeConflictsIntoTarget in src/git/operations.ts).
 *
 * INVARIANT: Conflict detection must reflect whether the merge algorithm
 * actually conflicts — NOT whether committed file content happens to contain
 * literal conflict-marker sequences (the 7-char "ours"/"theirs" lines git
 * writes). A branch that merely ADDS a file whose content contains those
 * markers (conflict-handling fixtures, docs about merge conflicts) does not
 * conflict and must be accepted cleanly. Regression test for the v0.19
 * false-positive that aborted an accept whose merge base WAS the target tip,
 * making a conflict impossible.
 *
 * NOTE: the marker strings below are assembled at runtime rather than written
 * as literals. The daemon that merges THIS branch still runs the pre-fix
 * detector, which greps merge-tree output for those 7-char sequences — a
 * committed literal marker would false-positive and block this fix's own
 * accept. Once the fixed detector is deployed everywhere, these can revert to
 * plain literal strings.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkMergeConflicts, checkMergeConflictsIntoTarget } from '../../src/git/operations';

/** Run a git command synchronously in a directory (test setup only). */
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/** Create a temp git repo on branch `main` with an initial commit. */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-conflict-detect-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\nline1\nline2\nline3\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

describe('merge-conflict detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTestRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a branch adding a file whose CONTENT contains literal conflict markers merges cleanly', async () => {
    // The exact shape that false-positived in v0.19: the feature branch is a
    // fast-forward descendant of main (merge base === main tip, so a conflict is
    // impossible), and it adds a fixture file containing literal marker lines.
    git(dir, 'checkout', '-b', 'feature');
    // Marker sequences built at runtime (see file header) so this committed
    // source carries no literal 7-char marker. The temp-repo file written below
    // still gets REAL marker content — the behavior under test is unchanged.
    const open = '<'.repeat(7);
    const sep = '='.repeat(7);
    const close = '>'.repeat(7);
    const fixture = [
      'These are LITERAL strings inside a test fixture, not a real conflict:',
      `${open} HEAD`,
      'ours',
      sep,
      'theirs',
      `${close} feature`,
    ].join('\n') + '\n';
    await writeFile(join(dir, 'fixture.txt'), fixture);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Add fixture containing literal conflict markers');

    // Merge feature -> main. Old content-scanning code returned true here.
    expect(await checkMergeConflictsIntoTarget('feature', 'main', dir)).toBe(false);

    // Same check via the HEAD variant (merge feature into checked-out main).
    git(dir, 'checkout', 'main');
    expect(await checkMergeConflicts('feature', dir)).toBe(false);
  });

  test('a branch with a REAL conflict is still detected', async () => {
    // Diverge main and feature on the same line so the merge genuinely conflicts.
    git(dir, 'checkout', '-b', 'feature');
    await writeFile(join(dir, 'README.md'), '# Test\nline1\nFEATURE\nline3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'feature edit');

    git(dir, 'checkout', 'main');
    await writeFile(join(dir, 'README.md'), '# Test\nline1\nMAIN\nline3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'main edit');

    expect(await checkMergeConflictsIntoTarget('feature', 'main', dir)).toBe(true);
    expect(await checkMergeConflicts('feature', dir)).toBe(true);
  });

  test('a non-conflicting divergent branch merges cleanly', async () => {
    // Both sides change different files — a normal, mergeable divergence.
    git(dir, 'checkout', '-b', 'feature');
    await writeFile(join(dir, 'feature-only.txt'), 'feature content\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'feature adds a file');

    git(dir, 'checkout', 'main');
    await writeFile(join(dir, 'main-only.txt'), 'main content\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'main adds a different file');

    expect(await checkMergeConflictsIntoTarget('feature', 'main', dir)).toBe(false);
  });

  test('an error (bad ref) throws rather than being reported as a conflict', async () => {
    // Per CLAUDE.md: fail hard on git errors — do not silently treat them as
    // "conflict" (blocks a mergeable branch) or "no conflict" (waves through an
    // unmergeable one).
    await expect(checkMergeConflictsIntoTarget('does-not-exist', 'main', dir)).rejects.toThrow();
  });
});
