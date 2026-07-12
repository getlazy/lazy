import { describe, test, expect } from 'bun:test';
import {
  deriveWorkingSubstate,
  formatWorkingSubstate,
  renderWorkingStatus,
} from '../../src/utils/working-substate';
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

describe('deriveWorkingSubstate', () => {
  // INVARIANT: phase work/work_done means the agent is the active thing.
  test('alive + work phase → agent', () => {
    const s = deriveWorkingSubstate(baseStatus, { isAlive: true, hasResponse: false });
    expect(s).toEqual({ kind: 'agent' });
  });

  test('alive + work_done phase → agent', () => {
    const s = deriveWorkingSubstate(
      { ...baseStatus, phase: 'work_done' },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toEqual({ kind: 'agent' });
  });

  // INVARIANT: ask turns during agent phases are a distinct answering substate —
  // the agent is drafting a response, not executing task work.
  test('alive + work phase with command_type=ask → agent:answering', () => {
    const s = deriveWorkingSubstate(
      { ...baseStatus, command_type: 'ask' },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toEqual({ kind: 'agent', answering: true });
  });

  test('alive + work_done phase with command_type=ask → agent:answering', () => {
    const s = deriveWorkingSubstate(
      { ...baseStatus, phase: 'work_done', command_type: 'ask' },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toEqual({ kind: 'agent', answering: true });
  });

  // non-ask command_type during agent phases stays plain agent.
  test('alive + work phase with command_type=start → agent (not answering)', () => {
    const s = deriveWorkingSubstate(
      { ...baseStatus, command_type: 'start' },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toEqual({ kind: 'agent' });
  });

  // INVARIANT: any non-work phase while alive is supervisor (harness) work.
  test('alive + post_turn_check phase → harness with phase + command', () => {
    const s = deriveWorkingSubstate(
      {
        ...baseStatus,
        phase: 'post_turn_check',
        phase_started_at: '2026-05-17T10:00:00.000Z',
        current_command: 'cargo build',
        current_command_started_at: '2026-05-17T10:01:00.000Z',
      },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toEqual({
      kind: 'harness',
      phase: 'post_turn_check',
      phaseStartedAt: '2026-05-17T10:00:00.000Z',
      currentCommand: 'cargo build',
      currentCommandStartedAt: '2026-05-17T10:01:00.000Z',
    });
  });

  test('harness phaseStartedAt falls back to updated_at then started_at', () => {
    const s = deriveWorkingSubstate(
      { ...baseStatus, phase: 'merge_and_fix', phase_started_at: undefined, updated_at: '2026-05-17T10:05:00.000Z' },
      { isAlive: true, hasResponse: false },
    );
    expect(s).toMatchObject({ kind: 'harness', phase: 'merge_and_fix', phaseStartedAt: '2026-05-17T10:05:00.000Z' });
  });

  // INVARIANT: not-alive is reserved for genuine stranded-completion candidates —
  // no live run AND no response present.
  test('not alive + no response → not-alive', () => {
    const s = deriveWorkingSubstate(baseStatus, { isAlive: false, hasResponse: false });
    expect(s).toEqual({ kind: 'not-alive' });
  });

  test('not alive + no response + no status → not-alive', () => {
    const s = deriveWorkingSubstate(null, { isAlive: false, hasResponse: false });
    expect(s).toEqual({ kind: 'not-alive' });
  });

  // INVARIANT: a present response means the turn finished and reconcile is
  // imminent — NOT a stranded task. Degrade to no substate, never not-alive.
  test('not alive + response present → null (finishing, not stranded)', () => {
    const s = deriveWorkingSubstate(baseStatus, { isAlive: false, hasResponse: true });
    expect(s).toBeNull();
  });

  // Alive but no checkpoint yet (container starting) — degrade to no substate.
  test('alive + no status → null', () => {
    const s = deriveWorkingSubstate(null, { isAlive: true, hasResponse: false });
    expect(s).toBeNull();
  });
});

describe('formatWorkingSubstate', () => {
  const now = new Date('2026-05-17T10:03:00.000Z');

  test('agent', () => {
    expect(formatWorkingSubstate({ kind: 'agent' }, now)).toBe('agent');
  });

  // INVARIANT: answering substate formats with the agent:answering label.
  test('agent:answering', () => {
    expect(formatWorkingSubstate({ kind: 'agent', answering: true }, now)).toBe('agent:answering');
  });

  test('not-alive', () => {
    expect(formatWorkingSubstate({ kind: 'not-alive' }, now)).toBe('not-alive');
  });

  test('harness with phase + elapsed', () => {
    expect(
      formatWorkingSubstate(
        { kind: 'harness', phase: 'post_turn_check', phaseStartedAt: '2026-05-17T10:00:00.000Z' },
        now,
      ),
    ).toBe('harness:post_turn_check (3m00s)');
  });

  test('harness with current command', () => {
    expect(
      formatWorkingSubstate(
        {
          kind: 'harness',
          phase: 'post_turn_check',
          phaseStartedAt: '2026-05-17T10:00:00.000Z',
          currentCommand: 'cargo build',
        },
        now,
      ),
    ).toBe('harness:post_turn_check cargo build (3m00s)');
  });

  test('harness without a parseable timestamp omits elapsed', () => {
    expect(
      formatWorkingSubstate({ kind: 'harness', phase: 'writing_response' }, now),
    ).toBe('harness:writing_response');
  });
});

describe('renderWorkingStatus', () => {
  const now = new Date('2026-05-17T10:03:00.000Z');

  test('wraps the substate in working(...)', () => {
    expect(renderWorkingStatus({ kind: 'agent' }, now)).toBe('working(agent)');
    expect(renderWorkingStatus({ kind: 'agent', answering: true }, now)).toBe('working(agent:answering)');
    expect(renderWorkingStatus({ kind: 'not-alive' }, now)).toBe('working(not-alive)');
  });

  test('null substate → plain working', () => {
    expect(renderWorkingStatus(null, now)).toBe('working');
    expect(renderWorkingStatus(undefined, now)).toBe('working');
  });
});
