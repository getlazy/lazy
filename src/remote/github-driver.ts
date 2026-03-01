/**
 * GitHubDriver — RepositoryDriver for GitHub PR-based workflows.
 *
 * Lifecycle:
 *   start  → publishBranch(): push + create draft PR
 *   turns  → pushBranch(): push latest commits (auto_push)
 *   blocked → markReadyForReview(): undraft PR after first agent turn
 *   accept → accept(): push + squash merge via GitHub API
 *   close/reject → cleanup(): close the PR
 *
 * Uses the `gh` CLI for all GitHub interactions. Authentication is
 * handled entirely by `gh auth login` — no env var needed.
 *
 * ## Security model
 *
 * - **External comments are untrusted input.** PR comments (from syncComments)
 *   are authored by external users and injected into agent prompts. They must
 *   never be treated as trusted instructions. The agent's CLAUDE.md and system
 *   prompt define the trust boundary, not comment authors.
 *
 * - **Token should have minimal privileges.** The GitHub token only needs
 *   'repo' scope for PR operations (create, read/write comments, merge).
 *   Broader scopes (admin:org, delete_repo, etc.) are flagged by
 *   checkHealth() as warnings.
 *
 * - **Doctor validates deterministically.** All security checks in
 *   checkHealth() are deterministic — no LLM is involved in security
 *   decisions. The checks verify: gh CLI presence, authentication status,
 *   token scope breadth, and remote URL correctness.
 */

import type {
  RepositoryDriver,
  DriverContext,
  MergeOptions,
  MergeResult,
  ChecksResult,
  ChecksStatusResult,
  WaitForChecksOptions,
  PublishResult,
  RemoteComment,
  PRState,
  HealthCheck,
  DriverDetection,
  DriverConfigOptions,
  ImportOptions,
  ImportResult,
} from './driver';
import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';
import { logger } from '../utils/logger';
import { getBranchName, getWorktreePath } from '../cli/helpers';
import { runGit as defaultRunGit, fastForwardLocal as sharedFastForwardLocal, type GitResult } from '../utils/git';

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Overridable subprocess runners for testing. */
export interface DriverDeps {
  runGh: (args: string[], cwd?: string) => GhResult;
  runGit: (args: string[], cwd?: string) => GitResult;
}

function runGh(args: string[], cwd?: string): GhResult {
  const spawnOpts: { cwd?: string; stdout: 'pipe'; stderr: 'pipe' } = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (cwd) spawnOpts.cwd = cwd;

  try {
    const result = Bun.spawnSync(['gh', ...args], spawnOpts);
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  } catch (err: unknown) {
    // gh binary not found
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `gh: command not found (${message})`,
      exitCode: 127,
    };
  }
}

/** Extract PR number from a GitHub PR URL (e.g., https://github.com/owner/repo/pull/123). */
function parsePrNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Detect if the repo has a GitHub remote.
 * Returns DriverDetection if the configured remote points to github.com, null otherwise.
 */
