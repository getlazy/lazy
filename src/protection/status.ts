/**
 * READ-ONLY protection status for a task — the one place that decides what
 * "this task is protected" means, and the one vocabulary every surface renders.
 *
 * WHY THIS EXISTS: `[protection]` in lazy.toml is invisible until an accept is
 * refused. The gate itself (src/protection/edge-gate.ts) is asked about a merge
 * EDGE at accept time; nothing asked it "would this task be gated?" ahead of
 * time, so the first news a human (or builder) got was a 403. This module
 * answers that question for a task, without side effects, so `lazy show`,
 * `lazy status`, `lazy list`, `lazy review`, `lazy_show` over MCP and the web
 * dashboard can all say the same thing in the same words.
 *
 * DEFINE ONCE, RENDER EVERYWHERE: the markers (`[P]`, `[A]`) and the phrasing
 * helpers below are the shared vocabulary. A new surface renders these; it does
 * not re-derive protection from config. Divergent wording across surfaces is
 * how a friction feature turns into a mystery.
 *
 * READ-ONLY, DELIBERATELY: there is no write path here and no MCP write
 * surface. Managing gates is a human act (`lazy protect`, `lazy approve`) —
 * see public-docs/surface-asymmetries.md. Reading state is harmless; arranging your
 * own gates is not.
 *
 * FIDELITY: the target branch is resolved exactly the way accept resolves it
 * (child → parent's `lazy/…` branch, top-level → its stored target branch,
 * falling back to `main`), and the default-branch gate uses the same
 * `getRemoteDefaultBranch` the gate uses. A surfacing layer that resolved
 * differently would confidently describe a gate other than the one that fires.
 */

import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config';
import type { Task } from '../types';
import { getRemoteDefaultBranch } from '../git/operations';
import { getBranchNameFromId } from '../cli/helpers';
import { parentTaskIdOf, targetBranchOf } from '../task-target';
import { peekHumanApproval } from './edge-gate';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Shared marker vocabulary
// ---------------------------------------------------------------------------

/**
 * Compact marker for a gated task in dense views (list rows, table cells).
 *
 * ASCII on purpose: these land inside padded, width-computed columns and in
 * output that scripts grep. A shield emoji is two columns wide in some
 * terminals and zero in others, which silently misaligns every row after it.
 */
export const PROTECTED_MARKER = '[P]';

/** Compact marker for "a `lazy approve` is recorded and not yet consumed". */
export const APPROVAL_PENDING_MARKER = '[A]';

/** Legend for the markers, for help text and column footers. */
export const PROTECTION_MARKER_LEGEND =
  `${PROTECTED_MARKER} protected — accepting needs \`lazy approve\`   ` +
  `${APPROVAL_PENDING_MARKER} approval recorded and pending`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a task's merge TARGET is protected. */
export type BranchGateSource =
  /** Named in [protection].protected_branches. */
  | 'listed'
  /** The repo default branch, gated by [protection].gate_default_branch. */
  | 'default-branch';

export interface TaskProtectionStatus {
  /** [protection].enabled — while false NOTHING below has any effect. */
  enabled: boolean;
  /**
   * True when this task's accept would be refused without a human approval.
   * Always false while `enabled` is false.
   */
  gated: boolean;
  /**
   * The OUTGOING gate: this task is listed in [protection].protected_tasks, so
   * its work needs approval to move upward whatever the target.
   *
   * `armed` is false when the task has no branch yet (never started): the gate
   * resolves entries to branches at decision time, so an unstarted entry gates
   * nothing — and cannot be accepted either. Reported rather than hidden, the
   * same way `lazy protect` reports it.
   */
  taskGate: { listedAs: string; armed: boolean } | null;
  /** The INCOMING gate: the branch this task merges into is protected. */
  branchGate: { branch: string; source: BranchGateSource } | null;
  /** Branch this task merges into, or null when it cannot be resolved. */
  targetBranch: string | null;
  /** An unconsumed `lazy approve` record, when one exists. */
  pendingApproval: { approvedAt: string } | null;
}

/**
 * Project-wide protection facts resolved ONCE, so a list of N tasks costs one
 * config read, one default-branch lookup and one resolve per protected entry —
 * not N of each.
 */
export interface ProtectionContext {
  enabled: boolean;
  protectedBranches: string[];
  gateDefaultBranch: boolean;
  /** Repo default branch, or null when protection is off or it is unresolved. */
  defaultBranch: string | null;
  /** taskId → the identifier as written in [protection].protected_tasks. */
  protectedTaskIds: Map<string, string>;
}

/**
 * The context for a project with nothing protected. Returned whenever the
 * feature cannot possibly apply, so the common case does no git and no
 * storage work at all.
 */
const INERT_CONTEXT: ProtectionContext = {
  enabled: false,
  protectedBranches: [],
  gateDefaultBranch: false,
  defaultBranch: null,
  protectedTaskIds: new Map(),
};

