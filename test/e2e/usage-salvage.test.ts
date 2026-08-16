/**
 * Token usage salvaged from a turn that DIED — end to end, real supervisor.
 *
 * Measured against the live store on 2026-08-02, every crashed or
 * watchdog-killed turn recorded no usage at all: real spend that existed on no
 * record (see docs/token-usage-recording.md). The salvage path that fixes it —
 * src/supervisor/usage.ts → ErrorResponse.usage → the recorded turn — lives
 * entirely BELOW `launchSupervisorAsync`, which the `--preload` module mock
 * replaces wholesale. So it can only be exercised on the fake-binary seam
 * (`setupTestLazy({ fakeClaude: true })`, see CLAUDE.md on the two agent seams):
 * here a real `lazy supervise` subprocess really spawns an agent that really
 * reports tokens and really exits non-zero.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { crashAfterReportingUsageScenario } from '../helpers/fake-claude';
import { agentTurns, readSessionRecord } from '../helpers/agent-seam';

describe('token usage survives a turn that dies (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: tokens a turn spent before it died are still recorded on a turn.
  //
  // The expensive part of a turn is the context the model reads before it falls
  // over, so a crashed turn is often most of that turn's cost. Dropping it made
  // a task's recorded spend a fiction. The tokens must reach BOTH views — the
  // turn record and the session total — and they must agree.
  test('a turn that reports usage and then crashes still records those tokens', async () => {
    const taskId = await createTask(ctx, 'Crash after spending tokens', 'Do the work');
    await ctx.setClaudeScenario(crashAfterReportingUsageScenario({
      sessionId: 'fake-sess-crash-usage',
      inputTokens: 4_000,
      outputTokens: 700,
      // Classified fatal_auth: the turn stops after ONE attempt instead of
      // climbing the retry ladder, which keeps the arithmetic here exact.
      stderr: 'API Error: 401 Invalid API key · Please run /login\n',
      exitCode: 1,
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await agentTurns(ctx.root, taskId);
    const last = turns[turns.length - 1] as { usage?: Record<string, number> };
    expect(last.usage).toBeDefined();
    expect(last.usage!.inputTokens).toBe(4_000);
    expect(last.usage!.outputTokens).toBe(700);

    // Both views agree: the session total is exactly what its turns account for.
    const session = await readSessionRecord(ctx.root, taskId) as {
      total_usage?: Record<string, number>;
    };
    expect(session.total_usage).toBeDefined();
    expect(session.total_usage!.inputTokens).toBe(4_000);
    expect(session.total_usage!.outputTokens).toBe(700);
  }, 150_000);
});
