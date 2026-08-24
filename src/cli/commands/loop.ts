import { requireLazyRoot, requireStorage, shortId, displayId, validateModel, parseFlags, formatDate, taskRef, getWorktreePath, getBranchNameFromId, resolveTaskOrExit } from '../helpers';
import { pendingViolations } from '../../utils/turns';
import { promptChoice, promptYesNo, isTTY } from '../editor';
import { commandStart } from './start';
import { runInteractiveReview } from '../tui/per-hunk-review';
import { queryWait } from '../../daemon/rpc-fallback';
import { normalizeTag } from '../../utils/tags';
import type { Task, TaskStatus } from '../../types';
import { commandAccept } from './accept';
import { commandReject } from './reject';
import { commandUnblock } from './unblock';
import { showTaskContext, runFeedbackFlow, syncTaskFromRemote } from './shared';
import { commandSyncTask } from './sync';
import { buildTaskTree, printTaskTree } from './list';

import { isTerminalStatus } from '../../types';
import { theme, dim } from '../theme';

import { ActivityMonitor } from '../activity-monitor';


import { cleanupWorktreeAndBranch, cleanupTaskContainer } from './shared';
import { getActor } from '../../constants';
import { parentTaskIdOf } from '../../task-target';

/** Maximum number of recent activity lines to display in the polling view. */
const MAX_ACTIVITY_LINES = 10;

/**
 * Rolling buffer of recent activity lines for display during polling.
 * Each entry includes a timestamp, task ID, and activity description.
 */
interface RecentActivityLine {
  timestamp: string;
  taskId: string;
  activity: string;
}

const recentActivity: RecentActivityLine[] = [];

/** Active activity monitors keyed by task short ID. */
const activeMonitors = new Map<string, ActivityMonitor>();

/**
 * Ensure activity monitors are running for all working tasks.
 * Stops monitors for tasks that are no longer working.
 */
function syncActivityMonitors(
  workingTaskIds: Map<string, { worktreePath: string; turnStartedAt?: string }>,
  runner: import('../../runner').Runner,
): void {
  // Start monitors for new working tasks
  for (const [taskShortId, info] of workingTaskIds) {
    if (!activeMonitors.has(taskShortId)) {
      const monitor = new ActivityMonitor(runner, info.worktreePath, taskShortId, info.turnStartedAt);
      monitor.start();
      activeMonitors.set(taskShortId, monitor);
    }
  }

  // Stop monitors for tasks that are no longer working
  for (const [taskShortId, monitor] of activeMonitors) {
    if (!workingTaskIds.has(taskShortId)) {
      monitor.stop();
      activeMonitors.delete(taskShortId);
    }
  }
}

/**
 * Drain activity from all monitors into the recent activity buffer.
 */
function drainActivityMonitors(): void {
  for (const [taskShortId, monitor] of activeMonitors) {
    const lines = monitor.drain();
    for (const line of lines) {
      recentActivity.push({
        timestamp: line.timestamp,
        taskId: taskShortId,
        activity: line.activity,
      });
    }
  }

  // Trim to max size
  while (recentActivity.length > MAX_ACTIVITY_LINES) {
    recentActivity.shift();
  }
}

/**
 * Stop all running activity monitors. Call when exiting the polling loop.
 */
function stopAllMonitors(): void {
  for (const [, monitor] of activeMonitors) {
    monitor.stop();
  }
  activeMonitors.clear();
}

/**
 * Handle interrupted tasks: prompt user to resume, close, or skip each one.
 * Interrupted tasks are those whose agent crashed or container died unexpectedly.
 */
