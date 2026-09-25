/**
 * The demo's stand-in `claude` binary, and the script each seeded task runs.
 *
 * WHY THIS IS NOT `test/helpers/fake-claude.ts`. That fake is the e2e seam and
 * is excellent at what it does, but it lives under `test/` and is reached by
 * `--preload`-era helpers; importing it from `src/` would bundle test helpers
 * into the shipped binary. It also answers a different question. A test scripts
 * ONE scenario at a time and rewrites the file between turns, because a test
 * drives turns one at a time. The demo has several tasks alive at once — one
 * holding a turn open while another is being unblocked — so its agent must pick
 * its behaviour per invocation from WHICH TASK it was launched for.
 *
 * That is the whole difference, and it is why the script below keys its
 * scenario off the task worktree it is running in rather than replaying a
 * sequence.
 *
 * WHAT MUST NOT DRIFT. The stream-json objects written here are parsed by the
 * real {@link ClaudeCodeActivityStream} (`src/agent/activity-stream.ts`): if a
 * shape drifts, the watchdog stops seeing progress and demo turns hang instead
 * of failing. `test/unit/demo-agent-events.test.ts` feeds every event this
 * module emits to that real parser, because the failure that reaches a user is
 * not two fakes disagreeing with each other but one of them disagreeing with
 * the parser.
 */

import { chmod, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

/** A file the demo agent writes and commits as its "work". */
export interface DemoFile {
  path: string;
  content: string;
}

/** One scripted demo turn. */
export interface DemoTurn {
  /** Summary text the turn records — what a reviewer reads first. */
  result: string;
  /** Files to write and commit before reporting. Omit for a no-commit turn. */
  commit?: { message: string; files: DemoFile[] };
  /**
   * Hold the turn open for this long after reporting nothing.
   *
   * This is how the `working` state is seeded: a task whose agent is genuinely
   * mid-turn, with a live supervisor and a real container-less runner process,
   * not a status field written to look like one.
   */
  holdMs?: number;
}

/**
 * The demo agent's script: task code → the turns that task's agent will run,
 * in order. A task invoked more times than it has turns repeats the last one,
 * so an unblock always produces a well-formed turn.
 */
export type DemoScript = Record<string, DemoTurn[]>;

/** Where the script lives inside the agent state dir. */
export const SCRIPT_FILE = 'script.json';

/**
 * Install the demo agent binary and its state directory.
 *
 * The shebang pins the absolute interpreter rather than `/usr/bin/env bun`: the
 * binary is exec'd from a supervisor whose PATH the demo controls, and a pinned
 * interpreter keeps working if that PATH is narrowed further.
 */
export async function installDemoAgent(
  agentDir: string,
  opts: { pacingMs?: number } = {},
): Promise<{ binDir: string; binPath: string }> {
  const binDir = join(agentDir, 'bin');
  await mkdir(binDir, { recursive: true });

  // A file beside the script, not an env var: the agent is exec'd by a
  // supervisor several processes away, and Teams' demo daemons do not share
  // this process's environment. Read on every turn.
  await writeFile(join(agentDir, PACING_FILE), `${JSON.stringify({ ms: opts.pacingMs ?? 0 })}\n`);

  const binPath = join(binDir, 'claude');
  await writeFile(binPath, `#!${process.execPath}\n${DEMO_AGENT_SOURCE}`);
  await chmod(binPath, 0o755);

  return { binDir, binPath };
}

/** Where the per-turn pacing lives inside the agent state dir. */
export const PACING_FILE = 'pacing.json';

/** Overrides the playground agent's pacing; milliseconds, `0` turns it off. */
export const DEMO_PACING_ENV = 'LAZY_PLAYGROUND_AGENT_PACING_MS';

/**
 * How long each playground turn takes before it reports, by default.
 *
 * A turn that finishes the instant it starts shows a person nothing: the task
 * flips straight from created to blocked and "working" is never on screen. A
 * few seconds is long enough to watch, short enough not to drag.
 */
export const DEFAULT_DEMO_PACING_MS = 3000;

/**
 * The pacing a playground should install: {@link DEMO_PACING_ENV} when set,
 * {@link DEFAULT_DEMO_PACING_MS} otherwise. A value that is not a whole,
 * non-negative number of milliseconds is refused rather than guessed at.
 */
export function resolveDemoPacingMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEMO_PACING_ENV]?.trim();
  if (!raw) return DEFAULT_DEMO_PACING_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${DEMO_PACING_ENV} must be a whole number of milliseconds (0 to turn pacing off), got "${raw}"`);
  }
  return Number(raw);
}

/** Write (or replace) the script the demo agent replays. */
export async function writeDemoScript(agentDir: string, script: DemoScript): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, SCRIPT_FILE), `${JSON.stringify(script, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The stream-json objects, built here so the unit test can assert on the SAME
// values the agent writes rather than on a copy of them.
// ---------------------------------------------------------------------------

/** `{"type":"system","subtype":"init",…}` → `session_start`. */
export function demoSessionStartEvent(sessionId: string): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

/** An assistant message carrying a `tool_use` block → `tool_start`. */
export function demoToolUseEvent(toolUseId: string, toolName = 'Edit'): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: toolName }] } };
}

