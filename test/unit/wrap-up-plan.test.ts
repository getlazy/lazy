/**
 * The wrap-up plan rules (final-turn design §3.2, §3.3) — which steps a turn
 * runs, resolved by the DAEMON from the task's audience and how the turn ended.
 *
 * INVARIANT (§13.3): the audience comes from `audienceOf` and nothing else —
 * `FinalClaim.wrap_up_steps` is an audit record and is never read back as the
 * plan. These tests pin the audience→steps mapping and the resolution inputs,
 * because a wrong plan here either bills an agent child for a presentation
 * nobody reads or skips the reader-facing work a person was promised.
 *
 * INVARIANT (§13.5): the plan rides EVERY work command and the SUPERVISOR picks
 * a list from it by how the turn ended — that discipline is asserted in the
 * supervisor tests, not here. What is pinned here is that both lists are
 * present and that they never change shape between launches for the same
 * audience.
 */

import { describe, test, expect } from 'bun:test';
import type { Actor, Turn } from '../../src/types';
import type { WrapUpStep } from '../../src/protocol/types';
import { audienceOf } from '../../src/task/audience';
import {
  resolvePresentedSha,
  resolveWrapUpPlan,
  resolveWrapUpCommandFields,
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

describe('wrapUpPlanFor — audience to steps', () => {
  test('a human-audience task gets every step, in execution order', () => {
    expect(wrapUpPlanFor('human').steps).toEqual(FULL_PLAN);
  });

  // INVARIANT: no step of the wrap-up asks the agent about the PROJECT. The
  // systemic check was removed (§7): it cost a full model turn on the task's
  // context at wrap-up, delayed the accept, and its findings are systemic by
  // definition — a scheduled sweep over recently accepted tasks finds them
  // just as well. Nothing may re-add a step whose output is not about THIS
  // task's diff.
  test('no plan contains a systemic step', () => {
    for (const audience of ['human', 'agent'] as const) {
      const plan = wrapUpPlanFor(audience);
      expect(plan.steps).not.toContain('systemic' as never);
      expect(plan.park_steps).not.toContain('systemic' as never);
    }
  });

  test('an agent-audience task skips every reader-facing step', () => {
    // Nobody opens the result, so present/react never run; pushback and
    // Agent-audience tasks still record protected-file decisions even though
    // they skip reader-facing maintenance and presentation work.
    expect(wrapUpPlanFor('agent').steps).toEqual(['permission_pushback']);
  });

  // INVARIANT (this task): the walkthrough is owed on EVERY human-facing park,
  // not only on a final. It exists to inform the human's accept decision, and
  // a human deciding about a needs-input task needs it exactly as much as one
  // deciding about a declared-done task. Gating it on the declaration meant the
  // human had to run a command to produce the thing that would tell them
  // whether to run the command.
  test('the park plan records protected files and presents for a human audience', () => {
    expect(wrapUpPlanFor('human').park_steps).toEqual(['permission_pushback', 'present']);
  });

  // INVARIANT: the rest of the chain is PENCILS-DOWN work.
  test('the park plan excludes final-only work', () => {
    for (const step of ['maintain', 'react', 'commit_leftovers'] as WrapUpStep[]) {
      expect(wrapUpPlanFor('human').park_steps).not.toContain(step);
    }
  });

  // INVARIANT: the leftovers nudge runs BEFORE the presentation and AFTER the
  // two nudges. After, because writing a maintained file and forgetting to
  // commit it is the case it exists for; before, because a commit it produces
  // must be in the file list the walkthrough is declared over.
  test('the leftovers check sits after the nudges and before the presentation', () => {
    const steps = wrapUpPlanFor('human').steps;
    expect(steps.indexOf('commit_leftovers')).toBeGreaterThan(steps.indexOf('maintain'));
    expect(steps.indexOf('commit_leftovers')).toBeGreaterThan(steps.indexOf('react'));
    expect(steps.indexOf('commit_leftovers')).toBeLessThan(steps.indexOf('present'));
  });

  test('an agent-audience task records permissions but does not present', () => {
    expect(wrapUpPlanFor('agent').park_steps).toEqual(['permission_pushback']);
  });

  // INVARIANT (this task): a HUB presents by its CHILDREN, derived, with no
  // model turn — so the presentation step leaves its plan on BOTH endings.
  // Asking a model to walk a reviewer through a release hub's branch asks for a
  // walkthrough of every feature in the release, which is what hit the
  // presentation item cap outright.
  test('a hub drops the presentation from both lists', () => {
    const plan = wrapUpPlanFor('human', { hub: true });
    // Only the PRESENTATION is dropped: a hub's own worktree can hold loose
    // work like any other, so the leftovers check stays.
    expect(plan.steps).toEqual(['permission_pushback', 'maintain', 'react', 'commit_leftovers']);
    expect(plan.park_steps).toEqual(['permission_pushback']);
  });

  // INVARIANT: the park plan is DERIVED from the final plan, never written out
  // a second time — so "human audience, not a hub" cannot come to mean two
  // different things on the two paths.
  test('every park step is also a final step', () => {
    for (const audience of ['human', 'agent'] as const) {
      for (const hub of [false, true]) {
        const plan = wrapUpPlanFor(audience, { hub });
        for (const step of plan.park_steps) expect(plan.steps).toContain(step);
      }
    }
  });
});

describe('resolveWrapUpPlan — audienceOf feeds the plan', () => {
  // Each of these awaits the call and asserts on the value, rather than using
  // `expect(promise).resolves`. Not a correctness fix: bun 1.4.2 does track an
  // un-awaited `.resolves` matcher and fails the test, so the un-awaited form
  // was never silently green (an earlier version of this comment claimed it
  // was — it was wrong). The reason for this shape is that it states the
  // timing itself instead of relying on the runner to notice.
  test('an agent-launched recent turn yields the agent plan', async () => {
    const plan = await resolveWrapUpPlan(
      planStorage({ turns: [turn('human', 'agent'), turn('agent')], historyActor: 'agent' }),
      { id: 'task-1', type: 'task' } as never,
      'sess-1',
    );
    expect(plan.steps).toEqual(['permission_pushback']);
    expect(plan.park_steps).toEqual(['permission_pushback']);
  });


  // INVARIANT: a start resolves its plan BEFORE recording turn 1 (so a failed
  // setup step never leaves the task working), and the launching actor it
  // passes decides the audience exactly as the recorded turn would — the
  // task's CREATOR must not. An agent-created child a human starts is a
  // human-audience task, and the reverse.
  test('a pending launch actor wins over the creator', async () => {
    const fields = (historyActor: 'agent' | 'human', pendingLaunchActor: 'agent' | 'human') =>
      resolveWrapUpCommandFields({
        storage: { ...(planStorage({ turns: [], historyActor }) as object), getTaskTurnReports: async () => [] } as never,
        task: { id: 'task-1', type: 'task' } as never,
        sessionId: 'sess-1',
        session: { upstream_merge_sha: null } as never,
        projectRoot: '/nonexistent',
        worktreePath: '/nonexistent',
        config: {} as never,
        pendingLaunchActor,
      });
    expect((await fields('agent', 'human')).wrap_up?.steps).toEqual(FULL_PLAN);
    expect((await fields('human', 'agent')).wrap_up?.steps).toEqual(['permission_pushback']);
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

  test('a failing status history still resolves — audience falls back to its safe default', async () => {
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

  // INVARIANT: the plan depends on the AUDIENCE and nothing else. It used to
  // take a launching actor too, because the systemic step re-armed on a new
  // brief; with that step gone the parameter is gone, and re-adding one would
  // re-introduce a plan that differs between launches of the same task.
  //
  // Asserted on the SIGNATURE rather than by calling twice: with no actor to
  // vary, two identical calls cannot disagree, so that version of this test
  // could never have failed.
  test('resolveWrapUpPlan takes no launching-actor argument', () => {
    expect(resolveWrapUpPlan.length).toBe(3); // storage, task, sessionId
  });

  test('the plan is re-derived from the CURRENT launching actor, never cached', () => {
    // A task a loop started but a human later picked up: the latest turn
    // decides, per §13.3, so the wrap-up must include the reader-facing work.
    expect(audienceOf({
      turns: [turn('human', 'agent'), turn('agent'), turn('human', 'builder')],
    })).toBe('human');
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
