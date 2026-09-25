/**
 * Unit tests for the effort a `low_high` work turn actually runs at.
 *
 * THE RULE (engineer, 2026-09-21, HIGH review finding): "the task's configured
 * effort must not be discarded in low_high mode. When a task's effort was
 * explicitly set ([agent] effort, --effort, the persisted per-task effort), the
 * draft runs at that effort; [review] draft_effort is the fallback only when
 * nothing was set."
 *
 * The hard part is that `resolveAndPersistEffort` pins the resolved effort on
 * EVERY task at its first launch, so `metadata.effort` alone cannot tell "the
 * human asked for medium" from "nobody said anything and medium is the built-in
 * default". `effort_explicit` is what carries that difference forward.
 */

import { describe, test, expect } from 'bun:test';
import {
  EFFORT_EXPLICIT_METADATA_KEY,
  effortWasChosen,
  pinChosenEffort,
  resolveAndPersistEffort,
  resolveAndPersistLowHighLoop,
} from '../../src/daemon/effort';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';

function task(metadata: Record<string, string> = {}, parentTaskId?: string): Task {
  return {
    id: 'task-1',
    goal: 'g',
    status: 'blocked',
    metadata,
    // The target discriminates parent-vs-branch; `parentTaskIdOf` reads it.
    target: parentTaskId
      ? { kind: 'task', parentTaskId }
      : { kind: 'branch', branch: 'main' },
  } as unknown as Task;
}

/** A storage double that records what was written, and nothing else. */
function storage(parent?: Task) {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    updateTaskMetadata: async (_id: string, key: string, value: string) => {
      writes.push([key, value]);
    },
    getTask: async () => parent ?? null,
  } as never;
}

function config(over: Partial<ResolvedConfig['review']> = {}): ResolvedConfig {
  return {
    agent: { effort: 'medium' },
    review: {
      mode: 'low_high',
      auto_fix: false,
      gate: 'auto',
      draft_effort: 'low',
      review_effort: 'xhigh',
      ...over,
    },
  } as unknown as ResolvedConfig;
}

describe('effort explicitness', () => {
  // An --effort on the command is the clearest possible act of choosing.
  test('an --effort override records the choice', async () => {
    const t = task();
    const s = storage();
    await resolveAndPersistEffort(t, 'high', 'medium', s);
    expect(t.metadata?.effort).toBe('high');
    expect(t.metadata?.[EFFORT_EXPLICIT_METADATA_KEY]).toBe('true');
  });

  // INVARIANT: a launch that pins the PROJECT DEFAULT is not a choice. This is
  // the whole reason the marker exists — without it every task looks chosen
  // from its second turn onwards, and `draft_effort` would be dead code.
  test('pinning the untouched project default is not a choice', async () => {
    const t = task();
    await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(t.metadata?.effort).toBe('medium');
    expect(t.metadata?.[EFFORT_EXPLICIT_METADATA_KEY]).toBeUndefined();
  });

  // INVARIANT: a project-wide `[agent] effort` is NOT a per-task choice. The
  // wider reading made `draft_effort` dead on every project that states an
  // effort at all — which is most of them — so the key it was meant to serve
  // had no effect anywhere it mattered. A project effort is the fallback the
  // review and revise phases use; the draft is the phase the mode exists to
  // make cheap, and only a choice about THIS TASK outranks it.
  test('a project-wide [agent] effort is not a per-task choice', async () => {
    const t = task();
    await resolveAndPersistEffort(t, undefined, 'high', storage());
    expect(t.metadata?.effort).toBe('high');
    expect(t.metadata?.[EFFORT_EXPLICIT_METADATA_KEY]).toBeUndefined();
    expect(effortWasChosen(t)).toBe(false);
  });

  // INVARIANT: sticky, last action wins. A later turn passing no `--effort` is
  // CONTINUING the choice, not withdrawing it — the same rule model and agent
  // follow, and there is no act that means "un-choose my effort".
  test('the choice survives a later turn that passes nothing', async () => {
    const t = task({ effort: 'high', [EFFORT_EXPLICIT_METADATA_KEY]: 'true' });
    await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(t.metadata?.effort).toBe('high');
    expect(t.metadata?.[EFFORT_EXPLICIT_METADATA_KEY]).toBe('true');
  });

  test('effortWasChosen reads the task marker and nothing else', () => {
    expect(effortWasChosen(task())).toBe(false);
    expect(effortWasChosen(task({ [EFFORT_EXPLICIT_METADATA_KEY]: 'true' }))).toBe(true);
  });
});

