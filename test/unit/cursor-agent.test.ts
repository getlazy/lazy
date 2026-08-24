import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CursorAgent } from '../../src/agent/cursor';
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
        const args = agent.buildExecArgs({ prompt: 'Hi', dangerouslySkipPermissions: false });
        const i = args.indexOf('--agent-endpoint');
        expect(i).toBeGreaterThan(-1);
        expect(args[i + 1]).toBe('http://127.0.0.1:8766/_lazy/cursor/agent/ab12');
      });

      test('omits the flag entirely when no endpoint is set', () => {
        delete process.env.CURSOR_API_ENDPOINT;
        const args = agent.buildExecArgs({ prompt: 'Hi', dangerouslySkipPermissions: false });
        expect(args).not.toContain('--agent-endpoint');
      });

      test('the prompt stays the last positional argument', () => {
        process.env.CURSOR_API_ENDPOINT = 'http://127.0.0.1:8766/_lazy/cursor/agent/ab12';
        const args = agent.buildExecArgs({ prompt: 'Hi', dangerouslySkipPermissions: false });
        expect(args[args.length - 1]).toBe('Hi');
      });
    });

    test('uses cursor-agent binary with --print and --trust', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      // Binary renamed from the legacy `agent` symlink to the documented name.
      expect(args[0]).toBe('cursor-agent');
      expect(args).toContain('--print');
      expect(args).toContain('--trust');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
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
        { prompt: 'Hello', dangerouslySkipPermissions: false },
        { prompt: 'Hello', dangerouslySkipPermissions: true },
        { prompt: 'Hello', dangerouslySkipPermissions: false, permissionMode: 'plan' as const },
        {
          prompt: 'Hello',
          dangerouslySkipPermissions: false,
          extraArgs: ['--sandbox', 'enabled'],
        },
      ]) {
        expect(agent.buildExecArgs(opts)).not.toContain('--approve-mcps');
      }
    });

    test('prompt is the last positional argument', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args[args.length - 1]).toBe('Hello');
    });

    test('prepends system prompt to user prompt', () => {
      const args = agent.buildExecArgs({
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
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--sandbox');
    });

    // INVARIANT: plan/ask turns must be read-only. Cursor has a native
    // read-only mode (--mode plan), used instead of Claude's tool-blocklist.
    test('permissionMode plan maps to --mode plan and suppresses --force', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: true,
        permissionMode: 'plan',
      });
      expect(args).toContain('--mode');
      expect(args).toContain('plan');
      expect(args).not.toContain('--force');
    });

    test('adds --resume with sessionId', () => {
      const args = agent.buildExecArgs({
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

    test('omits --model when modelId is empty', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        modelId: '',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--model');
    });

    // INVARIANT: "auto" is spelled by OMITTING --model. cursor-agent's flag is
    // optional and it then applies its own model selection — which is exactly
    // what auto means. The literal string is never sent: the CLI does no
    // client-side model validation, so a name the server doesn't know would
    // surface only as a failed turn.
    test('omits --model for the "auto" model, letting Cursor choose', () => {
      for (const modelId of ['auto', 'AUTO', '  auto  ']) {
        const args = agent.buildExecArgs({
          prompt: 'Hello',
          modelId,
          dangerouslySkipPermissions: false,
        });
        expect(args).not.toContain('--model');
        expect(args).not.toContain('auto');
      }
    });

    // The declared default is what resolveAgentModel falls back to for a Cursor
    // task with no explicit model — see test/unit/role-target.test.ts.
    test('declares "auto" as its default model', () => {
      expect(agent.defaultModel()).toBe('auto');
    });

    test('appends extraArgs after flags, before the prompt', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
        extraArgs: ['--extra-flag', 'value'],
      });
      expect(args).toContain('--extra-flag');
      expect(args[args.length - 1]).toBe('Hello');
    });

    test('omits optional flags when not provided', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--model');
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--append-system-prompt');
      expect(args).not.toContain('--worktree');
      expect(args).not.toContain('--mode');
    });

    // INVARIANT: --trust is always present in headless mode to avoid interactive prompts.
    test('always includes --trust', () => {
      const args = agent.buildExecArgs({
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
    // INVARIANT: Cursor CLI has a historic hanging bug — non-zero default timeout.
    test('returns non-zero default watchdog timeout', () => {
      expect(agent.defaultWatchdogTimeoutMs()).toBeGreaterThan(0);
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

  // SECURITY INVARIANT (fix-cursor-security-musts): pairing is opt-in per agent
  // and ONLY claude-code opts in. `lazy pair` hands a human an interactive
  // session on the HOST, in the task worktree. For any agent whose container
  // session lazy cannot surface without copying agent-written history onto the
  // host, that session is both dangerous (agent-authored text becomes input to
  // a session running as the human) and useless (no memory of the work).
  //
  // Do not flip cursor to true to "restore pairing". The gate is the decision.
  // It can only change when pairing itself runs inside the container, where
  // nothing needs importing across the boundary.
  test('pairing capability matrix', () => {
    expect(getAgent('claude-code').supportsPairing()).toBe(true);
    expect(getAgent('cursor').supportsPairing()).toBe(false);
    expect(getAgent('qa-agent').supportsPairing()).toBe(false);
  });

  // A new agent must not become pairable by forgetting to think about it.
  test('every registered agent declares a pairing stance explicitly', () => {
    for (const id of listAgents()) {
      expect(typeof getAgent(id).supportsPairing()).toBe('boolean');
    }
  });
});
