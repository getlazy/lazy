import { CODEX_LATEST_MODEL } from '../../src/config/default-models';
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAgent, CodexActivityStream, CODEX_DEFAULT_MODEL } from '../../src/agent/codex';
import { CodexPackaging, CODEX_INSTALL_HINT } from '../../src/agent/codex-packaging';
import { renderCodexConfig, CODEX_CONFIG_MARKER, CODEX_PROJECT_DOC_MAX_BYTES } from '../../src/agent/codex-config';
import { codexProxyEnvVars, codexLaunchEnvVars, codexBaseUrlPrefix, CODEX_ENDPOINT_ENV } from '../../src/proxy/codex-route';
import { getAgent, getAgentPackaging, listAgents, agentDisplayName } from '../../src/agent/registry';
import { codexProxiedCallScenario } from '../helpers/fake-codex';
import { extractUsage } from '../../src/proxy/usage';
import { aggregateUsage } from '../../src/proxy/aggregate';
import { toTurnUsage } from '../../src/utils/usage-recording';
import type { ProxyAuditRecord } from '../../src/storage/types';

// Every fixture line below is REAL output captured from codex-cli 0.152.1 (a point-in-time capture, not a pin)
// (aarch64 Linux, driven by a local fake OpenAI Responses server — see the
// add-codex-agent task journal). Do not hand-edit shapes; re-capture instead.

const THREAD_STARTED = '{"type":"thread.started","thread_id":"01a0648a-81c3-7b40-8d72-e54a856da67f"}';
const TURN_STARTED = '{"type":"turn.started"}';
const AGENT_MESSAGE = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello from the fake server!"}}';
const TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":42,"cached_input_tokens":12,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}';
const TURN_FAILED = '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: probe-401, url: http://127.0.0.1:18081/v1/responses"}}';
const RECONNECT_ERROR = '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: probe-401, url: http://127.0.0.1:18081/v1/responses)"}';

const SUCCESS_STREAM = [THREAD_STARTED, TURN_STARTED, AGENT_MESSAGE, TURN_COMPLETED].join('\n');

function auditRecord(usage: ProxyAuditRecord['usage']): ProxyAuditRecord {
  return {
    id: 'codex-1', seq: 1, ts: 1, role: 'agent', taskId: 'codex-task', backend: 'proxy',
    upstream: 'https://api.openai.com', method: 'POST', path: '/v1/responses',
    endpoint: 'responses', model: 'gpt-5.2', tier: 'openai', stream: false,
    requestShape: null, toolUses: [], toolResults: [], status: 200, usage,
    stopReason: null, error: null, durationMs: 1, reroute: null,
  };
}

