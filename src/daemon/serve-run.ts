/**
 * Start services, run by the daemon in the TASK's own container.
 *
 * This is what solo lazy has always done — the dashboard's Start services types
 * the project's command into a shell that IS the task's container — made into
 * one daemon operation so a surface with no shell into that container (Lazy
 * Teams, whose terminals are a member's own container, ./member-container.ts)
 * gets the same result:
 *
 *   - the services run where `servePorts` looks (the task's container, which
 *     publishes the declared `[serve]` ports), so the Services tab reports what
 *     is really running;
 *   - they run in a container that outlives member sessions and turns — nothing
 *     reaps an idle task container, and a member's entry no longer stops it
 *     (./member-entry.ts, engineer 2026-10-05) — so a build tool's state in it
 *     (a cargo registry under $HOME, anything kept outside the worktree)
 *     survives from one Start services to the next. A daemon restart does stop
 *     it (shutdown sweep, restart reaper); services then do not come back by
 *     themselves, and the next bring-up is a fresh container.
 *   - they are SHARED: one set per task, keyed by nothing but the task, which
 *     every member sees and controls. Never per member.
 *
 * WHAT IT DOES NOT DO: give anybody a terminal in the task's container. The
 * command is the project's designated Start services command, run detached with
 * no stdin; the person who pressed the button gets its OUTPUT (a log tail on the
 * Services tab), never a shell, and none of their credentials go anywhere. The
 * container holds what it always holds between turns — the task agent's own
 * placeholder — and runs code the task's branch wrote, exactly as a turn does;
 * nothing a person owns is added to it. A member's Shell, Pair and Chat keep
 * their own container, untouched.
 *
 * One services process per task container. Re-running stops the previous
 * process group first, so a second press is a restart, not a second dev server
 * fighting for the port. Its pid and log live in the container's /tmp, so they
 * go away with the container, as the processes do.
 */

import { ensureTaskContainer, type EnsureTaskContainerParams, type EnsureTaskContainerResult } from './task-container';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { resolveProjectStartServicesCmd, resolveProjectStopServicesCmd } from '../serve/start-cmd';
import { createRunner } from '../runner';
import { displayId, getWorktreePathForRef, taskRef } from '../task/identity';
import { spawn } from '../utils/spawn';
import type { Storage } from '../storage';
import type { Session, Task } from '../types';
import { isTerminalStatus } from '../task-state-machine';
import { PhaseReporter, SERVE_RUN_PHASES, RUN_SERVE_RUN_PHASES, serveRunPhasePlan, throttleNotes, type PhaseNotify, type ProgressEmitter } from './progress';
import type { EnsureRunContainerParams, EnsureRunContainerResult } from './commit-run-container';
import { runContainerName, runWorktreePath } from '../run/identity';
import type { CommitRun } from '../storage/types';

/** Where the services process's pid and output live, inside the task's container. */
export const SERVICES_PID_FILE = '/tmp/lazy-services.pid';
export const SERVICES_LOG_FILE = '/tmp/lazy-services.log';

/** How much of the log a status read returns. */
const LOG_TAIL_BYTES = 16 * 1024;

/** The container CLI a runner type drives. */
export function containerBinaryFor(runnerType: string): string {
  return runnerType === 'podman' ? 'podman' : 'docker';
}

/**
 * The script `sh -c` runs in the container, with the command as `$1` — never
 * interpolated, so nothing in it is parsed twice.
 *
 * Stops the previous services process GROUP (`setsid` made it a leader, so its
 * children — a `bin/dev`'s foreman, cargo's rustc — go with it), then starts the
 * command in a new session, detached, its output to the log.
 */
