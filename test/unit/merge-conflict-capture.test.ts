/**
 * Unit tests for merge conflict capture.
 *
 * Tests two aspects:
 * 1. Git conflict capture: verifying conflicted files can be read with markers
 * 2. Storage persistence: verifying merge_conflicts survive createTurn roundtrip
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import type { MergeConflict } from '../../src/types';
import { FileStorage } from '../../src/storage/file-storage';

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
  const dir = await mkdtemp(join(tmpdir(), 'lazy-conflict-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/**
 * Create a repo with two files that will conflict on merge.
 * Returns the repo path with HEAD on the feature branch.
 */
async function createMultiFileConflictRepo(): Promise<string> {
  const dir = await createTestRepo();

  // Create files on main
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'utils.ts'), 'export const x = 1;\n');
  await writeFile(join(dir, 'config.json'), '{"key": "main-value"}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Add files on main');

  // Create a feature branch from the initial commit (before the files)
  git(dir, 'checkout', '-b', 'feature', 'HEAD~1');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'utils.ts'), 'export const x = 2;\n');
  await writeFile(join(dir, 'config.json'), '{"key": "feature-value"}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Add files on feature');

  return dir;
}

describe('merge conflict capture — git level', () => {
  let repoDir: string;

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test('conflicted files contain conflict markers after failed merge', async () => {
    repoDir = await createMultiFileConflictRepo();

    // Trigger a merge that will conflict
    const mergeResult = git(repoDir, 'merge', 'main');
    expect(mergeResult.exitCode).not.toBe(0);

    // List unmerged files
    const diffResult = git(repoDir, 'diff', '--name-only', '--diff-filter=U');
    expect(diffResult.exitCode).toBe(0);

    const unmergedFiles = diffResult.stdout.split('\n').filter(Boolean);
    expect(unmergedFiles.length).toBeGreaterThanOrEqual(1);

    // Read each file and verify it has conflict markers
    for (const filePath of unmergedFiles) {
      const content = readFileSync(join(repoDir, filePath), 'utf-8');
      expect(content).toContain('<<<<<<<');
      expect(content).toContain('=======');
      expect(content).toContain('>>>>>>>');
    }

    // Abort to clean up
    git(repoDir, 'merge', '--abort');
  });

  test('capture pattern produces valid MergeConflict objects', async () => {
    repoDir = await createMultiFileConflictRepo();

    // Trigger the conflicting merge
    git(repoDir, 'merge', 'main');

    // Replicate the captureConflicts logic inline
    const mergeSource = 'main';
    const result = Bun.spawnSync(
      ['git', 'diff', '--name-only', '--diff-filter=U'],
      { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' },
    );

    const filePaths = result.stdout.toString().trim().split('\n').filter(Boolean);
    const conflicts: MergeConflict[] = [];

    for (const filePath of filePaths) {
      const content = readFileSync(join(repoDir, filePath), 'utf-8');
      conflicts.push({ path: filePath, content, merge_source: mergeSource });
    }

    // Verify the capture result
    expect(conflicts.length).toBeGreaterThanOrEqual(1);

    for (const conflict of conflicts) {
      expect(conflict.path).toBeTruthy();
      expect(conflict.merge_source).toBe('main');
      expect(conflict.content).toContain('<<<<<<<');
      expect(conflict.content).toContain('=======');
      expect(conflict.content).toContain('>>>>>>>');
    }

    // Clean up
    git(repoDir, 'merge', '--abort');
  });
});

describe('merge conflict capture — storage persistence', () => {
  let storageDir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lazy-storage-test-'));

    // Init a git repo and .lazy directory so FileStorage/getDataDir is happy
    git(storageDir, 'init');
    git(storageDir, 'config', 'user.email', 'test@lazy.test');
    git(storageDir, 'config', 'user.name', 'Lazy Test');
    await mkdir(join(storageDir, '.lazy'), { recursive: true });
    await writeFile(join(storageDir, 'README.md'), '# Test\n');
    git(storageDir, 'add', '.');
    git(storageDir, 'commit', '-m', 'Init');

    storage = new FileStorage(storageDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  test('createTurn with merge_conflicts persists them in turns.json', async () => {
    // Create a task and session
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'test-agent', 'main', 'abc123');

    const conflicts: MergeConflict[] = [
      {
        path: 'src/utils.ts',
        content: '<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> main\n',
        merge_source: 'main',
      },
      {
        path: 'config.json',
        content: '<<<<<<< HEAD\n{"key": "ours"}\n=======\n{"key": "theirs"}\n>>>>>>> main\n',
        merge_source: 'main',
      },
    ];

    // Create a turn with merge conflicts
    const turn = await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'Resolved conflicts.',
      mergeConflicts: conflicts,
    });

    expect(turn.merge_conflicts).toBeDefined();
    expect(turn.merge_conflicts!.length).toBe(2);
    expect(turn.merge_conflicts![0].path).toBe('src/utils.ts');
    expect(turn.merge_conflicts![0].content).toContain('<<<<<<<');
    expect(turn.merge_conflicts![1].path).toBe('config.json');

    // Verify persistence by reading turns back
    const turns = await storage.getSessionTurns(session.id);
    expect(turns.length).toBe(1);
    expect(turns[0].merge_conflicts).toBeDefined();
    expect(turns[0].merge_conflicts!.length).toBe(2);
    expect(turns[0].merge_conflicts![0].path).toBe('src/utils.ts');
    expect(turns[0].merge_conflicts![0].merge_source).toBe('main');
  });

  test('createTurn without merge_conflicts does not add field', async () => {
    const task = await storage.createTask('No conflict task');
    const session = await storage.createSession(task.id, 'test-agent', 'main', 'abc123');

    const turn = await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'Clean merge.',
    });

    expect(turn.merge_conflicts).toBeUndefined();

    // Verify via direct JSON read
    const turnsPath = join(storageDir, '.lazy', 'tasks', task.id, 'turns.json');
    const raw = JSON.parse(await readFile(turnsPath, 'utf-8'));
    expect(raw.turns[0]).not.toHaveProperty('merge_conflicts');
  });

  test('createTurn with empty merge_conflicts array does not add field', async () => {
    const task = await storage.createTask('Empty conflicts task');
    const session = await storage.createSession(task.id, 'test-agent', 'main', 'abc123');

    const turn = await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'Clean merge.',
      mergeConflicts: [],
    });

    expect(turn.merge_conflicts).toBeUndefined();

    // Verify via direct JSON read
    const turnsPath = join(storageDir, '.lazy', 'tasks', task.id, 'turns.json');
    const raw = JSON.parse(await readFile(turnsPath, 'utf-8'));
    expect(raw.turns[0]).not.toHaveProperty('merge_conflicts');
  });
});
