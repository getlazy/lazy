/**
 * RepositoryDriver abstracts how task branches are merged, published,
 * and synchronized with external systems.
 *
 * Commands call driver methods without knowing the backend — local git,
 * a hosted forge, or anything else that can accept branches and comments.
 */

import type { Task, CommentForge, CommentExternalKind } from '../types';
import type { Storage } from '../storage';
import type { DestinationRestoreConflict } from '../git/operations';

/**
 * Truncate a PR/MR title to 128 characters to avoid GitLab's 255-char limit.
 * If truncated, appends "..." to indicate the title was cut.
 *
 * The 128-char limit provides a safety margin — GitLab enforces 255 chars,
 * but keeping titles shorter improves readability in UI lists.
 *
 * Counts UTF-16 code units (string.length) while respecting code point
 * boundaries to prevent splitting multi-byte characters like emoji.
 */
export function truncateMRTitle(title: string): string {
  const MAX_LENGTH = 128;

  // Fast path: if already short enough, return as-is
  if (title.length <= MAX_LENGTH) {
    return title;
  }

  // Iterate by code points, tracking UTF-16 code unit length
  const chars = Array.from(title);
  let codeUnitLength = 0;
  let codePointCount = 0;

  // Find how many code points we can fit in (MAX_LENGTH - 3) code units
  for (const char of chars) {
    const charLength = char.length; // UTF-16 code units for this code point
    if (codeUnitLength + charLength > MAX_LENGTH - 3) {
      break;
    }
    codeUnitLength += charLength;
    codePointCount++;
  }

  return chars.slice(0, codePointCount).join('') + '...';
}

/**
 * Lightweight dependency injection context for drivers that need
 * access to task state (e.g., checking if a worktree belongs to
 * a working task before fast-forwarding into it).
 *
 * Passed at construction time via createDriver(). Optional — drivers
 * that don't receive a context degrade gracefully (skip the check).
 */
export interface DriverContext {
  storage: Storage;
  lazyRoot: string;
}

/**
 * Result of a driver detecting that it should handle a repository.
 * Contains the TOML config key/value pairs to inject into lazy.toml.
 */
export interface DriverDetection {
  /** Human-readable name for the detected remote (e.g., "GitHub") */
  name: string;
  /** Config to inject into lazy.toml (e.g., { 'remote.driver': 'github' }) */
  tomlOverrides: Record<string, string>;
}

/**
 * A driver detection function. Each driver registers one.
 * Returns a DriverDetection if it claims the repo, null otherwise.
 * @param repoDir - the repository directory to inspect
 * @param remoteName - the git remote name to check (default: 'origin')
 */
export type DetectRemoteFn = (repoDir: string, remoteName?: string) => DriverDetection | null;

/** Options passed to the driver's merge method. */
export interface MergeOptions {
  /** The task's git branch (e.g., "lazy/abc12345") */
  sourceBranch: string;
  /** The branch to merge into (e.g., "main" or "lazy/parent-id") */
  targetBranch: string;
  /** The task being accepted */
  task: Task;
  /** Short ID of the task (e.g., "abc12345") */
  taskShortId: string;
  /** Repository root path */
  root: string;
  /**
   * Optional synthesized faithful summary of what the work actually became.
   * Used by the LocalDriver as the squash commit body (commit/PR fidelity).
   * Hosted drivers ignore it — they read the (already-updated) PR/MR body live
   * at merge time. When absent, the local squash falls back to the
   * deterministic goal + commit-subjects message.
   */
  fidelityBody?: string;
  /**
   * This merge RESUMES an accept that died after the human said accept. The work
   * may already be on the target: a merge that would change nothing then answers
   * `merged` with `alreadyLanded`, instead of the fresh-accept refusal "squash
   * merge produced no commit". Never set on a fresh accept — there, a no-op
   * squash still means the branch is net-empty. Hosted drivers honour it too:
   * their ancestry check (`isBranchMerged`) cannot see a squash that already
   * landed, so on a resume they also ask the trees (`changesAlreadyOnRemoteTarget`
   * — would merging the branch into the remote target change nothing?) and
   * answer `alreadyLanded` when it would not.
   */
  resume?: boolean;
}

