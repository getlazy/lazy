/**
 * E2E tests for commit/PR fidelity.
 *
 * The local driver squash-merges into the target branch and uses the
 * synthesized fidelity summary (when available) as the squash commit body.
 * These tests exercise that path with a MOCKED summarizer (LAZY_SUMMARIZER_STUB)
 * so no live model is required.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';

/** Latest commit body on the given branch. */
function lastCommitBody(ctx: TestContext, branch: string): string {
  const res = ctx.git('log', branch, '-1', '--format=%B');
  return res.stdout;
}

/** Start a root task that makes a commit, then return its id. */
async function startCommittedTask(ctx: TestContext, goal: string): Promise<string> {
  const id = await createTask(ctx, goal, 'Do the work');
  // Reconcile too: accept refuses a task that is still 'working', and only a
  // reconcile pass moves it to 'blocked'.
  await startAndReconcile(ctx, id);
  return id;
}

describe('commit/PR fidelity (local driver squash message)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and these tests assert on the squash commit body, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The synthesized summary replaces the raw commit-subject list in the squash
  // commit body. This is the regeneration-on-accept trigger.
  test('accept uses the synthesized summary as the squash commit body', async () => {
    const id = await startCommittedTask(ctx, 'Fidelity goal');
    const logPath = join(ctx.root, 'summarizer-calls.log');

    const accept = await ctx.lazy(['accept', id, '--reason', 'LGTM'], {
      env: { LAZY_TEST: '1', LAZY_SUMMARIZER_STUB: '1', LAZY_SUMMARIZER_STUB_LOG: logPath },
    });
    expectSuccess(accept);

    const body = lastCommitBody(ctx, 'main');
    expect(body).toContain('Accept task');
    // Stub summary marker proves the body was regenerated from storage.
    expect(body).toContain('SYNTHESIZED-FIDELITY');
    expect(body).toContain('Fidelity goal');

    // Synthesis fired exactly once for this accept.
    expect(existsSync(logPath)).toBe(true);
    const calls = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(1);
  });

  // INVARIANT: synthesis is an enhancement, not a gate. When the summarizer is
  // unavailable, accept MUST still succeed and fall back to the deterministic
  // goal + commit-subjects squash message — never fail the merge.
  test('accept falls back to the deterministic message when synthesis fails', async () => {
    const id = await startCommittedTask(ctx, 'Fallback goal');

    const accept = await ctx.lazy(['accept', id, '--reason', 'LGTM'], {
      env: { LAZY_TEST: '1', LAZY_SUMMARIZER_STUB: '1', LAZY_SUMMARIZER_FAIL: '1' },
    });
    expectSuccess(accept);

    const body = lastCommitBody(ctx, 'main');
    expect(body).toContain('Accept task');
    expect(body).toContain('Fallback goal');
    // No synthesized content — the deterministic path was used.
    expect(body).not.toContain('SYNTHESIZED-FIDELITY');
  });

  // INVARIANT: upstream-merge sync is sync's job and must NOT regenerate the
  // fidelity record — the work did not change, only its base did. We assert the
  // summarizer is NOT invoked by `lazy sync` (the stub log stays empty),
  // regardless of sync's own outcome.
  test('sync does NOT regenerate the fidelity record', async () => {
    const id = await startCommittedTask(ctx, 'Sync goal');
    const logPath = join(ctx.root, 'summarizer-calls.log');
    // Seed the log so we can detect "unchanged" vs "never created".
    writeFileSync(logPath, '');

    // sync may legitimately no-op (nothing upstream to merge) — we don't assert
    // its exit code, only that synthesis was never triggered.
    await ctx.lazy(['sync', id], {
      env: { LAZY_TEST: '1', LAZY_SUMMARIZER_STUB: '1', LAZY_SUMMARIZER_STUB_LOG: logPath },
    });

    const calls = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(0);
  });
});
