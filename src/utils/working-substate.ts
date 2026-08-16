/**
 * Working-substate derivation — the single source of truth for distinguishing
 * the observable flavors of a `working` task:
 *
 *   - working(agent)            the agent (claude/cursor) is doing real work
 *   - working(agent:answering)  the agent is answering a question (`lazy ask`)
 *   - working(agent:pre-accept) the accept path is running its validation turn
 *   - working(waiting on X)     the agent is BLOCKED on a subtask (`lazy_wait`)
 *   - working(harness:<phase>)  the supervisor is doing pre/post-turn work
 *   - not-alive                 no live run and no response — a stranded candidate
 *
 * A task in `working` is otherwise opaque: a long `post_turn_check` (e.g.
 * `cargo build`), a hung supervisor, and a dead supervisor all render
 * identically. This module derives the distinction from the supervisor's
 * `status.json` checkpoint combined with actual run liveness, so every read
 * surface (`ls`, `blocked`, `active`, `status`, `show`, `watch`) renders it
 * consistently WITHOUT each one re-implementing the classification.
 *
 * The substate is DERIVED / observational ONLY. It never changes task state —
 * `working` stays `working`. It is a presentation layer and a diagnosis basis
 * (the not-alive substate is the signal `fix-stranded-working-task` keys on).
 */

import { join } from 'path';
import { readFile, stat } from 'fs/promises';
import type { SupervisorPhase, SupervisorStatus } from '../protocol/types';
import { readActiveWaits, type WaitingEntry } from '../protocol/waiting';
import { elapsedFrom } from './elapsed';
import { formatRetrySummary, type RetrySummaryInput } from './retry-summary';
import { logger } from './logger';

export type WorkingSubstate =
  | {
      kind: 'agent';
      /** The turn is an `lazy ask` question, not ordinary work. */
      answering?: boolean;
      /**
       * The turn is the accept path's pre-accept validation turn. The task is
       * genuinely `working` for its whole duration, and without this the only
       * observable state during an accept was a bare `working` that looked
       * exactly like the human having unblocked the task by hand.
       */
      preAccept?: boolean;
    }
  | {
      kind: 'harness';
      /** The supervisor phase driving the work (e.g. `post_turn_check`). */
      phase: SupervisorPhase;
      /** ISO timestamp the phase was entered — used for elapsed-in-phase display. */
      phaseStartedAt?: string;
      /** Currently-running subprocess command (e.g. `cargo build`), when set. */
      currentCommand?: string;
      /** ISO timestamp the subprocess started. */
      currentCommandStartedAt?: string;
      /**
       * Retry state, when the phase is `retrying`. Carried on the substate so
       * `list`/`active`/MCP say WHAT is being retried (attempt count, failure
       * class, latest error) rather than a bare `harness:retrying`.
       */
      retry?: RetrySummaryInput;
    }
  | {
      /**
       * The agent is BLOCKED inside a lazy tool call waiting on another task —
       * it is not doing work of its own. Distinguishing this from `agent` is the
       * whole point: an agent that decomposed its work into subtasks otherwise
       * looks identical to one that is thinking hard for twenty minutes.
       *
       * Derived from the daemon's own view of the in-flight blocking MCP call
       * (`waiting.json`, written by src/daemon/wait-registry.ts) — never from
       * agent output.
       */
      kind: 'waiting';
      /** Display labels of the tasks being waited on (code or short id). */
      targets: string[];
      /** ISO timestamp the earliest in-flight wait started. */
      since?: string;
    }
  | { kind: 'not-alive' };

/** Liveness inputs to the derivation, gathered from the runner + protocol dir. */
export interface LivenessContext {
  /** True when the supervisor run/pid is confirmed alive (`runner.isRunning`). */
  isAlive: boolean;
  /** True when a `response.json` is present (turn finished, reconcile imminent). */
  hasResponse: boolean;
  /**
   * In-flight blocking lazy-tool calls made BY this task, as recorded by the
   * daemon. Empty/absent means the agent is not blocked on anything.
   */
  waits?: WaitingEntry[];
}

