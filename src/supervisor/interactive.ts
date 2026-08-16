/**
 * Interactive-session supervisor — the wrapper `lazy pair` and `lazy chat` run
 * Claude Code under.
 *
 * WHAT THIS IS
 * ------------
 * `lazy pair` and `lazy chat` used to spawn Claude Code directly and block on
 * it. That made an interactive session the one child of the daemon with nobody
 * watching it: a daemon restart moved the audit proxy to a new OS-assigned port,
 * and the session kept talking to the old one until the human noticed every
 * model call failing. It also made the session invisible to `lazy upgrade`,
 * which discovers children by container name and so stopped every builder and
 * agent while leaving the interactive session running against an address it had
 * just invalidated.
 *
 * So both commands now start THIS first, and this runs Claude Code — the same
 * relationship `runBuilderSupervisor` has with the builder's Claude Code, but as
 * a host process rather than inside a container. It is deliberately shaped after
 * that supervisor (register → launch → watch → stop cleanly → resume in place)
 * rather than being a second, differently-shaped thing to maintain.
 *
 * ONE SUPERVISOR, TWO SURFACES
 * ----------------------------
 * The surfaces differ only in what argv Claude Code is handed and what the human
 * is told, so they are DATA on the config (`kind`, `extraArgs`, `extraEnv`), not
 * branches in the loop. `interactiveClaudeArgs` stays pure and the restart
 * machinery has exactly one implementation: a second copy of it is precisely how
 * `lazy chat` came to be missing the fix `lazy pair` got.
 *
 * THE TERMINAL BELONGS TO CLAUDE CODE
 * -----------------------------------
 * These sessions are interactive, so the supervisor must be invisible while the
 * session runs:
 *
 *  - stdio is INHERITED, never piped. Nothing here reads, wraps, buffers or
 *    re-emits the child's output, so the TUI, colours, mouse reporting and
 *    alternate-screen handling are exactly as if lazy had exec'd Claude Code.
 *  - Nothing is printed while the child holds the terminal. A restart notice
 *    mid-session would land in the middle of a redraw and corrupt the TUI, so
 *    the stop happens silently and the explanation is printed only once the
 *    child has released the screen. That explanation is not skipped — it is the
 *    same notice, at the same point in the lifecycle, that
 *    src/builder/relaunch.ts prints for a builder. The ONE exception is a child
 *    that ignores SIGTERM: after the grace period we break the silence on
 *    stderr, because a session that looks hung costs more than a redraw.
 *  - Ctrl-C and SIGWINCH reach Claude Code from the kernel: it shares this
 *    process's controlling terminal and foreground process group. The
 *    supervisor installs a NO-OP SIGINT handler purely so it does not die of
 *    the same keystroke — Claude Code treats Ctrl-C as "interrupt the turn",
 *    and the supervisor exiting there would strand the pairing lock and leave
 *    the task in `pairing` forever.
 *  - SIGTERM is FORWARDED to the child and then honoured: an external stop
 *    (`lazy upgrade`, an operator) means end the session, not resume it.
 *
 * RESUME IS AUTOMATIC, IN PLACE
 * -----------------------------
 * When the daemon generation changes, the child is stopped with SIGTERM and a
 * grace period (never SIGKILL) and then relaunched with `--resume <sessionId>`
 * into the SAME terminal, against a freshly-resolved proxy address.
 *
 * The alternative — tell the human to re-run the command — was rejected because
 * everything that makes a resume awkward elsewhere is already true here and
 * already handled: the human is sitting at this terminal; the pairing lock and
 * the task's `pairing` status are held by THIS process for the whole session, so
 * an in-place relaunch re-acquires nothing and races nothing; and the session id
 * is recoverable from the JSONL files on this host without the dead child's
 * cooperation. Making the human retype the command would discard the worktree
 * and task context for no gain.
 *
 * The launch environment is re-resolved from scratch on every relaunch, through
 * the same `resolveInteractiveLaunch` seam as the first launch. That is the
 * whole point: the proxy address is the value that went stale, and re-resolving
 * it is the fix. If it cannot be resolved, the supervisor FAILS rather than
 * relaunching into a dead endpoint — a child that cannot reach the audit plane
 * must never fall back to talking to Anthropic directly.
 */

