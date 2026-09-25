/**
 * Fake `cursor-agent` binary — the low-level e2e seam for Cursor turns.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/helpers/fake-claude.ts` gave Claude turns a seam where NOTHING in
 * `src/` is mocked: the daemon really launches `lazy supervise`, which really
 * spawns an agent binary, and only that binary is fake. Cursor had no
 * equivalent, so everything between "the daemon decided to run a cursor turn"
 * and "cursor-agent was executed" — the argv `CursorAgent.buildExecArgs`
 * builds, the credential placeholder the runner mints, the
 * `CURSOR_API_ENDPOINT` that points the agent at lazy's proxy — was covered
 * only at unit level, against functions called directly rather than through a
 * launch.
 *
 * This is that seam for Cursor. It shares all of its agent-agnostic machinery
 * with the claude fake (see `test/helpers/fake-agent-core.ts`): the same state
 * directory layout, the same `invocations.jsonl`, the same
 * single-scenario-or-`{sequence:[…]}` file, the same generic steps.
 *
 * WHAT THIS FAKE'S OUTPUT IS MODELLED ON — read before adding a step kind
 * ----------------------------------------------------------------------
 * The stream-json events emitted here are the REAL ones, read off the stdout
 * emitters in the shipped cursor-agent bundle (2026.09.02-c22c1a3) — see the
 * `CursorActivityStream` docblock in `src/agent/cursor.ts` for the full
 * provenance and the exact object list, and docs/cursor-stream-json.md for the
 * capture method. They are not invented, which the seam doc forbids; when
 * Cursor's format moves, both files move together.
 *
 * The final `{"type":"result",…}` object keeps the keys
 * `CursorAgent.parseResponse` actually reads (`result` / `session_id` from its
 * RESULT_KEYS / SESSION_KEYS), which is also what the real binary emits.
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

/** One scripted action of the fake cursor agent. */
export type CursorStep =
  /**
   * Write the turn's final `{"type":"result",…}` object on stdout — the last
   * line of the stream, in the shape `CursorAgent.parseResponse` consumes.
   */
  | { kind: 'respond'; result: string; sessionId: string; inputTokens?: number; outputTokens?: number }
  /** Write one stream-json event object on stdout as a single NDJSON line. */
  | { kind: 'emit'; event: Record<string, unknown> }
  /** Write raw text on stdout, verbatim (no newline added). */
  | { kind: 'stdout'; text: string }
  /** Write raw text on stderr, verbatim (no newline added). */
  | { kind: 'stderr'; text: string }
  /** Sleep. This is how "silent mid-turn" and "hangs after result" are expressed. */
  | { kind: 'sleep'; ms: number }
  /** Write files in the cwd and `git commit` them — the agent "doing work". */
  | { kind: 'commit'; message: string; files: Array<{ path: string; content: string }> }
  /**
   * Make one API request the way an authenticated cursor-agent would: at
   * `CURSOR_API_ENDPOINT` (which lazy points at its proxy's
   * `/_lazy/cursor/<placeholder>` route) with `Authorization: Bearer
   * $CURSOR_API_KEY`. This is what proves a LAUNCHED cursor turn's own traffic
   * carries the placeholder and gets the real key swapped in upstream —
   * something a test that synthesizes the request itself cannot show.
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
  /** Exit immediately with this code. */
  | { kind: 'exit'; code: number };

export interface CursorScenario {
  steps: CursorStep[];
  /**
   * Exit code once all steps are done (default 0). Ignored if a step already
   * exited.
   */
  exitCode?: number;
  /**
   * Swallow SIGTERM instead of dying. Use to exercise the watchdog's
   * SIGTERM→SIGKILL escalation; without it, a killed fake agent exits on the
   * first signal.
   */
  ignoreSigterm?: boolean;
}

