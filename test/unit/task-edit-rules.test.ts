import { describe, test, expect } from 'bun:test';
import { taskEditability, lockedFieldsReason } from '../../src/task-edit-rules';

/**
 * The predicate the daemon enforces and the web edit form renders from.
 *
 * INVARIANT: there is ONE answer to "what may still be edited on this task".
 * The daemon's editTask() and the web form both call these functions, so a form
 * can never offer a field the daemon would then refuse — which is the whole
 * point of the web surface (a refusal shown as a raw RPC error is the failure).
 */
describe('task edit rules', () => {
  test('a task with no turns is fully editable', () => {
    const e = taskEditability('backlog', 0);
    expect(e.started).toBe(false);
    expect(e.canEditLockedFields).toBe(true);
    expect(e.canEditMidFlightFields).toBe(true);
    expect(lockedFieldsReason('backlog', 0)).toBeNull();
  });

  test('one turn locks goal and prompt but not the next turn’s settings', () => {
    const e = taskEditability('blocked', 1);
    expect(e.started).toBe(true);
    expect(e.canEditLockedFields).toBe(false);
    expect(e.canEditMidFlightFields).toBe(true);

    const reason = lockedFieldsReason('blocked', 1);
    // Says WHY, and says what is still possible — a refusal that only closes
    // doors leaves the human nowhere to go.
    expect(reason).toContain('1 turn');
    expect(reason).toContain('goal and prompt are locked');
    expect(reason).toContain('model, effort and agent');
  });

  test('the turn count is pluralised', () => {
    expect(lockedFieldsReason('working', 3)).toContain('3 turns');
  });

  test('a terminal task cannot be edited at all, and the reason names its status', () => {
    for (const status of ['complete', 'abandoned'] as const) {
      const e = taskEditability(status, 0);
      expect(e.terminal).toBe(true);
      expect(e.canEditLockedFields).toBe(false);
      expect(e.canEditMidFlightFields).toBe(false);
      expect(lockedFieldsReason(status, 0)).toContain(status);
    }
  });
});
