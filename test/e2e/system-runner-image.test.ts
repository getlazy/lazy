/**
 * `lazy system runner-image` — the project's own runner image, which the
 * daemon builds when it starts (src/daemon/runner-image.ts). The build states
 * themselves are covered against a fake docker in
 * test/unit/runner-image-boot.test.ts; here the command's surface is.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy system runner-image', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a project with no custom image says it runs on the default one', async () => {
    const result = await ctx.lazy(['system', 'runner-image']);
    expectSuccess(result);
    expectOutput(result, "runs on lazy's default runner image");
  });

  test('--json carries the daemon\'s answer', async () => {
    const result = await ctx.lazy(['system', 'runner-image', '--json']);
    expectSuccess(result);
    const answer = JSON.parse(result.stdout);
    expect(answer.ready).toBe(true);
    expect(answer.project.state).toBe('none');
  });

  // INVARIANT: retry is refused when there is nothing to build, rather than
  // pretending to start a build.
  test('retry refuses when no custom image is configured', async () => {
    const result = await ctx.lazy(['system', 'runner-image', 'retry']);
    expectFailure(result);
    expect(result.stderr).toContain('no custom runner image');
  });

  test('use-project on a task that is not on the default image changes nothing', async () => {
    const taskId = await createTask(ctx, 'runner image probe');
    const result = await ctx.lazy(['system', 'runner-image', 'use-project', taskId]);
    expectSuccess(result);
    expectOutput(result, 'nothing to switch');
  });

  test('a task argument adds no banner for a task on the project image', async () => {
    const taskId = await createTask(ctx, 'runner image probe');
    const result = await ctx.lazy(['system', 'runner-image', taskId, '--json']);
    expectSuccess(result);
    const answer = JSON.parse(result.stdout);
    expect(answer.task.needsConfirmation).toBe(false);
    expect(answer.task.banner).toBeNull();
  });
});