/**
 * A warning from a pre-merge gate check.
 * Each warning represents a condition that would normally block the merge.
 */
export interface AcceptGateWarning {
  /** Which gate produced this warning (e.g., "ci", "reviews", "comments") */
  gate: string;
  /** Human-readable description of the issue */
  message: string;
}

/**
 * Result of a driver's merge operation. Three outcomes:
 *
 * - `merged`: Branch is now merged (either just completed or was already merged). Done.
 * - `pending`: Cannot merge yet. Reason is human-readable (e.g., "Pipeline running",
 *   "Required checks pending"). The task should be set to 'merging' status.
 * - `failed`: Merge attempted but failed. `isConflict` indicates merge conflicts
 *   (caller can offer sync-with-upstream). Other failures are errors.
 *
 * On `merged`, `restoreConflict` is set when the merge committed durably but the
 * destination worktree's stashed uncommitted work could not be auto-restored —
 * the accept still succeeded; the caller hands the reconciliation to the
 * destination worktree's owning task.
 */
export type MergeResult =
  | { status: 'merged'; metadata?: Record<string, string>; restoreConflict?: DestinationRestoreConflict; alreadyLanded?: boolean }
  | { status: 'pending'; reason: string; metadata?: Record<string, string> }
  | { status: 'failed'; error: string; isConflict?: boolean; metadata?: Record<string, string> };

/** Result of publishing a branch (push + optional draft PR creation). */
export interface PublishResult {
  /** Driver-specific metadata to store on the task (e.g., PR URL, PR number). */
  metadata?: Record<string, string>;
}

/** A comment fetched from an external review system. */
export interface RemoteComment {
  /** Which forge the item lives on. With kind and id, its identity. */
  forge: CommentForge;
  /** Which kind of forge item — ids are unique only within a kind. */
  kind: CommentExternalKind;
  /** The forge's own id for the item (no namespace prefix). */
  id: string;
  body: string;
  author: string;
  createdAt: string;
  /** File path if this is an inline comment */
  path?: string;
  /** Line number if this is an inline comment */
  line?: number;
}

/** State of a PR/MR on the remote forge. */
export type PRState = 'OPEN' | 'MERGED' | 'CLOSED';

/** A single health-check result reported by a driver. */
export interface HealthCheck {
  state: 'ok' | 'warn' | 'fail';
  /** Human-readable label, e.g. "gh CLI installed", "GitHub authentication" */
  what: string;
  /** Explanation for warn/fail states */
  reason?: string;
}

/** A deprecated config option with a human-readable alternative. */
export interface DeprecatedConfigOption {
  /** Key name within [remote] section, e.g. "token_env" */
  key: string;
  /** Human-readable explanation of what to do instead */
  alternative: string;
}

/** Config options declared by a driver for its [remote] section keys. */
export interface DriverConfigOptions {
  /** Valid config keys this driver recognizes in [remote] (besides 'driver') */
  valid: string[];
  /** Deprecated/obsolete keys with migration guidance */
  deprecated: DeprecatedConfigOption[];
}

/** Options passed to a driver's importUrl method. */
export interface ImportOptions {
  /** Parent task ID to set on the imported task */
  parentTaskId?: string;
}

/** Result of waiting for CI checks to complete. */
export type ChecksResult =
  | { passed: true }
  | { passed: false; failed: Array<{ name: string; url?: string }>; timedOut?: boolean };

/**
 * Result of a single-shot CI checks status query.
 *
 * - `passed`: All checks completed successfully (or no checks configured).
 * - `failed`: At least one check failed. Details in `failed` array.
 * - `pending`: Checks are still running. No failures yet.
 */