export function startServicesScript(settleSeconds?: number): string {
  return [
    `pidf=${SERVICES_PID_FILE}; logf=${SERVICES_LOG_FILE}`,
    // `$2` is the worktree. Take ownership of anything in it the container
    // user cannot write, as a member attach does on every attach: a root guest
    // daemon keeps writing into the worktree after the container started (a
    // sync merge, a restore creating log/), and the wrapper only adopts before a
    // turn. The worktree's .git pointer is read-only by design and left alone.
    'if [ -n "$2" ] && find "$2" ! -writable ! -path "$2/.git" -print -quit 2>/dev/null | grep -q .; then' +
      ' sudo -n find "$2" ! -path "$2/.git" -exec chown -h "$(id -u):$(id -g)" {} + 2>/dev/null || true; fi',
    'if [ -s "$pidf" ]; then old=$(cat "$pidf"); kill -TERM -"$old" 2>/dev/null;' +
      ' i=0; while kill -0 -"$old" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done;' +
      ' kill -KILL -"$old" 2>/dev/null; fi',
    // The previous group's pid must go before the new one starts: the wait
    // below polls for a NON-EMPTY pid file, and a stale one satisfied it at
    // once, so a status read straight after a restart named the dead group
    // and reported "stopped" for a command that was starting.
    'rm -f "$pidf"',
    ': > "$logf"',
    // `$0` of the inner shell is its name; the command is `$1`, run by sh -c.
    // The wrapper stays the group leader (so a stop still takes the whole group)
    // and records the command's exit status, so a command that daemonizes and
    // exits 0 is told apart from one that failed.
    'rm -f "$pidf.status"',
    // The command as launched, for the inventory (servicesStatusScript): the
    // project's command can change while an older one is still running.
    'printf \'%s\' "$1" > "$pidf.cmd"',
    'setsid sh -c \'echo $$ > "$0"; sh -c "$1"; echo $? > "$0.status"\' "$pidf" "$1" < /dev/null >> "$logf" 2>&1 &',
    // Give the pid file a moment to exist, so a status read straight after
    // the call does not report "not running" for a process that is starting.
    'i=0; while [ ! -s "$pidf" ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done',
    // `settleSeconds`, when given, is how long to wait before reporting whether
    // the command is still alive — in the status script's shape — so a command
    // that dies at once (a typo, a missing binary, a port in use) is caught by
    // the same exec that started it instead of looking started.
    ...(settleSeconds === undefined ? [] : [
      `sleep ${Math.max(0, Math.floor(settleSeconds))}`,
      // `finished`: the command exited 0 by itself (a pm2/overmind/supervisord
      // start that daemonized) — not a failure.
      'if [ -s "$pidf" ] && kill -0 -"$(cat "$pidf")" 2>/dev/null; then echo running;' +
        ' elif [ "$(cat "$pidf.status" 2>/dev/null)" = 0 ]; then echo finished; else echo stopped; fi',
      `tail -c ${LOG_TAIL_BYTES} "$logf"`,
    ]),
    'exit 0',
  ].join('\n');
}

/**
 * Stop the services process group, if any. With `withCommand`, the project's
 * Stop services command (`$1`, never interpolated) runs first; its exit status
 * becomes the script's, but the process group is ended after it EITHER way, so
 * a stop command that fails or forgets a process still leaves nothing running.
 */
export function stopServicesScript(withCommand = false): string {
  if (withCommand) {
    return [
      `pidf=${SERVICES_PID_FILE}`,
      'sh -c "$1" < /dev/null 2>&1; rc=$?',
      'if [ -s "$pidf" ]; then old=$(cat "$pidf"); kill -TERM -"$old" 2>/dev/null;' +
        ' i=0; while kill -0 -"$old" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done;' +
        ' kill -KILL -"$old" 2>/dev/null; rm -f "$pidf"; fi',
      'exit $rc',
    ].join('\n');
  }
  return [
    `pidf=${SERVICES_PID_FILE}`,
    '[ -s "$pidf" ] || exit 0',
    'old=$(cat "$pidf"); kill -TERM -"$old" 2>/dev/null',
    'i=0; while kill -0 -"$old" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
    'kill -KILL -"$old" 2>/dev/null; rm -f "$pidf"; exit 0',
  ].join('\n');
}

/** Most processes the inventory lists; a runaway fork must not flood a page. */
export const MAX_INVENTORY_PROCESSES = 64;

/** The largest log tail a status read may ask for (the "more output" view). */
export const MAX_LOG_TAIL_BYTES = 512 * 1024;