describe('the low_high draft effort', () => {
  // INVARIANT: a chosen effort is NOT discarded. Running a task somebody set to
  // `high` at `low` because the project switched review modes is a silent
  // downgrade of their work, visible only in the per-turn effort label.
  test('the draft runs at the task effort when somebody chose one', async () => {
    const t = task({ effort: 'high', [EFFORT_EXPLICIT_METADATA_KEY]: 'true' });
    const resolved = await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), 'high');
    expect(resolved).toMatchObject({ draftEffort: 'high', reviewEffort: 'xhigh' });
  });

  // The other branch: nobody chose FOR THIS TASK, so the mode's own cheap
  // default applies — including when the project states an effort of its own,
  // which is the case that would otherwise make `draft_effort` dead.
  test('the draft falls back to draft_effort when nobody chose for this task', async () => {
    const t = task({ effort: 'medium' });
    const resolved = await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), 'medium');
    expect(resolved).toMatchObject({ draftEffort: 'low', reviewEffort: 'xhigh' });

    // A project-wide `[agent] effort = "high"` resolves the task's effort to
    // high, and the DRAFT still runs at draft_effort.
    const projectHigh = task({ effort: 'high' });
    expect(await resolveAndPersistLowHighLoop(projectHigh, undefined, config(), storage(), 'high'))
      .toMatchObject({ draftEffort: 'low' });
  });

  // INVARIANT: the review never runs weaker than the draft it reviews (engineer
  // rule: a reviewer is never weaker than the writer). `review_effort` is a
  // FLOOR, not the value. The rule held by construction while the draft was
  // always `draft_effort`; once a chosen effort could raise the draft,
  // `--effort max` drafted at `max` and self-reviewed at the `xhigh` default.
  test('the review is raised to the draft effort when the draft is stronger', async () => {
    const t = task({ effort: 'max', [EFFORT_EXPLICIT_METADATA_KEY]: 'true' });
    expect(await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), 'max'))
      .toMatchObject({ draftEffort: 'max', reviewEffort: 'max' });
  });

  test('a draft weaker than review_effort leaves the configured review effort alone', async () => {
    const t = task({ effort: 'high', [EFFORT_EXPLICIT_METADATA_KEY]: 'true' });
    expect(await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), 'high'))
      .toMatchObject({ draftEffort: 'high', reviewEffort: 'xhigh' });

    // And the fallback draft, which is weaker still.
    expect(await resolveAndPersistLowHighLoop(task(), undefined, config(), storage(), 'medium'))
      .toMatchObject({ draftEffort: 'low', reviewEffort: 'xhigh' });
  });

  // The floor is computed against the CONFIGURED review effort, not a constant:
  // a project that lowered `review_effort` below its `draft_effort` still gets a
  // reviewer at least as strong as the writer.
  test('the floor applies to the configured review_effort too', async () => {
    const cfg = config({ draft_effort: 'high', review_effort: 'medium' });
    expect(await resolveAndPersistLowHighLoop(task(), undefined, cfg, storage(), 'medium'))
      .toMatchObject({ draftEffort: 'high', reviewEffort: 'high' });
  });

  test('another mode runs no loop at all', async () => {
    const t = task();
    expect(await resolveAndPersistLowHighLoop(t, { mode: 'separate' }, config(), storage(), 'high'))
      .toBeUndefined();
    expect(await resolveAndPersistLowHighLoop(t, { mode: 'off' }, config(), storage(), 'high'))
      .toBeUndefined();
  });
});

