/**
 * Accept check — refuse to merge a task whose own worktree does not build.
 *
 * ## The failure it prevents
 *
 * A task collapsed two generated constants into one. During review a human
 * reverted six protected test files, which left the branch inconsistent, and
 * the agent's very next turn was titled "Blocked: the reverted state does not
 * compile" and named every broken file. The task was accepted anyway: nothing
 * on the accept path reads a turn title, and the one file that mattered
 * (`test/mocks/claude.ts`, the `--preload` for every e2e suite) imported a
 * constant that no longer existed. Every `withDaemon` suite on the branch died,
 * and it survived review because the generated `src/version.ts` is gitignored,
 * so stale worktree copies still carried both constants.
 *
 * The lesson generalises past that one incident: NOTHING that says a task is
 * broken — a turn title, a post-turn check, an agent's own summary — is
 * load-bearing on accept. This gate is, because it runs the project's check in
 * the task's worktree at the moment of the merge and refuses on a non-zero exit.
 *
 * ## Deliberate shape
 *
 * - **The project's CONFIGURED command, never a hardcoded one.**
 *   `[automation] accept_check`. lazy does not know how a project builds, and a
 *   guessed command that exits non-zero for its own reasons would be worse than
 *   no gate. Unset = skipped, and accept SAYS it skipped.
 * - **Exit 127 is reported as "could not run", not as "does not compile".**
 *   A check whose interpreter is missing exits before reading a single file.
 *   Reporting that as a compile failure would send the reviewer hunting a type
 *   error that does not exist — and a gate that silently passes because nothing
 *   ran is the exact defect this module exists to prevent, so it still refuses.
 * - **Host-side, in the task worktree.** No agent turn, no container, no
 *   network, no extra daemon state: accept already has the worktree path.
 *   See the trust boundary below — this one is a real tradeoff, not a freebie.
 * - **The override is explicit and named.** `lazy accept <task> --allow-broken`
 *   accepts knowingly; the refusal names the flag. There is no way to turn the
 *   gate into a silent pass. It is CLI-only, so a refusal delivered over MCP
 *   says the override needs a terminal rather than naming a flag that surface
 *   cannot pass (docs/surface-asymmetries.md §14).
 *
 * ## Trust boundary — read before enabling this
 *
 * The check runs as a plain `sh -c` on the DAEMON HOST, as the user running
 * the daemon, with cwd set to the task worktree. That worktree is agent-written.
 *
 * The COMMAND is human config: it comes from the project's `lazy.toml`, read
 * from the project root, never from the task branch's copy — a task cannot edit
 * its own gate. But what the command RESOLVES is agent-authored: `bun run
 * typecheck` reads the worktree's `package.json` scripts, a `make check` reads
 * its `Makefile`, `tsc` reads its `tsconfig.json` (and, via that, any config it
 * extends). An agent that can commit to its own branch can change what your
 * check actually executes.
 *
 * This is deliberate but not free. `[automation] pre_accept` — the mechanical
 * acceptance gate — runs in its own ephemeral container built from the task's
 * consented image, independent of the task's runner, and the accept_check gate
 * does not even share that: the task's constraint is
 * that it must not depend on the runner, the network, or daemon health beyond
 * what accept already needs, so it executes outside every container guard —
 * including on fully automated MCP accepts of subtasks, where no human sees the
 * accept at all. Enabling `accept_check` on a container-runner project means
 * accepting a host-side execution of something the agent can influence. Treat
 * it the way you would treat a CI hook running over untrusted input.
 *
 * Cost: one process, bounded by `accept_check_timeout` (default 300s). Measured
 * on this repo (agent container, 2026-08): a full `tsc --noEmit` over ~900 files
 * takes 3.8-3.9s wall clock, and the gate itself adds nothing measurable on top
 * of the command — one `sh -c` spawn plus the stdio drain accept already does
 * for post-turn hooks. That is the whole per-accept cost, and it is zero for a
 * project that leaves `accept_check` unset.
 */

import { runTurnHookCommand, formatHookOutput, type TurnHookLogSink } from '../supervisor/post-turn-check';
import { docsSuffix } from '../docs/links';

/** Exit code of a command whose interpreter or binary was not found. */
const EXIT_COMMAND_NOT_FOUND = 127;

/** The flag that accepts a task knowingly despite a failing check. */
export const ALLOW_BROKEN_FLAG = '--allow-broken';

export class AcceptCheckFailedError extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Formatted stdout/stderr of the failed run, for the reviewer to act on. */
  readonly output: string;
  readonly elapsedMs: number;

  constructor(
    message: string,
    details: { command: string; exitCode: number; timedOut: boolean; output: string; elapsedMs: number },
  ) {
    super(message);
    this.name = 'AcceptCheckFailedError';
    this.command = details.command;
    this.exitCode = details.exitCode;
    this.timedOut = details.timedOut;
    this.output = details.output;
    this.elapsedMs = details.elapsedMs;
  }
}

export interface AcceptCheckOutcome {
  /** True when the command actually ran (whatever its exit code). */
  ran: boolean;
  /** Why the gate did not run, in the human's words. Present iff `ran` is false. */
  skippedReason?: string;
  /** Wall-clock cost of the check, when it ran. */
  elapsedMs?: number;
  /** True when the check failed and `--allow-broken` overrode the refusal. */
  overridden?: boolean;
  /** Exit code of the overridden failure, so the warning can name it. */
  exitCode?: number;
}

