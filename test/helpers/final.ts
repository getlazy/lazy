import type { TestContext } from './setup';
import { readSessionJson, readTaskJson, readTurns, writeTurns } from './storage';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';

/**
 * Record that this task's work turn was launched by an AGENT — the record an
 * MCP-originated start (`src/daemon/task-launcher.ts`) writes: a launching
 * `role: 'human'` turn whose `actor` is `agent`.
 *
 * Fixture setup for suites whose SUBJECT is AUDIENCE (final-turn design
 * §13.3): audience is derived from the last launching-actor turn, so a task
 * seeded this way resolves to agent-audience — whose final runs NO wrap-up
 * steps at all (§3.2: no protected-file push-back, no maintained-file nudge,
 * no presentation), and whose protected files defer to the hub's final (§4.2).
 *
 * Same mechanics as seedFinal — append-only on a SETTLED task, never mid-turn.
 */
export function markAgentLaunched(ctx: TestContext, taskId: string): void {
  const root = ctx.root;
  const session = readSessionJson(root, taskId);
  if (!session?.id) {
    throw new Error(`markAgentLaunched: task ${taskId} has no session.json — seed after start`);
  }
  const turns = readTurns(root, taskId);
  const nextSeq = turns.reduce((max, t) => Math.max(max, (t.sequence as number | undefined) ?? 0), 0) + 1;
  const now = Date.now();
  turns.push({
    id: `seeded-agent-launch-${now}-${nextSeq}`,
    session_id: session.id as string,
    sequence: nextSeq,
    role: 'human',
    content: '[agent] Work launched by the parent task\'s agent',
    timestamp: now,
    usage: undefined,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    turn_type: 'work',
    actor: 'agent',
  });
  writeTurns(root, taskId, turns);
}

/**
 * Record a standing final WITHOUT running any turn — the storage-level seed,
 * the fixture for suites whose SUBJECT is something other than finality,
 * daemonless or daemon-backed alike.
 *
 * ACCEPT NO LONGER NEEDS THIS. A final gates nothing: accept works from any
 * normal park, with the blocking items resolved in the same call. The seed is
 * kept for the suites where a STANDING FINAL is genuinely part of the setup —
 * the auto-review dispatch, the "head has since moved" label, the un-final
 * predicate — and a call in a suite about something else is a leftover, not a
 * requirement. Removing one should never change that suite's outcome.
 *
 * Appends a final-carrying turn to the task's turns.json, the same record the
 * reconciler persists `Turn.final` onto when an agent declares mid-turn.
 *
 * Safe on a SETTLED task in either mode — between turns, with no agent
 * running: the daemon derives every later turn's sequence from turns.json at
 * write time (`FileStorage.getNextTurnSequence` / `reserveTurnSequences` take
 * max(existing, reserved) + 1), so a turn appended while the task is settled
 * is seen and skipped by the next writer. The one hazard is
 * seeding while a turn is IN FLIGHT — a sequence the daemon has promised but
 * not yet written (`reserved_turn_sequence`) would collide with the seed. So:
 * seed after `startAndWait`/`startAndReconcile` has settled the task and
 * before the next turn starts, never mid-turn. (writeTurns also bypasses the
 * daemon's storage lock, which is the same precondition stated the other way
 * around.)
 */
export function seedFinal(ctx: TestContext, taskId: string): void {
  const root = ctx.root;
  const session = readSessionJson(root, taskId);
  if (!session?.id) {
    throw new Error(`seedFinal: task ${taskId} has no session.json — seed after start`);
  }
  // Coded tasks live in worktrees/<task_ref>, not worktrees/<shortId>.
  const task = readTaskJson(root, taskId);
  const ref = (task.metadata?.task_ref as string | undefined) ?? taskId;
  const head = ctx.git('-C', join(root, '.lazy', 'worktrees', ref), 'rev-parse', 'HEAD').stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`seedFinal: no HEAD sha for ${taskId} in ${join(root, '.lazy', 'worktrees', ref)}`);
  }
  const turns = readTurns(root, taskId);
  const nextSeq = turns.reduce((max, t) => Math.max(max, (t.sequence as number | undefined) ?? 0), 0) + 1;
  const now = Date.now();
  turns.push({
    id: `seeded-final-${now}-${nextSeq}`,
    session_id: session.id as string,
    sequence: nextSeq,
    role: 'human',
    content: '[system] Final declared',
    timestamp: now,
    usage: undefined,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    turn_type: 'wrap_up',
    final: { sha: head, actor: 'human', at: now, wrap_up_steps: [] },
  });
  writeTurns(root, taskId, turns);
}