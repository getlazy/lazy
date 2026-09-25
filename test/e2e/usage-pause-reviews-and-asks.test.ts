/**
 * [usage_pause] beyond work turns: the automatic review after a final, a
 * review's auto-fix, human reviews and asks, and a sync that needs an agent to
 * resolve a conflict — end to end through the real proxy.
 *
 * Fake-binary seam, like test/e2e/usage-pause.test.ts: a real daemon launches a
 * real `lazy supervise`, whose fake agent makes a real request through the lazy
 * proxy to a stub upstream. The stub answers with the Claude subscription usage
 * headers, so every reading the pause acts on is one the proxy captured from a
 * request — the work turn's, the reviewer's — and nothing is seeded by hand.
 *
 * Covered:
 *   - the automatic review after a final is HELD while paused: no reviewer
 *     runs, no review round and no auto-react budget is spent, a person's
 *     one-shot override is left alone — and it runs by itself after the reset;
 *   - a review whose OWN requests trip the pause holds its auto-fix before the
 *     round is counted, and the fix runs after the next reset;
 *   - a human `lazy review` and `lazy ask` are refused while paused, before
 *     anything is written, and the one-shot override lets exactly one through;
 *   - an automatic sync that hits a conflict is held (no agent launched, the
 *     queued sync kept), a human `lazy sync` of it is refused, and the held
 *     sync launches the agent by itself after the reset.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { launchAsPerson, setUsagePauseOverrideRpc } from '../helpers/usage-pause';
import { sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import {
  findFullTaskId,
  readTaskJson,
  readTaskStatus,
  readTurns,
  worktreePathFor,
  writeTaskJson,
  type StoredTurn,
} from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { readAuditRecords } from '../../src/proxy/audit-log';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';
import { USAGE_PAUSE_HELD_KEY, USAGE_PAUSE_PENDING_FIX_KEY } from '../../src/usage-pause/hold';
import { reviewWasNeverDispatched } from '../../src/review/verdict';
import type { ReviewReport } from '../../src/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowSec = () => Date.now() / 1000;

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, budgetMs: number, what: string): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const NEEDS_WORK_REPORT = JSON.stringify({
  verdict: 'needs_work',
  security: 'none found',
  data_integrity: 'none found',
  findings: [{ severity: 'high', category: 'correctness', summary: 'The retry path drops the last row.' }],
});

const CLEAN_REPORT = JSON.stringify({
  verdict: 'clean',
  security: 'none found',
  data_integrity: 'none found',
  findings: [],
});

/** Session start → one proxied request → result. */
function proxiedTurn(sessionId: string, result = 'Did some work.'): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'http', expectStatus: 200 },
      { kind: 'emit', event: resultEvent({ result, sessionId }) },
    ],
  };
}

/**
 * ONE scenario for every invocation — work turn, wrap-up resumes, reviewer and
 * fix alike (a turn is not one invocation, so aiming a scenario at the reviewer
 * by count is a guess; see test/e2e/review-dispatch-waits-for-park.test.ts). It
 * declares final through the handoff file, writes the presentation marker the
 * human-audience wrap-up needs, makes one proxied request (the reading), and
 * answers with a review report, which only a review turn parses.
 */
function everyInvocation(worktree: string, fullId: string, report: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent('sess-review') },
      {
        kind: 'write-file',
        path: join(worktree, '.lazy-task-sandbox', 'turn-handoff.jsonl'),
        content: JSON.stringify({ kind: 'final', content: 'Pencils down.' }) + '\n',
      },
      {
        kind: 'write-file',
        path: join(getProtocolDir(fullId), PRESENTATION_MARKER_FILE),
        content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }),
      },
      { kind: 'http', expectStatus: 200 },
      { kind: 'emit', event: resultEvent({ result: report, sessionId: 'sess-review' }) },
    ],
  };
}

function reviewTurns(ctx: TestContext, taskId: string): StoredTurn[] {
  return readTurns(ctx.root, taskId).filter((t) => t.role === 'agent' && t.turn_type === 'review');
}

/** Review turns a reviewer actually produced — not "[Review not started]" records. */
function ranReviews(ctx: TestContext, taskId: string): StoredTurn[] {
  return reviewTurns(ctx, taskId).filter((t) => !reviewWasNeverDispatched(t.review as ReviewReport | undefined));
}

