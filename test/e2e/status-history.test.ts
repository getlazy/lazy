import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy show status history', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: The per-task status changelog must be surfaced in `lazy show`
  // so status transitions (and the actor who triggered them) are auditable
  // without reading raw status-changelog.json. This is the whole point of the
  // status-history view: a `system`-actor transition (e.g. the reconciler
  // flipping a task to complete) must be visible to a human.
  test('renders status transitions with actor in lazy show', async () => {
    const taskId = await createTask(ctx, 'Status history view test', 'Do work');

    // backlog -> abandoned (actor=human, via CLI close)
    expectSuccess(await ctx.lazy(['close', taskId, '--reason', 'first close', '--yes']));
    // abandoned -> backlog (reopen)
    expectSuccess(await ctx.lazy(['reopen', taskId]));
    // backlog -> abandoned again
    expectSuccess(await ctx.lazy(['close', taskId, '--reason', 'second close', '--yes']));

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);

    // The Status History section renders each transition as `from → to`
    // along with the triggering actor.
    expectOutput(showResult, 'Status History');
    expectOutput(showResult, '→');
    expectOutput(showResult, 'abandoned');
    // CLI-driven transitions are attributed to the human actor.
    expectOutput(showResult, 'human');
  });
});
