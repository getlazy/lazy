/**
 * The `cluster` task type end to end: a cluster drives its children, and its
 * progress is visible without reading the tree by hand.
 *
 * The parts covered here are the ones LAZY owns. What the driver does inside its
 * turn (the schedule → wait → review → accept cycle, deferring a child it cannot
 * finish, raising a blocking item per deferred child) is prompt behaviour,
 * asserted in test/unit/cluster-type-constraints.test.ts against the prompt
 * itself — a mocked agent cannot demonstrate it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  readSessionJson,
  readTaskJson,
  readTaskStatus,
  readTurns,
  setTaskStatus,
  writeSessionJson,
} from '../helpers/storage';

/** Create a child under `parentId`, returning its short id. */
async function createChild(ctx: TestContext, parentId: string, goal: string): Promise<string> {
  const result = await ctx.lazy(['create', '--goal', goal, '--prompt', `${goal} work`, '--parent', parentId]);
  expectSuccess(result);
  const match = result.stdout.match(/Created task ([a-f0-9]{8})/);
  expect(match).toBeTruthy();
  return match![1];
}

describe('cluster task type', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('`lazy create --type cluster` records the type and `lazy show` reports k-of-n progress', async () => {
    const clusterResult = await ctx.lazy([
      'create', '--goal', 'Drive the review fixes', '--prompt', 'Run the children', '--type', 'cluster',
    ]);
    expectSuccess(clusterResult);
    const clusterId = clusterResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];
    expect(readTaskJson(ctx.root, clusterId).type).toBe('cluster');

    const a = await createChild(ctx, clusterId, 'First child');
    const b = await createChild(ctx, clusterId, 'Second child');
    setTaskStatus(ctx.root, a, 'complete');
    setTaskStatus(ctx.root, b, 'working');

    const show = await ctx.lazy(['show', clusterId]);
    expectSuccess(show);
    expect(show.stdout).toContain('Cluster progress:');
    expect(show.stdout).toContain('1/2 accepted');
    expect(show.stdout).toContain('running');

    const json = await ctx.lazy(['show', clusterId, '--json']);
    expectSuccess(json);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.cluster_progress.accepted).toBe(1);
    expect(parsed.cluster_progress.total).toBe(2);
    expect(parsed.cluster_progress.running).toHaveLength(1);
    // The old spelling is gone, not dual-emitted: a `--json` reader that misses
    // this key loses a number, never a page, so it costs no compatibility key.
    expect(parsed.loop_progress).toBeUndefined();
  });

  // INVARIANT: a cluster may have ANY number of running children, and no launch
  // path may refuse a start because a sibling is running.
  //
  // This REVERSES the rule the type shipped with. As `loop`, the daemon refused
  // to start a second child while one was active (`assertLoopHasNoRunningChild`)
  // on the argument that serial children never merge each other's work. The
  // engineer reversed it on 2026-09-20 after ten days of running them: the
  // merges it avoided were mostly micro-conflicts, while the serialisation cost
  // enough that two small children took 1h46m and 1h10m of wall-clock each. The
  // driver decides concurrency now, from file overlap and dependency, and a
  // daemon refusal cannot see either. Do not reintroduce a cap or a queue —
  // agent tasks are uncapped by design. See docs/design/cluster-replaces-loop.md.
  //
  // HOW THE SIBLING IS HELD ACTIVE, because the obvious arrangement is racy and
  // was: the first draft STARTED the first child, waited for its mocked turn,
  // then wrote its status back to `working`. That child has a session and no
  // live run, so the next reconcile tick (grace 0 under LAZY_TEST, 5s loop)
  // takes it down the run-disappeared path and parks it `interrupted`. Whether
  // the tick landed before or after the second start decided whether the case
  // failed spuriously or passed vacuously — and vacuously is the worse half,
  // because the sibling was no longer active, so the removed refusal would not
  // have fired either.
  //
  // So the sibling is NEVER started. Every reconciler path — reconcileTask and
  // all four sweeps — begins `getSessionByTaskId` / `if (!session) continue`,
  // so a task with no session is invisible to it and its status is whatever the
  // test last wrote, for as long as the test wants. The removed refusal keyed on
  // the sibling's STATUS (`isActiveStatus`, which `working` satisfies), not on a
  // live container, so this is exactly the state it refused on.
  test('two children of a cluster run at the same time', async () => {
    const clusterResult = await ctx.lazy([
      'create', '--goal', 'Concurrent cluster', '--prompt', 'Run them', '--type', 'cluster',
    ]);
    expectSuccess(clusterResult);
    const clusterId = clusterResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];

    expectSuccess(await ctx.lazyMocked(['start', clusterId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', clusterId]));

    const first = await createChild(ctx, clusterId, 'Runs first');
    const second = await createChild(ctx, clusterId, 'Runs alongside it');

    // Never started, so it has no session and nothing reclaims it.
    setTaskStatus(ctx.root, first, 'working');
    expect(readTaskStatus(ctx.root, first)).toBe('working');

    // THE ASSERTION: a sibling in an active status does not refuse this start.
    const alongside = await ctx.lazyMocked(['start', second, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(alongside);
    expectSuccess(await ctx.lazy(['wait', second]));

    // And the second child really ran, rather than the command merely exiting 0.
    expect(readTurns(ctx.root, second).length).toBeGreaterThan(0);

    // The sibling is untouched: starting one child does not stop another, and
    // it is still in the state the refusal would have keyed on.
    expect(readTaskStatus(ctx.root, first)).toBe('working');
  });

  // INVARIANT: adding a child to a QUIESCENT cluster restarts it. This is the one
  // deliberate, cluster-only exception to "nothing local starts a turn", and it is
  // derived from the tree — no comment is read and no comment surface emits
  // anything (see src/daemon/cluster-restart.ts).
  test('a child added to a blocked cluster starts a turn that names it', async () => {
    const clusterResult = await ctx.lazy([
      'create', '--goal', 'Restarting cluster', '--prompt', 'Run them', '--type', 'cluster',
    ]);
    expectSuccess(clusterResult);
    const clusterId = clusterResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];

    expectSuccess(await ctx.lazyMocked(['start', clusterId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', clusterId]));
    expect(readTaskStatus(ctx.root, clusterId)).toBe('blocked');

    const added = await createChild(ctx, clusterId, 'Arrived after the cluster stopped');

    // The reconciler picks this up on its next tick.
    const deadline = Date.now() + 60_000;
    let restartTurn: string | undefined;
    while (Date.now() < deadline && !restartTurn) {
      restartTurn = readTurns(ctx.root, clusterId)
        .map(t => t.content ?? '')
        .find(content => content.includes('added to this cluster'));
      if (!restartTurn) await new Promise(r => setTimeout(r, 1_000));
    }

    expect(restartTurn).toBeDefined();
    expect(restartTurn).toContain(added);
  }, 90_000);

  // INVARIANT: a cluster somebody STOPPED is not restarted by an arriving child.
  // `lazy stop` is the one act that means "do not run this without me", and it
  // used to be the state an added child woke — so stopping a cluster that was
  // still being handed work did nothing. The arrival is recorded as a comment
  // instead, which the cluster is given in the prompt of the next `lazy unblock`.
  test('a child added to a STOPPED cluster records a note and starts no turn', async () => {
    const clusterResult = await ctx.lazy([
      'create', '--goal', 'Stopped cluster', '--prompt', 'Run them', '--type', 'cluster',
    ]);
    expectSuccess(clusterResult);
    const clusterId = clusterResult.stdout.match(/Created task ([a-f0-9]{8})/)![1];

    expectSuccess(await ctx.lazyMocked(['start', clusterId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', clusterId]));
    expect(readTaskStatus(ctx.root, clusterId)).toBe('blocked');

    // What `lazy stop` leaves behind: parked in `blocked`, with the stop gate
    // set on the session. Stop itself only accepts a `working` task, and a
    // mocked turn is over before a test could catch it there.
    const session = readSessionJson(ctx.root, clusterId)!;
    session.user_stopped = true;
    writeSessionJson(ctx.root, clusterId, session);

    const added = await createChild(ctx, clusterId, 'Arrived while the cluster was stopped');

    // The notice is written by the same reconcile tick that would have done the
    // restart, so waiting for it is what makes the negative below meaningful.
    const deadline = Date.now() + 60_000;
    let notice: string | undefined;
    while (Date.now() < deadline && !notice) {
      const show = await ctx.lazy(['show', clusterId, '--json']);
      expectSuccess(show);
      notice = (JSON.parse(show.stdout).comments ?? [])
        .map((c: { content?: string }) => c.content ?? '')
        .find((content: string) => content.includes('added to this cluster'));
      if (!notice) await new Promise(r => setTimeout(r, 1_000));
    }

    expect(notice).toBeDefined();
    expect(notice).toContain(added);

    // And no turn: the cluster is where the operator left it.
    const restartTurn = readTurns(ctx.root, clusterId)
      .map(t => t.content ?? '')
      .find(content => content.includes('added to this cluster'));
    expect(restartTurn).toBeUndefined();
    expect(readTaskStatus(ctx.root, clusterId)).toBe('blocked');
    expect(readSessionJson(ctx.root, clusterId)!.user_stopped).toBe(true);
  }, 90_000);

  // A child a cluster set aside carries `deferred-by-<cluster>`; the cluster's progress
  // line is where the operator sees that without hunting through tags.
  test('a child tagged deferred-by-<cluster> is reported as deferred', async () => {
    const clusterResult = await ctx.lazy([
      'create', '--goal', 'Deferring cluster', '--prompt', 'Run them', '--type', 'cluster',
      '--code', 'deferring-cluster',
    ]);
    expectSuccess(clusterResult);
    const clusterId = 'deferring-cluster';

    const child = await createChild(ctx, clusterId, 'Too big to finish');
    expectSuccess(await ctx.lazy(['tag', child, 'deferred-by-deferring-cluster']));

    const show = await ctx.lazy(['show', clusterId]);
    expectSuccess(show);
    expect(show.stdout).toContain('1 deferred');
    expect(show.stdout).toContain('deferred');
  });
});
