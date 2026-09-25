/**
 * Which runner a previous daemon's claimed run is stopped on
 * (`previousGenerationRunnerType`, src/utils/reconcile.ts).
 *
 * INVARIANT: an unstamped ask/review claim is probed and stopped on the runner
 * its launch was BUILT from — ask and review both create theirs from
 * `task.runner_type` (src/daemon/task-lifecycle.ts) — never the session's
 * recorded runner when a per-task override makes them differ. The session
 * records the last WORK turn's runner; probing a reviewer there reads "not
 * running", so the claim was abandoned while the reviewer — pointed at the dead
 * daemon's proxy — was left alive, which is the run this path exists to stop.
 */

import { describe, test, expect } from 'bun:test';
import { previousGenerationRunnerType } from '../../src/utils/reconcile';

const HOST = 'dangerously-host-process-without-any-isolation' as const;

describe('previousGenerationRunnerType', () => {
  test('an unstamped review claim on a task whose runner override differs from the session stops on the TASK runner', () => {
    expect(previousGenerationRunnerType({}, { runner_type: HOST }, { runner_type: 'docker' })).toBe(HOST);
  });

  test('a stamped claim names its own runner, whatever the task and session say', () => {
    expect(previousGenerationRunnerType({ runner_type: 'podman' }, { runner_type: HOST }, { runner_type: 'docker' })).toBe('podman');
  });

  test('no claim runner and no task override: the session runner, else the project default', () => {
    expect(previousGenerationRunnerType({}, { runner_type: null }, { runner_type: 'docker' })).toBe('docker');
    expect(previousGenerationRunnerType({}, { runner_type: null }, { runner_type: null })).toBeUndefined();
  });
});
