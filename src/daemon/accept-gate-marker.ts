/**
 * The ACCEPT GATE's `working` is not a turn.
 *
 * `runInAcceptGateContainer` flips a task to `working` for the whole gate (to
 * keep auto-deliver and auto-resume off it), with no claim and no agent. The
 * MCP authority resolver reads `working` with no claim as a live WORK turn, so
 * for the gate's duration the task's token — held by anything still running in
 * the task's container — had full authority. The gate adds the task here before
 * the flip and removes it on every exit; the resolver treats a listed task as
 * having no turn.
 *
 * IN-PROCESS on purpose: the gate runs inside this daemon process and dies with
 * it, so a marker that outlived the process could only ever strip a later real
 * turn of its authority. Nothing here can fail to clear.
 */

const gatesRunning = new Set<string>();

export function markAcceptGateRunning(taskId: string): void {
  gatesRunning.add(taskId);
}

export function clearAcceptGateRunning(taskId: string): void {
  gatesRunning.delete(taskId);
}

/** Is this daemon process running the task's accept gate right now? */
export function isAcceptGateRunning(taskId: string): boolean {
  return gatesRunning.has(taskId);
}