async function handleInterruptedTasks(
  storage: Awaited<ReturnType<typeof requireStorage>>,
  root: string,
  skippedIds: Set<string>,
  modelOverride: any,
  follow: boolean,
): Promise<void> {
  const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true, withSessionsOnly: true });

  // Filter to tasks not already skipped this session, with active sessions
  const reviewable: typeof interruptedTasks = [];
  for (const task of interruptedTasks) {
    if (skippedIds.has(task.id)) continue;
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess && !sess.ended_at) {
      reviewable.push(task);
    }
  }

  if (reviewable.length === 0) return;

  // Sort by last_interaction_at ASC (oldest-waiting first)
  const tasksWithSessions = await Promise.all(
    reviewable.map(async (task) => ({
      task,
      session: (await storage.getSessionByTaskId(task.id))!,
    }))
  );
  tasksWithSessions.sort((a, b) => {
    const aTime = a.session.last_interaction_at ?? null;
    const bTime = b.session.last_interaction_at ?? null;
    if (aTime === null && bTime === null) return a.task.created_at - b.task.created_at;
    if (aTime === null) return -1;
    if (bTime === null) return 1;
    return (aTime - bTime) || (a.task.created_at - b.task.created_at);
  });

  // Process each interrupted task
  for (let i = 0; i < tasksWithSessions.length; i++) {
    const { task, session: sess } = tasksWithSessions[i];
    const taskShortId = shortId(task.id);
    const taskDisplayId = displayId(task);
    const worktreePath = getWorktreePath(root, task);

    console.log(`\n--- Interrupted Task ${i + 1} of ${tasksWithSessions.length}: ${taskDisplayId} ---`);

    // Show basic context
    console.log(`\nTask: ${taskDisplayId}`);
    console.log(`Goal: ${task.goal}`);
    console.log(`Status: interrupted  |  Last active: ${sess.last_interaction_at ? formatDate(sess.last_interaction_at) : 'unknown'}`);

    // Show recent commits if available
    let targetBranch: string;
    const parentId = parentTaskIdOf(task);
    if (parentId) {
      targetBranch = await getBranchNameFromId(parentId, storage);
    } else {
      targetBranch = 'main';
    }

    try {
      const { getBranchCommitMessages } = await import('../../git/operations');
      const commits = await getBranchCommitMessages(sess.git_branch, targetBranch, root);
      if (commits.length > 0) {
        const recent = commits.slice(0, 3);
        console.log(`\nRecent commits (${commits.length} total):`);
        for (const msg of recent) {
          console.log(`  ${msg}`);
        }
        if (commits.length > 3) {
          console.log(`  ... and ${commits.length - 3} more`);
        }
      }
    } catch {
      // Branch may not exist
    }

    console.log('');
    const menuOptions = [
      'Resume (restart agent)',
      'Reject task',
      'Skip (decide later)',
    ];

    const choice = await promptChoice('What would you like to do?', menuOptions);

    if (choice === 2) {
      // Skip
      skippedIds.add(task.id);
      continue;
    }

    if (choice === 0) {
      // Resume — restart the supervisor container and launch the agent
      // Pass --message to force imperative mode (launches agent immediately)
      // This is like unblock with a minimal feedback message.
      // After the agent finishes, the task will transition from working → blocked,
      // and the loop will pick it up again for review.
      await storage.close();
      const taskShortId = shortId(task.id);
      await commandUnblock([taskShortId, '--message', 'Resuming from interruption']);
      // Break out of interrupted tasks loop and let the main loop refresh storage
      // The task will be blocked and ready for review (or completed if agent finished)
      return;
    }

    if (choice === 1) {
      // Abandon — mark as abandoned and clean up
      console.log('Abandoning task...');
      try {
        // Mark as abandoned with reason
        await storage.abandonTask(task.id, 'Abandoned due to interruption', getActor());

        // Clean up worktree and branch
        try {
          await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root, storage, task.id, sess.agent_session_id);
        } catch (err) {
          // Log but don't fail — partial cleanup is acceptable
          console.error(`Warning: could not fully clean up worktree: ${err instanceof Error ? err.message : err}`);
        }

        // Clean up container
        try {
          await cleanupTaskContainer(storage, sess, taskRef(task), root);
        } catch (err) {
          console.error(`Warning: could not clean up container: ${err instanceof Error ? err.message : err}`);
        }

        console.log(`Task ${taskDisplayId} abandoned.`);
      } catch (err) {
        console.error(`Error abandoning task: ${err instanceof Error ? err.message : err}`);
      }

      skippedIds.add(task.id);
      continue;
    }
  }
}

// --- Queue mode (`lazy loop <task...>`) ---------------------------------
//
// Reactive mode (no positionals) reviews whatever happens to be blocked. Queue
// mode drives a curated, ordered list: start → wait → review gate → decide →
// next. See docs/design/loop-queue-mode.md for the full rationale, including
// why this deliberately persists NO loop state and takes NO locks (a builder
// must be able to run the same cycle over the same tasks).

/**
 * What the human chose at a review gate. Kept as data rather than inlined
 * branching so a future autonomy level (`--auto-accept-on-green`) can supply a
 * non-interactive decider without rewriting the loop body.
 */
type GateDecision = 'feedback' | 'deep-review' | 'accept' | 'reject' | 'sync' | 'skip' | 'stop';

/** What the loop should do with the current task after acting on a decision. */
type GateOutcome = 'advance' | 'regate' | 'stop';

