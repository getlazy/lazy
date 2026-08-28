/**
 * Liveness-aware wait for a supervisor's protocol response.
 *
 * The daemon runs two turns SYNCHRONOUSLY — `ask` and `pre_accept` — by writing
 * a command into the protocol dir, launching (or reusing) the supervisor run,
 * and polling for `response.json`. A bare `waitForResponse` poll only ever asks
 * "has the response appeared yet?", so a supervisor that dies before writing one
 * — crash at startup, a broken image, an OOM kill, `docker kill`, or a run that
 * was never launched because a stale `isRunning` said one was already up —
 * leaves the daemon polling a directory nothing will ever write to, until the
 * whole timeout expires. For pre-accept that is `watchdog_output_timeout_ms + 5m`
 * (~35 minutes by default): `lazy accept` sits on a spinner while nothing at all
 * is running. This helper closes that gap for both call sites.
 *
 * Two graces make the check safe rather than merely fast:
 *
 *   - STARTUP grace. A freshly launched run is not necessarily visible to
 *     `isRunning` the instant `launchSupervisor` returns (the docker CLI has
 *     returned but the container may not be reported running yet; the host
 *     runner has to write its pidfile). Liveness is not consulted at all until
 *     this has elapsed, so a slow start is never mistaken for a death.
 *
 *   - DEATH grace. The supervisor legitimately writes `response.json` and THEN
 *     exits, so "not running" and "response present" is the normal successful
 *     ending, observed in either order depending on poll timing. A run seen gone
 *     is therefore only reported dead if no response has appeared after this
 *     much longer of polling — the race resolves in favour of the response.
 *
 * The response poll keeps running at full rate throughout; the liveness probe
 * (a `docker inspect` or a `kill(pid, 0)`) runs on its own slower cadence so a
 * long turn does not spawn a probe every 500ms.
 */

import type { Runner } from '../runner/types';
import { readResponse } from '../protocol';
import type { Response } from '../protocol';
import { logger } from '../utils/logger';

/** How long after the wait starts before liveness is consulted at all. */
export const SUPERVISOR_STARTUP_GRACE_MS = 15_000;

/**
 * How long a run may be observed gone, with no response, before it is declared
 * dead. Covers the write-response-then-exit race in the normal direction.
 */
export const SUPERVISOR_DEATH_GRACE_MS = 5_000;

/** Cadence of the liveness probe itself (independent of the response poll). */
export const SUPERVISOR_LIVENESS_INTERVAL_MS = 2_000;

export type SupervisorWaitOutcome =
  /** The supervisor answered. */
  | { kind: 'response'; response: Response }
  /** The full timeout elapsed with the supervisor still alive (or unprobeable). */
  | { kind: 'timeout' }
  /**
   * The run is gone and no response arrived within the death grace. `diagnostics`
   * is a short human-readable tail (exit code / last log lines) when the runner
   * could supply one, else null — it is best-effort context for an error
   * message, never a control signal.
   */
  | { kind: 'dead'; diagnostics: string | null };

/** Generic form of {@link SupervisorWaitOutcome} — see {@link waitForSupervisorAnswer}. */
export type SupervisorAnswerOutcome<T> =
  | { kind: 'answer'; answer: T }
  | { kind: 'timeout' }
  | { kind: 'dead'; diagnostics: string | null };

export interface WaitForSupervisorAnswerOptions<T> {
  /**
   * "Has my answer arrived?" — returns the answer, or null to keep waiting.
   *
   * Injected because WHERE the answer comes from differs by caller while the
   * liveness logic around it does not. The reconciler is the single reader of
   * `response.json`; a synchronous turn therefore polls the in-flight record in
   * STORAGE for its outcome, exactly as `lazy wait` polls task status — except
   * that it can tell "MY turn ended" from "some turn ended", because the record
   * names the turn sequence it is waiting for.
   */
  readAnswer: () => Promise<T | null> | T | null;
  /** Runner that owns the supervisor run (used only to probe liveness + logs). */
  runner: Runner;
  /** Run/container name to probe. */
  runName: string;
  /** Total wall-clock budget; 0 waits forever (still liveness-aware). */
  timeoutMs: number;
  /** Poll interval. */
  intervalMs?: number;
  /** See {@link WaitForSupervisorResponseOptions.alreadyRunning}. */
  alreadyRunning?: boolean;
  /** Overrides, for tests that cannot afford the real graces. */
  startupGraceMs?: number;
  deathGraceMs?: number;
  livenessIntervalMs?: number;
}