/**
 * Prints the state (`running`, `stopped`, `never`) on the first line, then the
 * INVENTORY as `@@`-prefixed lines up to `@@end`, then the log's tail.
 *
 * The inventory is read straight from /proc, so it needs nothing the image may
 * lack (no `ps`, no `ss`): every process in the services process GROUP (the
 * one `setsid` made — the command and everything it started), each one's
 * listening TCP sockets, and the wrapper's record of how the command ended.
 *
 *   @@pid <group leader>     @@started <epoch the pid file was written>
 *   @@exit <code>            @@cmd <the command as launched>
 *   @@logbytes <log size>
 *   @@proc <pid> <ppid> <state> <cmdline>
 *   @@sock <pid> <inode>     @@listen <port> <inode>
 */
export function servicesStatusScript(tailBytes: number = LOG_TAIL_BYTES): string {
  const tail = Math.max(1, Math.min(MAX_LOG_TAIL_BYTES, Math.floor(tailBytes)));
  return [
    `pidf=${SERVICES_PID_FILE}; logf=${SERVICES_LOG_FILE}`,
    'if [ -s "$pidf" ] && kill -0 -"$(cat "$pidf")" 2>/dev/null; then echo running;' +
      ' elif [ -e "$logf" ]; then echo stopped; else echo never; fi',
    'pg=; if [ -s "$pidf" ]; then pg=$(cat "$pidf"); echo "@@pid $pg";' +
      ' echo "@@started $(stat -c %Y "$pidf" 2>/dev/null)"; fi',
    '[ -s "$pidf.status" ] && echo "@@exit $(cat "$pidf.status")"',
    '[ -s "$pidf.cmd" ] && echo "@@cmd $(head -n 1 "$pidf.cmd")"',
    '[ -e "$logf" ] && echo "@@logbytes $(wc -c < "$logf")"',
    // Every process whose group is the services group. /proc/<pid>/stat is
    // `pid (comm) state ppid pgrp …`, and comm may hold spaces: cut at the
    // LAST `) ` before splitting.
    'if [ -n "$pg" ]; then n=0; for d in /proc/[0-9]*; do' +
      ' read -r st < "$d/stat" 2>/dev/null || continue; rest=${st##*) }; set -- $rest;' +
      ` [ "$3" = "$pg" ] || continue; n=$((n+1)); [ $n -le ${MAX_INVENTORY_PROCESSES} ] || break; p=\${d#/proc/};` +
      ' echo "@@proc $p $2 $1 $(tr \'\\0\\n\' \'  \' < "$d/cmdline" 2>/dev/null | cut -c1-300)";' +
      // One `ls` per group process, not a readlink per descriptor.
      ' ls -l "$d/fd" 2>/dev/null | while read -r line; do case "$line" in *socket:\\[*) i=${line##*socket:[};' +
      ' echo "@@sock $p ${i%]}";; esac; done;' +
      ' done; fi',
    // Listening TCP sockets (state 0A), IPv4 and IPv6: local port (hex), inode.
    'for t in /proc/net/tcp /proc/net/tcp6; do [ -r "$t" ] || continue;' +
      ' while read -r _ local _ st _ _ _ _ _ inode _; do [ "$st" = 0A ] || continue;' +
      ' echo "@@listen $((0x${local##*:})) $inode"; done < "$t"; done',
    'echo "@@end"',
    `[ -e "$logf" ] && tail -c ${tail} "$logf"`,
    'exit 0',
  ].join('\n');
}

/** One process in the services process group, as the container reports it. */
export interface ServicesProcess {
  pid: number;
  ppid: number;
  /** The kernel's one-letter state: R running, S sleeping, Z zombie, … */
  procState: string;
  /** Its command line (cut to 300 characters). */
  command: string;
  /** TCP ports this process listens on inside the container. */
  listeningPorts: number[];
  /**
   * True for the group leader: lazy's own wrapper that runs the command and
   * records its exit code. Its command line is lazy's plumbing, so `command`
   * carries the launched command instead.
   */
  wrapper?: boolean;
}

/**
 * What Start services launched in the task's container, and what it is doing.
 * `state` and `log` keep their original meaning for older readers; the rest is
 * the inventory, absent when the container answered in the older shape.
 */