export type ChecksStatusResult =
  | { status: 'passed' }
  | { status: 'failed'; failed: Array<{ name: string; url?: string }> }
  | { status: 'pending' };

/** A single failed CI job with enough detail to be actionable. */
export interface CIJobFailure {
  /** The job/check name (e.g., "lint", "test-unit"). */
  name: string;
  /** URL to the CI run page. */
  url?: string;
  /** Truncated log output from the failed job. */
  log?: string;
}

/** Options for waitForChecks. */
export interface WaitForChecksOptions {
  /** Maximum time to wait in milliseconds. Default: 600000 (10 minutes). */
  timeout?: number;
  /** Polling interval in milliseconds. Default: 10000 (10 seconds). */
  pollInterval?: number;
}

/** Options for {@link RepositoryDriver.markReadyForReview}. */
export interface MarkReadyOptions {
  /** Explicit base for a NEW PR/MR (see markReadyForReview). */
  baseBranch?: string;
}

/** An open PR/MR found on the forge by its head branch. */
export interface OpenReview {
  url: string;
  /** The branch the PR/MR merges into. */
  baseBranch: string;
  /** Task metadata that records it — the keys markReadyForReview would write. */
  metadata: Record<string, string>;
}

/** Result returned by a driver's importUrl method. */
export interface ImportResult {
  /** Task goal (e.g., PR title) */
  goal: string;
  /**
   * The PR/MR description body, when the driver has one.
   *
   * Not stored on the task: it is raw material for the link-time description
   * one-shot (src/daemon/link-describe.ts), which turns it — together with the
   * commits, the diff and the imported comments — into the task's prompt.
   */
  description?: string;
  /** Existing branch name to adopt */
  branch: string;
  /** Driver-specific metadata (e.g., PR number, URL) */
  metadata: Record<string, string>;
  /** Existing comments to import as notes, with their forge identity. */
  comments?: RemoteComment[];
}

/**
 * RepositoryDriver abstracts the repository backend that lazy talks to.
 *
 * Each method corresponds to a lifecycle event in lazy's task flow.
 * Drivers that have no meaningful action for a given event (e.g., a
 * local-only driver has nothing to push) simply return immediately.
 */
export interface RepositoryDriver {
  /**
   * Attempt to merge a task's branch into the target branch.
   *
   * Three possible outcomes:
   * - `merged`: Branch is now merged (completed or was already merged).
   * - `pending`: Cannot merge yet (pipeline running, checks pending, etc.).
   *   Returns a human-readable reason. Caller sets task to 'merging'.
   * - `failed`: Merge failed (conflicts, errors). Caller should NOT change
   *   task state — offer sync-with-upstream for conflicts, show error otherwise.
   *
   * - LocalDriver: squash-merge locally, always immediate (merged or failed).
   * - GitLabDriver: push + squash merge via glab. Returns pending if pipeline running.
   * - GitHubDriver: push + squash merge via gh. Returns pending if checks running.
   */
  merge(opts: MergeOptions): Promise<MergeResult>;

  /**
   * Get the current CI checks/pipeline status for a task's PR, without polling.
   *
   * Returns immediately with the current state:
   * - `passed`: All checks completed successfully (or no checks configured).
   * - `failed`: At least one check failed.
   * - `pending`: Checks are still running.
   *
   * Used by the reconciler to detect failed pipelines on merging tasks.
   * LocalDriver: always returns { status: 'passed' } (no remote checks).
   */
  getChecksStatus(task: Task): Promise<ChecksStatusResult>;

  /**
   * Wait for CI checks on a task's PR to complete.
   * Polls check status until all checks pass, any fail, or timeout.
   * Returns { passed: true } immediately if no checks are configured.
   * LocalDriver: always returns { passed: true } (no remote checks).
   */
  waitForChecks(task: Task, options?: WaitForChecksOptions): Promise<ChecksResult>;

