/**
 * Fake `pi` binary — the low-level e2e seam for pi turns.
 *
 * Same seam as `fake-claude.ts` / `fake-cursor.ts` (see those headers and
 * `fake-agent-core.ts` for the machinery): nothing in `src/` is mocked, the
 * daemon really launches `lazy supervise`, which really spawns this binary —
 * so what gets exercised is the argv `PiAgent.buildExecArgs` builds, the
 * launch env (LAZY_PI_PROVIDER, the credential placeholders, the PI_OFFLINE
 * flags), and the supervisor's stream/watchdog handling of pi's output.
 *
 * UNLIKE the cursor fake, this one's output is modelled on CAPTURED REAL
 * OUTPUT: pi 0.84.4's `--mode json` JSONL stream was recorded against a
 * scripted Anthropic-wire server (test/fixtures/pi/*.jsonl, add-pi-agent) and
 * the event shapes are additionally documented in the npm package's own
 * docs/json.md. The `respond` step emits that verified shape — session header
 * first, lifecycle events, `agent_end` carrying the messages — because
 * `PiActivityStream` genuinely parses it in production.
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

/** One scripted action of the fake pi agent. */
export type PiStep =
  /**
   * Emit one full turn's JSONL stream: session header, lifecycle events, an
   * assistant message, `agent_end`, `agent_settled` — the verified shape of
   * `pi -p --mode json`. The session id honors the launch's `--session-id`
   * argument when present (pi's exact-id create-or-resume contract), else
   * `sessionId`, else a fixed default.
   */
  | { kind: 'respond'; result: string; sessionId?: string; inputTokens?: number; outputTokens?: number; model?: string; errorMessage?: string }
  /** Write raw text on stdout, verbatim (no newline added). */
  | { kind: 'stdout'; text: string }
  /** Write raw text on stderr, verbatim (no newline added). */
  | { kind: 'stderr'; text: string }
  /** Sleep. This is how "silent mid-turn" and "hangs after result" are expressed. */
  | { kind: 'sleep'; ms: number }
  /** Write files in the cwd and `git commit` them — the agent "doing work". */
  | { kind: 'commit'; message: string; files: Array<{ path: string; content: string }> }
  /** Exit immediately with this code. */
  | { kind: 'exit'; code: number };

export interface PiScenario {
  steps: PiStep[];
  /** Exit code once all steps are done (default 0). Ignored if a step already exited. */
  exitCode?: number;
  /** Swallow SIGTERM to exercise the watchdog's SIGTERM→SIGKILL escalation. */
  ignoreSigterm?: boolean;
}

/** Single scenario, or a per-invocation sequence (last entry repeats). */
export type PiScenarioFile = PiScenario | { sequence: PiScenario[] };

export type PiInvocation = FakeAgentInvocation;

// ---------------------------------------------------------------------------
// Scenario builders for the common shapes
// ---------------------------------------------------------------------------

export interface PiSuccessOptions {
  result?: string;
  sessionId?: string;
  /** Files to write + commit before responding (the "work"). */
  commit?: { message: string; files: Array<{ path: string; content: string }> };
}

/** (optional commit) → one verified-shape JSONL turn → exit 0. */
export function piSuccessScenario(opts: PiSuccessOptions = {}): PiScenario {
  const steps: PiStep[] = [];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Fake pi agent completed the task.',
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  return { steps };
}

/**
 * The wind-down case: a complete, verified-shape turn stream, then a process
 * that will not exit. This is what pi does in the field — the stream ends on
 * `agent_end`/`agent_settled` and the binary lingers — so the supervisor's
 * wind-down kill is what ends the turn, and the summary must survive it.
 */
export function piHangAfterResultScenario(
  opts: PiSuccessOptions & { hangMs?: number } = {},
): PiScenario {
  const base = piSuccessScenario(opts);
  return { steps: [...base.steps, { kind: 'sleep', ms: opts.hangMs ?? 120_000 }] };
}

/** The crash case: some stderr, then a non-zero exit with no stream. */
export function piCrashScenario(opts: { stderr?: string; exitCode?: number } = {}): PiScenario {
  return {
    steps: [
      { kind: 'stderr', text: opts.stderr ?? 'Error: something went wrong\n' },
      { kind: 'exit', code: opts.exitCode ?? 1 },
    ],
  };
}