export interface ServicesRunState {
  /** `running`: the process group is alive. `stopped`: it ran and exited. `never`: not started in this container. */
  state: 'running' | 'stopped' | 'never';
  /** The tail of the command's combined output ('' when none). */
  log: string;
  /**
   * The one-word answer for a person: `starting` (alive, listening on nothing
   * yet, launched within {@link STARTING_WINDOW_SECONDS}s), `running`, `exited`
   * (ended by itself — see `exitCode`), `stopped` (stopped, or ended without
   * recording a code), `never`.
   */
  phase?: 'starting' | 'running' | 'exited' | 'stopped' | 'never';
  /** The services process group's leader, while it runs. */
  pid?: number | null;
  /** The command as it was launched. */
  command?: string | null;
  /** When it was launched (ISO 8601). */
  startedAt?: string | null;
  /** The command's exit code, when it ended by itself. */
  exitCode?: number | null;
  /** The processes in the group, the leader first ([] when not running). */
  processes?: ServicesProcess[];
  /** The whole log's size in bytes; `logTruncated` when `log` holds less. */
  logBytes?: number | null;
  logTruncated?: boolean;
}

/**
 * How long a status read may take. Well under Teams' web read limit (8s): a
 * slow inventory comes back "not known" rather than failing the whole
 * servePorts answer and the port list with it.
 */
export const STATUS_READ_TIMEOUT_MS = 5_000;

/** How long a live command listening on nothing reads as `starting`. */
export const STARTING_WINDOW_SECONDS = 120;

export interface ServeRunDeps {
  getStorage?: () => Promise<Storage>;
  ensureContainer?: (projectRoot: string, params: EnsureTaskContainerParams) => Promise<EnsureTaskContainerResult>;
  /** A commit run's bring-up (./commit-run-container.ts); defaults to ensureRunContainer. */
  ensureRunContainer?: (projectRoot: string, params: EnsureRunContainerParams) => Promise<EnsureRunContainerResult>;
  exec?: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  resolveCmd?: (storage: Storage, projectRoot: string) => Promise<string>;
  resolveStopCmd?: (storage: Storage) => Promise<string>;
  /** Where a stop is sent: the task's running container, or null when there is none. */
  containerTarget?: (projectRoot: string, task: Task, session: Session | null) => Promise<{ binary: string; name: string } | null>;
  /** Injectable clock for the restore-note throttle. */
  now?: () => number;
  /** Where `serve.run` narrates its phases (the request's heartbeat envelope). */
  progress?: ProgressEmitter;
}

async function defaultExec(argv: string[], timeoutMs: number) {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: timeoutMs });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function resolveTaskOrThrow(storage: Storage, ref: string): Promise<Task> {
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) {
    throw new RpcError(resolved.ambiguousMatches?.length ? 409 : 404,
      resolved.ambiguousMatches?.length ? `Ambiguous task ID '${ref}'.` : `Task not found: ${ref}`);
  }
  return resolved.task;
}

/**
 * What Start services acts on: a task, or a commit run (./commit-run.ts) — the
 * product at one commit without a task. Exactly one of the two ids.
 */
export type ServeSubjectParams = { taskId: string; runId?: undefined } | { runId: string; taskId?: undefined };

/** Read `taskId` / `runId` off RPC params: exactly one, a non-empty string. */
export function serveSubjectParams(params: Record<string, unknown>): ServeSubjectParams {
  const taskId = params.taskId;
  const runId = params.runId;
  if (taskId !== undefined && runId !== undefined) throw new RpcError(400, "Give either 'taskId' or 'runId', not both.");
  if (typeof runId === 'string' && runId) return { runId };
  if (runId !== undefined) throw new RpcError(400, "'runId' must be a non-empty string.");
  if (typeof taskId === 'string' && taskId) return { taskId };
  throw new RpcError(400, "Missing required parameter 'taskId' (or 'runId' for a run).");
}

async function resolveRunOrThrow(storage: Storage, ref: string): Promise<CommitRun> {
  const run = (await storage.getCommitRun(ref)) ?? (await storage.getCommitRunBySlug(ref));
  if (!run) throw new RpcError(404, `Run not found: ${ref}`);
  return run;
}