  /** Push the branch to the remote. No-op for local driver. */
  pushBranch(branch: string): Promise<void>;

  /**
   * Fetch a branch from the remote into the local worktree.
   * Only fetches (updates origin/<branch> ref) — does NOT merge.
   * The merge is handled by the supervisor's sync-with-remote phase,
   * where the agent can resolve conflicts.
   *
   * Returns true if the remote has new commits ahead of local, false if up-to-date.
   * Network failures should throw (caller handles them as non-fatal).
   * No-op for local driver.
   */
  fetchBranch(branch: string, worktreePath: string): Promise<boolean>;

  /**
   * Publish a branch for the first time: push + create draft PR (or equivalent).
   * Called at start time. Returns metadata to store on the task (e.g., PR URL).
   */
  publishBranch(opts: {
    branch: string;
    targetBranch: string;
    task: Task;
  }): Promise<PublishResult>;

  /**
   * Mark a branch as ready for review.
   * For GitHub: creates PR if it doesn't exist yet, then undrafts.
   * Called after the first agent turn completes (task transitions to blocked).
   * Returns metadata to store on the task (e.g., PR URL/number if PR was created).
   * No-op for local driver.
   *
   * `opts.baseBranch` names the base of a NEW PR/MR explicitly. It exists for
   * one caller: an explicit `lazy submit` by a person on a task that
   * integrates into an intermediate (task) branch. Without it the base is
   * derived from the task's target and a task-branch target is refused — by
   * default lazy never opens a PR/MR for an intermediate branch on its own.
   * It never re-targets a PR/MR that already exists.
   */
  markReadyForReview(task: Task, opts?: MarkReadyOptions): Promise<{ metadata?: Record<string, string> }>;

  /**
   * The SHA `branch` points at on the remote, or null when the remote has no
   * such branch. Asks the remote (`git ls-remote`), never a local tracking
   * ref, which can be stale or missing. Throws when the remote cannot be
   * asked, so "not there" is never confused with "could not tell".
   *
   * LocalDriver: always null (there is no remote).
   */
  remoteBranchHead(branch: string): Promise<string | null>;

  /**
   * The OPEN PR/MR whose head is `branch`, if one exists — including one a
   * person opened by hand on the forge. Lightweight (no comment import), so
   * `lazy submit` can adopt it instead of failing to open a second one.
   * Closed and merged PRs/MRs are never returned. Throws when the forge
   * cannot be asked.
   *
   * LocalDriver: always null.
   */
  findOpenReviewForBranch(branch: string): Promise<OpenReview | null>;

  /**
   * The base branch of the PR/MR this task records, in whatever state it is
   * (open, merged, closed), or null when the task records none. Read from the
   * FORGE — a PR's base is a forge-side fact that can drift from the task's
   * target (a reparent, a person editing the PR). Throws when the forge cannot
   * be asked.
   *
   * LocalDriver: always null.
   */
  getReviewBase(task: Task): Promise<string | null>;

  /**
   * Change the base of the PR/MR this task records to `base` on the forge
   * (`gh pr edit --base`, `glab mr update --target-branch`). Called only when a
   * reparent moved the task's target under an open PR (src/daemon/review-retarget.ts).
   * Throws when the forge refuses or cannot be asked; the caller closes the PR
   * instead rather than leave it merging somewhere the task no longer goes.
   *
   * LocalDriver: never called (it records no PR); throws if it is.
   */
  retargetReview(task: Task, base: string): Promise<void>;

  /**
   * Fetch comments (and review summaries) left on this task's PR/MR. With
   * `since`, only those written at or after it: a display window for the turn
   * prompt. Without it, everything visible. Importers must omit it and dedup
   * by id, because an item's timestamp is when it was written, not when it
   * became visible, so no timestamp watermark can be trusted to import it.
   */
  syncComments(task: Task, since?: string): Promise<RemoteComment[]>;