/** Phases where the agent itself is the active thing. Everything else is harness work. */
const AGENT_PHASES: ReadonlySet<SupervisorPhase> = new Set<SupervisorPhase>([
  'work',
  'work_done',
]);

/**
 * Derive the working substate from a supervisor status snapshot and liveness.
 *
 * Pure function — all I/O happens in {@link computeWorkingSubstate}. Returns
 * `null` when no meaningful substate can be derived (e.g. the run is alive but
 * has not yet written a status.json), in which case callers should fall back to
 * a plain `working` with no substate.
 *
 * Caller contract: only invoke for tasks whose status is `working`.
 */
export function deriveWorkingSubstate(
  status: SupervisorStatus | null,
  ctx: LivenessContext,
): WorkingSubstate | null {
  // INVARIANT: asking-a-question is an agent substate, not harness — the agent
  // itself is active during the turn while it drafts a response.
  if (ctx.isAlive) {
    // Alive but no checkpoint yet (container still starting up) — degrade to no
    // substate rather than guessing.
    if (!status) return null;
    if (AGENT_PHASES.has(status.phase)) {
      // PRECEDENCE: waiting is the most specific thing we can say about an
      // agent-phase turn — the agent is provably parked inside a lazy tool call
      // right now — so it outranks the ask/pre-accept flavors, which describe
      // what the turn IS rather than what it is doing this second.
      const waiting = deriveWaiting(ctx.waits);
      if (waiting) return waiting;
      if (status.command_type === 'ask') return { kind: 'agent', answering: true };
      if (status.command_type === 'pre_accept') return { kind: 'agent', preAccept: true };
      return { kind: 'agent' };
    }
    // A harness phase outranks any lingering wait marker: the supervisor, not
    // the agent, is the active thing, so `harness:<phase>` is the more useful
    // (and more current) answer.
    return {
      kind: 'harness',
      phase: status.phase,
      phaseStartedAt: status.phase_started_at ?? status.updated_at ?? status.started_at,
      currentCommand: status.current_command,
      currentCommandStartedAt: status.current_command_started_at,
      retry: status.phase === 'retrying'
        ? {
            retryCount: status.retryCount,
            errors: status.errors,
            retry_failure_class: status.retry_failure_class,
          }
        : undefined,
    };
  }

  // Run not alive. A present response means the turn finished and reconciliation
  // is imminent — a finishing task, NOT a stranded one. Degrade to no substate
  // so we don't flag a healthy completion as not-alive.
  if (ctx.hasResponse) return null;

  // No live run and no response: a genuine stranded-completion candidate.
  return { kind: 'not-alive' };
}

/**
 * Fold the in-flight wait set into a `waiting` substate, or null when nothing is
 * in flight. Labels are deduped and ordered by wait start so the oldest thing
 * being waited on is named first.
 */
function deriveWaiting(waits: WaitingEntry[] | undefined): WorkingSubstate | null {
  if (!waits || waits.length === 0) return null;
  const ordered = [...waits].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  const targets: string[] = [];
  for (const wait of ordered) {
    for (const label of wait.labels ?? []) {
      if (label && !targets.includes(label)) targets.push(label);
    }
  }
  return { kind: 'waiting', targets, since: ordered[0]?.started_at };
}

/**
 * Read the supervisor `status.json` (async) for substate derivation and for any
 * other read surface that needs the raw checkpoint without pulling in the sync
 * `readStatus` from the protocol layer.
 *
 * Distinguishes "missing" (ENOENT — normal: container hasn't checkpointed, or
 * status was cleared) from "found but broken" (corrupt JSON — logged as a
 * warning so it's visible, but still degrades to null rather than crashing a
 * read command). Async — never blocks the daemon event loop.
 */
