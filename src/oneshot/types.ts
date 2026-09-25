/**
 * The machine one-shot request — what a caller asks for, and nothing else.
 *
 * A one-shot is a single prompt-in / text-out model call lazy makes on its own
 * behalf: an accept-time fidelity summary, a `lazy report` unit, a pass of
 * `lazy ask <session-id>` over a stored conversation, a memory compaction. No
 * supervisor, no session, no resume, no MCP.
 *
 * `lazy ask <task>` and `lazy chat` are NOT one-shots and never reach this type:
 * they RESUME a task's agent session read-only and therefore run on that task's
 * own agent, model and effort (src/daemon/launch-identity.ts).
 *
 * WHAT IS DELIBERATELY NOT IN THIS TYPE
 * -------------------------------------
 * There is no `readOnly` flag and no `cwd`. Write tools are disallowed for every
 * one-shot, unconditionally, and where the run stands is the RUNNER's decision —
 * derived from `repoAccess` below. Both used to be per-call-site options, and
 * both were got wrong: the fidelity summary ran in the project root with write
 * tools and committed onto `main` mid-accept, while `lazy report` and memory
 * compaction still ran with Bash/Write/Edit in the user's working tree. A caller
 * states what it NEEDS; it does not get to state how isolated it is.
 *
 * There is also no AGENT and no ROLE. A one-shot always runs on the BUILDER role
 * target (whose credential pays, unless a team-mode caller passes
 * {@link OneshotRequest.ownerCredentialEnv}) — never a task's agent, never `[models] default` — because it is a
 * fresh-context call lazy makes on the human's behalf, not a turn on anyone's
 * session. See {@link OneshotRequest.effort} and docs/oneshot-execution.md.
 *
 * See docs/oneshot-execution.md.
 */

import type { EffortLevel } from '../config/types';

/**
 * How much of the repository a one-shot needs.
 *
 * - `none` (the default): the prompt carries everything. The container runner
 *   gives the run no repository mount at all; the host runner stands it in a
 *   directory outside every git tree.
 * - `read-only`: the run may Read/Grep the project. The container runner mounts
 *   the project root `:ro`, so a write fails at the kernel; the host runner has
 *   no mount namespace, so there "read-only" means tool denial plus the OS
 *   sandbox — weaker, and documented as such.
 */
export type OneshotRepoAccess = 'none' | 'read-only';

/**
 * Effort a one-shot runs at when the request reached the daemon without one.
 *
 * {@link OneshotRequest.effort} is REQUIRED, so within one lazy version every
 * call site has already named its kind's effort at compile time. This constant
 * exists for exactly one case: an older CLI RPCing a newer daemon, whose params
 * predate the field. Middle of the ladder — a one-shot whose kind we cannot see
 * should be neither the cheapest nor the most expensive thing lazy can run.
 */
export const DEFAULT_ONESHOT_EFFORT: EffortLevel = 'medium';

export interface OneshotRequest {
  /** The full prompt. Stamped with the machine-one-shot marker by the runner. */
  prompt: string;
  /**
   * Model id, or undefined to run the BUILDER role target's model.
   *
   * Set only where a HUMAN named one — today that is `lazy memory compact
   * --model` and nothing else. Never derived from a task: a one-shot strips
   * `--resume`/`--continue`, so it inherits no session and no prompt cache from
   * the task it is about, and a task's model id may not even be valid on the
   * builder's harness or upstream. Never `[models] default` either: that id is
   * only meaningful against the endpoint the DEFAULT profile resolves to, and a
   * one-shot's traffic goes to the builder profile's.
   */
  model?: string;
  /**
   * Reasoning effort for this run — fixed per one-shot KIND by its call site,
   * never inherited from the builder's own `--effort` or from a task.
   *
   * Required so that adding a one-shot is a decision about how much thinking it
   * deserves. A summary is a summary whether or not the human happens to be
   * driving a builder at `xhigh`: inheriting would make every accept-time
   * fidelity blurb cost as much as the reasoning that produced the work. The
   * kinds and their levels are listed in docs/oneshot-execution.md.
   */
  effort: EffortLevel;
  /** Repository access this call genuinely needs. Defaults to `none`. */
  repoAccess?: OneshotRepoAccess;
  /**
   * Kill the run after this many milliseconds and throw. Omitted, the run is
   * bounded by {@link DEFAULT_ONESHOT_TIMEOUT_MS} — bounded is the DEFAULT, and
   * unbounded is the explicit opt-out (`timeoutMs: 0`).
   *
   * That polarity is deliberate. An unbounded default only ever looks safe: the
   * accept-time fidelity summary wedged tasks in `merging` until someone killed
   * the daemon, and the same wedge in a human-invoked one-shot hangs a terminal
   * with no output forever. "The human can Ctrl-C it" is not a bound — it is a
   * person noticing.
   */
  timeoutMs?: number;
  /**
   * Short task ref this one-shot belongs to, threaded onto proxied traffic as
   * `x-lazy-task-id` so the audit plane and the per-task progress counters can
   * attribute the call. Omitted where the caller has no task (`lazy report`,
   * memory compaction) — those records simply carry a null task id.
   */
  taskId?: string;
  /**
   * Team-mode session placeholder env (`lazy-sess-…`) bound to the HUMAN who
   * asked for this run, so the proxy bills their own credential rather than the
   * builder's. Built by the daemon from a turn-credential plan
   * (src/daemon/turn-credentials.ts) — never a real secret. Omitted, the run
   * uses the builder role's credential exactly as before.
   */
  ownerCredentialEnv?: Array<{ key: string; value: string }>;
}
