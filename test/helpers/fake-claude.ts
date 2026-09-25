/**
 * Fake `claude` binary — the low-level e2e seam for agent behavior.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original e2e seam (`test/mocks/claude.ts` + Bun `--preload`) replaces the
 * whole `src/capture/claude.ts` module, INCLUDING `launchSupervisorAsync`. That
 * means no e2e test can ever reach the supervisor at all: `execWithWatchdog`,
 * the no-progress kill, the wind-down kill, stream-json parsing, and response
 * capture are all downstream of a function the mock replaces wholesale. That is
 * why `fix-turn-end-detection` had to put every watchdog assertion at the unit
 * layer.
 *
 * This module moves the seam DOWN: instead of mocking lazy's own code, it
 * installs a scriptable fake `claude` executable on PATH. Combined with the
 * host-process runner (see `setupTestLazy({ fakeClaude: true })`), the entire
 * real stack runs unmocked — daemon → runner → `lazy supervise` subprocess →
 * `execWithWatchdog` → spawn(`claude`) → stream parsing → response.json — and
 * the only fake thing in the picture is the agent binary itself.
 *
 * SCRIPTING MODEL
 * ---------------
 * The binary is dumb on purpose: on each invocation it reads `scenario.json`
 * from its state directory and replays the steps in order. Tests rewrite that
 * file between turns, so a long-lived daemon (which cannot be re-env'd
 * per-test) still gets per-test agent behavior — the same file-based injection
 * pattern `test/mocks/remote.ts` uses for accept gates.
 *
 * Every invocation is appended to `invocations.jsonl`, so tests can assert on
 * the argv lazy actually handed the agent (`--resume`, `--output-format
 * stream-json`, `--model`, …) rather than trusting a mock's own bookkeeping.
 */

import {
  composeFakeAgentSource,
  installFakeAgent,
  setAgentScenario,
  recordAgentEnvKeys,
  readAgentInvocations,
  clearAgentInvocations,
  type FakeAgentBinary,
  type FakeAgentInvocation,
} from './fake-agent-core';

/** One scripted action of the fake agent. */
export type ClaudeStep =
  /** Write one JSON object as a stream-json line on stdout. */
  | { kind: 'emit'; event: Record<string, unknown> }
  /** Write raw text on stdout, verbatim (no newline added). */
  | { kind: 'stdout'; text: string }
  /** Write raw text on stderr, verbatim (no newline added). */
  | { kind: 'stderr'; text: string }
  /** Sleep. This is how "silent mid-turn" and "hangs after result" are expressed. */
  | { kind: 'sleep'; ms: number }
  /**
   * Write a file without committing it — the handoff channel a tools-down agent uses.
   * `path` may be absolute or relative to the cwd (the worktree); parent directories are created.
   */
  | { kind: 'write-file'; path: string; content: string }
  /** Write files in the cwd and `git commit` them — the agent "doing work". */
  | { kind: 'commit'; message: string; files: Array<{ path: string; content: string }> }
  /**
   * POST to `ANTHROPIC_BASE_URL` using the credential env the agent was launched
   * with — the shape Claude Code derives from `CLAUDE_CODE_OAUTH_TOKEN` (Bearer)
   * or `ANTHROPIC_API_KEY` (x-api-key). Used to exercise the proxy credential
   * swap on a real supervised turn without calling Anthropic.
   */
  | {
      kind: 'http';
      path?: string;
      method?: string;
      body?: unknown;
      /** Fail the step unless the response status matches. */
      expectStatus?: number;
      /** Write `{ status, ok }` into the fake's state dir under this filename. */
      recordFile?: string;
    }
  /**
   * Append a turn to a Claude session JSONL under
   * `$HOME/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — exactly what a
   * real INTERACTIVE `claude` session writes as it runs.
   *
   * This is the seam for builder conversation capture: capture watches those
   * files, so a test can only exercise it if the fake agent actually produces
   * them. Repeat the step (same sessionId) to grow a file mid-session, or use a
   * new sessionId to model the fresh segment `/clear`, compaction, and resume
   * roll to.
   */
  | { kind: 'session-jsonl'; sessionId: string; userText: string; assistantText: string }
  /** Stop ignoring nothing and exit immediately with this code. */
  | { kind: 'exit'; code: number }
  /**
   * Simulate the agent's `lazy_report` MCP call reaching the daemon: write the
   * presentation marker into the task's protocol dir (shared runtime step — see
   * fake-agent-core.ts). What the present step's invocation needs to pass §6.2
   * enforcement; deliberately scriptable so enforcement-failure suites omit it.
   */
  | { kind: 'declare-presentation' };