  /**
   * Get the current state of a task's PR/MR on the remote.
   * Returns null if the task has no PR or the state cannot be determined.
   * No-op (returns null) for local driver.
   */
  getPRState(task: Task): Promise<PRState | null>;

  /**
   * Update the lazy-owned, delimited section of the PR/MR body with a
   * synthesized summary reflecting what the work actually became (pivots,
   * human-feedback rounds, child contributions).
   *
   * Updates ONLY the text between the lazy delimiters — human-authored edits to
   * the rest of the description are preserved. If the delimiters are absent, a
   * fresh delimited section is appended (never clobbering human text).
   *
   * This is a remote *write*: it uses the fail-hard retry policy and THROWS on
   * remote failure (no silent fallback). Callers that treat body regeneration
   * as an enhancement (accept, sync) wrap this in try/catch so a write failure
   * never blocks the merge or push — distinct from synthesis failure, which is
   * handled upstream in src/synthesis/fidelity.ts.
   *
   * No-op for the local driver (no remote body to update).
   */
  updateRemoteBody(task: Task, summary: string): Promise<void>;

  /**
   * Submit an approving review so the forge will let the merge through.
   *
   * INVARIANT: this is the ONLY review or comment lazy writes to a PR/MR, and
   * it runs ONLY under `[remote] auto_approve` on a protected target — where
   * the forge refuses the merge without an approval, so the write is the
   * mechanism, not narration. Everything else lazy used to post (review
   * findings, accept/reject reviews) was removed on 2026-09-21: forge
   * notifications for lazy's own bookkeeping annoyed the humans watching the
   * PR. Do not add a second write path here.
   *
   * For GitHub: submits a PR review with event "APPROVE" and the reason as
   * body. There is NO comment fallback — a comment is not an approval, so it
   * would not unblock the merge, and posting one is the thing this method's
   * invariant forbids. An implementation that cannot approve reports that and
   * writes nothing. No-op for the local driver or when no PR exists.
   *
   * Returns null when the approval landed, and null for a forge refusing a
   * SELF-approval (GitHub's 422): that is the expected outcome for the sole
   * developer `auto_approve` is aimed at, so it is logged at debug and the
   * accept carries on — warning about it on every accept is noise, not news.
   * Any other failure returns a warning string the caller should display
   * without failing the accept.
   */
  approveForMerge(task: Task, reason: string): Promise<string | null>;

  /** Clean up external resources when a task is rejected or closed. */
  cleanup(branch: string): Promise<void>;

  /** Report driver health as a list of checks. */
  checkHealth(): Promise<HealthCheck[]>;

  /** Declare valid and deprecated config keys for the [remote] section. */
  getConfigOptions(): DriverConfigOptions;

  /**
   * Get the URL (e.g., PR URL, issue URL, MR URL) for a task in the remote system.
   * Returns null if no URL is available (local driver, or task has no remote reference).
   * Used to display the remote link in editor headers and task context.
   */
  getTaskUrl(task: Task): Promise<string | null>;

  /**
   * Check whether a task has a remote reference (PR, MR, issue, etc.).
   * Returns true if the task has driver-specific metadata indicating a
   * remote entity exists. Used by callers that need to know "is there a PR?"
   * without knowing the driver's metadata key names.
   */
  hasRemoteRef(task: Task): boolean;

  /**
   * Validate whether accept can proceed for a task.
   * Returns null if accept can proceed, or an error message string if it cannot.
   * Each driver defines its own preconditions — e.g., GitHubDriver requires
   * a remote ref (PR) to exist before accept can merge via the API.
   */
  validateAccept(task: Task): string | null;

  /**
   * Check whether a target branch has protection rules on the remote.
   * Returns true if the branch has protection rules (e.g., required reviews,
   * required status checks), false otherwise.
   *
   * LocalDriver: always returns false (no remote protection).
   * GitHubDriver: checks via GitHub API branch protection endpoint.
   * GitLabDriver: checks via GitLab API protected branches endpoint.
   */
  isTargetBranchProtected(targetBranch: string): Promise<boolean>;

