/**
 * E2E for `lazy review` — the agent-review verb.
 *
 * Fake-binary seam: real daemon + supervisor + scripted `claude`. Asserts the
 * argv contract the task named: new session (no `--resume`), and the review
 * prompt carries the security / data-integrity sweep.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';
import { readTurns, setTaskMetadata, setTaskStatus } from '../helpers/storage';
import { IMPORT_SOURCE_URL_KEY } from '../../src/task/linked';

const REVIEW_JSON = JSON.stringify({
  verdict: 'clean',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
});

describe('lazy review (real supervisor, fake claude)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Review target', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' }),
        successScenario({ result: REVIEW_JSON, sessionId: 'fake-sess-review' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('prints the structured report and leaves the task blocked', async () => {
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'Verdict: clean');
    expectOutput(result, 'Security: none found');
    expectOutput(result, 'Data integrity: none found');
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
  }, 120_000);

  test('review invocation is a new session with the security/data-integrity prompt', async () => {
    expectSuccess(await ctx.lazy(['review', taskId, '--yes']));
    const invocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    const reviewInv = invocations[invocations.length - 1];
    expect(reviewInv.argv).not.toContain('--resume');
    expect(reviewInv.argv).toContain('--disallowedTools');
    const disallowIdx = reviewInv.argv.indexOf('--disallowedTools');
    expect(reviewInv.argv[disallowIdx + 1]).toMatch(/Bash/);
    expect(reviewInv.argv[disallowIdx + 1]).toMatch(/Write/);
    expect(reviewInv.argv[disallowIdx + 1]).toMatch(/Edit/);
    const promptIdx = reviewInv.argv.indexOf('-p');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = reviewInv.argv[promptIdx + 1] ?? '';
    expect(prompt).toMatch(/SECURITY/i);
    expect(prompt).toMatch(/DATA INTEGRITY/i);
    expect(prompt).toMatch(/none found/);
    expect(prompt).toMatch(/lazy_raise/);
    // The reviewer's issues are FINDINGS in its JSON, delivered to the fixer as
    // its next brief; `lazy_raise` survives for the one `needs_human` decision,
    // which is why the assertion above still expects the tool to be named.
    expect(prompt).toMatch(/findings go in the JSON/i);
    // And the verdict it must produce is the closed set, spelled out.
    expect(prompt).toMatch(/clean \| needs_work \| needs_human/);
  }, 120_000);

  test('show labels the review turn', async () => {
    expectSuccess(await ctx.lazy(['review', taskId, '--yes']));
    const shown = await ctx.lazy(['show', taskId]);
    expectSuccess(shown);
    expectOutput(shown, '(review)');
    expectOutputExcludes(shown, 'FAILED REVIEW');
  }, 120_000);
});

describe('lazy review unparsed report is loud (real supervisor, fake claude)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Review target', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Work done.', sessionId: 'fake-sess-work' }),
        successScenario({ result: 'Looks fine, ship it.', sessionId: 'fake-sess-review' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('prints FAILED REVIEW and never Findings: none', async () => {
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'FAILED REVIEW (unparsed)');
    expectOutput(result, 'not a clean review');
    expectOutputExcludes(result, 'Findings: none');
    const shown = await ctx.lazy(['show', taskId]);
    expectOutput(shown, 'FAILED REVIEW (unparsed)');
  }, 120_000);
});

describe('lazy review (validation, no agent)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('refuses a task with no session', async () => {
    const taskId = await createTask(ctx, 'Never started');
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'no session');
  });

  test('refuses a complete task (finished worktrees are gone)', async () => {
    const taskId = await createTask(ctx, 'Already finished', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    setTaskStatus(ctx.root, taskId, 'complete');
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'complete');
    expectError(result, 'already finished');
  });

  test('usage names the agent-review verb', async () => {
    const help = await ctx.lazy(['review', '--help']);
    expectOutput(help, 'Run an agent review');
    expectOutput(help, '--yes');
    // INVARIANT: the help says plainly that lazy does not post reviews to a
    // PR/MR. The old help promised the opposite.
    expectOutput(help, 'lazy does not post reviews');
  });
});

/**
 * INVARIANT: a review NEVER reaches the forge. Lazy posts nothing to a pull
 * or merge request that a human receives as a notification (engineer
 * decision, 2026-09-21: "Description refresh is fine — that's a single thing
 * that gets updated. Intermittent comments are not fine — we should just not
 * post anything."). These tests mock at the DRIVER boundary and assert the
 * absence of a write, which is the only thing that can regress here.
 *
 * The review path makes no forge call at all now, so these assertions cannot
 * by themselves tell "nothing was written" from "the mock was never active".
 * Two things close that gap, and neither lives here:
 * test/e2e/accept-reject-no-forge-writes.test.ts drives the same seam to a
 * POSITIVE control (reject records exactly one `close`), and the driver suites
 * assert the removed posting methods are not properties of the driver at all,
 * which no mock can fake.
 */
describe('lazy review makes no forge write', () => {
  let ctx: TestContext;
  let taskId: string;

  function armForgeWriteLog(): void {
    writeFileSync(join(ctx.protocolBase, 'mock-forge-writes.json'), '{}');
  }

  function forgeWrites(): Array<{ kind: string }> {
    const path = join(ctx.protocolBase, 'mock-forge-write-calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_ACCEPT_GATES: '[]',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: REVIEW_JSON,
          session_id: 'mock-sess-review-post',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      },
    });
    taskId = await createTask(ctx, 'Review with a PR', 'Do the work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_id', '42');
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_url', 'https://github.com/o/r/pull/42');
    armForgeWriteLog();
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: this is the case that USED to post — the task's own PR, opened
  // by lazy, with findings to report. It is now silent on the forge and the
  // report lives only on the task.
  test('a review on the task\'s own PR writes nothing to the forge', async () => {
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectSuccess(result);
    expect(forgeWrites().filter((w) => w.kind !== 'body')).toEqual([]);
    expectOutputExcludes(result, 'Posted to PR');
    const review = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'agent' && t.turn_type === 'review',
    )?.review;
    // The report IS recorded — silence on the forge is not silence on the task.
    expect(review).toBeTruthy();
  }, 120_000);

  // INVARIANT: `--post` is a deprecated no-op kept so old scripts do not die
  // on an unknown flag. Asking for it does NOT re-enable posting — there is
  // no opt-in, by design. The notice goes to STDERR like every other advisory
  // in this command, so it cannot land in a script's piped report.
  test('--post is a no-op that posts nothing and says so', async () => {
    const result = await ctx.lazy(['review', taskId, '--yes', '--post']);
    expectSuccess(result);
    expectError(result, 'no longer does anything');
    expectOutputExcludes(result, 'no longer does anything');
    expect(forgeWrites().filter((w) => w.kind !== 'body')).toEqual([]);
  }, 120_000);

  // INVARIANT: a linked PR (someone else's) was already the conservative case.
  // It stays silent for the same reason every other PR now does.
  test('a linked PR gets no comment either', async () => {
    setTaskMetadata(ctx.root, taskId, IMPORT_SOURCE_URL_KEY, 'https://github.com/o/r/pull/42');
    const result = await ctx.lazy(['review', taskId, '--yes']);
    expectSuccess(result);
    expect(forgeWrites().filter((w) => w.kind !== 'body')).toEqual([]);
  }, 120_000);
});
