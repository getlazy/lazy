/**
 * Protected branches — human-approved accepts (internally: the edge-gate model).
 *
 * A merge is a directed edge `source → target`. Internally the decision is
 * asked about the edge, not the endpoints: today only the INCOMING direction
 * is user-facing (the target is a protected branch, e.g. the repo default
 * branch), and a protected accept cannot complete without a human-recorded
 * approval (`lazy approve <task>`), which is consumed by exactly one accept.
 *
 * Both directions now ship. INCOMING: the target is a protected branch (e.g.
 * the repo default branch). OUTGOING: the SOURCE is a protected TASK — a task
 * that takes work in freely but needs a human to be promoted upward, whatever
 * the target. Protected tasks are listed by code in
 * `[protection].protected_tasks` and resolved to their branches at decision
 * time; the human manages the list with `lazy protect <task> on|off`.
 * See docs/protected-branches.md.
 *
 * This is FRICTION, not security: it flips the builder's default from
 * "auto-accept unless forbidden" to "cannot accept without a deliberate human
 * act". It does not defend against a hostile agent — see
 * docs/protected-branches.md.
 */

import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config';
import { getRemoteDefaultBranch } from '../git/operations';
import { logger } from '../utils/logger';
import { docsSuffix } from '../docs/links';

export interface MergeEdge {
  /** Branch being merged (the task's branch). */
  sourceBranch: string;
  /** Branch being merged into. */
  targetBranch: string;
}

export interface ProtectionConfig {
  /**
   * Master switch — branch protection is OPT-IN and this defaults to false.
   * While disabled, NOTHING in [protection] has any effect: accepts behave
   * as if the feature didn't exist. A single obvious knob so protection can
   * be toggled on/off without deleting the protected_branches /
   * protected_tasks lists.
   */
  enabled: boolean;
  protected_branches: string[];
  /**
   * Protected tasks, by code or short id. Stored as task identifiers rather
   * than branch names because the human thinks in tasks — the branch is an
   * implementation detail that is resolved (through Storage) at decision time.
   */
  protected_tasks: string[];
  gate_default_branch: boolean;
  passphrase_file: string;
}

/** A protected task resolved to the branch its work merges out of. */
export interface ProtectedTaskBranch {
  /** The identifier as written in [protection].protected_tasks. */
  listedAs: string;
  branch: string;
}

export interface EdgeGateDecision {
  gated: boolean;
  /** Human-readable explanation of why the merge is protected. Empty when unprotected. */
  reason: string;
}

/**
 * Pure decision: does this merge require a human approval?
 *
 * `defaultBranch` may be null when the caller knows the target cannot be the
 * repo default branch (or default-branch protection is off) and wants to skip
 * the git lookup. `protectedTaskBranches` is the resolved form of
 * `protection.protected_tasks`; pass an empty list when the caller has not
 * resolved them (the outgoing check is then simply not applied). Branch
 * matching is by exact name — deliberately no globbing ("clever ain't wise";
 * predictable beats convenient).
 */
export function evaluateEdgeGate(
  edge: MergeEdge,
  protection: ProtectionConfig,
  defaultBranch: string | null,
  protectedTaskBranches: ProtectedTaskBranch[] = [],
): EdgeGateDecision {
  // INVARIANT: branch protection is opt-in. With [protection] enabled = false
  // (the default), no merge is ever protected — accepts behave exactly as
  // before the feature existed.
  if (!protection.enabled) {
    return { gated: false, reason: '' };
  }

  // Outgoing direction: the SOURCE is a protected task. Checked first because
  // it holds regardless of the target — including targets the incoming checks
  // deliberately leave alone (a `lazy/*` parent branch) — and because its
  // reason names the task, which is what the human listed.
  const outgoing = protectedTaskBranches.find((t) => t.branch === edge.sourceBranch);
  if (outgoing) {
    return {
      gated: true,
      reason: `task \`${outgoing.listedAs}\` is listed in [protection].protected_tasks — its work needs human approval to move upward`,
    };
  }

  // Incoming direction: the target is a protected branch.
  if (protection.protected_branches.includes(edge.targetBranch)) {
    return {
      gated: true,
      reason: `\`${edge.targetBranch}\` is listed in [protection].protected_branches`,
    };
  }
  if (
    protection.gate_default_branch &&
    defaultBranch !== null &&
    edge.targetBranch === defaultBranch
  ) {
    return {
      gated: true,
      reason: `\`${edge.targetBranch}\` is the repo default branch, protected while [protection] is enabled`,
    };
  }

  return { gated: false, reason: '' };
}