  /**
   * Check whether the MR/PR for a task has at least one external approval.
   * "External" means from someone other than the lazy service account.
   * Returns true if at least one approval exists, false otherwise.
   *
   * LocalDriver: always returns false (no remote approvals).
   * GitHubDriver: checks PR reviews for APPROVED status.
   * GitLabDriver: checks MR approval status via API.
   */
  hasExternalApproval(task: Task): Promise<boolean>;

  /**
   * Check pre-merge gates (CI status, review status, unresolved comments).
   *
   * Returns an array of warnings. An empty array means all gates pass.
   * Used by the accept CLI to block merges when gates are failing.
   *
   * LocalDriver: always returns [] (no remote gates).
   * GitHubDriver: checks CI checks, review decision, and unresolved review threads.
   * GitLabDriver: checks pipeline status, approval status, and unresolved discussions.
   */
  checkAcceptGates(task: Task): Promise<AcceptGateWarning[]>;

  /**
   * Resolve the upstream branch ref for sync-with-upstream.
   *
   * For remote drivers (e.g., GitHub): fetches origin/<branch> and returns
   * "origin/<branch>" so the supervisor merges the remote-tracking ref
   * (which reflects the true upstream state) instead of a stale local branch.
   *
   * For local drivers: returns the branch name as-is (no remote to fetch).
   *
   * Network failures fall back to the local branch name — the merge will
   * use whatever state is available locally.
   */
  resolveUpstreamRef(parentBranch: string, worktreePath: string): Promise<string>;

  /**
   * The ref name {@link resolveUpstreamRef} resolves `parentBranch` to, with NO
   * network I/O: `<remote>/<branch>` for a hosted driver, the branch itself for
   * a local one. `resolveUpstreamRef` is this name plus the fetch that refreshes
   * it.
   *
   * Read-only surfaces — above all a task diff — need the SAME answer the task
   * launcher branched from, but must not fetch: rendering a diff is not a
   * network operation, and a three-dot diff is merge-base-based, so a slightly
   * stale remote-tracking ref gives an identical result.
   */
  upstreamRefName(parentBranch: string): string;

  /**
   * After a successful accept, attempt to fast-forward the local parent branch
   * to match the remote. This prevents the next task from starting on a stale
   * SHA and showing a confusing merge commit on turn 1.
   *
   * Two strategies depending on whether the target branch is checked out:
   * - Checked out (common — user on main): `git fetch origin <branch>` then
   *   `git merge --ff-only origin/<branch>`. Safe because ff-only refuses on divergence.
   * - Not checked out (child→parent merge): `git fetch origin <branch>:<branch>`
   *   (refspec fetch) which atomically advances the local ref.
   *
   * - LocalDriver: no-op, returns { success: true } (no remote to sync from)
   * - GitHubDriver: fetches and fast-forwards; returns warning if local has diverged
   */
  fastForwardLocal(targetBranch: string, root: string): Promise<{ success: boolean; warning?: string }>;

  /**
   * Whether this driver supports periodic sync (push branches, create PRs,
   * post comments, etc.). Returns false for drivers with no remote (e.g., LocalDriver).
   * Used by callers to decide whether to run sync at all.
   */
  needsSync: boolean;

  /**
   * Fetch upstream state from the remote (e.g., git fetch + fast-forward).
   * Called at the start of sync to bring local state up to date.
   * Throws an error if the driver has no remote to fetch from.
   *
   * @param branchesToUpdate - Additional branches to fast-forward beyond the
   *   default branch (e.g., task target branches). Branches that don't exist
   *   locally are silently skipped.
   */
  fetchRemoteState(root: string, branchesToUpdate?: string[]): Promise<void>;

