import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAgent, CodexActivityStream, CODEX_DEFAULT_MODEL } from '../../src/agent/codex';
import { CodexPackaging, CODEX_PINNED_VERSION, CODEX_INSTALL_HINT } from '../../src/agent/codex-packaging';
import { renderCodexConfig, CODEX_CONFIG_MARKER } from '../../src/agent/codex-config';
import { codexProxyEnvVars, codexLaunchEnvVars, codexBaseUrlPrefix, CODEX_ENDPOINT_ENV } from '../../src/proxy/codex-route';
import { getAgent, getAgentPackaging, listAgents, agentDisplayName } from '../../src/agent/registry';
import { codexProxiedCallScenario } from '../helpers/fake-codex';

// Every fixture line below is REAL output captured from codex-cli 0.152.1
// (aarch64 Linux, driven by a local fake OpenAI Responses server — see the
// add-codex-agent task journal). Do not hand-edit shapes; re-capture instead.

const THREAD_STARTED = '{"type":"thread.started","thread_id":"01a0648a-81c3-7b40-8d72-e54a856da67f"}';
const TURN_STARTED = '{"type":"turn.started"}';
const AGENT_MESSAGE = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello from the fake server!"}}';
const TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":42,"cached_input_tokens":12,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}';
const TURN_FAILED = '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: probe-401, url: http://127.0.0.1:18081/v1/responses"}}';
const RECONNECT_ERROR = '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: probe-401, url: http://127.0.0.1:18081/v1/responses)"}';

const SUCCESS_STREAM = [THREAD_STARTED, TURN_STARTED, AGENT_MESSAGE, TURN_COMPLETED].join('\n');

