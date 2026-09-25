/**
 * Restart a quiescent `cluster` task when a child is added to it.
 *
 * THE EXCEPTION, STATED PLAINLY. "A lazy comment never starts a turn"
 * (CLAUDE.md) still holds — nothing here reads comments, and no comment
 * surface emits anything. What starts the turn is a change in the TREE: a task
 * whose parent is a blocked cluster appeared, and the cluster is the thing whose
 * only job is to run its children. A cluster that sat blocked until a human
 * noticed and unblocked it would make "add a task to the cluster" a two-step
 * action with an invisible second step.
 *
 * It is deliberately narrow:
 *   - `cluster` tasks only. No other type is ever restarted this way.
 *   - Only while the cluster is BLOCKED. A working driver needs no nudge; it
 *     re-reads its own subtree every cycle.
 *   - Never a cluster somebody STOPPED. See below.
 *   - Only for children the driver's OWN agent did not create. A driver that
 *     spawns its own subtasks would otherwise wake itself forever, one turn per
 *     child.
 *   - Under the ordinary auto-react budget (via autoUnblockTask), like every
 *     other daemon-initiated turn. Once that budget is spent the cluster simply
 *     stays blocked until a human unblocks it, which resets the counters.
 *
 * A DELIBERATELY STOPPED CLUSTER STAYS STOPPED. `lazy stop` / `lazy_stop` is how
 * a human, the builder, or a parent agent says "this one is not to run until I
 * say so" — it parks the task in `blocked` and sets `user_stopped` on the
 * session. This path did not consult it, so the one state that means "do not
 * start this" was also the state a new child restarted, and stopping a cluster
 * that was still being handed work did nothing. The gate is `isUserStopped`
 * (src/task/user-stop.ts).
 *
 * The paths that consult it are countable, and this is one of eight: the
 * reconciler's fast auto-resume lane (`maybeAutoResume`), its daemon-restart
 * interrupt path (a restart must not undo a human's stop), the slow lane's queue
 * (`listSlowLaneQueue`, the set `processAutoResumeQueue` draws from), here,
 * auto-delivery's `upstream_change` and `ci_result` paths (`./auto-deliver.ts`),
 * the replay of a subtask start the usage pause held (`processHeldStart` in
 * `./usage-pause.ts`), and the wake of that start's parked parent
 * (`processParentWake`, same file). Those deliveries leave their signals queued while the
 * gate is set, so an explicit resume can receive them later.
 *
 * The arrival is not lost when the gate fires: the same message the restart
 * would have carried is written as a COMMENT on the cluster, which is delivered
 * in the prompt of the next `lazy unblock`, whoever sends it. Once per child,
 * because the watermark advances on a successful write exactly as it does on a
 * successful launch. Children REMOVED from a cluster need nothing here: they are
 * terminal, so they never enter the fresh set, and the parent-child tap has
 * already posted `[Subtask removed]` on the cluster
 * (src/task/notify-parent-children.ts).
 *
 * HOW LONG THE EXEMPTION LASTS: until the cluster's next COMPLETED TURN, whoever
 * started it. `user_stopped` is cleared by `resetConsecutiveInterruptions`, and
 * the `actor === 'human'` conditions on unblock and resume
 * (src/daemon/task-lifecycle.ts) decide only who clears it EAGERLY, at launch.
 * Every completion path calls it unconditionally afterwards — a work turn
 * (src/utils/reconcile.ts, the completed-turn recorder), a sync turn (same
 * file), `recordAskCompletedTurn`, `recordReviewCompletedTurn` and
 * `recordWrapUpSettle`. So a BUILDER or AGENT unblock does restart the cluster
 * and does end the exemption; it just ends it one turn later than a human's
 * would. (Stranded-completion recovery clears it too, but is gated on
 * `isClusterTask` first, so it never applies to a cluster.)
 *
 * A READ-ONLY VISITOR IS ENOUGH, which is the surprising part. `lazy ask`
 * requires `blocked` or `conflict` and `lazy_review` requires one of blocked /
 * conflict / submitted / interrupted — exactly the states a stopped cluster sits
 * in — and both record a completed turn, so asking a stopped cluster a question
 * or running a review on it lifts the stop, with nobody having resumed anything.
 * Note that stopping an in-flight ask or review deliberately does NOT set
 * `user_stopped` (see `stopClaimedTurn`), so the asymmetry runs one way only.
 * Not changed here — it is auto-resume's semantics for every task type, not the
 * cluster restart's — but stated because a reader who stops a cluster and then
 * asks it a question will otherwise not believe what the daemon does next.
 *
 * DERIVED, NOT EMITTED. There is no `child_added` signal row, even though
 * `parent-child-tap.ts` does give the daemon a write-side chokepoint for
 * "a task gained a subtask". That tap is the right place to hang the
 * `[Subtask added]` COMMENT: a comment is written once and can be retried from
 * a queue if it fails. Starting a TURN is a different problem:
 *
 *   - A missed emit is permanent. A failed comment gets re-posted by the sweep;
 *     a turn that was never started is never started. Anything that reaches
 *     storage another way — a daemonless CLI writing FileStorage directly, a
 *     child created while the daemon was down, a surface written later — is
 *     invisible to the tap but plainly visible in the tree afterwards.
 *   - The decision is not available at the write. When `createTask` runs, the
 *     cluster is still `working`; whether it needs waking depends on where its
 *     turn got to, which is only knowable later.
 *
 * So the daemon compares the tree — the source of truth for a cluster's
 * children, the same rule the driver itself is given — against a per-cluster
 * watermark. That is idempotent across daemon restarts for free.
 */