/** A user message carrying a `tool_result` block → `tool_end`. */
export function demoToolResultEvent(toolUseId: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] } };
}

/**
 * A `tool_progress` keep-alive for a tool call in flight → `heartbeat`. What
 * the agent emits every second while a paced turn is "reading".
 */
export function demoHeartbeatEvent(toolUseId: string, toolName = 'Read'): Record<string, unknown> {
  return { type: 'tool_progress', parent_tool_use_id: toolUseId, tool_name: toolName };
}

/** An assistant text message → plain `progress`. Narrates a paced turn. */
export function demoProgressTextEvent(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** The final `{"type":"result",…}` line — the turn's summary. */
export function demoResultEvent(result: string, sessionId: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result,
    session_id: sessionId,
    usage: { input_tokens: 1200, output_tokens: 480 },
  };
}

/**
 * Every event kind the demo agent can emit, for the parser-contract test.
 *
 * Exported so `test/unit/demo-agent-events.test.ts` cannot fall out of step
 * with the agent by listing shapes of its own.
 */
export function demoAgentEventSamples(): Record<string, unknown>[] {
  return [
    demoSessionStartEvent('demo-sess-1'),
    demoToolUseEvent('toolu_demo_1'),
    demoToolResultEvent('toolu_demo_1'),
    demoHeartbeatEvent('toolu_demo_pace'),
    demoProgressTextEvent('Still working (1)...'),
    demoResultEvent('Demo turn finished.', 'demo-sess-1'),
  ];
}

/**
 * The agent script, as source.
 *
 * Uses only `node:` builtins: it runs from a temp directory with no
 * node_modules, exec'd by a supervisor that knows nothing about this repo.
 */
