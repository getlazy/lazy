/**
 * What a daemon is doing while it STARTS, for a caller waiting on it.
 *
 * A Teams project start polls the daemon for its task proxy address and used to
 * give up after a fixed 10s. The daemon answers RPC as soon as it binds, but
 * published the proxy address only after every store-touching startup step
 * after the bind: three migrations that walk the whole store, and a cleanup
 * that waits (up to the 60s store-open deadline) for the store to open. Either
 * the field error itself says which: "the daemon answered, but its task proxy
 * did not start" is only reachable after `lazy daemon start` saw the daemon
 * healthy, i.e. after the bind, so the store had already opened (it opens
 * before the bind) and the delay was the whole-store migrations — the only
 * store work after the bind. The proxy now starts before all of them, and
 * nothing said what the daemon was doing. Every awaited startup step now names itself
 * here, `/daemon/status` reports it as `startup`, and the step's duration is
 * logged at INFO so a slow start is legible after the fact.
 *
 * In-memory and per-process: a fresh process starts in `starting`.
 */

import { logger } from '../utils/logger';

export interface StartupPhaseView {
  /** True once every startup step has finished. */
  complete: boolean;
  /** The step running now, in plain words; null once complete. */
  phase: string | null;
  /** How long the current step has been running. */
  phaseMs: number;
  /** How long the daemon has been starting (or took to start, once complete). */
  elapsedMs: number;
}

let startedAt = Date.now();
let phase: string | null = 'starting';
let phaseSince = startedAt;
let completedAt: number | null = null;

/** Name the step now running. */
export function setStartupPhase(name: string, now: number = Date.now()): void {
  phase = name;
  phaseSince = now;
}

/**
 * Run one startup step under its name, logging how long it took. The phase is
 * left on the step if it throws — the caller decides what a failure means.
 */
export async function startupStep<T>(name: string, step: () => Promise<T>): Promise<T> {
  setStartupPhase(name);
  const t0 = Date.now();
  const value = await step();
  logger.info(`Startup: ${name} took ${Date.now() - t0}ms`);
  return value;
}

export function markStartupComplete(now: number = Date.now()): void {
  phase = null;
  completedAt = now;
  logger.info(`Startup: complete in ${now - startedAt}ms`);
}

export function startupPhaseView(now: number = Date.now()): StartupPhaseView {
  return {
    complete: completedAt !== null,
    phase,
    phaseMs: completedAt !== null ? 0 : now - phaseSince,
    elapsedMs: (completedAt ?? now) - startedAt,
  };
}

/** Called once at daemon start (and by tests) to begin a fresh record. */
export function resetStartupPhase(now: number = Date.now()): void {
  startedAt = now;
  phase = 'starting';
  phaseSince = now;
  completedAt = null;
}