/** Statuses that mean "the turn is not over yet — keep waiting". */
function isUnsettled(status: string): boolean {
  // `queued` is waiting for a concurrency slot, not a finished turn. The daemon
  // wait RPC returns immediately for it (it only polls `working`), so the loop
  // has to recognize it or it would gate a task that never ran.
  return status === 'working' || status === 'queued';
}

/**
 * Block until a task's turn is genuinely over.
 *
 * The daemon wait RPC is capped at 600s per request and returns immediately for
 * any non-`working` status, so a single call is not enough: re-issue on timeout
 * and on `queued`. Returns the settled status.
 */
async function waitUntilSettled(ref: string): Promise<TaskStatus> {
  const QUEUED_POLL_MS = 3000;
  let announcedQueued = false;
  while (true) {
    let result;
    try {
      result = await queryWait({ taskId: ref });
    } catch (err) {
      throw new Error(`Failed while waiting for ${ref}: ${err instanceof Error ? err.message : err}`);
    }

    if (result.timed_out) {
      console.log(dim(`  still working (${ref}) — continuing to wait…`));
      continue;
    }

    if (isUnsettled(result.status)) {
      if (result.status === 'queued') {
        // Announce once, then poll quietly — a queue wait can be long.
        if (!announcedQueued) {
          console.log(dim(`  ${ref} is queued for an agent slot — waiting…`));
          announcedQueued = true;
        }
        await new Promise(resolve => setTimeout(resolve, QUEUED_POLL_MS));
      }
      continue;
    }

    return result.status as TaskStatus;
  }
}

/**
 * Present the review gate for one task and return the human's decision.
 * Printing context and choosing are separate steps on purpose — see GateDecision.
 */
async function presentGate(
  storage: Awaited<ReturnType<typeof requireStorage>>,
  task: Task,
  sess: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof requireStorage>>['getSessionByTaskId']>>>,
  root: string,
  position: string,
): Promise<GateDecision> {
  const taskShortId = shortId(task.id);
  const taskLabel = displayId(task);
  const worktreePath = getWorktreePath(root, task);

  console.log(`\n--- ${position}: ${taskLabel} ---`);

  const turnCount = await storage.getTurnCountByTaskId(task.id);
  const unseenCount = await showTaskContext(
    taskShortId,
    task.goal,
    task.status,
    turnCount,
    sess.git_branch,
    worktreePath,
    root,
    parentTaskIdOf(task),
    storage,
    task.id,
    sess.id,
    taskLabel,
  );

  const acceptLabel = unseenCount > 0
    ? `Accept anyway (agent hasn't seen ${unseenCount} comment${unseenCount === 1 ? '' : 's'})`
    : 'Accept (merge work)';
  const feedbackLabel = unseenCount > 0
    ? 'Give feedback - includes unseen comments (recommended)'
    : 'Give feedback (open editor)';

  const menu: Array<[string, GateDecision]> = [
    [feedbackLabel, 'feedback'],
    ['Review hunk-by-hunk (lazy review -i)', 'deep-review'],
    [acceptLabel, 'accept'],
    ['Reject (discard work)', 'reject'],
    ['Sync upstream (lazy sync)', 'sync'],
    ['Skip (leave as-is, move to next task)', 'skip'],
    ['Stop the loop', 'stop'],
  ];

  const choice = await promptChoice('What would you like to do?', menu.map(([label]) => label));
  return menu[choice][1];
}

/**
 * Act on a gate decision. Storage must already be closed — every delegate
 * (accept/reject/sync/unblock) opens its own.
 *
 * Returns whether the loop should advance to the next task, re-gate the same
 * task (feedback sends it back to `working`), or stop.
 */