describe('CodexAgent', () => {
  let agent: CodexAgent;

  beforeEach(() => {
    agent = new CodexAgent();
  });

  test('has id "codex"', () => {
    expect(agent.id).toBe('codex');
  });

  describe('buildExecArgs', () => {
    test('fresh turn: codex exec --json with the prompt on stdin', () => {
      const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hello', dangerouslySkipPermissions: false });
      expect(args[0]).toBe('codex');
      expect(args[1]).toBe('exec');
      expect(args).toContain('--json');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).not.toContain('Hello');
      expect(args.stdinInput).toBe('Hello');
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
      expect(args[args.length - 1]).toBe('-');
      expect(args.stdinInput).toBe('continue');
    });

    test('dangerouslySkipPermissions maps to --dangerously-bypass-approvals-and-sandbox', () => {
      const args = agent.buildExecArgs({ modelId: 'default', prompt: 'Hi', dangerouslySkipPermissions: true });
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    // INVARIANT: on the host-process runner (not externally sandboxed) a
    // read-only Codex turn keeps codex's own read-only sandbox — there is no
    // container around it, so that sandbox is the only boundary.
    test('plan mode outside a container uses the native read-only sandbox, not the bypass flag', () => {
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

    // INVARIANT: inside a task container a read-only Codex turn (ask, review,
    // low-high self-review) bypasses codex's sandbox exactly like a work turn.
    // Codex's read-only sandbox is bubblewrap, which cannot create a namespace
    // in our containers — with it, reviewers had no shell and their lazy MCP
    // calls were denied, and they "approved" work they never read. Read-only
    // is enforced by lazy instead (toolset, prompt, supervisor write check).
    test('plan mode inside a container bypasses the sandbox — fresh and resumed', () => {
      for (const sessionId of [undefined, '01a0648b-f428-70b0-8f46-4672842290ba']) {
        const args = agent.buildExecArgs({
          modelId: 'default',
          prompt: 'Hi',
          sessionId,
          dangerouslySkipPermissions: true,
          permissionMode: 'plan',
          externallySandboxed: true,
        });
        expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(args).not.toContain('sandbox_mode="read-only"');
        expect(args).not.toContain('--sandbox');
      }
    });

    test('prepends system prompt to user prompt (no system-prompt flag exists)', () => {
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'Do something',
        systemPrompt: 'You are a helper',
        dangerouslySkipPermissions: false,
      });
      const prompt = args.stdinInput!;
      expect(prompt).toContain('<system>');
      expect(prompt).toContain('You are a helper');
      expect(prompt.indexOf('<system>')).toBeLessThan(prompt.indexOf('Do something'));
    });

    test('sends an oversized combined prompt through stdin without losing content', () => {
      const systemPrompt = 'system 🐙'.repeat(20_000);
      const userPrompt = 'user 🐙'.repeat(20_000);
      const args = agent.buildExecArgs({ modelId: 'default', prompt: userPrompt, systemPrompt, dangerouslySkipPermissions: false });
      expect(args.stdinInput).toBe(`<system>\n${systemPrompt}\n</system>\n\n${userPrompt}`);
      expect(args.join(' ')).not.toContain(systemPrompt);
      expect(args.join(' ')).not.toContain(userPrompt);
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

    test('extraArgs remain in argv while the prompt uses stdin', () => {
      const args = agent.buildExecArgs({
        modelId: 'default',
        prompt: 'Hi',
        extraArgs: ['--color', 'never'],
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain('--color');
      expect(args.stdinInput).toBe('Hi');
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

    test('leaves usage absent when turn.completed has no measurement', () => {
      const stream = [THREAD_STARTED, AGENT_MESSAGE, '{"type":"turn.completed"}'].join('\n');
      expect(agent.parseResponse(stream).usage).toBeUndefined();
    });

    test('leaves malformed turn.completed usage absent instead of fabricating zero', () => {
      for (const usage of [
        {},
        { input_tokens: 10 },
        { input_tokens: '10', output_tokens: 7 },
        { input_tokens: 10, output_tokens: Number.NaN },
        { input_tokens: 10, output_tokens: -1 },
        { input_tokens: 10, output_tokens: 7, cached_input_tokens: '2' },
      ]) {
        const stream = [
          THREAD_STARTED,
          AGENT_MESSAGE,
          JSON.stringify({ type: 'turn.completed', usage }),
        ].join('\n');
        expect(agent.parseResponse(stream).usage).toBeUndefined();
      }
    });

    test('matches proxy-audit totals for the same OpenAI response', () => {
      const response = agent.parseResponse(SUCCESS_STREAM);
      const wireBody = JSON.stringify({
        usage: {
          input_tokens: 42,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 12 },
        },
      });
      const proxy = aggregateUsage([auditRecord(extractUsage(false, wireBody, 'openai'))]).totals;
      expect(toTurnUsage(response.usage)).toEqual({
        inputTokens: proxy.inputTokens,
        outputTokens: proxy.outputTokens,
        cacheCreationTokens: proxy.cacheCreationInputTokens,
        cacheReadTokens: proxy.cacheReadInputTokens,
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

  // INVARIANT: codex is not pinned, so a newer release may emit event types and fields lazy has never seen. Unknown ones are ignored, never fatal.
  test('ignores unknown event types and extra fields', () => {
    const stream = [
      THREAD_STARTED,
      '{"type":"brand.new_event","payload":{"x":1}}',
      '{"type":"item.completed","extra":"f","item":{"id":"item_0","type":"agent_message","text":"hi","new_field":[1,2]}}',
      '{"type":"turn.completed","new_top_level":true,"usage":{"input_tokens":42,"cached_input_tokens":12,"output_tokens":7,"future_counter":3}}',
    ].join('\n');
    const response = agent.parseResponse(stream);
    expect(response.result).toBe('hi');
    expect(response.usage?.output_tokens).toBe(7);
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

    // INVARIANT: unknown event types and extra fields never throw; known events still map.
    test('tolerates unknown events and extra fields', () => {
      const stream = new CodexActivityStream();
      expect(() => stream.parseLine('{"type":"brand.new_event","payload":{"x":1}}')).not.toThrow();
      const started = stream.parseLine('{"type":"thread.started","thread_id":"t-1","new_field":true}');
      expect(started?.kind).toBe('session_start');
      expect(started?.sessionId).toBe('t-1');
      const done = stream.parseLine('{"type":"turn.completed","extra":1,"usage":{"input_tokens":4,"output_tokens":2,"future":9}}');
      expect(done?.kind).toBe('result');
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
      expect(response.usage!.input_tokens).toBe(30);
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

    test('reasoning and messages advance work; reconnect errors only report liveness', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine(TURN_STARTED)?.kind).toBe('progress');
      expect(stream.parseLine(RECONNECT_ERROR)?.kind).toBe('heartbeat');
      expect(stream.parseLine(RECONNECT_ERROR)?.failureMessage).toBeTruthy();
      expect(stream.parseLine('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"…"}}')?.kind).toBe('progress');
      expect(stream.parseLine(AGENT_MESSAGE)?.kind).toBe('progress');
    });

    test('turn.failed does NOT emit result (no summary to protect)', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine(TURN_FAILED)?.kind).toBe('heartbeat');
      expect(stream.parseLine(TURN_FAILED)?.failureMessage).toBeTruthy();
    });

    test('malformed and non-JSON lines are null, never a throw', () => {
      const stream = new CodexActivityStream();
      expect(stream.parseLine('')).toBeNull();
      expect(stream.parseLine('{"type":"turn.comp')).toBeNull();
      expect(stream.parseLine('plain text')).toBeNull();
    });
  });

  describe('classifyFailure', () => {
    test('remaining E2BIG from environment or flags stops without retry', () => {
      const failure = agent.classifyFailure({ message: "E2BIG: argument list too long, posix_spawn 'codex'" });
      expect(failure.class).toBe('fatal_config');
    });

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

    // Wire lines verbatim from builder-on-codex turns 2, 9 and 13 (2026-09-26).
    // The recorded turns truncate the terminal error; its full text is turn 9's.
    const LIMIT =
      '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), ' +
      'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 12:29 AM."}';
    const METADATA = (m: string) =>
      `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`${m}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}`;
    const RESUMED =
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"This session was recorded with model `gpt-6-astra` but is resuming with `gpt-6-sol`. Consider switching back to `gpt-6-astra` as it may affect Codex performance."}}';

    // INVARIANT: a Codex item.completed error item is a warning that never
    // decides the failure class; the terminal error does. The metadata warning
    // read as "model rejected" and stopped a task that had hit a usage limit.
    test('turn 2: metadata warning + usage limit is a usage limit, not fatal_config', () => {
      const failure = agent.classifyFailure({
        message: [
          '{"type":"thread.started","thread_id":"01a0de3e-d504-7c11-a55c-2d3ccc8fefdb"}',
          METADATA('gpt-6-astra'),
          '{"type":"turn.started"}',
          LIMIT,
        ].join('\n'),
      });
      expect(failure.class).toBe('transient_overload');
      expect(failure.reason).toBe('Codex usage limit reached — try again at Sep 27th, 2026 12:29 AM');
    });

    test('turn 9: a plain usage limit is a usage limit with its reset time', () => {
      const failure = agent.classifyFailure({
        message:
          "Codex turn failed: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
          'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 12:29 AM.',
      });
      expect(failure.class).toBe('transient_overload');
      expect(failure.reason).toContain('Sep 27th, 2026 12:29 AM');
    });

    test('turn 13: resume-model and metadata warnings + usage limit is a usage limit', () => {
      const failure = agent.classifyFailure({
        message: [RESUMED, METADATA('gpt-6-sol').replace('item_0', 'item_1'), '{"type":"turn.started"}', LIMIT].join('\n'),
      });
      expect(failure.class).toBe('transient_overload');
    });

    // INVARIANT: the supervisor classifies what extractStdoutError returns for
    // the WHOLE stream — the generic 500-char excerpt of the last five lines
    // cut turn 13's limit off at "You've hit yo" behind the two warnings.
    const TURN_FAILED =
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 12:29 AM."}}';
    const STREAMS: Record<string, string[]> = {
      'turn 2': [
        '{"type":"thread.started","thread_id":"01a0de3e-d504-7c11-a55c-2d3ccc8fefdb"}',
        METADATA('gpt-6-astra'),
        '{"type":"turn.started"}',
        LIMIT,
      ],
      'turn 13': [RESUMED, METADATA('gpt-6-sol').replace('item_0', 'item_1'), '{"type":"turn.started"}', LIMIT],
    };
    for (const [name, lines] of Object.entries(STREAMS)) {
      for (const tail of [[], [TURN_FAILED]]) {
        test(`${name} full stream${tail.length ? ' + turn.failed' : ''}: extracted then classified as a usage limit`, () => {
          const extracted = agent.extractStdoutError([...lines, ...tail].join('\n'));
          expect(extracted).toStartWith("You've hit your usage limit.");
          const failure = agent.classifyFailure({ message: extracted!, stdoutError: extracted });
          expect(failure.class).toBe('transient_overload');
          expect(failure.reason).toBe('Codex usage limit reached — try again at Sep 27th, 2026 12:29 AM');
        });
      }
    }

    test('extraction never returns a warning item', () => {
      expect(agent.extractStdoutError([RESUMED, METADATA('gpt-6-sol'), '{"type":"turn.started"}'].join('\n'))).toBeUndefined();
    });

    test('a truncated reset time is not quoted', () => {
      const failure = agent.classifyFailure({ message: "You've hit your usage limit. … or try again at 4:43 " });
      expect(failure.reason).toBe('Codex usage limit reached');
    });

    test('warnings alone never classify as a rejected model', () => {
      const failure = agent.classifyFailure({ message: [RESUMED, METADATA('gpt-6-sol')].join('\n') });
      expect(failure.class).not.toBe('fatal_config');
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

  test('defaultModel is a concrete OpenAI model id, not lazy\'s Anthropic default', () => {
    expect(agent.defaultModel()).toBe(CODEX_LATEST_MODEL);
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

  test('docker install resolves the latest release tag once and the arch', () => {
    const cmd = pkg.dockerInstallCommand();
    expect(cmd).toContain('releases/latest');
    expect(cmd).not.toMatch(/rust-v[0-9]/);
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
  test('both binaries come from the one release tag, resolved once', () => {
    for (const cmd of [pkg.dockerInstallCommand(), CODEX_INSTALL_HINT]) {
      // One lookup of the latest tag; every download names that tag.
      expect(cmd.match(/releases\/latest/g)?.length).toBe(1);
      expect(cmd).not.toContain('releases/latest/download');
      expect(cmd).toContain('releases/download/$tag/');
      expect(cmd).not.toMatch(/rust-v[0-9]/);
    }
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

  // INVARIANT: the lazy MCP server's tools are pre-approved. `codex exec`
  // runs with approval policy `never`, under which an unapproved MCP call is
  // denied — read-only turns reported "lazy_status and lazy_diff require
  // approval". Which tools exist is lazy's per-turn choice (a read-only
  // server never advertises the write tools), so approving them all is safe.
  test('pre-approves the lazy MCP server tools', () => {
    const content = renderCodexConfig({
      proxyBaseUrl: 'http://x',
      mcpServer: { command: 'lazy-agent', args: [] },
    });
    const section = content.slice(content.indexOf('[mcp_servers.lazy]'));
    expect(section).toContain('default_tools_approval_mode = "approve"');
  });

  test("raises codex's 32 KiB project-doc cap so a large AGENTS.md is read whole", () => {
    // INVARIANT: the managed config sets project_doc_max_bytes at top level (before any table). Codex 0.152.1 truncates the injected AGENTS.md at 32 KiB by default, silently dropping most of a large repo's instructions.
    const content = renderCodexConfig({ proxyBaseUrl: 'http://x', mcpServer: { command: 'c', args: [] } });
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBeGreaterThan(32768);
    const line = `project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`;
    expect(content).toContain(line);
    expect(content.indexOf(line)).toBeLessThan(content.indexOf('[model_providers.lazy]'));
  });

  test("turns off codex's plugin marketplace sync", () => {
    // INVARIANT: the managed config disables codex's curated-plugin sync. With it on, codex (0.161.0) git-clones a marketplace into $CODEX_HOME/.tmp/plugins, which lives inside the task worktree, so every codex turn planted a nested repository that blocked accept.
    const content = renderCodexConfig({ proxyBaseUrl: 'http://x', mcpServer: { command: 'c', args: [] } });
    expect(content.slice(content.indexOf('[features]'))).toContain('plugins = false');
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