/**
 * True when this context can never produce anything to render, so a caller
 * iterating tasks can skip the per-task work entirely.
 *
 * A listed task is reportable even while the master switch is off (that IS the
 * report — "listed, but disabled"); a protected BRANCH is not, because with
 * protection disabled it gates nothing and names no particular task.
 */
export function contextIsInert(ctx: ProtectionContext): boolean {
  if (ctx.protectedTaskIds.size > 0) return false;
  if (!ctx.enabled) return true;
  return ctx.protectedBranches.length === 0 && !(ctx.gateDefaultBranch && ctx.defaultBranch);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Resolve the project-wide protection facts.
 *
 * The default-branch lookup runs ONLY when protection is enabled and gates the
 * default branch — a project that never turned protection on pays nothing, and
 * never sees `getRemoteDefaultBranch`'s "could not resolve" warning because of
 * a read-only status line.
 *
 * `protected_tasks` is resolved even while protection is disabled (it is a
 * storage read per entry, and the list is empty in a stock project). That is
 * what lets `lazy show` say "listed, but protection is disabled" instead of
 * silently reporting an unprotected task the human believes is gated.
 */
export async function loadProtectionContext(
  storage: Storage,
  config: ResolvedConfig,
  projectRoot: string,
): Promise<ProtectionContext> {
  const p = config.protection;

  if (!p.enabled && p.protected_tasks.length === 0 && p.protected_branches.length === 0) {
    return INERT_CONTEXT;
  }

  const protectedTaskIds = new Map<string, string>();
  for (const listedAs of p.protected_tasks) {
    // A stale entry (no match / ambiguous) gates nothing and belongs to
    // `lazy doctor` and `lazy protect`, not to a per-task status line.
    const match = await storage.resolveTask(listedAs);
    if (match.task) protectedTaskIds.set(match.task.id, listedAs);
  }

  let defaultBranch: string | null = null;
  if (p.enabled && p.gate_default_branch) {
    try {
      defaultBranch = await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
    } catch (err) {
      // Observational surface: a repo we cannot ask about the default branch
      // must not fail a `show`/`list`. The explicit lists still apply.
      logger.debug(
        `Protection status: could not resolve the repo default branch: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    enabled: p.enabled,
    protectedBranches: p.protected_branches,
    gateDefaultBranch: p.gate_default_branch,
    defaultBranch,
    protectedTaskIds,
  };
}

/**
 * Resolve the branch a task's work merges INTO, mirroring accept's resolution
 * (src/daemon/task-lifecycle.ts): a child merges into its parent's `lazy/…`
 * branch, a top-level task into its stored target branch, falling back to
 * `main` exactly as accept does.
 */
export async function resolveTaskTargetBranch(
  storage: Storage,
  task: Task,
): Promise<string | null> {
  const parentId = parentTaskIdOf(task);
  if (parentId) {
    try {
      return await getBranchNameFromId(parentId, storage);
    } catch (err) {
      logger.debug(
        `Protection status: could not resolve parent branch for task ${task.id}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
  return targetBranchOf(task) ?? 'main';
}

/**
 * Compute a task's protection status against an already-loaded context.
 *
 * `targetBranch` may be passed by a caller that already resolved it (the review
 * TUI has it); pass `undefined` to have it resolved here, or `null` when it is
 * genuinely unknown.
 *
 * `hasBranch` says whether the task has a branch of its own yet — used only to
 * report an unarmed task gate. Pass it when the caller already has the session.
 */
export async function protectionStatusForTask(
  storage: Storage,
  ctx: ProtectionContext,
  task: Task,
  opts: { targetBranch?: string | null; hasBranch?: boolean } = {},
): Promise<TaskProtectionStatus> {
  const listedAs = ctx.protectedTaskIds.get(task.id) ?? null;

  const targetBranch =
    opts.targetBranch !== undefined
      ? opts.targetBranch
      : await resolveTaskTargetBranch(storage, task);

  let branchGate: TaskProtectionStatus['branchGate'] = null;
  if (targetBranch) {
    if (ctx.protectedBranches.includes(targetBranch)) {
      branchGate = { branch: targetBranch, source: 'listed' };
    } else if (
      ctx.enabled &&
      ctx.gateDefaultBranch &&
      ctx.defaultBranch !== null &&
      targetBranch === ctx.defaultBranch
    ) {
      branchGate = { branch: targetBranch, source: 'default-branch' };
    }
  }

  let armed = true;
  if (listedAs) {
    armed = opts.hasBranch ?? Boolean((await storage.getSessionByTaskId(task.id))?.git_branch);
  }

  const taskGate = listedAs ? { listedAs, armed } : null;
  const gated = ctx.enabled && (taskGate !== null || branchGate !== null);

  // Probed only for a gated task: a pending approval on an ungated task is
  // leftover bookkeeping, not something a reader must act on.
  let pendingApproval: TaskProtectionStatus['pendingApproval'] = null;
  if (gated) {
    try {
      const approval = await peekHumanApproval(storage, task.id);
      if (approval) pendingApproval = { approvedAt: approval.approved_at };
    } catch (err) {
      // A corrupt approval record throws. It must not break a read-only view;
      // `lazy approve` overwrites it and accept reports it properly.
      logger.debug(
        `Protection status: could not read the approval record for task ${task.id}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    enabled: ctx.enabled,
    gated,
    taskGate,
    branchGate,
    targetBranch,
    pendingApproval,
  };
}

/** Convenience for a single task: load the context and compute in one call. */
export async function loadTaskProtectionStatus(
  storage: Storage,
  config: ResolvedConfig,
  projectRoot: string,
  task: Task,
  opts: { targetBranch?: string | null; hasBranch?: boolean } = {},
): Promise<TaskProtectionStatus> {
  const ctx = await loadProtectionContext(storage, config, projectRoot);
  return protectionStatusForTask(storage, ctx, task, opts);
}

// ---------------------------------------------------------------------------
// Shared phrasing
// ---------------------------------------------------------------------------

/**
 * Markers for a dense view, e.g. `` or `[P]` or `[P][A]`. Empty string when
 * there is nothing to say — callers concatenate unconditionally.
 */
export function protectionMarkers(status: TaskProtectionStatus): string {
  if (!status.gated) return '';
  return status.pendingApproval
    ? `${PROTECTED_MARKER}${APPROVAL_PENDING_MARKER}`
    : PROTECTED_MARKER;
}

/**
 * The value of the "Protected" line in a detail view: `yes (task gate)`,
 * `yes (branch gate)`, `yes (task gate + branch gate)`, or the honest
 * `no (listed, but [protection] is disabled)` for a task the human listed
 * while the master switch is off. Null when there is nothing to report.
 */
export function protectionSummary(status: TaskProtectionStatus): string | null {
  if (status.gated) {
    const kinds: string[] = [];
    if (status.taskGate) kinds.push('task gate');
    if (status.branchGate) kinds.push('branch gate');
    return `yes (${kinds.join(' + ')})`;
  }
  // Not gated, but the human wrote this task into the config: saying nothing
  // would leave them believing a gate is armed when the master switch is off.
  if (status.taskGate) {
    return 'no — listed in [protection].protected_tasks, but protection is disabled';
  }
  return null;
}

/**
 * The explanatory lines under the summary: what each gate is, whether it is
 * armed, and where the approval stands. Plain text — each surface applies its
 * own theme, escaping, or truncation.
 */
export function protectionAdvice(
  status: TaskProtectionStatus,
  taskDisplayId: string,
): string[] {
  const lines: string[] = [];

  if (status.taskGate) {
    lines.push(
      `Listed in [protection].protected_tasks as \`${status.taskGate.listedAs}\` — ` +
      `merging this task's work upward needs human approval, whatever the target.`,
    );
    if (!status.taskGate.armed) {
      lines.push('The task has no branch yet — the gate arms when it does.');
    }
  }

  if (status.branchGate) {
    lines.push(
      status.branchGate.source === 'default-branch'
        ? `Merges into \`${status.branchGate.branch}\`, the repo default branch, ` +
          `protected while [protection] is enabled.`
        : `Merges into protected branch \`${status.branchGate.branch}\` ` +
          `(listed in [protection].protected_branches).`,
    );
  }

  if (!status.gated) return lines;

  lines.push(
    status.pendingApproval
      ? `Approval pending (recorded ${status.pendingApproval.approvedAt}) — ` +
        `spent by the next accept that completes.`
      : `No approval recorded — a human must run \`lazy approve ${taskDisplayId}\` ` +
        `before this task can be accepted.`,
  );

  return lines;
}

/**
 * One-line form for space-constrained headers (the review TUI, a status bar).
 * Null when there is nothing to say.
 */
export function protectionHeadline(status: TaskProtectionStatus): string | null {
  if (!status.gated) return null;
  const what = status.taskGate && status.branchGate
    ? 'protected (task + branch gate)'
    : status.taskGate
      ? 'protected (task gate)'
      : `protected (merges into \`${status.branchGate!.branch}\`)`;
  return status.pendingApproval
    ? `${PROTECTED_MARKER} ${what} — approval pending`
    : `${PROTECTED_MARKER} ${what} — needs \`lazy approve\``;
}

/**
 * The JSON shape returned by MCP `lazy_show` and consumable by the web
 * dashboard. Snake_case to match the rest of the MCP surface; null-safe fields
 * so a consumer can rely on their presence.
 */
export function protectionToJson(status: TaskProtectionStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    gated: status.gated,
    target_branch: status.targetBranch,
    task_gate: status.taskGate
      ? { listed_as: status.taskGate.listedAs, armed: status.taskGate.armed }
      : null,
    branch_gate: status.branchGate
      ? { branch: status.branchGate.branch, source: status.branchGate.source }
      : null,
    approval_pending: status.pendingApproval
      ? { approved_at: status.pendingApproval.approvedAt }
      : null,
    markers: protectionMarkers(status),
    summary: protectionSummary(status),
  };
}