export function detectGitHub(repoDir: string, remoteName: string = 'origin'): DriverDetection | null {
  try {
    const result = Bun.spawnSync(['git', 'remote', 'get-url', remoteName], {
      cwd: repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (result.exitCode === 0) {
      const url = result.stdout.toString().trim();
      if (url.includes('github.com')) {
        return {
          name: 'GitHub',
          tomlOverrides: { 'remote.driver': 'github' },
        };
      }
    }
  } catch {
    // No remote or git error
  }
  return null;
}

export class GitHubDriver implements RepositoryDriver {
  needsSync = true;

  private config: ResolvedConfig;
  private gh: (args: string[], cwd?: string) => GhResult;
  private git: (args: string[], cwd?: string) => GhResult;
  private repoPrivate: boolean | null = null;

  /** The configured git remote name (default: 'origin'). */
  private get remoteName(): string {
    return this.config.remote.git_remote;
  }

  private driverContext?: DriverContext;

  constructor(config: ResolvedConfig, deps?: DriverDeps, context?: DriverContext) {
    this.config = config;
    this.gh = deps?.runGh ?? runGh;
    this.git = deps?.runGit ?? defaultRunGit;
    this.driverContext = context;
  }

  async pushBranch(branch: string): Promise<void> {
    logger.info(`Pushing branch ${branch} to ${this.remoteName}...`);
    const result = this.git(['push', '-u', this.remoteName, branch]);
    if (result.exitCode !== 0) {
      if (result.stderr.includes('Everything up-to-date')) {
        logger.debug('Branch already up-to-date on remote');
        return;
      }
      throw new Error(`Failed to push branch ${branch}: ${result.stderr}`);
    }
    logger.debug(`Pushed branch ${branch} to ${this.remoteName}`);
  }

  async fetchBranch(branch: string, worktreePath: string): Promise<boolean> {
    // Fetch the latest state of the branch from remote (updates <remote>/<branch> ref)
    const fetchResult = this.git(['fetch', this.remoteName, branch], worktreePath);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch branch ${branch} from ${this.remoteName}: ${fetchResult.stderr}`);
    }

    // Check if <remote>/<branch> is ahead of local HEAD
    const remoteRef = `${this.remoteName}/${branch}`;
    const revListResult = this.git(
      ['rev-list', '--count', `HEAD..${remoteRef}`],
      worktreePath,
    );
    if (revListResult.exitCode !== 0) {
      // <remote>/<branch> might not exist as a tracking ref — no remote changes
      logger.debug(`fetchBranch: could not compare with ${remoteRef}: ${revListResult.stderr}`);
      return false;
    }

    const aheadCount = parseInt(revListResult.stdout.trim(), 10);
    if (aheadCount === 0) {
      logger.debug(`fetchBranch: ${remoteRef} has no new commits`);
      return false;
    }

    logger.info(`fetchBranch: ${remoteRef} is ${aheadCount} commit(s) ahead of local`);
    return true;
  }

  async resolveUpstreamRef(parentBranch: string, worktreePath: string): Promise<string> {
    const remoteRef = `${this.remoteName}/${parentBranch}`;
    const fetchResult = this.git(['fetch', this.remoteName, parentBranch], worktreePath);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch ${remoteRef} from ${this.remoteName}: ${fetchResult.stderr}`);
    }
    logger.debug(`resolveUpstreamRef: fetched ${remoteRef}`);
    return remoteRef;
  }

  async publishBranch(opts: {
    branch: string;
    targetBranch: string;
    task: Task;
  }): Promise<PublishResult> {
    const { branch, task } = opts;

    // Push branch only — do NOT create a draft PR.
    // PR creation is deferred until the agent has actual commits (markReadyForReview).
    // This prevents spurious PRs with zero unique commits.
    await this.pushBranch(branch);

    // If a PR already exists (e.g., imported from GitHub), return its metadata
    const existing = this.findExistingPR(branch);
    if (existing) {
      logger.debug(`PR already exists: ${existing.url}`);
      return {
        metadata: {
          github_remote_ref_url: existing.url,
          github_remote_ref_id: String(existing.number),
        },
      };
    }

    // Store the target branch in metadata so markReadyForReview can create the PR later
    return {
      metadata: {
        remote_target_branch: opts.targetBranch,
      },
    };
  }

  async markReadyForReview(task: Task): Promise<{ metadata?: Record<string, string> }> {
    const existingPrNumber = this.prNumber(task);

    if (existingPrNumber) {
      // PR exists — undraft it
      const readyResult = runGh(['pr', 'ready', existingPrNumber]);
      if (readyResult.exitCode !== 0) {
        // Non-fatal: PR may already be non-draft, or repo may not use drafts
        logger.debug(`Failed to mark PR #${existingPrNumber} ready (non-fatal): ${readyResult.stderr}`);
      } else {
        logger.info(`Marked PR #${existingPrNumber} as ready for review`);
      }
      return {};
    }

    // No PR yet — create one (non-draft, since we're marking ready)
    const branchName = getBranchName(task);
    const targetBranch = this.targetBranch(task);

    // Note: Branch is already pushed by exportTasks() before calling markReadyForReview().
    // We do not push again here to avoid duplicate push operations.

    const body = this.buildPRBody(task);

    const createResult = this.gh([
      'pr', 'create',
      '--head', branchName,
      '--base', targetBranch,
      '--title', task.goal,
      '--body', body,
    ]);

    if (createResult.exitCode !== 0) {
      logger.warn(`Failed to create PR (non-fatal): ${createResult.stderr}`);
      return {};
    }

    const prUrl = createResult.stdout.trim();
    const prNumber = this.getPRNumber(branchName, prUrl);

    logger.info(`Created PR: ${prUrl}`);
    return {
      metadata: {
        github_remote_ref_url: prUrl,
        ...(prNumber !== undefined ? { github_remote_ref_id: String(prNumber) } : {}),
      },
    };
  }

  async merge(opts: MergeOptions): Promise<MergeResult> {
    const { sourceBranch, targetBranch, task, root } = opts;

    // Step 0: Check if already merged (idempotent — noop if already done)
    if (this.isBranchMerged(sourceBranch, targetBranch, root)) {
      logger.info('Branch is already merged into target — nothing to do.');
      return { status: 'merged' };
    }

    // Step 1: Push latest commits
    try {
      await this.pushBranch(sourceBranch);
    } catch (err) {
      return {
        status: 'failed',
        error: `Push failed: ${err instanceof Error ? err.message : err}`,
      };
    }

    // Step 2: Ensure we have an open PR to merge
    let prNumber = this.prNumber(task);
    let updatedMetadata: Record<string, string> | undefined;

    const existing = this.findExistingPR(sourceBranch);

    if (existing?.state === 'MERGED') {
      // PR was already merged — check if the branch content is fully in target.
      // GitHub can spuriously merge a PR (e.g., no unique commits) while the branch
      // has since gained new commits. If truly merged, return merged. Otherwise,
      // create a replacement PR for the new commits.
      if (this.isBranchMerged(sourceBranch, targetBranch, root)) {
        logger.info('PR and branch already merged — nothing to do.');
        return { status: 'merged' };
      }
    }

    if (existing?.state !== 'OPEN') {
      // PR is stale (MERGED with new commits, CLOSED) or doesn't exist — create a replacement
      const reason = existing ? `stale (state: ${existing.state})` : 'not found';
      logger.info(`Existing PR is ${reason}, creating replacement PR...`);

      const body = this.buildPRBody(task);
      const createResult = this.gh([
        'pr', 'create',
        '--head', sourceBranch,
        '--base', targetBranch,
        '--title', task.goal,
        '--body', body,
      ]);

      if (createResult.exitCode !== 0) {
        // If PR creation fails, the branch may already be fully merged into
        // the target (e.g., fast-forward or no unique commits). Check via git.
        if (this.isBranchMerged(sourceBranch, targetBranch, root)) {
          logger.info('Branch is already merged into target — nothing to do.');
          return { status: 'merged' };
        }
        return {
          status: 'failed',
          error: `Failed to create replacement PR: ${createResult.stderr}`,
        };
      }

      const prUrl = createResult.stdout.trim();
      const newPrNumber = this.getPRNumber(sourceBranch, prUrl);

      if (newPrNumber !== undefined) {
        prNumber = String(newPrNumber);
      } else {
        prNumber = undefined;
      }

      updatedMetadata = {
        github_remote_ref_url: prUrl,
        ...(prNumber !== undefined ? { github_remote_ref_id: prNumber } : {}),
      };

      logger.info(`Created replacement PR: ${prUrl}`);
    }

    // Step 3: Squash merge via gh pr merge
    // Fetch the PR body and append Lazy co-author trailer
    const mergeTarget = prNumber ?? sourceBranch;
    const { LAZY_COAUTHOR_TRAILER } = await import('../constants');

    // Fetch current PR body to preserve it in the squash commit
    let commitBody = LAZY_COAUTHOR_TRAILER;
    if (prNumber) {
      const viewResult = this.gh(['pr', 'view', prNumber, '--json', 'body'], root);
      if (viewResult.exitCode === 0) {
        try {
          const prData = JSON.parse(viewResult.stdout);
          const originalBody = prData.body || '';
          // Append co-author trailer to the existing PR body
          commitBody = originalBody ? `${originalBody}\n\n${LAZY_COAUTHOR_TRAILER}` : LAZY_COAUTHOR_TRAILER;
        } catch {
          // If parsing fails, fall back to just the trailer
          logger.debug('Failed to parse PR body, using co-author trailer only');
        }
      }
    }

    const mergeResult = this.gh(
      ['pr', 'merge', String(mergeTarget), '--squash', '--body', commitBody],
      root,
    );
    if (mergeResult.exitCode !== 0) {
      // Use structured JSON output from gh CLI to determine failure reason

      // Check PR mergeability for conflicts via gh pr view --json
      const prView = this.gh(['pr', 'view', String(mergeTarget), '--json', 'mergeable']);
      if (prView.exitCode === 0) {
        try {
          const data = JSON.parse(prView.stdout);
          if (data.mergeable === 'CONFLICTING') {
            return {
              status: 'failed',
              isConflict: true,
              error: 'PR has merge conflicts',
              metadata: updatedMetadata,
            };
          }
        } catch { /* fall through to other checks */ }
      }

      // Check for pending CI checks via gh pr checks --json
      if (prNumber) {
        const checks = this.getPRChecks(prNumber);
        const pending = checks.filter(c => c.bucket === 'pending');
        if (pending.length > 0) {
          const names = pending.map(c => c.name).join(', ');
          return {
            status: 'pending',
            reason: `Required checks pending: ${names}`,
            metadata: updatedMetadata,
          };
        }
      }

      // All other failures (branch protection, approval needed, etc.)
      return {
        status: 'failed',
        error: `PR merge failed: ${mergeResult.stderr}`,
        metadata: updatedMetadata,
      };
    }

    return { status: 'merged', metadata: updatedMetadata };
  }

  async getChecksStatus(task: Task): Promise<ChecksStatusResult> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      return { status: 'passed' };
    }

    const checks = this.getPRChecks(prNumber);
    if (checks.length === 0) {
      return { status: 'passed' };
    }

    const pending = checks.filter(c => c.bucket === 'pending');
    const failed = checks.filter(c => c.bucket === 'fail');

    if (failed.length > 0) {
      return {
        status: 'failed',
        failed: failed.map(c => ({ name: c.name, url: c.detailUrl })),
      };
    }

    if (pending.length > 0) {
      return { status: 'pending' };
    }

    return { status: 'passed' };
  }

  async waitForChecks(task: Task, options?: WaitForChecksOptions): Promise<ChecksResult> {
    const timeout = options?.timeout ?? 600_000; // 10 minutes
    const pollInterval = options?.pollInterval ?? 10_000; // 10 seconds

    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug('waitForChecks: no PR number in task metadata, returning passed');
      return { passed: true };
    }

    const startTime = Date.now();

    while (true) {
      const checks = this.getPRChecks(prNumber);

      if (checks.length === 0) {
        // No checks configured — nothing to wait for
        logger.debug('waitForChecks: no checks found, returning passed');
        return { passed: true };
      }

      const pending = checks.filter(c => c.bucket === 'pending');
      const failed = checks.filter(c => c.bucket === 'fail');

      if (pending.length === 0) {
        // All checks completed
        if (failed.length > 0) {
          return {
            passed: false,
            failed: failed.map(c => ({ name: c.name, url: c.detailUrl })),
          };
        }
        return { passed: true };
      }

      // Check timeout before sleeping
      if (Date.now() - startTime >= timeout) {
        return {
          passed: false,
          failed: pending.map(c => ({ name: c.name, url: c.detailUrl })),
          timedOut: true,
        };
      }

      // Show progress
      const pendingNames = pending.map(c => c.name).join(', ');
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`Waiting for ${pending.length} check(s): ${pendingNames} [${elapsed}s elapsed]`);

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Get the current status of all PR checks.
   * Returns an array of check objects with name, state, bucket, and detailUrl.
   */
  private getPRChecks(prNumber: string): Array<{ name: string; state: string; bucket: string; detailUrl?: string }> {
    const result = this.gh([
      'pr', 'checks', prNumber,
      '--json', 'name,state,bucket,detailUrl',
    ]);

    if (result.exitCode !== 0) {
      logger.debug(`getPRChecks: gh pr checks failed for PR #${prNumber}: ${result.stderr}`);
      return [];
    }

    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      logger.debug(`getPRChecks: failed to parse response for PR #${prNumber}`);
      return [];
    }
  }

  async postAcceptReview(task: Task, reason: string): Promise<string | null> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug('postAcceptReview: no PR number in task metadata, skipping');
      return null;
    }

    // Step 1: Try submitting an approving PR review via the GitHub API
    const reviewResult = this.gh([
      'api',
      `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
      '--method', 'POST',
      '--field', `body=${reason}`,
      '--field', 'event=APPROVE',
    ]);

    if (reviewResult.exitCode === 0) {
      logger.debug(`postAcceptReview: posted approving review to PR #${prNumber}`);
      return null;
    }

    // Step 2: APPROVE failed — check if it's a 422 (self-approval not allowed)
    const is422 = reviewResult.stderr.includes('422') ||
                  reviewResult.stderr.includes('Unprocessable Entity');

    if (is422) {
      // Self-approval is expected to fail — log at debug level only
      logger.debug(`postAcceptReview: self-approval not allowed for PR #${prNumber} (expected), falling back to comment`);
    } else {
      // Other errors (auth, network, etc.) should be visible
      logger.warn(`postAcceptReview: approving review failed for PR #${prNumber}: ${reviewResult.stderr}`);
    }

    // Fall back to a regular comment
    const commentBody = `[Lazy Accept] ${reason}`;
    const commentResult = this.gh([
      'pr', 'comment', prNumber, '--body', commentBody,
    ]);

    if (commentResult.exitCode === 0) {
      logger.debug(`postAcceptReview: posted accept comment to PR #${prNumber} (review fallback)`);
      return null;
    }

    // Both review and comment failed — return warning for the caller to display
    const warning = `Could not post accept review to PR #${prNumber}: ${reviewResult.stderr}`;
    logger.warn(`postAcceptReview: comment fallback also failed for PR #${prNumber}: ${commentResult.stderr}`);
    return warning;
  }

  async postRejectReview(task: Task, reason: string): Promise<string | null> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug('postRejectReview: no PR number in task metadata, skipping');
      return null;
    }

    // Step 1: Try submitting a REQUEST_CHANGES PR review via the GitHub API
    const reviewResult = this.gh([
      'api',
      `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
      '--method', 'POST',
      '--field', `body=${reason}`,
      '--field', 'event=REQUEST_CHANGES',
    ]);

    if (reviewResult.exitCode === 0) {
      logger.debug(`postRejectReview: posted requesting-changes review to PR #${prNumber}`);
      return null;
    }

    // Step 2: REQUEST_CHANGES failed — check if it's a 422 (self-review not allowed)
    const is422 = reviewResult.stderr.includes('422') ||
                  reviewResult.stderr.includes('Unprocessable Entity');

    if (is422) {
      // Self-review is expected to fail — log at debug level only
      logger.debug(`postRejectReview: self-review not allowed for PR #${prNumber} (expected), falling back to comment`);
    } else {
      // Other errors (auth, network, etc.) should be visible
      logger.warn(`postRejectReview: requesting-changes review failed for PR #${prNumber}: ${reviewResult.stderr}`);
    }

    // Fall back to a regular comment
    const commentBody = `[Lazy Reject] ${reason}`;
    const commentResult = this.gh([
      'pr', 'comment', prNumber, '--body', commentBody,
    ]);

    if (commentResult.exitCode === 0) {
      logger.debug(`postRejectReview: posted reject comment to PR #${prNumber} (review fallback)`);
      return null;
    }

    // Both review and comment failed — return warning for the caller to display
    const warning = `Could not post reject review to PR #${prNumber}: ${reviewResult.stderr}`;
    logger.warn(`postRejectReview: comment fallback also failed for PR #${prNumber}: ${commentResult.stderr}`);
    return warning;
  }

  async cleanup(branch: string): Promise<void> {
    // Check if a PR exists for this branch and close it
    const existing = this.findExistingPR(branch);
    if (existing && existing.state === 'OPEN') {
      logger.info(`Closing PR #${existing.number} for branch ${branch}...`);
      const closeResult = this.gh(['pr', 'close', String(existing.number)]);
      if (closeResult.exitCode !== 0) {
        logger.warn(`Failed to close PR #${existing.number}: ${closeResult.stderr}`);
      } else {
        logger.debug(`Closed PR #${existing.number}`);
      }
    }
    // Do NOT delete remote branch (user preference — GitHub soft-deletes anyway)
  }

  async syncComments(task: Task, since: string): Promise<RemoteComment[]> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug('syncComments: no PR number in task metadata, skipping');
      return [];
    }

    // Public repos are a prompt injection vector — skip comment sync unless
    // the user has explicitly opted in via the intentionally-ugly config flag.
    if (!this.isRepoPrivate()) {
      if (!this.config.remote.github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
        logger.info('syncComments: skipping comment sync for public repo (prompt injection risk). Set github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection = true in [remote] to enable.');
        return [];
      }
      logger.warn('syncComments: syncing comments from PUBLIC repo — prompt injection risk accepted via config');
    }

    const comments: RemoteComment[] = [];

    // Fetch issue comments (top-level PR comments) with pagination
    try {
      const issueComments = this.fetchPaginatedComments(
        `repos/{owner}/{repo}/issues/${prNumber}/comments`,
        since,
      );
      for (const c of issueComments) {
        const body = (c.body as string) ?? '';
        // Skip comments marked as lazy's own output (they contain the HTML marker)
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments: skipping own comment (id: ${c.id})`);
          continue;
        }
        const user = c.user as Record<string, unknown> | undefined;
        comments.push({
          id: String(c.id),
          body,
          author: (user?.login as string) ?? 'unknown',
          createdAt: (c.created_at as string) ?? '',
        });
      }
    } catch (err) {
      logger.warn(`syncComments: failed to fetch issue comments: ${err instanceof Error ? err.message : err}`);
    }

    // Fetch review comments (inline code comments) with pagination
    try {
      const reviewComments = this.fetchPaginatedComments(
        `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
        since,
      );
      for (const c of reviewComments) {
        const body = (c.body as string) ?? '';
        // Skip comments marked as lazy's own output (they contain the HTML marker)
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments: skipping own comment (id: ${c.id})`);
          continue;
        }
        const user = c.user as Record<string, unknown> | undefined;
        comments.push({
          id: String(c.id),
          body,
          author: (user?.login as string) ?? 'unknown',
          createdAt: (c.created_at as string) ?? '',
          path: c.path as string | undefined,
          line: (c.line as number | undefined) ?? (c.original_line as number | undefined),
        });
      }
    } catch (err) {
      logger.warn(`syncComments: failed to fetch review comments: ${err instanceof Error ? err.message : err}`);
    }

    // Filter out comments posted by lazy itself (identified by hidden markers).
    // This prevents lazy from re-ingesting its own turn summaries, review feedback,
    // and notes as external PR comments.
    const externalComments = comments.filter(c => !c.body.startsWith('<!-- lazy:'));

    // Sort by creation time (oldest first)
    externalComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    logger.debug(`syncComments: fetched ${comments.length} comments since ${since}, ${externalComments.length} external (filtered ${comments.length - externalComments.length} lazy-posted)`);
    return externalComments;
  }

  async getPRState(task: Task): Promise<PRState | null> {
    const prNumber = this.prNumber(task);
    if (!prNumber) return null;

    const result = this.gh(['pr', 'view', prNumber, '--json', 'state']);
    if (result.exitCode !== 0) {
      logger.debug(`getPRState: gh pr view failed for PR #${prNumber}: ${result.stderr}`);
      return null;
    }

    try {
      const data = JSON.parse(result.stdout.trim());
      const state = data.state as string;
      if (state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') {
        return state;
      }
      return null;
    } catch {
      logger.debug(`getPRState: failed to parse response for PR #${prNumber}`);
      return null;
    }
  }

  async postTurnSummary(task: Task, content: string): Promise<void> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug('postTurnSummary: no PR number in task metadata, skipping');
      return;
    }

    // Prepend hidden HTML marker to identify this comment as lazy's own output.
    // The marker is invisible in GitHub's rendered view but detectable by syncComments.
    const markedContent = '<!-- lazy:turn -->\n' + content;

    const result = this.gh(['pr', 'comment', prNumber, '--body', markedContent]);
    if (result.exitCode !== 0) {
      logger.warn(`postTurnSummary: failed to post comment to PR #${prNumber}: ${result.stderr}`);
    } else {
      logger.debug(`postTurnSummary: posted turn summary to PR #${prNumber}`);
    }
  }

  async checkHealth(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // 1. Check gh CLI is installed
    const ghVersion = this.gh(['--version']);
    if (ghVersion.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'gh CLI installed', reason: 'Install from https://cli.github.com/' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'gh CLI installed' });

    // 2. Check gh auth status
    const authStatus = this.gh(['auth', 'status']);
    if (authStatus.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'GitHub authentication', reason: 'Run: gh auth login' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'GitHub authentication' });

    // 3. Check for overly broad token scopes from auth status output
    const authOutput = `${authStatus.stdout}\n${authStatus.stderr}`;
    const dangerousScopes = ['admin:org', 'delete_repo', 'admin:repo_hook', 'admin:enterprise', 'admin:gpg_key', 'admin:ssh_signing_key'];
    const foundScopes = dangerousScopes.filter(scope => authOutput.includes(scope));
    if (foundScopes.length > 0) {
      checks.push({
        state: 'warn',
        what: 'Token scopes',
        reason: `Token has ${foundScopes.map(s => `'${s}'`).join(', ')} — consider reducing to minimal 'repo' scope`,
      });
    } else {
      checks.push({ state: 'ok', what: 'Token scopes' });
    }

    // 4. Check that the configured git remote exists and points to GitHub
    const remoteUrl = this.git(['remote', 'get-url', this.remoteName]);
    if (remoteUrl.exitCode !== 0) {
      checks.push({ state: 'fail', what: `Git remote ${this.remoteName}`, reason: `No remote '${this.remoteName}' configured. Run: git remote add ${this.remoteName} <github-url>` });
      return checks;
    }
    const url = remoteUrl.stdout;
    if (!url.includes('github.com')) {
      checks.push({
        state: 'warn',
        what: `Git remote ${this.remoteName}`,
        reason: `Remote points to ${url}, which does not appear to be GitHub`,
      });
    } else {
      checks.push({ state: 'ok', what: `Git remote ${this.remoteName}` });
    }

    // 5. Check repo visibility and comment sync status
    const repoView = this.gh(['repo', 'view', '--json', 'isPrivate']);
    if (repoView.exitCode === 0) {
      try {
        const data = JSON.parse(repoView.stdout);
        if (data.isPrivate !== true) {
          // Public repo
          if (this.config.remote.github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
            checks.push({
              state: 'warn',
              what: 'Public repo: PR comment sync enabled (prompt injection risk)',
              reason: 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection is enabled — anyone can post comments that get forwarded to the agent',
            });
          } else {
            checks.push({
              state: 'warn',
              what: 'Public repo: PR comment sync disabled',
              reason: 'Comment sync is disabled for public repos to prevent prompt injection. PR review comments will not reach the agent.',
            });
          }
        } else {
          checks.push({ state: 'ok', what: 'Private repo: PR comment sync enabled' });
        }
      } catch {
        // Parse failure — skip this check
      }
    }

    return checks;
  }

  getConfigOptions(): DriverConfigOptions {
    return {
      valid: ['github_auto_push', 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection'],
      deprecated: [
        {
          key: 'token_env',
          alternative: 'Authentication is now handled by gh CLI. Run: gh auth login',
        },
      ],
    };
  }

  // --- Import methods ---

  canImport(url: string): boolean {
    return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
  }

  async importUrl(url: string, _opts: ImportOptions): Promise<ImportResult> {
    // Parse PR number from URL
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse PR number from URL: ${url}`);
    }
    const prNumber = match[1];

    // Fetch PR details via gh CLI
    const prView = this.gh([
      'pr', 'view', prNumber,
      '--json', 'title,headRefName,state,url,number,body',
    ]);
    if (prView.exitCode !== 0) {
      throw new Error(`Failed to fetch PR #${prNumber}: ${prView.stderr}`);
    }

    let prData: Record<string, unknown>;
    try {
      prData = JSON.parse(prView.stdout);
    } catch {
      throw new Error(`Failed to parse PR data for #${prNumber}`);
    }

    const title = (prData.title as string) ?? `PR #${prNumber}`;
    const branch = prData.headRefName as string;
    const state = prData.state as string;
    const prUrl = (prData.url as string) ?? url;
    const prNum = String(prData.number ?? prNumber);

    if (!branch) {
      throw new Error(`PR #${prNumber} has no head branch`);
    }

    // Fetch PR comments for import as notes
    const comments: string[] = [];
    const commentsResult = this.gh([
      'pr', 'view', prNumber,
      '--json', 'comments',
    ]);
    if (commentsResult.exitCode === 0) {
      try {
        const commentsData = JSON.parse(commentsResult.stdout);
        const prComments = commentsData.comments as Array<Record<string, unknown>> | undefined;
        if (prComments) {
          for (const c of prComments) {
            const author = (c.author as Record<string, unknown>)?.login as string ?? 'unknown';
            const body = (c.body as string) ?? '';
            if (body.trim()) {
              comments.push(`[${author}] ${body}`);
            }
          }
        }
      } catch {
        // Non-fatal: continue without comments
        logger.debug(`Failed to parse comments for PR #${prNumber}`);
      }
    }

    return {
      goal: title,
      branch,
      metadata: {
        github_remote_ref_url: prUrl,
        github_remote_ref_id: prNum,
        github_remote_ref_state: state,
        import_source_url: url,
      },
      comments,
    };
  }

  // --- Private helpers ---

  /**
   * Read the PR number from task metadata with backward compatibility.
   * Fallback chain: github_remote_ref_id → remote_ref_id → github_pr_number.
   */
  private prNumber(task: Task): string | undefined {
    return task.metadata?.github_remote_ref_id ?? task.metadata?.remote_ref_id ?? task.metadata?.github_pr_number;
  }

  /**
   * Read the PR URL from task metadata with backward compatibility.
   * Fallback chain: github_remote_ref_url → remote_ref_url → github_pr_url.
   */
  private prUrl(task: Task): string | undefined {
    return task.metadata?.github_remote_ref_url ?? task.metadata?.remote_ref_url ?? task.metadata?.github_pr_url;
  }

  /**
   * Read the target branch from task metadata with backward compatibility.
   * remote_target_branch is driver-agnostic, github_pr_target_branch is legacy.
   */
  private targetBranch(task: Task): string {
    return task.metadata?.remote_target_branch ?? task.metadata?.github_pr_target_branch ?? 'main';
  }

  /**
   * Check if the current repo is private. Caches the result for the driver lifetime.
   * Returns true if private, false if public. Defaults to false (public) on error
   * to err on the side of safety (skipping comment sync).
   */
  private isRepoPrivate(): boolean {
    if (this.repoPrivate !== null) return this.repoPrivate;

    const result = this.gh(['repo', 'view', '--json', 'isPrivate']);
    if (result.exitCode !== 0) {
      logger.warn(`isRepoPrivate: gh repo view failed, assuming public (comment sync will be skipped): ${result.stderr}`);
      this.repoPrivate = false;
      return false;
    }

    try {
      const data = JSON.parse(result.stdout);
      this.repoPrivate = data.isPrivate === true;
    } catch {
      logger.warn('isRepoPrivate: failed to parse response, assuming public (comment sync will be skipped)');
      this.repoPrivate = false;
    }

    return this.repoPrivate;
  }

  private buildPRBody(task: Task): string {
    const sections: string[] = [];

    sections.push(`## Goal\n\n${task.goal}`);

    if (task.prompt) {
      sections.push(`## Prompt\n\n${task.prompt}`);
    }

    sections.push('---\n*Created by [lazy](https://getlazy.dev/)*');

    return sections.join('\n\n');
  }

  /** Check if sourceBranch is already fully merged into targetBranch via git. */
  private isBranchMerged(sourceBranch: string, targetBranch: string, cwd: string): boolean {
    // git merge-base --is-ancestor <branch> <remote>/<target> returns 0 if branch is an ancestor
    const result = this.git(
      ['merge-base', '--is-ancestor', sourceBranch, `${this.remoteName}/${targetBranch}`],
      cwd,
    );
    return result.exitCode === 0;
  }

  private findExistingPR(branch: string): { url: string; number: number; state: string } | null {
    const result = this.gh(['pr', 'view', branch, '--json', 'url,number,state']);
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout);
      return { url: data.url, number: data.number, state: data.state };
    } catch {
      return null;
    }
  }

  /**
   * Fetch all comments from a paginated GitHub API endpoint since a given timestamp.
   * Uses gh api with --paginate to deterministically fetch all pages.
   * Returns raw JSON objects from the API.
   */
  private fetchPaginatedComments(
    endpoint: string,
    since: string,
  ): Array<Record<string, unknown>> {
    // Use since parameter on the API request for issue comments (supported natively).
    // For review comments, the API supports since but only for updated_at, so we
    // fetch all and filter in code for consistency.
    const result = this.gh([
      'api', endpoint,
      '--paginate',
    ]);

    if (result.exitCode !== 0) {
      logger.warn(`fetchPaginatedComments: API call failed: ${result.stderr}`);
      return [];
    }

    if (!result.stdout.trim()) return [];

    try {
      // gh api --paginate concatenates JSON arrays: [...][...][...]
      const raw = result.stdout.trim();
      let allComments: Array<Record<string, unknown>>;

      if (raw.startsWith('[')) {
        const normalized = '[' + raw.replace(/\]\s*\[/g, '],[') + ']';
        const pages: Array<Array<Record<string, unknown>>> = JSON.parse(normalized);
        allComments = pages.flat();
      } else {
        // Single object or NDJSON
        allComments = raw.split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
      }

      // Filter by since timestamp
      return allComments.filter(c => {
        const createdAt = c.created_at as string | undefined;
        return createdAt && createdAt >= since;
      });
    } catch (err) {
      logger.warn(`fetchPaginatedComments: failed to parse response: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private getPRNumber(branch: string, prUrl: string): number | undefined {
    // Try gh pr view first
    const viewResult = this.gh(['pr', 'view', branch, '--json', 'number']);
    if (viewResult.exitCode === 0) {
      try {
        return JSON.parse(viewResult.stdout).number;
      } catch {
        // fall through
      }
    }
    // Fallback: parse from URL
    return parsePrNumberFromUrl(prUrl);
  }

  async getTaskUrl(task: Task): Promise<string | null> {
    // Return the stored PR URL if available
    return this.prUrl(task) ?? null;
  }

  hasRemoteRef(task: Task): boolean {
    return !!this.prNumber(task);
  }

  getRemoteRefUrl(task: Task): string | null {
    return this.prUrl(task) ?? null;
  }

  getRemoteRefState(task: Task): string | null {
    return task.metadata?.github_remote_ref_state ?? task.metadata?.remote_ref_state ?? null;
  }

  validateAccept(task: Task): string | null {
    if (!this.hasRemoteRef(task)) {
      return 'Task has no remote reference (PR). Push and create a PR first with: lazy sync';
    }
    return null;
  }

  async fastForwardLocal(targetBranch: string, root: string): Promise<{ success: boolean; warning?: string }> {
    // Build a skip callback if we have storage access — protects working worktrees
    // from having their branch fast-forwarded mid-agent-turn.
    let shouldSkipWorktree: ((path: string) => boolean) | undefined;
    if (this.driverContext) {
      const { storage, lazyRoot } = this.driverContext;
      const workingTasks = await storage.listTasksWithOptions({ workingOnly: true });
      const workingPaths = new Set(workingTasks.map(t => getWorktreePath(lazyRoot, t)));
      shouldSkipWorktree = (path: string) => workingPaths.has(path);
    }
    return sharedFastForwardLocal(targetBranch, this.remoteName, root, this.git, shouldSkipWorktree);
  }

  async fetchRemoteState(root: string, branchesToUpdate?: string[]): Promise<void> {
    // Fetch latest from remote
    logger.info('Fetching from remote...');
    const fetchResult = this.git(['fetch', this.remoteName], root);
    if (fetchResult.exitCode !== 0) {
      logger.warn(`Fetch failed: ${fetchResult.stderr}`);
    } else {
      logger.debug('Fetched latest from remote');
    }

    // Collect unique branches to fast-forward: always include main, plus any extras
    const branches = new Set(['main', ...(branchesToUpdate ?? [])]);

    for (const branch of branches) {
      this.fastForwardBranch(root, branch);
    }
  }

  /**
   * Fast-forward a local branch to match its origin counterpart.
   * Skips branches that don't exist locally (they don't need updating).
   *
   * Uses `git fetch origin branch:branch` for non-checked-out branches
   * (safe fast-forward of the local ref) and `git merge --ff-only` when
   * the branch is currently checked out.
   */
  private fastForwardBranch(root: string, branch: string): void {
    logger.info(`Updating ${branch} branch...`);
    const checkResult = this.git(['rev-parse', '--verify', branch], root);
    if (checkResult.exitCode !== 0) {
      logger.debug(`${branch} branch not found locally, skipping`);
      return;
    }

    // Check if we're currently on this branch — determines update strategy
    const headResult = this.git(['symbolic-ref', '--short', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${branch}`;

    if (currentBranch === branch) {
      // On the target branch: use merge --ff-only (updates working tree too)
      const ffResult = this.git(['merge', '--ff-only', remoteRef], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
      } else {
        this.logMergeFailure(branch, ffResult.stderr);
      }
    } else {
      // Not on the target branch: use fetch refspec to advance the local ref
      const ffResult = this.git(['fetch', this.remoteName, `${branch}:${branch}`], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
      } else {
        this.logMergeFailure(branch, ffResult.stderr);
      }
    }
  }

  /**
   * Log a fast-forward failure with appropriate severity based on the error.
   */
  private logMergeFailure(branch: string, stderr: string): void {
    if (stderr.includes('fatal: refusing to merge unrelated histories') || stderr.includes('not possible to fast-forward') || stderr.includes('! [rejected]')) {
      logger.warn(`${branch} branch has diverged from ${this.remoteName}/${branch}. Manual merge may be needed.`);
    } else if (stderr.includes('Already up to date') || stderr.includes('up to date')) {
      logger.debug(`${branch} branch already up to date`);
    } else {
      logger.debug(`${branch} merge result: ${stderr}`);
    }
  }

  getLastCommentSyncedAt(task: Task): string | undefined {
    return task.metadata?.github_remote_last_comment_synced_at ?? task.metadata?.remote_last_comment_synced_at ?? task.metadata?.github_last_comment_synced_at;
  }

  commentSyncedAtKey(): string {
    return 'github_remote_last_comment_synced_at';
  }

  getLastPostedTurnSeq(task: Task): number {
    const val = task.metadata?.github_remote_last_posted_turn_seq ?? task.metadata?.remote_last_posted_turn_seq ?? task.metadata?.github_last_posted_turn_seq;
    return val ? Number(val) : -1;
  }

  postedTurnSeqKey(): string {
    return 'github_remote_last_posted_turn_seq';
  }

  getLastPostedNoteAt(task: Task): string | undefined {
    return task.metadata?.github_remote_last_posted_note_at ?? task.metadata?.remote_last_posted_note_at ?? task.metadata?.github_last_posted_note_at;
  }

  postedNoteAtKey(): string {
    return 'github_remote_last_posted_note_at';
  }

  formatImportedComment(comment: RemoteComment, task: Task): string {
    const prNum = this.prNumber(task) ?? '?';
    // Format: [PR #N @author] {remote:id} body
    // The {remote:id} tag enables deduplication on subsequent syncs
    let content = `[PR #${prNum} @${comment.author}] {remote:${comment.id}} ${comment.body}`;
    if (comment.path) {
      content += `\n(on file: ${comment.path}`;
      if (comment.line) content += `, line ${comment.line}`;
      content += ')';
    }
    return content;
  }

  isImportedComment(noteContent: string): boolean {
    // Matches both new {remote:id} and old {gh:id} formats for backward compatibility
    return /^\[PR #\d+ @[^\]]+\] \{(?:remote|gh):\w+\}/.test(noteContent);
  }
}
