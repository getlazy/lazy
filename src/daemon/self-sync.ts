/**
 * Self-sync: a task's OWN agent reconciling its branch while its turn is running.
 *
 * Ordinary `lazy sync` refuses a `working` task and, when it does run, dispatches
 * a supervisor that performs the merges and runs a separate `claude -p` pass for
 * any conflicts. Neither is available to a CLUSTER task: a cluster is `working` for
 * its whole turn, so its branch is frozen at whatever its parent was when the
 * cluster started and every child it cuts inherits that stale base.
 *
 * This module is the other execution shape for the SAME two merges. The agent
 * calls `lazy_sync` on itself and is parked inside the tool call while the daemon
 * performs the merges host-side, in that agent's own worktree:
 *
 *   step 1 of 2 — `origin/<own branch>` (a colleague pushed to the task branch)
 *   step 2 of 2 — the parent, through `resolveUpstreamMergeRef()`
 *
 * The order is the same load-bearing order sync has always used (see CLAUDE.md,
 * "Upstream merge is sync's job"): the branch must be at its true tip before the
 * parent is merged on top.
 *
 * Everything that decides WHAT to merge — the fetch, the origin-branch check, the
 * upstream-ref resolution, the containment tests — happens in `syncTaskRun`
 * before this module is reached, so a self-sync and a supervisor sync can never
 * disagree about the refs. Nothing here is taken from the agent: it supplies only
 * its own identity, and even that comes from the authenticated per-task MCP
 * context rather than from a tool argument.
 *
 * IDEMPOTENT BY CONSTRUCTION. The call merges everything outstanding and stops at
 * the FIRST conflict, leaving that merge in place for the calling agent to
 * resolve and conclude with `lazy_commit`. The agent then calls `lazy_sync`
 * again: the step it already merged is contained in HEAD, so it is simply not
 * offered again, and the call proceeds to whatever is left. The daemon never has
 * to remember which step it was on — git knows.
 */

import { RpcError } from './rpc-error';
import { runGit } from '../utils/git';
import { readWorktreeMergeState, hasUncommittedChanges } from '../git/operations';
import { logger } from '../utils/logger';
import type { Storage } from '../storage';
import { turnChannelActor } from './turn-owner';
import mergeConflictResolutionTemplate from '../prompts/merge-conflict-resolution.md' with { type: 'text' };

/** Step numbering is FIXED, not positional: origin is always 1 of 2, the parent always 2 of 2. */
const TOTAL_STEPS = 2;

export interface SelfSyncStep {
  /** 1 = the task's own branch on origin, 2 = the parent. */
  step: number;
  of: number;
  /** The ref as a human reads it — `origin/lazy/<task>` or the parent branch. */
  ref: string;
  outcome: 'merged' | 'conflict';
  /** Commits the merge brought in (before the merge, `HEAD..<ref>`). */
  commits?: number;
  head_before?: string;
  head_after?: string;
  conflicted_files?: string[];
}

export interface SelfSyncOutcome {
  status: 'up_to_date' | 'merged' | 'conflict';
  message: string;
  steps: SelfSyncStep[];
  /** Present only on `conflict`: what the calling agent must do next. */
  instructions?: string;
}

/** One merge this call may have to perform, in execution order. */
export interface SelfSyncPlanStep {
  step: number;
  /** Display label — the ref name. */
  ref: string;
  /**
   * What git is actually asked to merge. For the parent this is the SHA the
   * daemon already resolved, so the ref cannot move underneath the merge.
   */
  target: string;
}

/**
 * Build the ordered list of merges for one self-sync call.
 *
 * Both inputs are already containment-tested by the caller (`fetchBranch` for
 * origin, `hasUpstreamChanges` for the parent), which is what makes a repeat call
 * after a resolved conflict a no-op for the step that already landed.
 */
export function planSelfSyncSteps(args: {
  /** `origin/<own branch>`, set ONLY when the fetch found commits HEAD lacks. */
  remoteBranch?: string;
  /** The resolved parent ref, for display. */
  parentRef: string;
  /** The parent's SHA, resolved host-side. */
  parentSha: string;
  /** False when HEAD already contains the parent. */
  parentHasChanges: boolean;
}): SelfSyncPlanStep[] {
  const steps: SelfSyncPlanStep[] = [];
  if (args.remoteBranch) {
    steps.push({ step: 1, ref: args.remoteBranch, target: args.remoteBranch });
  }
  if (args.parentHasChanges) {
    steps.push({ step: 2, ref: args.parentRef, target: args.parentSha });
  }
  return steps;
}

