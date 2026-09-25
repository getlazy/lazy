/**
 * Shared machinery for the fake-AGENT-BINARY seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/helpers/fake-claude.ts` proved the seam: install a scriptable fake agent
 * executable on PATH, switch the project to the host-process runner, and the
 * whole real stack (daemon → runner → `lazy supervise` → `execWithWatchdog` →
 * spawn) runs unmocked with only the agent binary faked. Lazy now ships a second
 * agent (cursor), whose argv/env contract and proxy route had no coverage at
 * that depth at all.
 *
 * Everything in this file is the part of that seam that is genuinely agent-
 * AGNOSTIC: where the state directory lives, how invocations and env are
 * recorded, how a scenario file (single or `{sequence:[…]}`) is resolved per
 * invocation, and the generic steps (`stdout`/`stderr`/`sleep`/`commit`/`exit`).
 * Each agent supplies a small prelude with the parts that are genuinely its own:
 * how it answers probe invocations, what a default turn looks like, and the step
 * kinds only it understands (claude's stream-json `emit`, cursor's single-object
 * `respond`).
 *
 * NOT A PUBLIC TEST API. Suites use `test/helpers/fake-claude.ts` or
 * `test/helpers/fake-cursor.ts`; this file exists so those two do not each carry
 * their own copy of the runtime.
 */

import { chmod, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';

/** Names of the files inside a fake agent's state directory. */
export const SCENARIO_FILE = 'scenario.json';
export const INVOCATIONS_FILE = 'invocations.jsonl';
export const RECORD_ENV_FILE = 'record-env.json';

/** An installed fake agent binary and the state directory it reads/writes. */
export interface FakeAgentBinary {
  /** State directory: holds scenario.json and invocations.jsonl. */
  dir: string;
  /** Directory to prepend to PATH — contains the fake executable. */
  binDir: string;
  /** The executable's name, e.g. `claude` or `cursor-agent`. */
  binaryName: string;
}

/** Record of one fake-agent invocation, as written to invocations.jsonl. */
export interface FakeAgentInvocation {
  argv: string[];
  cwd: string;
  /** Epoch ms when the invocation started. */
  at: number;
  /**
   * The fake agent's OWN pid, recorded from inside it.
   *
   * The only way a test can name the agent process. Asserting that stopping a
   * run really stopped the agent needs the process, not the turn: "the turn was
   * interrupted" is a statement about lazy's records, and the bug it has to
   * catch is an agent that keeps running after them.
   *
   * Comparable with host pids only on the host-process seam this fake normally
   * runs under. If a suite ever runs the fake inside a container, this is that
   * container's pid namespace and means nothing outside it.
   */
  pid: number;
  /**
   * The environment the agent was actually launched with, as far as the fake
   * records it: the auth-shaped keys (credential slots plus endpoint overrides)
   * always, plus any key a test asked for via `recordAgentEnvKeys`. `null` means
   * a requested key was not set; an auth key that was not set is simply absent.
   *
   * Recorded so a test can assert what the agent process holds, and in
   * particular what it does NOT hold: under JIT credential injection the auth
   * slots carry a placeholder, never a real credential.
   *
   * Only these keys, and only in the fake: every value here is a test fixture.
   */
  env: Record<string, string | null>;
}

/**
 * Write a fake agent executable and its state directory.
 *
 * The shebang is the ABSOLUTE path of the bun that is running the tests, not
 * `/usr/bin/env bun`: the binary is invoked from subprocesses whose PATH we
 * control, and pinning the interpreter keeps the fake agent working even if a
 * test narrows PATH further.
 */
export async function installFakeAgent(
  dir: string,
  binaryName: string,
  source: string,
): Promise<FakeAgentBinary> {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const binPath = join(binDir, binaryName);
  await writeFile(binPath, `#!${process.execPath}\n${source}`);
  await chmod(binPath, 0o755);

  return { dir, binDir, binaryName };
}

/** Install (or replace) the scenario the fake agent will replay next. */
export async function setAgentScenario(fake: FakeAgentBinary, scenario: unknown): Promise<void> {
  await writeFile(join(fake.dir, SCENARIO_FILE), JSON.stringify(scenario, null, 2));
}

/**
 * Ask the fake agent to echo these env keys back on every future invocation.
 *
 * The proof a test needs for per-task env is "the agent's own process had this
 * variable" — nothing weaker (an argv containing `-e KEY=VALUE` only proves lazy
 * meant to). Values land in `FakeAgentInvocation.env`.
 */
export async function recordAgentEnvKeys(fake: FakeAgentBinary, keys: string[]): Promise<void> {
  await writeFile(join(fake.dir, RECORD_ENV_FILE), JSON.stringify(keys));
}

/** Every invocation of the fake agent so far, oldest first. */
export async function readAgentInvocations(fake: FakeAgentBinary): Promise<FakeAgentInvocation[]> {
  let raw: string;
  try {
    raw = await readFile(join(fake.dir, INVOCATIONS_FILE), 'utf-8');
  } catch (err) {
    // No invocations yet is a normal state (the agent has not been launched).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read fake-${fake.binaryName} invocations: ${(err as Error).message}`);
  }
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as FakeAgentInvocation);
}