  /**
   * Get the sequence number of the last turn already reflected in the PR/MR
   * body's lazy-owned fidelity section, from task metadata. Returns -1 when
   * nothing has been reflected yet. Drivers resolve their own metadata key
   * names, reading the pre-fidelity "posted turn" keys as fallbacks so
   * existing stores keep their progress.
   */
  getLastFidelityTurnSeq(task: Task): number;

  /** Get the canonical metadata key for the fidelity turn watermark. */
  fidelityTurnSeqKey(): string;

  /**
   * Get the stored CI failure signature from task metadata.
   * Used to deduplicate CI failure comments — if the signature matches
   * the current failure set, no new comment is posted.
   * Returns undefined if no CI failures have been synced.
   */
  getLastCIFailureSynced(task: Task): string | undefined;

  /** Get the canonical metadata key for storing the CI failure signature. */
  ciFailureSyncedKey(): string;

  /**
   * Fetch detailed information about failed CI jobs for a task's PR/MR.
   * Returns an array of failed jobs with name, URL, and truncated log output.
   *
   * Agents run in containers with no browser access — they cannot follow links
   * to CI pages. The log output is essential for the agent to diagnose and fix
   * failures without human intervention.
   *
   * Returns an empty array if no CI failures exist, or if the task has no remote ref.
   * LocalDriver: always returns [] (no remote CI).
   *
   * When branchName is provided, looks up CI status by branch (works even
   * without a PR/MR). Falls back to PR/MR-based lookup if branch lookup
   * fails or branchName is not provided.
   */
  getFailedCIJobs(task: Task, branchName?: string): Promise<CIJobFailure[]>;

  /**
   * Get the remote reference URL (PR/MR URL) from task metadata.
   * Each driver resolves its own metadata key names (with backward compat).
   * Returns null if no URL is available.
   */
  getRemoteRefUrl(task: Task): string | null;

  /**
   * Get the remote reference state (e.g., OPEN, MERGED, CLOSED) from task metadata.
   * Each driver resolves its own metadata key names.
   * Returns null if no state is available.
   */
  getRemoteRefState(task: Task): string | null;

  /**
   * Format a remote comment for storage as a local note.
   * The returned string includes driver-specific dedup markers so that
   * re-importing the same comment is idempotent.
   */
  formatImportedComment(comment: RemoteComment, task: Task): string;

  /**
   * Check if a note's content was originally imported from the remote.
   * Read by auto-react to keep lazy's own imported comments out of the
   * human-comment feed: a PR/MR comment lazy imported must never be treated
   * as fresh human feedback, or auto-react would react to it in a loop.
   */
  isImportedComment(noteContent: string): boolean;

  /**
   * Attempt to recover a task's remote reference (PR/MR) by looking it up
   * via branch name. Called when a submitted task has no remote ref metadata,
   * which prevents the daemon from detecting when the PR/MR is merged.
   *
   * Returns metadata to persist (e.g., PR number, URL) if a remote ref is
   * found, or null if no matching PR/MR exists on the remote.
   *
   * LocalDriver: always returns null (no remote refs).
   */
  recoverRemoteRef(task: Task): Promise<Record<string, string> | null>;

  /** Check if this driver can handle an import URL. */
  canImport?(url: string): boolean;

  /** Import a resource from a URL (e.g., adopt an existing PR). */
  importUrl?(url: string, opts: ImportOptions): Promise<ImportResult>;

  /**
   * Find an open PR/MR for `branch` and import it the same way as importUrl.
   * Returns null when none exists (or the driver has no forge). Used at
   * `lazy link <branch>` time and by the daemon's later-PR-discovery pass.
   *
   * Must look up by the real git branch name — never `lazy/<task-ref>`.
   * Linked tasks adopt someone else's branch; getBranchName() is the wrong ref.
   */
  findPullRequestForBranch?(branch: string): Promise<ImportResult | null>;
}
