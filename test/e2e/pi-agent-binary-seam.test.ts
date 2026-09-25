/**
 * pi turns on the fake-BINARY seam — the launch contract, executed.
 *
 * Same seam as test/e2e/cursor-agent-binary-seam.test.ts: nothing in `src/`
 * is mocked — daemon → HostProcessRunner → a real `lazy supervise` →
 * `PiAgent` → a fake `pi` on PATH (test/helpers/fake-pi.ts). What is proved
 * here is what the LAUNCHED binary was handed: the argv `buildExecArgs`
 * builds, the credential PLACEHOLDER (never a real key), the provider/offline
 * env, and the per-turn HOME files (models.json proxy pin, the lazy MCP
 * bridge extension). Unlike the cursor fake, the output the fake emits is the
 * VERIFIED shape of pi 0.84.4's --mode json stream.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { piSuccessScenario, piHangAfterResultScenario, piErrorScenario, type PiScenario } from '../helpers/fake-pi';
import { readTaskStatus } from '../helpers/storage';
import { setGuards, agentTurns, waitForStatus, readSessionRecord } from '../helpers/agent-seam';
import { looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';

describe('pi turns through the fake-binary seam', () => {
  let ctx: TestContext;
  /**
   * A stand-in for the local Ollama the built-in `pi` profile points at.
   *
   * The default endpoint is now a LOCAL server (src/config/agent-profiles.ts),
   * and a local endpoint is preflighted whether or not a human pinned it — so
   * without something answering on a port, every launch here would fail the
   * probe rather than exercise the argv contract this suite is about. It only
   * has to answer: the pi binary is fake, so no model request is ever made.
   */
  let ollamaStub: { port: number; stop: () => void };

  /** The invocations that are real TURNS (probes are never recorded). */
  async function turnInvocations() {
    const all = await ctx.piInvocations();
    return all.filter(i => i.argv.includes('-p'));
  }

  function requireEnv(env: Record<string, string | null>, key: string): string {
    const value = env[key];
    expect(value, `the pi turn was launched without ${key}`).not.toBeNull();
    if (typeof value !== 'string') {
      throw new Error(`${key} was not recorded for the pi turn (got ${String(value)})`);
    }
    return value;
  }

  beforeEach(async () => {
    // The daemon holds a (fake) real OpenAI key so an OpenAI-provider pi
    // launch passes its credential-exists check; the spawned agent must still
    // only ever see a placeholder (asserted below).
    ctx = await setupTestLazy({
      fakePi: true,
      daemonEnv: { OPENAI_API_KEY: 'sk-proj-REAL-pi-seam-key', OPENROUTER_API_KEY: 'sk-or-REAL-pi-seam-key' },
    });
    // HOME is where the supervisor writes the per-turn pi files; the offline
    // flags and provider are lazy's own launch env. AUTH keys are recorded by
    // the fake unconditionally.
    const server = Bun.serve({ port: 0, fetch: () => new Response('Ollama is running') });
    ollamaStub = { port: server.port!, stop: () => server.stop(true) };
    const configPath = join(ctx.root, 'lazy.toml');
    const baseConfig = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${baseConfig}\n[agents.pi]\nharness = "pi"\nmodel = "qwen3.8:latest"\n` +
      `endpoint = "http://127.0.0.1:${ollamaStub.port}"\n`,
    );
    await ctx.recordPiEnvKeys([
      'HOME', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'LAZY_PI_PROVIDER', 'LAZY_PI_OLLAMA_MODEL',
      'LAZY_PI_OPENAI_MODEL', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK',
    ]);
  });

  afterEach(async () => {
    await ctx.cleanup();
    ollamaStub?.stop();
  });

  test('a launched turn gets the argv, proxied env, and per-turn HOME files pi expects', async () => {
    const taskId = await createTask(ctx, 'pi argv contract', 'Do the pi thing');

    await ctx.setPiScenario({
      sequence: [
        piSuccessScenario({
          result: 'First turn done.',
          commit: { message: 'pi turn 1', files: [{ path: 'pi-1.txt', content: 'one\n' }] },
        }),
        piSuccessScenario({ result: 'Second turn done.' }),
      ],
    });

    // The effort is CHOSEN, which is what makes it the draft's: under the
    // default low-high review mode an unchosen effort drafts at the configured
    // `draft_effort` instead, and this test is about the task's own effort
    // reaching pi.
    expectSuccess(await ctx.lazy(['start', taskId, '--yes', '--effort', 'medium']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length, 'the fake pi was never launched for a turn').toBeGreaterThan(0);
    const argv = turns[0]!.argv;

    // The flag block PiAgent.buildExecArgs opens with, in order. --no-approve
    // is SECURITY: project trust pinned off so a checked-in .pi/ can never
    // execute (see src/agent/pi.ts).
    // `ollama` is the CUSTOM Anthropic-wire provider lazy declares, which is
    // what a local endpoint resolves to — and what the built-in `pi` profile
    // now is by default.
    expect(argv.slice(0, 6)).toEqual(['-p', '--mode', 'json', '--no-approve', '--provider', 'ollama']);
    // The system prompt travels on pi's native flag.
    expect(argv).toContain('--append-system-prompt');
    // A work turn keeps the full toolset.
    expect(argv).not.toContain('--exclude-tools');
    // Prompt is the last positional and carries the task's own prompt.
    expect(argv[argv.length - 1]).toContain('Do the pi thing');

    // The env the launch built: a minted PLACEHOLDER (the real credential
    // stays daemon-side, swapped per request at the proxy), the proxied base
    // URL, lazy's provider choice, and the no-startup-egress flags.
    const env = turns[0]!.env;
    // ANTHROPIC_AUTH_TOKEN specifically: it is the var this profile's
    // models.json interpolates (`apiKey: "$ANTHROPIC_AUTH_TOKEN"`), and the
    // var every non-plain-Anthropic credential rides in. Reading
    // ANTHROPIC_API_KEY instead would read the DAEMON's own environment, which
    // the host-process runner passes to its child wholesale — that runner has
    // no isolation by design, and the container runner (the real deployment)
    // passes only the vars named here.
    const credential = requireEnv(env, 'ANTHROPIC_AUTH_TOKEN');
    expect(looksLikeLazyPlaceholder(credential)).toBe(true);
    const baseUrl = requireEnv(env, 'ANTHROPIC_BASE_URL');
    expect(baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    expect(requireEnv(env, 'LAZY_PI_PROVIDER')).toBe('ollama');
    // No model in the env: the turn's model rides `--model` and models.json
    // only. The profile default used to ride here as LAZY_PI_OLLAMA_MODEL and
    // read as "this turn's model" to an agent running a different one.
    expect(env.LAZY_PI_OLLAMA_MODEL ?? null).toBeNull();
    expect(argv[argv.indexOf('--model') + 1]).toBe('qwen3.8:latest');
    expect(requireEnv(env, 'PI_OFFLINE')).toBe('1');
    expect(requireEnv(env, 'PI_SKIP_VERSION_CHECK')).toBe('1');

    // The per-turn HOME files: models.json pins pi's providers to the proxied
    // base URL, and the lazy MCP bridge extension names the MCP server command.
    const home = requireEnv(env, 'HOME');
    const modelsConfig = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf-8'));
    // The built-in anthropic provider is pinned to the proxy on EVERY turn, so
    // no pi provider ever holds a direct-egress base URL...
    expect(modelsConfig.providers.anthropic.baseUrl).toBe(baseUrl);
    // ...and the custom provider this turn runs declares its model and the
    // Anthropic wire, also at the proxy.
    expect(modelsConfig.providers.ollama.baseUrl).toBe(baseUrl);
    expect(modelsConfig.providers.ollama.api).toBe('anthropic-messages');
    // INVARIANT: the task's EFFORT has to survive the whole launch — the flag on
    // argv is only half of it. pi resolves `--thinking` against the model's own
    // declaration and clamps it, so a model declared without `reasoning` runs
    // every effort as `off` (the bug this pair pins: pi 0.84.4 reported
    // PI_REASONING_LEVEL=off for a --thinking high turn on a local Ollama).
    expect(argv).toContain('--thinking');
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('medium');
    const ollamaModel = modelsConfig.providers.ollama.models[0];
    expect(ollamaModel.id).toBe('qwen3.8:latest');
    expect(ollamaModel.reasoning).toBe(true);
    // xhigh and max are pi's EXTENDED levels: unsupported unless the model names
    // them, and clamped DOWN when unsupported — so lazy's two highest efforts
    // need these entries to arrive as themselves.
    expect(ollamaModel.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    // The MCP server command is baked in per turn (host runner spells it as a
    // bun invocation of src/index.ts; containers as `lazy-agent`) and names
    // THIS task, so the bridge can only ever serve this turn's tool channel.
    const bridge = await readFile(join(home, '.pi', 'agent', 'extensions', 'lazy-mcp.ts'), 'utf-8');
    expect(bridge).toContain('"mcp"');
    expect(bridge).toContain('--task-id');
    expect(bridge).toContain(taskId.slice(0, 8));

    // Second turn: the session id pi reported (echoed from the stream header)
    // is resumed via the exact-id --session-id contract.
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Keep going please']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterUnblock = await turnInvocations();
    expect(afterUnblock.length).toBeGreaterThan(turns.length);
    // The unblock turn's WORK invocation — found by its prompt, not by being
    // last: the turn's own wrap-up invocations run after it.
    const unblocked = afterUnblock.filter(i => String(i.argv[i.argv.length - 1]).includes('Keep going please'));
    expect(unblocked.length, 'the unblock turn never launched pi').toBe(1);
    const second = unblocked[0]!.argv;
    expect(second).toContain('--session-id');
    expect(second[second.indexOf('--session-id') + 1]).toBe('fake-pi-session-0001');
  }, 180_000);

  // The OpenAI-wire pi launch. An `[agents.*]` profile pointed at
  // api.openai.com resolves the openai wire (HARNESS_WIRES.pi), so the launch
  // selects pi's openai provider — declared under lazy's own `lazy-openai` key
  // (PI_PROVIDER_KEY) — and the per-turn models.json puts it on the Chat
  // Completions wire at the proxy's /v1. The credential still travels as an
  // Anthropic-shaped PLACEHOLDER: the proxy routes by the PROFILE named on
  // the grant, not by which env var carried the key.
  test('an OpenAI-endpoint pi profile runs the openai provider with a placeholder key', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[agents.openai-pi]\nharness = "pi"\nmodel = "gpt-5.2"\n` +
      `endpoint = "https://api.openai.com"\ncredential = "openai"\n`,
    );

    const taskId = await createTask(ctx, 'pi openai contract', 'Do the openai thing');
    expectSuccess(await ctx.lazy(['edit', taskId, '--agent', 'openai-pi']));

    await ctx.setPiScenario({
      sequence: [
        piSuccessScenario({
          result: 'OpenAI turn done.',
          commit: { message: 'pi openai turn', files: [{ path: 'pi-oai.txt', content: 'o\n' }] },
        }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length, 'the fake pi was never launched for the openai turn').toBeGreaterThan(0);
    const argv = turns[0]!.argv;

    expect(argv.slice(0, 6)).toEqual(['-p', '--mode', 'json', '--no-approve', '--provider', 'lazy-openai']);
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.2');

    const env = turns[0]!.env;
    // The credential pi authenticates with is the minted PLACEHOLDER in
    // ANTHROPIC_AUTH_TOKEN — the var models.json interpolates below — never the
    // daemon's real OpenAI key. resolveProfileLaunchCreds puts every
    // non-Anthropic credential there; the proxy swaps the real one in upstream.
    const credential = requireEnv(env, 'ANTHROPIC_AUTH_TOKEN');
    expect(credential).not.toBe('sk-proj-REAL-pi-seam-key');
    expect(looksLikeLazyPlaceholder(credential)).toBe(true);
    expect(requireEnv(env, 'LAZY_PI_PROVIDER')).toBe('openai');
    expect(env.LAZY_PI_OPENAI_MODEL ?? null).toBeNull();
    expect(requireEnv(env, 'PI_OFFLINE')).toBe('1');

    // models.json: the openai provider dials the proxy's /v1 on the
    // Chat Completions wire with the placeholder slot; the anthropic pin
    // stays so no pi provider ever has a direct-egress base.
    const home = requireEnv(env, 'HOME');
    const modelsConfig = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf-8'));
    expect(modelsConfig.providers.anthropic.baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    expect(modelsConfig.providers['lazy-openai']).toEqual({
      baseUrl: `${modelsConfig.providers.anthropic.baseUrl}/v1`,
      api: 'openai-completions',
      apiKey: '$ANTHROPIC_AUTH_TOKEN',
      // Reasoning declared here too, so the task's effort reaches the model as
      // `reasoning_effort`. `max` is absent on purpose: OpenAI has no such
      // effort, so pi clamps a max-effort turn to xhigh rather than sending a
      // value the API rejects.
      models: [{ id: 'gpt-5.2', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }],
    });
    expect(modelsConfig.providers.openai).toBeUndefined();
  }, 180_000);

  // OpenRouter — the case the endpoint wire table exists for: the same harness
  // on the OpenAI wire again, credential INFERRED from the hostname, and a
  // SLASHED model id (what OpenRouter models are called) that must reach pi
  // verbatim. `openai/gpt-4o` is the adversarial spelling: under pi's built-in
  // `openai` key it would be captured by pi's own catalog, which is why the
  // provider is declared under lazy's `lazy-openai` key instead.
  test('an OpenRouter pi profile runs the openai provider with its slashed model id verbatim', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[agents.openrouter-pi]\nharness = "pi"\nmodel = "openai/gpt-4o"\n` +
      `endpoint = "https://openrouter.ai/api"\n`,
    );

    const taskId = await createTask(ctx, 'pi openrouter contract', 'Do the openrouter thing');
    expectSuccess(await ctx.lazy(['edit', taskId, '--agent', 'openrouter-pi']));

    await ctx.setPiScenario({
      sequence: [
        piSuccessScenario({
          result: 'OpenRouter turn done.',
          commit: { message: 'pi openrouter turn', files: [{ path: 'pi-or.txt', content: 'r\n' }] },
        }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const turns = await turnInvocations();
    expect(turns.length, 'the fake pi was never launched for the openrouter turn').toBeGreaterThan(0);
    const argv = turns[0]!.argv;
    expect(argv.slice(0, 6)).toEqual(['-p', '--mode', 'json', '--no-approve', '--provider', 'lazy-openai']);
    expect(argv[argv.indexOf('--model') + 1]).toBe('openai/gpt-4o');

    const env = turns[0]!.env;
    const credential = requireEnv(env, 'ANTHROPIC_AUTH_TOKEN');
    expect(credential).not.toBe('sk-or-REAL-pi-seam-key');
    expect(looksLikeLazyPlaceholder(credential)).toBe(true);
    expect(requireEnv(env, 'LAZY_PI_PROVIDER')).toBe('openai');
    expect(env.LAZY_PI_OPENAI_MODEL ?? null).toBeNull();

    const home = requireEnv(env, 'HOME');
    const modelsConfig = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf-8'));
    expect(modelsConfig.providers['lazy-openai'].api).toBe('openai-completions');
    expect(modelsConfig.providers['lazy-openai'].models.map((m: { id: string }) => m.id))
      .toEqual(['openai/gpt-4o']);
    expect(modelsConfig.providers.openai).toBeUndefined();
  }, 180_000);

  // INVARIANT: providers lazy's proxy cannot front refuse AT LAUNCH — before
  // any agent process is spawned. A provider-prefixed model id is pi's syntax
  // for choosing a provider, so it must not survive to the binary.
  test('a provider-prefixed model refuses at launch without spawning pi', async () => {
    // On a CUSTOM provider every declared id resolves verbatim, slashes and
    // all, so the refusal is specific to pi's built-in anthropic provider —
    // which, since pi defaults to a local Ollama, is reached only by a profile
    // that names Anthropic. Same shape as the openai/openrouter tests below,
    // which also pin a hosted endpoint.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[agents.anthropic-pi]\nharness = "pi"\nmodel = "claude-opus-5"\n` +
      `endpoint = "https://api.anthropic.com"\n`,
    );

    const taskId = await createTask(ctx, 'pi provider refusal', 'Try google');
    expectSuccess(await ctx.lazy(['edit', taskId, '--agent', 'anthropic-pi', '--model', 'google/gemini-pro']));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await ctx.lazy(['wait', taskId, '--timeout', '60']);

    // The refusal is pre-spawn: the fake binary never ran a turn.
    const turns = await turnInvocations();
    expect(turns).toHaveLength(0);

    // And it is fatal_config — the task stops for a human instead of burning
    // the retry ladder on a launch that fails identically every time.
    const show = await ctx.lazy(['show', taskId]);
    expect(show.stdout + show.stderr).toContain('provider');
    expect(readTaskStatus(ctx.root, taskId)).not.toBe('complete');
  }, 120_000);

  // INVARIANT (turn-model stickiness): every pi turn runs the task's persisted
  // model — the work turn, the turn after a plain unblock (which names no
  // model), and an ask. models.json declares that ONE model and never the
  // profile default, so pi has no fallback to drift onto: it used to declare
  // both, and the agent saw the profile default in its env while running the
  // task's model.
  test("a task's model sticks across work, unblock and ask turns; the profile default is never offered", async () => {
    const taskId = await createTask(ctx, 'pi sticky model', 'Work on the sticky model');
    expectSuccess(await ctx.lazy(['edit', taskId, '--model', 'muse-glimmer']));

    await ctx.setPiScenario({
      sequence: [
        piSuccessScenario({
          result: 'Work turn done.',
          commit: { message: 'pi sticky', files: [{ path: 'pi-sticky.txt', content: 's\n' }] },
        }),
        piSuccessScenario({ result: 'Second turn done.' }),
        piSuccessScenario({ result: 'Third turn done.' }),
        piSuccessScenario({ result: 'Fourth turn done.' }),
        piSuccessScenario({ result: 'Fifth turn done.' }),
        piSuccessScenario({ result: 'Sixth turn done.' }),
        piSuccessScenario({ result: 'Here is the answer.' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Keep going']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'Which model?']));

    const turns = await turnInvocations();
    // Beyond start, unblock and ask there must be at least one supervisor-run
    // follow-up invocation (wrap-up: review/presentation) — the "nudge" leg of
    // the rule, which rides the same command and must carry the same model.
    const known = ['Work on the sticky model', 'Keep going', 'Which model?'];
    const followUps = turns.filter(t => !known.some(k => String(t.argv[t.argv.length - 1]).includes(k)));
    expect(followUps.length, 'no wrap-up/nudge invocation ran, so stickiness across one is unproven')
      .toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.argv[turn.argv.indexOf('--model') + 1]).toBe('muse-glimmer');
      expect(turn.env.LAZY_PI_OLLAMA_MODEL ?? null).toBeNull();
    }
    expect(turns[turns.length - 1]!.argv).toContain('--exclude-tools');

    const home = requireEnv(turns[turns.length - 1]!.env, 'HOME');
    const modelsConfig = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf-8'));
    expect(modelsConfig.providers.ollama.models.map((m: { id: string }) => m.id)).toEqual(['muse-glimmer']);
  }, 240_000);

  test('an ask turn runs read-only: write builtins excluded, session resumed', async () => {
    const taskId = await createTask(ctx, 'pi ask contract', 'Work then answer');

    await ctx.setPiScenario({
      sequence: [
        piSuccessScenario({
          result: 'Work turn done.',
          commit: { message: 'pi work', files: [{ path: 'pi-work.txt', content: 'w\n' }] },
        }),
        piSuccessScenario({ result: 'Here is the answer.' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const answer = await ctx.lazy(['ask', taskId, '-m', 'What did you do?']);
    expectSuccess(answer);

    const turns = await turnInvocations();
    const ask = turns[turns.length - 1]!.argv;
    // INVARIANT: plan/ask read-only is a DENYLIST of pi's write builtins —
    // an allowlist (--tools) would also strip the bridged lazy_* tools.
    expect(ask).toContain('--exclude-tools');
    expect(ask[ask.indexOf('--exclude-tools') + 1]).toBe('bash,edit,write,powershell');
    expect(ask).not.toContain('--tools');
    // The ask resumes the work session rather than starting an empty one.
    expect(ask).toContain('--session-id');
    expect(ask[ask.indexOf('--session-id') + 1]).toBe('fake-pi-session-0001');
  }, 180_000);

  // INVARIANT (src/agent/pi.ts + src/supervisor/work.ts): a pi process that
  // lingers after `agent_end` must still produce a SUCCESSFUL turn carrying the
  // agent's summary. pi's own `agent_end` line has no session id, so
  // `PiActivityStream` synthesizes the self-contained `pi_result` line the
  // wind-down salvage path re-parses — if that contract ever breaks, the turn
  // falls through to GracefulExitTimeoutError and the agent's report is lost.
  // Observed in the field: every pi turn on a local model was killed in
  // wind-down, and the salvage is the only thing standing between that and a
  // discarded report.
  test('a pi process that lingers after agent_end is killed, and the summary survives', async () => {
    await setGuards(ctx, { windDownMs: 2_000 });

    const taskId = await createTask(ctx, 'pi wind-down kill', 'Do the work');
    await ctx.setPiScenario({ sequence: [
      piHangAfterResultScenario({
        result: 'Pi summary emitted before the hang.',
        commit: { message: 'pi work before hang', files: [{ path: 'pi-hang.txt', content: 'done\n' }] },
        hangMs: 120_000,
      }),
      // The turn's own supervisor follow-ups (low-high self-review, wrap-up
      // walkthrough) still run after a salvaged result. Script them short and
      // commit-free: a replay of the hang would repeat its commit and fail.
      piSuccessScenario({ result: 'Follow-up done.' }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const turns = await agentTurns(ctx.root, taskId);
    // The summary survives the kill: the work invocation's turn, first of the
    // bundle.
    expect(String(turns[0]!.content)).toContain('Pi summary emitted before the hang.');
  }, 180_000);

  // INVARIANT (the 2026-09-16 incident, second half): a turn that dies with a
  // session id on its stream must be RESUMED into that same session, not
  // re-sent from scratch. The full production chain is exercised here: the
  // fake's session header is the first stream line, the watchdog kills the
  // silent turn three times with nothing captured (the hung-first-model-call
  // shape), the give-up error carries the stream's session id onto the error
  // response, the daemon reconciles it into the session record, and the
  // auto-resume hands it to pi as --session-id. Only the argv the fake actually
  // received proves the last link — a mocked suite could show lazy intended to
  // resume without showing the agent was told to.
  const PI_SESSION_ID = 'fake-pi-session-0001';

  /** A pi stream that reports its session and then goes silent forever. */
  function piSilentScenario(sessionId: string, silentMs: number): PiScenario {
    return {
      steps: [
        {
          kind: 'stdout',
          text:
            JSON.stringify({
              type: 'session',
              version: 3,
              id: sessionId,
              timestamp: new Date().toISOString(),
              cwd: process.cwd(),
            }) + '\n',
        },
        { kind: 'sleep', ms: silentMs },
      ],
    };
  }

  test('a watchdog-killed pi turn is auto-resumed into the SAME session', async () => {
    await setGuards(ctx, { noProgressMs: 3_000 });

    const taskId = await createTask(ctx, 'pi crash then resume', 'Do the work');
    await ctx.setPiScenario({
      sequence: [
        // Three zero-work kills exhaust the watchdog's relaunch ladder inside
        // one turn; the turn then ends as `interrupted`, which the reconciler
        // auto-resumes.
        piSilentScenario(PI_SESSION_ID, 120_000),
        piSilentScenario(PI_SESSION_ID, 120_000),
        piSilentScenario(PI_SESSION_ID, 120_000),
        // The resumed turn completes normally.
        piSuccessScenario({ result: 'Recovered after being auto-resumed.', sessionId: PI_SESSION_ID }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    // Settle only: whether `wait` samples the interrupted window or rides to
    // blocked is a race, as in auto-resume-binary-seam.test.ts.
    await ctx.lazy(['wait', taskId]);
    await waitForStatus(ctx.root, taskId, ['blocked'], 90_000);

    // The resumed turn's output proves it ran to completion.
    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1]!.content)).toContain('Recovered after being auto-resumed.');

    // The reconcile link: the killed turn's session id reached the record.
    const session = await readSessionRecord(ctx.root, taskId);
    expect(session.agent_session_id).toBe(PI_SESSION_ID);

    // And the resume link: the invocation the daemon actually launched carries
    // pi's exact-id resume flag with the KILLED turn's session id.
    const piTurns = (await ctx.piInvocations()).filter(i => i.argv.includes('-p'));
    expect(piTurns.length).toBeGreaterThanOrEqual(4);
    // The first, doomed attempt had nothing to resume.
    expect(piTurns[0]!.argv).not.toContain('--session-id');
    const resumed = piTurns[piTurns.length - 1]!.argv;
    expect(resumed).toContain('--session-id');
    expect(resumed[resumed.indexOf('--session-id') + 1]).toBe(PI_SESSION_ID);
  }, 240_000);

  // INVARIANT (same incident, the blocked-path half): a pi turn the MODEL
  // errored — pi's real shape is stopReason 'error' + errorMessage on the final
  // assistant, exit code 0 — blocks the task WITHOUT losing the conversation:
  // the id the stream reported reconciles into the session record, and a later
  // `lazy unblock` resumes that exact id instead of starting over.
  test('a model-errored pi turn blocks, and unblocking resumes the SAME session', async () => {
    const taskId = await createTask(ctx, 'pi fatal error then resume', 'Do the work');
    await ctx.setPiScenario({
      sequence: [
        piErrorScenario({
          // classifyFailure reads this off the stream: "no api key found for"
          // → fatal_auth — no retry, the task blocks with the reason.
          errorMessage: 'No API key found for ollama. Run pi /login to connect a provider.',
          sessionId: PI_SESSION_ID,
        }),
        piSuccessScenario({ result: 'Recovered after unblock.', sessionId: PI_SESSION_ID }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Credential fixed — try again']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await agentTurns(ctx.root, taskId);
    expect(String(turns[turns.length - 1]!.content)).toContain('Recovered after unblock.');

    const session = await readSessionRecord(ctx.root, taskId);
    expect(session.agent_session_id).toBe(PI_SESSION_ID);

    const piTurns = (await ctx.piInvocations()).filter(i => i.argv.includes('-p'));
    // Exactly one launch before the unblock — a fatal model error is not
    // retried — so the unblock turn is the SECOND invocation. Later ones are
    // that turn's own supervisor follow-ups (self-review, wrap-up).
    expect(piTurns.length).toBeGreaterThanOrEqual(2);
    expect(piTurns.filter(i => String(i.argv[i.argv.length - 1]).includes('Credential fixed')).length).toBe(1);
    const resumed = piTurns[1]!.argv;
    expect(resumed).toContain('--session-id');
    expect(resumed[resumed.indexOf('--session-id') + 1]).toBe(PI_SESSION_ID);
    expect(resumed[resumed.length - 1]).toContain('Credential fixed');
  }, 180_000);
});
