/**
 * Stop the AGENT in a task's container, never the container.
 *
 * A daemon restart (upgrade, crash, a fleet roll) invalidates the running
 * agent — its proxy address and in-flight turn belong to the previous daemon
 * — but nothing else in the task's container: the services in its tmux
 * sessions, whatever a person started in it, everything built or installed
 * outside the worktree. Killing the container threw all of that away on every
 * restart. So the restart reaper and the shutdown sweep stop only the
 * supervisor and the processes it started (the agent, its tools, its MCP
 * server), and the container's PID-1 wrapper starts a fresh supervisor, which
 * waits for the next command. That is exactly how builders already survive.
 *
 * THE HANDSHAKE WITH THE WRAPPER. The wrapper restarts its supervisor after
 * failed and stopped turns too, publishing a correlated error receipt on a
 * crash and backing off repeated failures without ending the environment.
 * A supervisor ended on PURPOSE for a daemon restart needs neither a crash
 * receipt nor backoff: this script writes {@link AGENT_RESTART_MARKER} naming
 * that supervisor before signalling. The wrapper consumes the marker and
 * restarts immediately only when the pid matches; a stale marker cannot hide
 * a later crash. Older wrappers that do not know the marker may still exit;
 * the next launch starts their stopped container in place when supported,
 * otherwise recreates it.
 *
 * WHAT IS STOPPED: the supervisor and every process DESCENDED from it,
 * TERM then KILL after the grace. A process the agent started and detached
 * (reparented to the container's init) is not a descendant and keeps running
 * — the same rule as between turns, where the wrapper kills nothing
 * (remove-reaper-cap-sweep). The tmux server is not a descendant either: the
 * daemon starts it with `docker exec`, and it daemonizes.
 */

/**
 * The label a task container carries when it was created to be KEPT: its
 * wrapper restarts a supervisor the daemon stopped on purpose, so a daemon
 * restart stops only the agent, and a stopped container may be started again
 * in place rather than recreated.
 */
export const KEPT_CONTAINER_LABEL = 'lazy.kept';

/** How long a stopped agent gets between TERM and KILL when the caller names no grace. */
export const AGENT_STOP_DEFAULT_GRACE_SECONDS = 10;

/** Written before the supervisor is signalled; tells the wrapper to restart it. */
export const AGENT_RESTART_MARKER = '/tmp/lazy-agent-restart';

/** The supervisor's pid, written by the wrapper for each supervisor it starts. */
export const SUPERVISOR_PID_FILE = '/tmp/lazy-supervisor.pid';

/** How long the script waits for a current wrapper to write the pid file, when it is not there yet. */
export const PID_FILE_WAIT_SECONDS = 3;

/**
 * The in-container script. `$1` is the grace in seconds. Prints `stopped`
 * when it ended a supervisor, `none` when there was none to end.
 *
 * The supervisor is found by the wrapper's pid file. A wrapper that writes one
 * (its command line names the file) may be between two supervisors, so when
 * the file is missing the script WAITS for it ({@link PID_FILE_WAIT_SECONDS})
 * rather than guessing; still none means no supervisor is running.
 *
 * Only a container whose wrapper predates the pid file is scanned, and the scan
 * selects a process whose argv[0] IS `lazy-agent` and whose command line has
 * `--one-shot` and `--protocol-dir`. Matching the command line alone selected
 * the wrapper's own `sh -c` — its script text holds the same words — and the
 * wrapper's descendants are the supervisor AND everything else in the
 * container it started. The scan skips the script's own pid too.
 */
