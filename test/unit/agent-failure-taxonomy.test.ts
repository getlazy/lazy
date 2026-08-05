/**
 * Unit tests for the agent failure taxonomy.
 *
 * INVARIANT: failure classification lives behind the AGENT abstraction. The
 * supervisor must never match error strings itself — every agent maps its own
 * raw stderr/stdout/exit code to the shared taxonomy, and the supervisor
 * consumes only the class. These tests pin the mapping per agent.
 */

import { describe, test, expect } from 'bun:test';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { CursorAgent } from '../../src/agent/cursor';
import { QaAgent } from '../../src/agent/qa-agent';
import { listAgents, getAgent } from '../../src/agent/registry';
import { isFatalFailureClass } from '../../src/agent/failure-taxonomy';

describe('ClaudeCodeAgent.classifyFailure', () => {
  const agent = new ClaudeCodeAgent();

  test('the observed incident error is transient_unreachable, not unknown', () => {
    // The live failure that motivated this work: the daemon had no usable
    // credential, so every launch died with a refused connection to the local
    // proxy. Refused connections CAN heal (proxy restart), so they are
    // transient — but bounded (see retry-policy), never an infinite spin.
    const failure = agent.classifyFailure({
      message: 'API Error: Unable to connect to API (ConnectionRefused)',
      exitCode: 1,
    });
    expect(failure.class).toBe('transient_unreachable');
  });

  test('missing credential (lazy pre-flight) is fatal_auth', () => {
    const failure = agent.classifyFailure({
      message: 'Authentication required. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
    });
    expect(failure.class).toBe('fatal_auth');
    expect(isFatalFailureClass(failure.class)).toBe(true);
  });

  test('401/403 and invalid API key are fatal_auth', () => {
    expect(agent.classifyFailure({ message: 'API Error: 401 {"type":"authentication_error"}' }).class)
      .toBe('fatal_auth');
    expect(agent.classifyFailure({ message: 'Invalid API key · Please run /login' }).class)
      .toBe('fatal_auth');
    expect(agent.classifyFailure({ message: 'API Error: 403 Forbidden' }).class)
      .toBe('fatal_auth');
  });

  test('billing exhaustion is fatal_auth — no retry cadence fixes an empty balance', () => {
    expect(agent.classifyFailure({ message: 'Your credit balance is too low to access the Anthropic API' }).class)
      .toBe('fatal_auth');
  });

  test('429/529/503 and overload are transient_overload', () => {
    expect(agent.classifyFailure({ message: 'API Error: 429 rate_limit_error' }).class)
      .toBe('transient_overload');
    expect(agent.classifyFailure({ message: 'API Error: 529 {"type":"overloaded_error"}' }).class)
      .toBe('transient_overload');
    expect(agent.classifyFailure({ message: 'API Error: 503 Service Unavailable' }).class)
      .toBe('transient_overload');
  });

  test('auth wins over an overload-looking body — order matters', () => {
    // A 403 body that mentions limits must not be read as a rate limit and
    // retried forever.
    const failure = agent.classifyFailure({
      message: 'API Error: 403 {"error":"organization has reached its limit"}',
    });
    expect(failure.class).toBe('fatal_auth');
  });

  test('socket/timeout errors are transient_network', () => {
    expect(agent.classifyFailure({ message: 'read ECONNRESET' }).class).toBe('transient_network');
    expect(agent.classifyFailure({ message: 'connect ETIMEDOUT 1.2.3.4:443' }).class).toBe('transient_network');
    expect(agent.classifyFailure({ message: 'TypeError: fetch failed' }).class).toBe('transient_network');
  });

  test('DNS failure is transient_unreachable (bounded), not plain network', () => {
    // A mistyped ANTHROPIC_BASE_URL never resolves; retrying it forever is the
    // exact spin this work exists to prevent.
    expect(agent.classifyFailure({ message: 'getaddrinfo ENOTFOUND proxy.invalid' }).class)
      .toBe('transient_unreachable');
  });

  test('exit 127 (binary missing) is fatal_config', () => {
    const failure = agent.classifyFailure({ message: 'claude: command not found', exitCode: 127 });
    expect(failure.class).toBe('fatal_config');
  });

  test('bad model or unknown flag is fatal_config', () => {
    expect(agent.classifyFailure({ message: "error: unknown option '--nope'" }).class).toBe('fatal_config');
    expect(agent.classifyFailure({ message: 'Invalid model name: claude-imaginary-9' }).class).toBe('fatal_config');
  });

  test('classification reads stderr and stdout_error, not just message', () => {
    const failure = agent.classifyFailure({
      message: 'exit code 1',
      stderr: 'API Error: 429 rate_limit_error',
    });
    expect(failure.class).toBe('transient_overload');

    const fromStdout = agent.classifyFailure({
      message: 'exit code 1',
      stdoutError: 'Invalid API key · Please run /login',
    });
    expect(fromStdout.class).toBe('fatal_auth');
  });

  test('unrecognized failures are unknown — never guessed into fatal', () => {
    // A wrong `fatal_*` blocks a task that would have recovered, so the
    // classifier must fail toward "keep trying".
    const failure = agent.classifyFailure({ message: 'Segmentation fault (core dumped)' });
    expect(failure.class).toBe('unknown');
    expect(isFatalFailureClass(failure.class)).toBe(false);
  });
});

describe('CursorAgent.classifyFailure', () => {
  const agent = new CursorAgent();

  test('not-logged-in is fatal_auth (Cursor dialect)', () => {
    expect(agent.classifyFailure({ message: 'Error: not logged in. Please run `agent login`.' }).class)
      .toBe('fatal_auth');
  });

  test('shares the common HTTP/network signals', () => {
    expect(agent.classifyFailure({ message: '429 Too Many Requests' }).class).toBe('transient_overload');
    expect(agent.classifyFailure({ message: 'connect ECONNREFUSED 127.0.0.1:4000' }).class)
      .toBe('transient_unreachable');
  });

  test('unrecognized failures are unknown', () => {
    expect(agent.classifyFailure({ message: 'weird cursor explosion' }).class).toBe('unknown');
  });
});

describe('QaAgent.classifyFailure', () => {
  test('always unknown — the qa-agent never talks to a provider', () => {
    const agent = new QaAgent();
    expect(agent.classifyFailure({ message: '429 rate limit' }).class).toBe('unknown');
    expect(agent.classifyFailure({ message: 'scenario file missing' }).class).toBe('unknown');
  });
});

describe('taxonomy coverage', () => {
  // INVARIANT: every registered agent implements classifyFailure. A new agent
  // that forgets it would make the supervisor error-blind again for that agent.
  test('every registered agent classifies failures', () => {
    for (const id of listAgents()) {
      const agent = getAgent(id);
      const failure = agent.classifyFailure({ message: 'something went wrong' });
      expect(typeof failure.class).toBe('string');
      expect(failure.reason.length).toBeGreaterThan(0);
    }
  });
});
