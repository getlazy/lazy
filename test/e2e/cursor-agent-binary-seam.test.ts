/**
 * Cursor turns on the fake-BINARY seam — the launch contract, executed.
 *
 * Everything between "the daemon decided to run a cursor turn" and
 * "`cursor-agent` was executed" had coverage only against functions called
 * directly: `buildExecArgs` in a unit test, `cursorLaunchEnvVars` in another,
 * and — for the proxy route — `test/e2e/proxy-cursor-passthrough.test.ts`,
 * which starts a real daemon but SYNTHESIZES the HTTP request itself. Nothing
 * proved that a launched cursor turn actually receives that argv, actually
 * holds a placeholder instead of the real key, or that its OWN traffic carries
 * the placeholder segment the proxy expects.
 *
 * This suite runs the whole thing unmocked — daemon → HostProcessRunner →
 * a real `lazy supervise` → `CursorAgent` → a fake `cursor-agent` on PATH (see
 * test/helpers/fake-cursor.ts) — and asserts on what that binary was handed.
 *
 * The fake's stream-json events are the real ones (read off the shipped
 * cursor-agent bundle — see docs/cursor-stream-json.md), so the watchdog cases
 * below exercise the guard against the format Cursor actually produces.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import {
  cursorSuccessScenario,
  cursorProxiedCallScenario,
  cursorBusyScenario,
  cursorGoSilentScenario,
} from '../helpers/fake-cursor';
import { setGuards, agentTurns, sessionInterrupt } from '../helpers/agent-seam';
import { readTaskStatus } from '../helpers/storage';
import { looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';
import { CURSOR_PROXY_PREFIX } from '../../src/proxy/cursor-route';
import { auditLogPath } from '../../src/proxy/audit-log';

/**
 * The Cursor key the DAEMON holds. The launch must never hand this to the agent
 * process — the proxy swaps it in per request — so it is both what the stub
 * upstream must see and what the recorded agent env must not contain.
 */
const REAL_CURSOR_KEY = 'key_THE_REAL_CURSOR_KEY_FOR_THE_BINARY_SEAM';

type Seen = { method: string; path: string; auth: string | null };