export async function readSupervisorStatusAsync(protoDir: string): Promise<SupervisorStatus | null> {
  const filePath = join(protoDir, 'status.json');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn(`working-substate: failed to read ${filePath}: ${(err as Error).message}`);
    return null;
  }
  try {
    return JSON.parse(raw) as SupervisorStatus;
  } catch (err) {
    logger.warn(`working-substate: corrupt status.json at ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

/** Whether a `response.json` exists in the protocol dir (turn finished). */
async function responseExists(protoDir: string): Promise<boolean> {
  try {
    await stat(join(protoDir, 'response.json'));
    return true;
  } catch {
    // Missing response is the normal case (turn still in progress) — not an error.
    return false;
  }
}

/**
 * Read the protocol dir and derive the working substate in one call.
 *
 * This is the single I/O entry point — it reads `status.json` (async, logging
 * corruption) and checks for a `response.json`, then delegates classification to
 * {@link deriveWorkingSubstate}. Callers supply liveness from the runner.
 *
 * Only call for `working` tasks.
 */
export async function computeWorkingSubstate(
  protoDir: string,
  isAlive: boolean,
): Promise<WorkingSubstate | null> {
  const [status, hasResponse, waits] = await Promise.all([
    readSupervisorStatusAsync(protoDir),
    responseExists(protoDir),
    readActiveWaits(protoDir),
  ]);
  return deriveWorkingSubstate(status, { isAlive, hasResponse, waits });
}

/** Max error-snippet length inside a substate label (tighter than the watch header). */
const SUBSTATE_SNIPPET_MAX = 60;

/**
 * Format the inner label for a working substate (without the `working(...)`
 * wrapper), e.g. `agent`, `agent:answering`, `harness:post_turn_check (3m00s)`,
 * `harness:post_turn_check cargo build (3m00s)`,
 * `harness:retrying attempt 7 (transient_overload): API 529 overloaded (47s)`,
 * `waiting on fix-foo (2m10s)`, `not-alive`.
 *
 * `now` is injectable for deterministic tests.
 */
export function formatWorkingSubstate(
  substate: WorkingSubstate,
  now: Date = new Date(),
): string {
  switch (substate.kind) {
    case 'agent':
      if (substate.answering) return 'agent:answering';
      if (substate.preAccept) return 'agent:pre-accept';
      return 'agent';
    case 'waiting': {
      // Name what is being waited on when we cheaply can — "waiting" alone
      // leaves the reader with the same "on what?" question the substate exists
      // to answer. Long fan-outs are summarized rather than listed, because this
      // label sits inside a `working(...)` cell in list/active output.
      let label = 'waiting';
      const [first, second, ...rest] = substate.targets;
      if (first && second) {
        label += rest.length > 0
          ? ` on ${first}, ${second} +${rest.length}`
          : ` on ${first}, ${second}`;
      } else if (first) {
        label += ` on ${first}`;
      }
      const elapsed = elapsedFrom(substate.since, now);
      if (elapsed !== null) label += ` (${elapsed})`;
      return label;
    }
    case 'not-alive':
      return 'not-alive';
    case 'harness': {
      let label = `harness:${substate.phase}`;
      if (substate.currentCommand) {
        label += ` ${substate.currentCommand}`;
      }
      // `harness:retrying` alone reads as "stuck for unknown reasons" — say
      // which attempt this is and what failed. Snippet is kept short because
      // this label sits inside a `working(...)` cell in list/active output.
      const retry = formatRetrySummary(substate.retry, SUBSTATE_SNIPPET_MAX);
      if (retry) label += ` ${retry}`;
      const elapsed = elapsedFrom(substate.phaseStartedAt, now);
      if (elapsed !== null) label += ` (${elapsed})`;
      return label;
    }
  }
}

/**
 * Render the full status word for a `working` task, decorated with its substate:
 * `working(agent)`, `working(harness:post_turn_check (3m00s))`,
 * `working(not-alive)`. When no substate is available, returns plain `working`.
 */
export function renderWorkingStatus(
  substate: WorkingSubstate | null | undefined,
  now: Date = new Date(),
): string {
  if (!substate) return 'working';
  return `working(${formatWorkingSubstate(substate, now)})`;
}