/**
 * Run the project's Start services command in the task's container, bringing
 * the container up first if it is not (the same bring-up as Start container,
 * which works whether or not a member has a terminal open). A second call
 * restarts the command.
 *
 * NARRATED as phases on the daemon's progress channel (./progress.ts, the
 * heartbeat envelope's `{"progress": …}` lines) — restore task files, start
 * the task's environment, start services — each started, skipped with a reason,
 * done or failed as it happens, so a surface can show the bring-up live instead
 * of a button that answers minutes later. The restore phase is fed by the
 * restore itself (`restoreProgress`), so whatever progress it reports lands on
 * that row. A failure fails the phase it happened in, with a readable reason
 * (see {@link readableFailure}) rather than a command's raw output.
 */
export async function runStartServices(
  projectRoot: string,
  params: ServeSubjectParams,
  deps: ServeRunDeps = {},
): Promise<{ containerName: string; command: string; containerStarted: boolean }> {
  const reporter = new PhaseReporter(deps.progress, 'serve.run');
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  // The subject decides only two things: how its environment is brought up,
  // and what the phases are called. Everything after is the same.
  let subject: string;
  let ensure: (p: Omit<EnsureTaskContainerParams, 'taskId'>) => Promise<EnsureTaskContainerResult>;
  let P: typeof SERVE_RUN_PHASES | typeof RUN_SERVE_RUN_PHASES = SERVE_RUN_PHASES;
  let filesInPlace = 'task files are in place';
  if (params.runId !== undefined) {
    const run = await resolveRunOrThrow(storage, params.runId);
    subject = run.slug;
    P = RUN_SERVE_RUN_PHASES;
    filesInPlace = 'the checkout is in place';
    ensure = async (p) => (deps.ensureRunContainer ?? (await import('./commit-run-container')).ensureRunContainer)(projectRoot, { runId: run.id, ...p });
  } else {
    const task = await resolveTaskOrThrow(storage, params.taskId);
    // A finished task's environment is not something to bring back: bringing
    // the container up would recreate its worktree.
    if (isTerminalStatus(task.status)) {
      throw new RpcError(409, `Task ${displayId(task)} is ${task.status}; its services cannot be started.`);
    }
    subject = displayId(task);
    ensure = (p) => (deps.ensureContainer ?? ensureTaskContainer)(projectRoot, { taskId: task.id, ...p });
  }
  const command = await (deps.resolveCmd ?? resolveProjectStartServicesCmd)(storage, projectRoot);
  if (!command) {
    throw new RpcError(409, 'No Start services command is designated for this project. Designate one first: Settings › Services on the dashboard, or the project\'s Configuration page in Lazy Teams.');
  }

  reporter.announce(serveRunPhasePlan(P), subject);
  // Which phase is open decides where a failure is reported. The restore and
  // the launch happen inside one bring-up, so the hooks open them as they begin.
  let restoring = false;
  let launching = false;
  // The restore reports a note per percentage step; Teams turns each into a
  // write and a page refresh, so notes are throttled — the first (opening the
  // phase) always goes, and the last one dropped is sent before the phase closes.
  let pendingRestoreNote: string | null = null;
  const restoreNote = throttleNotes((detail) => { pendingRestoreNote = null; reporter.note(detail); }, RESTORE_NOTE_THROTTLE_MS, deps.now);
  const restoreProgress: PhaseNotify = (detail) => {
    if (!restoring) {
      restoring = true;
      reporter.begin(P.restore, detail);
      return;
    }
    pendingRestoreNote = detail;
    restoreNote(detail);
  };
  const flushRestoreNote = () => { if (pendingRestoreNote !== null) reporter.note(pendingRestoreNote); pendingRestoreNote = null; };
  const onLaunching = () => {
    launching = true;
    flushRestoreNote();
    if (!restoring) reporter.skip(P.restore, filesInPlace);
    reporter.begin(P.environment, 'the environment is not running — starting it');
  };
  // Narration from the launch itself (image resolution, a docker build).
  const notify = throttleNotes((detail) => { if (launching) reporter.note(detail); });

  let container: EnsureTaskContainerResult;
  try {
    container = await ensure({ notify: (d) => notify(d), restoreProgress, onLaunching });
  } catch (err) {
    flushRestoreNote();
    const reason = readableFailure(err);
    if (!restoring && !launching) reporter.begin(P.environment);
    reporter.fail(reason);
    throw rethrowReadable(err, reason);
  }
  if (launching) {
    reporter.end(`${container.containerName} is up`);
  } else {
    flushRestoreNote();
    if (restoring) reporter.end();
    else reporter.skip(P.restore, filesInPlace);
    reporter.skip(P.environment, 'already running');
  }

  reporter.begin(P.services, `running ${command}`);
  const exec = deps.exec ?? defaultExec;
  const binary = containerBinaryFor(container.runnerType);
  const result = await exec(
    [binary, 'exec', '-w', container.worktreePath, container.containerName, 'sh', '-c', startServicesScript(SETTLE_SECONDS), 'lazy-services', command, container.worktreePath],
    30_000,
  );
  if (result.exitCode !== 0) {
    const reason = readableFailure(result.stderr.trim() || `exit ${result.exitCode}`);
    reporter.fail(`the command could not be started: ${reason}`);
    throw new RpcError(500, `Start services could not be started in ${container.containerName}: ${reason}`);
  }
  // A command that dies at once is the commonest failure, and would otherwise
  // look started: the script looked again after SETTLE_SECONDS. Anything but
  // `stopped` (an older shape, no answer) is not evidence it died.
  if (result.stdout.startsWith('finished\n') || result.stdout.trim() === 'finished') {
    reporter.end(`${command} finished (exit 0); anything it started in the background keeps running`);
    return { containerName: container.containerName, command, containerStarted: !container.alreadyRunning };
  }
  const after = parseServicesStatus(result.stdout);
  if (after.state === 'stopped') {
    const tail = lastLines(after.log, 5);
    reporter.fail(`${command} exited straight away${tail ? `. Its last output:\n${tail}` : ' without printing anything.'}`);
    throw new RpcError(500, `Start services exited straight away in ${container.containerName}${tail ? `. Its last output:\n${tail}` : ', printing nothing.'}`);
  }
  reporter.end(after.state === 'running' ? `${command} is running` : `${command} was started`);
  return { containerName: container.containerName, command, containerStarted: !container.alreadyRunning };
}

