import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Extract a task short ID from `lazy link` output (which says "Linked task <id>") */
function extractLinkedTaskId(output: string): string {
  const match = output.match(/Linked task ([a-f0-9]{8})/);
  if (!match) {
    throw new Error(`Could not extract linked task ID from output: ${output}`);
  }
  return match[1];
}

/**
 * Set the prompt on a task by directly modifying task.json.
 * Needed for linked tasks because `lazy edit` blocks when a session exists.
 */
function setTaskPrompt(root: string, shortId: string, prompt: string): void {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const taskDir = dirs.find(d => d.startsWith(shortId));
  if (!taskDir) {
    throw new Error(`No task directory found for short ID ${shortId} in ${tasksDir}`);
  }
  const taskJsonPath = join(tasksDir, taskDir, 'task.json');
  const task = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  task.prompt = prompt;
  writeFileSync(taskJsonPath, JSON.stringify(task, null, 2));
}

/**
 * Read task metadata from task.json for a given task.
 */
function getTaskMetadata(root: string, shortId: string): Record<string, string> | null {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const taskDir = dirs.find(d => d.startsWith(shortId));
  if (!taskDir) {
    throw new Error(`No task directory found for short ID ${shortId} in ${tasksDir}`);
  }
  const taskJsonPath = join(tasksDir, taskDir, 'task.json');
  const task = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  return task.metadata ?? null;
}

/**
 * Read the first human turn's content from turns.json for a given task.
 * Used to verify that the linked task preamble is injected into the turn.
 */
function getFirstTurnContent(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const taskDir = dirs.find(d => d.startsWith(shortId));
  if (!taskDir) {
    throw new Error(`No task directory found for short ID ${shortId} in ${tasksDir}`);
  }
  const turnsPath = join(tasksDir, taskDir, 'turns.json');
  const turnsData = JSON.parse(readFileSync(turnsPath, 'utf-8'));
  const humanTurns = turnsData.turns.filter((t: { role: string }) => t.role === 'human');
  if (humanTurns.length === 0) {
    throw new Error(`No human turns found in ${turnsPath}`);
  }
  return humanTurns[0].content;
}

/**
 * Link a mock PR as a lazy task.
 * Sets up a bare repo as origin, creates a branch, and runs `lazy link` with mocked driver.
 * Returns the linked task's short ID.
 */
async function linkTask(
  ctx: TestContext,
  branch: string,
  goal: string = 'Linked PR',
): Promise<string> {
  // Set up a bare repo as "origin" so git fetch works
  const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
  Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
  ctx.git('remote', 'add', 'origin', bareRepo);

  // Create the branch locally and push it to origin
  ctx.git('branch', branch);
  ctx.git('push', 'origin', branch);

  // Mock the import result
  const mockImport = JSON.stringify({
    goal,
    branch,
    metadata: {
      github_remote_ref_url: 'https://github.com/org/repo/pull/1',
      github_remote_ref_id: '1',
      github_remote_ref_state: 'OPEN',
      import_source_url: 'https://github.com/org/repo/pull/1',
    },
    comments: [],
  });

  const result = await ctx.lazyMocked(
    ['link', 'https://github.com/org/repo/pull/1'],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
  );

  if (result.exitCode !== 0) {
    throw new Error(`lazy link failed: ${result.stderr}\n${result.stdout}`);
  }

  return extractLinkedTaskId(result.stdout);
}