export interface EnforceAcceptCheckParams {
  /** The task's worktree — the tree that is about to be merged. */
  worktreePath: string;
  /** Command from `[automation] accept_check`. Empty = no gate configured. */
  command: string;
  /** Timeout in seconds from `[automation] accept_check_timeout`. */
  timeoutSecs: number;
  displayId: string;
  /** Branch the task is being merged INTO — the thing a broken merge breaks. */
  targetBranch: string;
  /** The human passed `--allow-broken`: report the failure, do not refuse. */
  allowBroken: boolean;
  /** See {@link acceptCheckOverrideAvailable}. Defaults to true (the CLI). */
  overrideAvailable?: boolean;
  /** Where progress lines go. Defaults to the supervisor logger. */
  logSink?: TurnHookLogSink;
}

/**
 * The refusal text: what happened, in MERGE terms, plus the output and the
 * named override. CLAUDE.md — an error says what was attempted, what happened,
 * and what to do about it.
 */
export function acceptCheckRefusalMessage(params: {
  displayId: string;
  targetBranch: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
  elapsedMs: number;
  /**
   * Can THIS caller actually take the override? False over MCP, where
   * `--allow-broken` does not exist (docs/surface-asymmetries.md §14) — naming
   * a flag the reader cannot pass coaches an agent toward a dead end.
   */
  overrideAvailable?: boolean;
}): string {
  const { displayId, targetBranch, command, exitCode, timedOut, output, elapsedMs } = params;
  const overrideAvailable = params.overrideAvailable !== false;
  const secs = (elapsedMs / 1000).toFixed(1);

  let headline: string;
  if (timedOut) {
    headline =
      `The accept check for task ${displayId} did not finish within ${secs}s and was killed. ` +
      `A check that never answered is not a pass, so the merge into \`${targetBranch}\` was refused.`;
  } else if (exitCode === EXIT_COMMAND_NOT_FOUND) {
    // Distinguished on purpose: exit 127 means nothing was compiled at all.
    headline =
      `The accept check for task ${displayId} COULD NOT RUN (exit 127 — command or interpreter ` +
      `not found), so nothing about this task was verified. A gate that passes because nothing ` +
      `ran is exactly the failure it exists to prevent, so the merge into \`${targetBranch}\` was refused.`;
  } else {
    headline =
      `Task ${displayId} does not build: its accept check failed (exit ${exitCode}) in the task's ` +
      `own worktree, so merging it into \`${targetBranch}\` would break \`${targetBranch}\`.`;
  }

  const remedy = overrideAvailable
    ? `Fix it in the task and re-run the accept, or — if you know this tree is broken and want it ` +
      `merged anyway — say so explicitly:\n\n` +
      `  lazy accept ${displayId} ${ALLOW_BROKEN_FLAG}\n`
    : `Fix it in the task and re-run the accept. There is no override on this surface: ` +
      `${ALLOW_BROKEN_FLAG} is a CLI flag with no equivalent here, so merging a tree that does ` +
      `not build takes a human at a terminal.\n`;

  return (
    `${headline}\n\n` +
    `  command: ${command}\n` +
    `  elapsed: ${secs}s\n\n` +
    `${output}\n\n` +
    remedy +
    docsSuffix('accept-check', '\n')
  );
}

/**
 * Whether the caller's surface can take `--allow-broken`.
 *
 * The flag is CLI-only by design (docs/surface-asymmetries.md §14), and the MCP
 * boundary sets an explicit actor for exactly this kind of question: 'agent' for
 * a task agent, 'builder' for the builder. A CLI accept passes no actor and
 * falls back to 'human'.
 */
export function acceptCheckOverrideAvailable(actor: unknown): boolean {
  const role =
    typeof actor === 'string'
      ? actor
      : typeof actor === 'object' && actor !== null
        ? (actor as { role?: unknown }).role
        : undefined;
  return role !== 'agent' && role !== 'builder';
}

/** The warning printed when a failing check was overridden. */
export function acceptCheckOverriddenWarning(displayId: string, exitCode: number): string {
  return (
    `Accept check FAILED (exit ${exitCode}) for task ${displayId} and was overridden with ` +
    `${ALLOW_BROKEN_FLAG} — this task was merged knowing it does not build.`
  );
}

/**
 * Run the configured accept check in the task worktree.
 *
 * Throws {@link AcceptCheckFailedError} when the check fails and `allowBroken`
 * is false. Returns (with `overridden: true`) when it fails and the human
 * overrode it — the caller surfaces that as a warning, never as silence.
 */
export async function enforceAcceptCheck(
  params: EnforceAcceptCheckParams,
): Promise<AcceptCheckOutcome> {
  const { worktreePath, command, timeoutSecs, displayId, targetBranch, allowBroken, logSink } = params;
  const overrideAvailable = params.overrideAvailable !== false;

  // Coalesced: a config object that predates this key (or a caller that built
  // one by hand) must degrade to "no gate", never crash an accept mid-merge.
  const trimmed = (command ?? '').trim();
  if (!trimmed) {
    // Never invent a build command for a project that configured none.
    return {
      ran: false,
      skippedReason: 'no `[automation] accept_check` is configured for this project',
    };
  }

  const result = await runTurnHookCommand(
    trimmed,
    worktreePath,
    Math.max(1, Math.round(timeoutSecs)) * 1000,
    `Accept check for ${displayId}`,
    logSink,
  );

  if (result.exitCode === 0) {
    return { ran: true, elapsedMs: result.elapsedMs };
  }

  const output = formatHookOutput(result);
  if (allowBroken) {
    return { ran: true, elapsedMs: result.elapsedMs, overridden: true, exitCode: result.exitCode };
  }

  throw new AcceptCheckFailedError(
    acceptCheckRefusalMessage({
      displayId,
      targetBranch,
      command: trimmed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output,
      elapsedMs: result.elapsedMs,
      overrideAvailable,
    }),
    {
      command: trimmed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output,
      elapsedMs: result.elapsedMs,
    },
  );
}