import { join } from 'path';
import { checkDaemonHealth, type DaemonStatus } from '../daemon/lifecycle';
import { watchDaemonGeneration } from '../daemon/generation';
import {
  registerInteractiveSession,
  unregisterInteractiveSession,
  type InteractiveSessionKind,
} from '../daemon/interactive-registry';
import { resolveInteractiveLaunch, launchEnvOverlay } from '../cli/interactive-auth';
import { discoverProjectSessionFiles } from '../import/claude-code-logs';
import { excludeMachineOneshots } from '../import/machine-oneshot';
import { pickLaunchSessionId } from '../builder/session-detect';
import { getHome } from '../utils/home';
import { spawn } from '../utils/spawn';

/**
 * How long the child gets to exit after SIGTERM before the supervisor stops
 * waiting quietly and tells the human what is going on.
 *
 * Nothing is escalated when it elapses. SIGKILL would take the session's
 * unsaved state with it, and the whole point of stopping is to hand the session
 * back intact — so the grace period bounds our SILENCE, not the child's life.
 */
export const INTERACTIVE_STOP_GRACE_MS = 10_000;

/** Attempts made to read a usable generation baseline before giving up. */
const BASELINE_READ_ATTEMPTS = 3;
/** Delay between baseline read attempts (ms). */
const BASELINE_RETRY_MS = 200;

export interface InteractiveSupervisorConfig {
  /** Which surface is running: names the launch, the registry entry and the hints. */
  kind: InteractiveSessionKind;
  /** Absolute project root — names the daemon dir and the interactive launch. */
  root: string;
  /** Directory Claude Code runs in: the worktree in task mode, else cwd. */
  cwd: string;
  /** Task short id when the session is bound to a task; absent when branchless. */
  taskId?: string;
  /** Session to resume on the FIRST launch (`--resume`), if any. */
  resumeSessionId?: string | null;
  /** Pass `--dangerously-skip-permissions` to Claude Code. */
  autonomous?: boolean;
  /** Surface-specific argv appended after the standard flags (e.g. chat's lockdown). */
  extraArgs?: string[];
  /** Extra env for the child (e.g. `LAZY_TASK`). Never carries credentials. */
  extraEnv?: Record<string, string>;
  /** Where human-facing lines go. Only ever called when no child holds the tty. */
  log?: (msg: string) => void;
  /** Where actionable failures go. Same timing rule as `log`. */
  errorOut?: (msg: string) => void;
  /** Daemon status reader (injectable for tests). */
  readStatus?: (projectRoot: string) => Promise<DaemonStatus>;
  /** Generation poll cadence (ms). Injectable for tests. */
  generationPollMs?: number;
  /** Grace period after SIGTERM before we say something (ms). */
  stopGraceMs?: number;
}

export interface InteractiveSupervisorResult {
  /** Exit code of the last Claude Code launch. */
  exitCode: number;
  /** Best-known session id of the last launch, or null. */
  sessionId: string | null;
  /** How many times the session was relaunched because the daemon restarted. */
  restarts: number;
}

/** The command a human typed to get here, for messages and hints. */
function commandName(kind: InteractiveSessionKind): string {
  return kind === 'chat' ? 'lazy chat' : 'lazy pair';
}

/**
 * Best-effort detection of the Claude session a just-exited launch was running,
 * from the JSONL files on this host.
 *
 * Same evidence and same rule as the builder's host-side detection: Claude
 * writes `<projects>/<encoded-cwd>/<sessionId>.jsonl` while the session runs, so
 * whatever ended the child, the file is still there. Recovery, not stamping —
 * it needs no cooperation from the process that died.
 *
 * NEVER throws: on the stop path the only thing worse than not knowing the id is
 * turning a clean stop into a crash.
 */
