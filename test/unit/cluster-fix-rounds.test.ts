/**
 * The mechanical per-child fix-round budget for cluster tasks
 * (`[cluster] max_child_fix_rounds`).
 *
 * WHY IT EXISTS: a cluster's driver runs its children unattended and step 5 of
 * its contract lets it unblock a child with the review's findings and go round
 * again. Nothing in the contract bounds how many times, so one child that keeps
 * not-quite-passing review can absorb any number of full agent turns with
 * nobody watching the spend.
 *
 * The exemptions below are not softness — each is a rule from elsewhere that
 * outranks this budget, and weakening any of them would cost something worse
 * than tokens.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  CLUSTER_FIX_ROUND_KEY,
  checkClusterFixRoundBudget,
  getClusterFixRound,
  incrementClusterFixRound,
  resetClusterFixRound,
} from '../../src/daemon/cluster-fix-rounds';
import type { Task } from '../../src/types';

const metadata = new Map<string, string>();

function makeStorage(tasks: Record<string, { type: string }>): any {
  return {
    getTask: async (id: string) => (tasks[id] ? { id, ...tasks[id] } : null),
    getTaskMetadata: async (taskId: string, key: string) => metadata.get(`${taskId}:${key}`) ?? null,
    updateTaskMetadata: async (taskId: string, key: string, value: string) => {
      metadata.set(`${taskId}:${key}`, value);
    },
  };
}

function child(parentId: string | null): Task {
  return {
    id: 'child-1',
    code: 'fix-thing',
    goal: 'Fix the thing',
    status: 'blocked',
    type: 'task',
    target: parentId ? { kind: 'task', parentTaskId: parentId } : { kind: 'branch', branch: 'main' },
  } as unknown as Task;
}

beforeEach(() => metadata.clear());

describe('the counter', () => {
  test('starts at zero, counts up, and resets', async () => {
    const storage = makeStorage({});
    expect(await getClusterFixRound(storage, 'child-1')).toBe(0);
    expect(await incrementClusterFixRound(storage, 'child-1')).toBe(1);
    expect(await incrementClusterFixRound(storage, 'child-1')).toBe(2);
    await resetClusterFixRound(storage, 'child-1');
    expect(await getClusterFixRound(storage, 'child-1')).toBe(0);
    expect(metadata.get(`child-1:${CLUSTER_FIX_ROUND_KEY}`)).toBe('');
  });

  // Best-effort by design: losing a reset costs the driver rounds it was entitled
  // to, which fails in the restrictive direction (fewer turns, never more), and
  // must never break the start or unblock it rides on.
  test('a reset that throws does not propagate', async () => {
    const storage = {
      getTaskMetadata: async () => null,
      updateTaskMetadata: async () => { throw new Error('store down'); },
    } as any;
    await resetClusterFixRound(storage, 'child-1');
  });
});

describe('checkClusterFixRoundBudget', () => {
  const clusterParent = { 'cluster-1': { type: 'cluster' } };

  // INVARIANT: the budget is counted PER CHILD, and under concurrency that is
  // the whole point. A cluster may now have any number of children running at
  // once (the serial rule was reversed on 2026-09-20), so one stubborn child
  // exhausting its rounds must neither spend nor refuse a sibling's. A budget
  // held on the CLUSTER would recouple the siblings that dropping the serial
  // rule uncoupled.
  test('one child at its budget does not spend or refuse a sibling\'s', async () => {
    const storage = makeStorage(clusterParent);
    const stubborn = { ...child('cluster-1'), id: 'child-stubborn' } as Task;
    const fresh = { ...child('cluster-1'), id: 'child-fresh' } as Task;
    metadata.set(`child-stubborn:${CLUSTER_FIX_ROUND_KEY}`, '3');

    expect((await checkClusterFixRoundBudget({
      storage, task: stubborn, actor: 'agent', budget: 3,
    })).kind).toBe('refused');

    // The sibling, running at the same time under the same cluster, is untouched.
    expect(await checkClusterFixRoundBudget({
      storage, task: fresh, actor: 'agent', budget: 3,
    })).toEqual({ kind: 'allowed', round: 0, budget: 3 });

    // And spending the sibling's rounds never moves the stubborn one's count.
    await incrementClusterFixRound(storage, 'child-fresh');
    await incrementClusterFixRound(storage, 'child-fresh');
    expect(await getClusterFixRound(storage, 'child-stubborn')).toBe(3);
    expect(await getClusterFixRound(storage, 'child-fresh')).toBe(2);
  });

  test('an agent unblock under the budget is allowed and reports the round', async () => {
    const storage = makeStorage(clusterParent);
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '1');
    expect(await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'agent', budget: 3,
    })).toEqual({ kind: 'allowed', round: 1, budget: 3 });
  });

  test('at the budget an agent unblock is refused, naming what to do instead', async () => {
    const storage = makeStorage(clusterParent);
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '3');
    const decision = await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'agent', budget: 3,
    });
    expect(decision.kind).toBe('refused');
    const message = (decision as { message: string }).message;
    expect(message).toContain('max_child_fix_rounds = 3');
    expect(message).toContain('lazy_accept');
    expect(message).toContain('lazy_close');
    expect(message).toContain('blocking');
  });

  // INVARIANT: a HUMAN unblock is never refused, at any count. It carries
  // feedback somebody has already typed, and refusing it discards that
  // (CLAUDE.md, "Never Lose Human Feedback"). A human taking over also starts a
  // fresh budget — the same human-intervention rule every other counter uses.
  test('a human unblock is never refused and resets the budget', async () => {
    const storage = makeStorage(clusterParent);
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '99');
    expect(await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'human', budget: 3,
    })).toEqual({ kind: 'reset' });
    expect(await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'builder', budget: 3,
    })).toEqual({ kind: 'reset' });
  });

  // INVARIANT: the daemon's own turns are exempt — a bound on the DRIVER's
  // judgement must not strand an auto-resume, a sync or a review auto-fix the
  // daemon started.
  test("the daemon's own unblock is neither counted nor refused", async () => {
    const storage = makeStorage(clusterParent);
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '99');
    expect(await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'system', budget: 3,
    })).toEqual({ kind: 'not-applicable' });
  });

  test('a child whose parent is not a cluster is unaffected', async () => {
    const storage = makeStorage({ 'plain-1': { type: 'task' } });
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '99');
    expect(await checkClusterFixRoundBudget({
      storage, task: child('plain-1'), actor: 'agent', budget: 3,
    })).toEqual({ kind: 'not-applicable' });
  });

  test('a top-level task is unaffected', async () => {
    const storage = makeStorage({});
    expect(await checkClusterFixRoundBudget({
      storage, task: child(null), actor: 'agent', budget: 3,
    })).toEqual({ kind: 'not-applicable' });
  });

  test('budget 0 disables the bound', async () => {
    const storage = makeStorage(clusterParent);
    metadata.set(`child-1:${CLUSTER_FIX_ROUND_KEY}`, '99');
    expect(await checkClusterFixRoundBudget({
      storage, task: child('cluster-1'), actor: 'agent', budget: 0,
    })).toEqual({ kind: 'not-applicable' });
  });
});

/**
 * WHERE THE BUDGET RESTARTS, and why each site is checked mechanically.
 *
 * `[cluster] max_child_fix_rounds` is documented — in `src/config/types.ts` and in
 * `lazy.toml.example`, which is what a user reads — as counting the rounds
 * "since that child was last STARTED OR ACCEPTED". Three of the four resets
 * (start, reopen, human unblock) were there; ACCEPT was not, so the documented
 * sentence was a claim the code did not keep and a reopened-then-re-accepted
 * child could be refused on a budget it had already been granted afresh.
 *
 * Each site lives inside a large daemon lifecycle function that no unit test
 * can call — they merge branches, spawn runners and talk to forges. So this is
 * a SOURCE SCAN, the same idiom as `cli-flag-alias-coverage.test.ts`: it reads
 * the enclosing function's body and fails if the reset is not in it. It cannot
 * prove the reset runs; it does prove the site was not quietly dropped, which
 * is how accept came to be missing in the first place.
 *
 * The scan asserts its own anchors, so it fails loudly rather than degrading
 * into a no-op when a function is renamed.
 */
