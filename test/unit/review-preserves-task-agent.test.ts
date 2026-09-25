/**
 * Guard: `lazy review` must not rewrite the task's agent OR restamp the work
 * container.
 *
 * INVARIANT: a review is a one-off read of the task's work on an EPHEMERAL
 * container (`lazy-review-<taskRef>`), same worktree mount. It uses
 * resolveOneOffTurnIdentity (read-only), stamps turns with task.agent_id, and
 * must never:
 *   - call updateTaskAgent / switchTaskAgent
 *   - call updateSessionContainerName (would point the session at the review
 *     run or clear/restamp container_agent_id)
 *   - call removeTaskRun (clears session.container_* for the work container)
 *   - launch via runner.runNameForTask (the work agent's name)
 *   - write the review command into protocolDir (the work mailbox) — see
 *     review-protocol-isolation.test.ts for the dedicated mailbox pin
 *
 * Sharing the work container is what made review look like it "switched the
 * task to Claude": removeTaskRun cleared the stamp, or a reused container kept
 * the wrong harness env after an agent switch. Sharing the work protocol
 * mailbox let the idle work supervisor consume the review command before the
 * ephemeral review container started.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { reviewContainerNameForTask, containerNameForTask } from '../../src/capture/claude';

const LIFECYCLE = join(import.meta.dir, '../../src/daemon/task-lifecycle.ts');
const LAUNCH_IDENTITY = join(import.meta.dir, '../../src/daemon/launch-identity.ts');

describe('lazy review preserves task.agent_id', () => {
  test('launchReviewTaskRun uses one-off identity and never updates the task agent', async () => {
    const source = await readFile(LIFECYCLE, 'utf-8');
    const start = source.indexOf('async function launchReviewTaskRun');
    expect(start).toBeGreaterThan(-1);
    // Bound the body loosely: next top-level export/function after this one.
    const rest = source.slice(start);
    const nextFn = rest.search(/\n(?:export )?(?:async )?function |\nexport async function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

    expect(body).toContain('resolveOneOffTurnIdentity');
    expect(body).toContain('agent_id: task.agent_id');
    expect(body).not.toContain('updateTaskAgent');
    expect(body).not.toContain('switchTaskAgent');
  });

  test('resolveOneOffTurnIdentity is documented as read-only (no persist)', async () => {
    const source = await readFile(LAUNCH_IDENTITY, 'utf-8');
    expect(source).toMatch(/resolveOneOffTurnIdentity[\s\S]*?read-only|ONE-OFFS DO NOT/);
    // The persisting form must remain distinct — a merge that collapsed them
    // would make ask/review rewrite the task record.
    expect(source).toContain('resolveTurnLaunchIdentity');
    expect(source).toContain('resolveOneOffTurnIdentity');
  });

  test('launchReviewTaskRun uses an ephemeral review container, not the work run', async () => {
    const source = await readFile(LIFECYCLE, 'utf-8');
    const start = source.indexOf('async function launchReviewTaskRun');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextFn = rest.search(/\n(?:export )?(?:async )?function |\nexport async function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

    expect(body).toContain('reviewContainerNameForTask');
    expect(body).not.toContain('runNameForTask(');
    // Calls only — comments may still name the helpers.
    expect(body).not.toMatch(/await\s+storage\.updateSessionContainerName\s*\(/);
    expect(body).not.toMatch(/await\s+removeTaskRun\s*\(/);
  });

  test('reviewContainerNameForTask is distinct from the work container name', () => {
    expect(reviewContainerNameForTask('abc12345')).toBe('lazy-review-abc12345');
    expect(reviewContainerNameForTask('abc12345')).not.toBe(containerNameForTask('abc12345'));
  });
});