/** Minimum gap between restore progress notes on the wire. */
const RESTORE_NOTE_THROTTLE_MS = 1000;

/** How long Start services waits before checking the command did not die at once. */
const SETTLE_SECONDS = 2;

function lastLines(text: string, n: number): string {
  // ANSI colour codes stripped: a dev server colours its output for a terminal.
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
}

/**
 * One readable sentence for a failure, never a command's whole output. A git
 * restore failure arrives with its progress meter (`Filtering content: 7% …`)
 * and every per-file line inlined; what a person needs is the line that says
 * why. Prefer `fatal:` / `error:` lines, drop progress lines, cap the length.
 */
export function readableFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean)
    .filter(l => !/\d+% \(\d+\/\d+\)/.test(l));
  const fatal = lines.find(l => /^fatal:/.test(l));
  const errors = lines.filter(l => /^error:/.test(l));
  let text: string;
  if (fatal || errors.length) {
    const head = lines[0] && !/^(fatal|error):/.test(lines[0]) ? `${lines[0].replace(/[:\s]+$/, '')}: ` : '';
    const parts = [...errors.slice(0, 2), ...(errors.length > 2 ? [`(and ${errors.length - 2} more errors)`] : []), ...(fatal ? [fatal] : [])];
    text = head + parts.join(' ');
  } else {
    text = lines.join(' ');
  }
  // A progress meter inlined on one line (git writes `\r` between updates, which
  // a joined message turns into spaces): drop everything from its first word.
  text = text.replace(/\s*(Filtering content|Updating files|Receiving objects|Resolving deltas):.*?(?=(error:|fatal:|$))/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 1200 ? `${text.slice(0, 1197)}…` : text;
}

function rethrowReadable(err: unknown, reason: string): Error {
  if (err instanceof RpcError) return new RpcError(err.status, reason, err.code);
  return new RpcError(500, reason);
}