export interface ClaudeScenario {
  steps: ClaudeStep[];
  /**
   * Exit code once all steps are done (default 0). Ignored if a step already
   * exited.
   */
  exitCode?: number;
  /**
   * Swallow SIGTERM instead of dying. Use to exercise the watchdog's
   * SIGTERM→SIGKILL escalation (`KILL_GRACE_MS`); without it, a killed fake
   * agent exits on the first signal.
   */
  ignoreSigterm?: boolean;
}

/**
 * A scenario file may hold a single scenario (used for every invocation) or a
 * sequence — invocation N uses `sequence[N]`, with the last entry repeating.
 * The sequence form is what multi-turn tests (start → unblock) need.
 */
export type ClaudeScenarioFile = ClaudeScenario | { sequence: ClaudeScenario[] };

/**
 * Record of one fake-agent invocation, as written to invocations.jsonl.
 *
 * Structurally agent-agnostic (see `FakeAgentInvocation`), kept under this name
 * because every suite on this seam already imports it.
 */
export type ClaudeInvocation = FakeAgentInvocation;

// ---------------------------------------------------------------------------
// stream-json event builders
//
// Shapes here MUST stay in sync with what ClaudeCodeActivityStream parses
// (src/agent/activity-stream.ts). If a shape drifts, the watchdog stops seeing
// progress and these tests fail loudly rather than silently passing — which is
// the correct failure mode, and the reason the builders live in one place.
// ---------------------------------------------------------------------------

/** `{"type":"system","subtype":"init",…}` → `session_start`. */
export function sessionStartEvent(sessionId: string): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

/** An assistant message carrying a `tool_use` block → `tool_start`. */
export function toolUseEvent(toolUseId: string, toolName = 'Bash'): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: toolName }] },
  };
}

/** A user message carrying a `tool_result` block → `tool_end`. */
export function toolResultEvent(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  };
}

/**
 * `{"type":"tool_progress","heartbeat":true,…}` → `heartbeat`.
 *
 * INVARIANT (see activity-stream.ts): a heartbeat is liveness, NOT progress. A
 * scenario that emits only heartbeats must still be killed by the no-progress
 * guard — that is exactly what `heartbeatOnlyScenario` asserts.
 */
export function heartbeatEvent(toolUseId: string, toolName = 'mcp__slow__tool'): Record<string, unknown> {
  return { type: 'tool_progress', heartbeat: true, parent_tool_use_id: toolUseId, tool_name: toolName };
}

/**
 * The final `{"type":"result",…}` line — the agent's summary.
 *
 * `modelId` reproduces how Claude Code reports the CONCRETE model it ran: a
 * `modelUsage` map keyed by model id, not a flat field. Pass it when the test is
 * about per-turn model identity; omit it and the turn records only the alias the
 * host launched with, which is the honest shape for an agent that reports none.
 */
