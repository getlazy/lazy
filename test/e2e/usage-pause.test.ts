/**
 * [usage_pause]: lazy stops STARTING turns on a credential once a subscription
 * usage window is past the threshold, end to end through the real proxy.
 *
 * Fake-binary seam: a real daemon launches a real `lazy supervise`, whose fake
 * agent makes a real request through the lazy proxy to a stub upstream. The
 * stub answers with the Claude subscription usage headers
 * (`anthropic-ratelimit-unified-5h-*`), so the reading the pause acts on is one
 * the proxy actually captured — nothing is seeded by hand.
 *
 * Covered:
 *   - a turn already running when the reading crosses the threshold finishes;
 *   - an explicit start/unblock above the threshold is refused, saying why;
 *   - the one-shot override lets exactly one PAUSED turn start, then reverts —
 *     and a launch it changes nothing for (an agent with no usage signal, an
 *     override below the reading) leaves it pending;
 *   - `lazy unblock --agent` is judged on the agent it switches to, and a start
 *     or unblock REFUSED with `--agent` leaves the stored agent as it was;
 *   - an auto-resume, and a cluster restart, the pause held go ahead by
 *     themselves after the reset, having consumed nothing while held.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { launchAsPerson, setUsagePauseOverrideRpc } from '../helpers/usage-pause';
import { sessionStartEvent, resultEvent, toolUseEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { readTaskStatus, readTurns, readTaskJson, findFullTaskId } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { installFakeCursor, setCursorScenario, readCursorInvocations, cursorSuccessScenario, type FakeCursor } from '../helpers/fake-cursor';
import { readAuditRecords } from '../../src/proxy/audit-log';

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

/** Session start → one proxied request → result. */
function proxiedTurn(sessionId: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'http', expectStatus: 200 },
      { kind: 'emit', event: resultEvent({ result: 'Did some work.', sessionId }) },
    ],
  };
}

/** Session start → one proxied request → keeps working (silent) for a long time. */
function proxiedThenBusy(sessionId: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'http', expectStatus: 200 },
      { kind: 'emit', event: toolUseEvent('toolu_busy', 'Bash') },
      { kind: 'sleep', ms: 120_000 },
    ],
  };
}

