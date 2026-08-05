/**
 * Unit test: lazy_show's retry_status payload.
 *
 * A builder driving tasks over MCP has no host CLI. Before this, a task stuck
 * in the supervisor's retry loop was indistinguishable over MCP from a healthy
 * `working` one — which is how a multi-minute rate-limit stall went undiagnosed.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { buildRetryStatus } from '../../src/mcp/tools';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { SupervisorStatus } from '../../src/protocol/types';
import type { Task } from '../../src/types';

const dirs: string[] = [];

function makeTask(status: string): Task {
  const id = randomUUID();
  return {
    id,
    goal: 'retry visibility',
    status,
    created_at: Date.now(),
    updated_at: Date.now(),
  } as unknown as Task;
}

function writeStatus(taskId: string, status: SupervisorStatus): void {
  const dir = getProtocolDir(taskId);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2));
}

function retryingStatus(taskId: string, overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  const now = '2026-07-27T10:00:00.000Z';
  return {
    phase: 'retrying',
    task_id: taskId,
    command_type: 'start',
    started_at: now,
    updated_at: now,
    phase_started_at: now,
    pid: 1234,
    retryCount: 7,
    retry_failure_class: 'transient_overload',
    retry_failure_reason: 'API returned 529',
    retry_next_delay_ms: 30_000,
    errors: [{
      message: 'API Error: 529 overloaded',
      count: 7,
      firstSeen: now,
      lastSeen: '2026-07-27T10:04:00.000Z',
    }],
    ...overrides,
  };
}

describe('buildRetryStatus', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('reports attempt count, classification, delay, and the error log', async () => {
    const task = makeTask('working');
    writeStatus(task.id, retryingStatus(task.id));

    expect(await buildRetryStatus(task)).toEqual({
      summary: 'attempt 7 (transient_overload): API Error: 529 overloaded',
      retry_count: 7,
      failure_class: 'transient_overload',
      failure_reason: 'API returned 529',
      next_delay_ms: 30_000,
      errors: [{
        message: 'API Error: 529 overloaded',
        count: 7,
        first_seen: '2026-07-27T10:00:00.000Z',
        last_seen: '2026-07-27T10:04:00.000Z',
        failure_class: null,
      }],
    });
  });

  test('returns null when the supervisor is not in the retry loop', async () => {
    const task = makeTask('working');
    writeStatus(task.id, retryingStatus(task.id, { phase: 'post_turn_check' }));
    expect(await buildRetryStatus(task)).toBeNull();
  });

  test('returns null for a non-working task even if a stale status file exists', async () => {
    const task = makeTask('blocked');
    writeStatus(task.id, retryingStatus(task.id));
    expect(await buildRetryStatus(task)).toBeNull();
  });

  test('returns null when there is no supervisor status at all', async () => {
    expect(await buildRetryStatus(makeTask('working'))).toBeNull();
  });
});
