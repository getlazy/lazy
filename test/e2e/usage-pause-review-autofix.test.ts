/**
 * A review's AUTO-FIX turn during a [usage_pause] is held, not lost.
 *
 * The auto-fix is a turn the DAEMON starts after a review settles — and a
 * review settles exactly once, so a fix refused at launch was never run. It
 * also rode the explicit unblock path with the reviewer as actor, so it could
 * spend a person's pending one-shot override.
 *
 * Here the review is one a PERSON asks for with auto-fix on (the review RPC's
 * `autoFix`, as a driver's `lazy_review` sets it), let through a pause by their
 * one-shot override; the fix it would start is the daemon's. The AUTOMATIC
 * review after a final is itself held while paused, so the auto-review path —
 * where the round is counted, and the hold must come first — is covered where
 * a pause can start mid-review: test/e2e/usage-pause-reviews-and-asks.test.ts.
 *
 * Runs on the module mock, like test/e2e/auto-review.test.ts. The pause comes
 * from a reading in the proxy audit log, which the daemon seeds its usage view
 * from at start (the mock agent makes no proxied requests).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { launchAsPerson, setUsagePauseOverrideRpc } from '../helpers/usage-pause';
import { findFullTaskId, readTaskJson, readTurns, type StoredTurn } from '../helpers/storage';
import { auditLogPath } from '../../src/proxy/audit-log';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { USAGE_PAUSE_HELD_KEY, USAGE_PAUSE_PENDING_FIX_KEY } from '../../src/usage-pause/hold';

const NEEDS_WORK_REPORT = {
  verdict: 'needs_work',
  security: 'none found',
  data_integrity: 'none found',
  findings: [
    { severity: 'high', category: 'correctness', summary: 'The retry path drops the last row.' },
  ],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, budgetMs: number, what: string): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

/** One audit record carrying a Claude subscription reading, for `credential`. */
function readingLine(i: number, credential: string, utilization: string, resetSec: number): string {
  return JSON.stringify({
    id: `usage-${i}`, seq: i, ts: Date.now(), role: 'agent', taskId: null, backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model: 'claude-opus', tier: 'opus', stream: true, requestShape: null, toolUses: [], toolResults: [],
    status: 200, usage: null, stopReason: null, error: null, durationMs: 5, reroute: null, enforcement: null,
    credential,
    usageLimitHeaders: {
      'anthropic-ratelimit-unified-5h-utilization': utilization,
      'anthropic-ratelimit-unified-5h-reset': String(resetSec),
    },
  });
}

describe('review auto-fix under a usage pause', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({ result: JSON.stringify(NEEDS_WORK_REPORT), session_id: 'mock-reviewer' }),
      },
    });
    // Same edits as the auto-review suite, INSIDE the init-produced sections,
    // each asserted to have changed something.
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    const edited = before
      .replace('# auto_react_backoff = "exponential"', 'auto_react_backoff = "none"')
      .replace('# max_auto_turns = 3', 'max_auto_turns = 8')
      .replace('# mode = "low_high"', 'mode = "separate"')
      .replace('# auto_fix = false', 'auto_fix = true');
    for (const key of ['auto_react_backoff = "none"', 'max_auto_turns = 8', 'mode = "separate"', 'auto_fix = true']) {
      if (!edited.includes(key)) throw new Error(`could not set ${key} in the init-produced lazy.toml`);
    }
    // [usage_pause] is not in the init template, so it is appended once.
    await writeFile(path, `${edited}\n[usage_pause]\nthreshold_percent = 95\n`);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a review's auto-fix is a DAEMON launch. While paused it is held
  // with nothing counted, it never spends a person's one-shot override, and it
  // runs by itself after the reset — a review settles once, so a refusal would
  // have lost it for good.
  test('the fix is held with nothing counted, keeps the override untouched, and runs after the reset', async () => {
    // 97% of a window that resets soon — long enough for the review to settle
    // inside it, short enough for the test to watch it lift.
    const resetSec = Math.floor(Date.now() / 1000) + 75;
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(logPath), { recursive: true });
    // Under both names Claude Code's credential can have: whichever the daemon's
    // environment resolves to is the one its gate reads.
    await writeFile(logPath, [
      readingLine(1, 'credential:ANTHROPIC_API_KEY', '0.97', resetSec),
      readingLine(2, 'credential:CLAUDE_CODE_OAUTH_TOKEN', '0.97', resetSec),
    ].join('\n') + '\n');
    // The daemon folds the audit log into its usage view once, at first read.
    await ctx.restartDaemon();

    const taskId = await createTask(ctx, 'Fix the retry path', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);

    // The start is paused too; a person lets it through with the override.
    // (No final is declared, so no automatic review is owed.)
    await setUsagePauseOverrideRpc(ctx, 'off');
    // A person's launch: a test's CLI has no terminal, so it could never take
    // the override (test/helpers/usage-pause.ts, launchAsPerson).
    expectSuccess(await launchAsPerson(ctx, 'startTask', { taskId: fullId }));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // A person asks for a review with auto-fix, and lets THAT through too.
    await setUsagePauseOverrideRpc(ctx, 'off');
    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    await client.rpc('reviewTask', ctx.root, { taskId: fullId, autoFix: true, usagePauseOverrideEligible: true });
    // …and sets it again. The daemon's own launches must never take it.
    await setUsagePauseOverrideRpc(ctx, 'off');

    const agentTurns = (): StoredTurn[] => readTurns(ctx.root, taskId).filter((t) => t.role === 'agent');
    const reviewTurn = (await until(
      () => agentTurns().find((t) => t.turn_type === 'review'),
      Boolean,
      30_000,
      'the review turn',
    ))!;
    const fixTurns = () =>
      agentTurns().filter((t) => (t.turn_type ?? 'work') === 'work' && (t.sequence ?? 0) > (reviewTurn.sequence ?? 0));
    const meta = () => (readTaskJson(ctx.root, fullId).metadata ?? {}) as Record<string, string>;
    const round = () => parseInt(meta().final_review_round ?? '0', 10) || 0;

    // Held: marked, pending, no fix turn, nothing counted, override untouched.
    await until(() => meta()[USAGE_PAUSE_HELD_KEY] ?? '', (v) => v.includes('review auto-fix'), 30_000, 'the hold mark');
    expect(meta()[USAGE_PAUSE_PENDING_FIX_KEY]).toBeTruthy();
    await sleep(8_000); // two more reconcile ticks: still nothing
    expect(Date.now() / 1000).toBeLessThan(resetSec - 2);
    expect(fixTurns()).toHaveLength(0);
    expect(round()).toBe(0);
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');
    expect((await ctx.lazy(['show', taskId])).stdout).toContain('review auto-fix is waiting');

    // After the reset the sweep re-runs the settle, and the fix turn runs with
    // the review's findings as its brief.
    await until(() => fixTurns().length, (n) => n > 0, 120_000, 'the held auto-fix turn');
    const feedback = readTurns(ctx.root, taskId).find(
      (t) => t.role === 'human' && (t.sequence ?? 0) > (reviewTurn.sequence ?? 0),
    );
    expect(`${feedback?.content ?? ''}\n${(feedback as { prompt?: string } | undefined)?.prompt ?? ''}`)
      .toContain('The retry path drops the last row.');
    expect(meta()[USAGE_PAUSE_PENDING_FIX_KEY] ?? '').toBe('');
    // Still the person's to use.
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');
  }, 300_000);
});