export function resultEvent(opts: {
  result: string;
  sessionId: string;
  inputTokens?: number;
  outputTokens?: number;
  modelId?: string;
}): Record<string, unknown> {
  const inputTokens = opts.inputTokens ?? 100;
  const outputTokens = opts.outputTokens ?? 200;
  return {
    type: 'result',
    subtype: 'success',
    result: opts.result,
    session_id: opts.sessionId,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    ...(opts.modelId
      ? { modelUsage: { [opts.modelId]: { inputTokens, outputTokens } } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Scenario builders for the common shapes
// ---------------------------------------------------------------------------

export interface SuccessScenarioOptions {
  result?: string;
  sessionId?: string;
  /** Files to write + commit before emitting the result (the "work"). */
  commit?: { message: string; files: Array<{ path: string; content: string }> };
  /** Concrete model id to self-report via `modelUsage` (see `resultEvent`). */
  modelId?: string;
  /**
   * Simulate the agent declaring its report presentation via `lazy_report`: the
   * fake writes the same `presentation.json` marker the daemon writes when a
   * real agent's MCP call arrives (see fake-agent-core's `declare-presentation`
   * step). A wrap-up turn's present invocation needs it — the real agent
   * declares when prompted with the presentation prompt, and the fake's stand-in
   * is this step. Deliberately NOT automatic: a suite exercising the §6.2
   * enforcement failure scripts a scenario WITHOUT it.
   */
  declarePresentation?: boolean;
}

/** Session start → a tool call → (optional commit) → result → exit 0. */
export function successScenario(opts: SuccessScenarioOptions = {}): ClaudeScenario {
  const sessionId = opts.sessionId ?? 'fake-sess-001';
  const steps: ClaudeStep[] = [
    { kind: 'emit', event: sessionStartEvent(sessionId) },
    { kind: 'emit', event: toolUseEvent('toolu_1') },
    { kind: 'emit', event: toolResultEvent('toolu_1') },
  ];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  if (opts.declarePresentation) {
    steps.push({ kind: 'declare-presentation' });
  }
  steps.push({
    kind: 'emit',
    event: resultEvent({
      result: opts.result ?? 'Fake agent completed the task.',
      sessionId,
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
    }),
  });
  return { steps };
}

/**
 * The wind-down case: the agent emits its final result and then refuses to
 * exit. The supervisor must keep the summary and treat the turn as successful.
 */
export function hangAfterResultScenario(opts: SuccessScenarioOptions & { hangMs?: number } = {}): ClaudeScenario {
  const base = successScenario(opts);
  return {
    ...base,
    steps: [...base.steps, { kind: 'sleep', ms: opts.hangMs ?? 120_000 }],
  };
}

/**
 * The no-progress case: the agent starts a tool call and then goes completely
 * silent. Only the no-progress guard can end this turn.
 */
export function goSilentScenario(opts: { sessionId?: string; silentMs?: number } = {}): ClaudeScenario {
  const sessionId = opts.sessionId ?? 'fake-sess-silent';
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'emit', event: toolUseEvent('toolu_stuck', 'Bash') },
      { kind: 'sleep', ms: opts.silentMs ?? 120_000 },
    ],
  };
}

/**
 * The wedged-MCP case: the agent never stops talking, but everything it says is
 * a heartbeat. Liveness without progress — must still be killed.
 */
export function heartbeatOnlyScenario(opts: { sessionId?: string; beats?: number; intervalMs?: number } = {}): ClaudeScenario {
  const sessionId = opts.sessionId ?? 'fake-sess-heartbeat';
  const beats = opts.beats ?? 60;
  const intervalMs = opts.intervalMs ?? 500;
  const steps: ClaudeStep[] = [
    { kind: 'emit', event: sessionStartEvent(sessionId) },
    { kind: 'emit', event: toolUseEvent('toolu_mcp', 'mcp__slow__tool') },
  ];
  for (let i = 0; i < beats; i++) {
    steps.push({ kind: 'sleep', ms: intervalMs });
    steps.push({ kind: 'emit', event: heartbeatEvent('toolu_mcp') });
  }
  return { steps };
}

/**
 * Session start → one proxied API request → result. The HTTP step is what proves
 * the placeholder the launch env handed the agent is swapped for the owner's
 * real credential before the stub upstream sees it.
 */
export function credentialSwapScenario(opts: {
  sessionId?: string;
  httpPath?: string;
  result?: string;
  recordFile?: string;
} = {}): ClaudeScenario {
  const sessionId = opts.sessionId ?? 'fake-sess-cred-swap';
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      {
        kind: 'http',
        path: opts.httpPath ?? '/v1/messages',
        expectStatus: 200,
        ...(opts.recordFile ? { recordFile: opts.recordFile } : {}),
      },
      {
        kind: 'emit',
        event: resultEvent({
          result: opts.result ?? 'Exercised the proxy credential swap.',
          sessionId,
        }),
      },
    ],
  };
}

