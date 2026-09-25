/**
 * Death-resilient registry for daemons AND supervisors spawned by the e2e suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each `setupTestLazy({ withDaemon })` — and any CLI call that implicitly
 * auto-starts a daemon via `ensureDaemon` — leaves a REAL `lazy daemon` running
 * as a detached, `unref()`'d subprocess so it can outlive the individual
 * `runLazy` subprocess calls within a test. `ctx.cleanup()` stops it in
 * `afterEach`.
 *
 * The problem: a detached daemon is not a child that dies with the test
 * process. Whenever the `bun test` process dies WITHOUT running every
 * `afterEach` — Ctrl-C during local iteration (the common case), a test-file
 * crash, or a hard kill — every daemon it started survives FOREVER. These
 * strays squat the daemon web-port window (DEFAULT_WEB_PORT + 100 auto-increment
 * slots); we have observed 100+ orphans exhaust the 26024–26123 range so that
 * the real project daemon gets shoved off the default port and browsers land on
 * an empty e2e store.
 *
 * The fix is a teardown path that does NOT depend on per-test `afterEach`:
 * every test project ROOT is registered here, and process-level
 * `exit`/`SIGINT`/`SIGTERM` handlers read each root's pidfile and SIGKILL any
 * surviving daemon. Normal exits and uncaught crashes go through `exit`; Ctrl-C
 * and `kill` go through the signal handlers. `afterEach` remains the primary,
 * graceful path — this is the net that catches everything it misses.
 *
 * Tracking ROOTS (not pids) is deliberate: an implicitly auto-started daemon is
 * spawned by a grandchild `runLazy` subprocess, so its pid is never visible to
 * the parent test process. But both explicit and auto-started daemons write
 * their pid to `<root>`'s daemon dir, so `readPid(root)` reaps either one.
 *
 * Bun runs all test files in a single process, so one module-level registry
 * (imported by `setup.ts` and the global preload) covers the whole suite.
 *
 * TWO THINGS THIS NET STILL CANNOT DO, AND WHO DOES THEM
 * -----------------------------------------------------
 * 1. A daemon whose pidfile the harness already deleted (cleanup removed the
 *    daemon dir, then a straggler subprocess auto-started a fresh daemon for
 *    that root). Covered here by the command-line sweep over `allTestRoots`.
 * 2. A `bun test` process that is SIGKILLed: no handler in it runs at all. Only
 *    the daemon's own parent watch can cover that — see
 *    `src/daemon/test-parent-watch.ts`, armed by `LAZY_TEST_PARENT_PID` in
 *    setup.ts.
 *
 * SUPERVISORS, NOT JUST DAEMONS
 * -----------------------------
 * A `fakeClaude` suite runs the host-process runner, which spawns a REAL
 * `lazy supervise` subprocess per task — also detached and `unref()`'d, and NOT
 * killed by stopping the daemon that launched it. Nothing used to reap those:
 * a crashed or interrupted run left live supervisors behind whose /tmp
 * worktrees had already been deleted. That is not merely untidy. Every
 * supervisor turn rewrites the ONE shared `~/.claude.json` `mcpServers.lazy`
 * entry with its own `--task-id`/`--worktree` (src/mcp/config.ts), so a leaked
 * test supervisor pointed a real agent's lazy MCP channel at a deleted temp
 * worktree — observed as `lazy_commit` failing with "working directory
 * '/tmp/lazy-e2e-.../worktrees/...' does not exist".
 *
 * So the same three layers now cover supervisors: `ctx.cleanup()` (graceful,
 * SIGTERM then SIGKILL), the exit/signal sweep below, and the supervisor's own
 * `LAZY_TEST_PARENT_PID` watch (src/supervisor/index.ts) for a SIGKILLed run.
 *
 * AND MACHINE ONE-SHOTS
 * ---------------------
 * There is a third leakable process, one level further down: a machine one-shot
 * (accept's fidelity summary, `lazy report`, `lazy ask`, memory compaction). It
 * is a child of whichever process ran it, so killing the daemon does not reap
 * it, and it has no pidfile at all. Containers accumulated stranded `claude`
 * pids carrying the one-shot marker, each one an unbounded model call against a
 * proxy that had already been torn down.
 *
 * One-shots are a Runner concern now (docs/oneshot-execution.md), which shrinks
 * this to the HOST runner: a containerized one-shot is a `--rm` container
 * carrying the project label, reaped like every other lazy container. The host
 * runner still spawns a real process, and it is still bounded by default, so a
 * strand is rare rather than routine — but "rare" is not "none", and the reaper
 * that catches the remaining ones is here.
 *
 * A one-shot is identified by lazy's OWN marker in its argv
 * (ONESHOT_MARKER, stamped into every one-shot prompt) plus a cwd under a
 * directory this run owns; both are required, so a developer's real `claude` on
 * the same machine is never touched.
 */