async function executeGateDecision(
  decision: GateDecision,
  task: Task,
  root: string,
  follow: boolean,
  modelOverride: string | undefined,
): Promise<GateOutcome> {
  const taskShortId = shortId(task.id);

  switch (decision) {
    case 'skip':
      return 'advance';

    case 'stop':
      return 'stop';

    case 'accept':
      await commandAccept([taskShortId]);
      return 'advance';

    case 'reject':
      await commandReject([taskShortId]);
      return 'advance';

    case 'sync':
      await commandSyncTask([taskShortId]);
      // Sync changes the worktree, not the decision — come back to the gate.
      return 'regate';

    case 'deep-review': {
      // Reuse `lazy review -i` wholesale. It may submit feedback itself (the
      // `q` path offers to unblock), so re-gate rather than advance: the loop
      // re-reads status and will wait again if the task went back to working.
      const storage = await requireStorage();
      try {
        const fresh = await storage.getTask(task.id);
        const sess = fresh ? await storage.getSessionByTaskId(fresh.id) : null;
        if (!fresh || !sess) {
          console.error(`Task ${taskShortId} no longer has a session.`);
          return 'advance';
        }
        await runInteractiveReview(storage, fresh, sess, root, {});
      } finally {
        try { await storage.close(); } catch { /* already closed by delegate */ }
      }
      return 'regate';
    }

    default: {
      // Feedback — unblock with editor input. The task goes back to `working`,
      // so the loop waits for the new turn and gates the SAME task again.
      const storage = await requireStorage();
      try {
        const fresh = await storage.getTask(task.id);
        if (!fresh) {
          console.error(`Task not found: ${taskShortId}`);
          return 'advance';
        }
        const sess = await storage.getSessionByTaskId(fresh.id);
        if (!sess) {
          console.error(`Task ${taskShortId} has no session.`);
          return 'advance';
        }

        // Conflict tasks have file permission violations that require explicit
        // approval/rejection decisions. Loop doesn't have the UI for that — use
        // `lazy unblock` directly, which prompts for each violated file.
        // Gated on the pending violation SET, not the `conflict` label: a
        // side-channel turn can leave a task labelled `blocked` while the set is
        // still pending, and running the feedback flow there would revert the
        // agent's committed work (fix-ask-nukes-violations).
        if (pendingViolations(await storage.getSessionTurns(sess.id)).length > 0) {
          console.log(theme.warning(`\nTask ${taskShortId} has file permission violations.`));
          console.log(`Use ${theme.command(`lazy unblock ${taskShortId}`)} to handle them interactively.`);
          return 'advance';
        }

        const worktreePath = getWorktreePath(root, fresh);
        await runFeedbackFlow(fresh, sess, root, storage, worktreePath, taskShortId, follow, modelOverride);
      } finally {
        try { await storage.close(); } catch { /* already closed by delegate */ }
      }
      return 'regate';
    }
  }
}

/**
 * Resolve the queue. Every reference must name a real task — one bad reference
 * fails the whole run before anything is started, naming it. Same invariant as
 * `lazy wait`'s multi-task race: silently dropping a reference would leave the
 * human believing they queued work that was never touched.
 */
async function resolveQueue(refs: string[]): Promise<Task[]> {
  const storage = await requireStorage();
  try {
    const seen = new Set<string>();
    const queue: Task[] = [];
    for (const ref of refs) {
      const task = await resolveTaskOrExit(storage, ref);
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      queue.push(task);
    }
    return queue;
  } finally {
    await storage.close();
  }
}

/**
 * Build a candidate queue from filters (`--backlog`, `--parent`, `--tag`) and
 * confirm it interactively. Returns null if the human declines.
 */
