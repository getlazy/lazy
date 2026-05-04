/**
 * RepositoryDriver abstracts how task branches are merged, published,
 * and synchronized with external systems.
 *
 * Commands call driver methods without knowing the backend — local git,
 * a hosted forge, or anything else that can accept branches and comments.
 */

import type { Task } from '../types';
import type { Storage } from '../storage';

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
 */
export type MergeResult =
  | { status: 'merged'; metadata?: Record<string, string> }
  | { status: 'pending'; reason: string; metadata?: Record<string, string> }
  | { status: 'failed'; error: string; isConflict?: boolean; metadata?: Record<string, string> };

/** Result of publishing a branch (push + optional draft PR creation). */
export interface PublishResult {
  /** Driver-specific metadata to store on the task (e.g., PR URL, PR number). */
  metadata?: Record<string, string>;
}

/** A comment fetched from an external review system. */
export interface RemoteComment {
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

/** Result returned by a driver's importUrl method. */
export interface ImportResult {
  /** Task goal (e.g., PR title) */
  goal: string;
  /** Existing branch name to adopt */
  branch: string;
  /** Driver-specific metadata (e.g., PR number, URL) */
  metadata: Record<string, string>;
  /** Existing comments to import as notes */
  comments?: string[];
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
   */
  markReadyForReview(task: Task): Promise<{ metadata?: Record<string, string> }>;

  /** Fetch comments left on this task's branch since the given timestamp. */
  syncComments(task: Task, since: string): Promise<RemoteComment[]>;

  /**
   * Get the current state of a task's PR/MR on the remote.
   * Returns null if the task has no PR or the state cannot be determined.
   * No-op (returns null) for local driver.
   */
  getPRState(task: Task): Promise<PRState | null>;

  /** Publish a turn summary so external reviewers can follow progress. */
  postTurnSummary(task: Task, content: string): Promise<void>;

  /**
   * Post an approving review on the task's PR/MR with the given reason.
   * For GitHub: submits a PR review with event "APPROVE" and the reason as body.
   * Falls back to a regular PR comment if the review fails.
   * No-op for local driver or when no PR exists.
   *
   * Returns null on success, or a warning message string if neither the review
   * nor the comment fallback could be posted. The caller should display the
   * warning but not fail the accept.
   */
  postAcceptReview(task: Task, reason: string): Promise<string | null>;

  /**
   * Post a requesting-changes review on the task's PR/MR with the given reason.
   * For GitHub: submits a PR review with event "REQUEST_CHANGES" and the reason as body.
   * Falls back to a regular PR comment if the review fails.
   * No-op for local driver or when no PR exists.
   *
   * Returns null on success, or a warning message string if neither the review
   * nor the comment fallback could be posted. The caller should display the
   * warning but not fail the reject.
   */
  postRejectReview(task: Task, reason: string): Promise<string | null>;

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
   * Get the timestamp of the last comment sync from task metadata.
   * Each driver resolves its own metadata key names (with backward compat).
   */
  getLastCommentSyncedAt(task: Task): string | undefined;

  /** Get the canonical metadata key for storing the last comment sync timestamp. */
  commentSyncedAtKey(): string;

  /**
   * Get the sequence number of the last posted turn from task metadata.
   * Returns -1 if no turns have been posted.
   */
  getLastPostedTurnSeq(task: Task): number;

  /** Get the canonical metadata key for storing the last posted turn sequence. */
  postedTurnSeqKey(): string;

  /**
   * Get the timestamp of the last posted note from task metadata.
   * Each driver resolves its own metadata key names (with backward compat).
   */
  getLastPostedNoteAt(task: Task): string | undefined;

  /** Get the canonical metadata key for storing the last posted note timestamp. */
  postedNoteAtKey(): string;

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
   * Used to avoid echoing imported comments back to the remote.
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
}