/**
 * A scenario file may hold a single scenario (used for every invocation) or a
 * sequence — invocation N uses `sequence[N]`, with the last entry repeating.
 * The sequence form is what multi-turn tests (start → unblock) need, and it is
 * how the `--resume` half of the argv contract gets exercised.
 */
export type CursorScenarioFile = CursorScenario | { sequence: CursorScenario[] };

/**
 * Record of one fake-agent invocation, as written to invocations.jsonl.
 *
 * Same structure as the claude seam's — the recording is agent-agnostic.
 */
export type CursorInvocation = FakeAgentInvocation;

// ---------------------------------------------------------------------------
// Stream-json event builders (shapes verified against the real binary)
// ---------------------------------------------------------------------------

/** The first line of every stream: `{"type":"system","subtype":"init",…}`. */
export function cursorInitEvent(sessionId: string, model = 'auto'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: sessionId,
    // Concrete id cursor-agent reports at session start — the only place a
    // Cursor turn learns what actually ran (the result object has no model).
    model,
    permissionMode: 'default',
  };
}

/** `{"type":"tool_call","subtype":"started",…}` — forward progress. */
export function cursorToolStartEvent(callId: string, sessionId: string): Record<string, unknown> {
  return {
    type: 'tool_call',
    subtype: 'started',
    call_id: callId,
    tool_call: { tool: { case: 'readToolCall', value: { args: { path: 'README.md' } } } },
    model_call_id: `model-${callId}`,
    session_id: sessionId,
    timestamp_ms: Date.now(),
  };
}

/** `{"type":"tool_call","subtype":"completed",…}` — forward progress. */
export function cursorToolEndEvent(callId: string, sessionId: string): Record<string, unknown> {
  return {
    ...cursorToolStartEvent(callId, sessionId),
    subtype: 'completed',
  };
}

// ---------------------------------------------------------------------------
// Scenario builders for the common shapes
// ---------------------------------------------------------------------------

export interface CursorSuccessOptions {
  result?: string;
  sessionId?: string;
  /** Concrete `model` on the init line. Defaults to `auto`, matching the real CLI. */
  model?: string;
  /** Files to write + commit before responding (the "work"). */
  commit?: { message: string; files: Array<{ path: string; content: string }> };
}

/** init → a tool call → (optional commit) → result object → exit 0. */
export function cursorSuccessScenario(opts: CursorSuccessOptions = {}): CursorScenario {
  const sessionId = opts.sessionId ?? 'fake-chat-001';
  const steps: CursorStep[] = [
    { kind: 'emit', event: cursorInitEvent(sessionId, opts.model) },
    { kind: 'emit', event: cursorToolStartEvent('call_1', sessionId) },
    { kind: 'emit', event: cursorToolEndEvent('call_1', sessionId) },
  ];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Fake cursor agent completed the task.',
    sessionId,
  });
  return { steps };
}

/**
 * A LONG but healthy turn: real tool-call events spread over `totalMs`, then a
 * result. Each event is forward progress, so a no-progress window shorter than
 * `totalMs` (but longer than the gap between events) must NOT kill it.
 *
 * This is the regression shape for the bug this seam was extended for: on the
 * single-blob `--output-format json` this turn was indistinguishable from a
 * wedged one, and every Cursor turn longer than the window was killed and
 * retried.
 */
export function cursorBusyScenario(opts: {
  sessionId?: string;
  /** Number of tool calls to make. */
  toolCalls?: number;
  /** Gap between consecutive events. */
  gapMs?: number;
  result?: string;
  commit?: { message: string; files: Array<{ path: string; content: string }> };
} = {}): CursorScenario {
  const sessionId = opts.sessionId ?? 'fake-chat-busy';
  const toolCalls = opts.toolCalls ?? 6;
  const gapMs = opts.gapMs ?? 500;
  const steps: CursorStep[] = [{ kind: 'emit', event: cursorInitEvent(sessionId) }];
  for (let i = 0; i < toolCalls; i++) {
    steps.push({ kind: 'sleep', ms: gapMs });
    steps.push({ kind: 'emit', event: cursorToolStartEvent(`call_${i}`, sessionId) });
    steps.push({ kind: 'sleep', ms: gapMs });
    steps.push({ kind: 'emit', event: cursorToolEndEvent(`call_${i}`, sessionId) });
  }
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Fake cursor agent worked for a long time.',
    sessionId,
  });
  return { steps };
}