// NOTE: import the lightweight `paths` module directly, NOT the `src/daemon`
// barrel. The barrel transitively pulls the daemon status path, which imports
// the generated `src/build-info.ts`. This module is imported by the global
// preload — and ES imports hoist, so it loads BEFORE the preload generates that
// file — which is why pulling the barrel here crashes every suite at once in a
// fresh worktree. `paths` only depends on path/crypto/os.
//
// `src/utils/process-identity` passes the same test, and was CHECKED against it
// rather than assumed: its whole import chain is fs / fs-promises / `./spawn`,
// and `./spawn` reaches only node:fs, node:path, bun's `which` and
// `./sanitize-text`, which imports nothing at all. Verified by hiding
// `src/version.ts` and `lazy-agent` — the exact state a cold worktree is in —
// and importing it.
import { readFileSync, existsSync, readdirSync, readlinkSync } from 'fs';
import { basename } from 'path';
import { getPidPath } from '../../src/daemon/paths';
import { processGroupIdSync, isRunningProcessSync } from '../../src/utils/process-identity';
import { commandLooksLikeDaemon } from '../../src/daemon/process-identity';

/**
 * The nonce from ONESHOT_MARKER (src/import/machine-oneshot.ts), duplicated
 * rather than imported ON PURPOSE: this module is loaded by the global preload,
 * before `src/build-info.ts` is generated, so it may only import leaf modules
 * (see the NOTE above). `machine-oneshot.ts` pulls in the logger and, through
 * it, most of the CLI.
 *
 * `test/unit/oneshot-reaper.test.ts` asserts this string is still a substring of
 * the real marker, so the duplication cannot silently rot.
 */
const ONESHOT_MARKER_NONCE = 'lazy-machine-oneshot/v1/';

/** Project roots of test daemons that have not been gracefully stopped yet. */
const liveDaemonRoots = new Set<string>();

/**
 * Every root this process has EVER registered — never pruned.
 *
 * `liveDaemonRoots` is the pidfile-based path and is emptied by a graceful
 * `cleanup()`. But a straggler CLI subprocess can auto-start a fresh daemon for
 * a root AFTER its cleanup ran (`ensureDaemon` sees no daemon and spawns one),
 * and that daemon is invisible to a pidfile the harness already deleted. The
 * exit-time command-line sweep uses this set instead, so such a latecomer is
 * still reaped.
 *
 * Deliberately scoped to roots THIS process created (mkdtemp names are unique):
 * a sweep keyed on "any /tmp/lazy-e2e-* daemon" would reap the daemons of a
 * concurrently running `bun test` process too.
 */
const allTestRoots = new Set<string>();

/**
 * Every directory a machine one-shot spawned by this run could be standing in,
 * beyond the project roots themselves: the per-context `LAZY_ONESHOT_BASE_DIR`
 * temp dir, which is where the fidelity summarizer deliberately runs its agent
 * (src/oneshot/state-dir.ts). Never pruned, for the same reason
 * `allTestRoots` is not.
 */
const allOneshotDirs = new Set<string>();

let handlersInstalled = false;

/** True once a SIGINT/SIGTERM handler has started — second interrupt skips cleanup. */
let interruptHandled = false;

/** Bound for the process-table sweep so teardown cannot hang forever. */
const EXIT_SWEEP_BUDGET_MS = 2_000;

/**
 * Test-only: per-/proc-entry delay so benchmarks can simulate a busy machine
 * without guessing. Read only inside `readAllProcessCommands`.
 */
