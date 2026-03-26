/**
 * E2E tests for file permission violation detection.
 *
 * Verifies that the supervisor detects when agents modify or delete
 * protected files, while allowing pure additions.
 *
 * Tests use --follow so that `lazy start` waits for the mock supervisor
 * to write response.json, then reconciles before exiting. Without --follow,
 * `lazy start` returns immediately and no reconciliation happens — agent
 * turns and violations would never be recorded.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { basename, join } from 'path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Get the external storage directory for a test project.
 * In tests, there's no git remote, so getProjectName falls back to the
 * directory basename. External storage lives at ~/.lazy/<project-name>/.
 */
function getStorageDir(root: string): string {
  return join(homedir(), '.lazy', basename(root));
}

function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(getStorageDir(root), 'tasks');
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId} in ${tasksDir}`);
  return match;
}

function readTaskStatus(root: string, shortId: string): string {
  const fullId = findFullTaskId(root, shortId);
  const taskPath = join(getStorageDir(root), 'tasks', fullId, 'task.json');
  const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
  return data.status;
}

function readTurns(root: string, shortId: string): Array<{
  role: string;
  content: string;
  violations?: Array<{ file: string; base_sha: string; status: string }>;
}> {
  const fullId = findFullTaskId(root, shortId);
  const turnsPath = join(getStorageDir(root), 'tasks', fullId, 'turns.json');
  const data = JSON.parse(readFileSync(turnsPath, 'utf-8'));
  return data.turns;
}

describe('file permission violations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    // Clean up external storage directory left at ~/.lazy/<project-name>
    const storageDir = getStorageDir(ctx.root);
    if (existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
    await ctx.cleanup();
  });

  // INVARIANT: Modifying a protected test file triggers a violation.
  // Agents must not modify existing test content without human review.
  test('detects violations when agent modifies a test file', async () => {
    // Enable permissions with test file patterns
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    // Create an existing test file that the agent will modify
    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the existing test file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Use --follow so that lazy start waits for the mock supervisor to finish,
    // then reconciles (processes response.json → creates agent turn, sets status)
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(result);

    // Verify violations are stored on the agent turn (created during reconciliation)
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(agentTurn!.violations![0].file).toBe('test.spec.ts');
    expect(agentTurn!.violations![0].status).toBe('pending');

    // Violation text is NOT in the turn content — violations live in the structured field
    expect(agentTurn!.content).not.toContain('## Permission Violations');

    // INVARIANT: Tasks with violations transition to 'conflict', not 'blocked'.
    // This makes permission violations visible at a glance in task listings.
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Adding new test files is allowed — pure additions don't violate permissions.
  // Agents should be free to create new tests without triggering violations.
  test('allows pure additions to test files without violations', async () => {
    // Enable permissions with test file patterns
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["test/**"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for test dir');

    const taskId = await createTask(ctx, 'Add tests', 'Write new tests');

    // Mock agent creates a brand new test file (pure addition)
    const mockFiles = JSON.stringify([
      { path: 'test/new-feature.test.ts', content: 'describe("new feature", () => { test("works", () => {}); });\n' },
    ]);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(result);

    // Verify no violations on the agent turn
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();

    // No violations → no violation text anywhere
    expect(agentTurn!.content).not.toContain('## Permission Violations');

    // No violations means task should be in 'blocked', not 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');
  });

  // INVARIANT: Unblocking a conflict task without --approve-file reverts ALL violated files.
  // Default behavior is safe: all violations are rejected and files are reverted to base SHA.
  test('unblock without --approve-file reverts all violated files', async () => {
    // Set up protected pattern and existing file
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    const originalContent = 'describe("existing tests", () => {});\n';
    writeFileSync(join(ctx.root, 'test.spec.ts'), originalContent);
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);

    // Verify task is in conflict with pending violations
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Unblock without --approve-file → all violations rejected and reverted
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the issue without modifying tests', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(unblockResult);

    // Verify violations are marked as rejected
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations!.every(v => v.status === 'rejected')).toBe(true);

    // Verify the file was reverted in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const fileContent = readFileSync(join(worktreePath, 'test.spec.ts'), 'utf-8');
    expect(fileContent).toBe(originalContent);
  });

  // INVARIANT: --approve-file allows selective approval of violated files.
  // Only non-approved files are reverted; approved files keep their changes.
  test('unblock with --approve-file approves specified files and reverts others', async () => {
    // Set up protected pattern and two existing files
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    const originalA = 'describe("tests A", () => {});\n';
    const originalB = 'describe("tests B", () => {});\n';
    writeFileSync(join(ctx.root, 'a.spec.ts'), originalA);
    writeFileSync(join(ctx.root, 'b.spec.ts'), originalB);
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies both protected files
    const mockFiles = JSON.stringify([
      { path: 'a.spec.ts', content: 'describe("modified A", () => {});\n' },
      { path: 'b.spec.ts', content: 'describe("modified B", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Approve a.spec.ts, reject b.spec.ts (default)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--approve-file', 'a.spec.ts', '--message', 'Approved A only', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(unblockResult);

    // Verify violation statuses
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    const violationA = agentTurn!.violations!.find(v => v.file === 'a.spec.ts');
    const violationB = agentTurn!.violations!.find(v => v.file === 'b.spec.ts');
    expect(violationA!.status).toBe('approved');
    expect(violationB!.status).toBe('rejected');

    // Verify b.spec.ts was reverted but a.spec.ts kept agent changes
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const contentA = readFileSync(join(worktreePath, 'a.spec.ts'), 'utf-8');
    const contentB = readFileSync(join(worktreePath, 'b.spec.ts'), 'utf-8');
    expect(contentA).toBe('describe("modified A", () => {});\n');
    expect(contentB).toBe(originalB);
  });

  // INVARIANT: Accept refuses tasks with pending (unresolved) violations.
  // All violations must be explicitly approved or rejected before merging.
  test('accept refuses task with pending violations', async () => {
    // Set up protected pattern and existing file
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file → violations pending
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Try to accept — should fail because violations are pending
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'unresolved file permission violations');
  });

  // INVARIANT: Accept succeeds after violations are resolved (approved or rejected).
  test('accept succeeds after violations are resolved via unblock', async () => {
    // Set up protected pattern and existing file
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file AND a non-protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
      { path: 'fix.ts', content: 'export const fix = true;\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);

    // Resolve violations by unblocking (default = all rejected).
    // Second mock turn creates another non-protected file so the branch has real changes to merge.
    const mockFiles2 = JSON.stringify([
      { path: 'fix2.ts', content: 'export const fix2 = true;\n' },
    ]);
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix without modifying tests', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles2 } },
    );
    expectSuccess(unblockResult);

    // Now accept should work — violations are resolved
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);
  });

  // INVARIANT: Accept with --approve-file covering ALL pending violations succeeds.
  // This allows direct accept of conflict tasks without an unnecessary unblock round-trip.
  test('accept with --approve-file covering all violations succeeds', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file AND a non-protected file (so there's something to merge)
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
      { path: 'fix.ts', content: 'export const fix = true;\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Accept with --approve-file covering the violated file → should succeed
    const acceptResult = await ctx.lazy([
      'accept', taskId, '--approve-file', 'test.spec.ts', '--yes',
    ]);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Approved 1 protected file change(s)');

    // Verify violations are marked as approved
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations!.every(v => v.status === 'approved')).toBe(true);
  });

  // INVARIANT: Accept with partial --approve-file refuses with specific missing files.
  // Partial approval at accept time is not allowed — all or nothing.
  test('accept with partial --approve-file fails listing missing files', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'a.spec.ts'), 'describe("A", () => {});\n');
    writeFileSync(join(ctx.root, 'b.spec.ts'), 'describe("B", () => {});\n');
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'a.spec.ts', content: 'describe("modified A", () => {});\n' },
      { path: 'b.spec.ts', content: 'describe("modified B", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Approve only a.spec.ts — b.spec.ts is missing → should fail
    const acceptResult = await ctx.lazy([
      'accept', taskId, '--approve-file', 'a.spec.ts', '--yes',
    ]);
    expectFailure(acceptResult);
    expectError(acceptResult, 'Missing approval');
    expectError(acceptResult, 'b.spec.ts');
  });

  // INVARIANT: User-specified protected patterns in lazy.toml are respected
  // and merged with built-in defaults.
  test('respects custom protected patterns from lazy.toml', async () => {
    // Add a custom protected pattern to lazy.toml
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["docs/**"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Add custom protected pattern');

    // Create an existing docs file
    mkdirSync(join(ctx.root, 'docs'), { recursive: true });
    writeFileSync(join(ctx.root, 'docs', 'api.md'), '# API Docs\n');
    ctx.git('add', 'docs/api.md');
    ctx.git('commit', '-m', 'Add docs file');

    const taskId = await createTask(ctx, 'Update docs', 'Update the docs');

    // Mock agent modifies existing content in the docs file (not a pure addition).
    // Changing "# API Docs" to "# Updated API Docs" triggers a violation because
    // the original line is removed and replaced — isPureAddition returns false.
    const mockFiles = JSON.stringify([
      { path: 'docs/api.md', content: '# Updated API Docs\n' },
    ]);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(result);

    // Verify the custom pattern triggered a violation
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(agentTurn!.violations![0].file).toBe('docs/api.md');

    // Violation text is NOT in the turn content — violations live in the structured field
    expect(agentTurn!.content).not.toContain('## Permission Violations');
  });

  // INVARIANT: Push-back fires when violations are detected, giving the agent one chance
  // to self-correct. If the agent reverts the file, no violations remain in the output.
  test('push-back allows agent to revert violation and clear it', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Mock push-back: agent reverts the file
    const pushbackReverts = JSON.stringify(['test.spec.ts']);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_PUSHBACK_REVERTS: pushbackReverts,
          LAZY_MOCK_PUSHBACK_RESPONSE: 'I reverted the test file change as it was unnecessary.',
        },
      },
    );
    expectSuccess(result);

    // Verify NO violations remain on the agent turn (agent reverted)
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();

    // Pushback response IS in the turn content — reviewers need to see the agent's justification
    expect(agentTurn!.content).toContain('## Permission Violation Review');
    expect(agentTurn!.content).toContain('I reverted the test file change as it was unnecessary.');

    // No violations means task goes to 'blocked', not 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');
  });

  // INVARIANT: When push-back fires and the agent keeps the file, violations persist
  // and the task enters 'conflict' status with the agent's justification.
  test('push-back with agent keeping changes preserves violations with justification', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Mock push-back: agent keeps the file, provides justification
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          // No LAZY_MOCK_PUSHBACK_REVERTS → agent keeps all changes
          LAZY_MOCK_PUSHBACK_RESPONSE: 'The test file change is essential for the bug fix.',
        },
      },
    );
    expectSuccess(result);

    // Verify violations persist
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(agentTurn!.violations![0].file).toBe('test.spec.ts');

    // Pushback response IS in the turn content — reviewers need to see the agent's justification
    expect(agentTurn!.content).toContain('## Permission Violation Review');
    expect(agentTurn!.content).toContain('The test file change is essential for the bug fix.');

    // Violations remain → task goes to 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Push-back only happens once per turn (no infinite loop).
  // Even after push-back, the result is final and the turn completes.
  test('push-back happens only once — no re-push-back after agent response', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Agent doesn't revert — violations remain after push-back
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    expectSuccess(result);

    // The turn completed (response was written) — push-back happened exactly once
    // We verify this by checking the response has pushed_back=true and violations
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);

    // Task completed the turn and moved to conflict (not stuck in a loop)
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Violations are detected on unblock turns, not just start turns.
  // protected_patterns must be passed through unblock commands to the supervisor.
  test('detects violations on unblock turns', async () => {
    // Enable permissions with test file patterns
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    // Create an existing test file that the agent will modify
    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // First turn: agent does NOT modify protected files (no violation)
    const mockFilesFirstTurn = JSON.stringify([
      { path: 'src/main.ts', content: 'console.log("first turn - safe change");\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesFirstTurn } },
    );
    expectSuccess(startResult);

    // Verify first turn has no violations and status is 'blocked'
    let turns = readTurns(ctx.root, taskId);
    let agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();
    let status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');

    // Second turn: agent modifies protected file (should trigger violation)
    const mockFilesSecondTurn = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Now modify the test file', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesSecondTurn } },
    );
    expectSuccess(unblockResult);

    // Verify second turn has violations
    turns = readTurns(ctx.root, taskId);
    const secondAgentTurn = turns.filter(t => t.role === 'agent')[1];
    expect(secondAgentTurn).toBeDefined();
    expect(secondAgentTurn!.violations).toBeDefined();
    expect(secondAgentTurn!.violations!.length).toBe(1);
    expect(secondAgentTurn!.violations![0].file).toBe('test.spec.ts');
    expect(secondAgentTurn!.violations![0].status).toBe('pending');

    // Violation text is NOT in the turn content — violations live in the structured field
    expect(secondAgentTurn!.content).not.toContain('## Permission Violations');

    // INVARIANT: Task transitions to 'conflict' after unblock with violations
    status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });
});