/** Forget every recorded invocation (useful between turns in one test). */
export async function clearAgentInvocations(fake: FakeAgentBinary): Promise<void> {
  await rm(join(fake.dir, INVOCATIONS_FILE), { force: true });
}

/**
 * Compose a standalone fake-agent script from an agent-specific prelude.
 *
 * The three fragments are concatenated in a fixed order, and that order is
 * load-bearing:
 *   1. `PREAMBLE`   — `fs`/`path`/`spawnSync`, `stateDir`, `argv`, `sleep`.
 *   2. the prelude  — must define `FAKE_LABEL`, `DEFAULT_SCENARIO`,
 *                     `function agentProbe(argv)` and `async function
 *                     runAgentStep(step)`. It may use anything from PREAMBLE.
 *   3. `RUNTIME`    — the probe short-circuit, invocation recording, scenario
 *                     resolution and the step loop, all of which read the
 *                     prelude's declarations.
 *
 * The result uses only `node:` builtins: it runs outside the test process,
 * outside the repo's module graph, and in principle from a temp dir with no
 * node_modules.
 */
export function composeFakeAgentSource(prelude: string): string {
  return `${PREAMBLE}\n${prelude}\n${RUNTIME}`;
}

/**
 * Requires and the handful of values every fragment below needs.
 *
 * `stateDir` is the parent of the `bin/` directory the executable lives in —
 * see `installFakeAgent`.
 */
const PREAMBLE = String.raw`
// Fake agent CLI. Generated by test/helpers/fake-agent-core.ts from an
// agent-specific prelude — see that file for the scripting model. Uses only
// node: builtins so it can run standalone.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stateDir = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`;

/**
 * The agent-agnostic runtime.
 *
 * Every behavior here was previously inlined in fake-claude.ts; the comments
 * explaining WHY each piece is shaped the way it is moved with it.
 */