function sweepDelayPerProcMs(): number {
  const raw = process.env.LAZY_TEST_REGISTRY_SWEEP_DELAY_MS;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

/** Sync read of a root's daemon pidfile. Mirrors `readPid` without the barrel. */
function readDaemonPid(root: string): number | null {
  const pidPath = getPidPath(root);
  if (!existsSync(pidPath)) return null;
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Does this command line belong to a lazy daemon serving exactly `root`?
 *
 * Daemon-ness is decided by the canonical matcher in
 * `src/daemon/process-identity.ts`; on top of it we require the `--project`
 * argument to name this root EXACTLY (token comparison, not `includes`, so one
 * temp root can never match another's daemon). Every daemon the harness can
 * leak carries that flag — `startTestDaemon` passes it, and so does
 * `startDaemonBackground` for auto-started ones.
 */
export function isDaemonCommandForRoot(cmd: string, root: string): boolean {
  // `null` root on purpose: passing the root would take the matcher's
  // "the root appears anywhere" shortcut, which is right when the pid came
  // from that root's daemon dir but far too loose here — we scan EVERY process
  // on the machine, and `lazy show --project <root>` must not read as a daemon.
  if (!commandLooksLikeDaemon(cmd, null)) return false;
  // Every daemon the harness can leak is a `--foreground` one: startTestDaemon
  // spawns it that way, and so does startDaemonBackground's detached child.
  if (!cmd.includes('--foreground')) return false;
  const tokens = cmd.split(/\s+/);
  const idx = tokens.lastIndexOf('--project');
  return idx !== -1 && tokens[idx + 1] === root;
}

/**
 * Does this command line belong to a `lazy supervise` process working inside
 * `root`?
 *
 * The supervisor is always spawned as `<lazy command…> supervise --protocol-dir
 * <dir> --worktree <path> --runner <type>` (see HostProcessRunner.launchSupervisor),
 * and a task's worktree always lives under the project root
 * (`<root>/.lazy/worktrees/<ref>`). As with the daemon matcher we key on the
 * ARGUMENTS — the `lazy` command itself may be a compiled binary or
 * `bun run <repo>/src/index.ts` — and we compare the `--worktree` value as a
 * TOKEN under this exact root, never with `includes`, so one temp root can
 * never match another run's supervisor.
 */
export function isSupervisorCommandForRoot(cmd: string, root: string): boolean {
  const tokens = cmd.split(/\s+/);
  if (!tokens.includes('supervise')) return false;
  const idx = tokens.lastIndexOf('--worktree');
  if (idx === -1) return false;
  const worktree = tokens[idx + 1];
  if (!worktree) return false;
  return worktree === root || worktree.startsWith(`${root}/`);
}

/**
 * Pids of every live `lazy supervise` process working inside `root`. Exported so
 * a test can assert the absence of one after teardown — the leak this whole
 * sweep exists for.
 */
export function findSupervisorsForRoot(root: string): number[] {
  const found: number[] = [];
  for (const [pid, cmd] of readAllProcessCommands()) {
    if (pid !== process.pid && isSupervisorCommandForRoot(cmd, root)) found.push(pid);
  }
  return found;
}

/**
 * A supervisor the sweep found, plus the process group it OWNS (null when it
 * does not own one).
 *
 * Reaping a supervisor by pid alone leaves the AGENT it spawned running,
 * reparented to init — the leak that put fake-`claude` processes in the process
 * table for the rest of a `bun test` run, each holding a worktree the harness
 * then deleted underneath it. The host-process runner launches every supervisor
 * with `setsid()` for exactly this reason, so the group reaches the agent too.
 *
 * `group` is only ever the supervisor's own group id: a process can only join a
 * group led by another process in its session, and a session leader's session
 * holds nothing but its own descendants, so `pgid === pid` is proof that every
 * member is this supervisor or something it started. Anything else — a
 * supervisor from before that launch behaviour, a platform that would not
 * answer — is null and gets the pid alone, exactly as before.
 */
export interface SupervisorTarget {
  pid: number;
  group: number | null;
}

/**
 * The process group `pid` leads, or null if it does not lead one.
 *
 * Ownership only — the READING is `processGroupIdSync`, which owns the
 * procfs-vs-`ps` split for the whole codebase. What is decided here is the
 * narrower question: a pgid equal to the pid means that process created the
 * group, so its members can only be it and its descendants. No answer means
 * null, never a guess at something wider.
 */
function ownedProcessGroup(pid: number): number | null {
  const pgid = processGroupIdSync(pid);
  return pgid !== null && pgid === pid ? pgid : null;
}

/** The `kill(2)` argument reaching a target: a negative pid addresses a group. */
function supervisorKillArg(target: SupervisorTarget): number {
  return target.group === null ? target.pid : -target.group;
}

/**
 * Every live `lazy supervise` process working inside `root`, with the group each
 * one owns — snapshotted, because a group id cannot be recovered once its leader
 * is gone, and the escalation pass needs it after the SIGTERM killed exactly
 * that leader.
 */
export function findSupervisorTargetsForRoot(root: string): SupervisorTarget[] {
  return findSupervisorsForRoot(root).map(pid => ({ pid, group: ownedProcessGroup(pid) }));
}

/** Signal a supervisor and, when it owns a group, the agent it spawned. */
export function signalSupervisorTarget(target: SupervisorTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(supervisorKillArg(target), signal);
  } catch {
    // Already exited (ESRCH) — nothing to reap.
  }
}

/**
 * Is anything this target covers still RUNNING?
 *
 * "Any group member", not "the leader": the whole point is the agent that
 * outlives its supervisor, so answering on the leader alone would report the
 * reap finished while the process it exists to catch was still there.
 *
 * Zombies do not count. `kill(pid, 0)` succeeds against a process that has
 * exited and not yet been reaped, and this runs immediately after SIGTERMing a
 * whole process tree — so the children are, by construction, mid-exit at exactly
 * the moment they are counted. Treating them as alive made every teardown wait
 * out its full two seconds before a SIGKILL with nothing left to kill. Same rule
 * the runner applies to its own stop; `isRunningProcessSync` is the same helper.
 */
export function isSupervisorTargetAlive(target: SupervisorTarget): boolean {
  // `kill(-pgid, 0)` is the cheap "does this group exist at all" probe; only if
  // it says yes is it worth reading each member's state.
  try {
    process.kill(supervisorKillArg(target), 0);
  } catch {
    return false;
  }
  if (target.group === null) return isRunningProcessSync(target.pid);
  return membersOfGroup(target.group).some(isRunningProcessSync);
}

/**
 * Pids in `pgid`, read straight from the process table.
 *
 * Sync and self-contained for the same reason the rest of this module is: it is
 * reachable from an `exit` handler, where nothing may await.
 */
function membersOfGroup(pgid: number): number[] {
  const members: number[] = [];
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return [];
    }
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (Number.isNaN(pid)) continue;
      if (processGroupIdSync(pid) === pgid) members.push(pid);
    }
    return members;
  }
  const out = Bun.spawnSync(['ps', '-eo', 'pid=,pgid=']);
  if (out.exitCode !== 0) return [];
  for (const line of out.stdout.toString().split('\n')) {
    const [rawPid, rawPgid] = line.trim().split(/\s+/);
    const pid = parseInt(rawPid ?? '', 10);
    if (!Number.isNaN(pid) && parseInt(rawPgid ?? '', 10) === pgid) members.push(pid);
  }
  return members;
}