export interface WaitForSupervisorResponseOptions {
  /** Protocol directory to poll for `response.json`. */
  protoDir: string;
  /** Runner that owns the supervisor run (used only to probe liveness + logs). */
  runner: Runner;
  /** Run/container name to probe. */
  runName: string;
  /** Total wall-clock budget; 0 waits forever (still liveness-aware). */
  timeoutMs: number;
  /** Response poll interval. */
  intervalMs?: number;
  /**
   * True when the caller REUSED a run it found already up instead of launching
   * one. The startup grace exists only to let a run the caller just started
   * become visible; a run that was already reported running has nothing to wait
   * for, so liveness is meaningful from the first probe. This is also the exact
   * shape of the stale-`isRunning` failure — launch skipped, nothing actually
   * there — so it is the case that most needs the fast answer.
   */
  alreadyRunning?: boolean;
  /** Overrides, for tests that cannot afford the real graces. */
  startupGraceMs?: number;
  deathGraceMs?: number;
  livenessIntervalMs?: number;
}

/**
 * Poll for the supervisor's response, aborting early if the supervisor dies.
 *
 * Never throws on a probe failure: a runner that cannot answer "is it running?"
 * (a transient docker CLI error, a runner with no notion of a run) is treated as
 * "still alive", so the caller falls back to the timeout it had before. Failing
 * to probe must never manufacture a false abort.
 */
export async function waitForSupervisorResponse(
  opts: WaitForSupervisorResponseOptions,
): Promise<SupervisorWaitOutcome> {
  const { protoDir, ...rest } = opts;
  const outcome = await waitForSupervisorAnswer<Response>({
    ...rest,
    readAnswer: () => readResponse(protoDir),
  });
  return outcome.kind === 'answer'
    ? { kind: 'response', response: outcome.answer }
    : outcome;
}

/**
 * The liveness-aware wait itself, over an arbitrary "answer".
 *
 * Identical semantics to {@link waitForSupervisorResponse} — including both
 * graces and the final re-read at the abort — with the source of the answer
 * injected. Splitting it this way is what lets the synchronous turns stop
 * reading `response.json` (the reconciler owns that file now) WITHOUT any of
 * this module's timing behaviour being reimplemented at the new call sites.
 */
export async function waitForSupervisorAnswer<T>(
  opts: WaitForSupervisorAnswerOptions<T>,
): Promise<SupervisorAnswerOutcome<T>> {
  const {
    readAnswer,
    runner,
    runName,
    timeoutMs,
    intervalMs = 500,
    alreadyRunning = false,
    startupGraceMs = alreadyRunning ? 0 : SUPERVISOR_STARTUP_GRACE_MS,
    deathGraceMs = SUPERVISOR_DEATH_GRACE_MS,
    livenessIntervalMs = SUPERVISOR_LIVENESS_INTERVAL_MS,
  } = opts;

  const start = Date.now();
  let lastProbe = 0;
  // Timestamp the run was FIRST observed gone in the current gone-streak; reset
  // the moment it is seen alive again.
  let goneSince: number | null = null;

  while (true) {
    const answer = await readAnswer();
    if (answer !== null && answer !== undefined) return { kind: 'answer', answer };

    const now = Date.now();

    if (timeoutMs > 0 && now - start >= timeoutMs) {
      return { kind: 'timeout' };
    }

    if (now - start >= startupGraceMs && now - lastProbe >= livenessIntervalMs) {
      lastProbe = now;
      let alive = true;
      try {
        alive = await runner.isRunning(runName);
      } catch (err) {
        // Probe failure is not death. Log once per probe at debug level and keep
        // waiting on the timeout — see the function doc.
        logger.debug(
          `Supervisor liveness probe for '${runName}' failed: ` +
          `${err instanceof Error ? err.message : String(err)}. Assuming still alive.`,
        );
        alive = true;
      }
      if (alive) {
        goneSince = null;
      } else if (goneSince === null) {
        goneSince = now;
      } else if (now - goneSince >= deathGraceMs) {
        // Final check: the answer may have landed between the last poll and
        // now. This only runs once, at the abort.
        const late = await readAnswer();
        if (late !== null && late !== undefined) return { kind: 'answer', answer: late };
        return { kind: 'dead', diagnostics: await collectRunDiagnostics(runner, runName) };
      }
    }

    await Bun.sleep(intervalMs);
  }
}

/**
 * Best-effort post-mortem for a run that vanished: exit code plus the tail of
 * its output. Everything here is optional — a runner may know neither — so each
 * piece is guarded and the whole thing returns null rather than failing the
 * abort it is only decorating.
 */
export async function collectRunDiagnostics(
  runner: Runner,
  runName: string,
  tailLines = 20,
): Promise<string | null> {
  const parts: string[] = [];

  try {
    const exitCode = await runner.getRunExitCode(runName);
    if (exitCode !== null) parts.push(`exit code ${exitCode}`);
  } catch (err) {
    logger.debug(`Could not read exit code for '${runName}': ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const logs = await runner.getRunLogs(runName, tailLines);
    const trimmed = logs?.trim();
    if (trimmed) parts.push(`last output:\n\`\`\`\n${trimmed.slice(-2000)}\n\`\`\``);
  } catch (err) {
    logger.debug(`Could not read logs for '${runName}': ${err instanceof Error ? err.message : String(err)}`);
  }

  return parts.length > 0 ? parts.join('; ') : null;
}