describe('CodexAgent', () => {
  let agent: CodexAgent;

  beforeEach(() => {
    agent = new CodexAgent();
  });

  test('has id "codex"', () => {
    expect(agent.id).toBe('codex');
  });

  describe('buildExecArgs', () => {
    test('fresh turn: codex exec --json with the prompt as the last positional', () => {
      const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hello', dangerouslySkipPermissions: false });
      expect(args[0]).toBe('codex');
      expect(args[1]).toBe('exec');
      expect(args).toContain('--json');
      expect(args).toContain('--skip-git-repo-check');
      expect(args[args.length - 1]).toBe('Hello');
    });

    test('resume is the nested subcommand with the thread id positional, before flags', () => {
      // Verified argv shape: `codex exec resume <id> --json … [PROMPT]`.
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'continue',
        sessionId: '01a0648b-f428-70b0-8f46-4672842290ba',
        dangerouslySkipPermissions: true,
      });
      expect(args.slice(0, 4)).toEqual(['codex', 'exec', 'resume', '01a0648b-f428-70b0-8f46-4672842290ba']);
      expect(args[args.length - 1]).toBe('continue');
    });

    test('dangerouslySkipPermissions maps to --dangerously-bypass-approvals-and-sandbox', () => {
      const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hi', dangerouslySkipPermissions: true });
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    test('plan mode uses the native read-only sandbox instead of the bypass flag', () => {
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'Hi',
        dangerouslySkipPermissions: true,
        permissionMode: 'plan',
      });
      const i = args.indexOf('-c');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('sandbox_mode="read-only"');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    test('prepends system prompt to user prompt (no system-prompt flag exists)', () => {
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'Do something',
        systemPrompt: 'You are a helper',
        dangerouslySkipPermissions: false,
      });
      const prompt = args[args.length - 1]!;
      expect(prompt).toContain('<system>');
      expect(prompt).toContain('You are a helper');
      expect(prompt.indexOf('<system>')).toBeLessThan(prompt.indexOf('Do something'));
    });

    test(`the "${CODEX_DEFAULT_MODEL}" sentinel omits -m so codex's own default applies`, () => {
      const args = agent.buildExecArgs({
        prompt: 'Hi',
        modelId: CODEX_DEFAULT_MODEL,
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('-m');
    });

    test('a concrete model id passes through -m', () => {
      const args = agent.buildExecArgs({ prompt: 'Hi', modelId: 'gpt-5.6-sol', dangerouslySkipPermissions: false });
      const i = args.indexOf('-m');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('gpt-5.6-sol');
    });

    test('effort maps to -c model_reasoning_effort; lazy "max" becomes codex "xhigh"', () => {
      // The -c value is forwarded verbatim to the API's reasoning.effort
      // (verified) — so only codex-valid values may ever be sent.
      for (const [lazy, codex] of [['low', 'low'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'xhigh']] as const) {
        const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hi', effort: lazy, dangerouslySkipPermissions: false });
        const i = args.indexOf('-c');
        expect(i).toBeGreaterThan(-1);
        expect(args[i + 1]).toBe(`model_reasoning_effort="${codex}"`);
      }
    });

    test('an unknown effort is dropped rather than forwarded for a remote 400', () => {
      const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hi', effort: 'turbo', dangerouslySkipPermissions: false });
      expect(args).not.toContain('-c');
    });

    test('extraArgs are appended before the prompt', () => {
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'Hi',
        extraArgs: ['--color', 'never'],
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain('--color');
      expect(args[args.length - 1]).toBe('Hi');
    });
  });

  describe('parseResponse', () => {
    test('parses the captured success stream', () => {
      const response = agent.parseResponse(SUCCESS_STREAM);
      expect(response.result).toBe('Hello from the fake server!');
      expect(response.session_id).toBe('01a0648a-81c3-7b40-8d72-e54a856da67f');
    });

    test('maps codex usage to Anthropic-shaped counts (input excludes cache reads)', () => {
      // Codex reports OpenAI Responses conventions: input_tokens INCLUDES
      // cached_input_tokens. Lazy's AgentTokenUsage is Anthropic-shaped, where
      // cache reads live in their own field — subtracting keeps the turn's
      // total identical under both conventions and avoids double-counting
      // against the proxy's wire-side extraction.
      const response = agent.parseResponse(SUCCESS_STREAM);
      expect(response.usage).toEqual({
        input_tokens: 30, // 42 - 12 cached
        output_tokens: 7,
        cache_read_input_tokens: 12,
        cache_creation_input_tokens: 0,
      });
    });

    test('joins multiple agent messages in stream order', () => {
      const stream = [
        THREAD_STARTED,
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"second"}}',
        TURN_COMPLETED,
      ].join('\n');
      expect(agent.parseResponse(stream).result).toBe('first\n\nsecond');
    });

    test('turn.failed throws quoting codex verbatim', () => {
      const stream = [THREAD_STARTED, TURN_STARTED, RECONNECT_ERROR, TURN_FAILED].join('\n');
      expect(() => agent.parseResponse(stream)).toThrow(/401 Unauthorized/);
    });

    test('names what is missing when the stream is incomplete', () => {
      expect(() => agent.parseResponse(THREAD_STARTED)).toThrow(/agent_message.*turn\.completed/);
      expect(() => agent.parseResponse('')).toThrow(/empty stdout/);
    });

    test('non-JSON noise lines are skipped, not fatal', () => {
      const stream = ['WARNING: something on stdout', SUCCESS_STREAM].join('\n');
      expect(agent.parseResponse(stream).result).toBe('Hello from the fake server!');
    });
  });

  describe('CodexActivityStream', () => {
    test('thread.started → session_start with the thread id, from line 1', () => {
      const stream = new CodexActivityStream();
      const event = stream.parseLine(THREAD_STARTED);
      expect(event?.kind).toBe('session_start');
      expect(event?.sessionId).toBe('01a0648a-81c3-7b40-8d72-e54a856da67f');
      // Codex's stream carries no MCP/tool report — "said nothing", never [].
      expect(event?.mcpServers).toBeUndefined();
      expect(event?.toolNames).toBeUndefined();
    });

    test('turn.completed → result whose raw excerpt parses under parseResponse', () => {
      // INVARIANT: with a streaming agent the watchdog retains ONLY the result
      // event's `raw` in full (stdout is a bounded tail), and work.ts hands
      // that raw to parseResponse on wind-down kills. The excerpt must
      // therefore be self-sufficient: session id + message + usage.
      const stream = new CodexActivityStream();
      for (const line of [THREAD_STARTED, TURN_STARTED, AGENT_MESSAGE]) stream.parseLine(line);
      const result = stream.parseLine(TURN_COMPLETED);
      expect(result?.kind).toBe('result');
      expect(result?.sessionId).toBe('01a0648a-81c3-7b40-8d72-e54a856da67f');

      const response = agent.parseResponse(result!.raw!);
      expect(response.result).toBe('Hello from the fake server!');
      expect(response.session_id).toBe('01a0648a-81c3-7b40-8d72-e54a856da67f');
      expect(response.usage.input_tokens).toBe(30);
    });

    test('command execution items map to tool_start / tool_end', () => {
      const stream = new CodexActivityStream();
      const started = stream.parseLine(
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"echo hi","aggregated_output":"","status":"in_progress"}}',
      );
      expect(started?.kind).toBe('tool_start');
      expect(started?.toolUseId).toBe('item_1');
      const ended = stream.parseLine(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"echo hi","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}',
      );
      expect(ended?.kind).toBe('tool_end');
      expect(ended?.toolUseId).toBe('item_1');
    });

    test('item.updated on a running command is a heartbeat, not progress', () => {
      // A command looping forever emits updates forever; if updates counted as
      // forward progress the turn would be immortal — same reasoning as
      // Claude's tool_progress heartbeats.
      const stream = new CodexActivityStream();
      const event = stream.parseLine(
        '{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"sleep 999","aggregated_output":"tick","status":"in_progress"}}',
      );
      expect(event?.kind).toBe('heartbeat');
    });

    test('mcp_tool_call items carry a server.tool label', () => {
      const stream = new CodexActivityStream();
      const event = stream.parseLine(
        '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"lazy","tool":"lazy_status","status":"in_progress"}}',
      );
      expect(event?.kind).toBe('tool_start');
      expect(event?.toolName).toBe('lazy.lazy_status');
    });

    test('reasoning and message items, turn.started, and in-stream errors are progress', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine(TURN_STARTED)?.kind).toBe('progress');
      expect(stream.parseLine(RECONNECT_ERROR)?.kind).toBe('progress');
      expect(stream.parseLine('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"…"}}')?.kind).toBe('progress');
      expect(stream.parseLine(AGENT_MESSAGE)?.kind).toBe('progress');
    });

    test('turn.failed does NOT emit result (no summary to protect)', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine(TURN_FAILED)?.kind).toBe('progress');
    });

    test('malformed and non-JSON lines are null, never a throw', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine('')).toBeNull();
      expect(stream.parseLine('{"type":"turn.comp')).toBeNull();
      expect(stream.parseLine('plain text')).toBeNull();
    });
  });

  describe('classifyFailure', () => {
    test('missing binary is fatal_config with the install hint', () => {
      const failure = agent.classifyFailure({ message: "spawn failed: binary 'codex' not found" });
      expect(failure.class).toBe('fatal_config');
      expect(failure.reason).toContain('Install with');
    });

    test('missing OPENAI_API_KEY env is fatal_auth naming set-key (verified message)', () => {
      const failure = agent.classifyFailure({
        message: 'Codex turn failed: Missing environment variable: `OPENAI_API_KEY`.',
      });
      expect(failure.class).toBe('fatal_auth');
      expect(failure.reason).toContain('lazy system agent set-key codex');
    });

    test('insufficient_quota is fatal_auth even when the body also carries a 429', () => {
      // OpenAI's out-of-billing error usually rides a 429; matching the 429
      // first would burn the retry ladder on a wall only billing clears.
      const failure = agent.classifyFailure({
        message: 'unexpected status 429 Too Many Requests: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
      });
      expect(failure.class).toBe('fatal_auth');
    });

    test('a plain rate limit stays transient_overload', () => {
      const failure = agent.classifyFailure({
        message: 'unexpected status 429 Too Many Requests: Rate limit reached for gpt-5 … Please try again in 20s. (rate_limit_exceeded)',
      });
      expect(failure.class).toBe('transient_overload');
    });

    test('the real invalid-key text (captured from api.openai.com) is fatal_auth', () => {
      const failure = agent.classifyFailure({
        message:
          'unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake-***-123. ' +
          'You can find your API key at https://platform.openai.com/account/api-keys., ' +
          'auth error: 401, auth error code: invalid_api_key',
      });
      expect(failure.class).toBe('fatal_auth');
    });

    test('an unknown model id is fatal_config', () => {
      const failure = agent.classifyFailure({
        message: 'The model `gpt-999` does not exist or you do not have access to it.',
      });
      expect(failure.class).toBe('fatal_config');
    });

    test('unmatched text is unknown (retried conservatively)', () => {
      expect(agent.classifyFailure({ message: 'something novel' }).class).toBe('unknown');
    });
  });

  test('isSessionNotFoundError matches the verified bogus-resume stderr', () => {
    expect(agent.isSessionNotFoundError(
      'Error: thread/resume: thread/resume failed: no rollout found for thread id 99999999-0000-0000-0000-000000000000 (code -32600)',
    )).toBe(true);
    expect(agent.isSessionNotFoundError('some other error')).toBe(false);
  });

  test('defaultModel is the omit-the-flag sentinel', () => {
    expect(agent.defaultModel()).toBe(CODEX_DEFAULT_MODEL);
  });

  test('declares an activity stream and progress-based watchdogging', () => {
    expect(agent.activityStream()).toBeInstanceOf(CodexActivityStream);
    expect(agent.defaultWatchdogTimeoutMs()).toBe(0);
  });

  describe('discoverSessionFiles', () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
      // Verified layout: sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl
      const day = join(configDir, 'sessions', '2026', '09', '02');
      await mkdir(day, { recursive: true });
      await writeFile(join(day, 'rollout-2026-09-02T23-53-13-01a0648a-81c3-7b40-8d72-e54a856da67f.jsonl'), '{}\n');
      await writeFile(join(day, 'rollout-2026-09-02T23-52-58-01a0648a-45ba-79b0-9d2d-4bc182b185b4.jsonl'), '{}\n');
    });

    test('finds all rollouts, and filters by session id', async () => {
      const all = agent.discoverSessionFiles({ configDir });
      expect(all).toHaveLength(2);
      const one = agent.discoverSessionFiles({ configDir, sessionId: '01a0648a-81c3-7b40-8d72-e54a856da67f' });
      expect(one).toHaveLength(1);
      expect(one[0]).toContain('01a0648a-81c3');
      await rm(configDir, { recursive: true, force: true });
    });

    test('missing sessions dir returns []', () => {
      expect(agent.discoverSessionFiles({ configDir: '/nonexistent/nowhere' })).toEqual([]);
    });
  });
});