const RUNTIME = String.raw`
// Probe invocations (--version and friends) are made by
// runner.checkAvailability() and by which-style checks long before any turn
// exists. They are answered without touching the scenario so a probe never
// consumes a sequence entry — and without being recorded, so a test counting
// invocations counts turns.
if (agentProbe(argv)) process.exit(0);

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
// ABSENCE of a real credential here — see public-docs/proxy-jit-credentials.md.
// CURSOR_API_ENDPOINT is in the list for the same reason the credential slots
// are: it carries the launch's placeholder in its path, so it is the evidence
// that a cursor turn was pointed at lazy's proxy rather than Cursor's servers.
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CURSOR_API_KEY', 'CURSOR_API_ENDPOINT', 'ANTHROPIC_BASE_URL',
  // Codex: the placeholder credential slot, and the proxy route base the
  // supervisor writes into ~/.codex/config.toml — the evidence a codex turn
  // was pointed at lazy's proxy rather than api.openai.com.
  'OPENAI_API_KEY', 'LAZY_CODEX_API_BASE',
];
const recordedEnv = {};
for (const key of AUTH_ENV_KEYS) {
  if (process.env[key] !== undefined) recordedEnv[key] = process.env[key];
}
// Additional variables a test asked for, echoed back so it can prove what the
// agent's own process environment actually contained. The key list comes from
// a file (not from the fake's env) so it works for both runners: with docker
// the container env is built from scratch, and anything the test set on the
// harness process would not be there to read.
try {
  const keys = JSON.parse(fs.readFileSync(path.join(stateDir, 'record-env.json'), 'utf-8'));
  for (const key of keys) {
    recordedEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

fs.appendFileSync(
  invocationsPath,
  JSON.stringify({ argv, cwd: process.cwd(), at: Date.now(), pid: process.pid, env: recordedEnv }) + '\n',
);

function loadScenario() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(stateDir, 'scenario.json'), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // No scenario configured: behave like a trivially successful agent so a
    // test that never scripts one still gets a well-formed turn.
    return DEFAULT_SCENARIO;
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.sequence)) {
    if (parsed.sequence.length === 0) throw new Error(FAKE_LABEL + ': empty scenario sequence');
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

function runCommit(step) {
  for (const file of step.files) {
    const full = path.join(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  const add = spawnSync('git', ['add', '-A'], { cwd: process.cwd() });
  if (add.status !== 0) {
    throw new Error(FAKE_LABEL + ': git add failed: ' + (add.stderr || '').toString());
  }
  const commit = spawnSync('git', ['commit', '-m', step.message], { cwd: process.cwd() });
  if (commit.status !== 0) {
    throw new Error(FAKE_LABEL + ': git commit failed: ' + (commit.stderr || '').toString());
  }
}

async function main() {
  for (const step of scenario.steps || []) {
    switch (step.kind) {
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
      case 'declare-presentation': {
        // Simulate the DAEMON side of agent lazy_report MCP call: the
        // daemon executes that call and drops the presentation marker into the
        // task's protocol dir (src/protocol/presentation-marker.ts). A fake
        // agent cannot call MCP, so the marker write is the seam's stand-in —
        // the real supervisor then reads the same file it would read from a
        // real agent's declaration. The protocol dir is derived from env the
        // agent process genuinely carries in production: LAZY_PROTOCOL_BASE
        // (or the ~/.lazy default) and LAZY_MCP_EXPECTED_TASK_ID, which the
        // supervisor sets in its own process env before every turn
        // (src/supervisor/mcp-setup.ts) and hands down through execWithWatchdog.
        // The marker shape MUST stay in lockstep with PresentationMarkerFile:
        // a read that does not understand the shape degrades to "not declared".
        const base = process.env.LAZY_PROTOCOL_BASE
          || path.join(require('node:os').homedir(), '.lazy', 'protocol');
        const taskId = process.env.LAZY_MCP_EXPECTED_TASK_ID;
        if (!taskId) {
          throw new Error(FAKE_LABEL + ': declare-presentation needs LAZY_MCP_EXPECTED_TASK_ID in the agent env');
        }
        const protoDir = path.join(base, taskId);
        fs.mkdirSync(protoDir, { recursive: true });
        const marker = { version: 1, declared_at: new Date().toISOString() };
        const target = path.join(protoDir, 'presentation.json');
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
        fs.renameSync(tmp, target);
        break;
      }
      case 'exit':
        process.exit(step.code);
        break;
      default:
        // Agent-specific kinds. runAgentStep returns false for anything it does
        // not know, so an unknown kind still fails loudly rather than silently
        // producing a turn the test did not script.
        if (!(await runAgentStep(step))) {
          throw new Error(FAKE_LABEL + ': unknown step kind ' + step.kind);
        }
    }
  }
  process.exit(scenario.exitCode ?? 0);
}

main().catch(err => {
  process.stderr.write(FAKE_LABEL + ' failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(70);
});
`;