/**
 * Signal every `lazy supervise` process working inside `root` — and the agent
 * each one spawned — found by command line (supervisors have no registry of
 * their own the harness can read: the host-process runner's pidfiles live under
 * the SUPERVISOR's `$HOME/.lazy/run`, which a fakeClaude context deliberately
 * moves out of the test process's reach). Synchronous; safe from an `exit`
 * handler.
 *
 * Returns the supervisor pids it signalled.
 */
export function killSupervisorsForRoot(
  root: string,
  commands?: Map<number, string>,
  signal: NodeJS.Signals = 'SIGKILL',
): number[] {
  const killed: number[] = [];
  for (const [pid, cmd] of commands ?? readAllProcessCommands()) {
    if (pid === process.pid) continue;
    if (!isSupervisorCommandForRoot(cmd, root)) continue;
    const target: SupervisorTarget = { pid, group: ownedProcessGroup(pid) };
    if (!isSupervisorTargetAlive(target)) continue;
    signalSupervisorTarget(target, signal);
    killed.push(pid);
  }
  return killed;
}

/**
 * Does this command line belong to a lazy machine one-shot (`claude -p` spawned
 * by the host runner's one-shot path)?
 *
 * Keyed on lazy's OWN marker, which src/oneshot/args.ts stamps into every
 * one-shot prompt and therefore into its argv — the same structural signal the
 * capture sweep uses to know a session is housekeeping. A human's `claude -p`
 * never carries it, so this alone already excludes the developer's own runs; the
 * cwd tie below narrows it further to runs this test process owns.
 *
 * The `claude` binary itself is matched by BASENAME on any argv token, not by
 * argv[0]: the harness's fake agent is a shebang script, so /proc reports the
 * interpreter first (`bun /tmp/…/bin/claude -p …`).
 */
