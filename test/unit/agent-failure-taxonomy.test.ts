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
import { CursorPackaging } from '../../src/agent/cursor-packaging';
import { QaAgent } from '../../src/agent/qa-agent';
import { listAgents, getAgent } from '../../src/agent/registry';
import {
  classifyCommonFailureSignals,
  isFatalFailureClass,
} from '../../src/agent/failure-taxonomy';

describe('classifyCommonFailureSignals', () => {
  test("the spawn wrapper's binary-not-found message is fatal_config", () => {
    const failure = classifyCommonFailureSignals(
      { message: "spawn failed: binary 'claude' not found" },
      ['claude'],
    );
    expect(failure?.class).toBe('fatal_config');
  });

  test('exit 127 is fatal_config', () => {
    const failure = classifyCommonFailureSignals(
      { message: 'claude: command not found', exitCode: 127 },
      ['claude'],
    );
    expect(failure?.class).toBe('fatal_config');
  });

  // INVARIANT: a quoted shell "command not found" for some other tool is not
  // evidence the agent binary is missing — only an anchored line naming the
  // agent binary (or exit 127 / the spawn wrapper) may stop retries.
  test('quoted command-not-found for another tool is not fatal_config', () => {
    const failure = classifyCommonFailureSignals(
      {
        message: 'agent turn failed',
        stderr: 'I ran `npm test` and the shell said:\nsome-other-tool: command not found',
        exitCode: 1,
      },
      ['claude'],
    );
    expect(failure).toBeNull();
  });

  test('a genuine shell command-not-found for the agent binary is fatal_config', () => {
    const failure = classifyCommonFailureSignals(
      { message: '', stderr: 'claude: command not found', exitCode: 1 },
      ['claude'],
    );
    expect(failure?.class).toBe('fatal_config');
  });
});

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

  // INVARIANT: a 404 from a model API is fatal_config, never retried. The model
  // does not exist on the upstream this task's profile routes to, which no
  // number of attempts changes — a pi task on a profile with no endpoint (so,
  // Anthropic) ran an Ollama model name and burned its attempts on a 404 that
  // lazy classified `unknown`.
  test('a model-not-found 404 is fatal_config, and says which two things disagree', () => {
    const failure = agent.classifyFailure({
      message: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: qwen3.6:27b"}}',
    });
    expect(failure.class).toBe('fatal_config');
    expect(failure.reason).toMatch(/model/i);
    expect(failure.reason).toMatch(/endpoint|profile/i);

    expect(agent.classifyFailure({ message: 'openai error: model_not_found' }).class)
      .toBe('fatal_config');
  });

  // INVARIANT: Anthropic's spent-balance 400 is fatal_auth. Seen on a real pi
  // turn — it retried the same unpayable request until the crash-loop backstop.
  // Distinct from "usage limit reached" (the 5-hour window), which stays
  // transient because it reopens on its own.
  test('"out of extra usage" is fatal_auth, while a resetting usage limit stays transient', () => {
    expect(agent.classifyFailure({
      message: 'pi turn ended in error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
        '"message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
    }).class).toBe('fatal_auth');

    expect(agent.classifyFailure({ message: 'Claude AI usage limit reached|1758300000' }).class)
      .toBe('transient_overload');
  });

  // INVARIANT: a 404 the AGENT printed is not evidence about the model API. The
  // bare number only counts next to model-API evidence on the same line — the
  // same defence the "command not found" signal already needed, for the same
  // reason: agents quote their own work, and a wrong fatal stops a task with a
  // confident, wrong reason ("your model does not exist") pointing the human at
  // a model/endpoint pair that is fine.
  test('a 404 quoted from the agent\'s own work stays retryable', () => {
    expect(agent.classifyFailure({
      message: 'agent turn failed',
      stderr: [
        'I ran the smoke test and it printed:',
        '  GET /api/widgets -> 404',
        'so I fixed the route and re-ran it.',
      ].join('\n'),
      exitCode: 1,
    }).class).toBe('unknown');

    // A test asserting a status code is the same shape.
    expect(agent.classifyFailure({
      message: 'agent turn failed',
      stderr: 'expect(res.status).toBe(404)  // FAIL: received 200',
    }).class).toBe('unknown');
  });

  // …while the real model-API shapes still classify, structured or bare.
  test('model-API 404s still classify, with or without the structured wording', () => {
    expect(agent.classifyFailure({
      message: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: qwen3.6:27b"}}',
    }).class).toBe('fatal_config');
    expect(agent.classifyFailure({ message: 'http 404 from https://api.anthropic.com/v1/messages' }).class)
      .toBe('fatal_config');
    // Structured spellings say what they are and need no neighbour.
    expect(agent.classifyFailure({ message: 'the upstream reported model_not_found' }).class)
      .toBe('fatal_config');
  });

  // INVARIANT: the 404 rule is LAST among the shared signals. Ambiguity
  // resolves toward "keep trying" — a wrong fatal blocks a task that would have
  // recovered — so ANY auth, overload or connectivity evidence in the same text
  // wins, including a 404 the agent merely quoted from its own work.
  test('any transient or auth evidence outranks the 404 rule', () => {
    expect(agent.classifyFailure({ message: 'API Error: 429 rate limit (see /404 docs)' }).class)
      .toBe('transient_overload');
    expect(agent.classifyFailure({ message: 'API Error: 403 forbidden, 404 not_found_error' }).class)
      .toBe('fatal_auth');
    expect(agent.classifyFailure({ message: 'socket hang up', stderr: 'earlier: GET /thing 404' }).class)
      .toBe('transient_network');
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

  // INVARIANT (cursor-first-class-agent §1): the spawn wrapper's ENOENT
  // diagnosis is a COMMON signal — every agent must classify it fatal, since
  // no amount of retrying installs a binary. Uses the exact message from
  // src/utils/spawn.ts and no exit code (the spawn threw before one existed).
  test("the spawn wrapper's binary-not-found message is fatal_config for every agent", () => {
    for (const agentId of listAgents()) {
      const failure = getAgent(agentId).classifyFailure({
        message: "spawn failed: binary 'whatever' not found",
      });
      expect(failure.class, `${agentId} must classify a missing binary as fatal`).toBe('fatal_config');
    }
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

  // INVARIANT (fix-cursor-action-required): Claude's "usage limit reached" is a
  // rolling 5-hour window that heals with no human involved, so it stays
  // transient. Cursor's plan wall is fatal (see below) — that is why the fatal
  // patterns live in Cursor's own classifier and NOT in the shared signals.
  test('a Claude usage limit stays transient — it heals on its own', () => {
    const failure = agent.classifyFailure({
      message: 'Claude AI usage limit reached|1758300000',
      exitCode: 1,
    });
    expect(failure.class).toBe('transient_overload');
    expect(isFatalFailureClass(failure.class)).toBe(false);
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

  // INVARIANT: lazy launches `cursor-agent`, not the legacy `agent` symlink —
  // matching the bare name would stop retries when an agent's transcript quotes
  // `agent: command not found` from some other tool in the worktree.
  test('a bare agent: command not found line is not fatal_config', () => {
    const failure = agent.classifyFailure({
      message: '',
      stderr: 'agent: command not found',
      exitCode: 1,
    });
    expect(failure.class).not.toBe('fatal_config');
    expect(failure.class).toBe('unknown');
  });

  test('a genuine cursor-agent command-not-found line is fatal_config', () => {
    const launchBinary = new CursorPackaging().binaryName();
    const failure = agent.classifyFailure({
      message: '',
      stderr: `${launchBinary}: command not found`,
      exitCode: 1,
    });
    expect(failure.class).toBe('fatal_config');
  });

  // The counterpart to the Claude case above: same two words, opposite class,
  // decided in each agent's own dialect rather than in the shared matcher.
  test('a Cursor plan/spend-limit wall is fatal_auth — it needs a human', () => {
    const failure = agent.classifyFailure({
      message:
        "ActionRequiredError: You've hit your usage limit for Opus. Switch to a different model " +
        'or set a Spend Limit to continue with Opus.',
      exitCode: 1,
    });
    expect(failure.class).toBe('fatal_auth');
    expect(isFatalFailureClass(failure.class)).toBe(true);
  });

  // ...but only a wall a human must act on. The same words over a window that
  // says it clears shortly stay transient — ambiguity resolves toward "keep
  // trying", never toward a block. This message carries BOTH signals at once.
  test('a short-window Cursor cap saying "usage limit" is NOT fatal', () => {
    const failure = agent.classifyFailure({
      message: "API Error: 429 — you've hit your usage limit for Sonnet. Resets in 20 minutes.",
      exitCode: 1,
    });
    expect(failure.class).toBe('transient_overload');
    expect(isFatalFailureClass(failure.class)).toBe(false);
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