describe('usage pause: reviews, asks and syncs', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  /** What the stub reports for the 5-hour window, asked afresh on every request. */
  let reading: () => { utilization: string; resetAtSec: number };

  async function editConfig(extra: (toml: string) => string = (t) => t): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = extra(await readFile(configPath, 'utf-8'));
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream.port}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
    // The proxy's upstream is read at daemon start.
    await ctx.restartDaemon();
  }

  async function sawReading(pct: string): Promise<boolean> {
    const records = await readAuditRecords(join(ctx.root, '.lazy'), { limit: 50 });
    return records.some((r) => r.usageLimitHeaders?.['anthropic-ratelimit-unified-5h-utilization'] === pct);
  }

  const meta = (taskId: string) => (readTaskJson(ctx.root, taskId).metadata ?? {}) as Record<string, string>;
  const holdOf = (taskId: string) => meta(taskId)[USAGE_PAUSE_HELD_KEY] ?? '';

  beforeEach(async () => {
    reading = () => ({ utilization: '0.10', resetAtSec: Math.floor(nowSec()) + 3600 });
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text().catch(() => '');
        const { utilization, resetAtSec } = reading();
        return Response.json(
          { type: 'message', model: 'claude-sonnet-4-6' },
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
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
  });

  // INVARIANT: the automatic review after a final is a DAEMON launch. On a
  // paused credential it is HELD — no reviewer runs, no review round and no
  // auto-react budget is spent, a person's one-shot override is never taken —
  // and nothing has to remember it: the catchup re-offers "a final with no
  // review after it" every tick, so it runs by itself after the reset. A
  // review whose own requests trip the pause then holds its AUTO-FIX before
  // the round is counted, and the fix runs after the next reset.
  test('the auto-review is held with nothing spent and runs after the reset; its auto-fix is held the same way', async () => {
    await editConfig((toml) => {
      const edited = toml
        .replace('# auto_react_backoff = "exponential"', 'auto_react_backoff = "none"')
        .replace('# max_auto_turns = 3', 'max_auto_turns = 8')
        .replace('# mode = "low_high"', 'mode = "separate"')
        .replace('# auto_fix = false', 'auto_fix = true');
      for (const key of ['auto_react_backoff = "none"', 'max_auto_turns = 8', 'mode = "separate"', 'auto_fix = true']) {
        if (!edited.includes(key)) throw new Error(`could not set ${key} in the init-produced lazy.toml`);
      }
      return edited;
    });

    // Two pause episodes back to back: the work turn's requests read 97% of a
    // window resetting at R1; once that has passed, the next request (the
    // reviewer's) reads 97% of a window resetting at R2; after that, 10%.
    const R1 = Math.floor(nowSec()) + 70;
    const R2 = R1 + 45;
    reading = () => {
      const now = nowSec();
      if (now < R1) return { utilization: '0.97', resetAtSec: R1 };
      if (now < R2) return { utilization: '0.97', resetAtSec: R2 };
      return { utilization: '0.10', resetAtSec: Math.floor(now) + 3600 };
    };

    const taskId = await createTask(ctx, 'Fix the retry path', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    await ctx.setClaudeScenario(everyInvocation(worktreePathFor(ctx.root, taskId), fullId, NEEDS_WORK_REPORT));

    // No reading yet, so the start goes through; the turn itself reads 97% and
    // finishes anyway — a running turn, and the nudges inside it, are exempt.
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await sawReading('0.97')).toBe(true);
    expect(readTurns(ctx.root, taskId).some((t) => t.final)).toBe(true);
    // A person's override, pending: the daemon's own launches must not take it.
    await setUsagePauseOverrideRpc(ctx, 'off');

    const round = () => parseInt(meta(taskId).final_review_round ?? '0', 10) || 0;
    const reviewBudget = () => parseInt(meta(taskId).auto_react_count_auto_review ?? '0', 10) || 0;

    // --- Episode 1: the auto-review is held ---
    await until(() => holdOf(taskId), (v) => v.includes('auto-review'), 45_000, 'the auto-review hold mark');
    const invocationsAtHold = (await ctx.claudeInvocations()).length;
    await sleep(8_000); // two more reconcile ticks: still nothing
    expect(nowSec()).toBeLessThan(R1 - 2);
    expect(ranReviews(ctx, taskId)).toHaveLength(0);
    expect((await ctx.claudeInvocations()).length).toBe(invocationsAtHold);
    expect(round()).toBe(0);
    expect(reviewBudget()).toBe(0);
    // Recorded like every other skip that can stand for hours, so accept is
    // gated on the unread work meanwhile.
    expect(reviewTurns(ctx, taskId).some((t) => String(t.content ?? '').includes('paused'))).toBe(true);
    expect((await ctx.lazy(['show', taskId])).stdout).toContain('auto-review is waiting');
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');

    // After R1 the catchup dispatches it by itself — nobody runs a command.
    const reviewed = await until(() => ranReviews(ctx, taskId), (r) => r.length > 0, 120_000, 'the held auto-review');
    expect((reviewed[0].review as ReviewReport).verdict).toBe('needs_work');
    expect(reviewBudget()).toBe(1);

    // --- Episode 2: the reviewer's own request tripped the pause again ---
    await until(() => holdOf(taskId), (v) => v.includes('review auto-fix'), 45_000, 'the auto-fix hold mark');
    expect(meta(taskId)[USAGE_PAUSE_PENDING_FIX_KEY]).toBeTruthy();
    expect(nowSec()).toBeLessThan(R2 - 2);
    const fixTurns = () =>
      readTurns(ctx.root, taskId).filter(
        (t) => t.role === 'agent' && (t.turn_type ?? 'work') === 'work' && (t.sequence ?? 0) > (reviewed[0].sequence ?? 0),
      );
    expect(fixTurns()).toHaveLength(0);
    expect(round()).toBe(0);

    // After R2 the held fix runs with the review's findings, and only now is
    // the round counted.
    await until(() => fixTurns().length, (n) => n > 0, 120_000, 'the held auto-fix turn');
    const feedback = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'human' && (t.sequence ?? 0) > (reviewed[0].sequence ?? 0),
    );
    expect(`${feedback?.content ?? ''}\n${(feedback as { prompt?: string } | undefined)?.prompt ?? ''}`)
      .toContain('The retry path drops the last row.');
    expect(round()).toBeGreaterThanOrEqual(1);
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');
  }, 360_000);

  // INVARIANT: a review or an ask a person asks for is REFUSED on a paused
  // credential with the start/unblock gate's message, before anything is
  // written — no turn, no status change. The one-shot override is for exactly
  // these launches, and lets exactly one through.
  test('a human review and ask are refused while paused; the override lets exactly one through', async () => {
    await editConfig();
    reading = () => ({ utilization: '0.97', resetAtSec: Math.floor(nowSec()) + 3600 });

    const taskId = await createTask(ctx, 'Paused review task', 'Do work');
    await ctx.setClaudeScenario(proxiedTurn('asked-1'));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(await until(() => sawReading('0.97'), Boolean, 5_000, 'the 97% reading')).toBe(true);
    const turnsBefore = readTurns(ctx.root, taskId).length;
    const invocationsBefore = (await ctx.claudeInvocations()).length;

    // A person's launch: a test's CLI has no terminal, so its refusal would not
    // name the override (test/helpers/usage-pause.ts, launchAsPerson).
    const review = await launchAsPerson(ctx, 'reviewTask', { taskId: findFullTaskId(ctx.root, taskId) });
    expect(review.exitCode).not.toBe(0);
    const reviewOut = review.stderr + review.stdout;
    expect(reviewOut).toContain('was not reviewed');
    expect(reviewOut).toContain('paused');
    expect(reviewOut).toContain('97%');
    expect(reviewOut).toContain('usage_pause_threshold');

    // The CLI refuses before the question is typed…
    const ask = await ctx.lazy(['ask', taskId, '-m', 'why this way?']);
    expect(ask.exitCode).not.toBe(0);
    expect(ask.stderr + ask.stdout).toContain('cannot be asked');
    // …and the daemon is the authority, without the CLI pre-flight.
    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    let askRefusal: RpcApplicationError | null = null;
    try {
      await client.rpc('askTask', ctx.root, { taskId: findFullTaskId(ctx.root, taskId), message: 'why this way?' });
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      askRefusal = err;
    }
    expect(askRefusal?.status).toBe(429);
    expect(askRefusal?.message).toContain('was not asked');

    expect(readTurns(ctx.root, taskId)).toHaveLength(turnsBefore);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect((await ctx.claudeInvocations()).length).toBe(invocationsBefore);

    // The override lets ONE review through, and is then gone.
    await ctx.setClaudeScenario(proxiedTurn('reviewer-1', CLEAN_REPORT));
    await setUsagePauseOverrideRpc(ctx, 'off');
    // A person's launch: a test's CLI has no terminal, so it could never take
    // the override (test/helpers/usage-pause.ts, launchAsPerson).
    expectSuccess(await launchAsPerson(ctx, 'reviewTask', { taskId: findFullTaskId(ctx.root, taskId) }));
    expect(ranReviews(ctx, taskId).length).toBeGreaterThan(0);
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).not.toContain('One-shot override');
    const again = await launchAsPerson(ctx, 'reviewTask', { taskId: findFullTaskId(ctx.root, taskId) });
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr + again.stdout).toContain('was not reviewed');
  }, 240_000);

  // INVARIANT: a sync runs an agent only for a conflict, and that is what the
  // pause gates. An AUTOMATIC sync that hits one is HELD — no agent launched,
  // the queued sync kept — and goes ahead by itself after the reset; a sync a
  // person asks for is refused, and does not drop the queued one.
  test('a conflict sync is held while paused and launches by itself after the reset', async () => {
    await editConfig();
    const resetAt = Math.floor(nowSec()) + 75;
    reading = () => ({ utilization: '0.97', resetAtSec: resetAt });

    const taskId = await createTask(ctx, 'Conflicting task', 'Edit the shared file');
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('sync-1') },
        { kind: 'commit', message: 'task side', files: [{ path: 'shared.txt', content: 'task side\n' }] },
        { kind: 'http', expectStatus: 200 },
        { kind: 'emit', event: resultEvent({ result: 'Edited the shared file.', sessionId: 'sync-1' }) },
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(await sawReading('0.97')).toBe(true);

    // Main edits the same file, so the parent merge conflicts.
    writeFileSync(join(ctx.root, 'shared.txt'), 'main side\n');
    expect(ctx.git('-C', ctx.root, 'add', 'shared.txt').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'main side').exitCode).toBe(0);

    await ctx.setClaudeScenario(proxiedTurn('sync-resolver'));
    await ctx.clearClaudeInvocations();
    // Queue a sync the way an upstream change does; the daemon's retry loop runs it.
    writeTaskJson(ctx.root, taskId, { ...readTaskJson(ctx.root, taskId), pending_sync: 1 });

    await until(() => holdOf(taskId), (v) => v.includes('conflict sync'), 45_000, 'the conflict-sync hold mark');
    await sleep(6_000);
    expect(nowSec()).toBeLessThan(resetAt - 2);
    expect((await ctx.claudeInvocations()).length).toBe(0);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(readTaskJson(ctx.root, taskId).pending_sync).toBeGreaterThan(0);
    expect(readTurns(ctx.root, taskId).some((t) => t.turn_type === 'sync')).toBe(false);
    expect((await ctx.lazy(['show', taskId])).stdout).toContain('conflict sync is waiting');

    // A person's sync of it is refused, says why, and keeps the queued one.
    const refused = await ctx.lazy(['sync', taskId]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('was not synced');
    expect(refused.stderr + refused.stdout).toContain('conflicts');
    expect(readTaskJson(ctx.root, taskId).pending_sync).toBeGreaterThan(0);
    expect((await ctx.claudeInvocations()).length).toBe(0);

    // After the reset the retry loop's next offer launches the agent.
    reading = () => ({ utilization: '0.10', resetAtSec: Math.floor(nowSec()) + 3600 });
    const launched = await until(() => ctx.claudeInvocations(), (inv) => inv.length > 0, 200_000, 'the held sync');
    expect(launched.length).toBeGreaterThan(0);
    expect(nowSec()).toBeGreaterThanOrEqual(resetAt);
  }, 360_000);
});
