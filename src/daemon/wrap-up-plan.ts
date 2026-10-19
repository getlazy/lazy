/**
 * The wrap-up plan: which steps run at the end of a turn, by how the turn
 * ended, and which range those steps scan.
 *
 * Built per work-turn launch by the command-assembly sites (start, unblock,
 * resume, auto-resume, auto-deliver) and carried on the command. The supervisor
 * is deliberately dumb (final-turn design §2.4): it runs the steps it is HANDED
 * and never derives a plan itself — the same division that puts
 * `protected_patterns` and the maintain/react entries on the command today.
 * Because the turn's ending is not knowable when the command is written, the
 * plan carries BOTH lists and the supervisor picks:
 *
 *   - `steps` — the turn declared `lazy_final`. The full reader-facing chain.
 *   - `park_steps` — it parked without one (a blocking raise, or it just
 *     stopped). Protected-file push-back always runs; presentation additionally
 *     runs on a task that is not a hub.
 *
 * Why permission push-back is on both lists: its re-detected set is the durable
 * per-turn record used by reviewers and callers that cannot run git. Running
 * it only after a final declaration left ordinary work turns with no record.
 *
 * Why the presentation is on both lists and the remaining chain is not: the
 * walkthrough exists to inform an ACCEPT decision, and a reviewer deciding
 * about a needs-input task needs it exactly as much as one deciding about a
 * declared-done one. The maintained-file sweep and reactive work are
 * pencils-down work, and redoing them for every park is the token burn the
 * final was introduced to cut.
 *
 * ONE PLAN FOR EVERY TASK, whoever its audience is (engineer, 2026-10-04).
 * The maintain/react rules are the USER's configuration, and an agent-audience
 * plan that ran only the push-back silently suppressed them for every cluster
 * child and agent-created subtask — and skipped `commit_leftovers`, whose whole
 * point is that nothing is left uncommitted. Audience still decides protected-
 * file DEFERRAL (src/protection/deferral.ts) and the reviewer's prompt; it
 * never decides which configured rules run. Opting out of a rule is a visible
 * config switch still to be designed, never an audience heuristic. The hub
 * rule is the only input left.
 *
 * `base_sha` resolves through `resolveTaskDiffBase` (src/task-diff-base.ts) —
 * the ONE shared base resolver the reviewer's diff uses — converted to a
 * concrete SHA so the supervisor never has to resolve refs in-container.
 */

import type { ResolvedConfig } from '../config/types';
import type { WrapUpPlan, WrapUpStep } from '../protocol';
import type { Storage } from '../storage/interface';
import type { Session, Task } from '../types';
import { isHubTask } from '../task/hub';
import { resolveTaskDiffBase } from '../task-diff-base';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

/**
 * The full plan: every step, in execution order (§3.3), for every task.
 *
 * `commit_leftovers` is PENCILS-DOWN WORK and belongs to the final alone, like
 * the push-back and the maintained-file sweep. A parked turn may legitimately
 * hold an unfinished edit: the worktree survives, the next turn continues in
 * it, and nothing is lost. A turn that says it is DONE may not — anything still
 * loose then is work the reviewer will never see and the merge will never
 * carry. Parks are not left unwatched either way: the supervisor records the
 * end-of-turn path set on every turn regardless of plan (src/supervisor/
 * leftovers.ts), which costs a `git status` rather than a model invocation.
 */
const WRAP_UP_PLAN: readonly WrapUpStep[] = [
  'permission_pushback',
  'maintain',
  'react',
  'commit_leftovers',
  'present',
];

/** The two step lists for a task. A hub presents by its children, so it drops `present`. */
export function wrapUpPlanFor(
  opts: { hub?: boolean } = {},
): { steps: WrapUpStep[]; park_steps: WrapUpStep[] } {
  let steps = [...WRAP_UP_PLAN];
  if (opts.hub) steps = steps.filter((step) => step !== 'present');
  // Permission checks produce the durable record on every work turn and the
  // presentation belongs on every park. Derive both from the final plan so hub
  // routing cannot diverge between the two endings.
  return {
    steps,
    park_steps: steps.filter((step) => step === 'permission_pushback' || step === 'present'),
  };
}

/**
 * Resolve a task's wrap-up plan. Only the task's children vary it (the hub
 * rule). Unreadable children degrade to "not a hub" — the direction that asks
 * for a walkthrough that may be redundant, never a missing one.
 */