/** Why a listed protected task currently gates nothing. */
export type StaleProtectedTaskReason = 'not-found' | 'ambiguous' | 'no-branch';

/** A `protected_tasks` entry that cannot be resolved to a branch to gate on. */
export interface StaleProtectedTask {
  /** The identifier as written in [protection].protected_tasks. */
  listedAs: string;
  reason: StaleProtectedTaskReason;
  /** One sentence naming what is wrong, for direct display. */
  detail: string;
}

/**
 * Split `[protection].protected_tasks` (codes/short ids) into the entries that
 * resolve to a branch and the entries that do not.
 *
 * Pure classification, no logging — the caller decides how loud to be. The
 * accept path warns (see resolveProtectedTaskBranches); `lazy doctor` renders
 * a single grouped warning; `lazy protect` shows them inline in its listing.
 */
export async function classifyProtectedTasks(
  storage: Storage,
  protectedTasks: string[],
): Promise<{ resolved: ProtectedTaskBranch[]; stale: StaleProtectedTask[] }> {
  const resolved: ProtectedTaskBranch[] = [];
  const stale: StaleProtectedTask[] = [];

  for (const listedAs of protectedTasks) {
    const match = await storage.resolveTask(listedAs);
    if (!match.task) {
      const ambiguous = (match.ambiguousMatches?.length ?? 0) > 0;
      stale.push({
        listedAs,
        reason: ambiguous ? 'ambiguous' : 'not-found',
        detail: ambiguous
          ? `matches ${match.ambiguousMatches!.length} tasks, so it resolves to none`
          : 'matches no task (deleted, or the code changed)',
      });
      continue;
    }
    const session = await storage.getSessionByTaskId(match.task.id);
    if (!session?.git_branch) {
      stale.push({
        listedAs,
        reason: 'no-branch',
        detail: 'has no branch yet — the task has never been started',
      });
      continue;
    }
    resolved.push({ listedAs, branch: session.git_branch });
  }

  return { resolved, stale };
}

/**
 * Resolve `[protection].protected_tasks` to the branches those tasks merge out
 * of, warning about entries that resolve to nothing.
 *
 * A stale entry gates NOTHING (there is no branch to compare against) — it
 * fails open rather than blocking every accept on a config typo. That makes it
 * a gate the human believes is armed but isn't, so it must be loud: warned here
 * on every gated accept, reported by `lazy doctor`, and shown as stale in
 * `lazy protect`'s listing.
 */
export async function resolveProtectedTaskBranches(
  storage: Storage,
  protectedTasks: string[],
): Promise<ProtectedTaskBranch[]> {
  const { resolved, stale } = await classifyProtectedTasks(storage, protectedTasks);
  for (const entry of stale) {
    logger.warn(
      `[protection].protected_tasks lists "${entry.listedAs}", which ${entry.detail} — ` +
      `that entry protects nothing. Fix it with \`lazy protect ${entry.listedAs} off\` ` +
      `or by editing lazy.toml.`,
    );
  }
  return resolved;
}

/**
 * Evaluate protection for a merge, resolving the repo default branch only
 * when the decision actually needs it.
 *
 * `storage` is required for the OUTGOING (protected-task) check; without it
 * only the incoming branch checks run. Callers that can reach storage should
 * always pass it.
 *
 * INVARIANT: subtask→`<prefix>/…` intermediate-parent merges stay unprotected
 * and quiet by default — a lazy-managed task branch is never the repo default
 * branch, so we skip the git lookup (and its "no remote HEAD" warning) for
 * those targets unless config protects them explicitly. (A protected TASK is
 * the deliberate exception: it gates its own outgoing merge even into a
 * `lazy/*` parent, which is the whole point of listing it.)
 */
export async function resolveEdgeGateDecision(
  edge: MergeEdge,
  config: ResolvedConfig,
  projectRoot: string,
  storage?: Storage,
): Promise<EdgeGateDecision> {
  const protection = config.protection;

  // Opt-in master switch: skip everything (including the git lookup) when off.
  if (!protection.enabled) {
    return { gated: false, reason: '' };
  }

  const protectedTaskBranches =
    storage && protection.protected_tasks.length > 0
      ? await resolveProtectedTaskBranches(storage, protection.protected_tasks)
      : [];

  // First pass without the default branch: protected tasks + the explicit list.
  const explicit = evaluateEdgeGate(edge, protection, null, protectedTaskBranches);
  if (explicit.gated) return explicit;
  if (!protection.gate_default_branch) return explicit;

  const taskBranchPrefix = `${config.git.default_branch_prefix}/`;
  if (edge.targetBranch.startsWith(taskBranchPrefix)) return explicit;

  const defaultBranch = await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
  return evaluateEdgeGate(edge, protection, defaultBranch, protectedTaskBranches);
}

