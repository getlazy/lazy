/**
 * Daemon generation — "is the daemon answering me the same process that
 * launched my child?"
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit/policy proxy runs IN-PROCESS with the daemon and its port is
 * OS-assigned by default (`[proxy] port` is optional, and omitting it is the
 * recommended setting because a fixed port collides across per-project
 * daemons). Every launch surface resolves that address exactly once and bakes
 * it into the child's environment as `ANTHROPIC_BASE_URL` — Claude Code reads
 * it at startup and will never re-read it, on a 401 or otherwise. So the moment
 * the daemon restarts, every already-running child is pointed at a dead port
 * for the rest of its life, and nothing notices.
 *
 * A daemon restart is therefore a LIFECYCLE EVENT that invalidates every child
 * the previous daemon launched. This module is the shared signal for detecting
 * it. Nothing here decides what to do about it — see src/daemon/restart-reaper.ts
 * (task agents and builders, stopped by the new daemon at startup) and
 * src/supervisor/interactive.ts (pair sessions, which supervise themselves because
 * only the host side can resume an interactive terminal).
 *
 * WHY AN EXPLICIT INSTANCE ID
 * ---------------------------
 * The signal has to answer "different process?", and the alternatives all
 * answer something else:
 *
 *  - **`daemon.lock` (flock)** is the authoritative LIVENESS signal
 *    (src/daemon/process-identity.ts) and was the first place to look. It
 *    cannot answer this question: the lock file is the same file across
 *    generations, so "held" says a daemon is running, never WHICH one. Live
 *    and live-but-restarted look identical.
 *  - **`uptime` going backwards** is what the builder relaunch loop had to make
 *    do with. It is a heuristic: it only fires if a poll happens to straddle
 *    the restart, and a fast restart-plus-drift can read as monotonic.
 *  - **pid** is recycled by the OS, and a restart can legitimately land on the
 *    same number.
 *  - **buildTime / version** do not change at all on a crash-restart, or on any
 *    restart from source (`buildTime` is `'dev'` there).
 *
 * A random id minted once per process start is exact, is free to compute, and
 * costs one string on an already-BOUNDED status route. A crash-restart and a
 * deliberate restart produce the same answer, which is correct: the port is
 * equally dead either way, so nothing here tries to tell them apart.
 *
 * Readings from a daemon that predates `instanceId` fall back to the old
 * heuristics rather than reporting "no change" — during an upgrade the two
 * sides are, by definition, different versions.
 */

import { checkDaemonHealth, type DaemonStatus } from './lifecycle';

/**
 * Did these two readings come from different daemon processes?
 *
 * Only ever asked of a reading where `current.running` is true — a daemon that
 * is momentarily down has not been replaced yet, and callers that treat "down"
 * as a change would act on a restart that has not happened.
 */
export function generationChanged(baseline: DaemonStatus, current: DaemonStatus): boolean {
  if (!current.running) return false;
  // Baseline was taken while no daemon was running → any live daemon is new.
  if (!baseline.running) return true;

  // Exact signal when both ends have it.
  if (baseline.instanceId && current.instanceId) {
    return baseline.instanceId !== current.instanceId;
  }

  // Legacy fallback: one side predates instanceId (mid-upgrade, mixed
  // versions). These are heuristics — see the header — but a missing id is
  // itself evidence the two sides differ, so erring toward "changed" here is
  // the safe direction: it costs a stop+resume, where a missed restart costs
  // the child every model call it makes from then on.
  const buildTimeChanged =
    !!baseline.buildTime && !!current.buildTime && current.buildTime !== baseline.buildTime;
  const pidChanged = !!baseline.pid && !!current.pid && current.pid !== baseline.pid;
  const uptimeReset =
    typeof baseline.uptime === 'number' &&
    typeof current.uptime === 'number' &&
    current.uptime < baseline.uptime;
  const idAppeared = !baseline.instanceId && !!current.instanceId;
  return buildTimeChanged || pidChanged || uptimeReset || idAppeared;
}

/** Default poll cadence for a generation watch. */
export const DEFAULT_GENERATION_POLL_MS = 2000;

export interface GenerationWatchOptions {
  /** Absolute project root whose daemon is being watched. */
  projectRoot: string;
  /**
   * Generation to compare against. Pass the reading taken when the child was
   * launched; omit to have the watch take its own baseline on the first poll.
   */
  baseline?: DaemonStatus;
  /** Poll cadence (default {@link DEFAULT_GENERATION_POLL_MS}). */
  intervalMs?: number;
  /**
   * Fired exactly once, when a DIFFERENT daemon is observed running.
   *
   * Deliberately not fired when the daemon merely goes away: the child is
   * already dead in the water at that point, but stopping it then would strand
   * it with nowhere to resume to. Waiting for the replacement means the moment
   * we act is the first moment a resume can actually succeed.
   */
  onRestart: (current: DaemonStatus, baseline: DaemonStatus) => void | Promise<void>;
  /** Status reader (injectable for tests). */
  readStatus?: (projectRoot: string) => Promise<DaemonStatus>;
}

export interface GenerationWatch {
  /** Stop polling. Idempotent; safe to call from a signal handler. */
  stop(): void;
}

/**
 * Poll the daemon until its generation changes, then fire `onRestart` once and
 * stop. Errors from the reader are swallowed on purpose — a status probe that
 * fails is indistinguishable from "daemon momentarily down", which is not an
 * event; the next poll decides.
 */
export function watchDaemonGeneration(opts: GenerationWatchOptions): GenerationWatch {
  const {
    projectRoot,
    intervalMs = DEFAULT_GENERATION_POLL_MS,
    onRestart,
    readStatus = checkDaemonHealth,
  } = opts;

  let baseline = opts.baseline;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const current = await readStatus(projectRoot);
      if (!baseline) {
        // First reading establishes the baseline. A daemon that is down right
        // now is a legitimate baseline: whatever comes up next is new.
        baseline = current;
      } else if (generationChanged(baseline, current)) {
        stop();
        await onRestart(current, baseline);
        return;
      }
    } catch {
      // Unreachable daemon is not an event — see the doc comment.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  // Never hold the process open on account of the watch alone.
  timer.unref?.();
  return { stop };
}