async function pickQueueFromFilters(
  backlogOnly: boolean,
  parentRef: string | undefined,
  tagFilter: string | undefined,
): Promise<Task[] | null> {
  const storage = await requireStorage();
  let candidates: Task[];
  try {
    let parentId: string | null = null;
    if (parentRef) {
      const parent = await resolveTaskOrExit(storage, parentRef);
      parentId = parent.id;
    }

    candidates = await storage.listTasksWithOptions(backlogOnly ? { backlogOnly: true } : { nonTerminalOnly: true });

    if (parentId) {
      candidates = candidates.filter(t => parentTaskIdOf(t) === parentId);
    }
    if (tagFilter) {
      candidates = candidates.filter(t => t.tags?.includes(tagFilter));
    }
    // Creation order — the order a hub's backlog was written down.
    candidates.sort((a, b) => a.created_at - b.created_at);
  } finally {
    await storage.close();
  }

  if (candidates.length === 0) {
    console.log('No tasks matched those filters.');
    return null;
  }

  console.log(`\n${theme.header(`Queue (${candidates.length} task${candidates.length === 1 ? '' : 's'}, in order)`)}`);
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${theme.taskId(displayId(t))}  ${dim(t.status.padEnd(12))} ${t.goal}`);
  }
  console.log('');

  const confirmed = await promptYesNo('Loop over these tasks?', true);
  if (!confirmed) {
    console.log('Nothing started. Name the tasks explicitly to loop over a different set.');
    return null;
  }
  return candidates;
}

/** Print the command that resumes an interrupted run. */
function printResumeHint(queue: Task[], startIndex: number, pipeline: boolean): void {
  const remaining = queue.slice(startIndex);
  if (remaining.length === 0) return;
  const refs = remaining.map(t => displayId(t)).join(' ');
  console.log(`\n${remaining.length} task${remaining.length === 1 ? '' : 's'} left. Resume with:`);
  console.log(`  ${theme.command(`lazy loop ${refs}${pipeline ? ' --pipeline' : ''}`)}`);
}

/**
 * Queue mode: drive a curated, ordered list of tasks through
 * start → wait → review gate → decide → next.
 */
async function runQueueMode(
  queue: Task[],
  root: string,
  opts: { follow: boolean; modelOverride: string | undefined; pipeline: boolean },
): Promise<void> {
  // Tasks already started by the pipeline pre-start, so they aren't started twice.
  const preStarted = new Set<string>();

  // The queue is not persisted, so the resume command IS the recovery story —
  // it has to survive every exit path, including Ctrl+C and a delegate command
  // calling process.exit() out from under us (e.g. `lazy start` failing).
  let currentIndex = 0;
  let hintEmitted = false;
  const emitResumeHint = () => {
    if (hintEmitted) return;
    hintEmitted = true;
    printResumeHint(queue, currentIndex, opts.pipeline);
  };
  const onExit = () => emitResumeHint();
  const onSigint = () => {
    console.log('');
    emitResumeHint();
    process.exit(130);
  };
  process.on('exit', onExit);
  process.on('SIGINT', onSigint);

  try {
    await driveQueue();
  } finally {
    process.off('exit', onExit);
    process.off('SIGINT', onSigint);
  }

  async function driveQueue(): Promise<void> {
    for (let i = 0; i < queue.length; i++) {
      currentIndex = i;
      const queued = queue[i];
      const ref = displayId(queued);
      const position = `Task ${i + 1} of ${queue.length}`;

      try {
        // --- Re-read state fresh. A re-run of the same command must be idempotent.
        const storage = await requireStorage();
        let task: Task | null;
        try {
          task = await storage.getTask(queued.id);
        } finally {
          await storage.close();
        }

        if (!task) {
          console.log(`\n--- ${position}: ${ref} ---`);
          console.log('Task no longer exists. Skipping.');
          continue;
        }

        if (isTerminalStatus(task.status)) {
          console.log(`\n--- ${position}: ${ref} ---`);
          console.log(`Already ${task.status}. Skipping.`);
          continue;
        }

        if (task.status === 'pairing') {
          console.log(`\n--- ${position}: ${ref} ---`);
          console.log('Task is being paired on. Skipping — it is not the loop\'s to drive.');
          continue;
        }

        // --- Start it if it has never run.
        if (task.status === 'backlog' && !preStarted.has(task.id)) {
          console.log(`\n--- ${position}: ${ref} ---`);
          console.log(`Starting ${ref}: ${task.goal}`);
          await commandStart([ref, '--yes']);
        }

        // --- Pipeline: start the next not-yet-started task so its agent works
        // while the human reviews this one. Depth 1 by design.
        if (opts.pipeline && i + 1 < queue.length) {
          const nextRef = displayId(queue[i + 1]);
          const s = await requireStorage();
          let next: Task | null;
          try {
            next = await s.getTask(queue[i + 1].id);
          } finally {
            await s.close();
          }
          if (next && next.status === 'backlog' && !preStarted.has(next.id)) {
            console.log(dim(`\nPre-starting next task ${nextRef} (--pipeline)…`));
            preStarted.add(next.id);
            await commandStart([nextRef, '--yes']);
          }
        }

        // --- Gate loop for THIS task. Feedback returns here rather than advancing.
        let advance = false;
        while (!advance) {
          const settled = await waitUntilSettled(ref);

          if (isTerminalStatus(settled)) {
            console.log(`\nTask ${ref} is now ${settled}. Moving on.`);
            break;
          }

          const s = await requireStorage();
          let decision: GateDecision;
          try {
            const fresh = await s.getTask(queued.id);
            if (!fresh) {
              console.log(`Task ${ref} disappeared. Moving on.`);
              break;
            }
            // Pick up PR state/comments before showing context, as reactive mode does.
            await syncTaskFromRemote(fresh, s, root);
            const refreshed = await s.getTask(queued.id);
            if (refreshed && isTerminalStatus(refreshed.status)) {
              console.log(`\nTask ${ref} is now ${refreshed.status}. Moving on.`);
              break;
            }
            const sess = await s.getSessionByTaskId(queued.id);
            if (!sess) {
              console.log(`Task ${ref} has no session. Skipping.`);
              break;
            }
            decision = await presentGate(s, refreshed ?? fresh, sess, root, position);
          } finally {
            try { await s.close(); } catch { /* ignore */ }
          }

          const outcome = await executeGateDecision(decision, task, root, opts.follow, opts.modelOverride);
          if (outcome === 'stop') {
            console.log('\nLoop stopped.');
            emitResumeHint();
            return;
          }
          if (outcome === 'advance') advance = true;
          // 'regate' falls through: wait again (feedback restarted the agent) and re-gate.
        }
      } catch (err) {
        console.error(`\nError while looping over ${ref}: ${err instanceof Error ? err.message : err}`);
        emitResumeHint();
        process.exit(1);
      }
    }

    // Every task was decided — there is nothing left to resume.
    hintEmitted = true;
    console.log(theme.success(`\nLoop complete — ${queue.length} task${queue.length === 1 ? '' : 's'} processed.`));
  }
}

/**
 * Sequential review loop.
 *
 * - `lazy loop` — reactive: review every blocked task, oldest-waiting first.
 * - `lazy loop <task...>` — queue: drive exactly these tasks, in this order,
 *   starting the ones that haven't run yet.
 */
export async function commandLoop(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'model', takesValue: true },
    { name: 'follow', takesValue: false },
    { name: 'pipeline', takesValue: false },
    { name: 'backlog', takesValue: false },
    { name: 'parent', takesValue: true },
    { name: 'tag', takesValue: true },
  ], 'loop');

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const follow = parsed.flags.get('follow') === true;
  const pipeline = parsed.flags.get('pipeline') === true;
  const backlogOnly = parsed.flags.get('backlog') === true;
  const parentRef = parsed.flags.get('parent') as string | undefined;
  const tagValue = parsed.flags.get('tag') as string | undefined;
  const tagFilter = tagValue !== undefined ? normalizeTag(tagValue) : undefined;

  const hasFilters = backlogOnly || parentRef !== undefined || tagFilter !== undefined;

  // Argument validation runs BEFORE the TTY guard: a malformed invocation is a
  // malformed invocation whether or not there's a terminal, and reporting
  // "requires an interactive terminal" for it would hide the real mistake.

  // Explicit task references and filters are two ways to say the same thing.
  // Combining them would require guessing which wins — refuse instead.
  if (parsed.positional.length > 0 && hasFilters) {
    console.error('Name tasks explicitly or select them with --backlog/--parent/--tag, not both.');
    process.exit(1);
  }

  if (pipeline && parsed.positional.length === 0 && !hasFilters) {
    console.error('--pipeline applies to a task queue. Name the tasks, or select them with --backlog/--parent/--tag.');
    process.exit(1);
  }

  // isTTY() rather than process.stdin.isTTY directly, so the documented
  // LAZY_FORCE_TTY test seam can reach the loop body at all.
  if (!isTTY()) {
    console.error('lazy loop requires an interactive terminal.');
    process.exit(1);
  }

  const root = requireLazyRoot();

  // Resolve an explicit queue BEFORE the runner pre-flight. Resolution is pure
  // validation with no side effects, and a typo'd reference is both the more
  // likely mistake and the more confusing one to have masked by an environment
  // complaint — same ordering rule as the wait race's reference resolution.
  const explicitQueue = parsed.positional.length > 0
    ? await resolveQueue(parsed.positional)
    : null;

  // Pre-flight checks before entering the review loop
  const { createRunner } = await import('../../runner');
  const runner = await createRunner(root);
  try {
    await runner.checkAvailability();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // --- Queue mode: an explicit, ordered list of tasks to drive.
  if (explicitQueue || hasFilters) {
    // The filter picker prompts, so it runs after the runner check — nobody
    // should confirm a queue only to be told the runner is unavailable.
    const queue = explicitQueue ?? await pickQueueFromFilters(backlogOnly, parentRef, tagFilter);

    if (!queue || queue.length === 0) return;

    await runQueueMode(queue, root, { follow, modelOverride, pipeline });
    return;
  }

  // Track skipped tasks so we don't re-show them
  const skippedBlockedIds = new Set<string>();
  const skippedInterruptedIds = new Set<string>();

  // Main review loop
  while (true) {
    const storage = await requireStorage();
    try {
      // First, check for interrupted tasks and offer to resume them
      await handleInterruptedTasks(storage, root, skippedInterruptedIds, modelOverride, follow);

      // Query blocked tasks with sessions (started tasks waiting for review)
      const allBlocked = await storage.listTasksWithOptions({ blockedOnly: true, withSessionsOnly: true });

      // Filter to only tasks with active (non-ended) sessions, excluding skipped
      const reviewable: typeof allBlocked = [];
      for (const task of allBlocked) {
        if (skippedBlockedIds.has(task.id)) continue;
        const sess = await storage.getSessionByTaskId(task.id);
        if (sess && !sess.ended_at) {
          reviewable.push(task);
        }
      }

      if (reviewable.length === 0) {
        // No blocked tasks — wait for new ones, showing active tasks like `active --follow`
        const pollIntervalMs = 3000;
        let foundBlocked = false;

        while (!foundBlocked) {
          // Clear screen for clean display
          process.stdout.write('\x1B[2J\x1B[H');

          // Check for newly blocked tasks that weren't already skipped
          const newBlocked = await storage.listTasksWithOptions({ blockedOnly: true, withSessionsOnly: true });
          const newReviewable: typeof newBlocked = [];
          for (const t of newBlocked) {
            if (skippedBlockedIds.has(t.id)) continue;
            const s = await storage.getSessionByTaskId(t.id);
            if (s && !s.ended_at) newReviewable.push(t);
          }

          if (newReviewable.length > 0) {
            // Genuinely new blocked tasks found — reset skips and resume review loop
            skippedBlockedIds.clear();
            foundBlocked = true;
            break;
          }

          // Show active tasks (non-terminal with sessions) while waiting
          const activeTasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });

          if (activeTasks.length === 0) {
            stopAllMonitors();
            console.log('No active tasks. Waiting for tasks to become blocked...');
          } else {
            // Start/sync activity monitors for working tasks
            const workingTasks = new Map<string, { worktreePath: string; turnStartedAt?: string }>();
            for (const t of activeTasks) {
              if (t.status === 'working') {
                const tRef = taskRef(t);
                const tWorktree = getWorktreePath(root, t);
                const tSess = await storage.getSessionByTaskId(t.id);
                workingTasks.set(tRef, {
                  worktreePath: tWorktree,
                  turnStartedAt: tSess?.last_interaction_at ? new Date(tSess.last_interaction_at).toISOString() : undefined,
                });
              }
            }
            syncActivityMonitors(workingTasks, runner);
            drainActivityMonitors();

            const tree = await buildTaskTree(storage, activeTasks, root);
            console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
            console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));
            for (const rootNode of tree) {
              printTaskTree(rootNode);
            }

            // Show recent activity feed below the task table
            if (recentActivity.length > 0) {
              console.log(`\n${theme.header('Recent Activity')}`);
              console.log(theme.separator('─'.repeat(70)));
              for (const line of recentActivity) {
                console.log(`${dim(line.timestamp)} [${theme.taskId(line.taskId)}] ${line.activity}`);
              }
            }
          }

          console.log(`\n(waiting for tasks — press Ctrl+C to stop, polling every ${pollIntervalMs / 1000}s)`);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // Stop activity monitors when leaving the polling loop
        stopAllMonitors();

        // Close storage and re-enter the main loop to pick up the blocked task
        await storage.close();
        continue;
      }

      // Sort by last_interaction_at ASC (oldest-waiting first)
      const tasksWithSessions = await Promise.all(
        reviewable.map(async (task) => ({
          task,
          session: (await storage.getSessionByTaskId(task.id))!,
        }))
      );
      tasksWithSessions.sort((a, b) => {
        const aTime = a.session.last_interaction_at ?? null;
        const bTime = b.session.last_interaction_at ?? null;
        if (aTime === null && bTime === null) return a.task.created_at - b.task.created_at;
        if (aTime === null) return -1;
        if (bTime === null) return 1;
        return (aTime - bTime) || (a.task.created_at - b.task.created_at);
      });

      // Pick the first task
      const { task, session: sess } = tasksWithSessions[0];
      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePath(root, task);

      // Sync PR comments and state from GitHub before showing context
      await syncTaskFromRemote(task, storage, root);

      // Re-read task in case sync updated its status (e.g., PR merged/closed externally)
      const freshTask = await storage.getTask(task.id);
      if (freshTask && isTerminalStatus(freshTask.status)) {
        const taskLabel = displayId(task);
        console.log(`\nTask ${taskLabel} is now ${freshTask.status}. Skipping.`);
        await storage.close();
        continue;
      }

      // Show position in queue
      const taskLabel = displayId(task);
      console.log(`\n--- Task 1 of ${tasksWithSessions.length}: ${taskLabel} ---`);

      const turnCount = await storage.getTurnCountByTaskId(task.id);
      const unseenCount = await showTaskContext(
        taskShortId,
        task.goal,
        task.status,
        turnCount,
        sess.git_branch,
        worktreePath,
        root,
        parentTaskIdOf(task),
        storage,
        task.id,
        sess.id,
        taskLabel,
      );

      const menuOptions = unseenCount > 0
        ? [
            'Give feedback - includes unseen comments (recommended)',
            `Accept anyway (agent hasn't seen ${unseenCount} comment${unseenCount === 1 ? '' : 's'})`,
            'Reject (discard work)',
            'Sync upstream (lazy sync)',
            'Skip (move to next task)',
          ]
        : [
            'Give feedback (open editor)',
            'Accept (merge work)',
            'Reject (discard work)',
            'Sync upstream (lazy sync)',
            'Skip (move to next task)',
          ];

      const choice = await promptChoice('What would you like to do?', menuOptions);

      if (choice === 4) {
        // Skip — track and move to next task
        skippedBlockedIds.add(task.id);
        await storage.close();
        continue;
      }

      // Close storage before delegating to accept/abandon (they open their own)
      await storage.close();

      switch (choice) {
        case 1:
          // Accept
          await commandAccept([taskShortId]);
          break;
        case 2:
          // Reject
          await commandReject([taskShortId]);
          break;
        case 3:
          // Merge upstream via lazy sync
          await commandSyncTask([taskShortId]);
          break;
        default: {
          // Give feedback (choice 0)
          const storage2 = await requireStorage();
          try {
            const task2 = await storage2.getTask(task.id);
            if (!task2) { console.error(`Task not found: ${taskShortId}`); process.exit(1); }
            const sess2 = await storage2.getSessionByTaskId(task2.id);
            if (!sess2) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }

            // Conflict tasks have file permission violations that require explicit
            // approval/rejection decisions. Loop doesn't have the UI for that.
            // Same violation-set gate as above (fix-ask-nukes-violations).
            if (pendingViolations(await storage2.getSessionTurns(sess2.id)).length > 0) {
              console.log(theme.warning(`\nTask ${taskShortId} has file permission violations.`));
              console.log(`Use ${theme.command(`lazy unblock ${taskShortId}`)} to handle them interactively.`);
              break;
            }

            await runFeedbackFlow(task2, sess2, root, storage2, worktreePath, taskShortId, follow, modelOverride);
          } finally {
            await storage2.close();
          }
          break;
        }
      }

      // Continue to next task (list will be refreshed on next iteration)
    } finally {
      // Storage may already be closed by delegates, safe to call multiple times
      try { await storage.close(); } catch { /* ignore */ }
    }
  }
}