// ---------------------------------------------------------------------------
// Human-approval store (one-shot, per task)
// ---------------------------------------------------------------------------
//
// Persisted through the Storage interface as task metadata — never via direct
// file access. One pending approval per task; consuming it clears the slot so
// an approval unlocks exactly one accept.

const APPROVAL_METADATA_KEY = 'edge_gate_approval';

export interface HumanApproval {
  approved_at: string;
}

/** Record a pending human approval for a task (overwrites any prior pending one). */
export async function recordHumanApproval(storage: Storage, taskId: string): Promise<HumanApproval> {
  const approval: HumanApproval = { approved_at: new Date().toISOString() };
  await storage.updateTaskMetadata(taskId, APPROVAL_METADATA_KEY, JSON.stringify(approval));
  return approval;
}

/** Read the pending human approval for a task without consuming it. */
export async function peekHumanApproval(storage: Storage, taskId: string): Promise<HumanApproval | null> {
  const raw = await storage.getTaskMetadata(taskId, APPROVAL_METADATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HumanApproval;
  } catch (err) {
    throw new Error(
      `Corrupt approval record on task ${taskId} (metadata key '${APPROVAL_METADATA_KEY}'): ` +
      `${err instanceof Error ? err.message : err}. Re-run \`lazy approve\` to overwrite it.`,
    );
  }
}

/**
 * Consume the pending human approval for a task: return it and clear it so it
 * cannot satisfy a second accept. Returns null when none is pending.
 *
 * INVARIANT: approval consumption is atomic with accept completion. Callers
 * must NOT call this at gate-check time — an accept that fails afterwards
 * would have burned the human's one-shot approval without merging anything.
 * The accept path reaches this only through {@link EdgeGateClearance.commit},
 * at the point the merge is durably finalized.
 */
export async function takeHumanApproval(storage: Storage, taskId: string): Promise<HumanApproval | null> {
  const approval = await peekHumanApproval(storage, taskId);
  if (!approval) return null;
  await storage.updateTaskMetadata(taskId, APPROVAL_METADATA_KEY, '');
  return approval;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * The outcome of a passed edge-gate check, plus the deferred consumption of
 * whatever satisfied it.
 *
 * `commit()` is what actually spends a one-shot `lazy approve` record. It is
 * a no-op when the gate did not apply, or when a forge PR/MR approval was the
 * satisfier (there is nothing local to spend — and a pending `lazy approve`
 * record must survive for the accept that really needs it).
 *
 * Calling `commit()` more than once is safe: the second call finds nothing
 * pending and does nothing.
 */
export interface EdgeGateClearance {
  /** True when the merge was protected at all. */
  gated: boolean;
  /**
   * True when a pending `lazy approve` record is the satisfier and is still
   * waiting to be spent by `commit()`.
   */
  usesLocalApproval: boolean;
  /**
   * Spend the reserved approval. Call this — and only this — at the point the
   * accept is durably finalized.
   */
  commit: () => Promise<void>;
}

/** Clearance for a merge that needed no approval at all. */
const UNGATED_CLEARANCE: EdgeGateClearance = {
  gated: false,
  usesLocalApproval: false,
  commit: async () => {},
};

export class EdgeGateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeGateRefusedError';
  }
}

/**
 * Build the refusal message for a protected accept with no approval.
 *
 * `forgeAvailable` names the PR/MR route as a second way for the human to
 * approve — but only when there actually is one, so a local-driver project is
 * never pointed at a PR it cannot have.
 */
export function edgeGateRefusalMessage(
  displayId: string,
  edge: MergeEdge,
  reason: string,
  forgeAvailable = false,
): string {
  return (
    `Accepting task ${displayId} would merge \`${edge.sourceBranch}\` into \`${edge.targetBranch}\`, ` +
    `which requires human approval (${reason}). ` +
    `This cannot be satisfied from a builder or agent session — no flag, confirmation code, ` +
    `or retry will complete it. A human must record a one-time approval by running:\n\n` +
    `  lazy approve ${displayId}\n\n` +
    (forgeAvailable
      ? `Approving this task's PR/MR on the forge satisfies the same gate — either act works.\n\n`
      : '') +
    `then re-run the accept. To change what is protected, a human can run ` +
    `\`lazy protect <branch|task> off\` (or turn protection off entirely with ` +
    `[protection] enabled = false in lazy.toml).` +
    docsSuffix('protected-branches', '\n\n')
  );
}

