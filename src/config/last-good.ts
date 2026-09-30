/**
 * The last known good config: what a RUNNING DAEMON operates on while the
 * lazy.toml in force does not load.
 *
 * Every daemon operation reads config afresh (`loadConfig`), so a file saved
 * mid-edit with a syntax error used to fail the next turn launch, reconciler
 * tick and request — a healthy daemon brought to a standstill by a half-typed
 * line. With this enabled (the daemon does, at startup), a load that fails
 * answers with the last config that loaded FROM THE SAME RESOLVED PATH, and the
 * failure is reported once: a warning in the daemon log and whatever the
 * daemon's listener does with it (a system message). `lazy daemon status` and
 * `lazy doctor` read {@link lastKnownGoodState} for as long as it lasts. The
 * next successful load ends it.
 *
 * INVARIANT: the fallback is keyed by the resolved path and nothing else. It can
 * never hand out a config read from a different file — a task worktree's
 * lazy.toml included — so "A task worktree's lazy.toml has no authority"
 * (CLAUDE.md, src/config/loader.ts findConfigDir) holds exactly as before: the
 * only config it returns is one the project-root resolution already accepted.
 *
 * Off by default: a CLI command runs once and must report a broken file as
 * broken, not quietly use a copy it does not have anyway.
 */

import type { ResolvedConfig } from './types';

/** An episode of the file in force not loading while a good copy is in use. */
export interface LastKnownGoodState {
  /** The file that does not load. */
  path: string;
  /** The loader's own message for the failure (first seen in this episode, refreshed on each failed read). */
  error: string;
  /** When this episode started (ISO). */
  since: string;
  /** When the config now in use was loaded (ISO). */
  goodLoadedAt: string;
}

export type LastKnownGoodEvent =
  | { kind: 'fallback'; state: LastKnownGoodState }
  | { kind: 'recovered'; path: string };

let enabled = false;
let listener: ((event: LastKnownGoodEvent) => void) | null = null;
const good = new Map<string, { config: ResolvedConfig; loadedAt: string }>();
const failing = new Map<string, LastKnownGoodState>();

/**
 * Turn the fallback on for this process. `onEvent` hears each episode's start
 * ONCE (`fallback`) and its end (`recovered`) — never each failed read.
 */
export function enableLastKnownGood(onEvent?: (event: LastKnownGoodEvent) => void): void {
  enabled = true;
  listener = onEvent ?? null;
}

/** For tests: back to the CLI's behaviour, nothing remembered. */
export function resetLastKnownGood(): void {
  enabled = false;
  listener = null;
  good.clear();
  failing.clear();
}

function emit(event: LastKnownGoodEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch (err) {
    // The listener reports; a report failing must not turn a successful config
    // read (or a working fallback) into a failed one. Say so on stderr, which
    // the daemon log captures.
    console.error(`[last-good-config] listener failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Called by the loader after every successful load. */
export function rememberGoodConfig(path: string, config: ResolvedConfig): void {
  if (!enabled) return;
  good.set(path, { config: structuredClone(config), loadedAt: new Date().toISOString() });
  if (failing.delete(path)) emit({ kind: 'recovered', path });
}

/**
 * The config to use in place of a failed load of `path`, or null when there is
 * none (fallback off, or nothing ever loaded from this path in this process).
 */
export function lastKnownGoodFor(path: string, err: unknown): ResolvedConfig | null {
  if (!enabled) return null;
  const entry = good.get(path);
  if (!entry) return null;
  const error = err instanceof Error ? err.message : String(err);
  const existing = failing.get(path);
  if (existing) {
    existing.error = error;
  } else {
    const state: LastKnownGoodState = { path, error, since: new Date().toISOString(), goodLoadedAt: entry.loadedAt };
    failing.set(path, state);
    emit({ kind: 'fallback', state: { ...state } });
  }
  // A copy, never the remembered object: a caller that writes into its config
  // must not change what the next fallback returns.
  return structuredClone(entry.config);
}

/** The episode in progress for `path`, if the last-known-good config is in use for it. */
export function lastKnownGoodState(path: string): LastKnownGoodState | null {
  const state = failing.get(path);
  return state ? { ...state } : null;
}