export function loopUsage(): void {
  console.log(`Usage: lazy loop [<task_id>...] [--backlog] [--parent <task>] [--tag <tag>]
                 [--pipeline] [--model <model>] [--follow]

Two modes, one review gate.

Reactive (no task IDs):
  Sequentially review all blocked tasks, oldest-waiting first. When none remain,
  shows active tasks and polls for new blocked ones every 3 seconds.

Queue (task IDs, or a --backlog/--parent/--tag selection):
  Drive exactly those tasks, in that order: start each one that hasn't run yet,
  wait for its turn, present the review gate, act on your decision, move on.
  Backlog-processing for a hub's pile of small tasks.

At each gate you choose: give feedback, review hunk-by-hunk (the same surface as
'lazy review --interactive'), accept, reject, sync upstream, skip (leave the task
exactly as it is), or stop.
Feedback and sync return to the same task; accept, reject and skip move on.

The queue is not persisted. Stopping (or Ctrl+C) prints the command that resumes
the rest, and re-running is idempotent: finished tasks are skipped, started ones
are not restarted.

Options:
  --backlog         Select backlog tasks instead of naming them (confirmed interactively)
  --parent <task>   Restrict the selection to this task's direct children
  --tag <tag>       Restrict the selection to tasks carrying this tag
  --pipeline        Start the NEXT queued task while you review the current one
  --model <model>   Override model for feedback turns (e.g. opus, sonnet, claude-opus-4-8)
  --follow          Wait for agent after giving feedback

Examples:
  lazy loop                                  # Review all blocked tasks
  lazy loop fix-a fix-b fix-c                # Drive these three, in order
  lazy loop --backlog --parent v0-20         # Pick a hub's backlog, then drive it
  lazy loop --backlog --tag cleanup --pipeline
  lazy loop --model opus                     # Use opus for feedback turns
  lazy loop --follow                         # Wait for agent after giving feedback`);
}