describe('CodexPackaging', () => {
  const pkg = new CodexPackaging();

  test('binary and config dir names', () => {
    expect(pkg.binaryName()).toBe('codex');
    expect(pkg.configDirName()).toBe('.codex');
  });

  test('supports container runners', () => {
    expect(pkg.supportsContainerRunner()).toBe(true);
  });

  test('docker install pins the verified release and resolves the arch', () => {
    const cmd = pkg.dockerInstallCommand();
    expect(cmd).toContain(`rust-v${CODEX_PINNED_VERSION}`);
    expect(cmd).toContain('x86_64-unknown-linux-musl');
    expect(cmd).toContain('aarch64-unknown-linux-musl');
    expect(pkg.generateDockerfile()).toContain(cmd);
  });

  // INVARIANT: BOTH codex binaries are installed. `codex-code-mode-host` is a
  // separate release asset, and codex spawns it from its own directory for any
  // model whose `tool_mode` is `code_mode_only` — which the ChatGPT
  // subscription backend's default model is. Installing only `codex` produced a
  // turn that authenticated, reached the model, and then died on "failed to
  // spawn code-mode host …: No such file or directory" without touching a file.
  test('docker install includes the code-mode host, not just the CLI', () => {
    const cmd = pkg.dockerInstallCommand();
    expect(cmd).toContain('codex-code-mode-host');
    expect(pkg.generateDockerfile()).toContain('codex-code-mode-host');
    expect(CODEX_INSTALL_HINT).toContain('codex-code-mode-host');
  });

  // ...and from the SAME release as the CLI: the two handshake on a versioned
  // protocol, so a mixed pair is a runtime failure rather than a build one.
  test('both binaries come from the one pinned release', () => {
    const urls = [...pkg.dockerInstallCommand().matchAll(/rust-v([0-9][^/"\s]*)/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const version of urls) expect(version).toBe(CODEX_PINNED_VERSION);
  });

  test('supervisor tool checks name the codex binary', () => {
    const checks = pkg.supervisorToolChecks();
    expect(checks.some((c) => c.cmd === 'codex')).toBe(true);
  });

  // INVARIANT: the code-mode host is REPORTED, never a launch gate. A failed
  // supervisor tool check exits the supervisor, so listing it there would refuse
  // every codex task on an image built before that binary was installed —
  // including the many whose model never enters code mode and work fine today.
  // Diagnostics say what is wrong; they do not decide that nothing may run.
  test('the code-mode host is not a fatal preflight check', () => {
    expect(pkg.supervisorToolChecks().some((c) => c.cmd === 'codex-code-mode-host')).toBe(false);
  });
});

describe('registry', () => {
  test('codex is registered as agent and packaging with a display name', () => {
    expect(listAgents()).toContain('codex');
    expect(getAgent('codex').id).toBe('codex');
    expect(getAgentPackaging('codex').agentId).toBe('codex');
    expect(agentDisplayName('codex')).toBe('Codex');
  });
});

describe('codex-config', () => {
  test('renders the managed config with proxy provider and MCP entry', () => {
    // proxyBaseUrl is now the COMPLETE base_url, path prefix included: only the
    // launch knows which upstream the profile routes to, and that decides
    // whether codex must request /v1/responses or /responses.
    const content = renderCodexConfig({
      proxyBaseUrl: 'http://host.docker.internal:8766/v1',
      mcpServer: { command: '/usr/local/bin/lazy-agent', args: ['mcp', '--task-id', 'abc'] },
    });
    expect(content.startsWith(CODEX_CONFIG_MARKER)).toBe(true);
    expect(content).toContain('model_provider = "lazy"');
    expect(content).toContain('base_url = "http://host.docker.internal:8766/v1"');
    // env_key is what makes codex read the JIT placeholder from the launch env
    // and bearer it to the proxy — the whole credential model rides this line.
    expect(content).toContain('env_key = "OPENAI_API_KEY"');
    expect(content).toContain('wire_api = "responses"');
    expect(content).toContain('[mcp_servers.lazy]');
    expect(content).toContain('command = "/usr/local/bin/lazy-agent"');
    expect(content).toContain('args = ["mcp", "--task-id", "abc"]');
  });

  test('TOML-escapes strings via JSON escaping', () => {
    const content = renderCodexConfig({
      proxyBaseUrl: 'http://x',
      mcpServer: { command: 'c:\\path "quoted"', args: ['a\nb'] },
    });
    expect(content).toContain('command = "c:\\\\path \\"quoted\\""');
    expect(content).toContain('args = ["a\\nb"]');
  });
});

describe('codex-route', () => {
  // Codex dials the proxy's own address — there is no `/_lazy/...` route prefix,
  // because OpenAI-wire routing is per-caller, from the grant behind the Bearer
  // placeholder. What the base URL DOES carry is the upstream's own API path
  // prefix, since codex appends its paths to base_url verbatim and the proxy
  // forwards the result unchanged.
  test('endpoint env is the proxy base plus /v1 (trailing slash stripped)', () => {
    expect(codexProxyEnvVars('http://127.0.0.1:8766/')).toEqual([
      { key: CODEX_ENDPOINT_ENV, value: 'http://127.0.0.1:8766/v1' },
    ]);
  });

  // INVARIANT: the base_url's path prefix follows the UPSTREAM, not the proxy.
  // api.openai.com serves the Responses API at /v1/responses; the ChatGPT
  // subscription backend serves it at <base>/responses, and its base already
  // ends in /backend-api/codex. The proxy concatenates upstream + path, so a
  // /v1 here would make a subscription turn request
  // https://chatgpt.com/backend-api/codex/v1/responses and 404. Verified
  // against codex-cli 0.152.1 (docs/codex-chatgpt-subscription.md).
  test('a ChatGPT-subscription profile drops the /v1 prefix', () => {
    expect(codexProxyEnvVars('http://127.0.0.1:8766', 'https://chatgpt.com/backend-api/codex')).toEqual([
      { key: CODEX_ENDPOINT_ENV, value: 'http://127.0.0.1:8766' },
    ]);
    expect(codexBaseUrlPrefix('https://chatgpt.com/backend-api/codex')).toBe('');
    // Every other upstream — including one lazy has never heard of — keeps /v1.
    expect(codexBaseUrlPrefix('https://api.openai.com')).toBe('/v1');
    expect(codexBaseUrlPrefix('https://gateway.example.internal')).toBe('/v1');
    expect(codexBaseUrlPrefix('')).toBe('/v1');
  });

  // INVARIANT: the test double sends what the REAL codex would. It appends its
  // path to LAZY_CODEX_API_BASE, which is the complete base_url — so a `/v1` in
  // the double's path models a request codex never makes, and on a subscription
  // route the proxy's allowlist refuses it, making the failure read as a proxy
  // fault. The double went stale exactly this way once (nothing consumed it, so
  // nothing was red); this is the cheap guard that catches it next time.
  test('the proxied-call test double uses the path the real codex would', () => {
    const httpStep = codexProxiedCallScenario().steps.find((s) => s.kind === 'http');
    expect(httpStep).toBeDefined();
    expect((httpStep as { path?: string }).path).toBe('/responses');
    expect((httpStep as { path?: string }).path).not.toContain('/v1');
  });

  test('the launch passes the profile endpoint through to the prefix decision', () => {
    const vars = codexLaunchEnvVars({
      harness: 'codex',
      runnerType: 'docker',
      proxyPort: 8766,
      bind: '127.0.0.1',
      endpoint: 'https://chatgpt.com/backend-api/codex',
    });
    expect(vars).toHaveLength(1);
    expect(vars[0]!.value.endsWith('/v1')).toBe(false);
  });

  test('returns [] for non-codex agents', () => {
    expect(codexLaunchEnvVars({ harness: 'claude-code', runnerType: 'docker', proxyPort: 8766, bind: '127.0.0.1' })).toEqual([]);
  });

  // INVARIANT: the gate is the HARNESS, not the task's `agent` — that names a
  // PROFILE. `[agents.work-codex] harness = "codex"` must be routed; a profile
  // name arriving here would fail the comparison, launch with no
  // LAZY_CODEX_API_BASE, and let codex dial api.openai.com unaudited.
  test('a profile name is not a harness — the caller must resolve it', () => {
    expect(codexLaunchEnvVars({ harness: 'work-codex', runnerType: 'docker', proxyPort: 8766, bind: '127.0.0.1' })).toEqual([]);
  });

  test('sets the endpoint env for a codex launch', () => {
    const vars = codexLaunchEnvVars({ harness: 'codex', runnerType: 'docker', proxyPort: 8766, bind: '127.0.0.1' });
    expect(vars).toHaveLength(1);
    expect(vars[0]!.key).toBe(CODEX_ENDPOINT_ENV);
    expect(vars[0]!.value).toMatch(/^http:\/\//);
  });

  // INVARIANT: no direct-egress fallback, ever. A codex launch that cannot
  // resolve the proxy FAILS instead of dialing api.openai.com unaudited.
  test('fails loud when the proxy address cannot be resolved', () => {
    expect(() => codexProxyEnvVars(undefined)).toThrow(/audit proxy/);
    expect(() => codexLaunchEnvVars({ harness: 'codex', runnerType: 'docker', proxyPort: undefined, bind: '127.0.0.1' })).toThrow(/audit proxy/);
  });
});
