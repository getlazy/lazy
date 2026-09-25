/**
 * [usage_pause] cannot silently do nothing and cannot be talked around —
 * end to end through the real proxy.
 *
 * Fake-binary seam, like test/e2e/usage-pause.test.ts: a real daemon launches a
 * real `lazy supervise`, whose fake agent makes a real request through the lazy
 * proxy to a stub upstream, so every reading is one the proxy captured.
 *
 * Covered:
 *   - armed with NO READING (the upstream sends no usage headers) is a warning
 *     in `lazy doctor`, `lazy daemon config get` and `lazy stats limits`;
 *   - a paused reading survives a daemon restart with the audit log deleted;
 *   - the one-shot override cannot be set by a non-human channel, nor from the
 *     CLI without a terminal, and the CLI never names it to the builder;
 *   - a cluster driver's `lazy_start` of a child on a paused credential is HELD,
 *     is waitable, and the child starts by itself after the reset;
 *   - `lazy pair` and `lazy chat` are refused while paused;
 *   - `lazy_conversation_ask` over the daemon's MCP route is refused while paused;
 *   - `lazy ask` on a finished task is refused by the pre-flight, before a
 *     question is collected.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, rm, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { launchAsPerson, setUsagePauseOverrideRpc } from '../helpers/usage-pause';
import { sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { findFullTaskId, readTaskJson, readTaskStatus, readTurns, storageDirFor, writeTaskJson } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { auditLogDir, readAuditRecords } from '../../src/proxy/audit-log';
import { USAGE_PAUSE_PENDING_START_KEY } from '../../src/usage-pause/hold';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, budgetMs: number, what: string): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
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

describe('usage pause hardening', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  /** What the stub reports; `null` = no usage headers at all. */
  let reading: () => { utilization: string; resetAtSec: number } | null;

  beforeEach(async () => {
    reading = () => ({ utilization: '0.10', resetAtSec: Math.floor(Date.now() / 1000) + 3600 });
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text().catch(() => '');
        const r = reading();
        return Response.json(
          { type: 'message', model: 'claude-sonnet-4-6' },
          r === null ? {} : {
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': r.utilization,
              'anthropic-ratelimit-unified-5h-reset': String(r.resetAtSec),
              'anthropic-ratelimit-unified-5h-status': Number(r.utilization) >= 0.9 ? 'allowed_warning' : 'allowed',
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
    // The proxy's upstream is read at daemon start.
    await ctx.restartDaemon();
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
    clearMcpTokenCache();
  });

  const client = () => DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);

  async function sawReading(pct: string): Promise<boolean> {
    const records = await readAuditRecords(join(ctx.root, '.lazy'), { limit: 50 });
    return records.some((r) => r.usageLimitHeaders?.['anthropic-ratelimit-unified-5h-utilization'] === pct);
  }

  /** One turn on a fresh task, whose request reads `utilization`; the task ends blocked. */
  async function pauseWithOneTurn(utilization: string, resetAtSec: number, goal = 'Paused task'): Promise<string> {
    reading = () => ({ utilization, resetAtSec });
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.setClaudeScenario(proxiedTurn(`sess-${goal.replace(/\W/g, '')}`));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await until(() => sawReading(utilization), Boolean, 10_000, `the ${utilization} reading`)).toBe(true);
    return taskId;
  }

  /** POST `lazy_usage_limits` to the daemon's MCP route as the builder; the last JSON line is the reply. */
  async function builderUsageLimits(): Promise<{ result?: any; error?: any }> {
    const token = await mintMcpToken(ctx.root, { kind: 'builder' }, 'e2e-builder');
    const target = getDaemonTcpTarget(ctx.root)!;
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/_/lazy_usage_limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: {} }),
    });
    const lines = (await resp.text()).trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  /** POST one tool call to the daemon's MCP route as `taskId`'s own agent. */
  async function agentTool(taskId: string, tool: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const fullId = findFullTaskId(ctx.root, taskId);
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullId }, 'e2e-agent');
    const target = getDaemonTcpTarget(ctx.root)!;
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/${fullId}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: args }),
    });
    return { status: resp.status, body: await resp.json().catch(() => null) };
  }

  // INVARIANT: pausing ARMED for a credential lazy spends turns on, with no
  // usable subscription reading for it, is LOUD — a warning in `lazy doctor`,
  // `lazy daemon config get` and `lazy stats limits`. The gate cannot tell it
  // from "not paused", so without these the feature silently did nothing
  // (the Claude header names are still unverified).
  test('armed with no reading is a warning on every surface, never OK', async () => {
    reading = () => null;
    const taskId = await createTask(ctx, 'No headers task', 'Do work');
    await ctx.setClaudeScenario(proxiedTurn('sess-noheaders'));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const config = await until(
      async () => (await ctx.lazy(['daemon', 'config', 'get'])).stdout,
      (out) => out.includes('Armed, NO READING'),
      15_000,
      'the no-reading line in daemon config get',
    );
    expect(config).toContain('pausing cannot engage');

    const limits = await ctx.lazy(['stats', 'limits']);
    expectSuccess(limits);
    expect(limits.stdout).toContain('ARMED, NO READING');

    const doctor = await ctx.lazy(['doctor']);
    const doctorOut = doctor.stdout + doctor.stderr;
    expect(doctorOut).toContain('armed, NO READING');
    expect(doctorOut).toContain('pausing cannot engage');

    // INVARIANT: the machine-readable surfaces say it too. `stats limits
    // --json` and `lazy_usage_limits` list the armed credential with
    // coverage `none` — an absent reading must not read as untouched headroom.
    const json = await ctx.lazy(['stats', 'limits', '--json']);
    expectSuccess(json);
    const armed = JSON.parse(json.stdout).pause.coverage.filter((c: { coverage: string }) => c.coverage === 'none');
    expect(armed).toHaveLength(1);
    const overMcp = await builderUsageLimits();
    expect(overMcp.error).toBeUndefined();
    expect(overMcp.result.pause.coverage.map((c: { credential: string; coverage: string }) => [c.credential, c.coverage]))
      .toEqual([[armed[0].credential, 'none']]);

    // And it is durable: with the audit log gone, a restarted daemon still
    // knows the credential spent turns with no reading, and doctor says so.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await rm(auditLogDir(join(ctx.root, '.lazy')), { recursive: true, force: true });
    expectSuccess(await ctx.lazy(['daemon', 'start']));
    const after = await ctx.lazy(['doctor']);
    expect(after.stdout + after.stderr).toContain('armed, NO READING');

    // INVARIANT: with the saved readings unreadable, the machine-readable
    // surfaces REFUSE, naming the file — never `readings: []`, which a builder
    // would plan from as untouched headroom.
    const readingsFile = join(storageDirFor(ctx.root), 'usage-limit-readings.json');
    expect((await readFile(readingsFile, 'utf-8')).length).toBeGreaterThan(0);
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await writeFile(readingsFile, '{ "readings": [ truncated');
    expectSuccess(await ctx.lazy(['daemon', 'start']));
    const refused = await ctx.lazy(['stats', 'limits', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).not.toContain('"readings"');
    expect(refused.stderr).toContain(`saved usage readings unreadable at ${readingsFile}`);
    const refusedMcp = await builderUsageLimits();
    expect(refusedMcp.result).toBeUndefined();
    expect(JSON.stringify(refusedMcp.error)).toContain(`saved usage readings unreadable at ${readingsFile}`);
    // The plain output still shows what it has, headed by the same warning.
    const plain = await ctx.lazy(['stats', 'limits']);
    expectSuccess(plain);
    expect(plain.stdout).toContain('SAVED READINGS UNREADABLE');
  }, 240_000);

  // INVARIANT: the CLI never names the one-shot override to the builder. Its
  // `lazy unblock` pre-flight and `lazy daemon config get` run in the
  // builder's own shell, and spelling the escape hatch out there undid the
  // daemon's refusal, which is careful not to.
  test('the builder channel is never shown the override command', async () => {
    const taskId = await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600, 'Builder hint task');
    const env = { LAZY_ACTOR: 'builder' };
    const refused = await ctx.lazy(['unblock', taskId, '-m', 'carry on'], { env });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('cannot be unblocked right now');
    expect(refused.stderr + refused.stdout).not.toContain('usage_pause_threshold');
    const config = await ctx.lazy(['daemon', 'config', 'get'], { env });
    expectSuccess(config);
    expect(config.stdout).toContain('Usage pause');
    // The general "Change for this daemon session" line (concurrency limits) stays.
    expect(config.stdout).not.toContain('usage_pause_threshold');
  }, 240_000);

  // INVARIANT: the builder's shell cannot CONSUME a person's one-shot override.
  // `lazy start` / `lazy unblock` carry the `human` channel for attribution
  // from any process; without a terminal they are judged like the builder's —
  // refused on a paused credential, the override left pending for the person
  // who set it, and the command never named in the refusal.
  test("a terminal-less start or unblock never spends a person's override", async () => {
    const paused = await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600, 'Paused A');
    const other = await createTask(ctx, 'Task B', 'More work');
    await setUsagePauseOverrideRpc(ctx, 'off');

    const unblock = await ctx.lazy(['unblock', paused, '-m', 'go on']);
    expect(unblock.exitCode).not.toBe(0);
    expect(unblock.stderr + unblock.stdout).toContain('paused');
    expect(unblock.stderr + unblock.stdout).not.toContain('usage_pause_threshold');
    const start = await ctx.lazy(['start', other, '--yes']);
    expect(start.exitCode).not.toBe(0);
    expect(start.stderr + start.stdout).toContain('was not started');
    expect(start.stderr + start.stdout).not.toContain('usage_pause_threshold');
    expect(await readTaskStatus(ctx.root, other)).toBe('backlog');
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');

    // …while the person it was set for can still use it, exactly once.
    await ctx.setClaudeScenario(proxiedTurn('person-start'));
    const person = await launchAsPerson(ctx, 'startTask', { taskId: findFullTaskId(ctx.root, other) });
    expect(person.exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).not.toContain('One-shot override');
  }, 240_000);

  // INVARIANT: the latest reading lives in Storage. With the bounded audit log
  // gone — what a long pause does to a paused credential's last reading — a
  // restarted daemon still pauses on it.
  test('a paused reading survives a restart with the audit log deleted', async () => {
    await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600);
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await rm(auditLogDir(join(ctx.root, '.lazy')), { recursive: true, force: true });
    expect(await readAuditRecords(join(ctx.root, '.lazy'), { limit: 50 })).toHaveLength(0);
    expectSuccess(await ctx.lazy(['daemon', 'start']));

    const other = await createTask(ctx, 'After the restart', 'More work');
    const refused = await ctx.lazy(['start', other, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('was not started');
    expect(refused.stderr + refused.stdout).toContain('97%');
    expect(await readTaskStatus(ctx.root, other)).toBe('backlog');
    expect((await ctx.lazy(['stats', 'limits'])).stdout).toContain('PAUSED');

    // INVARIANT: `lazy doctor` explains the DAEMON's state — the pause it seeded
    // from Storage (the audit log is gone) and its pending override — not what
    // the CLI process could reconstruct from the log on its own.
    await setUsagePauseOverrideRpc(ctx, 'off');
    const doctor = await ctx.lazy(['doctor']);
    const doctorOut = doctor.stdout + doctor.stderr;
    expect(doctorOut).toContain('97% used');
    expect(doctorOut).toContain('one-shot override is pending');

    // INVARIANT: nothing reaches the stored readings through the storage RPC —
    // a caller that could write one could lift the pause.
    for (const [method, args] of [
      ['saveUsageLimitReading', { reading: { credential: 'credential:CLAUDE_CODE_OAUTH_TOKEN', ts: Date.now(), upstream: '', backend: '', status: null, taskId: null, model: null, headers: {} } }],
      ['getUsageLimitReadings', {}],
    ] as const) {
      let refusal: RpcApplicationError | null = null;
      try {
        await client().rpc('storage', ctx.root, { method, args });
      } catch (err) {
        if (!(err instanceof RpcApplicationError)) throw err;
        refusal = err;
      }
      expect(refusal?.status).toBe(404);
    }
  }, 240_000);

  // INVARIANT: the one-shot override is the HUMAN's escape hatch. The daemon
  // refuses to set it for any other channel, and the CLI refuses without a
  // real terminal — which is how an agent or the builder runs it.
  test('the override cannot be set by an agent, the builder, nobody, or a CLI without a terminal', async () => {
    for (const actor of ['agent', 'builder', undefined]) {
      let refusal: RpcApplicationError | null = null;
      try {
        await client().rpc('usagePause', ctx.root, { action: 'set', value: 'off', ...(actor ? { actor } : {}) });
      } catch (err) {
        if (!(err instanceof RpcApplicationError)) throw err;
        refusal = err;
      }
      expect(refusal?.status).toBe(403);
    }
    const cli = await ctx.lazy(['daemon', 'config', 'set', 'usage_pause_threshold', 'off']);
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toContain('Refusing to set usage_pause_threshold');
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).not.toContain('One-shot override');

    // The human channel can, and every surface says when.
    await setUsagePauseOverrideRpc(ctx, 'off');
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toMatch(/One-shot override: off \(set \d{4}-/);
  }, 120_000);

  // INVARIANT: a cluster driver's start of its child on a paused credential is
  // HELD, not refused: nothing launches, the driver is told not to retry, the
  // child is waitable, and it starts by itself once the window resets.
  // INVARIANT (round 4): the driver is told to END its turn, not to wait — a
  // waiting driver re-polls with a model request on the paused credential every
  // wait timeout — and the daemon WAKES the parked driver once it has launched
  // the held child. No model request runs between the park and the reset.
  test("a driver's child start is held, the parked driver is woken after the reset", async () => {
    const created = await ctx.lazy([
      'create', '--goal', 'Paused cluster', '--prompt', 'Run the children', '--type', 'cluster',
    ]);
    expectSuccess(created);
    const clusterId = created.stdout.match(/Created task ([a-f0-9]{8})/)![1]!;
    const resetAtSec = Math.floor(Date.now() / 1000) + 50;
    reading = () => ({ utilization: '0.98', resetAtSec });
    await ctx.setClaudeScenario(proxiedTurn('cluster-1'));
    expectSuccess(await ctx.lazy(['start', clusterId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', clusterId]));
    expect(await until(() => sawReading('0.98'), Boolean, 10_000, 'the 98% reading')).toBe(true);
    reading = () => ({ utilization: '0.05', resetAtSec: Math.floor(Date.now() / 1000) + 3600 });

    // Created by the driver's own agent, so the cluster restart (which wakes a
    // cluster only for children somebody ELSE added) cannot be what wakes it.
    const made = await agentTool(clusterId, 'lazy_create', { goal: 'A child', prompt: 'x' });
    expect(made.status).toBe(200);
    const childId = made.body.result.id as string;
    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(proxiedTurn('child-1'));

    const started = await agentTool(clusterId, 'lazy_start', { task_id: childId });
    expect(started.status).toBe(200);
    expect(JSON.stringify(started.body)).toContain('HELD by the usage pause');
    expect(JSON.stringify(started.body)).not.toContain('usage_pause_threshold');
    expect(JSON.stringify(started.body)).toContain('END YOUR TURN');
    expect(await readTaskStatus(ctx.root, childId)).toBe('backlog');
    expect((readTaskJson(ctx.root, childId).metadata ?? {})[USAGE_PAUSE_PENDING_START_KEY]).toBeTruthy();
    expect((await ctx.claudeInvocations()).length).toBe(0);

    // Waitable while held: reported pending and held, not "has no session".
    const waited = await agentTool(clusterId, 'lazy_wait', { task_id: childId, timeout: 2 });
    expect(waited.status).toBe(200);
    expect(JSON.stringify(waited.body)).toContain('held_by_usage_pause');

    // Parked: nothing spends while the pause lasts.
    await sleep(6_000);
    expect(Date.now() / 1000).toBeLessThan(resetAtSec);
    expect((await ctx.claudeInvocations()).length).toBe(0);
    expect(await readTaskStatus(ctx.root, clusterId)).toBe('blocked');

    // INVARIANT: `lazy show` and `lazy doctor` never name the override command
    // outside a person's own terminal — doctor is where every refusal points,
    // the builder's and an agent's included. A held subtask START is released
    // by the reset alone (the override never replays it), and show says so.
    const shown = await ctx.lazy(['show', childId]);
    expectSuccess(shown);
    expect(shown.stdout).toContain('starts by itself after the reset');
    expect(shown.stdout).not.toContain('usage_pause_threshold off');
    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout + doctor.stderr).not.toContain('usage_pause_threshold off');

    // After the reset the reconciler starts it by itself — nobody asks again.
    const status = await until(
      () => readTaskStatus(ctx.root, childId),
      (s) => s !== 'backlog',
      120_000,
      'the held child to start after the reset',
    );
    expect(['working', 'blocked']).toContain(status);
    const invocations = await until(() => ctx.claudeInvocations(), (inv) => inv.length > 0, 30_000, "the child's agent");
    expect(invocations.length).toBeGreaterThan(0);
    expect((readTaskJson(ctx.root, childId).metadata ?? {})[USAGE_PAUSE_PENDING_START_KEY] ?? '').toBe('');

    // …and then wakes the parked driver, once, saying so.
    const woke = await until(
      () => readTurns(ctx.root, clusterId).some((t) => String((t as { content?: string }).content ?? '').includes('has now started')),
      Boolean,
      90_000,
      'the parked driver to be woken',
    );
    expect(woke).toBe(true);
  }, 300_000);

  // INVARIANT: `lazy pair` and `lazy chat` spend a credential like a turn, so a
  // paused one refuses them before the session opens — the task untouched.
  test('pair and chat are refused while paused', async () => {
    const taskId = await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const pair = await ctx.lazy(['pair', taskId]);
    expect(pair.exitCode).not.toBe(0);
    expect(pair.stderr).toContain('was not opened for pairing');
    expect(pair.stderr).toContain('paused');
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const chat = await ctx.lazy(['chat', taskId]);
    expect(chat.exitCode).not.toBe(0);
    expect(chat.stderr).toContain('was not started');
    expect(chat.stderr).toContain('paused');

    // INVARIANT (round 4): only a person at a real terminal may TAKE the
    // one-shot override, not merely set it. This test's CLI has no terminal on
    // stdin — exactly an agent's tool call, which `getActor()` alone would have
    // called `human` — so with an override pending, pair, chat and report are
    // still refused as paused, and the override stays for the person who set it.
    await setUsagePauseOverrideRpc(ctx, 'off');
    for (const args of [['pair', taskId], ['chat', taskId], ['report']]) {
      const refused = await ctx.lazy(args);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr + refused.stdout).toContain('paused');
    }
    expect((await ctx.lazy(['daemon', 'config', 'get'])).stdout).toContain('One-shot override: off');
  }, 240_000);

  // INVARIANT: only a start that could otherwise go ahead as a FIRST start is
  // held — the child in `backlog` with no turns. An agent starting a child that
  // already ran gets its ordinary answer, and nothing is written: no pending
  // start and no hold mark that could never be honoured.
  test("a driver's start of a child that already ran is refused, not held", async () => {
    const created = await ctx.lazy(['create', '--goal', 'Cluster', '--prompt', 'Run children', '--type', 'cluster']);
    expectSuccess(created);
    const clusterId = created.stdout.match(/Created task ([a-f0-9]{8})/)![1]!;
    await ctx.setClaudeScenario(proxiedTurn('cluster-own'));
    expectSuccess(await ctx.lazy(['start', clusterId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', clusterId]));

    const made = await agentTool(clusterId, 'lazy_create', { goal: 'A child that runs first', prompt: 'x' });
    expect(made.status).toBe(200);
    const childId = made.body.result.id as string;
    reading = () => ({ utilization: '0.97', resetAtSec: Math.floor(Date.now() / 1000) + 3600 });
    expectSuccess(await ctx.lazy(['start', childId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', childId]));
    expect(await until(() => sawReading('0.97'), Boolean, 10_000, 'the 97% reading')).toBe(true);
    const statusBefore = await readTaskStatus(ctx.root, childId);

    const started = await agentTool(clusterId, 'lazy_start', { task_id: childId });
    expect(started.status).not.toBe(200);
    expect(JSON.stringify(started.body)).not.toContain('HELD');
    const meta = (readTaskJson(ctx.root, childId).metadata ?? {}) as Record<string, string>;
    expect(meta[USAGE_PAUSE_PENDING_START_KEY] ?? '').toBe('');
    expect(meta.usage_pause_held ?? '').toBe('');
    expect(await readTaskStatus(ctx.root, childId)).toBe(statusBefore);
  }, 240_000);

  // INVARIANT: running inside the daemon is not a way around the gate —
  // `lazy_conversation_ask` served on the daemon's own MCP route is judged
  // like every other model run, as the channel asking.
  test('lazy_conversation_ask over the daemon MCP route is refused while paused', async () => {
    const taskId = await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600);
    const now = new Date().toISOString();
    await client().rpc('storage', ctx.root, { method: 'saveConversation', args: { conversation: {
      sessionId: 'c0ffee00-0000-4000-8000-000000000001', projectPath: 'p', cwd: null, version: null, gitBranch: null,
      startedAt: now, endedAt: now, importedAt: Date.now(), summary: 'A seeded conversation',
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      messages: [{ uuid: 'm1', parentUuid: null, timestamp: now, role: 'user', text: 'Hello.', model: null, usage: null }],
      subagents: [],
    } } });

    const asked = await agentTool(taskId, 'lazy_conversation_ask', {
      session_id: 'c0ffee00', question: 'What was said?',
    });
    expect(asked.status).toBe(429);
    expect(JSON.stringify(asked.body)).toContain('paused');
    expect(JSON.stringify(asked.body)).not.toContain('usage_pause_threshold');
  }, 240_000);

  // INVARIANT: `lazy ask` on a finished task (the record route, a one-shot on
  // the builder role's credential) is refused by the CLI pre-flight — before a
  // question is collected — not by the daemon after it.
  test('lazy ask on a finished task is refused before the question is taken', async () => {
    const taskId = await pauseWithOneTurn('0.97', Math.floor(Date.now() / 1000) + 3600);
    expectSuccess(await ctx.lazy(['close', taskId, '--reason', 'done', '--yes']));
    // The task's OWN credential is made unpaused (an agent lazy has no usage
    // signal for), so only the builder role's — what the record route really
    // spends — can explain a refusal here.
    writeTaskJson(ctx.root, taskId, { ...readTaskJson(ctx.root, taskId), agent_id: 'cursor' });
    const asked = await ctx.lazy(['ask', taskId, '--message', 'why?']);
    expect(asked.exitCode).not.toBe(0);
    expect(asked.stderr + asked.stdout).toContain('cannot be asked right now');
  }, 240_000);
});
