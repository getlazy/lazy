/**
 * The user-stop gate: "somebody deliberately halted this task."
 *
 * `lazy stop` / `lazy_stop` parks a task in `blocked` and sets
 * `session.user_stopped`. The status alone does not say why a task is parked —
 * a task that finished its turn is `blocked` too — so every path that would
 * start a turn NOBODY asked for has to consult this flag, not the status.
 *
 * It lives in its own module, with no imports, because the paths that must
 * agree about it sit on both sides of import cycles: the reconciler's fast
 * auto-resume lane (`src/utils/reconcile.ts`), the slow lane
 * (`src/daemon/auto-resume-queue.ts`, which the reconciler calls into) and the
 * cluster restart (`src/daemon/cluster-restart.ts`, reached through auto-deliver).
 * Two of those had already spelled the predicate out for themselves rather than
 * import across a cycle — which is how the cluster restart came to wake a cluster
 * the engineer had stopped: nothing was wrong with the rule, it just was not
 * asked.
 *
 * Cleared by a human picking the task back up — `resetConsecutiveInterruptions`
 * on a manual unblock or resume — which re-arms every automatic path at once.
 */

/**
 * True when this session was stopped on purpose (human CLI, builder over MCP,
 * or a parent agent stopping its own child) rather than interrupted by a crash.
 *
 * A legacy session with the field absent reads as NOT stopped: the flag records
 * a deliberate act, and its absence is the ordinary case.
 */
export function isUserStopped(session: { user_stopped?: boolean }): boolean {
  return session.user_stopped === true;
}

/**
 * The statuses a stopped task can be listed in. Not `working`: a builder
 * unblock leaves the flag set until that turn completes.
 */
export function isParkedStatus(status: string): boolean {
  return status === 'blocked' || status === 'conflict' || status === 'interrupted';
}

/**
 * True when a listing should mark this task as stopped: it is parked
 * (`blocked`, `conflict` or `interrupted`) AND its session was stopped on
 * purpose. The one rule behind the CLI's `[STOPPED]` chip and `lazy_list`'s
 * `stopped` field, so the two surfaces cannot disagree about which tasks a
 * person halted.
 */
export function isStoppedParked(
  status: string,
  session: { user_stopped?: boolean } | null | undefined,
): boolean {
  if (!session) return false;
  return isParkedStatus(status) && isUserStopped(session);
}
