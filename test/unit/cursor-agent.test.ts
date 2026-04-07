import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CursorAgent } from '../../src/agent/cursor';
import { CursorPackaging } from '../../src/agent/cursor-packaging';
import { getAgent, getAgentPackaging, listAgents } from '../../src/agent/registry';

describe('CursorAgent', () => {
  let agent: CursorAgent;

  beforeEach(() => {
    agent = new CursorAgent();
  });

  test('has id "cursor"', () => {
    expect(agent.id).toBe('cursor');
  });

  describe('buildExecArgs', () => {
    test('uses agent binary with --print and --trust', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
      expect(args[0]).toBe('agent');
      expect(args).toContain('--print');
      expect(args).toContain('--trust');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
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

    test('adds --force for dangerouslySkipPermissions', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: true,
      });
      expect(args).toContain('--force');
    });

    test('does not add --force when dangerouslySkipPermissions is false', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        dangerouslySkipPermissions: false,
      });
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

    test('omits --model when modelId is empty', () => {
      const args = agent.buildExecArgs({
        prompt: 'Hello',
        modelId: '',
        dangerouslySkipPermissions: false,
      });
      expect(args).not.toContain('--model');
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

    test('throws on invalid JSON', () => {
      expect(() => agent.parseResponse('not json')).toThrow('Failed to parse Cursor JSON output');
    });

    test('throws on missing result field', () => {
      const stdout = JSON.stringify({ session_id: 'abc' });
      expect(() => agent.parseResponse(stdout)).toThrow('missing required fields');
    });

    test('throws on missing session_id field', () => {
      const stdout = JSON.stringify({ result: 'hello' });
      expect(() => agent.parseResponse(stdout)).toThrow('missing required fields');
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

    test('getAuthEnvVars returns empty value when CURSOR_API_KEY is not set', () => {
      delete process.env.CURSOR_API_KEY;
      const authVars = agent.getAuthEnvVars();
      expect(authVars).toEqual([{ key: 'CURSOR_API_KEY', value: '' }]);
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

  describe('watchdog', () => {
    // INVARIANT: Cursor CLI has a known hanging bug — non-zero default timeout.
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

  test('binary name is agent', () => {
    expect(pkg.binaryName()).toBe('agent');
  });

  // INVARIANT: Cursor agent does not support Docker runner.
  test('dockerInstallCommand throws', () => {
    expect(() => pkg.dockerInstallCommand()).toThrow('does not support Docker');
  });

  // INVARIANT: Cursor agent does not support Docker runner.
  test('generateDockerfile throws', () => {
    expect(() => pkg.generateDockerfile()).toThrow('does not support Docker');
  });

  test('supervisorToolChecks includes agent and git', () => {
    const checks = pkg.supervisorToolChecks();
    const names = checks.map(c => c.name);
    expect(names).toContain('git');
    expect(names).toContain('Cursor CLI');
    // Verify it checks the 'agent' binary, not 'cursor'
    const cursorCheck = checks.find(c => c.name === 'Cursor CLI');
    expect(cursorCheck?.cmd).toBe('agent --version');
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
});
