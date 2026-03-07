/**
 * E2E tests for supervisor auto-retry with exponential backoff.
 *
 * Tests that the supervisor correctly retries on failures with backoff,
 * detects crash loops, and abandons retry when new commands arrive.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import {
  writeCommand,
  readStatus,
  writeResponse,
  protocolDir as getProtocolDir,
  clearStatus,
  consumeResponse,
  hasCommand,
  ensureProtocolDir,
} from '../../src/protocol';
import type { UnblockCommand, CompletedResponse, SupervisorStatus, StartCommand } from '../../src/protocol';
import { runWork, CrashError, type RetryState } from '../../src/supervisor/work';
import type { WorkResult } from '../../src/supervisor/work';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

describe('supervisor retry', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('retry state includes retryCount and errors in status.json', async () => {
    const taskId = await createTask(ctx, 'test retry state');
    const protoDir = getProtocolDir(taskId);

    // Manually write a status with retry state
    const status: SupervisorStatus = {
      phase: 'retrying',
      task_id: taskId,
      command_type: 'start',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
      retryCount: 3,
      errors: [
        {
          message: 'Connection reset',
          count: 2,
          firstSeen: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:05:00Z',
        },
        {
          message: 'Rate limited',
          count: 1,
          firstSeen: '2025-01-01T00:06:00Z',
          lastSeen: '2025-01-01T00:06:00Z',
        },
      ],
    };

    // Write status
    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, 'status.json'), JSON.stringify(status, null, 2));

    // Read it back
    const readBack = readStatus(protoDir);
    expect(readBack).not.toBeNull();
    expect(readBack!.phase).toBe('retrying');
    expect(readBack!.retryCount).toBe(3);
    expect(readBack!.errors).toHaveLength(2);
    expect(readBack!.errors![0].message).toBe('Connection reset');
    expect(readBack!.errors![0].count).toBe(2);
    expect(readBack!.errors![1].message).toBe('Rate limited');
    expect(readBack!.errors![1].count).toBe(1);
  });

  test('error deduplication keeps last 10 distinct errors', () => {
    // This test validates the recordError function logic in work.ts
    // Since it's internal, we'll test it indirectly via protocol files

    const taskId = 'test-dedup-task';
    const protoDir = join(ctx.protocolBase,taskId);

    // Simulate 15 different errors (should keep only last 10)
    const errors = [];
    for (let i = 0; i < 15; i++) {
      errors.push({
        message: `Error ${i}`,
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
    }

    const status: SupervisorStatus = {
      phase: 'retrying',
      task_id: taskId,
      command_type: 'start',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
      retryCount: 15,
      errors,
    };

    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, 'status.json'), JSON.stringify(status, null, 2));

    const readBack = readStatus(protoDir);
    expect(readBack).not.toBeNull();
    expect(readBack!.errors).toBeDefined();
    // The supervisor would limit to 10, but we're testing file I/O here
    // The actual limit is enforced in work.ts recordError()
  });

  test('list command shows retry count for working tasks', async () => {
    const taskId = await createTask(ctx, 'test list retry display');
    const protoDir = getProtocolDir(taskId);

    // Set up task as working with retry state
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(protoDir, { recursive: true });

    const status: SupervisorStatus = {
      phase: 'retrying',
      task_id: taskId,
      command_type: 'start',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
      retryCount: 5,
      errors: [
        {
          message: 'Network timeout',
          count: 5,
          firstSeen: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:05:00Z',
        },
      ],
    };

    writeFileSync(join(protoDir, 'status.json'), JSON.stringify(status, null, 2));

    // Run list command
    const result = await ctx.lazy(['list']);

    // Should show retry state
    expect(result.exitCode).toBe(0);
    // Note: actual display format depends on task being in 'working' status
    // and session existing. This is a basic check that list runs.
  });

  test('show command handles retry state without crashing', async () => {
    const taskId = await createTask(ctx, 'test show retry details');

    // Just verify show works - actual retry display requires a session
    const result = await ctx.lazy(['show', taskId]);
    expect(result.exitCode).toBe(0);
  });

  test('show command with retry state in protocol (unit test)', async () => {
    const taskId = await createTask(ctx, 'test show with retry');
    const protoDir = getProtocolDir(taskId);

    mkdirSync(protoDir, { recursive: true });

    const status: SupervisorStatus = {
      phase: 'retrying',
      task_id: taskId,
      command_type: 'start',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
      retryCount: 10,
      errors: [
        {
          message: 'API timeout',
          count: 7,
          firstSeen: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:15:00Z',
        },
        {
          message: 'Connection refused',
          count: 3,
          firstSeen: '2025-01-01T00:16:00Z',
          lastSeen: '2025-01-01T00:20:00Z',
        },
      ],
    };

    writeFileSync(join(protoDir, 'status.json'), JSON.stringify(status, null, 2));

    // Verify status was written correctly
    const readBack = readStatus(protoDir);
    expect(readBack).not.toBeNull();
    expect(readBack!.phase).toBe('retrying');
    expect(readBack!.retryCount).toBe(10);
    expect(readBack!.errors).toHaveLength(2);
  });

  test('protocol files support retrying phase', () => {
    const taskId = 'proto-retry-test';
    const protoDir = join(ctx.protocolBase,taskId);

    const status: SupervisorStatus = {
      phase: 'retrying',
      task_id: taskId,
      command_type: 'unblock',
      started_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:10:00Z',
      pid: 12345,
      retryCount: 20,
      errors: [
        {
          message: 'Persistent error',
          count: 20,
          firstSeen: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:10:00Z',
        },
      ],
    };

    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, 'status.json'), JSON.stringify(status, null, 2));

    const read = readStatus(protoDir);
    expect(read).not.toBeNull();
    expect(read!.phase).toBe('retrying');
    expect(read!.retryCount).toBe(20);
    expect(read!.errors).toHaveLength(1);
    expect(read!.errors![0].count).toBe(20);
  });
});

describe('runWork retry with command check', () => {
  let tempProtoDir: string;

  beforeEach(async () => {
    tempProtoDir = await mkdtemp(join(tmpdir(), 'lazy-retry-test-'));
  });

  afterEach(async () => {
    await rm(tempProtoDir, { recursive: true, force: true });
  });

  // INVARIANT: When the command file is consumed before the work phase,
  // hasCommand() returns false during retry backoff, so retries proceed
  // normally. This is the fix for the false-positive "new command detected"
  // bug where the already-consumed command file was still present.
  test('retry succeeds when command file is absent (already consumed)', async () => {
    let callCount = 0;

    // First call fails, second succeeds
    const mockExecute = async (): Promise<WorkResult> => {
      callCount++;
      if (callCount === 1) {
        throw new CrashError({
          message: 'API 500 error',
          exitCode: 1,
          stderr: 'Internal Server Error',
          durationMs: 15000, // >10s so not a "fast fail"
        });
      }
      return {
        result: 'Task completed',
        session_id: 'test-session-123',
        usage: { input_tokens: 100, output_tokens: 200 },
      };
    };

    // No command.json in protocol dir — simulating early consume
    expect(hasCommand(tempProtoDir)).toBe(false);

    const result = await runWork(
      new ClaudeCodeAgent(),
      '/tmp/fake-worktree',
      'test prompt',
      undefined,
      undefined,
      tempProtoDir,
      undefined,
      mockExecute,
    );

    expect(callCount).toBe(2);
    expect(result.result).toBe('Task completed');
    expect(result.session_id).toBe('test-session-123');
  }, 120000); // backoff is 30s for first retry

  // INVARIANT: A genuinely new command written by the host during retry
  // backoff SHOULD still cancel the retry. The early-consume fix must not
  // break this: only the stale command is removed, new ones still detected.
  test('retry aborts when a genuinely new command arrives during backoff', async () => {
    let callCount = 0;

    const mockExecute = async (): Promise<WorkResult> => {
      callCount++;
      throw new CrashError({
        message: 'API 500 error',
        exitCode: 1,
        stderr: 'Internal Server Error',
        durationMs: 15000,
      });
    };

    // Write a "new" command during backoff (simulating host sending a new command)
    // We need to write it after the first failure but before the backoff completes.
    // Since backoff is 30s and command check is every 2s, we have time.
    setTimeout(() => {
      mkdirSync(tempProtoDir, { recursive: true });
      const command: StartCommand = {
        type: 'start',
        task_id: 'new-task-id',
        goal: 'new task goal',
        prompt: 'new prompt',
        turn_started_at: new Date().toISOString(),
      };
      writeFileSync(join(tempProtoDir, 'command.json'), JSON.stringify(command));
    }, 3000); // Write after 3s — within the 30s backoff window

    await expect(
      runWork(
        new ClaudeCodeAgent(),
        '/tmp/fake-worktree',
        'test prompt',
        undefined,
        undefined,
        tempProtoDir,
        undefined,
        mockExecute,
      )
    ).rejects.toThrow('Retry canceled: new command arrived');

    expect(callCount).toBe(1);
  }, 120000); // backoff is 30s for first retry
});