describe('usage pause', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  let cursorUpstream: ReturnType<typeof Bun.serve>;
  /** What the stub reports for the 5-hour window. */
  let utilization = '0.10';
  let resetAtSec = Math.floor(Date.now() / 1000) + 3600;

  async function editConfig(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream.port}"\n` +
        // Its OWN origin: the proxy maps credentials per origin, so sharing one
        // with the Anthropic upstream would file Claude traffic under Cursor's key.
        `cursor_upstream = "http://127.0.0.1:${cursorUpstream.port}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
  }

  async function sawReading(pct: string): Promise<boolean> {
    const records = await readAuditRecords(join(ctx.root, '.lazy'), { limit: 50 });
    return records.some((r) => r.usageLimitHeaders?.['anthropic-ratelimit-unified-5h-utilization'] === pct);
  }

  /**
   * A fake `cursor-agent` beside the fake claude: an agent lazy has no usage
   * signal for, so a turn on it is never paused. Symlinked into the claude
   * fake's bin dir (the one on the daemon's PATH); the fake resolves its state
   * dir through the link, so the two fakes keep separate scenarios.
   */
  async function addFakeCursor(): Promise<FakeCursor> {
    const fakeCursor = await installFakeCursor(await mkdtemp(join(tmpdir(), 'lazy-e2e-usage-pause-cursor-')));
    await symlink(join(fakeCursor.binDir, 'cursor-agent'), join(ctx.fakeClaudeBinDir!, 'cursor-agent'));
    return fakeCursor;
  }

  const savedCursorKey = process.env.CURSOR_API_KEY;

  beforeEach(async () => {
    // The daemon needs a Cursor credential to launch a cursor turn at all.
    process.env.CURSOR_API_KEY = 'cursor-test-key-usage-pause';
    utilization = '0.10';
    resetAtSec = Math.floor(Date.now() / 1000) + 3600;
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text().catch(() => '');
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
    cursorUpstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({}) });
    ctx = await setupTestLazy({ fakeClaude: true });
    await editConfig();
    // The proxy's upstream is read at daemon start.
    await ctx.restartDaemon();
  });

  afterEach(async () => {
    upstream.stop(true);
    cursorUpstream.stop(true);
    await ctx.cleanup();
    if (savedCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedCursorKey;
  });

  test('refuses starts and unblocks above the threshold; the override lets exactly one through', async () => {
    const taskId = await createTask(ctx, 'Usage pause task', 'Do work');
    await ctx.setClaudeScenario(proxiedTurn('pause-1'));

    // No reading yet, so the first turn starts. During it the upstream reports
    // 97% — past the threshold. INVARIANT: a turn already running is never
    // stopped by the pause; the gate only runs at launch.
    utilization = '0.97';
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');
    expect(await until(() => sawReading('0.97'), Boolean, 5_000)).toBe(true);

    const limits = await ctx.lazy(['stats', 'limits']);
    expectSuccess(limits);
    expect(limits.stdout).toContain('PAUSED');

    // INVARIANT: above the threshold an explicit unblock is refused before the
    // editor would open, naming credential, window, reading, threshold and reset.
    const refused = await ctx.lazy(['unblock', taskId, '-m', 'more please']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('paused');
    expect(refused.stderr).toContain('5-hour window');
    expect(refused.stderr).toContain('97%');
    expect(refused.stderr).toContain('95%');
    expect(refused.stderr).toContain('resets at');
    // INVARIANT: the harness is not a person at a terminal, so the CLI must not
    // name the one-shot override here — only a person at their own terminal is
    // told the command (the builder's shell would otherwise see it).
    expect(refused.stderr).not.toContain('usage_pause_threshold');
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // The daemon is the authority, not the CLI pre-flight: a start (which has
    // no pre-flight) is refused by the launch gate itself.
    const other = await createTask(ctx, 'Second task', 'More work');
    const refusedStart = await ctx.lazy(['start', other, '--yes']);
    expect(refusedStart.exitCode).not.toBe(0);
    expect(refusedStart.stderr + refusedStart.stdout).toContain('was not started');
    expect(await readTaskStatus(ctx.root, other)).toBe('backlog');

    // INVARIANT: `lazy unblock --agent` is judged on the agent the turn will
    // run on. The paused Claude task switched to cursor — an agent lazy has no
    // usage signal for — is not refused, by the CLI pre-flight or the daemon.
    // (Before any override is set, so nothing else could let it through.)
    const fakeCursor = await addFakeCursor();
    await setCursorScenario(fakeCursor, cursorSuccessScenario({ sessionId: 'cursor-free-1' }));
    const switched = await ctx.lazy(['unblock', taskId, '--agent', 'cursor', '-m', 'carry on in cursor']);
    expectSuccess(switched);
    expect(switched.stderr).not.toContain('paused');
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect((await readCursorInvocations(fakeCursor)).length).toBeGreaterThan(0);

    // INVARIANT: a start or unblock REFUSED by the pause leaves the task exactly
    // as it was — the `--agent` switch it asked for included. Judged by the
    // daemon itself: `lazy start` has no CLI pre-flight, and the unblock goes
    // straight to the RPC so the CLI pre-flight cannot answer for it.
    const cursorBorn = await createTask(ctx, 'Born on cursor', 'x', { agent: 'cursor' });
    const refusedSwitchStart = await ctx.lazy(['start', cursorBorn, '--agent', 'claude-code', '--yes']);
    expect(refusedSwitchStart.exitCode).not.toBe(0);
    expect(refusedSwitchStart.stderr + refusedSwitchStart.stdout).toContain('was not started');
    expect(readTaskJson(ctx.root, cursorBorn).agent_id).toBe('cursor');
    expect(await readTaskStatus(ctx.root, cursorBorn)).toBe('backlog');

    expect(readTaskJson(ctx.root, taskId).agent_id).toBe('cursor');
    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    let unblockRefusal: RpcApplicationError | null = null;
    try {
      await client.rpc('unblockTask', ctx.root, {
        taskId: findFullTaskId(ctx.root, taskId), message: 'back to claude', agentOverride: 'claude-code',
      });
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      unblockRefusal = err;
    }
    expect(unblockRefusal?.status).toBe(429);
    expect(readTaskJson(ctx.root, taskId).agent_id).toBe('cursor');
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // INVARIANT: an override that would not let a paused launch through is
    // not used by it. 96% does not cover a 97% reading: the start is refused,
    // says so, and the override stays pending.
    await setUsagePauseOverrideRpc(ctx, '96');
    // A person's launch: a test's CLI has no terminal, so it could never take
    // the override (test/helpers/usage-pause.ts, launchAsPerson).
    const tooLow = await launchAsPerson(ctx, 'startTask', { taskId: findFullTaskId(ctx.root, other) });
    expect(tooLow.exitCode).not.toBe(0);
    expect(tooLow.stderr + tooLow.stdout).toContain('does not cover this reading');
    // …and says what does: `off`, the value every surface recommends.
    expect(tooLow.stderr + tooLow.stdout).toContain('usage_pause_threshold off');
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: 96%');

    // INVARIANT: a launch the pause was not holding anyway never spends the
    // override. The task is on cursor now, so this unblock starts without it —
    // and the override its setter is about to use on a paused turn is still there.
    await setUsagePauseOverrideRpc(ctx, 'off');
    const cursorBefore = (await readCursorInvocations(fakeCursor)).length;
    expectSuccess(await launchAsPerson(ctx, 'unblockTask', { taskId: findFullTaskId(ctx.root, taskId), message: 'more cursor work' }));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect((await readCursorInvocations(fakeCursor)).length).toBeGreaterThan(cursorBefore);
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');

    // INVARIANT: the override is good for exactly ONE paused turn start, then
    // reverts. Back on Claude the task is paused again; the override lets this
    // one unblock through and is gone.
    expectSuccess(await launchAsPerson(ctx, 'unblockTask', {
      taskId: findFullTaskId(ctx.root, taskId), message: 'go on, once', agentOverride: 'claude-code',
    }));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const after = await ctx.lazy(['daemon', 'config', 'get']);
    expect(after.stdout).not.toContain('One-shot override');
    const refusedAgain = await launchAsPerson(ctx, 'unblockTask', { taskId: findFullTaskId(ctx.root, taskId), message: 'and again' });
    expect(refusedAgain.exitCode).not.toBe(0);
    expect(refusedAgain.stderr).toContain('paused');
  }, 240_000);

  test('an auto-resume the pause held goes ahead by itself once the window resets', async () => {
    const taskId = await createTask(ctx, 'Held resume task', 'Work slowly');
    await ctx.setClaudeScenario(proxiedThenBusy('held-1'));

    // The window resets soon after the reading, so the test can watch it lift.
    utilization = '0.98';
    resetAtSec = Math.floor(Date.now() / 1000) + 40;
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(() => sawReading('0.98'), Boolean, 30_000)).toBe(true);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('working');

    // Take the daemon down mid-turn: the task is left interrupted, and the new
    // daemon's auto-resume is the launch the pause must hold.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('interrupted');
    await ctx.clearClaudeInvocations();
    utilization = '0.05';
    await ctx.setClaudeScenario(proxiedThenBusy('held-2'));
    expectSuccess(await ctx.lazy(['daemon', 'start']));

    // Held: still interrupted, no agent launched, and `lazy show` says why.
    await settle(5_000);
    expect(Date.now() / 1000).toBeLessThan(resetAtSec - 2);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('interrupted');
    expect((await ctx.claudeInvocations()).length).toBe(0);
    const show = await ctx.lazy(['show', taskId]);
    expect(show.stdout).toContain('Usage pause');
    expect(show.stdout).toContain('auto-resume is waiting');
    // The first hold of the episode files one notice for whoever is not watching.
    const messages = await ctx.lazy(['messages']);
    expect(messages.stdout).toContain('paused');

    // INVARIANT: held work goes ahead by itself after the reset — nobody runs
    // a command. The reconciler re-offers the resume every tick, and the first
    // offer after the reset gets through the gate.
    const status = await until(async () => readTaskStatus(ctx.root, taskId), (s) => s === 'working', 90_000, 500);
    expect(status).toBe('working');
    const invocations = await until(() => ctx.claudeInvocations(), (inv) => inv.length > 0, 30_000, 500);
    expect(invocations.length).toBeGreaterThan(0);
    // And the mark is gone, so nothing reports a wait that is over.
    expect((await ctx.lazy(['show', taskId])).stdout).not.toContain('Usage pause');
  }, 240_000);

  test('a cluster restart the pause held is not used up, and goes ahead after the reset', async () => {
    const created = await ctx.lazy([
      'create', '--goal', 'Paused cluster', '--prompt', 'Run the children', '--type', 'cluster',
    ]);
    expectSuccess(created);
    const clusterId = created.stdout.match(/Created task ([a-f0-9]{8})/)![1];

    // The cluster's own turn reads 98% of a window that resets soon.
    utilization = '0.98';
    resetAtSec = Math.floor(Date.now() / 1000) + 50;
    await ctx.setClaudeScenario(proxiedTurn('cluster-1'));
    expectSuccess(await ctx.lazy(['start', clusterId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', clusterId]));
    expect(await readTaskStatus(ctx.root, clusterId)).toBe('blocked');
    expect(await until(() => sawReading('0.98'), Boolean, 5_000)).toBe(true);
    await ctx.clearClaudeInvocations();
    utilization = '0.05';

    // A child added to a blocked cluster would restart it — but not while paused.
    const child = await ctx.lazy(['create', '--goal', 'Arrived during the pause', '--prompt', 'x', '--parent', clusterId]);
    expectSuccess(child);
    const childId = child.stdout.match(/Created task ([a-f0-9]{8})/)![1];
    const restarted = () =>
      readTurns(ctx.root, clusterId).some((t) => String((t as { content?: string }).content ?? '').includes(childId));

    await settle(8_000);
    expect(Date.now() / 1000).toBeLessThan(resetAtSec - 2);
    expect(await readTaskStatus(ctx.root, clusterId)).toBe('blocked');
    expect((await ctx.claudeInvocations()).length).toBe(0);
    expect(restarted()).toBe(false);
    const show = await ctx.lazy(['show', clusterId]);
    expect(show.stdout).toContain('cluster restart is waiting');

    // INVARIANT: the held restart consumed nothing it retries from — the
    // child's arrival was not marked seen — so after the reset it goes ahead by
    // itself, and the restart turn names the child.
    const woke = await until(async () => restarted(), Boolean, 90_000, 500);
    expect(woke).toBe(true);
    const invocations = await until(() => ctx.claudeInvocations(), (inv) => inv.length > 0, 30_000, 500);
    expect(invocations.length).toBeGreaterThan(0);
  }, 240_000);
});
