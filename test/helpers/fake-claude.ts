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

import { chmod, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';

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
  /** Write files in the cwd and `git commit` them — the agent "doing work". */
  | { kind: 'commit'; message: string; files: Array<{ path: string; content: string }> }
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
  | { kind: 'exit'; code: number };

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

/** Record of one fake-agent invocation, as written to invocations.jsonl. */
export interface ClaudeInvocation {
  argv: string[];
  cwd: string;
  /** Epoch ms when the invocation started. */
  at: number;
  /**
   * The auth-shaped environment the agent was actually launched with — the
   * credential slots plus the base URL. Recorded so a test can assert what the
   * agent process holds, and in particular what it does NOT hold: under JIT
   * credential injection these carry a placeholder, never a real credential.
   *
   * Only these keys, and only in the fake: every value here is a test fixture.
   */
  env: Record<string, string>;
}

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

const SCENARIO_FILE = 'scenario.json';
const INVOCATIONS_FILE = 'invocations.jsonl';

export interface FakeClaude {
  /** State directory: holds scenario.json and invocations.jsonl. */
  dir: string;
  /** Directory to prepend to PATH — contains the `claude` executable. */
  binDir: string;
}

/**
 * Write the fake `claude` executable and its state directory.
 *
 * The shebang is the ABSOLUTE path of the bun that is running the tests, not
 * `/usr/bin/env bun`: the binary is invoked from subprocesses whose PATH we
 * control, and pinning the interpreter keeps the fake agent working even if a
 * test narrows PATH further.
 */
export async function installFakeClaude(dir: string): Promise<FakeClaude> {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const script = `#!${process.execPath}\n${FAKE_CLAUDE_SOURCE}`;
  const binPath = join(binDir, 'claude');
  await writeFile(binPath, script);
  await chmod(binPath, 0o755);

  return { dir, binDir };
}

/** Install (or replace) the scenario the fake agent will replay next. */
export async function setClaudeScenario(fake: FakeClaude, scenario: ClaudeScenarioFile): Promise<void> {
  await writeFile(join(fake.dir, SCENARIO_FILE), JSON.stringify(scenario, null, 2));
}

/** Every invocation of the fake agent so far, oldest first. */
export async function readClaudeInvocations(fake: FakeClaude): Promise<ClaudeInvocation[]> {
  let raw: string;
  try {
    raw = await readFile(join(fake.dir, INVOCATIONS_FILE), 'utf-8');
  } catch (err) {
    // No invocations yet is a normal state (the agent has not been launched).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read fake-claude invocations: ${(err as Error).message}`);
  }
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as ClaudeInvocation);
}

/** Forget every recorded invocation (useful between turns in one test). */
export async function clearClaudeInvocations(fake: FakeClaude): Promise<void> {
  await rm(join(fake.dir, INVOCATIONS_FILE), { force: true });
}

/**
 * Source of the fake binary.
 *
 * Kept as a string rather than a separate .ts file that gets copied because the
 * binary must be standalone: it runs outside the test process, outside the
 * repo's module graph, and (in principle) from a temp dir with no node_modules.
 * It therefore uses only `node:` builtins.
 */
const FAKE_CLAUDE_SOURCE = String.raw`
// Fake "claude" CLI. Generated by test/helpers/fake-claude.ts — see that file
// for the scripting model. Uses only node: builtins so it can run standalone.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stateDir = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

// --version is asked by runner.checkAvailability() and by which-style probes
// long before any turn exists. Answer without touching the scenario so a probe
// never consumes a sequence entry.
if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude Code for lazy e2e)\n');
  process.exit(0);
}

const invocationsPath = path.join(stateDir, 'invocations.jsonl');
let invocationIndex = 0;
try {
  const existing = fs.readFileSync(invocationsPath, 'utf-8');
  invocationIndex = existing.split('\n').filter(l => l.trim()).length;
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  invocationIndex = 0;
}
// Record the auth-shaped env the agent was launched with. Tests assert on the
// ABSENCE of a real credential here \u2014 see public-docs/proxy-jit-credentials.md.
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CURSOR_API_KEY', 'ANTHROPIC_BASE_URL',
];
const authEnv = {};
for (const key of AUTH_ENV_KEYS) {
  if (process.env[key] !== undefined) authEnv[key] = process.env[key];
}
fs.appendFileSync(
  invocationsPath,
  JSON.stringify({ argv, cwd: process.cwd(), at: Date.now(), env: authEnv }) + '\n',
);

function loadScenario() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(stateDir, 'scenario.json'), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // No scenario configured: behave like a trivially successful agent so a
    // test that never scripts one still gets a well-formed turn.
    return {
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
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.sequence)) {
    if (parsed.sequence.length === 0) throw new Error('fake claude: empty scenario sequence');
    const idx = Math.min(invocationIndex, parsed.sequence.length - 1);
    return parsed.sequence[idx];
  }
  return parsed;
}

const scenario = loadScenario();

if (scenario.ignoreSigterm) {
  // Exercise the watchdog's SIGTERM -> SIGKILL escalation: refuse the polite
  // signal so only SIGKILL can end this process.
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCommit(step) {
  for (const file of step.files) {
    const full = path.join(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  const add = spawnSync('git', ['add', '-A'], { cwd: process.cwd() });
  if (add.status !== 0) {
    throw new Error('fake claude: git add failed: ' + (add.stderr || '').toString());
  }
  const commit = spawnSync('git', ['commit', '-m', step.message], { cwd: process.cwd() });
  if (commit.status !== 0) {
    throw new Error('fake claude: git commit failed: ' + (commit.stderr || '').toString());
  }
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

async function main() {
  for (const step of scenario.steps || []) {
    switch (step.kind) {
      case 'session-jsonl':
        writeSessionJsonl(step);
        break;
      case 'emit':
        process.stdout.write(JSON.stringify(step.event) + '\n');
        break;
      case 'stdout':
        process.stdout.write(step.text);
        break;
      case 'stderr':
        process.stderr.write(step.text);
        break;
      case 'sleep':
        await sleep(step.ms);
        break;
      case 'commit':
        runCommit(step);
        break;
      case 'exit':
        process.exit(step.code);
        break;
      default:
        throw new Error('fake claude: unknown step kind ' + step.kind);
    }
  }
  process.exit(scenario.exitCode ?? 0);
}

main().catch(err => {
  process.stderr.write('fake claude failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(70);
});
`;
