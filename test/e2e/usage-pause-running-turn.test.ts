/**
 * Stopping a RUNNING turn for spend, end to end through the real proxy:
 * `[usage_pause]` once the turn's credential crosses the threshold mid-turn,
 * and a task's own token cap (`lazy edit --token-cap`).
 *
 * Fake-binary seam: a real daemon launches a real `lazy supervise`, whose fake
 * agent makes real requests through the lazy proxy to a stub upstream. The
 * stub reports the Claude subscription usage headers and a token `usage` body,
 * so both the reading and the spend are ones the proxy actually captured.
 *
 * The proxy reuses a task's verdict for a few seconds, so the scenarios leave
 * a gap between requests longer than that.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { dirname, join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { allowTaskRpc } from '../helpers/usage-pause';
import { sessionStartEvent, toolUseEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { readTaskStatus, readSessionJson, findFullTaskId } from '../helpers/storage';
import { spawnSync } from 'child_process';

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number, stepMs = 250): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(stepMs);
    last = await read();
  }
  return last;
}

/** Proxied request → commit → (gap) → a second request, recorded → keeps working. */
function twoRequestsThenBusy(sessionId: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'http', expectStatus: 200 },
      { kind: 'commit', message: 'work before the stop', files: [{ path: 'kept.txt', content: 'kept\n' }] },
      { kind: 'sleep', ms: 6_500 },
      { kind: 'http', recordFile: 'second-request.json' },
      { kind: 'emit', event: toolUseEvent('toolu_busy', 'Bash') },
      { kind: 'sleep', ms: 120_000 },
    ],
  };
}

/** A resumed turn: one request, then done. */
function resumedTurn(sessionId: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'http', expectStatus: 200 },
      { kind: 'emit', event: resultEvent({ result: 'Finished after the reset.', sessionId }) },
    ],
  };
}