/**
 * Enforce branch protection for an accept. Runs for ALL drivers, including
 * local.
 *
 * When the merge is protected it must be SATISFIED by a deliberate human act.
 * There are two satisfiers, and they are the same mechanism seen from two
 * places — not two competing gates:
 *
 *   1. A forge PR/MR approval (`forgeApproval`), when one is configured and
 *      the task has a remote ref. A human clicking "Approve" on the PR is the
 *      same deliberate act as `lazy approve`, expressed where they were
 *      already reviewing the diff; demanding a second, local approval on top
 *      would be friction with no added judgement behind it.
 *   2. A pending `lazy approve` record, consumed one-approval-per-accept.
 *
 * The forge is checked FIRST so an already-approved PR does not silently burn
 * the human's stored one-shot approval — that approval stays pending for the
 * accept that actually needs it.
 *
 * A `forgeApproval` probe that throws is treated as "no approval": the forge
 * being unreachable must never open the gate, and the human always has
 * `lazy approve` as the offline path. The reason is logged, never swallowed.
 *
 * INVARIANT: approval consumption is atomic with accept completion. Passing
 * the gate does NOT spend the approval — it only reserves it. The returned
 * {@link EdgeGateClearance} carries a `commit()` that the caller invokes at
 * the exact point the merge becomes durable (the same point that writes the
 * lazy-accept tag / hands the merge to the forge). An accept that fails or is
 * aborted at ANY phase therefore leaves the approval intact and re-usable,
 * while a successful accept still spends it exactly once. The check and the
 * commit both run inside accept's per-task lifecycle lock, so two concurrent
 * accepts cannot both consume the same approval.
 */
export async function enforceEdgeGate(opts: {
  storage: Storage;
  config: ResolvedConfig;
  projectRoot: string;
  taskId: string;
  displayId: string;
  edge: MergeEdge;
  /**
   * Probe for a human approval recorded on the forge (GitHub/GitLab) for this
   * task's PR/MR. Omitted by callers with no forge, and by the local driver.
   */
  forgeApproval?: () => Promise<boolean>;
}): Promise<EdgeGateClearance> {
  const decision = await resolveEdgeGateDecision(opts.edge, opts.config, opts.projectRoot, opts.storage);
  if (!decision.gated) return UNGATED_CLEARANCE;

  if (opts.forgeApproval) {
    let approvedOnForge = false;
    try {
      approvedOnForge = await opts.forgeApproval();
    } catch (err) {
      // Fail CLOSED: an unreachable forge leaves the gate shut, and the
      // refusal below tells the human how to approve locally instead.
      logger.warn(
        `Branch protection: could not check for a PR/MR approval on task ${opts.displayId} ` +
        `(${err instanceof Error ? err.message : err}) — treating it as unapproved. ` +
        `Use \`lazy approve ${opts.displayId}\` to approve locally.`,
      );
    }
    if (approvedOnForge) {
      logger.info(
        `Branch protection: satisfied by a PR/MR approval on task ${opts.displayId} — ` +
        `merging \`${opts.edge.sourceBranch}\` into \`${opts.edge.targetBranch}\`.`,
      );
      // Nothing local to spend, and any pending `lazy approve` record stays
      // pending for an accept that actually needs it.
      return { gated: true, usesLocalApproval: false, commit: async () => {} };
    }
  }

  // RESERVE, do not spend: peek only. The approval is consumed by commit()
  // once the merge is durable — see the invariant on this function.
  const approval = await peekHumanApproval(opts.storage, opts.taskId);
  if (approval) {
    logger.info(
      `Branch protection: using human approval for task ${opts.displayId} ` +
      `(recorded at ${approval.approved_at}) — merging \`${opts.edge.sourceBranch}\` into ` +
      `\`${opts.edge.targetBranch}\`. It is spent only once the merge completes; ` +
      `if this accept fails, the approval stays valid for a retry.`,
    );
    return {
      gated: true,
      usesLocalApproval: true,
      commit: async () => {
        const spent = await takeHumanApproval(opts.storage, opts.taskId);
        if (spent) {
          logger.info(
            `Branch protection: consumed human approval for task ${opts.displayId} ` +
            `(recorded at ${spent.approved_at}) — the accept completed.`,
          );
        }
      },
    };
  }

  throw new EdgeGateRefusedError(edgeGateRefusalMessage(opts.displayId, opts.edge, decision.reason, !!opts.forgeApproval));
}
