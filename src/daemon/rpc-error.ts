/**
 * The error type every daemon route understands.
 *
 * Lives in its own module (rather than in rpc-handlers.ts, where it was
 * defined) so that input-validation helpers — ./rpc-params, ./http-body — can
 * raise it without importing the whole handler graph and forming an import
 * cycle with it. `rpc-handlers.ts` re-exports it, so existing importers are
 * unaffected.
 *
 * The `status` is load-bearing: routes map it to the HTTP status verbatim, so a
 * caller's bad argument stays a 400 instead of flattening into a 500 that reads
 * as a daemon crash (see test/e2e/mcp-route-status.test.ts).
 */
/**
 * Machine-readable refusal kinds, for the callers that must tell one 409 from
 * another. Deliberately a tiny closed set: a code exists only where a caller's
 * BEHAVIOUR differs, never as a second spelling of the message.
 *
 * - `task_busy` — somebody else owns this task right now (its status is
 *   `working`/`pairing`, a synchronous turn is in flight, or its worktree is
 *   locked). Transient by construction: the right response is to come back on
 *   the next tick, not to record a failure. The daemon's auto-review catchup
 *   reads it for exactly that (`src/daemon/auto-review.ts`) — a review it lost
 *   a race to start is not a review that failed, and recording one gated a task
 *   whose real review was running at that instant.
 *
 * - `usage_paused` — the usage pause refused a launch a person asked for
 *   (src/daemon/usage-pause.ts). Read by the callers that must tell it from a
 *   failure: a reparent whose follow-up sync was refused has still reparented.
 */
export type RpcErrorCode = 'task_busy' | 'usage_paused';

export class RpcError extends Error {
  constructor(public status: number, message: string, public code?: RpcErrorCode) {
    super(message);
  }
}

/**
 * Was this refusal "somebody else owns the task right now"?
 *
 * Lives here, next to the code, so a reader never has to match on a message.
 */
export function isTaskBusyRefusal(err: unknown): boolean {
  return err instanceof RpcError && err.code === 'task_busy';
}

/** Was this the usage pause refusing a launch somebody asked for? */
export function isUsagePauseRefusal(err: unknown): boolean {
  return err instanceof RpcError && err.code === 'usage_paused';
}