/**
 * The model-error case: a full, verified-shape turn whose FINAL assistant
 * message is an error (`stopReason: 'error'` + `errorMessage`, binary still
 * exits 0 — pi's real behavior, so lazy classifies from the stream). The
 * message must classify as the intended failure class, e.g.
 * "No API key found for ollama." → fatal_auth.
 */
export function piErrorScenario(opts: { errorMessage: string; sessionId?: string }): PiScenario {
  return {
    steps: [{ kind: 'respond', result: '', errorMessage: opts.errorMessage, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }],
  };
}

// ---------------------------------------------------------------------------
// Installation / state
// ---------------------------------------------------------------------------

/**
 * An installed fake `pi` binary and its state directory. The binary NAME is
 * `PiPackaging.binaryName()` — what the availability probe and spawn use.
 */
export type FakePi = FakeAgentBinary;

/** Write the fake `pi` executable and its state directory. */
export async function installFakePi(dir: string): Promise<FakePi> {
  return await installFakeAgent(dir, 'pi', composeFakeAgentSource(FAKE_PI_PRELUDE));
}

export async function setPiScenario(fake: FakePi, scenario: PiScenarioFile): Promise<void> {
  await setAgentScenario(fake, scenario);
}

export async function recordPiEnvKeys(fake: FakePi, keys: string[]): Promise<void> {
  await recordAgentEnvKeys(fake, keys);
}

export async function readPiInvocations(fake: FakePi): Promise<PiInvocation[]> {
  return await readAgentInvocations(fake);
}

export async function clearPiInvocations(fake: FakePi): Promise<void> {
  await clearAgentInvocations(fake);
}

/**
 * The pi-specific half of the fake binary. See `composeFakeAgentSource` for
 * the contract (`FAKE_LABEL`, `DEFAULT_SCENARIO`, `agentProbe`, `runAgentStep`).
 */
const FAKE_PI_PRELUDE = String.raw`
const FAKE_LABEL = 'fake pi';

// Probe invocations, answered without consuming a scenario entry:
//   --version  HostProcessRunner.checkAvailability() and PiPackaging.diagnose().
function agentProbe(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write('0.84.4-fake\n');
    return true;
  }
  return false;
}

const DEFAULT_SCENARIO = {
  steps: [
    { kind: 'respond', result: 'Fake pi agent default response.' },
  ],
};

// Emit one turn in the VERIFIED shape of pi 0.84.4's --mode json stream (see
// test/fixtures/pi/*.jsonl): session header first, lifecycle events, the
// final assistant message on message_end/agent_end. PiActivityStream parses
// exactly this in production, so the fake must not invent a different shape.
function writeTurnStream(step) {
  // pi's exact-id contract: --session-id <id> creates-or-resumes that id.
  const idFlag = argv.indexOf('--session-id');
  const sessionId =
    (idFlag !== -1 && argv[idFlag + 1]) || step.sessionId || 'fake-pi-session-0001';
  const usage = {
    input: step.inputTokens === undefined ? 100 : step.inputTokens,
    output: step.outputTokens === undefined ? 200 : step.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 300,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: step.result }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: step.model || 'claude-sonnet-4-5',
    usage,
    // The errored-turn shape pi 0.84.4 emits (camelCase, verified against a
    // scripted Anthropic-wire server): the final assistant carries
    // stopReason 'error' plus an errorMessage, and the binary still exits 0 —
    // which is why lazy classifies the failure from the STREAM, not the exit
    // code. responseFromResultLine throws on exactly this shape.
    ...(step.errorMessage
      ? { stopReason: 'error', errorMessage: step.errorMessage, rawStopReason: 'error' }
      : { stopReason: 'stop' }),
    timestamp: Date.now(),
  };
  const user = { role: 'user', content: [{ type: 'text', text: 'prompt' }], timestamp: Date.now() };
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: user },
    { type: 'message_end', message: user },
    { type: 'message_start', message: { ...assistant, content: [], stopReason: 'pending' } },
    { type: 'message_end', message: assistant },
    { type: 'turn_end', message: assistant, toolResults: [] },
    { type: 'agent_end', messages: [user, assistant] },
    { type: 'agent_settled' },
  ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\n');
}

async function runAgentStep(step) {
  switch (step.kind) {
    case 'respond':
      writeTurnStream(step);
      return true;
    default:
      return false;
  }
}
`;
