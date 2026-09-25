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
 * The proxied-round-trip half (the turn's own HTTP hitting the proxy's
 * OpenAI-compatible route and the placeholder being swapped upstream) lands
 * with the route itself — see proxy-openai-upstreams, which this task's branch
 * is stacked on.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { codexSuccessScenario } from '../helpers/fake-codex';
import { readTaskStatus } from '../helpers/storage';
import { writeAgentApiKey } from '../../src/agent/credentials';
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
    await writeAgentApiKey(ctx.root, 'codex', REAL_OPENAI_KEY);
  });

  afterEach(async () => {
    await ctx.cleanup();
    // AFTER cleanup: the daemon is reaped through this process's env too.
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
  });

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
    // The default model omits -m: codex's own default applies, and lazy's
    // managed config.toml never writes a `model` key that could hijack it.
    expect(argv).not.toContain('-m');
    // Prompt is the last positional and carries the task's own prompt.
    expect(argv[argv.length - 1]).toContain('Do the codex thing');

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

    // Second turn: the thread codex reported is resumed via the nested
    // subcommand — `exec resume <thread-id>` — not started fresh.
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Keep going please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterUnblock = await turnInvocations();
    expect(afterUnblock.length).toBeGreaterThan(turns.length);
    // The unblock turn's WORK invocation — found by its prompt, not by being
    // last: the turn's own wrap-up invocations run after it.
    const unblocked = afterUnblock.filter(i => String(i.argv[i.argv.length - 1]).includes('Keep going please'));
    expect(unblocked.length, 'the unblock turn never launched codex').toBe(1);
    const second = unblocked[0]!.argv;
    expect(second.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second[2]).toBe('01a00000-0000-7000-8000-00000000t001');
  }, 180_000);

});