export async function detectInteractiveSessionId(opts: {
  cwd: string;
  launchedAtMs: number;
  resumeId: string | null;
  homeDirAbs?: string;
}): Promise<string | null> {
  const { cwd, launchedAtMs, resumeId, homeDirAbs = getHome() } = opts;
  try {
    // Exclude lazy's own machine one-shots: they land in this same shared dir
    // (runClaudeOneshot inherits the daemon's cwd) and would otherwise be picked
    // as "the newest session this launch owns" — see excludeMachineOneshots.
    const files = await excludeMachineOneshots(
      await discoverProjectSessionFiles(cwd, join(homeDirAbs, '.claude', 'projects')),
    );
    return pickLaunchSessionId(files, launchedAtMs, resumeId);
  } catch {
    // Unreadable projects dir — fall back to what we launched with.
    return resumeId;
  }
}

/** Build the Claude Code argv for one launch. Pure, so it is testable. */
export function interactiveClaudeArgs(opts: {
  resumeSessionId?: string | null;
  autonomous?: boolean;
  extraArgs?: string[];
  model?: string;
}): string[] {
  const args = ['claude'];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.autonomous) args.push('--dangerously-skip-permissions');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/**
 * Read the generation baseline to compare later polls against.
 *
 * Returns `undefined` — meaning UNKNOWN — rather than inventing a reading, if
 * the daemon cannot be read as running. This is load-bearing: a transient probe
 * failure recorded as "no daemon was running" makes the very next healthy
 * reading look like a restart, and the supervisor would SIGTERM a perfectly
 * healthy interactive session out from under the human. An UNKNOWN baseline
 * makes the watch establish its own on the first poll that succeeds, so the
 * worst case is a missed restart rather than a fabricated one — and a spurious
 * restart is the worse failure here, because somebody is sitting at the
 * terminal watching it happen.
 */
async function readGenerationBaseline(
  root: string,
  readStatus: (projectRoot: string) => Promise<DaemonStatus>,
): Promise<DaemonStatus | undefined> {
  for (let attempt = 0; attempt < BASELINE_READ_ATTEMPTS; attempt++) {
    try {
      const status = await readStatus(root);
      if (status.running) return status;
    } catch {
      // Probe failed — indistinguishable from "momentarily down". Retry.
    }
    if (attempt < BASELINE_READ_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, BASELINE_RETRY_MS));
    }
  }
  return undefined;
}

/**
 * Run an interactive session under supervision. Blocks until the human ends it
 * (or an external SIGTERM does), relaunching in place across daemon restarts.
 */