export async function resolveWrapUpPlan(
  storage: {
    getChildTasks(taskId: string): Promise<readonly Pick<Task, 'status'>[]>;
  },
  task: Task,
  // Unused since the plan stopped reading turns; kept so every launch site's
  // call and the signature (pinned by the arity test) stay stable.
  _sessionId: string,
): Promise<{ steps: WrapUpStep[]; park_steps: WrapUpStep[] }> {
  // The hub rule is `isHubTask` (src/task/hub.ts) and nothing else — the
  // regions loader routes on the same predicate, and the two disagreeing would
  // mean a task that authors no walkthrough and is then told it has none.
  let children: Pick<Task, 'status'>[] = [];
  try {
    children = [...await storage.getChildTasks(task.id)];
  } catch (err) {
    logger.debug(
      `resolveWrapUpPlan: children of task ${task.id} unavailable: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
  return wrapUpPlanFor({ hub: isHubTask(task, children) });
}

/**
 * HEAD the walkthrough now on record was declared at, or undefined when the
 * task has none (or the record predates the stamp).
 *
 * Newest-report-wins, the same `(updated_at ?? created_at)` recency rule
 * `latestPresentation` applies — the answer must name the SHA of the SAME
 * walkthrough every reader surface will show.
 *
 * Best-effort: an unreadable report store returns undefined, which makes the
 * presentation step run. Spending one step is the right failure.
 */
export async function resolvePresentedSha(
  storage: Pick<Storage, 'getTaskTurnReports'>,
  taskId: string,
): Promise<string | undefined> {
  try {
    const reports = await storage.getTaskTurnReports(taskId);
    let bestAt = -1;
    let bestSha: string | undefined;
    for (const report of reports) {
      if (!report.presentation) continue;
      const at = report.updated_at ?? report.created_at;
      if (at > bestAt) {
        bestAt = at;
        bestSha = report.presentation_head_sha;
      }
    }
    return bestSha;
  } catch (err) {
    logger.debug(
      `resolvePresentedSha: turn reports for task ${taskId} unavailable: ` +
      `${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

/**
 * The concrete SHA of the base this task's own diff is rendered against —
 * the range the wrap-up phase's scans run over (§3.4).
 *
 * Resolved through `resolveTaskDiffBase` (the same base the reviewer's diff
 * uses) and converted from a ref to a SHA: a three-dot diff is
 * `merge-base(ref, HEAD)..HEAD`, and the supervisor must scan exactly that
 * range without resolving refs itself. Returns `undefined` when the base
 * cannot be resolved — the supervisor then falls back to the turn-window scan
 * rather than refusing the wrap-up. Never throws.
 */
export async function resolveWrapUpBaseSha(opts: {
  task: Task;
  session: Pick<Session, 'upstream_merge_sha'>;
  storage: Storage;
  projectRoot: string;
  worktreePath: string;
  config: ResolvedConfig;
}): Promise<string | undefined> {
  let base: Awaited<ReturnType<typeof resolveTaskDiffBase>>;
  try {
    base = await resolveTaskDiffBase(opts);
  } catch (err) {
    // resolveTaskDiffBase is documented never to throw; this is a launch path,
    // so even a surprise failure degrades to the turn-window scan instead of
    // failing the launch.
    logger.debug(
      `resolveWrapUpBaseSha: diff base resolution failed for task ${opts.task.id}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
  if (base.twoDot) return base.ref; // already a concrete SHA
  // Three-dot diff = merge-base(ref, HEAD) — the exact range the reviewer is
  // shown. Resolve it here, daemon-side, where the refs live.
  const mergeBase = await runGit(['merge-base', base.ref, 'HEAD'], {
    cwd: opts.worktreePath,
    stderr: 'ignore',
  });
  if (mergeBase.exitCode !== 0) {
    logger.debug(
      `resolveWrapUpBaseSha: merge-base ${base.ref} HEAD failed in ${opts.worktreePath}: ` +
      `${mergeBase.stderr.trim()}`,
    );
    return undefined;
  }
  const sha = mergeBase.stdout.trim();
  return sha === '' ? undefined : sha;
}

/** The two command fields the wrap-up plan contributes: the plan and its scan base. */
export type WrapUpCommandFields = {
  wrap_up?: WrapUpPlan;
  base_sha?: string;
};

/**
 * Build the wrap-up command fields for a work turn (start/unblock): the
 * plan plus the base SHA its scans run over. Spread the
 * result into the command at every site that assembles a work command.
 */
export async function resolveWrapUpCommandFields(opts: {
  storage: Storage;
  task: Task;
  sessionId: string;
  session: Pick<Session, 'upstream_merge_sha'>;
  projectRoot: string;
  worktreePath: string;
  config: ResolvedConfig;
}): Promise<WrapUpCommandFields> {
  const { steps, park_steps } = await resolveWrapUpPlan(
    opts.storage, opts.task, opts.sessionId,
  );
  const baseSha = await resolveWrapUpBaseSha(opts);
  const presentedSha = await resolvePresentedSha(opts.storage, opts.task.id);
  return {
    wrap_up: {
      steps,
      park_steps,
      ...(presentedSha ? { presented_sha: presentedSha } : {}),
    },
    ...(baseSha !== undefined ? { base_sha: baseSha } : {}),
  };
}
