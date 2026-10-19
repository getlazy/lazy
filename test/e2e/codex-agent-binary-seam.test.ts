/**
 * Codex turns on the fake-BINARY seam — the launch contract, executed.
 *
 * Same arrangement as test/e2e/cursor-agent-binary-seam.test.ts: nothing in
 * src/ is mocked — daemon → HostProcessRunner → a real `lazy supervise` →
 * `CodexAgent` → a fake `codex` on PATH (test/helpers/fake-codex.ts) — and the
 * assertions are about what that binary was handed: the argv
 * `CodexAgent.buildExecArgs` builds, the OPENAI_API_KEY placeholder the launch
 * mints, the LAZY_CODEX_API_BASE the supervisor turns into the managed
 * ~/.codex/config.toml, and the `exec resume` argv of a second turn.
 *
 * Unlike the cursor fake, the codex fake's output IS the verified real shape
 * (JSONL event stream captured from codex-cli 0.152.1), so a green turn here
 * also exercises the real parse path end to end.
 *
 * The proxied-round-trip half — the turn's own HTTP hitting the proxy's
 * OpenAI-compatible route, the placeholder swapped for the real key upstream,
 * and the request landing in the audit trail — is the first test below.
 */

import { CODEX_LATEST_MODEL } from '../../src/config/default-models';
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { largePrompt, createTaskWithPipedPrompt } from '../helpers/agent-seam';
import { expectSuccess } from '../helpers/assertions';
import { codexSuccessScenario, codexProxiedCallScenario } from '../helpers/fake-codex';
import { auditLogPath } from '../../src/proxy/audit-log';
import { readTaskStatus } from '../helpers/storage';
import { setCredential } from '../../src/credentials/store';
import { looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';

/**
 * The OpenAI key the DAEMON holds. The launch must never hand this to the
 * agent process — the proxy swaps it in per request.
 */
const REAL_OPENAI_KEY = 'sk-THE_REAL_OPENAI_KEY_FOR_THE_BINARY_SEAM';

describe('codex turns through the fake-binary seam', () => {
  let ctx: TestContext;

  /** The invocations that are real TURNS (probes are never recorded). */
  async function turnInvocations() {
    const all = await ctx.codexInvocations();
    return all.filter(i => i.argv.includes('exec'));
  }

  /** Read an env var the agent's own process actually held (see cursor twin). */
  function requireEnv(env: Record<string, string | null>, key: string): string {
    const value = env[key];
    expect(value, `the codex turn was launched without ${key}`).not.toBeNull();
    if (typeof value !== 'string') {
      throw new Error(`${key} was not recorded for the codex turn (got ${String(value)})`);
    }
    return value;
  }

  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    // PRE-EXISTING FAILURE, fixed here: this suite makes codex the agent role's
    // default, and the daemon's startup gate requires the credential that role's
    // profile bills — so the daemon refused to start ("no OpenAI credential
    // found") before the line below ever ran, and the whole suite failed in
    // setup. It was failing this way at this task's base commit (e8470219b),
    // unrelated to the ChatGPT work.
    //
    // The gate reads the daemon's ENVIRONMENT and the credential index; the
    // per-agent key file the test writes is a launch-time source, consulted
    // later. So the env var is what has to be present at daemon start, and it
    // must be set BEFORE setupTestLazy rather than after it.
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = REAL_OPENAI_KEY;

    ctx = await setupTestLazy({ fakeCodex: true });
    // The key the daemon holds, stored per-project so it survives restarts;
    // the launch resolves it only to prove one exists and mints a placeholder.
    await setCredential(ctx.root, { provider: 'openai', kind: 'api-key', secret: REAL_OPENAI_KEY }, 'file');
  });

  afterEach(async () => {
    await ctx.cleanup();
    // AFTER cleanup: the daemon is reaped through this process's env too.
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
  });

  // INVARIANT: a codex turn's own model request rides lazy's proxy and lands
  // in the audit trail, attributed to its task, with the daemon's real key
  // swapped in for the placeholder the agent held. proxy-codex-roundtrip proves
  // the route answers when a test dials it; this proves the LAUNCH dials it —
  // the fake reads only LAZY_CODEX_API_BASE, so a launch that stopped routing
  // codex through the proxy shows up as a request the audit never saw.
  test('the turn\'s own model traffic goes through the proxy and is audited', async () => {
    const seen: Array<{ method: string; path: string; auth: string | null }> = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get('authorization') });
        await req.text().catch(() => '');
        return Response.json({ id: 'resp-seam', usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } });
      },
    });
    try {
      const configPath = join(ctx.root, 'lazy.toml');
      const before = await readFile(configPath, 'utf-8');
      expect(before).not.toMatch(/^\s*\[agents\.codex\]/m);
      await writeFile(
        configPath,
        `${before}\n[agents.codex]\nharness = "codex"\nmodel = "${CODEX_LATEST_MODEL}"\n` +
        `endpoint = "http://127.0.0.1:${upstream.port}"\ncredential = "openai"\n`,
      );
      expectSuccess(await ctx.lazy(['daemon', 'restart']));

      const taskId = await createTask(ctx, 'Codex proxy route', 'Call the API');
      await ctx.setCodexScenario({
        sequence: [
          codexProxiedCallScenario({
            sessionId: '01a00000-0000-7000-8000-00000000a0d1',
            commit: { message: 'Codex proxied turn', files: [{ path: 'codex-proxy.txt', content: 'x\n' }] },
          }),
          codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000a0d1' }),
        ],
      });

      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));
      expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

      const turns = await turnInvocations();
      const placeholder = requireEnv(turns[0]!.env, 'OPENAI_API_KEY');
      expect(requireEnv(turns[0]!.env, 'LAZY_CODEX_API_BASE')).not.toContain(String(upstream.port));

      // The endpoint preflight may probe the stub too; the turn's request is
      // the POST to the Responses API.
      const call = seen.find(s => s.method === 'POST' && s.path.endsWith('/responses'));
      expect(call, `the codex turn never reached the stub upstream (saw ${JSON.stringify(seen)})`).toBeTruthy();
      expect(call!.auth).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(call!.auth).not.toContain(placeholder);

      const logPath = auditLogPath(join(ctx.root, '.lazy'));
      let record: any;
      for (let i = 0; i < 50 && !record; i++) {
        const raw = await readFile(logPath, 'utf-8').catch(() => '');
        record = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
          .find(r => String(r.upstream).includes(String(upstream.port)) && r.status === 200);
        if (!record) await Bun.sleep(100);
      }
      expect(record, 'the codex request has no audit record').toBeTruthy();
      expect(record.role).toBe('agent');
      expect(taskId.startsWith(String(record.taskId)) || String(record.taskId).startsWith(taskId)).toBe(true);
    } finally {
      upstream.stop(true);
    }
  }, 180_000);

  // INVARIANT: a prompt past the 128 KiB argv-element limit reaches codex whole,
  // on stdin, through the REAL supervisor spawn — never as an argv element,
  // where it dies with E2BIG and crash-loops the task.
  test('a >200 KiB prompt reaches the agent whole, on stdin', async () => {
    const prompt = largePrompt('LARGE-PROMPT-TAIL-codex');
    const taskId = await createTaskWithPipedPrompt(ctx, 'Large prompt', prompt);
    await ctx.setCodexScenario({ sequence: [
      codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000b16a', result: 'Large turn done.', commit: { message: 'large', files: [{ path: 'large.txt', content: 'ok\n' }] } }),
      codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000b16a', result: 'Follow-up done.' }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const [turn] = await turnInvocations();
    expect(turn, 'the fake codex was never launched for a turn').toBeDefined();
    expect(turn!.stdin).toContain(prompt);
    expect(turn!.argv.every(a => Buffer.byteLength(a) < 128 * 1024)).toBe(true);
    expect(turn!.argv.some(a => a.includes('LARGE-PROMPT-TAIL'))).toBe(false);
  }, 90_000);

  test('a launched turn gets the argv, placeholder key, proxy env and managed config codex expects', async () => {
    const taskId = await createTask(ctx, 'Codex argv contract', 'Do the codex thing');
    // HOME is not in the fake's default auth-shaped record list — ask for it
    // so the managed config.toml can be read from the turn's own home below.
    await ctx.recordCodexEnvKeys(['HOME']);

    await ctx.setCodexScenario({
      sequence: [
        codexSuccessScenario({
          sessionId: '01a00000-0000-7000-8000-00000000t001',
          result: 'First turn done.',
          commit: { message: 'Codex turn 1', files: [{ path: 'codex-1.txt', content: 'one\n' }] },
        }),
        // Every later invocation — the turn's own supervisor follow-ups (low-high
        // self-review, wrap-up walkthrough) and the unblock turn — resumes that
        // thread, and `exec resume` reports the SAME thread id back. No commit:
        // the fake replays this entry for each of them.
        codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000t001', result: 'Second turn done.' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length, 'the fake codex was never launched for a turn').toBeGreaterThan(0);
    const argv = turns[0]!.argv;

    // The subcommand + flag block CodexAgent.buildExecArgs opens with. A fresh
    // turn has no `resume` between `exec` and the flags.
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('--json');
    expect(argv).toContain('--skip-git-repo-check');
    // Bypass permission mode → codex's own sandbox off; lazy only sets this
    // where the process is already isolated, which is what this seam runs as.
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    // A task with no model runs Codex's declared default, passed explicitly.
    expect(argv[argv.indexOf('-m') + 1]).toBe(CODEX_LATEST_MODEL);
    // Fresh exec reads the full prompt from closed stdin.
    expect(argv).not.toContain('Do the codex thing');
    expect(turns[0]!.stdin).toContain('Do the codex thing');

    // OPENAI_API_KEY holds a MINTED PLACEHOLDER — the real key stays in the
    // daemon — and LAZY_CODEX_API_BASE points at the proxy's OpenAI route.
    const env = turns[0]!.env;
    const placeholder = requireEnv(env, 'OPENAI_API_KEY');
    expect(looksLikeLazyPlaceholder(placeholder)).toBe(true);
    expect(placeholder).not.toBe(REAL_OPENAI_KEY);
    expect(JSON.stringify(turns)).not.toContain(REAL_OPENAI_KEY);

    // The proxy's own address — codex dials the proxy, never the upstream, and
    // there is no `/_lazy/...` route prefix: OpenAI-wire routing is per-caller,
    // from the grant behind the Bearer placeholder. The `/v1` is the UPSTREAM's
    // API path, which the launch appends because only it knows which upstream
    // this profile forwards to (api.openai.com here; a ChatGPT-subscription
    // profile takes no prefix — src/proxy/codex-route.ts).
    const apiBase = requireEnv(env, 'LAZY_CODEX_API_BASE');
    expect(apiBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    // The supervisor turned that env into the managed ~/.codex/config.toml
    // BEFORE the agent ran: provider block routing through the proxy (with the
    // env_key line that makes codex bearer the placeholder) and the lazy MCP
    // entry. $HOME is the context's private temp home.
    const homeDir = requireEnv(env, 'HOME');
    const configToml = await readFile(join(homeDir, '.codex', 'config.toml'), 'utf-8');
    expect(configToml).toContain('model_provider = "lazy"');
    // VERBATIM — the supervisor writes what the launch computed and appends
    // nothing of its own, which is what keeps a subscription profile's
    // prefix-less base intact.
    expect(configToml).toContain(`base_url = "${apiBase}"`);
    expect(configToml).toContain('env_key = "OPENAI_API_KEY"');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain('[mcp_servers.lazy]');
    // Codex's plugin-marketplace sync is off: it would git-clone into
    // ~/.codex/.tmp/plugins, which is inside the task worktree.
    expect(configToml.slice(configToml.indexOf('[features]'))).toContain('plugins = false');

    // Second turn: the thread codex reported is resumed via the nested
    // subcommand — `exec resume <thread-id>` — not started fresh.
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Keep going please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterUnblock = await turnInvocations();
    expect(afterUnblock.length).toBeGreaterThan(turns.length);
    // The unblock turn's WORK invocation — found by its prompt, not by being
    // last: the turn's own wrap-up invocations run after it.
    const unblocked = afterUnblock.filter(i => i.stdin?.includes('Keep going please'));
    expect(unblocked.length, 'the unblock turn never launched codex').toBe(1);
    const second = unblocked[0]!.argv;
    expect(second.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second[2]).toBe('01a00000-0000-7000-8000-00000000t001');
    expect(second[second.length - 1]).toBe('-');
  }, 180_000);

});
