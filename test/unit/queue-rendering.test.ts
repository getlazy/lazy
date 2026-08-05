/**
 * Unit test for the queued-state rendering in `lazy list` / `lazy active`.
 *
 * The pure ordering/position logic is covered in concurrency.test.ts; this
 * asserts the render wiring turns a queued node into "queued #N of M (priority)"
 * so the surface the engineer asked for actually appears.
 */

import { describe, test, expect } from 'bun:test';
import { printTaskTree, type TaskWithSession } from '../../src/cli/commands/list';
import type { Task } from '../../src/types';

function queuedNode(id: string, priority: Task['priority'], position: number, total: number): TaskWithSession {
  const task = {
    id,
    code: id,
    goal: `goal ${id}`,
    prompt: '',
    type: 'task',
    status: 'queued',
    priority,
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
    pending_sync: 0,
  } as unknown as Task;
  return { task, session: null, turnCount: 0, children: [], queuePosition: { position, total } };
}

/** Capture everything printTaskTree writes to stdout. */
function capture(fn: () => void): string {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

describe('queued task rendering', () => {
  test('shows drain position and non-default priority', () => {
    const out = capture(() => printTaskTree(queuedNode('t1', 'high', 2, 3)));
    expect(out).toContain('queued #2 of 3');
    expect(out).toContain('(high)');
  });

  test('omits the priority tag for a normal-priority queued task', () => {
    const out = capture(() => printTaskTree(queuedNode('t2', 'normal', 1, 1)));
    expect(out).toContain('queued #1 of 1');
    expect(out).not.toContain('(normal)');
  });
});