describe('resolveAndPersistReviewSettings pins what it resolved', () => {
  // The launch path is where inheritance is READ — from the parent's persisted
  // values, once — and where the result is pinned onto the task.
  test('a child inherits its parent and records the result as its own', async () => {
    const child = task({}, 'cluster-1');
    // A parent whose settings somebody CHOSE — marked `task`, which is the one
    // source a child inherits (see review-mode.test.ts).
    const parent = {
      ...task({
        review_mode: 'separate',
        review_mode_source: 'task',
        review_gate: 'always',
        review_gate_source: 'task',
      }),
      code: 'hub',
    } as Task;
    const s = storage(parent);

    await resolveAndPersistLowHighLoop(child, undefined, config(), s, 'medium');

    expect(child.metadata?.review_mode).toBe('separate');
    expect(child.metadata?.review_gate).toBe('always');
    // Not stated anywhere up the chain, so the project's value is pinned.
    expect(child.metadata?.review_auto_fix).toBe('off');
    // And the child records WHERE each came from, so the next generation can
    // tell an inherited value from a decision — and so can a human reading
    // `lazy show`.
    expect(child.metadata?.review_mode_source).toBe('parent:hub');
    expect(child.metadata?.review_auto_fix_source).toBe('project');
  });

  // INVARIANT: a parent's LEGACY flag is not inheritable. The old resolver
  // pinned `low_high_loop = "off"` on every task alive, so a new task created
  // under any existing hub resolved `separate` on a project whose default is
  // `low_high` — every task in the tree in an arm nobody picked (engineer
  // report, 2026-09-21).
  test("a parent's legacy flag does not reach the child", async () => {
    const child = task({}, 'cluster-1');
    const parent = task({ low_high_loop: 'off' });

    await resolveAndPersistLowHighLoop(child, undefined, config(), storage(parent), 'medium');

    expect(child.metadata?.review_mode).toBe('low_high');
    expect(child.metadata?.review_mode_source).toBe('project');
  });

  test('a child that overrides keeps its own value over its parent', async () => {
    const child = task({}, 'cluster-1');
    const parent = task({ review_mode: 'separate' });

    await resolveAndPersistLowHighLoop(
      child, { mode: 'low_high' }, config(), storage(parent), 'medium',
    );

    expect(child.metadata?.review_mode).toBe('low_high');
  });

  // INVARIANT: an unreadable parent must not stop a launch. The parent level is
  // an enrichment and the project default is a correct answer without it;
  // refusing to run a task because its parent row could not be read would be a
  // far worse failure than reviewing it under the project's own setting.
  test('an unreadable parent degrades to the project default', async () => {
    const child = task({}, 'gone');
    const s = {
      updateTaskMetadata: async () => {},
      getTask: async () => { throw new Error('storage is down'); },
    } as never;

    const resolved = await resolveAndPersistLowHighLoop(child, undefined, config(), s, 'medium');
    expect(resolved).toMatchObject({ draftEffort: 'low' });
    expect(child.metadata?.review_mode).toBe('low_high');
  });
});

/*
 * THE MARKER IS WRITTEN AT EVERY SURFACE THAT LETS SOMEBODY CHOOSE AN EFFORT.
 *
 * Round 2 moved this bug rather than removing it: `effort_explicit` was written
 * only when `--effort` reached a LAUNCH, while `lazy create --effort`,
 * `lazy edit --effort` and the MCP `lazy_edit` effort argument wrote
 * `metadata.effort` directly and left the marker unset. So the most ordinary
 * way of choosing an effort — `lazy create --effort high` then `lazy start` —
 * resolved `high` with `effortWasChosen() === false` and drafted at `low`: the
 * exact silent downgrade the marker exists to prevent.
 *
 * `pinChosenEffort` is the one write all four go through, and these pin the two
 * sequences that were broken.
 */
describe('pinChosenEffort — every choosing surface writes both keys', () => {
  test('create-then-start: the draft runs at the chosen effort', async () => {
    // `lazy create --effort high` — the create surface, through the helper.
    const t = task();
    await pinChosenEffort(storage(), t.id, 'high', t);
    expect(t.metadata?.effort).toBe('high');
    expect(t.metadata?.[EFFORT_EXPLICIT_METADATA_KEY]).toBe('true');

    // …then `lazy start`, which passes no `--effort` of its own. Before the
    // shared helper this resolved `high` and drafted at `low`.
    const effort = await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(effort).toBe('high');
    expect(effortWasChosen(t)).toBe(true);
    expect(await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), effort))
      .toMatchObject({ draftEffort: 'high' });
  });

  test('edit-then-unblock: the same, through the edit surface', async () => {
    // A task that launched once on the project default — no choice recorded.
    const t = task();
    await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(effortWasChosen(t)).toBe(false);

    // `lazy edit --effort xhigh` (or the MCP effort arg) — same helper.
    await pinChosenEffort(storage(), t.id, 'xhigh', t);

    // …then the next unblock, passing nothing.
    const effort = await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(effort).toBe('xhigh');
    expect(await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), effort))
      .toMatchObject({ draftEffort: 'xhigh' });
  });

  // The untouched path must still fall back, or the fix would make
  // `draft_effort` dead by the other route.
  test('a task nobody chose for still drafts at draft_effort', async () => {
    const t = task();
    const effort = await resolveAndPersistEffort(t, undefined, 'medium', storage());
    expect(await resolveAndPersistLowHighLoop(t, undefined, config(), storage(), effort))
      .toMatchObject({ draftEffort: 'low' });
  });
});
