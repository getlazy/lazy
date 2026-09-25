/**
 * Protected branches — human-approved accepts (internally: the edge-gate model).
 *
 * A merge is a directed edge `source → target`. Internally the decision is
 * asked about the edge, not the endpoints: a protected accept cannot complete
 * without a deliberate human act — the human types the approval passphrase at
 * `lazy accept`'s own prompt, in the same invocation that merges. The approval
 * is therefore inherently bound to the exact commits being merged: there is no
 * stored token to go stale or to authorize a later, different diff.
 *
 * Both directions now ship. INCOMING: the target is a protected branch (e.g.
 * the repo default branch). OUTGOING: the SOURCE is a protected TASK — a task
 * that takes work in freely but needs a human to be promoted upward, whatever
 * the target. Protected tasks are listed by code in
 * `[protection].protected_tasks` and resolved to their branches at decision
 * time; the human manages the list with `lazy protect <task> on|off`.
 * See public-docs/protected-branches.md.
 *
 * This is FRICTION, not security: it flips the builder's default from
 * "auto-accept unless forbidden" to "cannot accept without a deliberate human
 * act". It does not defend against a hostile agent — see
 * public-docs/protected-branches.md.
 */

import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config';
import { getRemoteDefaultBranch } from '../git/operations';
import { logger } from '../utils/logger';
import { docsSuffix } from '../docs/links';
import { createHumanTokenVerifier } from './verify-token';

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
// Enforcement
// ---------------------------------------------------------------------------
//
// There is deliberately NO stored approval here. The pre-v0.22
// `edge_gate_approval` metadata record (`lazy approve`) was a floating
// credential: an `approved_at` stamp with no expiry and no binding to the
// commits being merged, so a pre-approval could let a later, different diff
// through. Approval is now supplied inline — the passphrase travels with the
// accept that uses it — so it cannot outlive or drift from the merge it
// authorizes. Do not reintroduce a stored approval token.

export class EdgeGateRefusedError extends Error {
  /**
   * True when a token WAS supplied and simply did not match the enrolled
   * passphrase. Callers use it to distinguish "retype it" from "nothing is
   * enrolled / you need to approve at all" when composing a remedy.
   */
  readonly tokenRejected: boolean;

  constructor(message: string, tokenRejected = false) {
    super(message);
    this.name = 'EdgeGateRefusedError';
    this.tokenRejected = tokenRejected;
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
  /**
   * The complete pasteable command (approved files, typed reason). The daemon
   * composes it; this function only interpolates. Absent, a bare accept.
   */
  acceptCommand?: string,
): string {
  const cmd = acceptCommand ?? `lazy accept ${displayId}`;
  return (
    `Accepting task ${displayId} would merge \`${edge.sourceBranch}\` into \`${edge.targetBranch}\`, ` +
    `which requires human approval (${reason}). ` +
    `This cannot be satisfied from a builder or agent session — no flag, confirmation code, ` +
    `or retry will complete it. A human must run, from their own terminal:\n\n` +
    `  ${cmd}\n\n` +
    `which prompts for the approval passphrase and merges in one step. ` +
    `There is no non-interactive path.\n\n` +
    (forgeAvailable
      ? `Approving this task's PR/MR on the forge satisfies the same gate — either act works.\n\n`
      : '') +
    `To change what is protected, a human can run ` +
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
 *      same deliberate act as typing the passphrase, expressed where they were
 *      already reviewing the diff; demanding the passphrase on top would be
 *      friction with no added judgement behind it.
 *   2. The approval passphrase (`token`), typed by the human at `lazy accept`'s
 *      own prompt and verified here, inline with the merge it authorizes.
 *
 * The forge is checked FIRST so an already-approved PR merges without the
 * human being prompted for a passphrase they don't need to type.
 *
 * A `forgeApproval` probe that throws is treated as "no approval": the forge
 * being unreachable must never open the gate, and the human always has the
 * inline passphrase as the offline path. The reason is logged, never swallowed.
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
  /**
   * The approval passphrase, collected by the CLI at its own TTY prompt.
   * Verified inline via the verify-token seam — never stored, so it cannot
   * outlive this accept.
   */
  token?: string;
  /**
   * Complete `lazy accept …` command to name in the refusal. The caller
   * composes it (approved files, typed reason); this gate only prints it.
   */
  acceptCommand?: string;
}): Promise<void> {
  const decision = await resolveEdgeGateDecision(opts.edge, opts.config, opts.projectRoot, opts.storage);
  if (!decision.gated) return;

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
        `Run \`lazy accept ${opts.displayId}\` from a terminal to approve with the passphrase instead.`,
      );
    }
    if (approvedOnForge) {
      logger.info(
        `Branch protection: satisfied by a PR/MR approval on task ${opts.displayId} — ` +
        `merging \`${opts.edge.sourceBranch}\` into \`${opts.edge.targetBranch}\`.`,
      );
      return;
    }
  }

  if (opts.token !== undefined) {
    const verifier = createHumanTokenVerifier(opts.projectRoot);
    const verification = await verifier.verify(opts.token);
    if (verification.ok) {
      logger.info(
        `Branch protection: satisfied by inline human approval (${verifier.kind}) for task ${opts.displayId} — ` +
        `merging \`${opts.edge.sourceBranch}\` into \`${opts.edge.targetBranch}\`.`,
      );
      return;
    }
    throw new EdgeGateRefusedError(verification.message, verification.mismatch === true);
  }

  throw new EdgeGateRefusedError(edgeGateRefusalMessage(
    opts.displayId,
    opts.edge,
    decision.reason,
    !!opts.forgeApproval,
    opts.acceptCommand,
  ));
}