describe('cursor turns through the fake-binary seam', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  let savedCursorKey: string | undefined;
  const seen: Seen[] = [];

  /** The invocations that are real TURNS (probes are never recorded). */
  async function turnInvocations() {
    const all = await ctx.cursorInvocations();
    return all.filter(i => i.argv.includes('--print'));
  }

  /**
   * Read an env var the agent's own process actually held.
   *
   * A recorded value of `null` is MEANINGFUL — the fake writes it when the key
   * was absent from its environment entirely, which is a different failure from
   * "present but wrong". Fail on it here, by name, so a launch that forgot a
   * variable says so instead of surfacing as a confusing string mismatch three
   * assertions later. Returning `string` also gives the callers below a
   * genuinely non-null value rather than one cast into shape.
   */
  function requireEnv(env: Record<string, string | null>, key: string): string {
    const value = env[key];
    expect(value, `the cursor turn was launched without ${key}`).not.toBeNull();
    if (typeof value !== 'string') {
      throw new Error(`${key} was not recorded for the cursor turn (got ${String(value)})`);
    }
    return value;
  }

  /** Poll until `check` passes or the budget runs out; returns the last value. */
  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
    const deadline = Date.now() + budgetMs;
    let last = await read();
    while (!ok(last) && Date.now() < deadline) {
      await Bun.sleep(100);
      last = await read();
    }
    return last;
  }

  /** Cursor-backend audit records the proxy has written so far. */
  async function cursorAuditRecords(expected: number): Promise<Array<Record<string, any>>> {
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    return await until(
      async () => {
        const raw = await readFile(logPath, 'utf-8').catch(() => '');
        return raw.trim().split('\n').filter(Boolean)
          .map(l => JSON.parse(l) as Record<string, any>)
          .filter(r => r.backend === 'cursor');
      },
      recs => recs.length >= expected,
      10_000,
    );
  }

  /**
   * Point the cursor route at the stub upstream and restart the daemon so the
   * new config takes effect.
   *
   * The section is APPENDED rather than key-rewritten because the init template
   * mentions `[proxy]` only in comments — asserted, so a template change that
   * starts writing a real section fails here instead of producing a duplicate
   * key error at load time.
   */
  async function pinCursorUpstreamAndRestart(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\ncursor_upstream = "http://127.0.0.1:${upstream.port}"\n`,
    );
    expectSuccess(await ctx.lazy(['daemon', 'restart']));
  }

  beforeEach(async () => {
    seen.length = 0;
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({
          method: req.method,
          path: u.pathname + u.search,
          auth: req.headers.get('authorization'),
        });
        await req.text().catch(() => '');
        return Response.json({ ok: true });
      },
    });

    // The key the daemon holds, pinned on THIS process's environment so every
    // process the context spawns inherits it — the first daemon, and the one
    // `daemon restart` starts below.
    //
    // It used to be written to the per-project credentials file instead, on the
    // reasoning that `resolveAgentApiKey` reads env first and then that file, so
    // the file survives a restart while `daemonEnv` does not. That could never
    // work: the daemon's credential GATE (src/daemon/credential-gate.ts) does
    // not consult the per-agent file at all — it asks `credentialAvailable`,
    // which knows only the environment and the credential store — so with
    // `agent_id = "cursor"` and an empty store the daemon refused to start
    // before the file was ever written, and supplying a key in the environment
    // to get past that then won the resolution and became the key the proxy
    // swapped in. The suite was red either way.
    savedCursorKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = REAL_CURSOR_KEY;

    ctx = await setupTestLazy({ fakeCursor: true });
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
    if (savedCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedCursorKey;
  });

  test('a launched turn gets the argv and proxy env cursor expects', async () => {
    const taskId = await createTask(ctx, 'Cursor argv contract', 'Do the cursor thing');

    await ctx.setCursorScenario({
      sequence: [
        cursorSuccessScenario({
          sessionId: 'fake-chat-turn-1',
          result: 'First turn done.',
          commit: { message: 'Cursor turn 1', files: [{ path: 'cursor-1.txt', content: 'one\n' }] },
        }),
        // Every later invocation — the turn's own supervisor follow-ups (low-high
        // self-review, wrap-up walkthrough) and the unblock turn — resumes that
        // chat, and a resumed cursor chat keeps its id. No commit: the fake
        // replays this entry for each of them, and a repeated commit fails.
        cursorSuccessScenario({ sessionId: 'fake-chat-turn-1', result: 'Second turn done.' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length, 'the fake cursor-agent was never launched for a turn').toBeGreaterThan(0);
    const argv = turns[0]!.argv;

    // The flag block CursorAgent.buildExecArgs opens with, in order.
    // INVARIANT (fix-cursor-silent-watchdog): stream-json, never the single-blob
    // `json`. In `json` mode cursor-agent writes nothing until the turn ends, so
    // the supervisor's no-progress guard saw silence and killed every turn
    // longer than its window.
    expect(argv.slice(0, 4)).toEqual(['--print', '--output-format', 'stream-json', '--trust']);
    // Bypass permission mode → run-everything with Cursor's own sandbox off
    // (lazy only sets this when the process is already isolated or the human
    // chose bypass, which is what the fake-binary seam runs as).
    expect(argv.join(' ')).toContain('--force --sandbox disabled');
    // SECURITY: --approve-mcps is deliberately never passed — it would approve
    // every repo-supplied .cursor/mcp.json server in the worktree.
    expect(argv).not.toContain('--approve-mcps');
    // The model is ALWAYS passed, `auto` included (fix-cursor-model-turn-setting:
    // omitting it silently runs whatever model ~/.cursor/cli-config.json holds).
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBeTruthy();
    // First turn: no session to resume yet.
    expect(argv).not.toContain('--resume');
    // Prompt is the last positional and carries the task's own prompt.
    expect(argv[argv.length - 1]).toContain('Do the cursor thing');

    // The proxy env the launch built. CURSOR_API_KEY holds a MINTED PLACEHOLDER
    // — the real key stays in the daemon and is injected per request — and
    // CURSOR_API_ENDPOINT points the agent at that placeholder's route.
    const env = turns[0]!.env;
    const placeholder = requireEnv(env, 'CURSOR_API_KEY');
    expect(looksLikeLazyPlaceholder(placeholder)).toBe(true);
    expect(placeholder).not.toBe(REAL_CURSOR_KEY);
    expect(JSON.stringify(turns)).not.toContain(REAL_CURSOR_KEY);

    const endpoint = requireEnv(env, 'CURSOR_API_ENDPOINT');
    expect(endpoint).toContain(`${CURSOR_PROXY_PREFIX}/${placeholder}`);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    // Same value on the flag: a server-supplied agentUrl must not be able to
    // redirect the agent stream around the proxy.
    expect(argv).toContain('--agent-endpoint');
    expect(argv[argv.indexOf('--agent-endpoint') + 1]).toBe(endpoint);

    // Second turn: the session cursor reported is resumed rather than started
    // fresh. This is the half of the argv contract a single turn cannot show.
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Keep going please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterUnblock = await turnInvocations();
    expect(afterUnblock.length).toBeGreaterThan(turns.length);
    // The unblock turn's WORK invocation — found by its prompt, not by being
    // last: the turn's own wrap-up invocations run after it.
    const unblocked = afterUnblock.filter(i => String(i.argv[i.argv.length - 1]).includes('Keep going please'));
    expect(unblocked.length, 'the unblock turn never launched cursor').toBe(1);
    const second = unblocked[0]!.argv;
    expect(second).toContain('--resume');
    expect(second[second.indexOf('--resume') + 1]).toBe('fake-chat-turn-1');
  }, 180_000);

  // INVARIANT: cursor traffic rides lazy's proxy, always — and the agent never
  // holds the key it is spending. proxy-cursor-passthrough proves the route
  // answers when something dials it; this proves the LAUNCH is what dials it.
  test('the turn\'s own traffic carries the placeholder and is audited', async () => {
    await pinCursorUpstreamAndRestart();

    const taskId = await createTask(ctx, 'Cursor proxy route', 'Call the API');
    await ctx.setCursorScenario(cursorProxiedCallScenario({
      sessionId: 'fake-chat-proxy-1',
      httpPath: '/aiserver.v1.ChatService/StreamUnifiedChat?v=2',
      commit: { message: 'Cursor proxied turn', files: [{ path: 'cursor-proxy.txt', content: 'x\n' }] },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length).toBeGreaterThan(0);
    const placeholder = requireEnv(turns[0]!.env, 'CURSOR_API_KEY');

    // The stub upstream saw the request the AGENT made: path forwarded verbatim
    // (credential segment stripped), and the real key swapped in for the
    // placeholder the agent process actually held.
    expect(seen.length, 'the launched turn never reached the stub upstream').toBeGreaterThan(0);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/aiserver.v1.ChatService/StreamUnifiedChat?v=2');
    expect(seen[0]!.auth).toBe(`Bearer ${REAL_CURSOR_KEY}`);
    expect(seen[0]!.auth).not.toContain(placeholder);

    // Attribution is EVIDENCE: role and task come from the grant the launch
    // minted, not from anything the agent put in the URL.
    const records = await cursorAuditRecords(1);
    expect(records.length).toBeGreaterThan(0);
    const rec = records[0]!;
    expect(rec.role).toBe('agent');
    expect(rec.taskId).toBeTruthy();
    expect(taskId.startsWith(String(rec.taskId)) || String(rec.taskId).startsWith(taskId)).toBe(true);
    expect(rec.status).toBe(200);
    // Coarse by design — the Anthropic wire extractor must never read a cursor
    // request, so these stay empty rather than guessed.
    expect(rec.model).toBeNull();
    expect(rec.usage).toBeNull();
  }, 180_000);

  // INVARIANT (fix-cursor-silent-watchdog): a WORKING cursor turn is never
  // killed for taking a long time. This is the regression: on the single-blob
  // `--output-format json` the agent wrote nothing until it exited, so the
  // no-progress guard measured "how long may a turn take" and killed every turn
  // longer than the window — three consecutive 30-minute kills on one real task
  // (2026-09-08), the work landing only because the retry ladder resumed the
  // dirty worktree. The turn below runs for far longer than its own guard and
  // must finish, because its stream-json events are forward progress.
  test('a long cursor turn that keeps emitting events is NOT killed', async () => {
    await setGuards(ctx, { noProgressMs: 4_000 });

    const taskId = await createTask(ctx, 'Long cursor turn', 'Work for a while');
    await ctx.setCursorScenario({ sequence: [
      cursorBusyScenario({
        sessionId: 'fake-chat-busy',
        toolCalls: 8,
        gapMs: 1_000,   // 16s of work under a 4s no-progress window
        result: 'Finished the long turn.',
        commit: { message: 'Cursor long turn', files: [{ path: 'cursor-long.txt', content: 'long\n' }] },
      }),
      // The turn's own supervisor follow-ups (low-high self-review, wrap-up
      // walkthrough): short, and without the commit a replay would repeat.
      cursorSuccessScenario({ sessionId: 'fake-chat-busy', result: 'Follow-up done.' }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // One launch of the WORK, not a retry ladder: the turn was never killed.
    // Counted by the task's own prompt — the supervisor's follow-up
    // invocations after a finished turn are not retries.
    const turns = await turnInvocations();
    const workLaunches = turns.filter(i => String(i.argv[i.argv.length - 1]).includes('Work for a while'));
    expect(workLaunches.length).toBe(1);
    expect((await sessionInterrupt(ctx.root, taskId)).interrupt_reason ?? null).toBeNull();

    // The work invocation's turn, first of the bundle, carries its result.
    const recorded = await agentTurns(ctx.root, taskId);
    expect(String(recorded[0]!.content)).toContain('Finished the long turn.');
  }, 180_000);

  // The other half, and the reason the guard is not simply disabled for cursor:
  // a genuinely wedged turn must still die.
  test('a cursor turn that goes silent mid-turn is still killed', async () => {
    await setGuards(ctx, { noProgressMs: 4_000 });

    const taskId = await createTask(ctx, 'Wedged cursor turn', 'Do the work');
    await ctx.setCursorScenario(cursorGoSilentScenario({
      sessionId: 'fake-chat-silent',
      silentMs: 120_000,
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    // `wait` exits nonzero for a turn that ended ungracefully — that IS the
    // signal here. A watchdog kill lands the task in `interrupted`.
    const wait = await ctx.lazy(['wait', taskId]);
    expect(wait.exitCode).not.toBe(0);
    expectOutput(wait, 'interrupted');

    const interrupt = await sessionInterrupt(ctx.root, taskId);
    expect(String(interrupt.interrupt_reason)).toMatch(/watchdog|no forward progress/i);
    // Progress-based wording, not the byte-level "no output" — proof the guard
    // is now reading cursor's event stream rather than counting bytes.
    expect(String(interrupt.interrupt_reason)).toContain('no forward progress');
  }, 180_000);

  // INVARIANT: Cursor's init `model` is the concrete id that lands on the turn
  // as `model_id`. The result object has no model field, so if this is missing
  // every Cursor turn looks like it ran the requested alias.
  test('a cursor turn records the init-line model as model_id', async () => {
    const taskId = await createTask(ctx, 'Cursor actual model', 'Do the work');
    // Sequence form: entry 0 is the work invocation, entry 1 every supervisor
    // follow-up of the same turn (low-high self-review, wrap-up walkthrough),
    // which reports the same concrete model and must not replay the commit.
    await ctx.setCursorScenario({ sequence: [
      cursorSuccessScenario({
        sessionId: 'fake-chat-actual-model',
        model: 'claude-opus-4-5-20251101',
        result: 'Ran the resolved model.',
        commit: { message: 'Cursor actual model', files: [{ path: 'cursor-model.txt', content: 'ok\n' }] },
      }),
      cursorSuccessScenario({ sessionId: 'fake-chat-actual-model', model: 'claude-opus-4-5-20251101' }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--model', 'opus']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await agentTurns(ctx.root, taskId);
    // EVERY agent turn of the bundle: the work turn (model attached from the
    // activity stream), the low-high self-review and apply turns (which parse
    // only the isolated result line), and the walkthrough (raw stdout). Each
    // reaches the init model by a different path; checking only the last turn
    // proved one of them.
    expect(turns.length).toBeGreaterThan(1);
    for (const turn of turns) {
      expect(turn.model).toBe('opus');
      expect(turn.model_id, `turn "${String(turn.content).slice(0, 60)}" recorded no model_id`)
        .toBe('claude-opus-4-5-20251101');
    }
  }, 180_000);
});