/** Stop the services process in the task's container. A container that is not running has nothing to stop. */
export async function stopStartServices(
  projectRoot: string,
  params: ServeSubjectParams,
  deps: ServeRunDeps = {},
): Promise<{ stopped: boolean }> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  let target: { binary: string; name: string } | null;
  let worktreePath: string;
  if (params.runId !== undefined) {
    const run = await resolveRunOrThrow(storage, params.runId);
    target = await runContainerTarget(projectRoot, run);
    worktreePath = runWorktreePath(projectRoot, run.slug);
  } else {
    const task = await resolveTaskOrThrow(storage, params.taskId);
    const session = await storage.getSessionByTaskId(task.id);
    target = await (deps.containerTarget ?? taskContainerTarget)(projectRoot, task, session);
    worktreePath = getWorktreePathForRef(projectRoot, taskRef(task));
  }
  if (!target) return { stopped: false };
  const stopCmd = await (deps.resolveStopCmd ?? resolveProjectStopServicesCmd)(storage);
  // The worktree is mounted at the same path inside the container.
  const argv = stopCmd
    ? [target.binary, 'exec', '-w', worktreePath, target.name,
        'sh', '-c', stopServicesScript(true), 'lazy-services-stop', stopCmd]
    : [target.binary, 'exec', target.name, 'sh', '-c', stopServicesScript()];
  const result = await (deps.exec ?? defaultExec)(argv, 30_000);
  if (result.exitCode !== 0) {
    const detail = lastLines(`${result.stdout}\n${result.stderr}`, 5) || `exit ${result.exitCode}`;
    // No exit code: the exec was killed at its time limit, so the script's own
    // kill step may never have run — claim nothing about the services.
    if (result.exitCode === null) {
      throw new RpcError(500, `Stopping the services in ${target.name} did not finish within 30 seconds${stopCmd ? ` (Stop services command "${stopCmd}")` : ''}; they may still be running. Its last output:\n${detail}`);
    }
    throw new RpcError(500, stopCmd
      ? `The Stop services command "${stopCmd}" failed in ${target.name} (exit ${result.exitCode}); the services were stopped anyway. Its last output:\n${detail}`
      : `Could not stop the services in ${target.name}: ${detail}`);
  }
  return { stopped: true };
}

/** A run's container when it is running; null otherwise. */
export async function runContainerTarget(projectRoot: string, run: CommitRun): Promise<{ binary: string; name: string } | null> {
  const runner = await createRunner(projectRoot);
  if (!runner.usesSandbox()) return null;
  const name = runContainerName(projectRoot, run.slug);
  if (!(await runner.isRunning(name))) return null;
  return { binary: containerBinaryFor(runner.type), name };
}

/** The task's container when it is running on a container runner; null otherwise. */
export async function taskContainerTarget(projectRoot: string, task: Task, session: Session | null): Promise<{ binary: string; name: string } | null> {
  const runner = await createRunner(projectRoot, session?.runner_type ?? task.runner_type ?? undefined);
  if (!runner.usesSandbox()) return null;
  const name = session?.container_name ?? runner.runNameForTask(taskRef(task));
  if (!(await runner.isRunning(name))) return null;
  return { binary: containerBinaryFor(runner.type), name };
}

/**
 * Parse {@link servicesStatusScript}'s output. Output with no `@@end` (the start
 * script's settle report, or a shape from before the inventory) is the state
 * line and the log, as it always was.
 */