describe('usage pause stops running turns', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  let utilization = '0.10';
  let resetAtSec = Math.floor(Date.now() / 1000) + 3600;

  beforeEach(async () => {
    utilization = '0.10';
    resetAtSec = Math.floor(Date.now() / 1000) + 3600;
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text().catch(() => '');
        return Response.json(
          { type: 'message', model: 'claude-sonnet-4-6', usage: { input_tokens: 600, output_tokens: 400 } },
          {
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': utilization,
              'anthropic-ratelimit-unified-5h-reset': String(resetAtSec),
              'anthropic-ratelimit-unified-5h-status': Number(utilization) >= 0.9 ? 'allowed_warning' : 'allowed',
            },
          },
        );
      },
    });
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream.port}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
    await ctx.restartDaemon();
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
  });

  async function secondRequestStatus(): Promise<number | null> {
    try {
      const raw = await readFile(join(dirname(ctx.fakeClaudeBinDir!), 'second-request.json'), 'utf-8');
      return (JSON.parse(raw) as { status: number }).status;
    } catch {
      return null; // not written yet
    }
  }

  /** The commit the stopped turn made is still on the task's branch. */
  function branchHasKeptFile(taskId: string): boolean {
    const branch = readSessionJson(ctx.root, taskId)?.git_branch as string;
    const r = spawnSync('git', ['-C', ctx.root, 'log', '--format=%s', branch], { encoding: 'utf-8' });
    return r.stdout.includes('work before the stop');
  }

  // INVARIANT: with [usage_pause] set, a turn already RUNNING is stopped once
  // its credential crosses the threshold (engineer decision 2026-10-24): its
  // next model request is refused, the task is parked `interrupted` with the
  // work kept, and it resumes BY ITSELF once the window resets.
  test('a reading crossing the threshold mid-turn stops the turn, keeps the work, and resumes after the reset', async () => {
    const taskId = await createTask(ctx, 'Long audit', 'Work for a long time');
    await ctx.setClaudeScenario(twoRequestsThenBusy('run-1'));
    utilization = '0.97';
    resetAtSec = Math.floor(Date.now() / 1000) + 45;
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

    expect(await until(async () => readTaskStatus(ctx.root, taskId), (s) => s === 'interrupted', 60_000, 500)).toBe('interrupted');
    expect(await secondRequestStatus()).toBe(429);
    expect(branchHasKeptFile(taskId)).toBe(true);

    const show = await ctx.lazy(['show', taskId]);
    expect(show.stdout).toContain('Paused for usage: 5-hour window at 97%');
    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain('Paused for usage');

    // Held until the reset: no new agent launch.
    await ctx.clearClaudeInvocations();
    utilization = '0.05';
    await ctx.setClaudeScenario(resumedTurn('run-2'));
    await settle(4_000);
    expect(Date.now() / 1000).toBeLessThan(resetAtSec - 2);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('interrupted');
    expect((await ctx.claudeInvocations()).length).toBe(0);

    // After the reset it resumes with nobody running a command.
    const invocations = await until(() => ctx.claudeInvocations(), (inv) => inv.length > 0, 120_000, 500);
    expect(invocations.length).toBeGreaterThan(0);
    expect(branchHasKeptFile(taskId)).toBe(true);
  }, 240_000);

  // INVARIANT: the per-task allowance lifts a usage stop for that task's next
  // turn, and the turn it lets through is not stopped again for the window.
  test('letting the next turn through resumes a usage-stopped task now and runs it to its end', async () => {
    const taskId = await createTask(ctx, 'Allowed audit', 'Work');
    await ctx.setClaudeScenario(twoRequestsThenBusy('allow-1'));
    utilization = '0.97';
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), (s) => s === 'interrupted', 60_000, 500)).toBe('interrupted');

    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('allow-2') },
        { kind: 'http', expectStatus: 200 },
        { kind: 'sleep', ms: 6_500 },
        { kind: 'http', expectStatus: 200 },
        { kind: 'emit', event: resultEvent({ result: 'Done past the pause.', sessionId: 'allow-2' }) },
      ],
    });
    await allowTaskRpc(ctx, findFullTaskId(ctx.root, taskId), 'human');
    expect(await until(async () => readTaskStatus(ctx.root, taskId), (s) => s === 'blocked', 90_000, 500)).toBe('blocked');
  }, 240_000);

  // INVARIANT: at its own token cap a task's running turn stops the same way
  // but parks `blocked` and does NOT resume by itself; a launch is refused
  // naming the cap until a person raises it.
  test('a task at its token cap stops, waits, and runs again once the cap is raised', async () => {
    const taskId = await createTask(ctx, 'Capped audit', 'Work');
    expectSuccess(await ctx.lazy(['edit', taskId, '--token-cap', '1000']));
    await ctx.setClaudeScenario(twoRequestsThenBusy('cap-1'));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

    expect(await until(async () => readTaskStatus(ctx.root, taskId), (s) => s === 'blocked', 60_000, 500)).toBe('blocked');
    expect(await secondRequestStatus()).toBe(429);
    expect(branchHasKeptFile(taskId)).toBe(true);
    const show = await ctx.lazy(['show', taskId]);
    expect(show.stdout).toContain('Stopped at its token cap (1k of 1k)');
    expect(show.stdout).toContain('1k of 1k token cap');

    // Not resumed by itself, and an unblock is refused naming the cap.
    await settle(3_000);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const refused = await ctx.lazy(['unblock', taskId, '-m', 'keep going']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('token cap');

    expectSuccess(await ctx.lazy(['edit', taskId, '--token-cap', '50M']));
    await ctx.setClaudeScenario(resumedTurn('cap-2'));
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'keep going']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    // The stop banner is gone once the task has run again (the interrupt history keeps the reason).
    expect((await ctx.lazy(['show', taskId])).stdout).not.toMatch(/^\s+Stopped at its token cap/m);
  }, 240_000);
});