/** The crash case: some stderr, then a non-zero exit with no result line. */
export function crashScenario(opts: { stderr?: string; exitCode?: number } = {}): ClaudeScenario {
  return {
    steps: [
      { kind: 'stderr', text: opts.stderr ?? 'API Error: 500 internal server error\n' },
      { kind: 'exit', code: opts.exitCode ?? 1 },
    ],
  };
}

/**
 * The expensive crash: the agent works, REPORTS ITS TOKEN USAGE, and only then
 * dies with a non-zero exit.
 *
 * This is the shape that used to lose money silently — the turn spent real
 * tokens, said so on the wire, and the supervisor threw all of it away with the
 * crash. The supervisor now salvages the reported usage onto the error response
 * (src/supervisor/usage.ts) so it lands on a turn record.
 */
export function crashAfterReportingUsageScenario(opts: {
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  stderr?: string;
  exitCode?: number;
} = {}): ClaudeScenario {
  const sessionId = opts.sessionId ?? 'fake-sess-crash-usage';
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'emit', event: toolUseEvent('toolu_1') },
      { kind: 'emit', event: toolResultEvent('toolu_1') },
      {
        kind: 'emit',
        event: resultEvent({
          result: 'Fake agent got this far.',
          sessionId,
          inputTokens: opts.inputTokens ?? 4_000,
          outputTokens: opts.outputTokens ?? 700,
        }),
      },
      { kind: 'stderr', text: opts.stderr ?? 'API Error: 500 internal server error\n' },
      { kind: 'exit', code: opts.exitCode ?? 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Installation / state
// ---------------------------------------------------------------------------

/**
 * An installed fake `claude` binary and its state directory.
 *
 * Structurally agent-agnostic (see `FakeAgentBinary`), kept under this name
 * because every suite on this seam already imports it.
 */
export type FakeClaude = FakeAgentBinary;

/**
 * Write the fake `claude` executable and its state directory.
 *
 * `installFakeAgent` (test/helpers/fake-agent-core.ts) owns the shebang and the
 * permissions; everything claude-specific about the binary is in
 * `FAKE_CLAUDE_PRELUDE` below.
 */
export async function installFakeClaude(dir: string): Promise<FakeClaude> {
  return await installFakeAgent(dir, 'claude', composeFakeAgentSource(FAKE_CLAUDE_PRELUDE));
}

/** Install (or replace) the scenario the fake agent will replay next. */
export async function setClaudeScenario(fake: FakeClaude, scenario: ClaudeScenarioFile): Promise<void> {
  await setAgentScenario(fake, scenario);
}

/**
 * Ask the fake agent to echo these env keys back on every future invocation.
 *
 * The proof a test needs for per-task env is "the agent's own process had this
 * variable" — nothing weaker (an argv containing `-e KEY=VALUE` only proves
 * lazy meant to). Values land in `ClaudeInvocation.env`.
 */
export async function recordClaudeEnvKeys(fake: FakeClaude, keys: string[]): Promise<void> {
  await recordAgentEnvKeys(fake, keys);
}

/** Every invocation of the fake agent so far, oldest first. */
export async function readClaudeInvocations(fake: FakeClaude): Promise<ClaudeInvocation[]> {
  return await readAgentInvocations(fake);
}

/** Forget every recorded invocation (useful between turns in one test). */
export async function clearClaudeInvocations(fake: FakeClaude): Promise<void> {
  await clearAgentInvocations(fake);
}

/**
 * The claude-specific half of the fake binary.
 *
 * `composeFakeAgentSource` sandwiches this between the shared preamble (which
 * defines `fs`, `path`, `spawnSync`, `stateDir`, `argv` and `sleep`) and the
 * shared runtime (which calls `agentProbe`, records the invocation, resolves
 * `DEFAULT_SCENARIO`, and dispatches non-generic step kinds to `runAgentStep`).
 * The result is standalone and uses only `node:` builtins: it runs outside the
 * test process, outside the repo's module graph, and in principle from a temp
 * dir with no node_modules.
 */
const FAKE_CLAUDE_PRELUDE = String.raw`
const FAKE_LABEL = 'fake claude';

// --version is asked by runner.checkAvailability() and by which-style probes
// long before any turn exists. Answering it here keeps it off the scenario, so
// a probe never consumes a sequence entry.
function agentProbe(argv) {
  if (argv.includes('--version')) {
    process.stdout.write('9.9.9 (Fake Claude Code for lazy e2e)\n');
    return true;
  }
  return false;
}

// Used when no scenario file exists: behave like a trivially successful agent
// so a test that never scripts one still gets a well-formed turn.
const DEFAULT_SCENARIO = {
  steps: [
    { kind: 'emit', event: { type: 'system', subtype: 'init', session_id: 'fake-sess-default' } },
    {
      kind: 'emit',
      event: {
        type: 'result',
        subtype: 'success',
        result: 'Fake agent default response.',
        session_id: 'fake-sess-default',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ],
};

async function runHttp(step) {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) throw new Error('fake claude: ANTHROPIC_BASE_URL is unset');
  const pathPart = step.path || '/v1/messages';
  const method = step.method || 'POST';
  const headers = { 'content-type': 'application/json' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    headers.authorization = 'Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  } else {
    throw new Error('fake claude: no credential env var set for http step');
  }
  const body = step.body !== undefined
    ? JSON.stringify(step.body)
    : JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      });
  const url = baseUrl.replace(/\/$/, '') + pathPart;
  const res = await fetch(url, { method, headers, body });
  const record = { status: res.status, ok: res.ok };
  if (step.recordFile) {
    fs.writeFileSync(path.join(stateDir, step.recordFile), JSON.stringify(record));
  }
  if (step.expectStatus !== undefined && res.status !== step.expectStatus) {
    throw new Error(
      'fake claude: http expected status ' + step.expectStatus + ' got ' + res.status,
    );
  }
  // Drain the body so the connection closes cleanly.
  await res.text().catch(() => '');
}

// Claude Code's cwd -> projects-dir-name encoding. MUST stay in lockstep with
// encodeProjectPath() in src/import/claude-code-logs.ts: capture locates session
// files by this name, so a divergence here would make the fake write somewhere
// capture never looks and turn a real bug into a green test.
function encodeProjectPath(p) {
  return '-' + p.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

function writeSessionJsonl(step) {
  const home = process.env.HOME;
  if (!home) throw new Error('fake claude: HOME is unset; cannot write session JSONL');
  const cwd = process.cwd();
  const dir = path.join(home, '.claude', 'projects', encodeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, step.sessionId + '.jsonl');
  const now = new Date().toISOString();
  const base = { sessionId: step.sessionId, cwd, version: '9.9.9', gitBranch: 'main', timestamp: now };
  const userUuid = 'u-' + Math.random().toString(16).slice(2);
  const asstUuid = 'a-' + Math.random().toString(16).slice(2);
  const lines = [
    JSON.stringify({
      ...base, type: 'user', uuid: userUuid, parentUuid: null,
      message: { role: 'user', content: step.userText },
    }),
    JSON.stringify({
      ...base, type: 'assistant', uuid: asstUuid, parentUuid: userUuid,
      message: {
        role: 'assistant',
        model: 'claude-fake-1',
        content: [{ type: 'text', text: step.assistantText }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ];
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

// The step kinds only Claude Code understands. Returning false hands an unknown
// kind back to the shared runtime, which fails loudly.
async function runAgentStep(step) {
  switch (step.kind) {
    case 'emit':
      process.stdout.write(JSON.stringify(step.event) + '\n');
      return true;
    case 'write-file': {
      const dir = path.dirname(step.path);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(step.path, step.content);
      return true;
    }
    case 'http':
      await runHttp(step);
      return true;
    case 'session-jsonl':
      writeSessionJsonl(step);
      return true;
    default:
      return false;
  }
}
`;