async function headOf(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    throw new RpcError(500, `Failed to read HEAD in ${cwd}: ${result.stderr || 'git rev-parse failed'}`);
  }
  return result.stdout.trim();
}

async function countIncoming(target: string, cwd: string): Promise<number | undefined> {
  const result = await runGit(['rev-list', '--count', `HEAD..${target}`], { cwd });
  if (result.exitCode !== 0) return undefined;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Refuse a self-sync the worktree is not in a state to take.
 *
 * Both refusals are actionable rather than defensive: a merge started on top of
 * an unfinished merge, or on top of uncommitted work, is how a resolution gets
 * silently thrown away.
 */
export async function assertWorktreeReadyForSelfSync(worktreePath: string, displayId: string): Promise<void> {
  const mergeState = await readWorktreeMergeState(worktreePath);
  if (mergeState.mergeInProgress) {
    const files = mergeState.unmergedFiles.length
      ? `\n\nStill conflicted:\n${mergeState.unmergedFiles.map(f => `  - ${f}`).join('\n')}`
      : '';
    throw new RpcError(
      409,
      `Task ${displayId} already has a merge in progress — finish or abort it before syncing again. ` +
      `Resolve every conflicted file, then call lazy_commit to create the merge commit; ` +
      `call lazy_sync again afterwards and it will carry on with whatever is left.${files}`,
    );
  }

  if (await hasUncommittedChanges(worktreePath)) {
    throw new RpcError(
      409,
      `Task ${displayId} has uncommitted changes in its worktree. Commit them with lazy_commit ` +
      `(or discard them) before syncing — merging on top of uncommitted work risks losing it.`,
    );
  }
}

/**
 * Perform one self-sync call's merges, host-side, in the caller's worktree.
 *
 * Returns as soon as a step conflicts, with that merge LEFT IN PLACE: the calling
 * agent is the one that resolves it. Every clean merge is recorded as a
 * `supervisor`-actored sync turn, exactly as a supervisor sync records its own,
 * so the task's history shows what was merged.
 */
export async function runSelfSync(args: {
  storage: Storage;
  taskId: string;
  sessionId: string;
  displayId: string;
  worktreePath: string;
  plan: SelfSyncPlanStep[];
  /** Leave a conflicted merge for the calling agent; ordinary sync aborts it before dispatch. */
  leaveConflictInProgress?: boolean;
}): Promise<SelfSyncOutcome> {
  const { storage, taskId, sessionId, displayId, worktreePath, plan } = args;
  const leaveConflictInProgress = args.leaveConflictInProgress ?? true;

  await assertWorktreeReadyForSelfSync(worktreePath, displayId);

  const steps: SelfSyncStep[] = [];

  for (const planned of plan) {
    const headBefore = await headOf(worktreePath);
    const incoming = await countIncoming(planned.target, worktreePath);
    const message = `Merge ${planned.ref}`;

    const merge = await runGit(['merge', planned.target, '--no-ff', '-m', message], { cwd: worktreePath });

    if (merge.exitCode === 0) {
      const headAfter = await headOf(worktreePath);
      const step: SelfSyncStep = {
        step: planned.step,
        of: TOTAL_STEPS,
        ref: planned.ref,
        outcome: 'merged',
        ...(incoming !== undefined ? { commits: incoming } : {}),
        head_before: headBefore,
        head_after: headAfter,
      };
      steps.push(step);
      await recordSelfSyncTurn(storage, sessionId, describeStep(step));
      continue;
    }

    // Exit non-zero is not automatically a conflict: a merge can also fail
    // outright (a wedged index, an unreadable object). Tell them apart from the
    // worktree's own state rather than from git's exit code, and only the
    // conflict case is handed back to the agent to resolve.
    const state = await readWorktreeMergeState(worktreePath);
    if (!state.mergeInProgress || state.unmergedFiles.length === 0) {
      throw new RpcError(
        500,
        `Merging ${planned.ref} into task ${displayId} failed without leaving a resolvable merge: ` +
        `${merge.stderr.trim() || `git merge exited ${merge.exitCode}`}`,
      );
    }

    logger.info(
      `Self-sync ${displayId}: step ${planned.step} of ${TOTAL_STEPS} (${planned.ref}) conflicted in ` +
      `${state.unmergedFiles.length} file(s) — ${leaveConflictInProgress
        ? `leaving the merge in place for the task's own agent.`
        : `aborting it before dispatching conflict resolution.`}`,
    );

    if (!leaveConflictInProgress) {
      const abort = await runGit(['merge', '--abort'], { cwd: worktreePath });
      if (abort.exitCode !== 0) {
        throw new RpcError(
          500,
          `Merging ${planned.ref} into task ${displayId} conflicted, but the merge could not be aborted before conflict resolution was dispatched: ` +
          `${abort.stderr.trim() || `git merge --abort exited ${abort.exitCode}`}`,
        );
      }
    }

    steps.push({
      step: planned.step,
      of: TOTAL_STEPS,
      ref: planned.ref,
      outcome: 'conflict',
      ...(incoming !== undefined ? { commits: incoming } : {}),
      head_before: headBefore,
      conflicted_files: state.unmergedFiles,
    });

    const merged = steps.filter(s => s.outcome === 'merged');
    return {
      status: 'conflict',
      message:
        `Step ${planned.step} of ${TOTAL_STEPS} — merging ${planned.ref} — has conflicts in ` +
        `${state.unmergedFiles.length} file(s). ` +
        (leaveConflictInProgress
          ? `The merge is in progress in your worktree; resolve it, conclude it with lazy_commit, then call lazy_sync again to finish the rest.`
          : `The merge was aborted so a conflict-resolution agent can retry it.`) +
        (merged.length ? ` Already merged this call: ${merged.map(s => s.ref).join(', ')}.` : ''),
      steps,
      instructions: conflictInstructions(planned.ref, state.unmergedFiles),
    };
  }

  if (steps.length === 0) {
    return {
      status: 'up_to_date',
      message: 'Already up to date — nothing left to merge.',
      steps,
    };
  }

  return {
    status: 'merged',
    message: steps.map(describeStep).join(' '),
    steps,
  };
}

function describeStep(step: SelfSyncStep): string {
  const count = step.commits === undefined ? '' : ` (${step.commits} commit${step.commits === 1 ? '' : 's'})`;
  return (
    `Merged ${step.ref}${count}. ` +
    `HEAD: ${(step.head_before ?? '').substring(0, 8)} → ${(step.head_after ?? '').substring(0, 8)}.`
  );
}

/**
 * The conflict-resolution contract, taken from the same prompt a supervisor sync
 * hands its merge agent — so the rules that decide the common cases (union of
 * list entries, verified field lists, the merge commit is the deliverable) are
 * stated once and read identically on both routes.
 */
function conflictInstructions(ref: string, files: string[]): string {
  const body = mergeConflictResolutionTemplate.replace(/\{\{parentBranch\}\}/g, ref);
  const list = files.map(f => `  - ${f}`).join('\n');
  return `${body}\n\nConflicted files:\n${list}\n\nWhen the merge commit exists, call lazy_sync again — ` +
    `the step you just finished is a no-op and the call continues with anything still outstanding.`;
}

/**
 * Record a merged step as a `supervisor`-actored sync turn.
 *
 * Same actor and turn type a supervisor sync records (see recordSyncTurns in
 * src/utils/reconcile.ts): the merge was performed by lazy, not typed by a human
 * and not authored by the agent's own turn. Deliberately WITHOUT a SHA window —
 * the calling agent's work turn is still open and its own window already spans
 * these commits, so attaching one here would attribute the same commits twice.
 */
async function recordSelfSyncTurn(storage: Storage, sessionId: string, content: string): Promise<void> {
  const sequence = await storage.getNextTurnSequence(sessionId);
  await storage.createTurn({
    sessionId,
    sequence,
    role: 'human',
    content,
    // Channel and person exactly as the supervisor route records them
    // (recordSyncTurns): `supervisor` did the merge, and the person is whoever
    // the agent's own turn belongs to — or the configured system identity when
    // nobody asked for that turn.
    actor: await turnChannelActor(storage, sessionId, 'supervisor'),
    autoTriggered: true,
    turnType: 'sync',
  });
}