export function isMachineOneshotClaudeCommand(cmd: string): boolean {
  if (!cmd.includes(ONESHOT_MARKER_NONCE)) return false;
  const tokens = cmd.split(/\s+/);
  if (!tokens.includes('-p')) return false;
  return tokens.some(t => basename(t) === 'claude');
}

/** Is `dir` the directory `path`, or does it contain it? */
function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Working directory of each given pid. Synchronous, and best-effort: a platform
 * where neither mechanism works yields an empty map, which degrades the one-shot
 * sweep to a no-op rather than to a sweep that kills on the marker alone.
 *
 * Only ever called with the handful of pids that already matched the one-shot
 * marker, so the per-pid `lsof` on macOS stays cheap.
 */
function readProcessCwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        // A cwd whose directory was already removed reads back as
        // "/path/to/dir (deleted)" — exactly the case a leaked one-shot is in
        // after cleanup removed the temp root, so strip the suffix rather than
        // failing to match it.
        out.set(pid, readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''));
      } catch {
        // Process exited, or this process may not read its cwd link.
      }
    }
    return out;
  }
  try {
    // -Fpn prints machine-readable records: `p<pid>` then `n<path>` per fd.
    const result = Bun.spawnSync(['lsof', '-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    let current: number | null = null;
    for (const line of result.stdout.toString().split('\n')) {
      if (line.startsWith('p')) current = parseInt(line.slice(1), 10);
      else if (line.startsWith('n') && current !== null) out.set(current, line.slice(1));
    }
  } catch {
    // `lsof` missing or failed — documented no-op above.
  }
  return out;
}

/**
 * Pids of every live machine one-shot standing inside one of `dirs`. Exported so
 * a test can assert the absence of one after teardown — the leak this sweep
 * exists for.
 */
export function findOneshotClaudeUnderDirs(
  dirs: Iterable<string>,
  commands?: Map<number, string>,
): number[] {
  const dirList = [...dirs];
  if (dirList.length === 0) return [];
  const candidates: number[] = [];
  for (const [pid, cmd] of commands ?? readAllProcessCommands()) {
    if (pid === process.pid) continue;
    if (isMachineOneshotClaudeCommand(cmd)) candidates.push(pid);
  }
  if (candidates.length === 0) return [];
  const cwds = readProcessCwds(candidates);
  return candidates.filter(pid => {
    const cwd = cwds.get(pid);
    return cwd !== undefined && dirList.some(dir => isUnder(cwd, dir));
  });
}

/**
 * Signal every machine one-shot standing inside one of `dirs`. Synchronous; safe
 * from an `exit` handler. Returns the pids it signalled.
 */
export function killOneshotClaudeUnderDirs(
  dirs: Iterable<string>,
  commands?: Map<number, string>,
  signal: NodeJS.Signals = 'SIGKILL',
): number[] {
  const killed: number[] = [];
  for (const pid of findOneshotClaudeUnderDirs(dirs, commands)) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch {
      // Already exited (ESRCH) — nothing to reap.
    }
  }
  return killed;
}

/**
 * Read every live process's command line, keyed by pid. Synchronous on purpose:
 * the callers run inside `process.on('exit')`, where async work never completes.
 *
 * Linux reads /proc directly. Everything else (macOS) shells out to `ps` once.
 * A platform where neither works yields an empty map, which degrades this sweep
 * to a no-op — the pidfile path and the daemon's own parent watch still apply.
 */
