/**
 * The wrap-up plan rules (final-turn design §3.2, §3.3) — which steps a turn
 * runs, resolved by the DAEMON and carried on the command.
 *
 * INVARIANT (engineer, 2026-10-04): every task runs every configured
 * end-of-work step, whoever its audience is. An agent-audience plan used to
 * run only the protected-file push-back, which silently suppressed the user's
 * maintain/react rules and the leftovers commit for every cluster child and
 * agent-created subtask. Audience never decides which rules run.
 *
 * INVARIANT (§13.5): the plan rides EVERY work command and the SUPERVISOR picks
 * a list from it by how the turn ended — that discipline is asserted in the
 * supervisor tests, not here.
 */

import { describe, test, expect } from 'bun:test';
import type { Actor, Turn } from '../../src/types';
import type { WrapUpStep } from '../../src/protocol/types';
import {
  resolvePresentedSha,
  resolveWrapUpPlan,
  wrapUpPlanFor,
} from '../../src/daemon/wrap-up-plan';

function turn(role: Turn['role'], actor?: Actor): Pick<Turn, 'role' | 'actor'> {
  return { role, ...(actor ? { actor } : {}) };
}

/** Storage stub for resolveWrapUpPlan — childless by default. */
function planStorage(opts: {
  turns?: Pick<Turn, 'role' | 'actor' | 'final'>[];
  historyActor?: Actor;
  historyThrows?: boolean;
  /** Child statuses, in order. `2` is shorthand for two LANDED children. */
  children?: number | string[];
  childrenThrow?: boolean;
}) {
  return {
    getSessionTurns: async () => opts.turns ?? [],
    getStatusHistory: async () => {
      if (opts.historyThrows) throw new Error('read failed');
      return [{ status: 'backlog', timestamp: 1, actor: opts.historyActor ?? 'human' }];
    },
    getChildTasks: async () => {
      if (opts.childrenThrow) throw new Error('children unreadable');
      const statuses = typeof opts.children === 'number'
        ? new Array(opts.children).fill('complete')
        : opts.children ?? [];
      return statuses.map((status: string) => ({ status }));
    },
  } as never;
}

const FULL_PLAN: WrapUpStep[] = ['permission_pushback', 'maintain', 'react', 'commit_leftovers', 'present'];

describe('wrapUpPlanFor — one plan for every task', () => {
  test('every task gets every step, in execution order', () => {
    expect(wrapUpPlanFor().steps).toEqual(FULL_PLAN);
  });

  // INVARIANT: no step of the wrap-up asks the agent about the PROJECT. The
  // systemic check was removed (§7): it cost a full model turn on the task's
  // context at wrap-up, delayed the accept, and its findings are systemic by
  // definition — a scheduled sweep over recently accepted tasks finds them
  // just as well. Nothing may re-add a step whose output is not about THIS
  // task's diff.
  test('no plan contains a systemic step', () => {
    for (const hub of [false, true]) {
      const plan = wrapUpPlanFor({ hub });
      expect(plan.steps).not.toContain('systemic' as never);
      expect(plan.park_steps).not.toContain('systemic' as never);
    }
  });

  // INVARIANT (this task): the walkthrough is owed on EVERY human-facing park,
  // not only on a final. It exists to inform the human's accept decision, and
  // a human deciding about a needs-input task needs it exactly as much as one
  // deciding about a declared-done task. Gating it on the declaration meant the
  // human had to run a command to produce the thing that would tell them
  // whether to run the command.
  test('the park plan records protected files and presents', () => {
    expect(wrapUpPlanFor().park_steps).toEqual(['permission_pushback', 'present']);
  });

  // INVARIANT: the rest of the chain is PENCILS-DOWN work.
  test('the park plan excludes final-only work', () => {
    for (const step of ['maintain', 'react', 'commit_leftovers'] as WrapUpStep[]) {
      expect(wrapUpPlanFor().park_steps).not.toContain(step);
    }
  });

  // INVARIANT: the leftovers nudge runs BEFORE the presentation and AFTER the
  // two nudges. After, because writing a maintained file and forgetting to
  // commit it is the case it exists for; before, because a commit it produces
  // must be in the file list the walkthrough is declared over.
  test('the leftovers check sits after the nudges and before the presentation', () => {
    const steps = wrapUpPlanFor().steps;
    expect(steps.indexOf('commit_leftovers')).toBeGreaterThan(steps.indexOf('maintain'));
    expect(steps.indexOf('commit_leftovers')).toBeGreaterThan(steps.indexOf('react'));
    expect(steps.indexOf('commit_leftovers')).toBeLessThan(steps.indexOf('present'));
  });

  // INVARIANT (this task): a HUB presents by its CHILDREN, derived, with no
  // model turn — so the presentation step leaves its plan on BOTH endings.
  // Asking a model to walk a reviewer through a release hub's branch asks for a
  // walkthrough of every feature in the release, which is what hit the
  // presentation item cap outright.
  test('a hub drops the presentation from both lists', () => {
    const plan = wrapUpPlanFor({ hub: true });
    // Only the PRESENTATION is dropped: a hub's own worktree can hold loose
    // work like any other, so the leftovers check stays.
    expect(plan.steps).toEqual(['permission_pushback', 'maintain', 'react', 'commit_leftovers']);
    expect(plan.park_steps).toEqual(['permission_pushback']);
  });

  // INVARIANT: the park plan is DERIVED from the final plan, never written out
  // a second time — so "not a hub" cannot come to mean two
  // different things on the two paths.
  test('every park step is also a final step', () => {
    for (const hub of [false, true]) {
      const plan = wrapUpPlanFor({ hub });
      for (const step of plan.park_steps) expect(plan.steps).toContain(step);
    }
  });
});

