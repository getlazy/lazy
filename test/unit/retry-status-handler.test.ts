import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRetryStatusHandler } from '../../src/supervisor/retry-status';
import { readStatus } from '../../src/protocol/io';
import type { SupervisorStatus } from '../../src/protocol/types';
import type { RetryState } from '../../src/supervisor/work';

const baseState = (): RetryState => ({
  count: 0,
  errors: [],
  lastLaunchTime: 0,
  consecutiveFastFails: 0,
});

describe('makeRetryStatusHandler', () => {
  let dir: string;
  let status: SupervisorStatus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-retry-status-'));
    status = {
      phase: 'work',
      task_id: 'abc12345',
      command_type: 'start',
      started_at: '2026-07-27T10:00:00.000Z',
      updated_at: '2026-07-27T10:00:00.000Z',
      phase_started_at: '2026-07-27T10:00:00.000Z',
      pid: 1234,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('projects attempt count, error log, and failure class into status.json', () => {
    const handler = makeRetryStatusHandler(status, dir);
    handler({
      ...baseState(),
      count: 3,
      failureClass: 'transient_overload',
      failureReason: 'API returned 529',
      nextDelayMs: 30_000,
      errors: [
        {
          message: 'API Error: 529 overloaded',
          count: 3,
          firstSeen: '2026-07-27T10:00:00.000Z',
          lastSeen: '2026-07-27T10:01:00.000Z',
        },
      ],
    });

    const written = readStatus(dir);
    expect(written?.phase).toBe('retrying');
    expect(written?.retryCount).toBe(3);
    expect(written?.retry_failure_class).toBe('transient_overload');
    expect(written?.retry_next_delay_ms).toBe(30_000);
    expect(written?.errors?.[0].message).toBe('API Error: 529 overloaded');
  });

  // INVARIANT: readers poll status.json. If clearing retry state only mutated
  // the in-memory object, `lazy watch`/`list`/MCP would keep showing a stale
  // "retrying attempt N" until the next unrelated phase transition wrote the
  // file — exactly the confusion this surface exists to remove.
  test('clearing retry state restores the entry phase and persists it', () => {
    const handler = makeRetryStatusHandler(status, dir);
    handler({ ...baseState(), count: 2, errors: [] });
    expect(readStatus(dir)?.phase).toBe('retrying');

    handler(null);

    const written = readStatus(dir);
    expect(written?.phase).toBe('work');
    expect(written?.retryCount).toBeUndefined();
    expect(written?.errors).toBeUndefined();
    expect(written?.retry_failure_class).toBeUndefined();
    expect(written?.retry_next_delay_ms).toBeUndefined();
  });
});
