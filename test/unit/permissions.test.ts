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

  test('returns empty array when no files changed', () => {
    const sha = getSha(repoDir);
    const violations = detectViolations(repoDir, sha, sha, ['test/**']);
    expect(violations).toEqual([]);
  });

  test('returns empty array when no patterns provided', () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'test.spec.ts'), 'modified\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Change test');
    const endSha = getSha(repoDir);

    const violations = detectViolations(repoDir, startSha, endSha, []);
    expect(violations).toEqual([]);
  });

  // INVARIANT: New test files are pure additions — no violation.
  test('allows new file creation in protected directory', () => {
    const startSha = getSha(repoDir);

    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'new.test.ts'), 'test("works", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add new test');
    const endSha = getSha(repoDir);

    const violations = detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Modifying an existing test file triggers a violation.
  test('detects modification of existing protected file', () => {
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

    const violations = detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/existing.test.ts');
    expect(violations[0].base_sha).toBe(startSha);
    expect(violations[0].status).toBe('pending');
  });

  // INVARIANT: Deleting a protected file triggers a violation.
  test('detects deletion of protected file', () => {
    mkdirSync(join(repoDir, 'test'), { recursive: true });
    writeFileSync(join(repoDir, 'test', 'to-delete.test.ts'), 'test("will be deleted", () => {});\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add test to delete');
    const startSha = getSha(repoDir);

    git(repoDir, 'rm', 'test/to-delete.test.ts');
    git(repoDir, 'commit', '-m', 'Delete test');
    const endSha = getSha(repoDir);

    const violations = detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('test/to-delete.test.ts');
  });

  // INVARIANT: Only appending to a file (pure addition) is allowed.
  test('allows appending-only changes to protected files', () => {
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

    const violations = detectViolations(repoDir, startSha, endSha, ['test/**']);
    expect(violations).toEqual([]);
  });

  // INVARIANT: Pattern matching uses glob syntax (e.g., *.test.* matches any level).
  test('matches glob patterns like *.test.*', () => {
    writeFileSync(join(repoDir, 'foo.test.ts'), 'original\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add test');
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'foo.test.ts'), 'modified\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Modify test');
    const endSha = getSha(repoDir);

    const violations = detectViolations(repoDir, startSha, endSha, ['*.test.*']);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('foo.test.ts');
  });

  // INVARIANT: Non-protected files are never flagged.
  test('ignores changes to non-protected files', () => {
    const startSha = getSha(repoDir);

    writeFileSync(join(repoDir, 'src.ts'), 'code\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add source');
    const endSha = getSha(repoDir);

    const violations = detectViolations(repoDir, startSha, endSha, ['test/**', '*.test.*']);
    expect(violations).toEqual([]);
  });
});