import type { Storage } from '../storage';
import type { Task, Turn } from '../types';
import { isClusterTask, isTerminalStatus } from '../types';
import { displayId, shortId } from '../task/identity';
import { quotedOneLine } from '../task/notify-parent-children';
import { isUserStopped } from '../task/user-stop';
import { logger } from '../utils/logger';
import { autoUnblockTask } from './auto-deliver';

/**
 * Task metadata: children created at or before this epoch-ms mark have already
 * been delivered to the cluster. Written only after a successful restart.
 *
 * The stored key still says `loop` — the type's name before 2026-09-20. It is
 * private bookkeeping nothing outside this module reads, and renaming it would
 * silently reset every live cluster's watermark, so it stays as written.
 */
export const CLUSTER_CHILDREN_SEEN_KEY = 'loop_children_seen_through';

async function readWatermark(storage: Storage, clusterId: string): Promise<number> {
  const raw = await storage.getTaskMetadata(clusterId, CLUSTER_CHILDREN_SEEN_KEY);
  if (!raw) return 0;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Everything that existed AT `seenAt` has been accounted for.
 *
 * The caller passes a mark taken BEFORE it read the tree, never `Date.now()`
 * from in here: see {@link restartClusterForAddedChildren} for the child this
 * otherwise loses.
 */
async function markClusterChildrenSeen(
  storage: Storage,
  clusterId: string,
  seenAt: number,
): Promise<void> {
  await storage.updateTaskMetadata(clusterId, CLUSTER_CHILDREN_SEEN_KEY, String(seenAt));
}

/**
 * Does this turn START a turn the driver takes, as opposed to being recorded
 * DURING one?
 *
 * INVARIANT: only a WORK turn raises the floor below. Every launch —
 * `lazy start`, `lazy unblock`, and auto-delivery's own synthetic prompt —
 * records a `human`-role turn with no explicit type, which storage reads as
 * `work`. Everything else with `role: 'human'` is written while the driver's
 * turn is still open: a self-sync step (`recordSelfSyncTurn`, actor
 * `supervisor`, type `sync`), an ask, a review, a supervisor nudge.
 *
 * THIS IS THE BUG THE PREDICATE EXISTS TO FIX, and it cost two hand-unblocks on
 * 2026-09-19. The floor was the latest `human`-role turn of ANY type, and step 7
 * of the driver's contract makes it sync ITSELF mid-turn — which writes exactly
 * such a turn. So a child added at 10:00, to a driver whose turn ran 09:50–11:00
 * and self-synced at 10:30, sat BELOW a floor of 10:30 by the time the driver
 * parked: not "news", the candidate list came back empty, and the watermark then
 * advanced past it. The child was buried for good and the driver reported itself
 * finished with a task it never ran.
 */
function startsADriverTurn(turn: Turn): boolean {
  return !turn.turn_type || turn.turn_type === 'work';
}

/**
 * The floor for "new": the later of the last delivery and the START of the
 * cluster's most recent WORK turn.
 *
 * The turn start is what makes the first block work without a stored mark —
 * children the cluster was created with predate its turn and are not news, while
 * a child added DURING that turn is, even if the driver blocked a moment later.
 * That is the race the engineer asked about ("driver lists children, sees none
 * left, blocks; a child is added in between"), and this closes it: the child
 * sits above the floor, so the next reconcile tick picks it up. The cost when
 * the driver did see the child is one short extra turn.
 *
 * Falling back to the task's own creation time (no session, no turns) is the
 * safe direction: it can only over-report, and over-reporting costs a turn
 * while under-reporting loses work the human handed to the cluster.
 */
async function turnStartFloor(storage: Storage, cluster: Task): Promise<number> {
  const session = await storage.getSessionByTaskId(cluster.id);
  let lastTurnAt = 0;
  if (session) {
    const turns = await storage.getSessionTurns(session.id);
    // The turn's START, which is the prompt turn (`human` role — a launch, an
    // unblock, a system delivery), never the agent's answer and never a turn
    // recorded mid-flight. The answer is recorded when the turn ENDS, and using
    // it would put the floor above every child added while the agent was still
    // running: precisely the race. See startsADriverTurn for the mid-flight
    // half, which is the same race arriving by a different route.
    lastTurnAt = turns
      .filter(t => t.role === 'human' && startsADriverTurn(t))
      .reduce((max, t) => Math.max(max, t.timestamp), session.started_at);
  }
  return lastTurnAt === 0 ? cluster.created_at : lastTurnAt;
}

/**
 * Was this child created by the cluster's own agent?
 *
 * The creating actor is the actor on the task's first status-changelog entry.
 * An `agent` actor under a cluster parent can only be the driver itself:
 * `lazy_create` refuses to create anywhere but under the caller's own task.
 *
 * Read only for children that already passed the timestamp filter, so the usual
 * cost of this check per tick is zero reads.
 */
async function createdByOwnAgent(storage: Storage, child: Task): Promise<boolean> {
  try {
    const history = await storage.getStatusHistory(child.id);
    const first = history.reduce<{ timestamp: number; actor?: string } | null>(
      (oldest, entry) => (!oldest || entry.timestamp < oldest.timestamp ? entry : oldest),
      null,
    );
    return first?.actor === 'agent';
  } catch (err) {
    // Unreadable history is not proof of anything. Treat the child as
    // externally added: a spurious extra turn is a far smaller failure than a
    // cluster that never hears about a task the human gave it.
    logger.debug(
      `cluster-restart: could not read status history for ${shortId(child.id)}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Children added to `cluster` that it has not been told about: created after both
 * the watermark and {@link turnStartFloor}, not already finished, and not
 * created by the driver's own agent.
 *
 * COST. This runs for every blocked cluster on every reconcile tick, so the
 * steady state — a cluster whose children are all older than its watermark — must
 * be one metadata read and one child listing, and nothing else. That is why
 * EVERY empty result advances the watermark, including the one where the
 * own-agent filter emptied the list: a driver that created its own dozen
 * children during its last turn is the ordinary shape, and without the advance
 * each of those children looks like a candidate forever, so every tick pays for
 * the session, the whole turn list and a status history per child, indefinitely.
 * Advancing on an empty result cannot hide anything — those children were just
 * evaluated and found not to be news.
 *
 * `seenAt` is taken by the CALLER, BEFORE it reads anything. See
 * {@link restartClusterForAddedChildren}.
 */
export async function freshClusterChildren(
  storage: Storage,
  cluster: Task,
  seenAt: number = Date.now(),
): Promise<Task[]> {
  const watermark = await readWatermark(storage, cluster.id);
  const children = await storage.getChildTasks(cluster.id);
  const recent = children.filter(
    c => c.created_at > watermark && !isTerminalStatus(c.status),
  );
  if (recent.length === 0) return [];

  // Only now is the expensive floor worth resolving.
  const since = Math.max(watermark, await turnStartFloor(storage, cluster));
  const candidates = recent.filter(c => c.created_at > since);
  if (candidates.length === 0) {
    await markClusterChildrenSeen(storage, cluster.id, seenAt);
    return [];
  }

  const fresh: Task[] = [];
  for (const child of candidates) {
    if (!(await createdByOwnAgent(storage, child))) fresh.push(child);
  }
  if (fresh.length === 0) {
    // Every candidate was the driver's own work. Same argument as above: they
    // were evaluated and are not news, so do not re-read them next tick.
    await markClusterChildrenSeen(storage, cluster.id, seenAt);
  }
  return fresh;
}

/**
 * What the cluster is told about children that arrived while it was away.
 *
 * One builder for both endings — the restart's prompt and the stopped cluster's
 * comment — so the driver reads the same sentence whichever way it picks the
 * children up.
 *
 * A child's goal is whatever the person or agent that created it typed, and
 * here it reaches another agent's prompt: rendered through `quotedOneLine`, so
 * it is one bounded line, marked as somebody else's words, and unable to forge
 * the `--- END OF NOTES ---` terminator of the block the comment path lands in.
 */
function addedChildrenMessage(fresh: Task[]): string {
  const list = fresh
    .map(c => `- ${displayId(c)} (${c.status}): ${quotedOneLine(c.goal)}`)
    .join('\n');
  const noun = fresh.length === 1 ? 'child was' : 'children were';
  return (
    `${fresh.length} new ${noun} added to this cluster since your last turn:\n\n${list}\n\n` +
    `Pick the cycle back up: re-read your subtree (lazy_list on this task) — it is the ` +
    `source of truth, not this message — and decide what can run now. ` +
    `You may run as many children at once as your own judgement allows.`
  );
}

/** Opening words of the note left on a stopped cluster instead of restarting it. */
export const STOPPED_CLUSTER_NOTICE_PREFIX = '[Cluster children added while stopped]';

/**
 * Record the arrival on a cluster that is not to be restarted, and return whether
 * it landed.
 *
 * A comment, not a turn — which is the ordinary contract for every other
 * surface in lazy ("a lazy comment never starts a turn"), and exactly what the
 * human asked for by stopping the cluster. The driver is given it when somebody
 * picks it up with `lazy unblock`, under `NOTES ADDED SINCE YOUR LAST TURN`.
 *
 * The watermark advances only on a successful write, so a failed comment is
 * retried on the next tick rather than lost.
 *
 * IT OVERLAPS THE TAP'S `[Subtask added]` NOTE, AND THAT IS THE CHOICE. The
 * parent-child tap has already recorded each child as a one-line fact at the
 * moment it appeared; this says what the driver is to DO about them, in the
 * words the restart would have used. Two short notes per arrival, only ever for
 * a stopped cluster. Folding them into one was considered and rejected both ways:
 * the tap is generic to every parent and its note is deliberately one line, so
 * the instruction does not belong there; and dropping the child list from here
 * would make this notice depend on a sibling note that may still be queued for
 * the retry sweep, and would strip the goals from the RESTART prompt too, which
 * shares this builder and has no other source for them.
 */
async function recordArrivalsForStoppedCluster(
  storage: Storage,
  cluster: Task,
  fresh: Task[],
  seenAt: number,
): Promise<boolean> {
  try {
    await storage.createComment(
      cluster.id,
      `${STOPPED_CLUSTER_NOTICE_PREFIX} ${addedChildrenMessage(fresh)}`,
      'system',
    );
  } catch (err) {
    logger.warn(
      `cluster-restart ${shortId(cluster.id)}: stopped cluster, but could not record ` +
        `${fresh.length} added child(ren): ${err instanceof Error ? err.message : err} — ` +
        `will retry on the next tick`,
    );
    return false;
  }
  // The mark gets its own guard: by here the note is already posted, so letting
  // this throw would leave the side effect done and the bookkeeping undone, and
  // the throw would surface only as a debug line in the caller's catch. Both
  // halves report the same way, and the message says what the operator will
  // actually see — the note repeating — rather than just naming the error.
  try {
    await markClusterChildrenSeen(storage, cluster.id, seenAt);
  } catch (err) {
    logger.warn(
      `cluster-restart ${shortId(cluster.id)}: noted ${fresh.length} added child(ren) but could ` +
        `not advance the seen mark: ${err instanceof Error ? err.message : err} — ` +
        `the note will be posted again on the next tick until this write succeeds`,
    );
    return false;
  }
  logger.info(
    `cluster-restart ${shortId(cluster.id)}: stopped by user — not restarting; noted ` +
      `${fresh.length} added child(ren) for whoever resumes it: ` +
      fresh.map(c => displayId(c)).join(', '),
  );
  return true;
}

/**
 * Restart `cluster` if children were added to it while it was blocked.
 *
 * Returns true when a turn was launched. The watermark advances only on a
 * successful launch, so a delivery that was refused — budget spent, worktree
 * locked, runner down — is retried on the next tick rather than lost.
 *
 * Returns FALSE, having launched nothing, for a cluster somebody stopped: the
 * arrival is written as a comment instead and the cluster stays stopped until a
 * human picks it up. See the module docstring.
 *
 * THE MARK IS TAKEN BEFORE THE READ, not after the launch. `autoUnblockTask`
 * performs a real launch — worktree checks, container, prompt assembly — which
 * takes seconds, and a mark stamped afterwards silently covers everything added
 * during it: operator adds A, the tick starts waking the cluster, operator adds B
 * three seconds later, the launch returns and the watermark jumps past B. B then
 * sits below both the watermark and the new turn's prompt timestamp, so no later
 * tick ever sees it and the driver reports itself finished with a child it never
 * ran. Taking the mark first can only re-report a child (one cheap turn), which
 * is the direction this module chooses everywhere.
 */
export async function restartClusterForAddedChildren(
  storage: Storage,
  cluster: Task,
  lazyRoot: string,
): Promise<boolean> {
  if (!isClusterTask(cluster) || cluster.status !== 'blocked') return false;

  const seenAt = Date.now();
  const fresh = await freshClusterChildren(storage, cluster, seenAt);
  if (fresh.length === 0) return false;

  const session = await storage.getSessionByTaskId(cluster.id);
  if (!session) {
    logger.debug(`cluster-restart ${shortId(cluster.id)}: no session, skipping`);
    return false;
  }

  // Read AFTER the fresh check, never before: the steady state of this function
  // is one metadata read and one child listing (see freshClusterChildren), and a
  // session read on every blocked cluster on every tick would undo that.
  if (isUserStopped(session)) {
    await recordArrivalsForStoppedCluster(storage, cluster, fresh, seenAt);
    return false;
  }

  const launched = await autoUnblockTask(
    storage,
    cluster,
    session,
    lazyRoot,
    addedChildrenMessage(fresh),
    'child_added',
  );
  if (launched) {
    await markClusterChildrenSeen(storage, cluster.id, seenAt);
    logger.info(
      `cluster-restart ${shortId(cluster.id)}: restarted for ${fresh.length} added child(ren): ` +
        fresh.map(c => displayId(c)).join(', '),
    );
  }
  return launched;
}
