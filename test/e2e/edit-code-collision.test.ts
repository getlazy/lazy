import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { readTaskJson } from '../helpers/storage';

describe('lazy edit --code collision', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  // INVARIANT: an unstarted task's code edit applies create's collision rule —
  // two live tasks never share a code, or `lazy show <code>` becomes ambiguous.
  test('refuses a code another live task already uses', async () => {
    const a = await createTask(ctx, 'first');
    const b = await createTask(ctx, 'second');
    expectSuccess(await ctx.lazy(['edit', a, '--code', 'dup-code']));
    const result = await ctx.lazy(['edit', b, '--code', 'dup-code']);
    expectFailure(result);
    expectError(result, "A task with code 'dup-code' already exists");
  });

  // INVARIANT: a refused edit applies nothing — a code clash must not leave the
  // review settings of the same combined command written.
  test('a refused combined edit writes no review settings', async () => {
    const a = await createTask(ctx, 'first');
    const b = await createTask(ctx, 'second');
    expectSuccess(await ctx.lazy(['edit', a, '--code', 'dup-two']));
    const before = JSON.stringify(readTaskJson(ctx.root, b).metadata ?? {});
    const result = await ctx.lazy(['edit', b, '--review-gate', 'never', '--code', 'dup-two']);
    expectFailure(result);
    expect(JSON.stringify(readTaskJson(ctx.root, b).metadata ?? {})).toBe(before);
  });
});
