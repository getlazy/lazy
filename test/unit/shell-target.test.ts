import { describe, test, expect } from 'bun:test';
import { execContainerName } from '../../src/server/shell-ws';
import type { Task, Session } from '../../src/types';

/**
 * INVARIANT: the web shell can only ever exec into the TASK'S OWN container.
 *
 * The exec target is decided by execContainerName, which takes only the task,
 * its session, and the runner — there is NO client-supplied container input
 * anywhere in the resolution. A browser passes cols/rows and nothing else, so it
 * can never steer the exec at the host or another task's container. These tests
 * pin that the derivation reads only task/session state, exactly as
 * `lazy shell --container` derives it.
 */
describe('execContainerName (web-shell exec target)', () => {
  const task = {
    id: 'task-1234567890',
    metadata: { task_ref: 'add-web-shell' },
  } as unknown as Task;

  // A stand-in runner: only runNameForTask is consulted, matching the
  // Pick<Runner, 'runNameForTask'> the helper accepts.
  const runner = {
    runNameForTask: (ref: string) => `lazy-run-${ref}`,
  };

  test('uses the session container_name when the session recorded one', () => {
    const session = { container_name: 'lazy-run-add-web-shell-live' } as unknown as Session;
    expect(execContainerName(task, session, runner)).toBe('lazy-run-add-web-shell-live');
  });

  test('derives the name from the task ref when the session has none', () => {
    const session = { container_name: null } as unknown as Session;
    // Derived via runner.runNameForTask(taskRef(task)) — taskRef prefers the
    // stored task_ref, so this is the task's own run name and nothing else.
    expect(execContainerName(task, session, runner)).toBe('lazy-run-add-web-shell');
  });

  test('the derived name comes only from the task ref, never from any other input', () => {
    // Two tasks with different refs must map to different container names —
    // there is no shared or client-influenced component.
    const other = { id: 'task-9999', metadata: { task_ref: 'other-task' } } as unknown as Task;
    const noSession = { container_name: null } as unknown as Session;
    expect(execContainerName(task, noSession, runner)).not.toBe(
      execContainerName(other, noSession, runner),
    );
    expect(execContainerName(other, noSession, runner)).toBe('lazy-run-other-task');
  });
});