function readAllProcessCommands(deadlineMs?: number): Map<number, string> {
  const out = new Map<number, string>();
  const overBudget = () => deadlineMs !== undefined && Date.now() > deadlineMs;
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      // No /proc (unusual for linux, but never worth crashing teardown over).
      return out;
    }
    for (const entry of entries) {
      if (overBudget()) break;
      const pid = parseInt(entry, 10);
      if (Number.isNaN(pid)) continue;
      try {
        // /proc/<pid>/cmdline is NUL-separated (and NUL-terminated).
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
        if (cmd.length > 0) out.set(pid, cmd);
      } catch {
        // Process exited between readdir and here, or it is a kernel thread.
      }
      const delay = sweepDelayPerProcMs();
      if (delay > 0) {
        const until = Date.now() + delay;
        while (Date.now() < until) { /* test-only busy wait */ }
      }
    }
    return out;
  }
  try {
    const result = Bun.spawnSync(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
    for (const line of result.stdout.toString().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) out.set(parseInt(m[1], 10), m[2].trim());
    }
  } catch {
    // `ps` missing or failed — sweep degrades to a no-op, as documented above.
  }
  return out;
}

/**
 * SIGKILL every lazy daemon process serving `root`, found by command line
 * rather than by pidfile. Synchronous; safe from an `exit` handler.
 *
 * Returns the pids it signalled, so callers (and tests) can tell whether the
 * pidfile path had already covered everything.
 */
export function killDaemonsForRoot(root: string, commands?: Map<number, string>): number[] {
  const killed: number[] = [];
  for (const [pid, cmd] of commands ?? readAllProcessCommands()) {
    if (pid === process.pid) continue;
    if (!isDaemonCommandForRoot(cmd, root)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already exited (ESRCH) — nothing to reap.
    }
  }
  return killed;
}

/**
 * Fast path: SIGKILL every daemon whose pidfile is still registered. No process-
 * table scan — safe to call from a SIGINT/SIGTERM handler where blocking on a
 * full /proc or `ps` sweep would make Ctrl-C feel dead on a busy machine.
 */
function reapRegisteredByPidfile(): void {
  for (const root of liveDaemonRoots) {
    const pid = readDaemonPid(root);
    if (pid === null) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited (ESRCH) — nothing to reap. Any other error here is not
      // actionable during process teardown; we have no way to surface it.
    }
  }
  liveDaemonRoots.clear();
}

/**
 * Command-line sweep: one bounded process-table scan, then kill every leaked
 * daemon/supervisor/one-shot this run owns. Uses whatever `commands` contains —
 * including a partial map when the scan hit its deadline — never discards it.
 */
function reapCommandLineSweep(deadlineMs: number): void {
  if (allTestRoots.size === 0 && allOneshotDirs.size === 0) return;
  const commands = readAllProcessCommands(deadlineMs);
  const scanEndedEarly = Date.now() > deadlineMs;
  const { swept, sweptSupervisors, sweptOneshots } = killFromCommandScan(commands);
  if (scanEndedEarly) {
    process.stderr.write('daemon-registry: process-table scan stopped early (budget exceeded)\n');
  }
  if (swept.length > 0) {
    process.stderr.write(
      `daemon-registry: swept ${swept.length} leaked test daemon(s) at exit: ${swept.join(', ')}\n`,
    );
  }
  if (sweptSupervisors.length > 0) {
    process.stderr.write(
      `daemon-registry: swept ${sweptSupervisors.length} leaked test supervisor(s) at exit: ` +
      `${sweptSupervisors.join(', ')}\n`,
    );
  }
  if (sweptOneshots.length > 0) {
    process.stderr.write(
      `daemon-registry: swept ${sweptOneshots.length} stranded machine one-shot(s) at exit: ` +
      `${sweptOneshots.join(', ')}\n`,
    );
  }
}

/**
 * Normal-exit path: pidfile reaping plus bounded command-line sweep. Runs from
 * `process.on('exit')` when the test process finishes cleanly.
 */
function reapAllTestDaemons(): void {
  reapRegisteredByPidfile();
  reapCommandLineSweep(Date.now() + EXIT_SWEEP_BUDGET_MS);
}

