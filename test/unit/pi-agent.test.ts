/**
 * PiAgent unit tests.
 *
 * The parseResponse and activity-stream cases run against CAPTURED REAL OUTPUT
 * of pi 0.84.4 (`test/fixtures/pi/*.jsonl`, recorded in add-pi-agent against a
 * scripted Anthropic-wire server), not hand-written approximations — the same
 * verified-not-vendor-documented rule the cursor work established.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { PiAgent, PiActivityStream, resolvePiProvider, LAZY_PI_PROVIDER_ENV } from '../../src/agent/pi';
import { PiPackaging, PI_PINNED_VERSION } from '../../src/agent/pi-packaging';
import { getAgent, getAgentPackaging, listAgents, agentDisplayName } from '../../src/agent/registry';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'pi');
const PRINT_TURN = readFileSync(join(FIXTURES, 'print-turn.jsonl'), 'utf-8');
const TOOL_USE_TURN = readFileSync(join(FIXTURES, 'tool-use-turn.jsonl'), 'utf-8');

let agent: PiAgent;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [LAZY_PI_PROVIDER_ENV, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

beforeEach(() => {
  agent = new PiAgent();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('PiAgent', () => {
  describe('buildExecArgs', () => {
    test('builds headless JSON-mode argv with prompt last', () => {
      const args = agent.buildExecArgs({ prompt: 'do the thing', modelId: 'claude-opus-5', dangerouslySkipPermissions: true });
      expect(args[0]).toBe('pi');
      expect(args).toContain('-p');
      expect(args.slice(args.indexOf('--mode'))[1]).toBe('json');
      expect(args[args.length - 1]).toBe('do the thing');
    });

    // INVARIANT (security): --no-approve pins project trust OFF so a
    // checked-in .pi/extensions|settings.json|SYSTEM.md can never load — those
    // execute arbitrary code on trust and the task branch is agent-writable.
    // Same family as cursor never passing --approve-mcps.
    test('always passes --no-approve', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', dangerouslySkipPermissions: true });
      expect(args).toContain('--no-approve');
      const interactive = agent.buildInteractiveArgs({ modelId: 'claude-opus-5', dangerouslySkipPermissions: false });
      expect(interactive).toContain('--no-approve');
    });

    // INVARIANT: the provider is lazy's decision, made from the resolved role
    // target and delivered via launch env — never inferred from the model
    // string or defaulted to pi's own default provider (google).
    test('passes --provider anthropic by default', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--provider');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('anthropic');
    });

    test('passes --provider ollama when the launch env says so', () => {
      process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'qwen3:8b', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--provider');
      expect(args[idx + 1]).toBe('ollama');
      expect(args).toContain('qwen3:8b');
    });

    // INVARIANT: providers lazy's proxy cannot front are refused at launch
    // with an actionable message, not handed to pi (whose error would point at
    // /login instead of at lazy's config).
    test('refuses an unsupported provider from the launch env', () => {
      process.env[LAZY_PI_PROVIDER_ENV] = 'google';
      expect(() => agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', dangerouslySkipPermissions: true }))
        .toThrow(/pi provider not supported by lazy.*anthropic, ollama, openai/s);
    });

    // The openai provider is handed to pi under lazy's OWN key: under pi's
    // built-in `openai` the declaration merges with pi's catalog and an
    // OpenRouter `openai/…` id is captured by it (verified against 0.84.4 —
    // see PI_PROVIDER_KEY).
    test('passes --provider lazy-openai when the launch env says openai', () => {
      process.env[LAZY_PI_PROVIDER_ENV] = 'openai';
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'gpt-5.2', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--provider');
      expect(args[idx + 1]).toBe('lazy-openai');
      expect(args).toContain('gpt-5.2');
    });

    // INVARIANT: the provider is the profile's to decide, never a model
    // string's — there is no lazy spelling that selects one. On the BUILT-IN
    // anthropic provider a "provider/id" is never a real model (pi passes it
    // through as a custom id and Anthropic rejects it), so it is refused here,
    // where the message can name the fix.
    test('refuses a provider-prefixed model id on the built-in anthropic provider', () => {
      expect(() => agent.buildExecArgs({ prompt: 'x', modelId: 'openai/gpt-4o', dangerouslySkipPermissions: true }))
        .toThrow(/provider prefix/);
      expect(() => agent.buildExecArgs({ prompt: 'x', modelId: 'google/gemini', dangerouslySkipPermissions: true }))
        .toThrow(/provider prefix/);
    });

    // On the CUSTOM providers every model the turn names is declared in the
    // per-turn models.json and resolves to that declaration verbatim (VERIFIED
    // against pi 0.84.4 for each spelling below) — and slashed ids are simply
    // what OpenRouter models are called, so they must pass through.
    test('passes a slashed model id through verbatim on a custom provider', () => {
      process.env[LAZY_PI_PROVIDER_ENV] = 'openai';
      for (const modelId of ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o']) {
        const args = agent.buildExecArgs({ prompt: 'x', modelId, dangerouslySkipPermissions: true });
        expect(args[args.indexOf('--model') + 1]).toBe(modelId);
      }
      process.env[LAZY_PI_PROVIDER_ENV] = 'ollama';
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'hf.co/unsloth/foo', dangerouslySkipPermissions: true });
      expect(args[args.indexOf('--model') + 1]).toBe('hf.co/unsloth/foo');
    });

    test('passes system prompt via native --append-system-prompt', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', systemPrompt: 'be terse', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--append-system-prompt');
      expect(args[idx + 1]).toBe('be terse');
    });

    test('passes session id via exact-id --session-id (create-or-resume)', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', sessionId: 'abc-123', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--session-id');
      expect(args[idx + 1]).toBe('abc-123');
    });

    test('maps effort to --thinking', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', effort: 'xhigh', dangerouslySkipPermissions: true });
      const idx = args.indexOf('--thinking');
      expect(args[idx + 1]).toBe('xhigh');
    });

    // INVARIANT: plan/ask mode is a DENYLIST of pi's write-capable builtins.
    // `--tools <allowlist>` also strips extension-registered tools (verified
    // against 0.84.4), which would take away the read-only lazy_* toolset the
    // ask turn exists to use.
    test('plan mode excludes write tools instead of allowlisting', () => {
      const args = agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', permissionMode: 'plan', dangerouslySkipPermissions: false });
      const idx = args.indexOf('--exclude-tools');
      expect(args[idx + 1]).toBe('bash,edit,write,powershell');
      expect(args).not.toContain('--tools');
    });

    test('appends extraArgs after flags, before the prompt', () => {
      const args = agent.buildExecArgs({ prompt: 'the prompt', modelId: 'claude-opus-5', extraArgs: ['--foo', 'bar'], dangerouslySkipPermissions: true });
      const fooIdx = args.indexOf('--foo');
      expect(fooIdx).toBeGreaterThan(-1);
      expect(args[fooIdx + 1]).toBe('bar');
      expect(args[args.length - 1]).toBe('the prompt');
    });
  });

  describe('parseResponse (captured real output, pi 0.84.4)', () => {
    test('parses a full print-mode JSONL stream', () => {
      const response = agent.parseResponse(PRINT_TURN);
      expect(response.result).toBe('FAKE_OK hello from fake server');
      expect(response.session_id).toBe('11111111-2222-3333-4444-555555555555');
      expect(response.usage.input_tokens).toBe(10);
      expect(response.usage.output_tokens).toBe(8);
      expect(response.model_id).toBe('claude-sonnet-4-5');
    });

    test('parses a tool-use turn: final text, summed usage across assistant messages', () => {
      const response = agent.parseResponse(TOOL_USE_TURN);
      expect(response.result).toBe('FINAL: tool round-trip ok');
      expect(response.session_id).toBe('01a0648f-3066-706f-aac2-588d88248226');
      // Two LLM calls in the turn (tool_use + final): usage is the sum.
      expect(response.usage.input_tokens).toBe(30);
      expect(response.usage.output_tokens).toBe(11);
    });

    test('parses the synthesized self-contained pi_result line', () => {
      const stream = new PiActivityStream();
      let raw: string | undefined;
      for (const line of TOOL_USE_TURN.split('\n')) {
        const event = stream.parseLine(line);
        if (event?.kind === 'result') raw = event.raw;
      }
      expect(raw).toBeDefined();
      const response = agent.parseResponse(raw!);
      expect(response.result).toBe('FINAL: tool round-trip ok');
      expect(response.session_id).toBe('01a0648f-3066-706f-aac2-588d88248226');
      expect(response.usage.input_tokens).toBe(30);
    });

    test('surfaces an errored final message as a throw', () => {
      const line = JSON.stringify({
        type: 'pi_result',
        result: '',
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 0 },
        stop_reason: 'error',
        error_message: 'overloaded_error: try again',
      });
      expect(() => agent.parseResponse(line)).toThrow(/overloaded_error/);
    });

    // INVARIANT: a refusal from lazy's OWN proxy is named as such. pi records
    // it verbatim as an opaque `502 {"type":"error","error":{"type":
    // "proxy_error",…}}`, and on 2026-09-16 that is all anyone saw while every
    // Pi turn on a local model died on a proxy timeout. The raw text is kept
    // alongside the gloss because classifyFailure reads it.
    test('names lazy\'s proxy when the provider error came from it', () => {
      const line = JSON.stringify({
        type: 'pi_result',
        result: '',
        session_id: 's1',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'error',
        error_message: '502 {"type":"error","error":{"type":"proxy_error","message":"The operation timed out."}}',
      });
      expect(() => agent.parseResponse(line)).toThrow(/lazy's proxy could not complete this request/);
      expect(() => agent.parseResponse(line)).toThrow(/The operation timed out/);
      // …and it classifies as a transient network failure, not as "unknown".
      const failure = agent.classifyFailure({
        message: '502 {"type":"error","error":{"type":"proxy_error","message":"The operation timed out."}}',
      });
      expect(failure.class).toBe('transient_network');
    });

    test('throws with diagnostics on a stream with no agent_end', () => {
      const partial = PRINT_TURN.split('\n').slice(0, 4).join('\n');
      expect(() => agent.parseResponse(partial)).toThrow(/missing agent_end/);
    });

    test('throws on empty stdout', () => {
      expect(() => agent.parseResponse('')).toThrow(/empty stdout/);
    });
  });

  describe('activity stream (captured real output)', () => {
    test('maps the real event stream onto lazy activity kinds', () => {
      const stream = new PiActivityStream();
      const kinds: string[] = [];
      for (const line of TOOL_USE_TURN.split('\n')) {
        const event = stream.parseLine(line);
        if (event) kinds.push(event.kind);
      }
      expect(kinds[0]).toBe('session_start');
      expect(kinds).toContain('tool_start');
      expect(kinds).toContain('tool_end');
      expect(kinds).toContain('result');
      // pi has no heartbeat-shaped event; nothing may map to one.
      expect(kinds).not.toContain('heartbeat');
    });

    test('session_start carries the session id from the header', () => {
      const stream = new PiActivityStream();
      const event = stream.parseLine(PRINT_TURN.split('\n')[0]!);
      expect(event?.kind).toBe('session_start');
      expect(event?.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    });

    test('tool events carry the tool call id and name', () => {
      const stream = new PiActivityStream();
      let started: { id?: string; name?: string } | null = null;
      for (const line of TOOL_USE_TURN.split('\n')) {
        const event = stream.parseLine(line);
        if (event?.kind === 'tool_start') started = { id: event.toolUseId, name: event.toolName };
      }
      expect(started?.id).toBe('toolu_1');
      expect(started?.name).toBe('lazy_echo');
    });

    test('an agent_end with no prior session header degrades to progress', () => {
      const stream = new PiActivityStream();
      const lastLine = TOOL_USE_TURN.trim().split('\n').findLast(l => l.includes('"agent_end"'))!;
      expect(stream.parseLine(lastLine)?.kind).toBe('progress');
    });

    test('never throws on garbage or truncated lines', () => {
      const stream = new PiActivityStream();
      expect(stream.parseLine('')).toBeNull();
      expect(stream.parseLine('not json')).toBeNull();
      expect(stream.parseLine('{"type":"agent_end","mess')).toBeNull();
    });
  });

  describe('auth', () => {
    test('forwards ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN when present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok-2';
      const vars = agent.getAuthEnvVars();
      expect(vars).toEqual([
        { key: 'ANTHROPIC_API_KEY', value: 'sk-1' },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: 'tok-2' },
      ]);
      expect(agent.hasAuthEnv()).toBe(true);
    });

    // INVARIANT: every pi turn — anthropic, ollama or openai provider — carries
    // its credential in the Anthropic vars. A non-Anthropic upstream's key is
    // placed there by resolveProfileLaunchCreds and swapped in at the proxy, so
    // pi needs no per-wire env var of its own.
    test('an OPENAI_API_KEY in the environment is NOT a pi credential', () => {
      process.env.OPENAI_API_KEY = 'sk-proj-lazy-grant';
      expect(agent.hasAuthEnv()).toBe(false);
    });

    test('throws actionably when no lazy credential is present', () => {
      expect(() => agent.getAuthEnvVars()).toThrow(/Anthropic, Ollama or\s+OpenAI/);
      expect(agent.hasAuthEnv()).toBe(false);
    });
  });

  describe('classifyFailure (messages verified against pi 0.84.4)', () => {
    test('missing binary is fatal_config with the install hint', () => {
      const failure = agent.classifyFailure({ message: "spawn failed: binary 'pi' not found" });
      expect(failure.class).toBe('fatal_config');
      expect(failure.reason).toContain('bun add -g');
    });

    test("pi's own no-credential message is fatal_auth", () => {
      const failure = agent.classifyFailure({
        message: 'agent crashed',
        stderr: 'No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.',
      });
      expect(failure.class).toBe('fatal_auth');
    });

    test('unknown provider is fatal_config', () => {
      const failure = agent.classifyFailure({
        message: 'agent crashed',
        stderr: 'Error: Unknown provider "doesnotexist". Use --list-models to see available providers/models.',
      });
      expect(failure.class).toBe('fatal_config');
    });

    // INVARIANT (turn-model stickiness): a pi launch with no model is a loud,
    // fatal refusal — never a pi run on whatever its config offers by default.
    test("lazy's no-model refusal is fatal_config", () => {
      let message = '';
      try {
        agent.buildExecArgs({ prompt: 'x', dangerouslySkipPermissions: true });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/pi launch names no model/);
      expect(agent.classifyFailure({ message }).class).toBe('fatal_config');
    });

    // INVARIANT: lazy's own pre-flight provider refusal must classify fatal —
    // every retry re-runs the same refused config.
    test("lazy's unsupported-provider refusal is fatal_config", () => {
      process.env[LAZY_PI_PROVIDER_ENV] = 'groq';
      let message = '';
      try {
        agent.buildExecArgs({ prompt: 'x', modelId: 'claude-opus-5', dangerouslySkipPermissions: true });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      const failure = agent.classifyFailure({ message });
      expect(failure.class).toBe('fatal_config');
    });

    test('shared HTTP signals fall through to the common classifier', () => {
      expect(agent.classifyFailure({ message: 'API error 429 rate limit' }).class).toBe('transient_overload');
      expect(agent.classifyFailure({ message: 'ECONNREFUSED at proxy' }).class).toBe('transient_unreachable');
      expect(agent.classifyFailure({ message: 'total mystery' }).class).toBe('unknown');
    });
  });

  describe('declared capabilities', () => {
    test('streams activity, so no agent-specific watchdog default', () => {
      expect(agent.defaultWatchdogTimeoutMs()).toBe(0);
      expect(agent.activityStream()).toBeInstanceOf(PiActivityStream);
    });

    test('has no model opinion (lazy config decides)', () => {
      expect(agent.defaultModel()).toBeNull();
    });

    test('supports pairing with a resumable interactive argv', () => {
      expect(agent.supportsPairing()).toBe(true);
      const args = agent.buildInteractiveArgs({ sessionId: 's-1', modelId: 'opus', dangerouslySkipPermissions: true })!;
      expect(args[0]).toBe('pi');
      expect(args).not.toContain('-p');
      const idx = args.indexOf('--session-id');
      expect(args[idx + 1]).toBe('s-1');
    });
  });

  // INVARIANT (turn-model stickiness): every pi launch — supervised turn and
  // pair session alike — passes --model, and refuses when it has none. Without
  // --model pi runs whatever models.json offers first, silently: the gap that
  // let a pair session run a model the task never chose.
  describe('always --model', () => {
    for (const provider of ['anthropic', 'ollama', 'openai']) {
      test(`${provider}: exec and interactive both pass the task's model`, () => {
        process.env[LAZY_PI_PROVIDER_ENV] = provider;
        const exec = agent.buildExecArgs({ prompt: 'x', modelId: ' muse-glimmer ', dangerouslySkipPermissions: true });
        expect(exec[exec.indexOf('--model') + 1]).toBe('muse-glimmer');
        const interactive = agent.buildInteractiveArgs({ modelId: 'muse-glimmer', dangerouslySkipPermissions: true });
        expect(interactive[interactive.indexOf('--model') + 1]).toBe('muse-glimmer');
      });

      test(`${provider}: no model is a refusal, not a pi default`, () => {
        process.env[LAZY_PI_PROVIDER_ENV] = provider;
        for (const modelId of [undefined, '', '  ']) {
          expect(() => agent.buildExecArgs({ prompt: 'x', modelId, dangerouslySkipPermissions: true }))
            .toThrow(/pi launch names no model/);
        }
        for (const modelId of [undefined, null, '']) {
          expect(() => agent.buildInteractiveArgs({ modelId, dangerouslySkipPermissions: true }))
            .toThrow(/pi launch names no model/);
        }
      });
    }
  });

  describe('session discovery', () => {
    test('finds session files under <configDir>/agent/sessions by id suffix', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
      try {
        const project = join(dir, 'agent', 'sessions', '--tmp-work--');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, '2026-09-02T23-52-56-400Z_abc-123.jsonl'), '{}');
        writeFileSync(join(project, '2026-09-02T23-53-00-000Z_other.jsonl'), '{}');
        const matched = agent.discoverSessionFiles({ sessionId: 'abc-123', configDir: dir });
        expect(matched).toHaveLength(1);
        expect(matched[0]).toContain('_abc-123.jsonl');
        const all = agent.discoverSessionFiles({ configDir: dir });
        expect(all).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('returns [] when the sessions dir does not exist', () => {
      expect(agent.discoverSessionFiles({ configDir: '/nonexistent/nowhere' })).toEqual([]);
    });
  });
});

describe('resolvePiProvider', () => {
  test('defaults to anthropic and accepts ollama and openai', () => {
    expect(resolvePiProvider({})).toBe('anthropic');
    expect(resolvePiProvider({ [LAZY_PI_PROVIDER_ENV]: 'ollama' })).toBe('ollama');
    expect(resolvePiProvider({ [LAZY_PI_PROVIDER_ENV]: 'openai' })).toBe('openai');
  });

  test('refusal names the supported providers', () => {
    expect(() => resolvePiProvider({ [LAZY_PI_PROVIDER_ENV]: 'google' }))
      .toThrow(/anthropic, ollama, openai/);
  });
});

describe('PiPackaging', () => {
  const packaging = new PiPackaging();

  test('identity and layout', () => {
    expect(packaging.agentId).toBe('pi');
    expect(packaging.binaryName()).toBe('pi');
    expect(packaging.configDirName()).toBe('.pi');
    expect(packaging.supportsContainerRunner()).toBe(true);
  });

  // INVARIANT: the install is PINNED to the version the arg/stream contract
  // was verified against — a floating latest would change the contract under
  // every image rebuild.
  test('docker install is pinned and blocks postinstall scripts', () => {
    const install = packaging.dockerInstallCommand();
    expect(install).toContain(`@earendil-works/pi-coding-agent@${PI_PINNED_VERSION}`);
    expect(install).toContain('--ignore-scripts');
    expect(packaging.npmPackage()).toContain(`@${PI_PINNED_VERSION}`);
    expect(packaging.generateDockerfile()).toContain(install);
  });

  test('supervisor tool checks use bare binary names', () => {
    for (const check of packaging.supervisorToolChecks()) {
      expect(check.cmd).not.toContain(' ');
    }
    expect(packaging.supervisorToolChecks().map(c => c.cmd)).toContain('pi');
  });
});

describe('Agent registry', () => {
  test('pi is registered with agent, packaging, and display name', () => {
    expect(listAgents()).toContain('pi');
    expect(getAgent('pi')).toBeInstanceOf(PiAgent);
    expect(getAgentPackaging('pi')).toBeInstanceOf(PiPackaging);
    // "Pi" is how the vendor's own docs spell it in prose, and the display
    // name must be distinct from the raw id (agent-display-name drift guard).
    expect(agentDisplayName('pi')).toBe('Pi');
  });
});