/**
 * The genuinely wedged turn: a tool call starts and nothing else is ever
 * written. Only the no-progress guard can end it — and it still must.
 */
export function cursorGoSilentScenario(opts: { sessionId?: string; silentMs?: number } = {}): CursorScenario {
  const sessionId = opts.sessionId ?? 'fake-chat-silent';
  return {
    steps: [
      { kind: 'emit', event: cursorInitEvent(sessionId) },
      { kind: 'emit', event: cursorToolStartEvent('call_stuck', sessionId) },
      { kind: 'sleep', ms: opts.silentMs ?? 120_000 },
      { kind: 'respond', result: 'should never be reached', sessionId },
    ],
  };
}

/**
 * One proxied API request, then a normal response.
 *
 * The HTTP step is what proves the placeholder the launch env handed the agent
 * is swapped for the owner's real Cursor key before the stub upstream sees it.
 */
export function cursorProxiedCallScenario(opts: {
  sessionId?: string;
  result?: string;
  httpPath?: string;
  recordFile?: string;
  commit?: { message: string; files: Array<{ path: string; content: string }> };
} = {}): CursorScenario {
  const sessionId = opts.sessionId ?? 'fake-chat-proxy';
  const steps: CursorStep[] = [
    {
      kind: 'http',
      path: opts.httpPath ?? '/aiserver.v1.ChatService/StreamUnifiedChat',
      expectStatus: 200,
      ...(opts.recordFile ? { recordFile: opts.recordFile } : {}),
    },
  ];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Exercised the cursor proxy route.',
    sessionId,
  });
  return { steps };
}

