/**
 * Fake `codex` binary — the low-level e2e seam for Codex turns.
 *
 * Same arrangement as `test/helpers/fake-cursor.ts` (see its header for the
 * seam's rationale): nothing in `src/` is mocked — the daemon really launches
 * `lazy supervise`, which really spawns this binary — and the agent-agnostic
 * machinery is shared via `test/helpers/fake-agent-core.ts`.
 *
 * WHAT THIS FAKE'S OUTPUT IS MODELLED ON
 * --------------------------------------
 * Unlike Cursor's (whose real output shape is unverified), the codex JSONL
 * event stream WAS captured from the real binary (codex-cli 0.152.1, driven by
 * a fake OpenAI Responses server — see the add-codex-agent task journal) and
 * cross-checked against codex-rs `exec/src/exec_events.rs`. The `respond` step
 * therefore emits the real shapes verbatim:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
 *     "cache_write_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}
 *
 * If the pinned codex release ever changes these shapes, re-capture and update
 * BOTH this fake and `src/agent/codex.ts` together.
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

/** One scripted action of the fake codex agent. */
export type CodexStep =
  /**
   * Emit the verified success-path JSONL event stream for one turn: a
   * thread.started carrying `sessionId` as the thread id, an agent_message
   * item with `result`, and a turn.completed with usage.
   */
  | { kind: 'respond'; result: string; sessionId: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  /** Emit the verified failure path: thread.started, then turn.failed + exit 1. */
  | { kind: 'turnFailed'; sessionId?: string; message: string }
  /** Write raw text on stdout, verbatim (no newline added). */
  | { kind: 'stdout'; text: string }
  /** Write raw text on stderr, verbatim (no newline added). */
  | { kind: 'stderr'; text: string }
  /** Sleep. This is how "silent mid-turn" and "hangs after result" are expressed. */
  | { kind: 'sleep'; ms: number }
  /** Write files in the cwd and `git commit` them — the agent "doing work". */
  | { kind: 'commit'; message: string; files: Array<{ path: string; content: string }> }
  /**
   * Make one API request the way an authenticated codex would: at
   * `$LAZY_CODEX_API_BASE/responses` with `Authorization: Bearer
   * $OPENAI_API_KEY`, the launch's placeholder credential.
   *
   * The env var carries the COMPLETE base_url, path prefix included — the launch
   * computes it, because only the launch knows which upstream this profile routes
   * to (`/v1` for api.openai.com, none for the ChatGPT subscription backend). The
   * real codex appends its own paths to that base, so `path` here is appended
   * too; do NOT write `/v1` into it or the request lands on a path the proxy's
   * allowlist refuses and the failure reads as a proxy fault.
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

export interface CodexScenario {
  steps: CodexStep[];
  /** Exit code once all steps are done (default 0). Ignored if a step exited. */
  exitCode?: number;
  /** Swallow SIGTERM to exercise the watchdog's SIGTERM→SIGKILL escalation. */
  ignoreSigterm?: boolean;
}

/** Single scenario, or a per-invocation sequence (last entry repeats). */
export type CodexScenarioFile = CodexScenario | { sequence: CodexScenario[] };

export type CodexInvocation = FakeAgentInvocation;

// ---------------------------------------------------------------------------
// Scenario builders for the common shapes
// ---------------------------------------------------------------------------

export interface CodexSuccessOptions {
  result?: string;
  sessionId?: string;
  /** Files to write + commit before responding (the "work"). */
  commit?: { message: string; files: Array<{ path: string; content: string }> };
}

/** (optional commit) → the verified success event stream → exit 0. */
export function codexSuccessScenario(opts: CodexSuccessOptions = {}): CodexScenario {
  const sessionId = opts.sessionId ?? '01a00000-0000-7000-8000-000000000001';
  const steps: CodexStep[] = [];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Fake codex agent completed the task.',
    sessionId,
  });
  return { steps };
}

/**
 * One proxied API request, then a normal response.
 *
 * The path carries NO `/v1`: `LAZY_CODEX_API_BASE` is the complete base_url and
 * codex appends to it, so a `/v1` here would produce `<base>/v1/responses` —
 * which the real codex never sends, and which the proxy's allowlist refuses on a
 * subscription route, so the failure would read as a proxy fault rather than a
 * bad test double. Asserted in test/unit/codex-agent.test.ts.
 */
export function codexProxiedCallScenario(opts: {
  sessionId?: string;
  result?: string;
  recordFile?: string;
  commit?: { message: string; files: Array<{ path: string; content: string }> };
} = {}): CodexScenario {
  const sessionId = opts.sessionId ?? '01a00000-0000-7000-8000-00000000cafe';
  const steps: CodexStep[] = [
    {
      kind: 'http',
      path: '/responses',
      expectStatus: 200,
      ...(opts.recordFile ? { recordFile: opts.recordFile } : {}),
    },
  ];
  if (opts.commit) {
    steps.push({ kind: 'commit', message: opts.commit.message, files: opts.commit.files });
  }
  steps.push({
    kind: 'respond',
    result: opts.result ?? 'Exercised the codex proxy route.',
    sessionId,
  });
  return { steps };
}

