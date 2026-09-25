import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CursorAgent, CursorActivityStream } from '../../src/agent/cursor';
import { CursorPackaging } from '../../src/agent/cursor-packaging';
import { getAgent, getAgentPackaging, listAgents } from '../../src/agent/registry';

// NOTE: this file previously encoded "Cursor does not support Docker" as an
// invariant. That posture was explicitly reversed by the human-mandated
// cursor-first-class-agent task ("Cursor either works under containers or I
// don't care about it") — container support is now the invariant.

describe('CursorAgent', () => {
  let agent: CursorAgent;

  beforeEach(() => {
    agent = new CursorAgent();
  });

  test('has id "cursor"', () => {
    expect(agent.id).toBe('cursor');
  });

  describe('buildExecArgs', () => {
    // Cursor traffic routes through lazy's audit proxy (proxy-cursor-passthrough).
    // The endpoint override arrives as CURSOR_API_ENDPOINT on the launch env;
    // --agent-endpoint pins the AGENT STREAM to the same address, which a
    // server-supplied agentUrl could otherwise redirect away from the proxy.
    describe('proxy endpoint', () => {
      let saved: string | undefined;
      beforeEach(() => { saved = process.env.CURSOR_API_ENDPOINT; });
      afterEach(() => {
        if (saved === undefined) delete process.env.CURSOR_API_ENDPOINT;
        else process.env.CURSOR_API_ENDPOINT = saved;
      });

      test('pins --agent-endpoint to CURSOR_API_ENDPOINT when set', () => {
        process.env.CURSOR_API_ENDPOINT = 'http://127.0.0.1:8766/_lazy/cursor/agent/ab12';
        const args = agent.buildExecArgs({ modelId: 'test-model', prompt: 'Hi', dangerouslySkipPermissions: false });
        const i = args.indexOf('--agent-endpoint');
        expect(i).toBeGreaterThan(-1);
        expect(args[i + 1]).toBe('http://127.0.0.1:8766/_lazy/cursor/agent/ab12');
      });

      test('omits the flag entirely when no endpoint is set', () => {
        delete process.env.CURSOR_API_ENDPOINT;
        const args = agent.buildExecArgs({ modelId: 'test-model', prompt: 'Hi', dangerouslySkipPermissions: false });
        expect(args).not.toContain('--agent-endpoint');
      });

      test('the prompt stays the last positional argument', () => {
        process.env.CURSOR_API_ENDPOINT = 'http://127.0.0.1:8766/_lazy/cursor/agent/ab12';
        const args = agent.buildExecArgs({ modelId: 'test-model', prompt: 'Hi', dangerouslySkipPermissions: false });
        expect(args[args.length - 1]).toBe('Hi');
      });
    });

    test('uses cursor-agent binary with --print and --trust', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      // Binary renamed from the legacy `agent` symlink to the documented name.
      expect(args[0]).toBe('cursor-agent');
      expect(args).toContain('--print');
      expect(args).toContain('--trust');
      expect(args).toContain('--output-format');
      // INVARIANT (fix-cursor-silent-watchdog): stream-json, NOT the single-blob
      // `json`. In `json` mode cursor-agent emits nothing until the turn ends,
      // so the supervisor's no-progress guard saw a working turn as silence and
      // killed every turn longer than its window. buildExecArgs and
      // activityStream() must change together — a stream parser reading a
      // format the process does not produce makes every turn look silent.
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    });

    // INVARIANT (cursor-first-class-agent, security verification): lazy must
    // NEVER pass --approve-mcps. cursor-agent merges a checked-out repo's own
    // <cwd>/.cursor/mcp.json into its MCP server list; those workspace servers
    // are gated behind approval, and --approve-mcps ("Automatically approve all
    // MCP servers") is the one switch that approves them — turning `git
    // checkout` of a hostile repo into arbitrary command execution inside the
    // task container (which holds CURSOR_API_KEY and forwarded credentials).
    // lazy's own MCP is written to ~/.cursor/mcp.json (home), which loads
    // WITHOUT approval, so the flag was never needed. Keyless probes recorded in
    // src/agent/cursor.ts buildExecArgs. Do NOT "restore" this flag.
    test('never passes --approve-mcps (arbitrary-exec-by-checkout guard)', () => {
      for (const opts of [
        { prompt: 'Hello', modelId: 'test-model', dangerouslySkipPermissions: false },
        { prompt: 'Hello', modelId: 'test-model', dangerouslySkipPermissions: true },
        { prompt: 'Hello', modelId: 'test-model', dangerouslySkipPermissions: false, permissionMode: 'plan' as const },
        {
          prompt: 'Hello',
          modelId: 'test-model',
          dangerouslySkipPermissions: false,
          extraArgs: ['--sandbox', 'enabled'],
        },
      ]) {
        expect(agent.buildExecArgs(opts)).not.toContain('--approve-mcps');
      }
    });

    test('prompt is the last positional argument', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args[args.length - 1]).toBe('Hello');
    });

    test('prepends system prompt to user prompt', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Do something',
        systemPrompt: 'You are a helper',
        dangerouslySkipPermissions: false,
      });
      // Prompt is the last argument
      const prompt = args[args.length - 1];
      expect(prompt).toContain('<system>');
      expect(prompt).toContain('You are a helper');
      expect(prompt).toContain('</system>');
      expect(prompt).toContain('Do something');
      // System prompt should come before user prompt
      expect(prompt.indexOf('<system>')).toBeLessThan(prompt.indexOf('Do something'));
    });

    test('adds --force and --sandbox disabled for dangerouslySkipPermissions', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: true,
      });
      expect(args).toContain('--force');
      // Cursor's own sandbox is disabled when lazy already isolates the
      // process (container) or the human explicitly chose bypass.
      expect(args).toContain('--sandbox');
      expect(args).toContain('disabled');
    });

    test('does not add --force when dangerouslySkipPermissions is false', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--sandbox');
    });

    // INVARIANT (fix-reviewer-cannot-access-mcp): plan/ask/review turns must
    // stay read-only WITHOUT `--mode plan`. Cursor's plan mode rejects MCP tool
    // calls (reviewers reported "MCP calls were rejected" on every Cursor
    // review). Mirror Claude Code: exclude write ToolCall oneofs, keep --force
    // so remaining tools (reads + lazy MCP) auto-run headless.
    test('permissionMode plan excludes write tools and keeps --force (no --mode plan)', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: true,
        permissionMode: 'plan',
      });
      expect(args).not.toContain('--mode');
      expect(args).not.toContain('plan');
      expect(args).toContain('--exclude-tools');
      const excludeIdx = args.indexOf('--exclude-tools');
      const excluded = args[excludeIdx + 1] ?? '';
      expect(excluded).toContain('shellToolCall');
      expect(excluded).toContain('editToolCall');
      expect(excluded).toContain('deleteToolCall');
      expect(excluded).toContain('writeShellStdinToolCall');
      // MCP must remain callable — do not exclude mcpToolCall.
      expect(excluded).not.toContain('mcpToolCall');
      expect(args).toContain('--force');
      expect(args).toContain('--sandbox');
      expect(args[args.indexOf('--sandbox') + 1]).toBe('disabled');
    });

    test('permissionMode plan without dangerouslySkipPermissions still excludes writes and omits --force', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
        permissionMode: 'plan',
      });
      expect(args).toContain('--exclude-tools');
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--mode');
    });

    test('adds --resume with sessionId', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        sessionId: 'abc-123',
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain('--resume');
      expect(args).toContain('abc-123');
    });

    test('adds --model with explicit cursor model', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        modelId: 'sonnet-4-thinking',
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet-4-thinking');
    });

    test('passes bracket-parameterized model ids through verbatim', () => {
      const modelId = 'claude-opus-4-8[context=1m,effort=high]';
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        modelId,
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain(modelId);
    });

    // INVARIANT (turn-model stickiness): a Cursor launch with no model is
    // refused, never spelled by omitting --model. An omitted flag makes
    // cursor-agent read its own persisted selection (~/.cursor/cli-config.json)
    // — a model nobody chose for the task. See src/agent/launch-model.ts.
    test('refuses a launch with no model instead of omitting --model', () => {
      for (const modelId of [undefined, '', '   ']) {
        expect(() => agent.buildExecArgs({ prompt: 'Hello', modelId, dangerouslySkipPermissions: false }))
          .toThrow(/cursor launch names no model/);
      }
    });

    // INVARIANT (fix-cursor-model-turn-setting): "auto" is spelled by PASSING
    // `--model auto`, never by omitting the flag.
    //
    // This REPLACES the opposite invariant, which was asserted on a false
    // premise: that an absent --model makes cursor-agent "apply its own model
    // selection". It does not. cursor-agent resolves an absent --model against
    // its OWN persisted default in ~/.cursor/cli-config.json (`model` /
    // `selectedModel`, guarded by `hasChangedDefaultModel`) — the model the
    // human last picked in Cursor. In a real task sandbox that file read
    // `"model": {"modelId": "claude-opus-4-5"}`, so every turn ran Opus while
    // lazy recorded `auto`, and `lazy unblock --model auto` looked like a
    // no-op. Omission is not neutrality; it hands the choice to state lazy
    // does not own.
    //
    // The old comment's other claim — that the CLI does no client-side model
    // validation — is also wrong, and in our favour: cursor-agent matches
    // --model against its catalog (model id, display id, display name and
    // aliases, lowercased) and exits with "Cannot use this model: X.
    // Available models: …" when it cannot resolve one. `auto` IS in that
    // catalog (id `default`, displayed `auto`). A loud, named failure beats
    // silently running a model nobody chose.
    test('passes --model auto through rather than omitting the flag', () => {
      for (const modelId of ['auto', 'AUTO', '  auto  ']) {
        const args = agent.buildExecArgs({
          prompt: 'Hello',
          modelId,
          dangerouslySkipPermissions: false,
        });
        expect(args).toContain('--model');
        // Verbatim: the resolved id is what lazy recorded on the turn, so what
        // Cursor receives and what a human reads in `lazy show` are the same
        // string.
        expect(args[args.indexOf('--model') + 1]).toBe(modelId);
      }
    });

    // The declared default is what resolveAgentModel falls back to for a Cursor
    // task with no explicit model — see test/unit/role-target.test.ts.
    test('declares "auto" as its default model', () => {
      expect(agent.defaultModel()).toBe('auto');
    });

    test('appends extraArgs after flags, before the prompt', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
        extraArgs: ['--extra-flag', 'value'],
      });
      expect(args).toContain('--extra-flag');
      expect(args[args.length - 1]).toBe('Hello');
    });

    test('omits optional flags when not provided', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--append-system-prompt');
      expect(args).not.toContain('--worktree');
      expect(args).not.toContain('--mode');
    });

    // INVARIANT: --trust is always present in headless mode to avoid interactive prompts.
    test('always includes --trust', () => {
      const args = agent.buildExecArgs({
        modelId: 'test-model',
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args).toContain('--trust');
    });
  });

  describe('parseResponse', () => {
    test('parses valid JSON response', () => {
      const stdout = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Done!',
        session_id: 'sess-123',
      });
      const response = agent.parseResponse(stdout);
      expect(response.result).toBe('Done!');
      expect(response.session_id).toBe('sess-123');
    });

    // The success-path field names could not be verified without credentials,
    // so the parser accepts plausible aliases and normalizes them.
    test('accepts chatId alias for the session id', () => {
      const stdout = JSON.stringify({ result: 'Done!', chatId: 'chat-9' });
      const response = agent.parseResponse(stdout);
      expect(response.session_id).toBe('chat-9');
    });

    test('accepts text alias for the result', () => {
      const stdout = JSON.stringify({ text: 'Done!', session_id: 's1' });
      const response = agent.parseResponse(stdout);
      expect(response.result).toBe('Done!');
    });

    test('scans a stream for the last result line', () => {
      const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', result: 'final', session_id: 's2' }),
      ].join('\n');
      const response = agent.parseResponse(stdout);
      expect(response.result).toBe('final');
      expect(response.session_id).toBe('s2');
    });

    // INVARIANT: a raw stream's init-line `model` lands on the response as
    // `model_id`. Cursor's result object has no model field, and the
    // supervisor's follow-up invocations (self-review, wrap-up, walkthrough)
    // hand parseResponse raw stdout — without this every one of those turns
    // records no model_id and reads as if it ran the requested alias.
    test('takes model_id from the init line of a stream', () => {
      const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's3', model: 'claude-opus-4-5-20251101' }),
        JSON.stringify({ type: 'result', result: 'final', session_id: 's3' }),
      ].join('\n');
      expect(agent.parseResponse(stdout).model_id).toBe('claude-opus-4-5-20251101');
    });

    test('leaves model_id unset when the init line reports no model', () => {
      const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's4' }),
        JSON.stringify({ type: 'result', result: 'final', session_id: 's4' }),
      ].join('\n');
      expect(agent.parseResponse(stdout).model_id).toBeUndefined();
    });

    test('throws on invalid JSON', () => {
      expect(() => agent.parseResponse('not json')).toThrow('Failed to parse Cursor output');
    });

    test('throws on empty stdout', () => {
      expect(() => agent.parseResponse('   ')).toThrow('empty stdout');
    });

    test('throws on missing result field, listing keys seen', () => {
      const stdout = JSON.stringify({ session_id: 'abc', foo: 1 });
      expect(() => agent.parseResponse(stdout)).toThrow(/missing required fields.*session_id, foo/);
    });

    test('throws on missing session id field', () => {
      const stdout = JSON.stringify({ result: 'hello' });
      expect(() => agent.parseResponse(stdout)).toThrow('missing required fields');
    });

    // INVARIANT (fix-cursor-output-block-of-text): Cursor may concatenate
    // logical blocks (thinking steps, markdown sections) without proper line
    // breaks. The parser must post-process the result to ensure readability.
    describe('result text formatting', () => {
      test('adds newlines before markdown headings stuck to previous text', () => {
        const stdout = JSON.stringify({
          result: 'Some text here.## Summary\n\nThis is the summary.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Some text here.\n\n## Summary\n\nThis is the summary.');
      });

      test('adds newlines before h3 headings', () => {
        const stdout = JSON.stringify({
          result: 'Done.### Details\n\nMore info.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Done.\n\n### Details\n\nMore info.');
      });

      test('preserves existing newlines before headings', () => {
        const stdout = JSON.stringify({
          result: 'Some text here.\n\n## Summary\n\nThis is the summary.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Some text here.\n\n## Summary\n\nThis is the summary.');
      });

      test('adds newlines before "Let me" step markers after sentence-ending punctuation', () => {
        const stdout = JSON.stringify({
          result: 'I will do this.Let me check the files.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('I will do this.\n\nLet me check the files.');
      });

      test('adds newlines before "Now I" step markers', () => {
        const stdout = JSON.stringify({
          result: 'Finished exploring.Now I will implement the changes.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Finished exploring.\n\nNow I will implement the changes.');
      });

      test('handles multiple concatenated step markers', () => {
        const stdout = JSON.stringify({
          result: 'Exploring the codebase.Let me check the files.Now I understand the structure.Let me implement the fix.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        const lines = response.result.split('\n\n');
        expect(lines.length).toBe(4);
        expect(lines[0]).toBe('Exploring the codebase.');
        expect(lines[1]).toBe('Let me check the files.');
        expect(lines[2]).toBe('Now I understand the structure.');
        expect(lines[3]).toBe('Let me implement the fix.');
      });

      test('does not add newlines when there is no sentence-ending punctuation before step marker', () => {
        const stdout = JSON.stringify({
          result: 'Let me check the files',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        // No change — "Let me" at the start should not be modified
        expect(response.result).toBe('Let me check the files');
      });

      test('handles realistic Cursor output with thinking steps and summary', () => {
        const stdout = JSON.stringify({
          result: 'Let me start by exploring the codebase.Let me check the files.Now I understand.## Summary\n\nHere is what I did.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toContain('Let me start by exploring the codebase.\n\nLet me check the files.');
        expect(response.result).toContain('Now I understand.\n\n## Summary');
      });

      // INVARIANT (fix-reviewer-cannot-access-mcp): the real mangling is not only
      // "I'll"/"Let me" — Cursor glues ANY mid-turn bubble onto the previous
      // sentence with no space ("else.MCP", "directly.Shell", "...JSON.```").
      test('splits sentences glued without whitespace (review-turn mangling)', () => {
        const stdout = JSON.stringify({
          result:
            "I'll review this task's branch hostilely: first the task context and diff, then security and data-integrity sweeps before anything else.MCP calls were rejected, so I'll inspect the worktree and git history directly.Shell is blocked in this review mode; I'll read the changed files.Filing raises for the confirmed gaps, then the verdict JSON.```json\n{\"verdict\":\"request changes\"}\n```",
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toContain('before anything else.\n\nMCP calls were rejected');
        expect(response.result).toContain('git history directly.\n\nShell is blocked');
        expect(response.result).toContain('the verdict JSON.\n\n```json');
      });
    });

    describe('content blocks extraction', () => {
      test('extracts and joins text from content blocks array', () => {
        const stdout = JSON.stringify({
          content: [
            { type: 'text', text: 'First block.' },
            { type: 'text', text: 'Second block.' },
          ],
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('First block.\n\nSecond block.');
      });

      test('extracts text from thinking blocks', () => {
        const stdout = JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'Analyzing the code.' },
            { type: 'text', text: 'Here is my answer.' },
          ],
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Analyzing the code.\n\nHere is my answer.');
      });

      test('extracts content from message.content structure', () => {
        const stdout = JSON.stringify({
          message: {
            content: [
              { type: 'text', text: 'Message content.' },
            ],
          },
          result: 'fallback',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Message content.');
      });

      test('falls back to result string if no content blocks found', () => {
        const stdout = JSON.stringify({
          result: 'Plain result string.',
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Plain result string.');
      });

      test('skips empty content blocks', () => {
        const stdout = JSON.stringify({
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'Non-empty.' },
            { type: 'text', text: '   ' },
          ],
          session_id: 's1',
        });
        const response = agent.parseResponse(stdout);
        expect(response.result).toBe('Non-empty.');
      });
    });
  });

  describe('auth', () => {
    const originalEnv = process.env.CURSOR_API_KEY;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.CURSOR_API_KEY = originalEnv;
      } else {
        delete process.env.CURSOR_API_KEY;
      }
    });

    // INVARIANT: hasAuthEnv always returns true — Cursor CLI can use its own login session.
    test('hasAuthEnv always returns true', () => {
      process.env.CURSOR_API_KEY = 'test-key';
      expect(agent.hasAuthEnv()).toBe(true);

      delete process.env.CURSOR_API_KEY;
      expect(agent.hasAuthEnv()).toBe(true);
    });

    test('getAuthEnvVars returns key when CURSOR_API_KEY is set', () => {
      process.env.CURSOR_API_KEY = 'test-key';
      const authVars = agent.getAuthEnvVars();
      expect(authVars).toEqual([{ key: 'CURSOR_API_KEY', value: 'test-key' }]);
    });

    // An empty-but-present CURSOR_API_KEY makes the CLI report "the provided
    // API key is invalid" instead of its actionable login hint — so an unset
    // key must yield NO env var at all.
    test('getAuthEnvVars returns nothing when CURSOR_API_KEY is not set', () => {
      delete process.env.CURSOR_API_KEY;
      expect(agent.getAuthEnvVars()).toEqual([]);
    });
  });

  describe('error detection', () => {
    test('detects prompt too long errors', () => {
      expect(agent.isPromptTooLongError('Prompt is too long')).toBe(true);
      expect(agent.isPromptTooLongError('Error: context length exceeded')).toBe(true);
      expect(agent.isPromptTooLongError('Some other error')).toBe(false);
    });

    test('detects session not found errors', () => {
      expect(agent.isSessionNotFoundError('session not found')).toBe(true);
      expect(agent.isSessionNotFoundError('invalid session')).toBe(true);
      expect(agent.isSessionNotFoundError('Some other error')).toBe(false);
    });
  });

  describe('classifyFailure', () => {
    // Messages verified against cursor-agent 2026.08.11 (see docstring in
    // src/agent/cursor.ts).
    test('classifies the real no-credential message as fatal_auth', () => {
      const failure = agent.classifyFailure({
        message: '',
        stderr: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
        exitCode: 1,
      });
      expect(failure.class).toBe('fatal_auth');
    });

    test('classifies the real invalid-key message as fatal_auth', () => {
      const failure = agent.classifyFailure({
        message: '',
        stderr: '⚠ Warning: The provided API key is invalid.\nThe API key was loaded from the CURSOR_API_KEY environment variable.',
        exitCode: 1,
      });
      expect(failure.class).toBe('fatal_auth');
    });

    // INVARIANT (cursor-first-class-agent §1): a missing binary can never heal
    // by retrying. The engineer's first real cursor run crash-looped a full
    // session on exactly this message classified `unknown`.
    test('classifies the spawn wrapper binary-not-found message as fatal, with the install hint', () => {
      const failure = agent.classifyFailure({
        message: "spawn failed: binary 'cursor-agent' not found",
        exitCode: undefined,
      });
      expect(failure.class).toBe('fatal_config');
      expect(failure.reason).toContain('curl https://cursor.com/install');
    });

    // INVARIANT (fix-cursor-action-required): Cursor's ActionRequiredError is
    // the provider saying a human must act — a spent plan quota, a spend limit
    // that must be raised, a model that needs switching. It classified
    // `unknown` and was retried ~6 times across two container generations
    // before the human killed it by hand.
    test('classifies the real plan/usage-limit ActionRequiredError as fatal_auth', () => {
      const failure = agent.classifyFailure({
        message:
          "ActionRequiredError: You've hit your usage limit for Opus You've saved $50 on API model usage " +
          'this month with Pro. Switch to a different model or set a Spend Limit to continue with Opus. ' +
          'Your usage limits will reset when your monthly cycle ends on 9/19/2026.',
        exitCode: 1,
      });
      expect(failure.class).toBe('fatal_auth');
    });

    // The actionable half is knowledge only Cursor has. A generic reason
    // ("plan limit reached") would leave the human with nothing to do, so the
    // provider's own wording must survive into the reason string.
    test('carries Cursor\'s own remedy into the reason, not a generic one', () => {
      const failure = agent.classifyFailure({
        message: '',
        stderr:
          "ActionRequiredError: You've hit your usage limit for Opus. Switch to a different model " +
          'or set a Spend Limit to continue with Opus.',
        exitCode: 1,
      });
      expect(failure.reason).toContain('Switch to a different model');
      expect(failure.reason).toContain('Spend Limit');
    });

    test('a spend-limit message without the error name is still fatal_auth', () => {
      const failure = agent.classifyFailure({
        message: '',
        stdoutError: 'Set a Spend Limit to continue with this model.',
        exitCode: 1,
      });
      expect(failure.class).toBe('fatal_auth');
    });

    // A genuine provider-side rate limit still heals on its own — the fatal
    // patterns above must not swallow it.
    test('an ordinary 429 stays transient_overload', () => {
      const failure = agent.classifyFailure({
        message: 'API Error: 429 rate limit exceeded',
        exitCode: 1,
      });
      expect(failure.class).toBe('transient_overload');
    });

    // INVARIANT: the plan-wall patterns run BEFORE the shared transient
    // signals, so a message carrying BOTH must not be decided by whichever
    // matcher happens to be first. A short-window cap that says "usage limit"
    // is still transient — calling it fatal blocks a task that was about to
    // recover, which is the incident's misclassification pointed the other way.
    test('a 429 whose body also says "usage limit" stays transient_overload', () => {
      const failure = agent.classifyFailure({
        message:
          "API Error: 429 — You've hit your usage limit for Sonnet. Resets in 20 minutes.",
        exitCode: 1,
      });
      expect(failure.class).toBe('transient_overload');
    });

    // Same hazard without the status code: the short reset horizon alone is
    // enough evidence that no human needs to act.
    test('a short reset horizon alone keeps a usage wall transient', () => {
      const failure = agent.classifyFailure({
        message: "You've hit your usage limit for Sonnet. Try again in 1 hour.",
        exitCode: 1,
      });
      expect(failure.class).toBe('transient_overload');
    });

    // And the converse, so the escape hatch cannot swallow the incident: a
    // horizon stated as a DATE (four weeks out) is not a healing signal.
    test('a reset horizon stated as a date stays fatal_auth', () => {
      const failure = agent.classifyFailure({
        message:
          "ActionRequiredError: You've hit your usage limit for Opus. Your usage limits will " +
          'reset when your monthly cycle ends on 9/19/2026.',
        exitCode: 1,
      });
      expect(failure.class).toBe('fatal_auth');
    });

    test('classifies unknown option as fatal_config', () => {
      const failure = agent.classifyFailure({ message: '', stderr: "error: unknown option '--bogus'", exitCode: 1 });
      expect(failure.class).toBe('fatal_config');
    });
  });

  describe('watchdog', () => {
    // INVARIANT (fix-cursor-silent-watchdog): 0 = "no agent-specific default",
    // so the configured `[agent] watchdog_output_timeout_ms` applies, same as
    // Claude Code / Codex / pi. This used to be 5 minutes as belt-and-braces
    // against a historic --print hang, but on the single-blob output format
    // that number was really "how long may a Cursor turn take" — a working turn
    // emitted nothing until it ended, and every longer one was killed and
    // retried. With an activity stream the guard measures forward progress, so
    // a per-agent shortcut is no longer needed.
    test('defers to the configured watchdog window', () => {
      expect(agent.defaultWatchdogTimeoutMs()).toBe(0);
    });

    // INVARIANT: Cursor HAS an activity stream, and its shapes were verified
    // against the shipped binary (see docs/cursor-stream-json.md). Without one
    // the guard falls back to counting bytes, which is the bug above.
    test('exposes an activity stream', () => {
      expect(agent.activityStream()).not.toBeNull();
    });
  });

  describe('CursorActivityStream', () => {
    let stream: CursorActivityStream;
    beforeEach(() => { stream = new CursorActivityStream(); });

    test('maps the init line to session_start carrying the session id and model', () => {
      const event = stream.parseLine(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 'chat-1', model: 'claude-opus-4-5-20251101', cwd: '/w',
      }));
      expect(event).toEqual({
        kind: 'session_start',
        sessionId: 'chat-1',
        model: 'claude-opus-4-5-20251101',
      });
    });

    test('session_start omits model when the init line has none', () => {
      const event = stream.parseLine(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 'chat-1',
      }));
      expect(event).toEqual({ kind: 'session_start', sessionId: 'chat-1' });
    });

    // INVARIANT (src/supervisor/mcp-verify.ts, rule 1): fail only on POSITIVE
    // evidence of zero tools. Cursor's init reports neither `mcp_servers` nor
    // `tools`, so both must stay undefined — empty arrays would read as "this
    // turn loaded no lazy tools" and abort every Cursor turn at session start.
    test('reports no MCP evidence on session_start', () => {
      const event = stream.parseLine(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 'chat-1',
      }));
      expect(event!.kind).toBe('session_start');
      expect(event!.mcpServers).toBeUndefined();
      expect(event!.toolNames).toBeUndefined();
    });

    test('maps tool_call started/completed to tool_start/tool_end', () => {
      const started = stream.parseLine(JSON.stringify({
        type: 'tool_call', subtype: 'started', call_id: 'c1', session_id: 'chat-1',
        tool_call: { tool: { case: 'readToolCall', value: {} } },
      }));
      expect(started).toEqual({ kind: 'tool_start', toolUseId: 'c1', toolName: 'read' });

      const completed = stream.parseLine(JSON.stringify({
        type: 'tool_call', subtype: 'completed', call_id: 'c1', session_id: 'chat-1',
        tool_call: { tool: { case: 'readToolCall', value: {} } },
      }));
      expect(completed).toEqual({ kind: 'tool_end', toolUseId: 'c1', toolName: 'read' });
    });

    test('maps the final result line to a result event with the raw line', () => {
      stream.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-1' }));
      const line = JSON.stringify({
        type: 'result', subtype: 'success', result: 'done', session_id: 'chat-1',
      });
      const event = stream.parseLine(line);
      expect(event!.kind).toBe('result');
      expect(event!.sessionId).toBe('chat-1');
      expect(event!.raw).toBe(line);
      // The isolated result line is what the supervisor hands parseResponse.
      expect(agent.parseResponse(event!.raw!).result).toContain('done');
    });

    // Cursor writes no keep-alive event, so nothing may map to `heartbeat`:
    // a heartbeat deliberately does NOT reset the no-progress timer, and
    // demoting real progress to one would resurrect the silent-kill bug.
    test('treats thinking, assistant and unknown events as forward progress', () => {
      for (const msg of [
        { type: 'thinking', subtype: 'delta', text: 'hm' },
        { type: 'assistant', message: { role: 'assistant', content: [] } },
        { type: 'user', message: { role: 'user', content: [] } },
        { type: 'system', subtype: 'task_notification' },
        { type: 'something_new_in_a_future_release' },
      ]) {
        expect(stream.parseLine(JSON.stringify(msg))).toEqual({ kind: 'progress' });
      }
    });

    test('ignores blank, non-JSON and truncated lines rather than throwing', () => {
      expect(stream.parseLine('')).toBeNull();
      expect(stream.parseLine('  ')).toBeNull();
      expect(stream.parseLine('Some plain warning from the CLI')).toBeNull();
      expect(stream.parseLine('{"type":"tool_call","subty')).toBeNull();
    });
  });

  describe('session files', () => {
    test('returns empty array (undocumented format)', () => {
      expect(agent.discoverSessionFiles({})).toEqual([]);
      expect(agent.discoverSessionFiles({ sessionId: 'abc' })).toEqual([]);
    });
  });
});

describe('CursorPackaging', () => {
  let pkg: CursorPackaging;

  beforeEach(() => {
    pkg = new CursorPackaging();
  });

  test('has agentId "cursor"', () => {
    expect(pkg.agentId).toBe('cursor');
  });

  test('config dir is .cursor', () => {
    expect(pkg.configDirName()).toBe('.cursor');
  });

  test('no npm package', () => {
    expect(pkg.npmPackage()).toBe('');
  });

  test('binary name is cursor-agent', () => {
    expect(pkg.binaryName()).toBe('cursor-agent');
  });

  // INVARIANT (cursor-first-class-agent): Cursor supports container runners —
  // this is the make-or-break requirement of first-class Cursor support.
  test('supports container runners', () => {
    expect(pkg.supportsContainerRunner()).toBe(true);
  });

  test('dockerInstallCommand is the official curl installer', () => {
    const cmd = pkg.dockerInstallCommand();
    expect(cmd).toContain('curl');
    expect(cmd).toContain('cursor.com/install');
  });

  test('generateDockerfile installs cursor-agent as non-root user', () => {
    const dockerfile = pkg.generateDockerfile();
    expect(dockerfile).toContain('cursor.com/install');
    expect(dockerfile).toContain('USER user');
  });

  test('supervisorToolChecks includes cursor-agent and git', () => {
    const checks = pkg.supervisorToolChecks();
    const names = checks.map(c => c.name);
    expect(names).toContain('git');
    expect(names).toContain('Cursor CLI');
    const cursorCheck = checks.find(c => c.name === 'Cursor CLI');
    // A bare binary name: the supervisor startup check resolves cmds with
    // `which`, which cannot take arguments.
    expect(cursorCheck?.cmd).toBe('cursor-agent');
  });
});

describe('Agent registry', () => {
  test('cursor is listed in available agents', () => {
    expect(listAgents()).toContain('cursor');
  });

  test('getAgent("cursor") returns CursorAgent', () => {
    const agent = getAgent('cursor');
    expect(agent.id).toBe('cursor');
  });

  test('getAgentPackaging("cursor") returns CursorPackaging', () => {
    const pkg = getAgentPackaging('cursor');
    expect(pkg.agentId).toBe('cursor');
  });

  // Capability matrix: claude-code and cursor run everywhere; qa-agent stays
  // host-only (preserving the pre-existing guard behavior for it).
  test('container capability matrix', () => {
    expect(getAgentPackaging('claude-code').supportsContainerRunner()).toBe(true);
    expect(getAgentPackaging('cursor').supportsContainerRunner()).toBe(true);
    expect(getAgentPackaging('qa-agent').supportsContainerRunner()).toBe(false);
  });

  // SECURITY INVARIANT (fix-cursor-security-musts): pairing is opt-in per agent.
  // Cursor was gated OFF because `lazy pair` ran the interactive session on the
  // HOST, which meant surfacing a container session required copying
  // agent-written history into the human's own ~/.cursor — agent-authored text
  // becoming input to a session running as the human, with `--force` on top.
  //
  // The gate was lifted in `pair-in-container` under exactly the condition its
  // predecessor named: pairing now runs INSIDE the task's container, over the
  // sandbox home the agent's own turns already write, so nothing crosses the
  // boundary and `--autonomous` is the same trust decision as a supervised turn.
  // Do NOT flip cursor back to false to "restore" the old refusal, and do not
  // flip a new agent to true while pairing could still land on the host: the
  // condition, not the value, is the invariant.
  test('pairing capability matrix', () => {
    expect(getAgent('claude-code').supportsPairing()).toBe(true);
    expect(getAgent('cursor').supportsPairing()).toBe(true);
    expect(getAgent('qa-agent').supportsPairing()).toBe(false);
  });

  // An agent that opts into pairing MUST be able to build an interactive argv —
  // otherwise `lazy pair` passes the capability gate on the host and dies inside
  // the container with nothing to launch.
  test('every pairing-capable agent can build interactive args', () => {
    for (const id of listAgents()) {
      const agent = getAgent(id);
      if (!agent.supportsPairing()) continue;
      // A model, as every pair launcher supplies one (pairSessionModel always
      // resolves one); every harness refuses a model-less launch.
      const argv = agent.buildInteractiveArgs({ modelId: 'some-model', dangerouslySkipPermissions: false });
      expect(Array.isArray(argv) && argv.length > 0).toBe(true);
    }
  });

  // A new agent must not become pairable by forgetting to think about it.
  test('every registered agent declares a pairing stance explicitly', () => {
    for (const id of listAgents()) {
      expect(typeof getAgent(id).supportsPairing()).toBe('boolean');
    }
  });
});