function topLevelFunctions(src: string): Map<string, string> {
  const scopes = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of src.split('\n')) {
    const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    if (decl) {
      if (current) scopes.set(current, buf.join('\n'));
      current = decl[1];
      buf = [line];
      continue;
    }
    if (!current) continue;
    buf.push(line);
    if (line === '}') {
      scopes.set(current, buf.join('\n'));
      current = null;
      buf = [];
    }
  }
  if (current) scopes.set(current, buf.join('\n'));
  return scopes;
}

async function functionsOf(relativePath: string): Promise<Map<string, string>> {
  const src = await readFile(join(import.meta.dir, '../..', relativePath), 'utf-8');
  return topLevelFunctions(src);
}

describe('every documented reset site', () => {
  test('START: launching a task starts a fresh budget', async () => {
    const fns = await functionsOf('src/daemon/task-launcher.ts');
    const body = fns.get('launchTaskRun');
    expect(body).toBeDefined();
    expect(body).toContain('resetClusterFixRound(');
  });

  // The site that was missing. A child whose work has LANDED spent its rounds
  // on work that shipped; if it is ever reopened it is owed a full budget, and
  // the config comment has always said so.
  test('ACCEPT: every accept exit starts a fresh budget', async () => {
    const fns = await functionsOf('src/daemon/task-lifecycle.ts');
    const helper = fns.get('resetRoundBudgetsOnAccept');
    expect(helper).toBeDefined();
    expect(helper).toContain('resetClusterFixRound(');
    // Three exits merge a task: the two remote-merge paths and the local one.
    // All of them go through the helper — a fourth added without it is the
    // failure this counts. Since the merge became the accept's commit point
    // (fix-accept-resumable) every exit reaches it through ONE transition,
    // commitAcceptTransition, via finishLandedAccept — so count those.
    const transition = fns.get('commitAcceptTransition');
    expect(transition).toContain('resetRoundBudgetsOnAccept(');
    expect(fns.get('finishLandedAccept')).toContain('commitAcceptTransition(');
    const acceptRun = fns.get('acceptTaskRun');
    expect(acceptRun).toBeDefined();
    const calls = acceptRun!.match(/finishLandedAccept\(/g) ?? [];
    expect(calls.length).toBe(3);
  });

  test('REOPEN: a reopened task starts a fresh budget', async () => {
    const fns = await functionsOf('src/daemon/task-lifecycle.ts');
    const body = fns.get('reopenTask');
    expect(body).toBeDefined();
    expect(body).toContain('resetClusterFixRound(');
  });

  // The human-unblock reset has a behavioural test above
  // (`checkClusterFixRoundBudget` answers `reset`); what the scan adds is that the
  // unblock path ACTS on that answer rather than just not refusing.
  test('HUMAN UNBLOCK: the unblock path acts on the reset decision', async () => {
    const fns = await functionsOf('src/daemon/task-lifecycle.ts');
    const body = fns.get('launchUnblockTaskRun');
    expect(body).toBeDefined();
    expect(body).toContain("=== 'reset'");
    expect(body).toContain('resetClusterFixRound(');
  });

  // The user-facing sentence this whole set exists to keep true.
  test('the config surfaces still promise start-or-accept', async () => {
    const types = await readFile(join(import.meta.dir, '../../src/config/types.ts'), 'utf-8');
    const example = await readFile(join(import.meta.dir, '../../lazy.toml.example'), 'utf-8');
    expect(types).toContain('max_child_fix_rounds');
    expect(example).toContain('max_child_fix_rounds');
    for (const text of [types, example]) {
      expect(/started or accepted/i.test(text)).toBe(true);
    }
  });
});