/** The crash case: some stderr, then a non-zero exit with no event stream. */
export function codexCrashScenario(opts: { stderr?: string; exitCode?: number } = {}): CodexScenario {
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
 * An installed fake `codex` binary and its state directory. The NAME matters:
 * `CodexPackaging.binaryName()` is `codex`, and that is what both the
 * availability probe and the spawn use.
 */
export type FakeCodex = FakeAgentBinary;

/** Write the fake `codex` executable and its state directory. */
export async function installFakeCodex(dir: string): Promise<FakeCodex> {
  return await installFakeAgent(dir, 'codex', composeFakeAgentSource(FAKE_CODEX_PRELUDE));
}

/** Install (or replace) the scenario the fake agent will replay next. */
export async function setCodexScenario(fake: FakeCodex, scenario: CodexScenarioFile): Promise<void> {
  await setAgentScenario(fake, scenario);
}

/** Ask the fake agent to echo these env keys back on every future invocation. */
export async function recordCodexEnvKeys(fake: FakeCodex, keys: string[]): Promise<void> {
  await recordAgentEnvKeys(fake, keys);
}

/** Every invocation of the fake agent so far, oldest first. */
export async function readCodexInvocations(fake: FakeCodex): Promise<CodexInvocation[]> {
  return await readAgentInvocations(fake);
}

/** Forget every recorded invocation (useful between turns in one test). */
export async function clearCodexInvocations(fake: FakeCodex): Promise<void> {
  await clearAgentInvocations(fake);
}

/**
 * The codex-specific half of the fake binary. See fake-cursor.ts for how
 * `composeFakeAgentSource` sandwiches it.
 */
const FAKE_CODEX_PRELUDE = String.raw`
const FAKE_LABEL = 'fake codex';

// Probe invocations, answered without touching the scenario so they never
// consume a sequence entry:
//   --version      HostProcessRunner.checkAvailability() and CodexPackaging
//                  .diagnose() both run it before any turn exists.
//   login status   CodexPackaging.diagnose() and the system-agent view read it
//                  for auth state. "Not logged in" + exit 1 is the real CLI's
//                  un-authenticated answer (verified, 0.152.1) — informational
//                  there, since a launch supplies OPENAI_API_KEY.
function agentProbe(argv) {
  if (argv.includes('--version')) {
    process.stdout.write('codex-cli 0.152.1-fake\n');
    return true;
  }
  if (argv[0] === 'login' && argv[1] === 'status') {
    process.stdout.write('Not logged in\n');
    process.exit(1);
  }
  return false;
}

// Used when no scenario file exists: a well-formed event stream, so a test
// that never scripts one still gets a parseable turn.
const DEFAULT_SCENARIO = {
  steps: [
    { kind: 'respond', result: 'Fake codex agent default response.', sessionId: '01a00000-0000-7000-8000-0000000000aa' },
  ],
};

// The verified JSONL event stream of codex exec --json — shapes captured from
// the real binary; see this file's header.
function writeResponse(step) {
  const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  line({ type: 'thread.started', thread_id: step.sessionId });
  line({ type: 'turn.started' });
  line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: step.result } });
  line({
    type: 'turn.completed',
    usage: {
      input_tokens: step.inputTokens === undefined ? 100 : step.inputTokens,
      cached_input_tokens: step.cachedInputTokens === undefined ? 0 : step.cachedInputTokens,
      cache_write_input_tokens: 0,
      output_tokens: step.outputTokens === undefined ? 200 : step.outputTokens,
      reasoning_output_tokens: 0,
    },
  });
}

// The verified failure path: turn.failed on stdout, then exit 1.
function writeTurnFailed(step) {
  const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  line({ type: 'thread.started', thread_id: step.sessionId || '01a00000-0000-7000-8000-00000000dead' });
  line({ type: 'turn.started' });
  line({ type: 'error', message: step.message });
  line({ type: 'turn.failed', error: { message: step.message } });
  process.exit(1);
}

// One API call as an authenticated codex would make it: the step's path appended
// to LAZY_CODEX_API_BASE, with the launch's OPENAI_API_KEY placeholder as the
// bearer. That env var is the COMPLETE base_url — the real codex appends its own
// paths to exactly the same value, which it reads from the config.toml lazy
// writes out of it — so the default path carries no /v1 of its own.
// (No backticks in this half of the file: it lives inside a String.raw template.)
async function runHttp(step) {
  const endpoint = process.env.LAZY_CODEX_API_BASE;
  if (!endpoint) throw new Error(FAKE_LABEL + ': LAZY_CODEX_API_BASE is unset');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error(FAKE_LABEL + ': OPENAI_API_KEY is unset for http step');
  const pathPart = step.path || '/responses';
  const method = step.method || 'POST';
  const body = step.body !== undefined
    ? JSON.stringify(step.body)
    : JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true, store: false });
  const url = endpoint.replace(/\/$/, '') + pathPart;
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + apiKey,
    },
    body,
  });
  const record = { status: res.status, ok: res.ok };
  if (step.recordFile) {
    fs.writeFileSync(path.join(stateDir, step.recordFile), JSON.stringify(record));
  }
  if (step.expectStatus !== undefined && res.status !== step.expectStatus) {
    throw new Error(FAKE_LABEL + ': http expected status ' + step.expectStatus + ' got ' + res.status);
  }
  await res.text().catch(() => '');
}

// The step kinds only codex understands. Returning false hands an unknown kind
// back to the shared runtime, which fails loudly.
async function runAgentStep(step) {
  switch (step.kind) {
    case 'respond':
      writeResponse(step);
      return true;
    case 'turnFailed':
      writeTurnFailed(step);
      return true;
    case 'http':
      await runHttp(step);
      return true;
    default:
      return false;
  }
}
`;