describe('resolveWrapUpPlan — audience never narrows the plan', () => {
  // Each of these awaits the call and asserts on the value, rather than using
  // `expect(promise).resolves`. Not a correctness fix: bun 1.4.2 does track an
  // un-awaited `.resolves` matcher and fails the test, so the un-awaited form
  // was never silently green (an earlier version of this comment claimed it
  // was — it was wrong). The reason for this shape is that it states the
  // timing itself instead of relying on the runner to notice.
  // INVARIANT (engineer, 2026-10-04): an agent-launched task — an
  // agent-created subtask, a cluster child — gets the FULL plan: maintain,
  // react and commit_leftovers run for it exactly as for a human's task.
  test('an agent-launched task gets the full plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ turns: [turn('human', 'agent'), turn('agent')], historyActor: 'agent' }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toEqual(FULL_PLAN);
    expect(plan.park_steps).toEqual(['permission_pushback', 'present']);
  });

  // INVARIANT (engineer, 2026-10-04): a cluster's child is agent-audience
  // (that is what defers its protected files to the cluster's accept), and it
  // still runs the user's maintain rules and the leftovers commit.
  test('a cluster child gets the full plan', async () => {
    const storage = {
      ...(planStorage({ turns: [turn('human', 'agent')], historyActor: 'agent' }) as object),
      getTask: async () => ({ id: 'cluster-1', type: 'cluster', status: 'working' }),
    } as never;
    const plan = await resolveWrapUpPlan(
      storage,
      { id: 'task-1', type: 'task', parent_id: 'cluster-1' } as never,
      'sess-1',
    );
    expect(plan.steps).toContain('maintain');
    expect(plan.steps).toContain('commit_leftovers');
    expect(plan.steps).toEqual(FULL_PLAN);
  });

  test('a human-launched recent turn yields the full plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ turns: [turn('human', 'human')], historyActor: 'human' }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toEqual(FULL_PLAN);
    expect(plan.park_steps).toEqual(['permission_pushback', 'present']);
  });

  test('a failing status history still resolves to the full plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ historyThrows: true }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toEqual(FULL_PLAN);
  });

  // INVARIANT: unreadable children degrade to "not a hub" — the direction that
  // asks for a walkthrough that may be redundant, never one that is missing.
  test('unreadable children degrade to a non-hub plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ childrenThrow: true }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.park_steps).toEqual(['permission_pushback', 'present']);
  });

  test('a task with landed children resolves to the hub plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ children: 2 }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).not.toContain('present');
    expect(plan.park_steps).toEqual(['permission_pushback']);
  });

  // INVARIANT (review 36b9c014): a child still IN FLIGHT does not move the
  // plan. Until child work is on the branch the task is entirely its own work,
  // and dropping the step here would freeze its walkthrough at whatever head it
  // last filed one for — an authored walkthrough outranks the derived map, so
  // the reviewer would keep being served a reading order older than the branch
  // with nothing on the surface saying so.
  test('a task whose children are all still in flight keeps presenting', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ children: ['blocked', 'working'] }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toContain('present');
    expect(plan.park_steps).toEqual(['permission_pushback', 'present']);
  });

  // INVARIANT (review ba94e310/f2c997a9): the plan and the regions loader route
  // on ONE predicate (src/task/hub.ts). A task whose only subtask was closed is
  // not a hub, so it keeps authoring the walkthrough this change promises on
  // every human-facing park — it does not silently fall back to a git carve
  // plus a note promising a child that can never land.
  test('a task whose only child was abandoned still presents its own work', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ children: ['abandoned'] }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toContain('present');
    expect(plan.park_steps).toEqual(['permission_pushback', 'present']);
  });

  // INVARIANT: the plan takes no launching actor. Re-adding one would
  // re-introduce a plan that differs between launches of the same task.
  test('resolveWrapUpPlan takes no launching-actor argument', () => {
    expect(resolveWrapUpPlan.length).toBe(3); // storage, task, sessionId
  });
});

describe('resolvePresentedSha — the regeneration key', () => {
  // INVARIANT (this task): the walkthrough is re-authored only when HEAD has
  // moved past the one on record. A task that parks three times for decisions
  // pays for ONE walkthrough, which is what makes presenting on every park
  // affordable.
  const report = (over: Record<string, unknown>) => ({
    id: 'r', task_id: 't', session_id: 's', sections: [], created_at: 1, ...over,
  });

  test('the newest report carrying a presentation decides', async () => {
    const sha = await resolvePresentedSha({
      getTaskTurnReports: async () => [
        report({ created_at: 1, presentation: { groups: [] }, presentation_head_sha: 'old' }),
        report({ created_at: 2, presentation: { groups: [] }, presentation_head_sha: 'new' }),
      ],
    } as never, 't');
    expect(sha).toBe('new');
  });

  test('a report with no presentation is not the answer, however new', async () => {
    const sha = await resolvePresentedSha({
      getTaskTurnReports: async () => [
        report({ created_at: 1, presentation: { groups: [] }, presentation_head_sha: 'old' }),
        report({ created_at: 5 }),
      ],
    } as never, 't');
    expect(sha).toBe('old');
  });

  // A report written before the stamp existed reads as "unknown", which makes
  // the step run — spending one step is the right failure.
  test('an unstamped presentation resolves to undefined', async () => {
    const sha = await resolvePresentedSha({
      getTaskTurnReports: async () => [report({ presentation: { groups: [] } })],
    } as never, 't');
    expect(sha).toBeUndefined();
  });

  test('an unreadable report store resolves to undefined rather than throwing', async () => {
    const sha = await resolvePresentedSha({
      getTaskTurnReports: async () => { throw new Error('nope'); },
    } as never, 't');
    expect(sha).toBeUndefined();
  });
});