/** The crash case: some stderr, then a non-zero exit with no response object. */
export function cursorCrashScenario(opts: { stderr?: string; exitCode?: number } = {}): CursorScenario {
  return {
    steps: [
      { kind: 'stderr', text: opts.stderr ?? 'Error: something went wrong\n' },
      { kind: 'exit', code: opts.exitCode ?? 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Installation / state
// ---------------------------------------------------------------------------

/**
 * An installed fake `cursor-agent` binary and its state directory.
 *
 * Note the binary NAME: `CursorPackaging.binaryName()` is `cursor-agent`, and
 * that is what both the availability probe and the spawn use. Installing it
 * under any other name means the runner's `checkAvailability()` never finds it
 * and the turn dies before the argv contract is ever exercised.
 */
export type FakeCursor = FakeAgentBinary;

/** Write the fake `cursor-agent` executable and its state directory. */
export async function installFakeCursor(dir: string): Promise<FakeCursor> {
  return await installFakeAgent(dir, 'cursor-agent', composeFakeAgentSource(FAKE_CURSOR_PRELUDE));
}

/** Install (or replace) the scenario the fake agent will replay next. */
export async function setCursorScenario(fake: FakeCursor, scenario: CursorScenarioFile): Promise<void> {
  await setAgentScenario(fake, scenario);
}

/** Ask the fake agent to echo these env keys back on every future invocation. */
export async function recordCursorEnvKeys(fake: FakeCursor, keys: string[]): Promise<void> {
  await recordAgentEnvKeys(fake, keys);
}

/** Every invocation of the fake agent so far, oldest first. */
export async function readCursorInvocations(fake: FakeCursor): Promise<CursorInvocation[]> {
  return await readAgentInvocations(fake);
}

/** Forget every recorded invocation (useful between turns in one test). */
export async function clearCursorInvocations(fake: FakeCursor): Promise<void> {
  await clearAgentInvocations(fake);
}

/**
 * The cursor-specific half of the fake binary.
 *
 * `composeFakeAgentSource` sandwiches this between the shared preamble (which
 * defines `fs`, `path`, `spawnSync`, `stateDir`, `argv` and `sleep`) and the
 * shared runtime (which calls `agentProbe`, records the invocation, resolves
 * `DEFAULT_SCENARIO`, and dispatches non-generic step kinds to `runAgentStep`).
 */
const FAKE_CURSOR_PRELUDE = String.raw`
const FAKE_LABEL = 'fake cursor-agent';

// Probe invocations, answered without touching the scenario so they never
// consume a sequence entry:
//   --version  HostProcessRunner.checkAvailability() and CursorPackaging
//              .diagnose() both run it before any turn exists.
//   status     CursorPackaging.diagnose() reads it for auth state. "Not logged
//              in" on exit 0 is the real CLI's un-authenticated answer, and is
//              informational there — a launch supplies CURSOR_API_KEY.
function agentProbe(argv) {
  if (argv.includes('--version')) {
    process.stdout.write('2026.08.11-fake\n');
    return true;
  }
  if (argv[0] === 'status') {
    process.stdout.write('Not logged in\n');
    return true;
  }
  return false;
}

// Used when no scenario file exists: a well-formed one-object response, so a
// test that never scripts one still gets a parseable turn.
const DEFAULT_SCENARIO = {
  steps: [
    {
      kind: 'emit',
      event: { type: 'system', subtype: 'init', session_id: 'fake-chat-default', model: 'auto' },
    },
    { kind: 'respond', result: 'Fake cursor agent default response.', sessionId: 'fake-chat-default' },
  ],
};

// The final object of a --output-format stream-json turn. Same shape the
// single-blob json format used to emit, and the keys CursorAgent.parseResponse
// actually reads (RESULT_KEYS / SESSION_KEYS in src/agent/cursor.ts).
function writeResponse(step) {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: step.result,
    session_id: step.sessionId,
    usage: {
      input_tokens: step.inputTokens === undefined ? 100 : step.inputTokens,
      output_tokens: step.outputTokens === undefined ? 200 : step.outputTokens,
    },
  }) + '\n');
}

// One API call as an authenticated cursor-agent would make it: at
// CURSOR_API_ENDPOINT (lazy points this at its proxy's /_lazy/cursor/<token>
// route) with the launch's CURSOR_API_KEY as a bearer token.
async function runHttp(step) {
  const endpoint = process.env.CURSOR_API_ENDPOINT;
  if (!endpoint) throw new Error(FAKE_LABEL + ': CURSOR_API_ENDPOINT is unset');
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error(FAKE_LABEL + ': CURSOR_API_KEY is unset for http step');
  const pathPart = step.path || '/aiserver.v1.ChatService/StreamUnifiedChat';
  const method = step.method || 'POST';
  const body = step.body !== undefined
    ? JSON.stringify(step.body)
    : JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] });
  const url = endpoint.replace(/\/$/, '') + pathPart;
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body,
  });
  const record = { status: res.status, ok: res.ok };
  if (step.recordFile) {
    fs.writeFileSync(path.join(stateDir, step.recordFile), JSON.stringify(record));
  }
  if (step.expectStatus !== undefined && res.status !== step.expectStatus) {
    throw new Error(FAKE_LABEL + ': http expected status ' + step.expectStatus + ' got ' + res.status);
  }
  // Drain the body so the connection closes cleanly.
  await res.text().catch(() => '');
}

// The step kinds only cursor understands. Returning false hands an unknown kind
// back to the shared runtime, which fails loudly.
async function runAgentStep(step) {
  switch (step.kind) {
    case 'respond':
      writeResponse(step);
      return true;
    case 'emit':
      process.stdout.write(JSON.stringify(step.event) + '\n');
      return true;
    case 'http':
      await runHttp(step);
      return true;
    default:
      return false;
  }
}
`;
