/**
 * Unit tests for file permission violation detection.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectViolations } from '../../src/supervisor/permissions';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function getSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('detectViolations', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lazy-perm-test-'));
    git(repoDir, 'init');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    writeFileSync(join(repoDir, 'README.md'), '# Project\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Initial commit');
    git(repoDir, 'branch', '-M', 'main');
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(repoDir, { recursive: true, force: true });
  });

  test('returns empty array when no files changed', async () => {
    const sha = getSha(repoDir);
    const violations = await detectViolations(repoDir, sha, sha, ['test/**']);
    expect(violations).toEqual([]);
  });

  test('returns empty array when no patterns provided', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'test.spec.ts'), 'modified\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Change test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, []);
    expect(violations).toEqual([]);
  });

  // INVARIANT: New test files are pure additions — no violation.
  test('allows new file creation in protected directory', async () => {
    const startSha = getSha(repoDir);

    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'new.test.ts'), 'test("works", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add new test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Modifying an existing test file triggers a violation.
  test('detects modification of existing protected file', async () => {
    // Create a test file first
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("original", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add existing test');
    const startSha = getSha(repoDir);

    // Modify the test file
    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("changed", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Modify test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/existing.test.ts');
    expect(violations[0].base_sha).toBe(startSha);
    expect(violations[0].status).toBe('pending');
  });

  // INVARIANT: Deleting a protected file triggers a violation.
  test('detects deletion of protected file', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'to-delete.test.ts'), 'test("will be deleted", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add test to delete');
    const startSha = getSha(repoDir);

    git(repoDir, 'rm', 'test/to-delete.test.ts');
    git(repoDir, 'commit', '-m', 'Delete test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/to-delete.test.ts');
  });

  // INVARIANT: Only appending to a file (pure addition) is allowed.
  test('allows appending-only changes to protected files', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'append.test.ts'), 'test("original", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add test');
    const startSha = getSha(repoDir);

    // Append only — no removal of existing lines
    writeFileSync(join(repoDir, 'test', 'append.test.ts'), 'test("original", () => {});\ntest("new", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Append to test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Pattern matching uses glob syntax (e.g., *.test.* matches any level).
  test('matches glob patterns like *.test.*', async () => {
    writeFileSync(join(repoDir, 'foo.test.ts'), 'original\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add test');
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'foo.test.ts'), 'modified\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Modify test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['*.test.*']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('foo.test.ts');
  });

  // INVARIANT: Files created by the task itself are not violations when modified later.
  // The permission system protects pre-existing files, not agent-created ones.
  test('allows modification of file created by earlier commits in same task', async () => {
    // Record the branch point (before the task creates any files)
    const branchPointSha = getSha(repoDir);

    // Task creates a new file matching protected pattern (simulates turn 1)
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'new-feature.test.ts'), 'test("v1", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Turn 1: create test file');

    // Later turn modifies the same file (simulates turn 5 after feedback)
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'test', 'new-feature.test.ts'), 'test("v2 - rewritten after feedback", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Turn 5: modify test after feedback');
    const endSha = getSha(repoDir);

    // Without branchPointSha, this would be flagged as a violation
    const violationsWithout = await detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violationsWithout.length).toBe(1);

    // With branchPointSha, the file is recognized as task-created and exempt
    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**'], branchPointSha);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Files created by the task itself can be deleted without violation.
  test('allows deletion of file created by earlier commits in same task', async () => {
    const branchPointSha = getSha(repoDir);

    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'temp.test.ts'), 'test("temp", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Create temp test');

    const startSha = getSha(repoDir);
    git(repoDir, 'rm', 'test/temp.test.ts');
    git(repoDir, 'commit', '-m', 'Delete temp test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**'], branchPointSha);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Pre-existing files are still protected even when branchPointSha is provided.
  test('still detects modification of pre-existing file with branchPointSha', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("original", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add pre-existing test');

    // Branch point is after the file exists — so it's a pre-existing file
    const branchPointSha = getSha(repoDir);
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("gutted", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Modify existing test');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**'], branchPointSha);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/existing.test.ts');
  });

  // INVARIANT: Non-protected files are never flagged.
  test('ignores changes to non-protected files', async () => {
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'src.ts'), 'code\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add source');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**', '*.test.*']);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Protected files brought in by a parent-branch merge are merge
  // artifacts when their content matches upstream — not task-authored violations.
  // Without upstreamMergeRef this case falsely flags (the teams-deploy-package
  // incident: agents reverted whole release merges trying to "fix" them).
  test('does not flag protected files identical to upstream after parent merge', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'upstream.test.ts'), 'test("v1", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add protected test on main');
    const branchPointSha = getSha(repoDir);

    // Task branch diverges with its own work
    git(repoDir, 'checkout', '-b', 'lazy/task-branch');
    writeFileSync(join(repoDir, 'src.ts'), 'task work\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task work');
    const preMergeSha = getSha(repoDir);

    // Parent (main) gains a protected-file change from another accepted task
    git(repoDir, 'checkout', 'main');
    writeFileSync(join(repoDir, 'test', 'upstream.test.ts'), 'test("v2 from parent", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Parent updates protected test');

    // Sync merge brings the parent's version into the task branch
    git(repoDir, 'checkout', 'lazy/task-branch');
    git(repoDir, 'merge', 'main', '-m', 'Merge parent into task');
    const postMergeSha = getSha(repoDir);

    const withoutUpstream = await detectViolations(repoDir, preMergeSha, postMergeSha, ['test/**'], branchPointSha);
    expect(withoutUpstream.length).toBe(1);
    expect(withoutUpstream[0].file).toBe('test/upstream.test.ts');

    const withUpstream = await detectViolations(repoDir, preMergeSha, postMergeSha, ['test/**'], branchPointSha, 'main');
    expect(withUpstream).toEqual([]);
  });

  // INVARIANT: Merge artifacts match the RESOLVED upstream ref, not a stale local
  // parent branch. When origin/<parent> is ahead of local main, comparing against
  // the stale local ref falsely flags merge artifacts (the teams-deploy-package
  // incident class).
  test('does not flag merge artifact when local parent is stale but resolved ref matches', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'upstream.test.ts'), 'test("v1", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'v1 on main');
    const branchPointSha = getSha(repoDir);

    git(repoDir, 'checkout', '-b', 'lazy/task-branch');
    writeFileSync(join(repoDir, 'src.ts'), 'task work\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task work');
    const preMergeSha = getSha(repoDir);

    // Simulates origin/<parent> after a forge-side accept — ahead of stale local main.
    git(repoDir, 'checkout', '-b', 'origin-main');
    writeFileSync(join(repoDir, 'test', 'upstream.test.ts'), 'test("v2 from origin", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Origin updates protected test');

    // Local main never advanced — still at v1.
    git(repoDir, 'checkout', 'main');

    // Sync merges the resolved ref (origin-main), not stale main.
    git(repoDir, 'checkout', 'lazy/task-branch');
    git(repoDir, 'merge', 'origin-main', '-m', 'Merge resolved upstream into task');
    const postMergeSha = getSha(repoDir);

    const withStaleLocal = await detectViolations(repoDir, preMergeSha, postMergeSha, ['test/**'], branchPointSha, 'main');
    expect(withStaleLocal.length).toBe(1);
    expect(withStaleLocal[0].file).toBe('test/upstream.test.ts');

    const withResolvedRef = await detectViolations(repoDir, preMergeSha, postMergeSha, ['test/**'], branchPointSha, 'origin-main');
    expect(withResolvedRef).toEqual([]);
  });

  // INVARIANT: A merge PLUS task edits to the same protected file still flags.
  test('flags protected file when task edits differ from upstream after merge', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'mixed.test.ts'), 'test("v1", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add protected test on main');
    const branchPointSha = getSha(repoDir);

    git(repoDir, 'checkout', '-b', 'lazy/task-branch');
    writeFileSync(join(repoDir, 'src.ts'), 'task work\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task work');
    const preMergeSha = getSha(repoDir);

    git(repoDir, 'checkout', 'main');
    writeFileSync(join(repoDir, 'test', 'mixed.test.ts'), 'test("v2 from parent", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Parent updates protected test');

    git(repoDir, 'checkout', 'lazy/task-branch');
    git(repoDir, 'merge', 'main', '-m', 'Merge parent into task');
    const postMergeSha = getSha(repoDir);

    // Task further edits the same protected file beyond what upstream has
    writeFileSync(join(repoDir, 'test', 'mixed.test.ts'), 'test("task-specific edit", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task edits protected file after merge');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, preMergeSha, endSha, ['test/**'], branchPointSha, 'main');
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/mixed.test.ts');
  });

  // INVARIANT: Task-authored protected-file changes still flag when upstream ref is provided.
  test('still flags task-authored protected file edits with upstream ref', async () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("original", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add pre-existing test');
    const branchPointSha = getSha(repoDir);

    git(repoDir, 'checkout', '-b', 'lazy/task-branch');
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("task edit", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task modifies protected file');
    const endSha = getSha(repoDir);

    const violations = await detectViolations(repoDir, startSha, endSha, ['test/**'], branchPointSha, 'main');
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/existing.test.ts');
  });

  // INVARIANT: a failed git scan is not "no violations" — returning [] would let
  // an authoritative empty re-detect clear a real pending conflict (07b89876).
  test('throws ViolationScanError when git diff fails', async () => {
    const { ViolationScanError } = await import('../../src/supervisor/permissions');
    const startSha = getSha(repoDir);
    await expect(
      detectViolations(repoDir, startSha, '0000000000000000000000000000000000000000', ['test/**']),
    ).rejects.toBeInstanceOf(ViolationScanError);
  });

  // INVARIANT: the BRANCH-POINT lookup fails closed too, and that is the more
  // dangerous of the two. It answers "did this file exist before the task
  // started", and an empty answer means "none of them did" — i.e. every
  // protected file is a task creation and exempt. So a failed lookup returning
  // an empty set produced `[]` here: not "one file mis-classified" but "nothing
  // protected changed", authoritative, cached, and merged with no approval
  // recorded. Since the reviewer's decision moved to accept, this scan is the
  // only thing between an unapproved protected edit and the parent branch.
  //
  // The caller that matters (resolveOutstandingViolations) catches the throw and
  // degrades to the recorded set, which can overstate what is owed but never
  // understate it.
  test('throws rather than reporting no violations when the branch-point lookup fails', async () => {
    const { ViolationScanError } = await import('../../src/supervisor/permissions');
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("original", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add pre-existing test');
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'test', 'existing.test.ts'), 'test("task edit", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Task modifies protected file');
    const endSha = getSha(repoDir);

    // The range is fine, so the diff succeeds and finds the candidate; only the
    // branch-point ref is unresolvable, which is exactly the shape of a worktree
    // repaired against a missing object.
    const missingBranchPoint = '0000000000000000000000000000000000000000';
    await expect(
      detectViolations(repoDir, startSha, endSha, ['test/**'], missingBranchPoint),
    ).rejects.toBeInstanceOf(ViolationScanError);
  });
});
