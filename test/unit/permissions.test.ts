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
});
