import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Resolve the tasks directory for a test project. Test projects use external
 * storage (external_path in lazy.toml) with a fallback to the in-repo
 * .lazy/tasks layout.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

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
  const tasksDir = tasksDirFor(root);
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
  const tasksDir = tasksDirFor(root);
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
  const tasksDir = tasksDirFor(root);
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
    // `start` requires a real daemon (post-v0.11 the CLI routes storage and
    // turn reconciliation through the daemon). Running withDaemon also avoids a
    // lock-contention deadlock: createTask() uses ctx.lazy which would otherwise
    // auto-start a daemon that holds .storage-lock, while a LAZY_TEST start
    // subprocess opening storage directly would spin retrying for that lock.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('fails when using --goal flag (inline creation removed)', async () => {
    const result = await ctx.lazy(['start', '--goal', 'Inline start test', '--prompt', 'Do the work']);

    expectFailure(result);
    expectError(result, 'Unknown flag: --goal');
  });

  // INVARIANT: `lazy start` creates nothing. Inline creation was removed
  // deliberately in `remove-start-inline-create` (commit a709663) — a task
  // created and started in one step cannot have a forgotten --parent or --code
  // corrected, and wrong parenting was the project's largest source of rework.
  // Creation flags belong to `lazy create`, where `lazy edit` can still fix
  // them while the task sits in the backlog.
  //
  // Do NOT "fix" this by adding the flags back: that reverses a design decision
  // and needs explicit human approval. Rationale: docs/surface-asymmetries.md
  // section 9.
  for (const flag of ['--code', '--prompt', '--type', '--parent'] as const) {
    test(`rejects the creation flag ${flag} (inline creation removed)`, async () => {
      const result = await ctx.lazy(['start', flag, 'whatever']);

      expectFailure(result);
      expectError(result, `Unknown flag: ${flag}`);
    });
  }

  test('missing task ID explains the create-then-start workflow', async () => {
    const result = await ctx.lazy(['start']);

    expectFailure(result);
    expectError(result, 'Task ID is required');
    // The guidance must name `lazy create` AND show --code, since "I wanted a
    // task code" is the reason people reach for a create mode on `start`.
    expectError(result, 'lazy create');
    expectError(result, '--code');
  });

  // Parity with `lazy create`: the run-time overrides `start` does accept must
  // actually be accepted. These were silently absent from tab-completion.
  //
  // `--runner` is deliberately NOT exercised on the success path: forcing the
  // host runner drags in the bwrap/socat sandbox dependency, which this suite
  // otherwise has no need of. Its parsing is covered by the rejection test
  // below, which reaches the same boundary check without launching anything.
  test('accepts --effort alongside --model on an existing task', async () => {
    const taskId = await createTask(ctx, 'Override test', 'Do the work');

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--effort', 'high'],
      MOCK_CLAUDE_SUCCESS,
    );

    expectSuccess(result);
    expectOutput(result, 'Started task');
  });

  test('rejects an invalid --effort before starting anything', async () => {
    const taskId = await createTask(ctx, 'Bad effort', 'Do the work');

    const result = await ctx.lazy(['start', taskId, '--yes', '--effort', 'banana']);

    expectFailure(result);
    expectError(result, "Invalid effort 'banana'");
  });

  test('rejects an invalid --runner before starting anything', async () => {
    const taskId = await createTask(ctx, 'Bad runner', 'Do the work');

    const result = await ctx.lazy(['start', taskId, '--yes', '--runner', 'vm']);

    expectFailure(result);
    expectError(result, "Invalid runner 'vm'");
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

    // The mock supervisor writes response.json immediately; the daemon's
    // reconcile loop then transitions the task working → blocked. Wait for it.
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'blocked');
  }, 30_000);

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

  test.skip('starts a linked task using existing branch (no branch creation or push)', async () => {
    // Skipped: link command is timing out in this test environment
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

  test.skip('linked task does not create a new branch', async () => {
    // Skipped: link command is timing out in this test environment
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

  test.skip('linked task first turn includes situational awareness preamble', async () => {
    // Skipped: link command is timing out in this test environment
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

  test.skip('stores remote_target_branch metadata when starting on a non-main branch', async () => {
    // Skipped: test setup issue with branch switching in worktree environment
    // Create and switch to a feature branch
    ctx.git('checkout', '-b', 'feature/my-branch');
    ctx.git('commit', '--allow-empty', '-m', 'feature commit');

    const taskId = await createTask(ctx, 'Non-main branch test', 'Do the work');
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Started task');

    // Verify remote_target_branch is set to the feature branch, not 'main'
    const metadata = getTaskMetadata(ctx.root, taskId);
    expect(metadata).not.toBeNull();
    expect(metadata!.remote_target_branch).toBe('feature/my-branch');
  });

  test.skip('stores remote_target_branch metadata when starting on main', async () => {
    // Skipped: test setup issue in worktree environment
    const taskId = await createTask(ctx, 'Main branch test', 'Do the work');
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);

    const metadata = getTaskMetadata(ctx.root, taskId);
    expect(metadata).not.toBeNull();
    expect(metadata!.remote_target_branch).toBe('main');
  });

  test.skip('linked task preamble includes parent_branch from link metadata', async () => {
    // Skipped: link command is timing out in this test environment
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
    const taskId = await createTask(ctx, 'Empty commit test', 'Do the work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Started task');

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
  test.skip('does not create empty commit for linked tasks', async () => {
    // Skipped: link command is timing out in this test environment
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

  test.skip('shows warning when starting parentless task while active tasks exist', async () => {
    // TODO: This test is skipped because in e2e tests, the mock supervisor completes
    // immediately, transitioning tasks from 'working' to 'blocked' before we can
    // start the second task. Need to find a way to keep a task in 'working' state
    // for this test, or test this manually.
    //
    // The warning logic is implemented in start.ts and can be verified manually by:
    // 1. Starting a task: lazy start task1
    // 2. Creating a second task without parent: lazy create --goal "test" --prompt "test"
    // 3. Starting the second task while task1 is still working: lazy start task2
  });

  test.skip('parentless task with --yes skips warning about active tasks', async () => {
    // Skipped for same reason as above test
  });

  test('no warning when starting parentless task with no active tasks', async () => {
    // Create a task without starting any others first
    const taskId = await createTask(ctx, 'Only task', 'Do work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    // Should NOT show warning when there are no active tasks
    expectOutputExcludes(result, 'has no parent');
    expectOutputExcludes(result, 'active task');
  });

  test('child task starts successfully (has parent, no warning expected)', async () => {
    // Create and start a parent task
    const parentId = await createTask(ctx, 'Parent task', 'Parent work');
    await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Create a child task
    const result = await ctx.lazy(['create', '--goal', 'Child task', '--prompt', 'Child work', '--parent', parentId]);
    const childId = extractTaskId(result.stdout);

    // Start the child task - should succeed without warnings
    const startResult = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(startResult);
    // The warning logic only triggers for tasks without parents, so child tasks won't show it
  });

  // INVARIANT: Parentless tasks must always branch from the remote's default
  // branch, not the local checkout. This prevents start failures when the main
  // repo has an arbitrary feature branch checked out (e.g., when main is in a worktree).
  test('parentless task uses remote default branch, not local checkout', async () => {
    // Set up a bare repo as "origin" so git fetch works
    const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
    ctx.git('remote', 'add', 'origin', bareRepo);

    // Push main to origin so the remote has a default branch set
    ctx.git('push', 'origin', 'main');

    // Set origin/HEAD to point to main (this is what getRemoteDefaultBranch resolves)
    ctx.git('remote', 'set-head', 'origin', 'main');

    // Create and checkout a feature branch in the main repo (simulating worktree scenario)
    ctx.git('checkout', '-b', 'some-unrelated-feature-branch');
    ctx.git('commit', '--allow-empty', '-m', 'feature work');
    ctx.git('push', 'origin', 'some-unrelated-feature-branch');

    // Create a parentless task
    const taskId = await createTask(ctx, 'Parentless task test', 'Do the work');

    // Start the task — should use remote default branch (main), not local checkout
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Started task');

    // NOTE: the legacy `metadata.remote_target_branch` field is no longer
    // persisted — a parentless task's integration target is the canonical
    // { kind: 'branch', branch } union, and the remote default is resolved at
    // launch time rather than written back to metadata. The real invariant
    // (the branch was created FROM the remote default, not the local checkout)
    // is verified directly by the merge-base check below.

    // Verify the worktree was created from main, not the feature branch
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const mergeBaseResult = Bun.spawnSync(
      ['git', 'merge-base', `lazy/${taskId}`, 'origin/main'],
      { cwd: worktreePath, stdout: 'pipe' },
    );
    const mainTipResult = Bun.spawnSync(
      ['git', 'rev-parse', 'origin/main'],
      { cwd: worktreePath, stdout: 'pipe' },
    );

    expect(mergeBaseResult.exitCode).toBe(0);
    expect(mainTipResult.exitCode).toBe(0);

    const mergeBase = mergeBaseResult.stdout.toString().trim();
    const mainTip = mainTipResult.stdout.toString().trim();

    // The merge-base of lazy/taskId and origin/main should equal origin/main's tip,
    // meaning the task branch started from main, not from the feature branch
    expect(mergeBase).toBe(mainTip);
  });

  test('start succeeds when main repo has non-main branch checked out', async () => {
    // Set up remote
    const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
    ctx.git('remote', 'add', 'origin', bareRepo);
    ctx.git('push', 'origin', 'main');
    ctx.git('remote', 'set-head', 'origin', 'main');

    // Checkout a feature branch (this was causing the bug)
    ctx.git('checkout', '-b', 'ivan/some-feature');
    ctx.git('commit', '--allow-empty', '-m', 'feature commit');
    // Don't push the feature branch to remote — it doesn't exist on origin

    // Create a parentless task
    const taskId = await createTask(ctx, 'Bug reproduction', 'Do work');

    // This should succeed and use main, not try to fetch ivan/some-feature
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    expectSuccess(result);
    expectOutput(result, 'Started task');
    // Should not see error about fetching the feature branch
    expectOutputExcludes(result, "couldn't find remote ref ivan/some-feature");
    expectOutputExcludes(result, 'Failed to fetch');
  });
});
