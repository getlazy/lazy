import { describe, test, expect } from 'bun:test';
import { renderStatusHeader } from '../../src/cli/status-header';
import type { SupervisorStatus } from '../../src/protocol/types';

const baseStatus: SupervisorStatus = {
  phase: 'work',
  task_id: 'abc12345',
  command_type: 'start',
  started_at: '2026-05-17T10:00:00.000Z',
  updated_at: '2026-05-17T10:00:00.000Z',
  phase_started_at: '2026-05-17T10:00:00.000Z',
  pid: 1234,
};

describe('renderStatusHeader', () => {
  test('returns "no status" when status is null', () => {
    expect(renderStatusHeader(null, new Date('2026-05-17T10:00:00Z'))).toBe(
      'Supervisor: no status',
    );
  });

  test('formats seconds only when under a minute', () => {
    const now = new Date('2026-05-17T10:00:45.000Z');
    expect(renderStatusHeader(baseStatus, now)).toBe(
      'Supervisor: phase=work (45s)',
    );
  });

  test('formats minutes and seconds', () => {
    const now = new Date('2026-05-17T10:23:12.000Z');
    expect(renderStatusHeader(baseStatus, now)).toBe(
      'Supervisor: phase=work (23m12s)',
    );
  });

  test('formats hours, minutes, and zero-padded seconds', () => {
    const now = new Date('2026-05-17T11:05:03.000Z');
    expect(renderStatusHeader(baseStatus, now)).toBe(
      'Supervisor: phase=work (1h05m03s)',
    );
  });

  test('falls back to updated_at when phase_started_at is missing', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      phase: 'post_turn_check',
      phase_started_at: undefined,
      updated_at: '2026-05-17T10:00:00.000Z',
    };
    const now = new Date('2026-05-17T10:00:30.000Z');
    expect(renderStatusHeader(status, now)).toBe(
      'Supervisor: phase=post_turn_check (30s)',
    );
  });

  test('appends "running" half with elapsed when current_command is set', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      phase: 'post_turn_check',
      phase_started_at: '2026-05-17T10:00:00.000Z',
      current_command: 'cargo build',
      current_command_started_at: '2026-05-17T10:00:00.000Z',
    };
    const now = new Date('2026-05-17T10:23:12.000Z');
    expect(renderStatusHeader(status, now)).toBe(
      'Supervisor: phase=post_turn_check (23m12s), running: cargo build (23m12s)',
    );
  });

  test('omits "running" half entirely when current_command is null/undefined', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      current_command: undefined,
      current_command_started_at: undefined,
    };
    const now = new Date('2026-05-17T10:00:10.000Z');
    expect(renderStatusHeader(status, now)).toBe('Supervisor: phase=work (10s)');
  });

  test('renders "running: <cmd>" with no elapsed when current_command_started_at is missing', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      current_command: 'cargo build',
      current_command_started_at: undefined,
    };
    const now = new Date('2026-05-17T10:00:10.000Z');
    expect(renderStatusHeader(status, now)).toBe(
      'Supervisor: phase=work (10s), running: cargo build',
    );
  });

  // INVARIANT: `phase=retrying` on its own tells a human nothing — the header
  // repeats every 5s in `lazy watch` while only the elapsed counter moves. It
  // must carry the attempt count and the latest error.
  test('retrying phase carries attempt count, failure class, and latest error', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      phase: 'retrying',
      retryCount: 7,
      retry_failure_class: 'transient_overload',
      errors: [
        {
          message: 'API Error: 529 overloaded',
          count: 7,
          firstSeen: '2026-05-17T10:00:00.000Z',
          lastSeen: '2026-05-17T10:00:40.000Z',
        },
      ],
    };
    const now = new Date('2026-05-17T10:00:47.000Z');
    expect(renderStatusHeader(status, now)).toBe(
      'Supervisor: phase=retrying attempt 7 (transient_overload): API Error: 529 overloaded (47s)',
    );
  });

  test('retrying phase with no error recorded still reports the attempt', () => {
    const status: SupervisorStatus = { ...baseStatus, phase: 'retrying', retryCount: 1 };
    const now = new Date('2026-05-17T10:00:05.000Z');
    expect(renderStatusHeader(status, now)).toBe('Supervisor: phase=retrying attempt 1 (5s)');
  });

  // Retry fields linger in memory until the next phase write; a non-retrying
  // phase must never be decorated with a stale attempt count.
  test('non-retrying phase never renders retry details', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      phase: 'post_turn_check',
      retryCount: 3,
      errors: [
        {
          message: 'stale',
          count: 3,
          firstSeen: '2026-05-17T10:00:00.000Z',
          lastSeen: '2026-05-17T10:00:00.000Z',
        },
      ],
    };
    const now = new Date('2026-05-17T10:00:10.000Z');
    expect(renderStatusHeader(status, now)).toBe('Supervisor: phase=post_turn_check (10s)');
  });

  test('clamps negative elapsed (clock skew) to zero', () => {
    const status: SupervisorStatus = {
      ...baseStatus,
      phase_started_at: '2026-05-17T10:01:00.000Z',
    };
    const now = new Date('2026-05-17T10:00:00.000Z');
    expect(renderStatusHeader(status, now)).toBe(
      'Supervisor: phase=work (0s)',
    );
  });
});