export async function runInteractiveSupervisor(
  config: InteractiveSupervisorConfig,
): Promise<InteractiveSupervisorResult> {
  const {
    kind,
    root,
    cwd,
    taskId,
    autonomous,
    extraArgs = [],
    extraEnv = {},
    log = (m: string) => console.log(m),
    errorOut = (m: string) => console.error(m),
    readStatus = checkDaemonHealth,
    generationPollMs,
    stopGraceMs = INTERACTIVE_STOP_GRACE_MS,
  } = config;

  const command = commandName(kind);
  await registerInteractiveSession(root, { kind, cwd, ...(taskId ? { taskId } : {}) });

  // Signals. Installed for the supervisor's whole lifetime, not per launch, so
  // there is no window where a keystroke kills the wrapper mid-relaunch.
  let child: ReturnType<typeof spawn> | null = null;
  /** Set when an EXTERNAL stop arrived — that ends the session, never resumes. */
  let externallyStopped = false;

  // No-op: Claude Code receives Ctrl-C from the terminal on its own. The handler
  // exists only to stop the default disposition from killing this process, which
  // would strand the pairing lock and the task's `pairing` status.
  const onSigint = () => { /* delivered to the child by the tty; nothing to do */ };
  const onSigterm = () => {
    externallyStopped = true;
    // Forward rather than exit: the child owns unsaved state and the terminal.
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let resumeId = config.resumeSessionId ?? null;
  let restarts = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Resolve the launch target and env FRESH every iteration. On the first
      // pass this is the ordinary launch path; on a relaunch it is the fix —
      // the proxy address is the value that went stale.
      let target, envVars;
      try {
        ({ target, envVars } = await resolveInteractiveLaunch(root, command));
      } catch (err) {
        if (restarts === 0) throw err; // First launch: caller reports it as today.
        const msg = err instanceof Error ? err.message : String(err);
        errorOut('');
        errorOut(`The daemon restarted, but the ${kind} session was NOT resumed: lazy could not`);
        errorOut("resolve the restarted daemon's launch target for the new session.");
        errorOut('');
        errorOut(msg);
        errorOut('');
        errorOut('Resuming anyway would point Claude Code at a dead endpoint and every model');
        errorOut('call would fail, so lazy stopped instead.');
        errorOut(kind === 'chat'
          ? `Resume it once the daemon is healthy:  ${command}${taskId ? ` ${taskId}` : ''}`
          : resumeId
            ? `Resume it once the daemon is healthy:  ${command}${taskId ? ` ${taskId}` : ''} --resume ${resumeId}`
            : `Resume it once the daemon is healthy:  ${command}${taskId ? ` ${taskId}` : ''}`);
        return { exitCode: 1, sessionId: resumeId, restarts };
      }

      // Baseline taken immediately before the launch, so the window in which a
      // restart could be missed is as small as it can be made. UNKNOWN when the
      // daemon cannot be read as running — see readGenerationBaseline.
      const baseline = await readGenerationBaseline(root, readStatus);

      const launchedAtMs = Date.now();
      child = spawn(
        interactiveClaudeArgs({ resumeSessionId: resumeId, autonomous, extraArgs, model: target.model }),
        {
          cwd,
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
          // Long-running: the session ends when the human ends it.
          timeout: 0,
          env: { ...process.env, ...launchEnvOverlay(envVars), ...extraEnv },
        },
      );

      // Async spawn + await (never spawnSync) so the event loop keeps turning:
      // the generation watch below is a timer, and the command may have
      // auto-started the daemon as a CHILD of this process, which the runtime
      // can only reap while the loop runs.
      let restartDetected = false;
      let stopNoticeTimer: ReturnType<typeof setTimeout> | null = null;
      const watch = watchDaemonGeneration({
        projectRoot: root,
        ...(baseline ? { baseline } : {}),
        readStatus,
        ...(generationPollMs ? { intervalMs: generationPollMs } : {}),
        onRestart: () => {
          restartDetected = true;
          // Silence is deliberate: the child still owns the screen. SIGTERM
          // only — never SIGKILL, which would take unsaved session state with
          // it. If the child is still up after the grace period we say so, but
          // we keep waiting rather than escalating.
          try { child?.kill('SIGTERM'); } catch { /* already gone */ }
          stopNoticeTimer = setTimeout(() => {
            errorOut('');
            errorOut('The lazy daemon restarted, so this session is talking to an audit proxy that');
            errorOut('no longer exists. Claude Code was asked to exit and has not yet; quit it');
            errorOut('(`/exit`) and lazy will resume the conversation against the new daemon.');
          }, stopGraceMs);
          stopNoticeTimer.unref?.();
        },
      });

      const exitCode = await child.exited;
      watch.stop();
      if (stopNoticeTimer) clearTimeout(stopNoticeTimer);
      child = null;

      const sessionId = await detectInteractiveSessionId({ cwd, launchedAtMs, resumeId });

      if (!restartDetected || externallyStopped) {
        // Ordinary end of the session (or an external stop that means "end it").
        return { exitCode, sessionId, restarts };
      }

      restarts += 1;
      resumeId = sessionId;
      log('');
      log('The lazy daemon restarted, which invalidated this session\'s connection to its');
      log('audit proxy, so lazy stopped Claude Code rather than let every model call fail.');
      if (resumeId) {
        log(`Resuming the conversation (${resumeId.substring(0, 8)}) against the new daemon...`);
      } else {
        // Session detection failed. Relaunching without `--resume` is still the
        // right move — the human keeps their terminal and their task context —
        // but say plainly that the transcript did not come with it.
        log('Starting a fresh session against the new daemon — lazy could not determine which');
        log('conversation was running, so this one starts empty.');
      }
      log('');
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await unregisterInteractiveSession(root);
  }
}
