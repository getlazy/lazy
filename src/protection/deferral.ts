/**
 * Where a task's protected-file questions are ASKED — at its own accept, or at
 * its parent's.
 *
 * ## The rule
 *
 * An AGENT-AUDIENCE task with a live parent is not asked about its protected
 * files at all: every one of them is DEFERRED to the parent's accept. Every
 * subtask of a cluster is agent-audience (src/task/audience.ts), so a cluster's
 * children are the case this exists for; a subtask an ordinary task's agent
 * created and started is the other.
 *
 * ## Why — the question at the child's accept was never a human's
 *
 * Its accept is made by the parent's AGENT (a cluster's driver), so the only
 * "approval" it could record is that agent's. The parent's resolver already
 * refuses to count it: an agent-audience child's approvals never join the
 * parent's approved set, and its attributed paths WIDEN the parent's scan
 * (outstanding-resolver.ts, final-turn design §4.2). So the question is asked
 * at the parent's accept whatever happened below, and gating the child on it
 * only bought a second, meaningless decision — which drivers took for an
 * engineer's to make. They parked finished children "awaiting engineer
 * approval of protected test files", raised blocking items for it, and held
 * back the siblings that build on them, which is the opposite of what a
 * cluster is for: the work carries on, and the engineer decides once, on the
 * whole of it, at the cluster (engineer, 2026-10-04).
 *
 * INVARIANT: this predicate and the parent's "which children defer here" read
 * (`childContributionsFor`) ask the SAME question — `audienceOf` over the
 * child's turns, its creation actor and whether its parent is a cluster. If
 * they ever disagreed, a child could skip its own question while the parent
 * treated it as already decided, and a protected change would merge with
 * nobody having been asked. That is why deferral is keyed on audience and on
 * nothing else (not on who is accepting, not on the task type).
 *
 * ## When it does NOT defer — the conservative direction
 *
 * - **No parent.** A top-level task's accept merges into a real branch; there
 *   is nobody further up to ask.
 * - **A parent that is finished or unreadable.** A parent that will never be
 *   accepted again cannot ask anything. Accept and close reparent their
 *   children, so this is a guard, not the normal path.
 * - **A human-audience task** (a person or the builder launched it, and its
 *   parent is not a cluster). A person reads it, so it is asked where it is
 *   accepted, and that approval does join its parent's answer.
 * - **Anything unreadable** answers "not deferred": the task is asked at its
 *   own accept, which over-asks and never merges a change unseen.
 *
 * The chain composes: an agent-audience parent of an agent-audience child
 * defers again at ITS accept, so the question travels up to the first
 * human-audience ancestor — normally the cluster — and is asked there.
 */

import type { Storage } from '../storage/interface';
import type { Task, Turn } from '../types';
import { isClusterTask } from '../types';
import { isTerminalStatus } from '../task-state-machine';
import { audienceOf, createdByOf } from '../task/audience';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';

/** The task whose accept asks this task's protected-file questions. */
export interface ProtectedFileDeferral {
  /** The parent's full id. */
  taskId: string;
  /** The parent as people name it (code, or short id). */
  displayId: string;
}

/**
 * The parent this task's protected-file questions are deferred to, or null
 * when the task is asked at its own accept. Never throws.
 */
export async function resolveProtectedFileDeferral(
  storage: Pick<Storage, 'getTask' | 'getStatusHistory'>,
  task: Pick<Task, 'id' | 'target'>,
  turns: readonly Pick<Turn, 'role' | 'actor'>[],
): Promise<ProtectedFileDeferral | null> {
  // Read defensively, like parentIsClusterOf: no target is no parent.
  const parentId = task.target?.kind === 'task' ? task.target.parentTaskId : null;
  if (!parentId) return null;
  try {
    const parent = await storage.getTask(parentId);
    if (!parent || isTerminalStatus(parent.status)) return null;
    const audience = audienceOf({
      turns,
      createdBy: await createdByOf(storage, task),
      parentIsCluster: isClusterTask(parent),
    });
    if (audience !== 'agent') return null;
    return { taskId: parent.id, displayId: displayId(parent) };
  } catch (err) {
    logger.debug(
      `Task ${task.id.substring(0, 8)}: could not decide protected-file deferral ` +
      `(${err instanceof Error ? err.message : err}); asking at its own accept.`,
    );
    return null;
  }
}

/**
 * The accept's one-line notice that protected files went up undecided, naming
 * where they will be asked next. Not "where a person decides": an
 * agent-audience parent defers them again, so the honest claim is the next
 * step up and no further. Shared by every accept surface through the
 * preflight's warnings.
 */
export function deferredProtectedFilesNotice(
  files: readonly string[],
  deferredTo: ProtectedFileDeferral,
): string {
  return (
    `${files.length} protected file change(s) not decided here — they are asked at ` +
    `${deferredTo.displayId}'s own accept, or further up if that task defers them too: ${files.join(', ')}`
  );
}
