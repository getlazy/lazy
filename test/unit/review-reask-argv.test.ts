/**
 * The review re-ask is READ-ONLY on the worktree.
 *
 * INVARIANT: `runReviewVerdictReask` resumes the REVIEWER's session, and that
 * session was started read-only — `handleReviewCommand` passes `'plan'` to
 * `runWork`, which blocks the write tools via `--disallowedTools`. The re-ask
 * has to carry the same lockdown or it hands the reviewer write access to the
 * branch it is reviewing, halfway through reviewing it.
 *
 * WHY IT MATTERS MORE THAN THE USUAL "defense in depth": a reviewer that can
 * write could silently fix what it was about to report, rewrite a test out from
 * under its own finding, or commit into the IMPLEMENTER's worktree — where the
 * change lands on the implementer's task with no work turn behind it and no
 * record of who made it. That breaks the separation the whole review turn
 * exists to enforce.
 *
 * And this is not a rare path. The re-ask fires on exactly the reviews that
 * already went wrong — an unusable verdict, a missing sweep statement — so it
 * is reached under confusion, by an agent that has just demonstrated it is not
 * following the output contract.
 *
 * The argv is asserted rather than the call site because the lockdown is a
 * property of what the process is launched with; a test that only checked the
 * option object would pass against an agent that ignored it.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { runReviewVerdictReask } from '../../src/supervisor/review-reask';

/** Captures the argv `runReviewVerdictReask` builds, then fails the exec. */
function capturingAgent(sink: { argv?: string[] }): ClaudeCodeAgent {
  const agent = new ClaudeCodeAgent();
  const real = agent.buildExecArgs.bind(agent);
  agent.buildExecArgs = ((opts: Parameters<ClaudeCodeAgent['buildExecArgs']>[0]) => {
    const argv = real(opts);
    sink.argv = argv;
    // A binary that does not exist: execWithWatchdog returns a non-zero exit,
    // `runReviewVerdictReask` degrades to `failed: true`, and the test stays
    // offline. The argv is what is under test, not the invocation.
    return ['definitely-not-a-real-binary-for-tests', ...argv.slice(1)];
  }) as ClaudeCodeAgent['buildExecArgs'];
  return agent;
}

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

describe('the review re-ask argv', () => {
  test('blocks the write tools, exactly as the review invocation it resumes does', async () => {
    const sink: { argv?: string[] } = {};
    const result = await runReviewVerdictReask(
      capturingAgent(sink),
      originalCwd,
      'reviewer-session-id',
      'test-model',
      'high',
    );

    // The invocation itself failed (no such binary) — never throws, by design.
    expect(result.failed).toBe(true);

    const argv = sink.argv!;
    const disallowedIdx = argv.indexOf('--disallowedTools');
    expect(disallowedIdx).toBeGreaterThanOrEqual(0);
    expect(argv[disallowedIdx + 1]).toBe('Bash Write Edit');

    // The same shape the rest of the read-only surfaces use: the write tools are
    // withheld by name, NOT by `--permission-mode plan`, which would stall a
    // `claude -p` run on an interactive ExitPlanMode prompt it cannot answer
    // (test/unit/claude-code-plan-mode.test.ts).
    expect(argv).not.toContain('--permission-mode');
  });

  // The re-ask must still RESUME the reviewer's own session — asking a fresh
  // one for "the JSON block" would get a verdict about nothing, since the new
  // session never read the diff.
  test('resumes the reviewer session it was given', async () => {
    const sink: { argv?: string[] } = {};
    await runReviewVerdictReask(
      capturingAgent(sink),
      originalCwd,
      'reviewer-session-id',
      'test-model',
    );

    const argv = sink.argv!;
    const resumeIdx = argv.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIdx + 1]).toBe('reviewer-session-id');
  });
});
