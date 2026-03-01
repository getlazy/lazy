/**
 * E2E tests for the supervisor protocol.
 *
 * Tests protocol I/O round-trips, reconciliation with protocol state,
 * and host-side integration (start writes correct command).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readPlanContent, enrichResponseWithPlanContent } from '../../src/utils/reconcile';
import {
  writeCommand,
  readCommand,
  consumeCommand,
  hasCommand,
  writeResponse,
  readResponse,
  hasResponse,
  consumeResponse,
  writeStatus,
  readStatus,
  clearStatus,
  ensureProtocolDir,
  protocolDir as getProtocolDir,
} from '../../src/protocol';
import type {
  StartCommand,
  UnblockCommand,
  StopCommand,
  CompletedResponse,
  ErrorResponse,
  SupervisorStatus,
} from '../../src/protocol';

// ============================================================
// Section 1: Protocol I/O round-trips
// ============================================================

describe('protocol I/O', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'protocol-io-'));
    ensureProtocolDir(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- Command round-trips ---

  test('writeCommand / readCommand round-trip for start command', () => {
    const cmd: StartCommand = {
      type: 'start',
      task_id: 'test-task-001',
      goal: 'Fix the bug',
      prompt: 'Please fix the login bug',
      model_id: 'claude-sonnet-4-5-20250929',
    };

    writeCommand(dir, cmd);
    const read = readCommand(dir);

    expect(read).not.toBeNull();
    expect(read!.type).toBe('start');
    expect((read as StartCommand).task_id).toBe('test-task-001');
    expect((read as StartCommand).goal).toBe('Fix the bug');
    expect((read as StartCommand).prompt).toBe('Please fix the login bug');
    expect((read as StartCommand).model_id).toBe('claude-sonnet-4-5-20250929');
  });

  test('writeCommand / readCommand round-trip for unblock command', () => {
    const cmd: UnblockCommand = {
      type: 'unblock',
      task_id: 'test-task-002',
      goal: 'Add feature',
      prompt: 'Add error handling',
      claude_session_id: 'sess-123',
      parent_branch: 'main',
    };

    writeCommand(dir, cmd);
    const read = readCommand(dir);

    expect(read).not.toBeNull();
    expect(read!.type).toBe('unblock');
    expect((read as UnblockCommand).claude_session_id).toBe('sess-123');
    expect((read as UnblockCommand).parent_branch).toBe('main');
  });

  test('writeCommand / readCommand round-trip for stop command', () => {
    const cmd: StopCommand = {
      type: 'stop',
      task_id: 'test-task-003',
      reason: 'User cancelled',
    };

    writeCommand(dir, cmd);
    const read = readCommand(dir);

    expect(read).not.toBeNull();
    expect(read!.type).toBe('stop');
    expect((read as StopCommand).reason).toBe('User cancelled');
  });

  test('consumeCommand removes the command file', () => {
    writeCommand(dir, { type: 'stop', task_id: 'x' });
    expect(hasCommand(dir)).toBe(true);

    consumeCommand(dir);
    expect(hasCommand(dir)).toBe(false);
    expect(readCommand(dir)).toBeNull();
  });

  test('hasCommand detects presence and absence', () => {
    expect(hasCommand(dir)).toBe(false);

    writeCommand(dir, { type: 'stop', task_id: 'x' });
    expect(hasCommand(dir)).toBe(true);

    consumeCommand(dir);
    expect(hasCommand(dir)).toBe(false);
  });

  // --- Response round-trips ---

  test('writeResponse / readResponse round-trip for completed response', () => {
    const resp: CompletedResponse = {
      status: 'completed',
      result: 'I fixed the bug and committed the changes.',
      session_id: 'claude-sess-abc',
      usage: {
        input_tokens: 500,
        output_tokens: 1000,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
      },
    };

    writeResponse(dir, resp);
    const read = readResponse(dir);

    expect(read).not.toBeNull();
    expect(read!.status).toBe('completed');
    const completed = read as CompletedResponse;
    expect(completed.result).toBe('I fixed the bug and committed the changes.');
    expect(completed.session_id).toBe('claude-sess-abc');
    expect(completed.usage.input_tokens).toBe(500);
    expect(completed.usage.output_tokens).toBe(1000);
    expect(completed.usage.cache_creation_input_tokens).toBe(50);
    expect(completed.usage.cache_read_input_tokens).toBe(200);
  });

  test('writeResponse / readResponse round-trip for error response', () => {
    const resp: ErrorResponse = {
      status: 'error',
      error: 'Merge failed: conflicting files',
      phase: 'merge_and_fix',
    };

    writeResponse(dir, resp);
    const read = readResponse(dir);

    expect(read).not.toBeNull();
    expect(read!.status).toBe('error');
    const errorResp = read as ErrorResponse;
    expect(errorResp.error).toBe('Merge failed: conflicting files');
    expect(errorResp.phase).toBe('merge_and_fix');
  });

  test('writeResponse / readResponse round-trip for error response with crash details', () => {
    const resp: ErrorResponse = {
      status: 'error',
      error: 'Work phase failed: API rate limit exceeded',
      phase: 'work',
      exit_code: 1,
      stderr: 'Error: rate limit exceeded\nRetry after 60s',
      stdout_error: 'API rate limit exceeded',
      duration_ms: 45200,
    };

    writeResponse(dir, resp);
    const read = readResponse(dir);

    expect(read).not.toBeNull();
    expect(read!.status).toBe('error');
    const errorResp = read as ErrorResponse;
    expect(errorResp.error).toBe('Work phase failed: API rate limit exceeded');
    expect(errorResp.phase).toBe('work');
    expect(errorResp.exit_code).toBe(1);
    expect(errorResp.stderr).toBe('Error: rate limit exceeded\nRetry after 60s');
    expect(errorResp.stdout_error).toBe('API rate limit exceeded');
    expect(errorResp.duration_ms).toBe(45200);
  });

  test('consumeResponse removes the response file', () => {
    writeResponse(dir, {
      status: 'completed',
      result: 'done',
      session_id: 'x',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(hasResponse(dir)).toBe(true);

    consumeResponse(dir);
    expect(hasResponse(dir)).toBe(false);
    expect(readResponse(dir)).toBeNull();
  });

  test('hasResponse detects presence and absence', () => {
    expect(hasResponse(dir)).toBe(false);

    writeResponse(dir, {
      status: 'completed',
      result: 'done',
      session_id: 'x',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(hasResponse(dir)).toBe(true);

    consumeResponse(dir);
    expect(hasResponse(dir)).toBe(false);
  });

  // --- Status round-trips ---

  test('writeStatus / readStatus round-trip', () => {
    const status: SupervisorStatus = {
      phase: 'work',
      task_id: 'test-task-001',
      command_type: 'start',
      started_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:01:00Z',
      pre_turn_sha: 'abc123',
      post_merge_sha: 'def456',
      pid: 12345,
    };

    writeStatus(dir, status);
    const read = readStatus(dir);

    expect(read).not.toBeNull();
    expect(read!.phase).toBe('work');
    expect(read!.task_id).toBe('test-task-001');
    expect(read!.command_type).toBe('start');
    expect(read!.pre_turn_sha).toBe('abc123');
    expect(read!.post_merge_sha).toBe('def456');
    expect(read!.pid).toBe(12345);
  });

  test('clearStatus removes the status file', () => {
    writeStatus(dir, {
      phase: 'idle',
      task_id: 'x',
      command_type: 'start',
      started_at: '',
      updated_at: '',
      pid: 1,
    });
    expect(readStatus(dir)).not.toBeNull();

    clearStatus(dir);
    expect(readStatus(dir)).toBeNull();
  });

  // --- Cross-file interactions ---

  test('writeCommand clears any previous response', () => {
    // Simulate: supervisor wrote response, then host writes new command
    writeResponse(dir, {
      status: 'completed',
      result: 'done',
      session_id: 'old-sess',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(hasResponse(dir)).toBe(true);

    // Host writes new command — should clear the old response
    writeCommand(dir, {
      type: 'unblock',
      task_id: 'test-task',
      goal: 'next turn',
      prompt: 'continue',
    });

    expect(hasCommand(dir)).toBe(true);
    expect(hasResponse(dir)).toBe(false);
  });

  test('readCommand returns null for empty directory', () => {
    expect(readCommand(dir)).toBeNull();
  });

  test('readResponse returns null for empty directory', () => {
    expect(readResponse(dir)).toBeNull();
  });

  test('readStatus returns null for empty directory', () => {
    expect(readStatus(dir)).toBeNull();
  });

  test('consumeCommand is safe on non-existent file', () => {
    consumeCommand(dir);
    expect(hasCommand(dir)).toBe(false);
  });

  test('consumeResponse is safe on non-existent file', () => {
    consumeResponse(dir);
    expect(hasResponse(dir)).toBe(false);
  });

  test('clearStatus is safe on non-existent file', () => {
    clearStatus(dir);
    expect(readStatus(dir)).toBeNull();
  });
});

// ============================================================
// Section 2: Reconciliation with protocol
// ============================================================

describe('reconciliation with protocol', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('completed response reconciles task to blocked', async () => {
    // Start a task — the mock supervisor immediately writes response.json
    const taskId = await createTask(ctx, 'Reconcile test', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // The mock writes response.json during launchSupervisorAsync.
    // Any subsequent command triggers reconcileIfNeeded(), which reads
    // the response and transitions working → blocked.
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');

    // Verify agent turn was recorded with the mock's result text
    expectOutput(showResult, 'I have completed the task');
  });

  test('completed response records token usage', async () => {
    const taskId = await createTask(ctx, 'Token usage test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // MOCK_CLAUDE_SUCCESS has 500 input, 1000 output = 1500 total
    expectOutput(showResult, '500 in');
    expectOutput(showResult, '1.0k out');
  });

  test('error response reconciles task to interrupted', async () => {
    const taskId = await createTask(ctx, 'Error reconcile test', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // The mock writes a completed response. Reconciliation will run on the
    // next command and transition to blocked. We need to replace the
    // completed response with an error response BEFORE any command runs.
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // Replace the completed response with an error response.
    // We need to also set task status back to working in the storage.
    setTaskStatus(ctx.root, fullTaskId, 'working');
    const errorResp: ErrorResponse = {
      status: 'error',
      error: 'Claude process crashed during work phase',
      phase: 'work',
    };
    writeResponse(protoDir, errorResp);

    // Now trigger reconciliation — should read error response and transition to interrupted
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');
  });

  test('error response with crash details records agent error turn', async () => {
    const taskId = await createTask(ctx, 'Crash details test', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // Replace the completed response with an enriched error response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    const errorResp: ErrorResponse = {
      status: 'error',
      error: 'Work phase failed: API rate limit exceeded',
      phase: 'work',
      exit_code: 1,
      stderr: 'Error: rate limit exceeded for model claude-sonnet',
      stdout_error: 'API rate limit exceeded',
      duration_ms: 45200,
    };
    writeResponse(protoDir, errorResp);

    // Trigger reconciliation and verify crash details appear in show output
    const showResult = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');
    // Error turn should be recorded and visible
    expectOutput(showResult, 'Agent crashed');
    expectOutput(showResult, 'Exit code: 1');
    expectOutput(showResult, 'rate limit exceeded');
    expectOutput(showResult, '45.2s');
  });

  test('no response and no container reconciles to interrupted', async () => {
    const taskId = await createTask(ctx, 'No container test', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Replace with no response and set task back to working
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);
    consumeResponse(protoDir);
    setTaskStatus(ctx.root, fullTaskId, 'working');

    // In mock mode: isContainerRunning=false, containerExists=false
    // With no response and no container, reconciliation should → interrupted
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');
  });

  test('response.json is consumed after successful reconciliation', async () => {
    const taskId = await createTask(ctx, 'Consume test', 'Do some work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // Before reconciliation, response.json exists
    expect(hasResponse(protoDir)).toBe(true);

    // Trigger reconciliation
    await ctx.lazy(['show', taskId]);

    // After reconciliation, response.json should be consumed
    expect(hasResponse(protoDir)).toBe(false);
  });
});

// ============================================================
// Section 3: Host-side integration
// ============================================================

describe('host-side integration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy start creates protocol directory', async () => {
    const taskId = await createTask(ctx, 'Protocol start test', 'Build the feature');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);
    expect(existsSync(protoDir)).toBe(true);
  });

  test('lazy start writes command.json that mock supervisor processes', async () => {
    const taskId = await createTask(ctx, 'Command flow test', 'Build the feature');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The mock supervisor processed the command and wrote response.json
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);
    const response = readResponse(protoDir);
    expect(response).not.toBeNull();
    expect(response!.status).toBe('completed');
  });

  test('protocol directory path follows convention', () => {
    const taskId = 'abc12345-1234-5678-9abc-def012345678';
    const result = getProtocolDir(taskId);
    // Protocol dirs live at ~/.lazy/protocol/<taskId>/ (or LAZY_PROTOCOL_BASE/<taskId>/ in tests)
    // — per-user operational state, not in the repo
    const expectedBase = process.env.LAZY_PROTOCOL_BASE || join(require('os').homedir(), '.lazy', 'protocol');
    expect(result).toBe(join(expectedBase, taskId));
  });

  test('lazy start with custom mock response preserves result text', async () => {
    const taskId = await createTask(ctx, 'Custom response test', 'Build it');
    const customResponse = {
      result: 'Custom agent output for this specific task',
      session_id: 'custom-sess-id',
      usage: { input_tokens: 42, output_tokens: 99 },
    };

    await ctx.lazyMocked(['start', taskId, '--yes'], customResponse, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // After reconciliation, the custom result should appear in the agent turn
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Custom agent output');
  });

  test('lazy start records session with container name', async () => {
    const taskId = await createTask(ctx, 'Container name test', 'Do work');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    // The container name should appear in the start output
    expectOutput(result, `lazy-${taskId}`);
  });
});

// ============================================================
// Section 4: Plan content capture
// ============================================================

describe('plan content capture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plan-capture-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('readPlanContent returns null when no plans directory exists', () => {
    expect(readPlanContent(dir)).toBeNull();
  });

  test('readPlanContent returns null when plans directory is empty', () => {
    mkdirSync(join(dir, '.lazy-task-sandbox', '.claude', 'plans'), { recursive: true });
    expect(readPlanContent(dir)).toBeNull();
  });

  test('readPlanContent reads a single plan file', () => {
    const plansDir = join(dir, '.lazy-task-sandbox', '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan.md'), '# My Plan\n\n1. Step one\n2. Step two\n');

    const content = readPlanContent(dir);
    expect(content).not.toBeNull();
    expect(content).toContain('# My Plan');
    expect(content).toContain('Step one');
  });

  test('readPlanContent picks the most recently modified plan file', async () => {
    const plansDir = join(dir, '.lazy-task-sandbox', '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });

    // Write an older plan
    writeFileSync(join(plansDir, 'old-plan.md'), 'Old plan content');

    // Wait to ensure different mtime
    await Bun.sleep(50);

    // Write a newer plan
    writeFileSync(join(plansDir, 'new-plan.md'), 'New plan content');

    const content = readPlanContent(dir);
    expect(content).toBe('New plan content');
  });

  test('readPlanContent ignores non-.md files', () => {
    const plansDir = join(dir, '.lazy-task-sandbox', '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'notes.txt'), 'Not a plan');
    writeFileSync(join(plansDir, 'plan.md'), 'Actual plan');

    const content = readPlanContent(dir);
    expect(content).toBe('Actual plan');
  });

  test('readPlanContent returns null for empty plan files', () => {
    const plansDir = join(dir, '.lazy-task-sandbox', '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'empty.md'), '   \n  \n  ');

    expect(readPlanContent(dir)).toBeNull();
  });

  test('enrichResponseWithPlanContent returns original when no plan exists', () => {
    const result = enrichResponseWithPlanContent('The plan is ready for review.', dir);
    expect(result).toBe('The plan is ready for review.');
  });

  test('enrichResponseWithPlanContent appends plan content', () => {
    const plansDir = join(dir, '.lazy-task-sandbox', '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan.md'), '# Implementation Plan\n\n- Do the thing');

    const result = enrichResponseWithPlanContent('The plan is ready for review.', dir);
    expect(result).toContain('The plan is ready for review.');
    expect(result).toContain('--- Plan File Content ---');
    expect(result).toContain('# Implementation Plan');
    expect(result).toContain('Do the thing');
  });
});

describe('plan content capture e2e', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('plan file content is captured in agent turn during reconciliation', async () => {
    const taskId = await createTask(ctx, 'Plan capture test', 'Design an architecture');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_PLAN_CONTENT: '# Architecture Plan\n\n1. Build service layer\n2. Add API endpoints',
      },
    });

    // Trigger reconciliation and check the turn content
    const showResult = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
    // The plan content should be captured in the turn
    expectOutput(showResult, 'Architecture Plan');
    expectOutput(showResult, 'Build service layer');
    expectOutput(showResult, 'Plan File Content');
  });

  test('turn content without plan file is unchanged', async () => {
    const taskId = await createTask(ctx, 'No plan test', 'Fix the bug');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const showResult = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'I have completed the task');
    // Should NOT contain plan separator when no plan exists
    expect(showResult.stdout.includes('Plan File Content')).toBe(false);
  });
});

// ============================================================
// Helpers
// ============================================================

/**
 * Find the full task ID from a short ID by scanning the tasks directory.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const match = entries.find(e => e.startsWith(shortId));
  if (!match) {
    throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  }
  return match;
}

/**
 * Directly set a task's status in file storage.
 * Used by tests to set up specific reconciliation scenarios.
 */
function setTaskStatus(root: string, fullTaskId: string, status: string): void {
  const taskPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  // Also update the session's last_interaction_at to a time far in the past
  // so the grace period doesn't prevent reconciliation in tests
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    // Set to 1 minute ago to bypass grace period
    session.last_interaction_at = new Date(Date.now() - 60000).toISOString();
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }
}