/** Shared kill pass after a process-table scan. */
function killFromCommandScan(commands: Map<number, string>): {
  swept: number[];
  sweptSupervisors: number[];
  sweptOneshots: number[];
} {
  const swept: number[] = [];
  const sweptSupervisors: number[] = [];
  const sweptOneshots = killOneshotClaudeUnderDirs([...allTestRoots, ...allOneshotDirs], commands);
  for (const root of allTestRoots) {
    swept.push(...killDaemonsForRoot(root, commands));
    sweptSupervisors.push(...killSupervisorsForRoot(root, commands));
  }
  return { swept, sweptSupervisors, sweptOneshots };
}

/**
 * Test-only: pre-fix unbounded reap (no scan deadline). Used by the A/B benchmark
 * subprocess to replicate the old double-sweep + process.exit(130) path.
 */
export function reapAllTestDaemonsUnboundedForBenchmark(): void {
  reapRegisteredByPidfile();
  if (allTestRoots.size === 0 && allOneshotDirs.size === 0) return;
  killFromCommandScan(readAllProcessCommands());
}

/**
 * Test-only: install the pre-fix SIGINT/exit handlers for A/B timing. The
 * subprocess must set LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL=1 before importing
 * this module, then call registerTestDaemonRoot, then this function.
 */
export function installOldHandlersForBenchmark(): void {
  process.on('exit', reapAllTestDaemonsUnboundedForBenchmark);
  process.on('SIGINT', () => {
    reapAllTestDaemonsUnboundedForBenchmark();
    process.exit(130);
  });
}

/**
 * Re-raise `signal` with default disposition after bounded cleanup.
 *
 * INVARIANT: never `process.exit()` from a signal handler — that bypasses the
 * signal's natural propagation and leaves foreground children holding the TTY.
 * On bun 1.4.0, re-raise kills by signal and `process.on('exit')` does NOT run,
 * so the bounded command-line sweep MUST happen here before re-raising — not in
 * the exit handler.
 */
function handleProcessSignal(signal: NodeJS.Signals): void {
  // Second Ctrl-C while the first handler runs: die immediately, no cleanup.
  if (interruptHandled) {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  interruptHandled = true;

  reapRegisteredByPidfile();
  reapCommandLineSweep(Date.now() + EXIT_SWEEP_BUDGET_MS);

  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  process.kill(process.pid, signal);
}

function onSigint(): void {
  handleProcessSignal('SIGINT');
}

function onSigterm(): void {
  handleProcessSignal('SIGTERM');
}

/**
 * Install the process-death safety net exactly once. Idempotent: safe to call
 * from both the preload and `setup.ts` regardless of import order.
 */
function ensureHandlersInstalled(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Normal exit and most uncaught-exception exits. Synchronous only.
  process.on('exit', reapAllTestDaemons);

  // Ctrl-C / external kill: bounded reaping in-handler, then re-raise. The exit
  // handler above covers normal completion only — it does not run on signal death.
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
}

/**
 * Record a test project root whose daemon must be reaped if `afterEach` is
 * skipped. Call once per `setupTestLazy`, regardless of whether the daemon is
 * started explicitly (`withDaemon`) or auto-started later by a CLI call.
 */
export function registerTestDaemonRoot(root: string): void {
  ensureHandlersInstalled();
  liveDaemonRoots.add(root);
  allTestRoots.add(root);
}

/**
 * Record a directory that a machine one-shot spawned by this run could be
 * standing in (the context's `LAZY_ONESHOT_BASE_DIR`). Project roots are already
 * covered by `registerTestDaemonRoot`; this exists because the fidelity
 * summarizer deliberately runs its agent OUTSIDE the project.
 */
export function registerTestOneshotDir(dir: string): void {
  ensureHandlersInstalled();
  allOneshotDirs.add(dir);
}

/** Stop tracking a root once its daemon has been gracefully stopped + cleaned. */
export function unregisterTestDaemonRoot(root: string): void {
  liveDaemonRoots.delete(root);
}

// Install handlers on import so the net is armed the moment any test module —
// or the global preload — loads this file, even before the first daemon spawns.
// Benchmark subprocesses set LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL=1 to install
// handlers themselves (old vs new A/B timing).
if (process.env.LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL !== '1') {
  ensureHandlersInstalled();
}
