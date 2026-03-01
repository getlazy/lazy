/**
 * Unit tests for buildUpstreamMergeContext() in shared.ts.
 *
 * These tests create real git repos to verify that the upstream context
 * is built correctly from git history (commit log + diff stat + task goals).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildUpstreamMergeContext } from '../../src/cli/commands/shared';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';

/** Helper to run git commands in a directory */
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/** Create a temp git repo with an initial commit */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-ctx-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/** Create a minimal mock storage that resolves tasks by prefix */
function createMockStorage(tasks: Record<string, Partial<Task>>): Storage {
  return {
    resolveTask: async (input: string) => {
      const task = tasks[input];
      if (task) {
        return { task: task as Task };
      }
      return { task: null };
    },
  } as unknown as Storage;
}

describe('buildUpstreamMergeContext', () => {
  let repoDir: string;

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test('returns empty string when there are no upstream changes', async () => {
    repoDir = await createTestRepo();
    // Create a feature branch at the same point as main
    git(repoDir, 'checkout', '-b', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);
    expect(context).toBe('');
  });

  test('includes commit log from upstream', async () => {
    repoDir = await createTestRepo();

    // Create a feature branch
    git(repoDir, 'checkout', '-b', 'feature');

    // Add commits to main
    git(repoDir, 'checkout', 'main');
    await writeFile(join(repoDir, 'file1.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', 'file1.ts');
    git(repoDir, 'commit', '-m', 'Add file1');

    await writeFile(join(repoDir, 'file2.ts'), 'export const b = 2;\n');
    git(repoDir, 'add', 'file2.ts');
    git(repoDir, 'commit', '-m', 'Add file2');

    // Switch back to feature
    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('## Upstream changes being merged');
    expect(context).toContain('Add file1');
    expect(context).toContain('Add file2');
    expect(context).toContain('### Commits');
  });

  test('includes diff stat from upstream', async () => {
    repoDir = await createTestRepo();

    // Create a feature branch
    git(repoDir, 'checkout', '-b', 'feature');

    // Add a commit to main that modifies a file
    git(repoDir, 'checkout', 'main');
    await writeFile(join(repoDir, 'README.md'), '# Updated Test\nNew content\n');
    git(repoDir, 'add', 'README.md');
    git(repoDir, 'commit', '-m', 'Update README');

    // Switch back to feature
    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('### Files changed');
    expect(context).toContain('README.md');
  });

  test('includes context about using upstream info for resolution', async () => {
    repoDir = await createTestRepo();

    // Create a feature branch
    git(repoDir, 'checkout', '-b', 'feature');

    // Add a commit to main
    git(repoDir, 'checkout', 'main');
    await writeFile(join(repoDir, 'file.ts'), 'const x = 1;\n');
    git(repoDir, 'add', 'file.ts');
    git(repoDir, 'commit', '-m', 'Add file');

    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('Use this context to understand the intent of upstream changes');
  });

  test('includes the parent branch name in context', async () => {
    repoDir = await createTestRepo();

    git(repoDir, 'checkout', '-b', 'feature');

    git(repoDir, 'checkout', 'main');
    await writeFile(join(repoDir, 'file.ts'), 'const x = 1;\n');
    git(repoDir, 'add', 'file.ts');
    git(repoDir, 'commit', '-m', 'Add file');

    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('landed on main since your branch diverged');
  });

  test('handles merge commits from lazy branches', async () => {
    repoDir = await createTestRepo();

    // Create a feature branch
    git(repoDir, 'checkout', '-b', 'feature');

    // Create a lazy-style branch and merge it to main
    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'lazy/abc12345');
    await writeFile(join(repoDir, 'lazy-feature.ts'), 'export const lazy = true;\n');
    git(repoDir, 'add', 'lazy-feature.ts');
    git(repoDir, 'commit', '-m', 'Implement lazy feature');

    // Merge lazy branch into main with --no-ff (typical merge)
    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', 'lazy/abc12345', '--no-ff', '-m', 'Merge lazy/abc12345: Implement lazy feature (#99)');

    // Switch back to feature
    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('lazy/abc12345');
    expect(context).toContain('Implement lazy feature');
  });

  test('enriches lazy branch commits with task goals from storage', async () => {
    repoDir = await createTestRepo();

    // Create a feature branch
    git(repoDir, 'checkout', '-b', 'feature');

    // Create a lazy branch merge on main
    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'lazy/abc12345');
    await writeFile(join(repoDir, 'lazy-feature.ts'), 'export const lazy = true;\n');
    git(repoDir, 'add', 'lazy-feature.ts');
    git(repoDir, 'commit', '-m', 'Implement lazy feature');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', 'lazy/abc12345', '--no-ff', '-m', 'Merge lazy/abc12345');

    git(repoDir, 'checkout', 'feature');

    // Create mock storage with a task goal
    const mockStorage = createMockStorage({
      'abc12345': { goal: 'Add authentication to the API' },
    });

    const context = await buildUpstreamMergeContext('main', repoDir, mockStorage);

    expect(context).toContain('Goal: Add authentication to the API');
  });

  test('falls back gracefully when storage lookup fails', async () => {
    repoDir = await createTestRepo();

    git(repoDir, 'checkout', '-b', 'feature');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'lazy/abc12345');
    await writeFile(join(repoDir, 'lazy-feature.ts'), 'export const lazy = true;\n');
    git(repoDir, 'add', 'lazy-feature.ts');
    git(repoDir, 'commit', '-m', 'Implement lazy feature');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', 'lazy/abc12345', '--no-ff', '-m', 'Merge lazy/abc12345');

    git(repoDir, 'checkout', 'feature');

    // Create a storage that throws errors
    const failingStorage = {
      resolveTask: async () => { throw new Error('Storage unavailable'); },
    } as unknown as Storage;

    const context = await buildUpstreamMergeContext('main', repoDir, failingStorage);

    // Should still return context, just without goal enrichment
    expect(context).toContain('Merge lazy/abc12345');
    expect(context).not.toContain('Goal:');
  });

  test('handles multiple commits with various formats', async () => {
    repoDir = await createTestRepo();

    git(repoDir, 'checkout', '-b', 'feature');

    git(repoDir, 'checkout', 'main');

    // Direct push
    await writeFile(join(repoDir, 'hotfix.ts'), 'fix();\n');
    git(repoDir, 'add', 'hotfix.ts');
    git(repoDir, 'commit', '-m', 'Hotfix: fix critical bug');

    // Another commit
    await writeFile(join(repoDir, 'config.ts'), 'export default {};\n');
    git(repoDir, 'add', 'config.ts');
    git(repoDir, 'commit', '-m', 'Add default config');

    git(repoDir, 'checkout', 'feature');

    const context = await buildUpstreamMergeContext('main', repoDir, null);

    expect(context).toContain('Hotfix: fix critical bug');
    expect(context).toContain('Add default config');
    expect(context).toContain('hotfix.ts');
    expect(context).toContain('config.ts');
  });
});