const DEMO_AGENT_SOURCE = String.raw`
// Lazy's DEMO agent — generated by src/demo/agent.ts. Not a real agent: it
// replays a script keyed by the task worktree it was launched in, so a demo
// environment can hold several tasks in different states at once.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stateDir = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

// How often a held-open turn completes a step to stay alive. Well inside the
// 30-minute default watchdog window, and far enough apart that a demo left
// running for an hour produces a readable turn rather than a wall of events.
const KEEPALIVE_INTERVAL_MS = 120000;

// --version is asked by the runner's availability check and by which-style
// probes long before any turn exists. Answer it without touching the script, so
// a probe never consumes a turn.
if (argv.includes('--version')) {
  process.stdout.write('0.0.0-demo (lazy playground agent)\n');
  process.exit(0);
}

// WHICH TASK IS THIS? The daemon launches the agent inside the task's worktree,
// whose directory name is the task code (…/.lazy/worktrees/<code>). That is the
// only signal available to a process the daemon tells nothing else about, and
// it is stable: the worktree path is derived from the code by lazy itself.
const taskCode = path.basename(process.cwd());

function loadTurns() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(stateDir, 'script.json'), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
  const script = JSON.parse(raw);
  return script[taskCode] || null;
}

// Count previous invocations FOR THIS TASK so an unblock runs the next scripted
// turn rather than repeating the first. Per-task counters, because several
// tasks share this one binary and a global counter would interleave them.
// ONE COUNTER FILE PER TASK, not one shared file.
//
// This used to be a single "turn-counts.json" holding every task's count, read
// and rewritten whole. The demo is deliberately built to have several agents
// alive at once — "demo-working" holds a turn for 45 minutes while everything
// else runs, and Teams can start tasks concurrently — so two agents starting
// together read the same object and the second write lost the first's update.
// Worse, teardown kills agents mid-flight by design, and a process killed
// during that rewrite left a TRUNCATED file that threw on every later turn
// until the whole root was recreated.
//
// Per-task files remove the shared object entirely: no two agents ever touch
// the same path, so there is nothing to lose. The write is still atomic
// (temp + rename, the same shape "writeManifest" uses), because a kill during
// this task's own write would otherwise corrupt this task's own counter.
const countsDir = path.join(stateDir, 'turn-counts');
function nextTurnIndex() {
  const countPath = path.join(countsDir, taskCode + '.json');

  // An unreadable counter reads as zero rather than throwing. The count is
  // bookkeeping for which scripted turn to replay — losing it degrades a demo
  // to replaying the first turn, which is survivable. Throwing fails the turn
  // outright, which is not.
  let index = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(countPath, 'utf-8'));
    if (typeof parsed.turns === 'number' && parsed.turns >= 0) index = parsed.turns;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('demo agent: ignoring unreadable turn counter ' + countPath + '\n');
    }
  }

  fs.mkdirSync(countsDir, { recursive: true });
  const temp = countPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ turns: index + 1 }));
  fs.renameSync(temp, countPath);
  return index;
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// Write a turn note. Its content carries the turn index, so it DIFFERS on every
// turn — which is what makes a replayed turn a real change rather than a no-op.
function writeTurnNote(turnIndex, why) {
  const notePath = 'notes/' + taskCode + '.md';
  const full = path.join(process.cwd(), notePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full,
    '## Turn ' + (turnIndex + 1) + '\n\n' + why + '\n' +
    'Written by the demo stand-in agent. No real agent ran and no model was called.\n\n');
  return notePath;
}

// Is there anything staged or unstaged for git to commit?
function worktreeIsClean() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: process.cwd() });
  if (status.status !== 0) {
    throw new Error('demo agent: git status failed: ' + (status.stderr || '').toString());
  }
  return status.stdout.toString().trim().length === 0;
}

// Commit the turn's work, GUARANTEEING there is some.
//
// A scripted turn writes fixed content, so replaying it — which is exactly what
// a second "lazy unblock" does — produces byte-identical files, nothing to
// stage, and a "git commit" that exits non-zero on an empty change. That made
// the one action the demo exists to let people exercise fail on repeat:
// "demo-conflict" and "demo-protected" failed on the FIRST unblock (one scripted
// turn each, replayed immediately) and "demo-review" on the second.
//
// The earlier workaround was a second scripted turn for "demo-review" alone,
// which fixed one task and left the mechanism broken. The mechanism is fixed
// here instead: if the scripted files leave the worktree clean, the turn writes
// a note whose content includes the turn index — the same thing the unscripted
// path already does, and the reason that path never had this bug.
function commitWork(commit, turnIndex) {
  for (const file of commit.files) {
    const full = path.join(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }

  if (worktreeIsClean()) {
    writeTurnNote(turnIndex,
      'Replayed "' + commit.message + '" — the scripted change was already in place, ' +
      'so this turn recorded a note instead.');
  }

  const add = spawnSync('git', ['add', '-A'], { cwd: process.cwd() });
  if (add.status !== 0) {
    throw new Error('demo agent: git add failed: ' + (add.stderr || '').toString());
  }
  const args = ['-c', 'user.email=demo-agent@lazy.invalid', '-c', 'user.name=Lazy Demo Agent',
    'commit', '-m', commit.message];
  const done = spawnSync('git', args, { cwd: process.cwd() });
  if (done.status !== 0) {
    throw new Error('demo agent: git commit failed: ' + (done.stderr || '').toString());
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// PACING. A turn that reports the instant it starts shows a person nothing —
// the task jumps from created to blocked and "working" is never on screen — so
// each turn takes pacing.json's "ms" before it reports (installDemoAgent writes
// it; 0 or a missing file means no pacing). The wait is one long tool call on
// the wire: a tool_use, then every second a tool_progress heartbeat and a line
// of assistant text, then the tool_result — the shapes the activity parser
// knows (see demoHeartbeatEvent / demoProgressTextEvent in agent.ts).
function pacingMs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'pacing.json'), 'utf-8'));
    return typeof parsed.ms === 'number' && parsed.ms > 0 ? parsed.ms : 0;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('demo agent: ignoring unreadable pacing.json: ' + err.message + '\n');
    }
    return 0;
  }
}

// Only the invocation that OPENS a work turn is paced — the one lazy hands its
// system prompt. The review, revise and walkthrough steps inside a turn, and
// the accept-time description one-shot, resume without it; pacing those too
// would multiply every turn (and every accept) by several waits nobody watches.
async function pace() {
  if (!argv.includes('--append-system-prompt')) return;
  const ms = pacingMs();
  if (ms <= 0) return;
  const id = 'toolu_demo_pace';
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read' }] } });
  const deadline = Date.now() + ms;
  let beat = 0;
  while (Date.now() < deadline) {
    await sleep(Math.min(1000, deadline - Date.now()));
    beat += 1;
    emit({ type: 'tool_progress', parent_tool_use_id: id, tool_name: 'Read' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still working (' + beat + ')...' }] } });
  }
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
}

async function main() {
  const turns = loadTurns();
  const sessionId = 'demo-sess-' + taskCode;

  // A task with no script still has to produce a WELL-FORMED turn WITH WORK IN
  // IT. Two reasons, and the second is the one that matters: an agent that
  // emits nothing looks to the supervisor like one that died, and a turn with
  // no commit gives a reviewer an empty diff. Unscripted tasks are not an edge
  // case here — every task somebody creates themselves while trying the demo
  // is one, including the ones created from Lazy Teams, and "I made a task and
  // there was nothing to review" is the demo failing at its whole job.
  if (!turns || turns.length === 0) {
    const index = nextTurnIndex();
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_demo_1', name: 'Edit' }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_demo_1' }] } });
    await pace();

    const note = writeTurnNote(index,
      'This task has no script, so the stand-in agent recorded a note instead.');
    commitWork({ message: 'demo: record a note for ' + taskCode, files: [] }, index);

    emit({
      type: 'result', subtype: 'success',
      result: 'Demo agent: wrote ' + note + '. This task has no script, so the stand-in ' +
        'agent left a note instead — enough for a real diff to review.',
      session_id: sessionId,
      usage: { input_tokens: 1200, output_tokens: 480 },
    });
    process.exit(0);
  }

  // A task invoked more times than it has scripted turns REPLAYS the last one.
  // That is what every repeated unblock does, and "commitWork" is what makes it
  // produce a real change rather than an empty commit.
  const turnIndex = nextTurnIndex();
  const turn = turns[Math.min(turnIndex, turns.length - 1)];

  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_demo_1', name: 'Edit' }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_demo_1' }] } });
  await pace();

  if (turn.commit) commitWork(turn.commit, turnIndex);

  // The "working" seed: hold the turn open WITHOUT reporting, so the task is
  // genuinely mid-turn. Reporting first and then sleeping would be the
  // wind-down case instead, which the supervisor treats as finished.
  //
  // The hold KEEPS ITSELF ALIVE by completing a step every couple of minutes.
  // A plain sleep does not survive: the supervisor's watchdog kills an agent
  // that spends longer than watchdog_output_timeout_ms (30 minutes by default)
  // on a single step, so a 45-minute sleep always ended in a kill and the
  // advertised "working" task quietly became "interrupted". Anyone who left a
  // demo up and came back — which is how it gets used for screenshots — found
  // the state gone, and the e2e could not see it because it looks seconds after
  // "up".
  //
  // It has to be a COMPLETED step, not a heartbeat: lazy deliberately does not
  // count a stuck tool call's keep-alives as progress (see
  // watchdog_output_timeout_ms in lazy.toml.example), because otherwise a
  // wedged call would never be caught. So each beat is a tool_use followed by
  // its tool_result — the same shape any real step has.
  if (turn.holdMs) {
    const deadline = Date.now() + turn.holdMs;
    let beat = 0;
    while (Date.now() < deadline) {
      await sleep(Math.min(KEEPALIVE_INTERVAL_MS, deadline - Date.now()));
      if (Date.now() >= deadline) break;
      beat += 1;
      const id = 'toolu_demo_hold_' + beat;
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read' }] } });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    }
  }

  emit({
    type: 'result', subtype: 'success',
    result: turn.result,
    session_id: sessionId,
    usage: { input_tokens: 1200, output_tokens: 480 },
  });
  process.exit(0);
}

main().catch(err => {
  process.stderr.write('demo agent failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(70);
});
`;