export function parseServicesStatus(stdout: string, now: number = Date.now()): ServicesRunState {
  const nl = stdout.indexOf('\n');
  const head = (nl === -1 ? stdout : stdout.slice(0, nl)).trim();
  const state = head === 'running' || head === 'stopped' ? head : 'never';
  const rest = nl === -1 ? '' : stdout.slice(nl + 1);
  const lines = rest.split('\n');
  const endIdx = rest.startsWith('@@') ? lines.indexOf('@@end') : -1;
  if (endIdx === -1) return { state, log: rest };
  const log = lines.slice(endIdx + 1).join('\n');

  let pid: number | null = null;
  let started: number | null = null;
  let exitCode: number | null = null;
  let command: string | null = null;
  let logBytes: number | null = null;
  const procs: ServicesProcess[] = [];
  const sockets = new Map<number, string[]>();
  const listening = new Map<string, number>();
  const int = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  for (const line of lines.slice(0, endIdx)) {
    const m = /^@@(\w+) ?(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const parts = value.split(' ');
    switch (key) {
      case 'pid': pid = int(value); break;
      case 'started': started = int(value); break;
      case 'exit': exitCode = int(value); break;
      case 'cmd': command = value || null; break;
      case 'logbytes': logBytes = int(value); break;
      case 'proc': {
        const p = int(parts[0]);
        if (p === null) break;
        procs.push({ pid: p, ppid: int(parts[1]) ?? 0, procState: parts[2] ?? '', command: parts.slice(3).join(' ').trim(), listeningPorts: [] });
        break;
      }
      case 'sock': {
        const p = int(parts[0]);
        if (p !== null && parts[1]) sockets.set(p, [...(sockets.get(p) ?? []), parts[1]]);
        break;
      }
      case 'listen': {
        const port = int(parts[0]);
        // Inode 0 is a socket nobody owns any more (TIME_WAIT-ish leftovers).
        if (port !== null && parts[1] && parts[1] !== '0') listening.set(parts[1], port);
        break;
      }
    }
  }
  for (const proc of procs) {
    const ports = new Set<number>();
    for (const inode of sockets.get(proc.pid) ?? []) {
      const port = listening.get(inode);
      if (port !== undefined) ports.add(port);
    }
    proc.listeningPorts = [...ports].sort((a, b) => a - b);
  }
  for (const proc of procs) {
    if (proc.pid === pid) {
      proc.wrapper = true;
      if (command) proc.command = command;
    }
  }
  // The leader first, then by pid: the tree reads top-down.
  procs.sort((a, b) => (a.pid === pid ? -1 : b.pid === pid ? 1 : a.pid - b.pid));

  let phase: ServicesRunState['phase'];
  if (state === 'running') {
    const young = started !== null && now / 1000 - started < STARTING_WINDOW_SECONDS;
    phase = young && !procs.some(p => p.listeningPorts.length > 0) ? 'starting' : 'running';
  } else if (state === 'stopped') {
    phase = exitCode !== null ? 'exited' : 'stopped';
  } else {
    phase = 'never';
  }
  const running = state === 'running';
  return {
    state,
    log,
    phase,
    pid: running ? pid : null,
    command,
    startedAt: started !== null ? new Date(started * 1000).toISOString() : null,
    exitCode: running ? null : exitCode,
    processes: running ? procs : [],
    logBytes,
    logTruncated: logBytes !== null && logBytes > Buffer.byteLength(log),
  };
}

/**
 * Is Start services running in this container, and what has it printed? null
 * when the container could not be asked — "not known" is not "not running".
 */
export async function readServicesRunState(
  binary: string,
  containerName: string,
  exec: ServeRunDeps['exec'] = defaultExec,
  opts: { logBytes?: number } = {},
): Promise<ServicesRunState | null> {
  const result = await exec([binary, 'exec', containerName, 'sh', '-c', servicesStatusScript(opts.logBytes)], STATUS_READ_TIMEOUT_MS);
  if (result.exitCode !== 0) return null;
  return parseServicesStatus(result.stdout);
}

/** A declared `[serve]` service a process is listening on, and whether it answers from outside. */
export interface ProcessServiceLink {
  name: string;
  port: number;
  /** The probe's answer for the published port (src/serve/probe.ts); null when it could not be attempted. */
  listening: boolean | null;
}

/**
 * Name each process's listening ports after the declared services they serve,
 * carrying the published port's probe — "pid 42 listens on 3000, which is
 * `web`, and web answers". A rule on the daemon's side so every surface
 * reads the same join.
 */
export function linkProcessesToServices(
  run: ServicesRunState,
  services: Array<{ name: string; port: number; listening: boolean | null }>,
): Omit<ServicesRunState, 'processes'> & { processes: Array<ServicesProcess & { services: ProcessServiceLink[] }> } {
  return {
    ...run,
    processes: (run.processes ?? []).map((proc) => ({
      ...proc,
      services: services
        .filter((s) => proc.listeningPorts.includes(s.port))
        .map((s) => ({ name: s.name, port: s.port, listening: s.listening })),
    })),
  };
}
