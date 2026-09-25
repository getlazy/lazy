/**
 * Daemon-side writer of the turn-ending marker (`final.json`).
 *
 * Two MCP tools declare how a turn is ending — `lazy_final` (pencils down) and
 * `lazy_raise(blocking: true)` (needs input) — and both execute in the daemon.
 * The supervisor, which picks the closing chain from it, runs in the task container and
 * can only see the protocol dir. This module is the one place that writes
 * across that seam, for the same reason `progress-registry.ts` is: every agent
 * tool call authenticates with a per-session MCP token, so the daemon knows
 * which task is reporting, and no client ever writes protocol state directly.
 *
 * SERIALIZED PER TASK. The marker is read-modify-written (a `needs_input` mark
 * must never erase a `final` claim from earlier in the same invocation), and the
 * MCP server dispatches calls concurrently — so two tools racing here would drop
 * one half. One chain per task, exactly as progress does.
 *
 * INVARIANT — bookkeeping must never break the call it observes. The
 * needs-input mark is BEST EFFORT and its failure is logged, never thrown: it
 * only tells the supervisor the daemon was reachable this invocation, and
 * losing that must never cost an agent its `lazy_raise` call. The FINAL claim
 * is not best-effort — an agent that is told "recorded" must have been
 * recorded, and it is what selects the closing chain — so `recordFinalClaim`
 * propagates.
 */

import { protocolDir } from '../protocol';
import { mergeFinalMarker, type FinalMarkerClaim } from '../protocol/final-marker';
import { logger } from '../utils/logger';

/** Per-task serialization of marker writes. */
const writeChains = new Map<string, Promise<unknown>>();

function serialize<T>(taskId: string, op: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(taskId) ?? Promise.resolve();
  const next = prev.then(op, op);
  // Keep the chain alive past a rejection, but never leave an unhandled one.
  writeChains.set(taskId, next.catch(() => undefined));
  return next;
}

/** Record that this invocation declared the work finished. Throws on failure. */
export async function recordFinalClaim(taskId: string, claim: FinalMarkerClaim): Promise<void> {
  await serialize(taskId, () => mergeFinalMarker(protocolDir(taskId), { final: claim }));
}

/**
 * Record that this invocation filed a blocking raise.
 *
 * It does not change which closing steps run — a task that parks for a
 * decision gets the same presentation as one that just stopped. What it says
 * is that this invocation reached the daemon, which is how the supervisor
 * knows not to go looking in the MCP-down handoff file for an ending.
 *
 * Best-effort: a failure here costs one pointless file read, and must never
 * cost the raise itself.
 */
export async function recordNeedsInput(taskId: string): Promise<void> {
  try {
    await serialize(taskId, () =>
      mergeFinalMarker(protocolDir(taskId), { needs_input: { at: new Date().toISOString() } }),
    );
  } catch (err) {
    logger.warn(
      `turn-ending-registry: could not mark task ${taskId.substring(0, 8)} needs-input ` +
      `(${err instanceof Error ? err.message : String(err)}); the supervisor will re-read the handoff file for this turn.`,
    );
  }
}