export function stopAgentScript(opts: {
  /**
   * A `case` glob the scanned command line must ALSO match. Tests narrow it to
   * their own stand-in: run anywhere else (an agent's own container), the scan
   * would find — and stop — that agent's supervisor.
   */
  commandMatch?: string;
  /** Seconds to wait for a current wrapper's pid file; defaults to {@link PID_FILE_WAIT_SECONDS}. */
  pidFileWaitSeconds?: number;
} = {}): string {
  const match = opts.commandMatch ?? '*';
  const wait = Math.max(0, Math.floor((opts.pidFileWaitSeconds ?? PID_FILE_WAIT_SECONDS) * 10));
  return [
    `m=${AGENT_RESTART_MARKER}; pf=${SUPERVISOR_PID_FILE}; grace=\${1:-10}`,
    'live_pf() { sup=; [ -s "$pf" ] && sup=$(cat "$pf"); [ -n "$sup" ] && ! kill -0 "$sup" 2>/dev/null && sup=; [ -n "$sup" ]; }',
    'live_pf',
    // A current wrapper names the pid file in its own command line.
    'if [ -z "$sup" ]; then current=; for d in /proc/[0-9]*; do [ "${d#/proc/}" = "$$" ] && continue;' +
      ' c=$(tr \'\\0\' \' \' < "$d/cmdline" 2>/dev/null); case "$c" in *"$pf"*) current=1; break;; esac; done',
    `  if [ -n "$current" ]; then i=0; while [ $i -lt ${wait} ] && ! live_pf; do sleep 0.1; i=$((i+1)); done`,
    // An older wrapper: the supervisor by argv[0], never the wrapper's `sh -c`.
    '  else for d in /proc/[0-9]*; do [ "${d#/proc/}" = "$$" ] && continue;' +
      ' a0=$(tr \'\\0\' \'\\n\' < "$d/cmdline" 2>/dev/null | head -n 1); [ "${a0##*/}" = lazy-agent ] || continue;' +
      ' c=$(tr \'\\0\' \' \' < "$d/cmdline" 2>/dev/null);' +
      ` case "$c" in *--one-shot*--protocol-dir*) case "$c" in ${match}) sup=\${d#/proc/}; break;; esac;; esac; done; fi; fi`,
    '[ -n "$sup" ] || { echo none; exit 0; }',
    // Every (pid, ppid) once, then the supervisor's descendants breadth-first.
    // /proc/<pid>/stat is `pid (comm) state ppid …`; comm may hold spaces, so
    // cut at the LAST `) `.
    'all=$(for d in /proc/[0-9]*; do read -r st < "$d/stat" 2>/dev/null || continue; rest=${st##*) }; set -- $rest; echo "${d#/proc/} $2"; done)',
    'tree=$sup; frontier=$sup',
    'while [ -n "$frontier" ]; do next=; for p in $frontier; do',
    '  next="$next $(printf \'%s\\n\' "$all" | while read -r c pp; do [ "$pp" = "$p" ] && printf \'%s \' "$c"; done)"',
    'done; frontier=$(echo $next); tree="$tree $frontier"; done',
    // The marker names the supervisor it is for: the wrapper restarts only on its own pid.
    'echo "$sup" > "$m"',
    'kill -TERM $tree 2>/dev/null',
    'i=0; while [ $i -lt $((grace * 10)) ]; do alive=0; for p in $tree; do kill -0 "$p" 2>/dev/null && alive=1; done;' +
      ' [ $alive = 0 ] && break; sleep 0.1; i=$((i+1)); done',
    'kill -KILL $tree 2>/dev/null',
    'echo stopped',
  ].join('\n');
}

/** What {@link stopAgentScript} reported, or `failed` when it could not run. */
export type AgentStopOutcome = 'stopped' | 'none' | 'failed';

/** Read the script's answer off its stdout. */
export function parseAgentStop(exitCode: number | null, stdout: string): AgentStopOutcome {
  if (exitCode !== 0) return 'failed';
  const last = stdout.trim().split('\n').pop()?.trim();
  return last === 'stopped' ? 'stopped' : last === 'none' ? 'none' : 'failed';
}

/**
 * Stop the agent in a task's run, keeping the run. Falls back to stopping the
 * whole run when the runner cannot stop just the agent (the host-process
 * runner, whose run IS the agent) or when the in-container stop failed — the
 * guarantee every caller relies on is that the previous agent no longer runs,
 * and a kept container is the courtesy, not the guarantee.
 *
 * Returns true when no agent from before the call is left running.
 */
export async function stopTaskAgent(
  runner: {
    stopRun(runName: string, opts?: { gracefulTimeoutSeconds?: number }): Promise<boolean>;
    stopAgentInRun?(runName: string, opts?: { gracefulTimeoutSeconds?: number }): Promise<AgentStopOutcome>;
  },
  runName: string,
  opts: {
    gracefulTimeoutSeconds?: number;
    /**
     * What the fallback {@link stopRun} is given, when it differs from the
     * agent stop's grace: `null` gives it no options at all — the shutdown
     * sweep keeps Docker's fallback on its immediate `docker kill`. Absent
     * means the same grace as the agent stop.
     */
    fallback?: { gracefulTimeoutSeconds?: number } | null;
  } = {},
): Promise<{ ok: boolean; keptRun: boolean }> {
  const { fallback, ...agentOpts } = opts;
  if (runner.stopAgentInRun) {
    const outcome = await runner.stopAgentInRun(runName, agentOpts);
    if (outcome !== 'failed') return { ok: true, keptRun: true };
  }
  const fallbackOpts = fallback === undefined ? agentOpts : (fallback ?? undefined);
  return { ok: await runner.stopRun(runName, fallbackOpts), keptRun: false };
}