describe('lazy start', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('starts a task with inline --goal and --prompt', async () => {
    const result = await ctx.lazyMocked(
      ['start', '--goal', 'Inline start test', '--prompt', 'Do the work'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectSuccess(result);
    expectOutput(result, 'Started task');
    expectOutput(result, 'Inline start test');
    expectOutput(result, 'Task is working');
  });

  test('fails if existing task has no prompt', async () => {
    const taskId = await createTask(ctx, 'Task without prompt');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectFailure(result);
    expectError(result, 'has no prompt');
  });

  test('starts an existing task and creates worktree', async () => {
    const taskId = await createTask(ctx, 'Start test', 'Do the work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    expectSuccess(result);
    expectOutput(result, 'Started task');
    expectOutput(result, `lazy/${taskId}`);
  });

  test('task transitions to blocked after start (supervisor completes immediately)', async () => {
    const taskId = await createTask(ctx, 'Status test', 'Do work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Mock supervisor writes response.json immediately, so reconciliation
    // transitions the task from working → blocked when show triggers it
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'blocked');
  });

  test('cannot start same task twice', async () => {
    const taskId = await createTask(ctx, 'Double start', 'Do work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const secondStart = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectFailure(secondStart);
    expect(secondStart.stderr).toMatch(/already has an active session|session has ended/);
  });

  test('--yes skips confirmation when starting existing task', async () => {
    const taskId = await createTask(ctx, 'Yes flag test', 'Do the work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    expectSuccess(result);
    expectOutput(result, 'Started task');
    // Prompt should not be shown in output (no confirmation)
  });

  // INVARIANT: Non-destructive commands auto-proceed when no TTY and all
  // required args are present. Starting an existing task (which already has
  // goal + prompt) should not require --yes in non-TTY environments.
  test('auto-proceeds when no TTY and existing task has all required args', async () => {
    const taskId = await createTask(ctx, 'No TTY test', 'Do the work');

    // lazyMocked runs without a TTY by default — should succeed without --yes
    const result = await ctx.lazyMocked(['start', taskId], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Started task');
  });

  test('starts a linked task using existing branch (no branch creation or push)', async () => {
    const branch = 'feature/linked-pr';
    const taskId = await linkTask(ctx, branch, 'Fix linked PR');

    // Set prompt on the linked task (direct file edit since lazy edit blocks)
    setTaskPrompt(ctx.root, taskId, 'Review and fix the linked PR');

    // The mock import result must be provided so the mock remote driver is active
    const mockImport = JSON.stringify({
      goal: 'Fix linked PR',
      branch,
      metadata: { import_source_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(result);
    expectOutput(result, 'Started task');
    // Should use the existing branch name, not lazy/<id>
    expectOutput(result, branch);
    expectOutputExcludes(result, `lazy/${taskId}`);
    // Should reuse the existing worktree
    expectOutput(result, 'Reusing existing worktree');
  });

  test('linked task does not create a new branch', async () => {
    const branch = 'ivan/my-feature';
    const taskId = await linkTask(ctx, branch, 'My linked feature');

    setTaskPrompt(ctx.root, taskId, 'Work on the feature');

    const mockImport = JSON.stringify({
      goal: 'My linked feature',
      branch,
      metadata: { import_source_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(result);
    // Branch output should show the original branch, not lazy/<id>
    expectOutput(result, branch);
    // Verify no "Creating worktree" message (should be "Reusing")
    expectOutputExcludes(result, 'Creating worktree');
  });

  test('linked task first turn includes situational awareness preamble', async () => {
    const branch = 'feature/preamble-test';
    const taskId = await linkTask(ctx, branch, 'Preamble test PR');

    const userPrompt = 'Fix the auth bug in login.ts';
    setTaskPrompt(ctx.root, taskId, userPrompt);

    const mockImport = JSON.stringify({
      goal: 'Preamble test PR',
      branch,
      metadata: { import_source_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(result);

    // Read the first turn content from storage
    const turnContent = getFirstTurnContent(ctx.root, taskId);

    // Preamble should mention the existing branch name
    expect(turnContent).toContain(`existing branch '${branch}'`);
    // Preamble should mention it was forked from parent branch
    expect(turnContent).toContain('forked from');
    // Preamble should include branch status info
    expect(turnContent).toContain('commit(s) ahead');
    // Preamble should include working tree status
    expect(turnContent).toMatch(/Working tree (is clean|has uncommitted changes)/);
    // The original user prompt must appear AFTER the preamble
    expect(turnContent).toContain(userPrompt);
    // The preamble comes before the user prompt (separated by ---)
    const preambleEnd = turnContent.indexOf('---');
    const promptStart = turnContent.indexOf(userPrompt);
    expect(preambleEnd).toBeGreaterThan(-1);
    expect(promptStart).toBeGreaterThan(preambleEnd);
  });

  test('stores remote_target_branch metadata when starting on a non-main branch', async () => {
    // Create and switch to a feature branch
    ctx.git('checkout', '-b', 'feature/my-branch');
    ctx.git('commit', '--allow-empty', '-m', 'feature commit');

    const result = await ctx.lazyMocked(
      ['start', '--goal', 'Non-main branch test', '--prompt', 'Do the work'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectSuccess(result);
    expectOutput(result, 'Started task');

    // Extract task ID from output
    const taskId = extractTaskId(result.stdout);

    // Verify remote_target_branch is set to the feature branch, not 'main'
    const metadata = getTaskMetadata(ctx.root, taskId);
    expect(metadata).not.toBeNull();
    expect(metadata!.remote_target_branch).toBe('feature/my-branch');
  });

  test('stores remote_target_branch metadata when starting on main', async () => {
    const result = await ctx.lazyMocked(
      ['start', '--goal', 'Main branch test', '--prompt', 'Do the work'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);

    const metadata = getTaskMetadata(ctx.root, taskId);
    expect(metadata).not.toBeNull();
    expect(metadata!.remote_target_branch).toBe('main');
  });

  test('linked task preamble includes parent_branch from link metadata', async () => {
    const branch = 'feature/parent-branch-test';
    const taskId = await linkTask(ctx, branch, 'Parent branch test');

    setTaskPrompt(ctx.root, taskId, 'Do some work');

    const mockImport = JSON.stringify({
      goal: 'Parent branch test',
      branch,
      metadata: { import_source_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(result);

    // Read the first turn content
    const turnContent = getFirstTurnContent(ctx.root, taskId);

    // The preamble should reference 'main' as the parent branch
    // (since link detects it via merge-base against the main branch)
    expect(turnContent).toContain("forked from 'main'");
  });

  // INVARIANT: Every new task branch gets an empty initial commit to prevent
  // GitHub from auto-closing PRs when the branch becomes identical to base.
  test('creates empty initial commit when starting a new task', async () => {
    const result = await ctx.lazyMocked(
      ['start', '--goal', 'Empty commit test', '--prompt', 'Do the work'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectSuccess(result);
    expectOutput(result, 'Started task');

    const taskId = extractTaskId(result.stdout);

    // Check the git log in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const logResult = Bun.spawnSync(
      ['git', 'log', '--oneline', '--format=%s'],
      { cwd: worktreePath, stdout: 'pipe' },
    );

    expect(logResult.exitCode).toBe(0);
    const commits = logResult.stdout.toString().trim().split('\n');

    // The first (most recent) commit should be the empty initial commit
    expect(commits[0]).toMatch(/^Initialize task/);
    expect(commits[0]).toContain('Empty commit test');
  });

  // INVARIANT: Linked tasks already have work on them, so they should NOT
  // get an empty initial commit (which would pollute the existing PR).
  test('does not create empty commit for linked tasks', async () => {
    const branch = 'feature/no-empty-commit';

    // Set up a bare repo as "origin" so git fetch works
    const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
    ctx.git('remote', 'add', 'origin', bareRepo);

    // Create the branch locally and push it to origin
    ctx.git('branch', branch);
    ctx.git('push', 'origin', branch);

    // Mock the import result
    const mockImport = JSON.stringify({
      goal: 'Linked task test',
      branch,
      metadata: {
        remote_ref_url: 'https://github.com/org/repo/pull/1',
        remote_ref_id: '1',
        remote_ref_state: 'OPEN',
        import_source_url: 'https://github.com/org/repo/pull/1',
      },
      comments: [],
    });

    const linkResult = await ctx.lazyMocked(
      ['link', 'https://github.com/org/repo/pull/1'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(linkResult);

    // Find the task directory (it has a hex ID but we need to find it)
    const tasksDir = join(ctx.root, '.lazy', 'tasks');
    const taskDirs = readdirSync(tasksDir);
    const taskDir = taskDirs[taskDirs.length - 1]; // Most recent task
    const taskJsonPath = join(tasksDir, taskDir, 'task.json');
    const task = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
    const taskShortId = taskDir.split('-')[0];

    // Set the prompt directly in task.json
    task.prompt = 'Work on the task';
    writeFileSync(taskJsonPath, JSON.stringify(task, null, 2));

    const result = await ctx.lazyMocked(
      ['start', taskShortId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectSuccess(result);

    // Check the git log in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskShortId);
    const logResult = Bun.spawnSync(
      ['git', 'log', '--oneline', '--format=%s'],
      { cwd: worktreePath, stdout: 'pipe' },
    );

    expect(logResult.exitCode).toBe(0);
    const commits = logResult.stdout.toString().trim().split('\n');

    // Should NOT have an "Initialize task" commit
    expect(commits[0]).not.toMatch(/^Initialize task/);
  });
});
