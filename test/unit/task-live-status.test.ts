/**
 * Unit tests for the task-page live-status token contract.
 *
 * INVARIANT: the token changes when any load-bearing header field changes
 * (status, display status/outcome, progress line, turn count, last activity)
 * and is stable when none of them do — so the poller can no-op cheaply.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildLiveStatusToken,
  buildLiveStatusPayload,
  taskLiveStatusScript,
} from '../../src/server/task-live-status';
import type { Task, Session } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'live-status-demo',
    goal: 'Demo',
    prompt: 'Do it',
    type: 'task',
    status: 'working',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agent_id: 'claude',
    runner_type: null,
    started_at: 1000,
    ended_at: null,
    outcome: null,
    git_branch: 'lazy/live-status-demo',
    git_start_sha: 'abc',
    agent_session_id: null,
    last_interaction_at: 1000,
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    container_agent_id: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
    user_stopped: false,
    upstream_merge_sha: null,
    ...overrides,
  };
}

describe('task live-status token', () => {
  test('identical inputs produce the same token', () => {
    const task = makeTask();
    const session = makeSession();
    const a = buildLiveStatusToken({ task, session, turns: 2, progress: null });
    const b = buildLiveStatusToken({ task, session, turns: 2, progress: null });
    expect(a).toBe(b);
  });

  test('status change flips the token', () => {
    const session = makeSession();
    const working = buildLiveStatusToken({
      task: makeTask({ status: 'working' }),
      session,
      turns: 1,
    });
    const blocked = buildLiveStatusToken({
      task: makeTask({ status: 'blocked' }),
      session,
      turns: 1,
    });
    expect(working).not.toBe(blocked);
  });

  test('session outcome (display status) flips the token without a task.status change', () => {
    const task = makeTask({ status: 'working' });
    const open = buildLiveStatusToken({
      task,
      session: makeSession({ outcome: null }),
      turns: 1,
    });
    const ended = buildLiveStatusToken({
      task,
      session: makeSession({ outcome: 'accepted', ended_at: 2000 }),
      turns: 1,
    });
    expect(open).not.toBe(ended);
  });

  test('progress line change flips the token', () => {
    const task = makeTask();
    const session = makeSession();
    const none = buildLiveStatusToken({ task, session, turns: 1, progress: null });
    const line = buildLiveStatusToken({
      task,
      session,
      turns: 1,
      progress: { message: 'running migration 3/7', recordedAt: '2026-09-10T12:00:00.000Z' },
    });
    const next = buildLiveStatusToken({
      task,
      session,
      turns: 1,
      progress: { message: 'running migration 4/7', recordedAt: '2026-09-10T12:01:00.000Z' },
    });
    expect(none).not.toBe(line);
    expect(line).not.toBe(next);
  });

  test('turn count or last activity flip the token', () => {
    const task = makeTask();
    const base = buildLiveStatusToken({
      task,
      session: makeSession({ last_interaction_at: 1000 }),
      turns: 1,
    });
    const moreTurns = buildLiveStatusToken({
      task,
      session: makeSession({ last_interaction_at: 1000 }),
      turns: 2,
    });
    const later = buildLiveStatusToken({
      task,
      session: makeSession({ last_interaction_at: 2000 }),
      turns: 1,
    });
    expect(base).not.toBe(moreTurns);
    expect(base).not.toBe(later);
  });

  test('payload carries token and load-bearing fields', () => {
    const task = makeTask({ status: 'blocked' });
    const session = makeSession({ outcome: null, last_interaction_at: 42 });
    const payload = buildLiveStatusPayload({
      task,
      session,
      turns: 3,
      progress: { message: 'almost', recordedAt: 't' },
    });
    expect(payload.token).toBe(
      buildLiveStatusToken({
        task,
        session,
        turns: 3,
        progress: { message: 'almost', recordedAt: 't' },
      }),
    );
    expect(payload.status).toBe('blocked');
    expect(payload.display_status).toBe('blocked');
    expect(payload.turns).toBe(3);
    expect(payload.last_active_at).toBe(42);
    expect(payload.progress).toEqual({ message: 'almost', recorded_at: 't' });
  });
});

describe('task live-status client script', () => {
  test('polls live-status and fetches chrome fragments, never meta-refresh', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('/live-status');
    expect(script).toContain("chrome', '1'");
    expect(script).toContain('fragment');
    expect(script).not.toContain('http-equiv');
    // Must preserve an open Watch panel across header swap.
    expect(script).toContain('is-open');
    expect(script).toContain('lzWireWatch');
  });

  // INVARIANT: the island knows nothing about which tabs exist — it reads each
  // tab's regions and policy off `data-lz-tab-regions` / `data-lz-tab-policy`.
  // It used to carry a hardcoded `/(shell|verify)$/` for the tabs it must not
  // tear down; that rule now lives in TASK_TAB_POLICY (asserted in
  // task-live-regions.test.ts), so a new tab registers without editing this
  // script. Naming tabs in here again would reintroduce the coupling.
  test('reads the per-tab policy from the DOM, never a hardcoded tab list', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('data-lz-tab-regions');
    expect(script).toContain('data-lz-tab-policy');
    expect(script).not.toContain('shell|verify');
  });

  // INVARIANT: nothing is deleted-and-refetched. The old island removed every
  // cached tab body on any change, which yanked a reader out of Changes
  // because an unrelated subtask was accepted.
  test('marks hidden bodies stale instead of removing them', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('data-lz-stale');
    expect(script).toContain('lzMorph');
    expect(script).not.toContain('bustNonTerminalBodies');
  });

  // INVARIANT: an in-place update never lands on a region the reader is
  // working in — a refresh that clears a half-typed comment is a bug.
  test('guards on focus, selection and recent scroll', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('activeElement');
    expect(script).toContain('isCollapsed');
    expect(script).toContain('SCROLL_QUIET_MS');
    expect(script).toContain('visibilitychange');
  });

  // A `pill` tab is never swapped under the reader, and asking the server for
  // its body would put a full diff render on a 3s background poll.
  test('asks for header+strip only when the visible body will not be used', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain("'body', '0'");
    expect(script).toContain('Changes updated — reload');
  });

  // INVARIANT: a tab is recorded as current ONLY where the body was patched.
  // The behaviour is driven end-to-end in task-live-staleness.test.ts; this
  // pins that both halves of the rule exist in the shipped text, so neither
  // can be dropped by an edit that only reads well.
  test('marks the tab fresh and stale through one function each', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('function markCurrentFresh()');
    expect(script).toContain('function markCurrentStale()');
  });

  // INVARIANT: the morph overwrites markup other islands decorated, so their
  // idempotent re-scan hooks run afterwards or the affordances stay gone.
  test('re-runs the review island hooks after a morph', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('lzAnnotateProse');
    expect(script).toContain('lzRefreshViewable');
    expect(script).toContain('lzRefreshStickyTop');
  });

  // INVARIANT: a body-less render never DROPS a badge — an absent badge reads
  // as "none", which is worse than a stale number.
  test('carries a badge the incoming strip does not have', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain('function carryBadgesForward(');
    expect(script).toContain('lz-tab-badge');
  });
});
