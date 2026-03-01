import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrphanBranchStorage } from '../../src/storage/orphan-branch-storage';
import { FileStorage } from '../../src/storage/file-storage';
import { createStorage } from '../../src/storage';

/**
 * Helper to create an isolated git repo for testing.
 */
function createTestRepo(): string {
  const dir = join(tmpdir(), `lazy-orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  // git init
  const init = Bun.spawnSync(['git', 'init'], { cwd: dir });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);

  // Configure git user
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd: dir });

  // Create initial commit (required for worktrees to work)
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'initial'], { cwd: dir });

  // Create .lazy directory (simulates lazy init)
  mkdirSync(join(dir, '.lazy'), { recursive: true });

  return dir;
}

function cleanupTestRepo(dir: string): void {
  // Remove worktrees first to avoid git lock issues
  const worktreeList = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: dir });
  if (worktreeList.exitCode === 0) {
    const lines = worktreeList.stdout.toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('worktree ') && !line.includes(dir + '\n') && line.trim() !== `worktree ${dir}`) {
        const path = line.substring('worktree '.length).trim();
        if (path !== dir) {
          Bun.spawnSync(['git', 'worktree', 'remove', path, '--force'], { cwd: dir });
        }
      }
    }
  }

  // Force remove the directory
  const rm = Bun.spawnSync(['rm', '-rf', dir]);
  if (rm.exitCode !== 0) {
    // Best effort cleanup
  }
}

/**
 * Get the number of commits on a branch.
 */
function getCommitCount(branchName: string, cwd: string): number {
  const result = Bun.spawnSync(['git', 'rev-list', '--count', branchName], { cwd });
  if (result.exitCode !== 0) return 0;
  return parseInt(result.stdout.toString().trim(), 10);
}

/**
 * Get the latest commit message on a branch.
 */
function getLatestCommitMessage(branchName: string, cwd: string): string {
  const result = Bun.spawnSync(['git', 'log', '-1', '--format=%s', branchName], { cwd });
  if (result.exitCode !== 0) return '';
  return result.stdout.toString().trim();
}

/**
 * Check if a branch exists.
 */
function branchExists(branchName: string, cwd: string): boolean {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', `refs/heads/${branchName}`], { cwd });
  return result.exitCode === 0;
}

describe('OrphanBranchStorage', () => {
  let repoDir: string;
  let storage: OrphanBranchStorage;

  beforeEach(async () => {
    repoDir = createTestRepo();
    storage = new OrphanBranchStorage(repoDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    cleanupTestRepo(repoDir);
  });

  // --- Lifecycle ---

  test('creates orphan branch on initialization', () => {
    expect(branchExists('lazy-state', repoDir)).toBe(true);
  });

  test('creates worktree on initialization', () => {
    const worktreePath = join(repoDir, '.lazy', '.state-worktree');
    expect(existsSync(worktreePath)).toBe(true);
  });

  test('custom branch name works', async () => {
    const customStorage = new OrphanBranchStorage(repoDir, { branchName: 'custom-state' });
    await customStorage.initialize();
    expect(branchExists('custom-state', repoDir)).toBe(true);
    await customStorage.close();
  });

  test('re-initialization is idempotent', async () => {
    // Create a task first
    await storage.createTask('Test task');

    // Re-initialize
    const storage2 = new OrphanBranchStorage(repoDir);
    await storage2.initialize();

    // Data should persist
    const tasks = await storage2.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].goal).toBe('Test task');

    await storage2.close();
  });

  // --- Task CRUD ---

  test('creates and retrieves a task', async () => {
    const task = await storage.createTask('Build feature X');

    expect(task.goal).toBe('Build feature X');
    expect(task.status).toBe('backlog');
    expect(task.id).toBeDefined();

    const retrieved = await storage.getTask(task.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.goal).toBe('Build feature X');
  });

  test('creates task with parent', async () => {
    const parent = await storage.createTask('Parent task');
    const child = await storage.createTask('Child task', parent.id);

    expect(child.parent_task_id).toBe(parent.id);
  });

  test('lists tasks', async () => {
    await storage.createTask('Task A');
    await storage.createTask('Task B');
    await storage.createTask('Task C');

    const tasks = await storage.listTasks();
    expect(tasks.length).toBe(3);
  });

  test('updates task status', async () => {
    const task = await storage.createTask('Status test');
    await storage.updateTaskStatus(task.id, 'working');

    const updated = await storage.getTask(task.id);
    expect(updated!.status).toBe('working');
  });

  test('updates task goal', async () => {
    const task = await storage.createTask('Original goal');
    await storage.updateTaskGoal(task.id, 'Updated goal');

    const updated = await storage.getTask(task.id);
    expect(updated!.goal).toBe('Updated goal');
  });

  test('updates task model', async () => {
    const task = await storage.createTask('Model test');
    await storage.updateTaskModel(task.id, 'opus');

    const updated = await storage.getTask(task.id);
    expect(updated!.model).toBe('opus');
  });

  test('closes and reopens a task', async () => {
    const task = await storage.createTask('Close test');

    await storage.closeTask(task.id, 'No longer needed');
    let updated = await storage.getTask(task.id);
    expect(updated!.status).toBe('closed');
    expect(updated!.close_reason).toBe('No longer needed');

    await storage.reopenTask(task.id);
    updated = await storage.getTask(task.id);
    expect(updated!.status).toBe('backlog');
  });

  test('prefix matching for task IDs', async () => {
    const task = await storage.createTask('Prefix test');
    const prefix = task.id.substring(0, 8);

    const found = await storage.getTask(prefix);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  // --- Sessions ---

  test('creates and retrieves a session', async () => {
    const task = await storage.createTask('Session test');
    const session = await storage.createSession(task.id, 'claude-code', 'feature/test', 'abc123');

    expect(session.task_id).toBe(task.id);
    expect(session.agent_id).toBe('claude-code');

    const retrieved = await storage.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
  });

  test('ends a session', async () => {
    const task = await storage.createTask('End session test');
    const session = await storage.createSession(task.id, 'claude-code', 'feature/test', 'abc123');

    await storage.endSession(session.id, 'accepted');

    const ended = await storage.getSession(session.id);
    expect(ended!.outcome).toBe('accepted');
    expect(ended!.ended_at).not.toBeNull();
  });

  // --- Turns ---

  test('creates and retrieves turns', async () => {
    const task = await storage.createTask('Turn test');
    const session = await storage.createSession(task.id, 'claude-code', 'feature/test', 'abc123');

    const turn1 = await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'human',
      content: 'Do the thing',
    });
    const turn2 = await storage.createTurn({
      sessionId: session.id,
      sequence: 2,
      role: 'agent',
      content: 'Done!',
    });

    const turns = await storage.getSessionTurns(session.id);
    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe('human');
    expect(turns[1].role).toBe('agent');
  });

  test('gets next turn sequence', async () => {
    const task = await storage.createTask('Sequence test');
    const session = await storage.createSession(task.id, 'claude-code', 'feature/test', 'abc123');

    const seq1 = await storage.getNextTurnSequence(session.id);
    expect(seq1).toBe(1);

    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'human',
      content: 'Hello',
    });
    const seq2 = await storage.getNextTurnSequence(session.id);
    expect(seq2).toBe(2);
  });

  // --- Commits ---

  test('records and retrieves commits', async () => {
    const task = await storage.createTask('Commit test');
    const session = await storage.createSession(task.id, 'claude-code', 'feature/test', 'abc123');

    const commit = await storage.createCommit(session.id, 'deadbeef', 'Fix the bug');

    const commits = await storage.getSessionCommits(session.id);
    expect(commits.length).toBe(1);
    expect(commits[0].sha).toBe('deadbeef');
    expect(commits[0].message).toBe('Fix the bug');
  });

  // --- Comments ---

  test('creates and retrieves comments', async () => {
    const task = await storage.createTask('Comment test');

    const comment = await storage.createComment(task.id, 'This is a comment');

    const comments = await storage.getTaskComments(task.id);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toBe('This is a comment');
  });

  // --- Prompt History ---

  test('updates task prompt and gets history', async () => {
    const task = await storage.createTask('Prompt test');

    const v1 = await storage.updateTaskPrompt(task.id, 'First prompt');
    expect(v1.version).toBe(1);
    expect(v1.content).toBe('First prompt');

    const v2 = await storage.updateTaskPrompt(task.id, 'Second prompt');
    expect(v2.version).toBe(2);

    const history = await storage.getPromptHistory(task.id);
    expect(history.length).toBe(2);
  });

  // --- Search ---

  test('searches across tasks', async () => {
    await storage.createTask('Build authentication system');
    await storage.createTask('Fix database bug');

    const results = await storage.search('authentication');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('authentication');
  });

  // --- Task Tree ---

  test('supports task tree operations', async () => {
    const root = await storage.createTask('Root task');
    const child1 = await storage.createTask('Child 1', root.id);
    const child2 = await storage.createTask('Child 2', root.id);

    const children = await storage.getChildTasks(root.id);
    expect(children.length).toBe(2);

    const foundRoot = await storage.getRootTask(child1.id);
    expect(foundRoot!.id).toBe(root.id);

    const ancestry = await storage.getTaskAncestry(child1.id);
    expect(ancestry.length).toBe(2);
    expect(ancestry[0].id).toBe(root.id);
    expect(ancestry[1].id).toBe(child1.id);
  });

  // --- Git Integration ---

  test('commits appear on orphan branch after writes', async () => {
    const commitsBefore = getCommitCount('lazy-state', repoDir);

    await storage.createTask('Git commit test');

    const commitsAfter = getCommitCount('lazy-state', repoDir);
    expect(commitsAfter).toBeGreaterThan(commitsBefore);
  });

  test('commit messages are descriptive', async () => {
    await storage.createTask('My awesome feature');

    const message = getLatestCommitMessage('lazy-state', repoDir);
    expect(message).toContain('Create task');
  });

  test('reads do not create commits', async () => {
    const task = await storage.createTask('Read test');
    const commitsAfterCreate = getCommitCount('lazy-state', repoDir);

    // Perform read-only operations
    await storage.getTask(task.id);
    await storage.listTasks();
    await storage.getPromptHistory(task.id);
    await storage.getTaskComments(task.id);

    const commitsAfterReads = getCommitCount('lazy-state', repoDir);
    expect(commitsAfterReads).toBe(commitsAfterCreate);
  });

  test('orphan branch has no parent commits from main', async () => {
    // The orphan branch should have no commits in common with main
    const result = Bun.spawnSync(
      ['git', 'merge-base', 'lazy-state', 'HEAD'],
      { cwd: repoDir }
    );
    // merge-base should fail because there's no common ancestor
    expect(result.exitCode).not.toBe(0);
  });
});

describe('OrphanBranchStorage vs FileStorage parity', () => {
  let repoDir: string;
  let orphanStorage: OrphanBranchStorage;
  let fileStorage: FileStorage;

  beforeEach(async () => {
    repoDir = createTestRepo();

    orphanStorage = new OrphanBranchStorage(repoDir);
    await orphanStorage.initialize();

    fileStorage = new FileStorage(repoDir);
    await fileStorage.initialize();
  });

  afterEach(async () => {
    await orphanStorage.close();
    await fileStorage.close();
    cleanupTestRepo(repoDir);
  });

  test('both produce tasks with same structure', async () => {
    const orphanTask = await orphanStorage.createTask('Test goal');
    const fileTask = await fileStorage.createTask('Test goal');

    // Same structure (different IDs and timestamps)
    expect(orphanTask.goal).toBe(fileTask.goal);
    expect(orphanTask.status).toBe(fileTask.status);
    expect(orphanTask.parent_task_id).toBe(fileTask.parent_task_id);
    expect(orphanTask.model).toBe(fileTask.model);
  });

  test('both support full session lifecycle', async () => {
    // Orphan branch
    const oTask = await orphanStorage.createTask('Orphan test');
    const oSession = await orphanStorage.createSession(oTask.id, 'claude-code', 'branch-o', 'sha1');
    await orphanStorage.createTurn({
      sessionId: oSession.id,
      sequence: 1,
      role: 'human',
      content: 'Hello',
    });
    await orphanStorage.endSession(oSession.id, 'accepted');

    // File storage
    const fTask = await fileStorage.createTask('File test');
    const fSession = await fileStorage.createSession(fTask.id, 'claude-code', 'branch-f', 'sha2');
    await fileStorage.createTurn({
      sessionId: fSession.id,
      sequence: 1,
      role: 'human',
      content: 'Hello',
    });
    await fileStorage.endSession(fSession.id, 'accepted');

    // Both should have same structure
    const oResult = await orphanStorage.getSession(oSession.id);
    const fResult = await fileStorage.getSession(fSession.id);

    expect(oResult!.outcome).toBe(fResult!.outcome);
    expect(oResult!.outcome).toBe('accepted');
  });
});

describe('createStorage backend routing', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(repoDir);
  });

  test('defaults to in-repo (FileStorage)', async () => {
    const storage = await createStorage(repoDir);
    // Should work as FileStorage
    const task = await storage.createTask('Default backend');
    expect(task.goal).toBe('Default backend');
    await storage.close();
  });

  test('orphan-branch backend creates OrphanBranchStorage', async () => {
    const storage = await createStorage(repoDir, { backend: 'orphan-branch' });
    const task = await storage.createTask('Orphan backend');
    expect(task.goal).toBe('Orphan backend');

    // Verify the orphan branch was created
    expect(branchExists('lazy-state', repoDir)).toBe(true);

    await storage.close();
  });

  test('orphan-branch backend with custom branch name', async () => {
    const storage = await createStorage(repoDir, {
      backend: 'orphan-branch',
      branchName: 'my-state',
    });
    const task = await storage.createTask('Custom branch');
    expect(task.goal).toBe('Custom branch');

    expect(branchExists('my-state', repoDir)).toBe(true);

    await storage.close();
  });

  test('external backend requires path', async () => {
    await expect(
      createStorage(repoDir, { backend: 'external' })
    ).rejects.toThrow('externalPath is required');
  });

  test('external backend works with path', async () => {
    const extDir = join(tmpdir(), `lazy-ext-${Date.now()}`);
    mkdirSync(extDir, { recursive: true });

    const storage = await createStorage(repoDir, {
      backend: 'external',
      externalPath: extDir,
    });
    const task = await storage.createTask('External storage');
    expect(task.goal).toBe('External storage');

    await storage.close();
    Bun.spawnSync(['rm', '-rf', extDir]);
  });

  test('external storage does not create tasks/ in repo', async () => {
    const extDir = join(tmpdir(), `lazy-ext-isolation-${Date.now()}`);
    mkdirSync(extDir, { recursive: true });

    const storage = await createStorage(repoDir, {
      backend: 'external',
      externalPath: extDir,
    });

    // Create a task — should go to external storage
    const task = await storage.createTask('External-only task');
    expect(task.goal).toBe('External-only task');

    // Verify task data exists in external directory
    const extTaskDir = join(extDir, 'tasks', task.id);
    expect(existsSync(extTaskDir)).toBe(true);

    // Verify NO tasks/ directory was created in the repo's .lazy/
    const inRepoTasksDir = join(repoDir, '.lazy', 'tasks');
    expect(existsSync(inRepoTasksDir)).toBe(false);

    // getStoragePath() should return the external path
    expect(storage.getStoragePath()).toBe(extDir);

    // getTaskDir() should return a path under the external directory
    expect(storage.getTaskDir(task.id)).toBe(extTaskDir);

    await storage.close();
    Bun.spawnSync(['rm', '-rf', extDir]);
  });

  test('external storage getStoragePath returns external path', async () => {
    const extDir = join(tmpdir(), `lazy-ext-path-${Date.now()}`);
    mkdirSync(extDir, { recursive: true });

    const storage = await createStorage(repoDir, {
      backend: 'external',
      externalPath: extDir,
    });

    expect(storage.getStoragePath()).toBe(extDir);

    await storage.close();
    Bun.spawnSync(['rm', '-rf', extDir]);
  });

  test('in-repo storage getStoragePath returns .lazy path', async () => {
    const storage = await createStorage(repoDir, { backend: 'in-repo' });
    expect(storage.getStoragePath()).toBe(join(repoDir, '.lazy'));
    await storage.close();
  });
});
