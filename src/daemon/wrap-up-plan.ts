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
 *     runs on a human-audience task that is not a hub.
 *
 * Why permission push-back is on both lists: its re-detected set is the durable
 * per-turn record used by reviewers and callers that cannot run git. Running
 * it only after a final declaration left ordinary work turns with no record.
 *
 * Why the presentation is on both lists and the remaining chain is not: the
 * walkthrough exists to inform a human's ACCEPT decision, and a human deciding
 * about a needs-input task needs it exactly as much as one deciding about a
 * declared-done one. The maintained-file sweep and reactive work are
 * pencils-down work, and redoing them for every park is the token burn the
 * final was introduced to cut.
 *
 * The audience rule is `audienceOf` (src/task/audience.ts) and nothing else
 * (§13.3): the most recent human/builder/agent-launched turn decides, with no
 * stored field and no agent-settable flag. The plan is re-resolved on every
 * launch, so a task whose audience changes with its next review comment gets
 * the new plan on the next turn.
 *
 * `base_sha` resolves through `resolveTaskDiffBase` (src/task-diff-base.ts) —
 * the ONE shared base resolver the reviewer's diff uses — converted to a
 * concrete SHA so the supervisor never has to resolve refs in-container.
 */

import type { ResolvedConfig } from '../config/types';
import type { WrapUpPlan, WrapUpStep } from '../protocol';
import type { StatusChange } from '../storage/types';
import type { Storage } from '../storage/interface';
import type { Actor, Session, Task, Turn } from '../types';
import { audienceOf } from '../task/audience';
import { isHubTask } from '../task/hub';
import { resolveTaskDiffBase } from '../task-diff-base';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

/**
 * The full plan: every step, in execution order (§3.3). A human-audience task
 * gets all of them — the reader-facing work the final exists to demand.
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
const HUMAN_WRAP_UP_PLAN: readonly WrapUpStep[] = [
  'permission_pushback',
  'maintain',
  'react',
  'commit_leftovers',
  'present',
];

/**
 * The agent-audience plan. An agent-created, agent-driven subtask has no human
 * reader: presentation and the reader-facing automations are skipped entirely.
 *
 * Agent-audience tasks skip reader-facing upkeep and presentation, but still
 * run the protected-file check so their turn records agree with branch scans.
 */
const AGENT_WRAP_UP_PLAN: readonly WrapUpStep[] = ['permission_pushback'];

/** The two step lists for a task — the one place audience → steps maps. */
export function wrapUpPlanFor(
  audience: 'human' | 'agent',
  opts: { hub?: boolean } = {},
): { steps: WrapUpStep[]; park_steps: WrapUpStep[] } {
  let steps = audience === 'agent' ? [...AGENT_WRAP_UP_PLAN] : [...HUMAN_WRAP_UP_PLAN];
  if (opts.hub) steps = steps.filter((step) => step !== 'present');
  // Permission checks produce the durable record on every work turn.
  // Presentation also belongs on every human-facing park. Derive both from the
  // final plan so audience/hub routing cannot diverge between the two endings.
  return {
    steps,
    park_steps: steps.filter((step) => step === 'permission_pushback' || step === 'present'),
  };
}

/**
 * Resolve a task's wrap-up plan from its audience.
 *
 * Reads the session's turns (sequence order) and the task's status changelog —
 * the two inputs `audienceOf` derives the audience from — plus the task's
 * children, for the hub rule. All three reads are best-effort: a task whose
 * history cannot be read still launches, with `audienceOf` falling back to its
 * safe default.
 */
export async function resolveWrapUpPlan(
  storage: {
    getSessionTurns(sessionId: string): Promise<readonly Pick<Turn, 'role' | 'actor' | 'final'>[]>;
    getStatusHistory(taskId: string): Promise<StatusChange[]>;
    getChildTasks(taskId: string): Promise<readonly Pick<Task, 'status'>[]>;
  },
  task: Task,
  sessionId: string,
): Promise<{ steps: WrapUpStep[]; park_steps: WrapUpStep[] }> {
  const turns = await storage.getSessionTurns(sessionId);
  let createdBy: 'human' | 'builder' | 'agent' | null | undefined;
  try {
    const history = await storage.getStatusHistory(task.id);
    // A `system`-created task (daemon-created, e.g. an auto-spawned child) has
    // no launching actor at creation — leave undefined and let `audienceOf`
    // fall through to its safe default.
    const actor = history[0]?.actor;
    createdBy = actor === 'human' || actor === 'builder' || actor === 'agent' ? actor : null;
  } catch (err) {
    // The changelog is a fallback input, not a gate: losing it degrades to the
    // safe default audience (human → more wrap-up work), never blocks a launch.
    logger.debug(
      `resolveWrapUpPlan: status history for task ${task.id} unavailable: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
  // The hub rule is `isHubTask` (src/task/hub.ts) and nothing else — the
  // regions loader routes on the same predicate, and the two disagreeing would
  // mean a task that authors no walkthrough and is then told it has none.
  let children: Pick<Task, 'status'>[] = [];
  try {
    children = [...await storage.getChildTasks(task.id)];
  } catch (err) {
    // Unreadable children degrade to "not a hub", which asks for a walkthrough
    // that may be redundant — the same safe direction the audience fallback
    // takes, and never a missing one.
    logger.debug(
      `resolveWrapUpPlan: children of task ${task.id} unavailable: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
  return wrapUpPlanFor(audienceOf({ turns, createdBy }), {
    hub: isHubTask(task, children),
  });
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
 * audience-resolved plan plus the base SHA its scans run over. Spread the
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
  /**
   * The actor of a launch whose turn is not recorded YET. A start resolves its
   * plan before recording turn 1 (every fallible step precedes the flip to
   * `working`), so that turn is appended to the session's turns as the newest
   * one — the plan still derives from the turn list alone, exactly as if the
   * turn were already stored. Without it the task's CREATOR would decide.
   */
  pendingLaunchActor?: Actor;
}): Promise<WrapUpCommandFields> {
  const pending = opts.pendingLaunchActor;
  const planStorage = pending
    ? {
      getSessionTurns: async (id: string) => [
        ...await opts.storage.getSessionTurns(id),
        { role: 'human' as const, actor: pending },
      ],
      getStatusHistory: (id: string) => opts.storage.getStatusHistory(id),
      getChildTasks: (id: string) => opts.storage.getChildTasks(id),
    }
    : opts.storage;
  const { steps, park_steps } = await resolveWrapUpPlan(
    planStorage, opts.task, opts.sessionId,
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
