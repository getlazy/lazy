import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installFakeClaude, setClaudeScenario, crashScenario, successScenario, overloadedRetryEvent } from '../helpers/fake-claude';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { runWork, FatalAgentError, type RetryState } from '../../src/supervisor/work';
import { createRunnerFromType } from '../../src/runner';
import { TRANSIENT_MAX_ATTEMPTS } from '../../src/supervisor/retry-policy';
import { setupTestLazy } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { agentTurns, sessionInterrupt } from '../helpers/agent-seam';

// INVARIANT: actual agent exits, rather than mocked supervisor responses, drive
// transient retries. A persistent overload must end the turn as transient.
for (const recovers of [true, false]) {
  test(`fake 529 agent ${recovers ? 'recovers with visible attempts' : 'exhausts its bounded retries'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-recovery-'));
    try {
      const fake = await installFakeClaude(dir);
      const failure = crashScenario({ stderr: 'API Error: 529 Overloaded' });
      await setClaudeScenario(fake, recovers ? { sequence: [failure, failure, successScenario()] } : failure);
      const agent = new ClaudeCodeAgent();
      const build = agent.buildExecArgs.bind(agent);
      agent.buildExecArgs = opts => {
        const args = build(opts);
        args[0] = join(fake.binDir, 'claude');
        return args;
      };
      const states: (RetryState | null)[] = [];
      const delays: number[] = [];
      const turn = runWork(agent, createRunnerFromType('dangerously-host-process-without-any-isolation'),
        dir, 'test', undefined, 'claude-opus-5-5', undefined, undefined,
        state => states.push(state ? structuredClone(state) : null), undefined,
        0, undefined, undefined, 100, undefined,
        async ms => { delays.push(ms); });
      if (recovers) {
        expect((await turn).result).toBeTruthy();
        expect(delays).toEqual([5000, 10000]);
        expect(states.at(-1)).toBeNull();
        expect(states.filter(s => s?.nextRetryAt).map(s => s!.count)).toEqual([1, 2]);
        expect(states.find(s => s?.recoveryDeadline)?.recoveryDeadline).toBeTruthy();
      } else {
        const error = await turn.catch(err => err);
        expect(error).toBeInstanceOf(FatalAgentError);
        expect(error.failureClass).toBe('transient_overload');
        expect(error.attempts).toBe(TRANSIENT_MAX_ATTEMPTS);
        expect(delays).toEqual([5000, 10000, 20000, 40000, 60000]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// Full daemon/supervisor coverage: real sleeps, correlated response and task park.

for (const recovers of [true, false]) {
  test(`daemon publishes retries and ${recovers ? 'recovers' : 'records bounded transient exhaustion'}`, async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const configPath = join(ctx.root, 'lazy.toml');
      const config = await readFile(configPath, 'utf8');
      const patched = config.replace(/^#? ?auto_resume = true/m, 'auto_resume = false');
      expect(patched).not.toBe(config);
      await writeFile(configPath, patched);
      const id = await createTask(ctx, 'Retry recovery', 'Do the work');
      const failure = crashScenario({ stderr: 'API Error: 529 Overloaded\n' });
      await ctx.setClaudeScenario(recovers
        ? { sequence: [failure, failure, successScenario()] } : failure);
      expectSuccess(await ctx.lazy(['start', id, '--yes']));
      let visible = '';
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const show = await ctx.lazy(['show', id]);
        visible += show.stdout;
        if (visible.includes('attempt 2') && visible.includes('529')) break;
        await Bun.sleep(200);
      }
      expect(visible).toContain('retry');
      expect(visible).toContain('529');
      expect(visible).toContain('attempt 1');
      expect(visible).toContain('attempt 2');
      expect(visible).toContain('next retry at');
      const waited = await ctx.lazy(['wait', id]);
      expect(waited.exitCode).toBe(recovers ? 0 : 1);
      if (!recovers) expect(waited.stdout).toContain('interrupted');
      const turns = await agentTurns(ctx.root, id);
      expect(turns.length).toBeGreaterThan(0);
      if (!recovers) {
        expect(JSON.stringify(turns)).toContain('transient_overload');
        const interrupt = await sessionInterrupt(ctx.root, id);
        expect(interrupt.interrupt_reason).toContain('transient_overload');
        expect(Date.now() - start).toBeLessThan(220_000);
      }
      expect((await ctx.claudeInvocations()).length).toBeGreaterThanOrEqual(recovers ? 3 : 6);
    } finally { await ctx.cleanup(); }
  }, 250_000);
}

test('first live process retry is published, bounded and relaunched', async () => {
  const ctx = await setupTestLazy({ fakeClaude: true });
  try {
    const id = await createTask(ctx, 'Live retry', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [{ steps: [
      ...Array.from({ length: 100 }, (_, i) => [
        { kind: 'emit' as const, event: overloadedRetryEvent(i + 1) },
        { kind: 'sleep' as const, ms: 1000 },
      ]).flat(),
    ] }, successScenario()] });
    expectSuccess(await ctx.lazy(['start', id, '--yes']));
    const start = Date.now();
    let visible = '';
    while (Date.now() - start < 15_000) {
      visible = (await ctx.lazy(['show', id])).stdout;
      if (visible.includes('transient_overload')) break;
      await Bun.sleep(200);
    }
    expect(visible).toContain('transient_overload');
    expectSuccess(await ctx.lazy(['wait', id]));
    const invocations = await ctx.claudeInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    expect(invocations[1]!.at - invocations[0]!.at).toBeGreaterThan(60_000);
    expect(invocations[1]!.at - invocations[0]!.at).toBeLessThan(80_000);
    expect(Date.now() - start).toBeLessThan(95_000);
    expect((await agentTurns(ctx.root, id)).length).toBeGreaterThan(0);
  } finally { await ctx.cleanup(); }
}, 130_000);
