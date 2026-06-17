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
  CIJobFailure,
  AcceptGateWarning,
} from './driver';
import { truncateMRTitle } from './driver';
import type { Task } from '../types';
import { targetBranchOf } from '../task-target';
import type { ResolvedConfig } from '../config/types';
import { logger } from '../utils/logger';
import { getBranchName, getWorktreePath } from '../cli/helpers';
import { runGit as defaultRunGit, fastForwardLocal as sharedFastForwardLocal, findWorktreeForBranch, tryFastForwardInWorktree, type GitResult } from '../utils/git';
import { spawnSync } from '../utils/spawn';
import { spawn } from '../utils/spawn';
import { truncateLog } from '../utils/log-truncate';
import { withRemoteRetry, type RetryOptions } from '../utils/retry';
import { applyFidelitySection, composeInitialBody } from '../synthesis/fidelity';

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Overridable subprocess runners for testing. */
export interface DriverDeps {
  runGh: (args: string[], cwd?: string) => Promise<GhResult>;
  runGit: (args: string[], cwd?: string) => Promise<GitResult>;
  /** Override retry options for testing (e.g., { maxAttempts: 1 } to disable retries). */
  retryOptions?: RetryOptions;
}

async function runGh(args: string[], cwd?: string): Promise<GhResult> {
  const spawnOpts: Record<string, unknown> = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (cwd) spawnOpts.cwd = cwd;

  try {
    const proc = spawn(['gh', ...args], spawnOpts) as any;
    const result = await proc.exited;
    return {
      stdout: (await Bun.readableStreamToText(proc.stdout)).trim(),
      stderr: (await Bun.readableStreamToText(proc.stderr)).trim(),
      exitCode: proc.exitCode ?? result,
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
 * Parse a GitHub remote URL and extract the repository identifier (owner/repo).
 * Supports both SSH and HTTPS formats.
 * Returns null if the URL is not a valid GitHub URL.
 *
 * Examples:
 *   git@github.com:getlazy/lazy-dev.git -> getlazy/lazy-dev
 *   https://github.com/getlazy/lazy-dev.git -> getlazy/lazy-dev
 *   https://github.com/getlazy/lazy-dev -> getlazy/lazy-dev
 */
function parseGitHubRepoIdentifier(url: string): string | null {
  // SSH format: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS format: https://github.com/owner/repo or https://user:token@github.com/owner/repo
  const httpsMatch = url.match(/https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

/**
 * Detect if the repo has a GitHub remote.
 * Returns DriverDetection if the configured remote points to github.com, null otherwise.
 */
export function detectGitHub(repoDir: string, remoteName: string = 'origin'): DriverDetection | null {
  try {
    // SYNC CALL: This is called during `lazy init` before any async context exists.
    // It's a one-time detection check, not a runtime operation — blocking is acceptable here.
    const proc = spawnSync(['git', 'remote', 'get-url', remoteName], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
    const exitCode = proc.exitCode ?? 1;
    const url = proc.stdout ? proc.stdout.toString().trim() : '';

    if (exitCode === 0 && url.includes('github.com')) {
      return {
        name: 'GitHub',
        tomlOverrides: { 'remote.driver': 'github' },
      };
    }
  } catch {
    // No remote or git error
  }
  return null;
}

export class GitHubDriver implements RepositoryDriver {
  needsSync = true;

  private config: ResolvedConfig;
  private gh: (args: string[], cwd?: string) => Promise<GhResult>;
  private git: (args: string[], cwd?: string) => Promise<GitResult>;
  private repoPrivate: boolean | null = null;

  /** The configured git remote name (default: 'origin'). */
  private get remoteName(): string {
    return this.config.remote.git_remote;
  }

  private driverContext?: DriverContext;
  private retryOpts?: RetryOptions;

  constructor(config: ResolvedConfig, deps?: DriverDeps, context?: DriverContext) {
    this.config = config;
    this.driverContext = context;

    // Wrap gh to default cwd to the project root so {owner}/{repo} placeholders
    // resolve correctly. Without this, daemon processes resolve against their own
    // cwd (e.g., the lazy source tree) instead of the QA/user project.
    const baseGh = deps?.runGh ?? runGh;
    this.gh = (args: string[], cwd?: string) => baseGh(args, cwd ?? context?.lazyRoot);

    this.git = deps?.runGit ?? defaultRunGit;

    // When deps are injected (test mode), default to no-retry to avoid test
    // timeouts from backoff delays. Tests that want to verify retry behavior
    // can explicitly set retryOptions with appropriate timeouts.
    this.retryOpts = deps?.retryOptions ?? (deps ? { maxAttempts: 1 } : undefined);
  }

  async pushBranch(branch: string): Promise<void> {
    await withRemoteRetry(
      async () => {
        logger.info(`Pushing branch ${branch} to ${this.remoteName}...`);
        // No -u: task branches must not set upstream tracking, or `git pull`
        // in the worktree would silently merge the remote task branch. The
        // doctor command flags any task branch that has tracking configured.
        const result = await this.git(['push', this.remoteName, branch]);
        if (result.exitCode !== 0) {
          if (result.stderr.includes('Everything up-to-date')) {
            logger.debug('Branch already up-to-date on remote');
            return;
          }
          throw new Error(`Failed to push branch ${branch}: ${result.stderr}`);
        }
        logger.debug(`Pushed branch ${branch} to ${this.remoteName}`);
      },
      `push ${branch} to ${this.remoteName}`,
      this.retryOpts,
    );
  }

  async fetchBranch(branch: string, worktreePath: string): Promise<boolean> {
    // Fetch the latest state of the branch from remote (updates <remote>/<branch> ref)
    await withRemoteRetry(
      async () => {
        const fetchResult = await this.git(['fetch', this.remoteName, branch], worktreePath);
        if (fetchResult.exitCode !== 0) {
          throw new Error(`Failed to fetch branch ${branch} from ${this.remoteName}: ${fetchResult.stderr}`);
        }
      },
      `fetch ${branch} from ${this.remoteName}`,
      this.retryOpts,
    );

    // Check if <remote>/<branch> is ahead of local HEAD
    const remoteRef = `${this.remoteName}/${branch}`;
    const revListResult = await this.git(
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
    await withRemoteRetry(
      async () => {
        const fetchResult = await this.git(['fetch', this.remoteName, parentBranch], worktreePath);
        if (fetchResult.exitCode !== 0) {
          throw new Error(`Failed to fetch ${remoteRef} from ${this.remoteName}: ${fetchResult.stderr}`);
        }
      },
      `fetch upstream ref ${parentBranch} from ${this.remoteName}`,
      this.retryOpts,
    );
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
    const existing = await this.findExistingPR(branch);
    if (existing) {
      logger.debug(`PR already exists: ${existing.url}`);
      return {
        metadata: {
          github_remote_ref_url: existing.url,
          github_remote_ref_id: String(existing.number),
        },
      };
    }

    // Nothing to persist: markReadyForReview derives the PR base from the task's
    // canonical target (task.target), not from stored metadata.
    return { metadata: {} };
  }

  async markReadyForReview(task: Task): Promise<{ metadata?: Record<string, string> }> {
    const existingPrNumber = this.prNumber(task);

    if (existingPrNumber) {
      // PR exists — check draft state explicitly before calling `gh pr ready`.
      // Substring-matching stderr for idempotency is fragile ("already" matches
      // unrelated failures). If the PR isn't a draft, nothing to do. If
      // anything fails, propagate — silent fallback is what this fix removes.
      const viewResult = await this.gh(['pr', 'view', existingPrNumber, '--json', 'isDraft']);
      if (viewResult.exitCode !== 0) {
        throw new Error(
          `gh pr view failed (exit ${viewResult.exitCode}) for PR #${existingPrNumber}: ${viewResult.stderr.trim()}`
        );
      }

      let isDraft: boolean;
      try {
        isDraft = JSON.parse(viewResult.stdout).isDraft === true;
      } catch (err) {
        throw new Error(
          `gh pr view returned unparseable JSON for PR #${existingPrNumber}: ${err instanceof Error ? err.message : err}`
        );
      }

      if (!isDraft) {
        logger.debug(`PR #${existingPrNumber} is already non-draft — nothing to do`);
        return {};
      }

      const readyResult = await this.gh(['pr', 'ready', existingPrNumber]);
      if (readyResult.exitCode !== 0) {
        throw new Error(
          `gh pr ready failed (exit ${readyResult.exitCode}) for PR #${existingPrNumber}: ${readyResult.stderr.trim()}`
        );
      }
      logger.info(`Marked PR #${existingPrNumber} as ready for review`);
      return {};
    }

    // No PR yet — create one (non-draft, since we're marking ready)
    const branchName = getBranchName(task);
    const targetBranch = await this.targetBranch(task);

    // Guard against empty targetBranch — the ?? operator doesn't catch empty strings
    if (!targetBranch || targetBranch.trim() === '') {
      throw new Error(`Cannot create PR for branch ${branchName}: target branch is empty. Task target: ${JSON.stringify(task.target)}`);
    }

    logger.debug(`markReadyForReview: branchName=${branchName}, targetBranch=${targetBranch}`);

    // Note: Branch is already pushed by exportTasks() before calling markReadyForReview().
    // We do not push again here to avoid duplicate push operations.

    const body = this.buildPRBody(task);

    // Get the repository identifier to explicitly specify --repo for gh CLI.
    // This ensures the PR is created in the correct repository when multiple
    // GitHub remotes exist (e.g., origin → GitLab, github-obsolete → GitHub).
    const repoIdentifier = await this.getRepoIdentifier();
    if (!repoIdentifier) {
      logger.warn(`Failed to determine GitHub repository from remote ${this.remoteName} — PR creation may fail`);
    }

    const createArgs = [
      'pr', 'create',
      '--head', branchName,
      '--base', targetBranch,
      '--title', truncateMRTitle(task.goal),
      '--body', body,
    ];

    // Add --repo flag if we successfully parsed the repository identifier
    if (repoIdentifier) {
      createArgs.push('--repo', repoIdentifier);
    }

    // Log the exact command for debugging PR creation failures
    logger.debug(`markReadyForReview: executing: gh ${createArgs.join(' ')}`);

    const createResult = await this.gh(createArgs);

    if (createResult.exitCode !== 0) {
      throw new Error(
        `gh pr create failed (exit ${createResult.exitCode}) for branch ${branchName} -> ${targetBranch}: ${createResult.stderr.trim()}`
      );
    }

    const prUrl = createResult.stdout.trim();
    const prNumber = await this.getPRNumber(branchName, prUrl);

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
    if (await this.isBranchMerged(sourceBranch, targetBranch, root)) {
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

    const existing = await this.findExistingPR(sourceBranch);

    if (existing?.state === 'MERGED') {
      // PR was already merged — check if the branch content is fully in target.
      // GitHub can spuriously merge a PR (e.g., no unique commits) while the branch
      // has since gained new commits. If truly merged, return merged. Otherwise,
      // create a replacement PR for the new commits.
      if (await this.isBranchMerged(sourceBranch, targetBranch, root)) {
        logger.info('PR and branch already merged — nothing to do.');
        return { status: 'merged' };
      }
    }

    if (existing?.state !== 'OPEN') {
      // PR is stale (MERGED with new commits, CLOSED) or doesn't exist — create a replacement
      const reason = existing ? `stale (state: ${existing.state})` : 'not found';
      logger.info(`Existing PR is ${reason}, creating replacement PR...`);

      // Guard against empty targetBranch — the ?? operator doesn't catch empty strings
      if (!targetBranch || targetBranch.trim() === '') {
        logger.error(`merge: targetBranch is empty. Task target: ${JSON.stringify(task.target)}`);
        return {
          status: 'failed',
          error: 'Target branch is empty',
        };
      }

      logger.debug(`merge: sourceBranch=${sourceBranch}, targetBranch=${targetBranch}`);

      const body = this.buildPRBody(task);
      const createArgs = [
        'pr', 'create',
        '--head', sourceBranch,
        '--base', targetBranch,
        '--title', truncateMRTitle(task.goal),
        '--body', body,
      ];
      const repoIdentifier = await this.getRepoIdentifier();
      if (repoIdentifier) {
        createArgs.push('--repo', repoIdentifier);
      }

      // Log the exact command for debugging PR creation failures
      logger.debug(`merge: executing: gh ${createArgs.join(' ')}`);

      const createResult = await this.gh(createArgs);

      if (createResult.exitCode !== 0) {
        // If PR creation fails, the branch may already be fully merged into
        // the target (e.g., fast-forward or no unique commits). Check via git.
        if (await this.isBranchMerged(sourceBranch, targetBranch, root)) {
          logger.info('Branch is already merged into target — nothing to do.');
          return { status: 'merged' };
        }
        return {
          status: 'failed',
          error: `Failed to create replacement PR: ${createResult.stderr}`,
        };
      }

      const prUrl = createResult.stdout.trim();
      const newPrNumber = await this.getPRNumber(sourceBranch, prUrl);

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

    // Gate checks (CI, reviews) are handled by checkAcceptGates() before merge() is called.
    // merge() trusts that the caller has already validated gates.
    const mergeTarget = prNumber ?? sourceBranch;

    // Step 3: Squash merge via gh pr merge
    // Fetch the PR body and append Lazy co-author trailer
    const { LAZY_COAUTHOR_TRAILER } = await import('../constants');

    // Fetch current PR body to preserve it in the squash commit
    let commitBody = LAZY_COAUTHOR_TRAILER;
    if (prNumber) {
      const viewResult = await this.gh(['pr', 'view', prNumber, '--json', 'body'], root);
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

    const mergeResult = await this.gh(
      ['pr', 'merge', String(mergeTarget), '--squash', '--body', commitBody],
      root,
    );
    if (mergeResult.exitCode !== 0) {
      // Use structured JSON output from gh CLI to determine failure reason

      // Check PR mergeability for conflicts via gh pr view --json
      const prView = await this.gh(['pr', 'view', String(mergeTarget), '--json', 'mergeable']);
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
        const checks = await this.getPRChecks(prNumber);
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

    const checks = await this.getPRChecks(prNumber);
    if (checks.length === 0) {
      return { status: 'passed' };
    }

    const pending = checks.filter(c => c.bucket === 'pending');
    const failed = checks.filter(c => c.bucket === 'fail');

    if (failed.length > 0) {
      return {
        status: 'failed',
        failed: failed.map(c => ({ name: c.name, url: c.link })),
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
      const checks = await this.getPRChecks(prNumber);

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
            failed: failed.map(c => ({ name: c.name, url: c.link })),
          };
        }
        return { passed: true };
      }

      // Check timeout before sleeping
      if (Date.now() - startTime >= timeout) {
        return {
          passed: false,
          failed: pending.map(c => ({ name: c.name, url: c.link })),
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
   * Returns an array of check objects with name, state, bucket, and link.
   */
  private async getPRChecks(prNumber: string): Promise<Array<{ name: string; state: string; bucket: string; link?: string }>> {
    const result = await this.gh([
      'pr', 'checks', prNumber,
      '--json', 'name,state,bucket,link',
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

  async getFailedCIJobs(task: Task, branchName?: string): Promise<CIJobFailure[]> {
    // Try branch-based lookup first (works without a PR)
    if (branchName) {
      const branchFailed = await this.getBranchFailedChecks(branchName);
      if (branchFailed.length > 0) return this.fetchCheckLogs(branchFailed);
    }

    // Fall back to PR-based lookup
    const prNumber = this.prNumber(task);

    // If there's a PR, use PR-based check status (most precise).
    // Otherwise, fall back to branch-based workflow run detection so
    // CI failures are caught even before a PR exists (auto-push flow).
    const failed = prNumber
      ? (await this.getPRChecks(prNumber)).filter(c => c.bucket === 'fail')
      : await this.getBranchFailedChecks(getBranchName(task));

    if (failed.length === 0) return [];

    return this.fetchCheckLogs(failed);
  }

  /**
   * Fetch logs for a list of failed checks. Each check needs a name and optional link.
   * Returns CIJobFailure objects with truncated log output where available.
   */
  private async fetchCheckLogs(checks: Array<{ name: string; link?: string }>): Promise<CIJobFailure[]> {
    const results: CIJobFailure[] = [];

    for (const check of checks) {
      const failure: CIJobFailure = {
        name: check.name,
        url: check.link,
      };

      // Try to fetch logs for GitHub Actions jobs.
      // link format: https://github.com/{owner}/{repo}/actions/runs/{run_id}/job/{job_id}
      if (check.link) {
        const jobMatch = check.link.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
        if (jobMatch) {
          const jobId = jobMatch[1];
          try {
            const logResult = await this.gh([
              'api',
              `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`,
            ]);
            if (logResult.exitCode === 0 && logResult.stdout) {
              failure.log = truncateLog(logResult.stdout, 200);
            }
          } catch {
            logger.debug(`getFailedCIJobs: failed to fetch logs for job ${jobId}`);
          }
        }
      }

      results.push(failure);
    }

    return results;
  }

  /**
   * Get failed CI checks for a branch directly (without a PR).
   * Uses `gh run list --branch <branch>` to find the latest workflow run,
   * then checks for failed jobs. This enables CI auto-react before a PR exists.
   */
  private async getBranchFailedChecks(branch: string): Promise<Array<{ name: string; bucket: string; link?: string }>> {
    // Get the most recent workflow run for the branch.
    // Must pass --repo explicitly because the git remote URL may have embedded
    // credentials (x-access-token:TOKEN@github.com) which gh doesn't recognize.
    const repoId = await this.getRepoIdentifier();
    const args = [
      'run', 'list',
      '--branch', branch,
      '--limit', '1',
      '--json', 'databaseId,status,conclusion',
    ];
    if (repoId) args.push('--repo', repoId);
    const result = await this.gh(args);

    if (result.exitCode !== 0) {
      logger.debug(`getBranchFailedChecks: gh run list failed for branch ${branch}: ${result.stderr}`);
      return [];
    }

    let runs: Array<{ databaseId: number; status: string; conclusion: string }>;
    try {
      runs = JSON.parse(result.stdout.trim());
    } catch {
      logger.debug(`getBranchFailedChecks: failed to parse run list for branch ${branch}`);
      return [];
    }

    if (runs.length === 0) return [];
    const run = runs[0];

    // Only inspect completed runs with failure conclusion
    if (run.status !== 'completed' || run.conclusion !== 'failure') return [];

    // Fetch failed jobs from this run
    const jobsArgs = ['run', 'view', String(run.databaseId), '--json', 'jobs'];
    if (repoId) jobsArgs.push('--repo', repoId);
    const jobsResult = await this.gh(jobsArgs);

    if (jobsResult.exitCode !== 0) {
      logger.debug(`getBranchFailedChecks: gh run view failed for run ${run.databaseId}: ${jobsResult.stderr}`);
      return [];
    }

    try {
      const data = JSON.parse(jobsResult.stdout.trim());
      const jobs: Array<{ name: string; conclusion: string; url?: string }> = data.jobs ?? [];
      return jobs
        .filter(j => j.conclusion === 'failure')
        .map(j => ({ name: j.name, bucket: 'fail', link: j.url }));
    } catch {
      logger.debug(`getBranchFailedChecks: failed to parse jobs for run ${run.databaseId}`);
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
    const reviewResult = await this.gh([
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
    const commentResult = await this.gh([
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
    const reviewResult = await this.gh([
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
    const commentResult = await this.gh([
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
    const existing = await this.findExistingPR(branch);
    if (existing && existing.state === 'OPEN') {
      logger.info(`Closing PR #${existing.number} for branch ${branch}...`);
      const closeResult = await this.gh(['pr', 'close', String(existing.number)]);
      if (closeResult.exitCode !== 0) {
        logger.warn(`Failed to close PR #${existing.number}: ${closeResult.stderr}`);
      } else {
        logger.debug(`Closed PR #${existing.number}`);
      }
    }
    // Do NOT delete remote branch (user preference — GitHub soft-deletes anyway)
  }

  async syncComments(task: Task, since: string): Promise<RemoteComment[]> {
    const taskLabel = task.code ?? task.id.substring(0, 8);
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      logger.debug(`syncComments [${taskLabel}]: no PR number in task metadata, skipping`);
      return [];
    }

    // Public repos are a prompt injection vector — skip comment sync unless
    // the user has explicitly opted in via the intentionally-ugly config flag.
    if (!(await this.isRepoPrivate())) {
      if (!this.config.remote.github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
        logger.info(`syncComments [${taskLabel}]: skipping comment sync for public repo (prompt injection risk). Set github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection = true in [remote] to enable.`);
        return [];
      }
      logger.warn(`syncComments [${taskLabel}]: syncing comments from PUBLIC repo — prompt injection risk accepted via config`);
    }

    const comments: RemoteComment[] = [];

    // Fetch issue comments (top-level PR comments) with pagination
    try {
      const issueComments = await this.fetchPaginatedComments(
        `repos/{owner}/{repo}/issues/${prNumber}/comments`,
        since,
      );
      for (const c of issueComments) {
        const body = (c.body as string) ?? '';
        // Skip comments marked as lazy's own output (they contain the HTML marker)
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments [${taskLabel}]: skipping own comment (id: ${c.id})`);
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
      logger.warn(`syncComments [${taskLabel}]: failed to fetch issue comments: ${err instanceof Error ? err.message : err}`);
    }

    // Fetch review comments (inline code comments) with pagination
    try {
      const reviewComments = await this.fetchPaginatedComments(
        `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
        since,
      );
      for (const c of reviewComments) {
        const body = (c.body as string) ?? '';
        // Skip comments marked as lazy's own output (they contain the HTML marker)
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments [${taskLabel}]: skipping own comment (id: ${c.id})`);
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
      logger.warn(`syncComments [${taskLabel}]: failed to fetch review comments: ${err instanceof Error ? err.message : err}`);
    }

    // Filter out comments posted by lazy itself (identified by hidden markers).
    // This prevents lazy from re-ingesting its own turn summaries, review feedback,
    // and notes as external PR comments.
    const externalComments = comments.filter(c => !c.body.startsWith('<!-- lazy:'));

    // Sort by creation time (oldest first)
    externalComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    logger.debug(`syncComments [${taskLabel}]: fetched ${comments.length} comments since ${since}, ${externalComments.length} external (filtered ${comments.length - externalComments.length} lazy-posted)`);
    return externalComments;
  }

  async getPRState(task: Task): Promise<PRState | null> {
    const prNumber = this.prNumber(task);
    if (!prNumber) return null;

    const result = await this.gh(['pr', 'view', prNumber, '--json', 'state']);
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

    const result = await this.gh(['pr', 'comment', prNumber, '--body', markedContent]);
    if (result.exitCode !== 0) {
      logger.warn(`postTurnSummary: failed to post comment to PR #${prNumber}: ${result.stderr}`);
    } else {
      logger.debug(`postTurnSummary: posted turn summary to PR #${prNumber}`);
    }
  }

  async checkHealth(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // 1. Check gh CLI is installed
    const ghVersion = await this.gh(['--version']);
    if (ghVersion.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'gh CLI installed', reason: 'Install from https://cli.github.com/' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'gh CLI installed' });

    // 2. Check gh auth status
    const authStatus = await this.gh(['auth', 'status']);
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
    const remoteUrl = await this.git(['remote', 'get-url', this.remoteName]);
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
    const repoView = await this.gh(['repo', 'view', '--json', 'isPrivate']);
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
      valid: ['auto_approve', 'github_auto_push', 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection'],
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
    const prView = await this.gh([
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
    const commentsResult = await this.gh([
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

  async recoverRemoteRef(task: Task): Promise<Record<string, string> | null> {
    const branchName = getBranchName(task);
    // Note: findExistingPR skips CLOSED/MERGED PRs for safety in the publish flow,
    // but for recovery we need to find ANY PR including merged ones.
    const args = ['pr', 'view', branchName, '--json', 'url,number,state'];
    const repoIdentifier = await this.getRepoIdentifier();
    if (repoIdentifier) {
      args.push('--repo', repoIdentifier);
    }
    const result = await this.gh(args);
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout);
      return {
        github_remote_ref_url: data.url,
        github_remote_ref_id: String(data.number),
      };
    } catch {
      return null;
    }
  }

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
   * The base branch for a NEW PR, derived from the task's canonical integration
   * target ({@link TaskTarget}) — never from stored metadata.
   *
   * This is used only when *creating* a PR (markReadyForReview). A PR's base is
   * a creation-time fact owned by GitHub thereafter: once the PR exists,
   * markReadyForReview early-returns and never re-targets it, and an existing
   * PR's base is read back from the forge rather than from lazy. So a later
   * `lazy reparent` does not silently rewrite an open PR's base — it only
   * affects the base of a PR not yet created.
   *
   * PRs are only opened for top-level tasks, whose target is a named branch.
   * The legacy `github_pr_target_branch` / `remote_target_branch` metadata keys
   * are no longer consulted (task.target is the single source of truth); they
   * survive on disk only as a one-time read for the storage-layer migration.
   */
  private async targetBranch(task: Task): Promise<string> {
    // INVARIANT: PRs only for protected branches; subtask→parent merges are
    // local. A task stacked on another task (target.kind === 'task') or carrying
    // a legacy 'lazy/...' sentinel must NEVER have its PR silently retargeted to
    // the repo default — that is exactly the "PR against main for a child task"
    // bug. A PR is only ever created for a protected named-branch target, so
    // reaching here for a lazy-parented task is a merge-routing bug; fail loudly.
    if (task.target.kind === 'task') {
      throw new Error(
        `Refusing to create a PR for task ${task.id}: it is stacked on another task ` +
        `(parent ${task.target.parentTaskId}). Subtask→parent merges must be local git ` +
        `operations, not remote PRs — this is a merge-routing bug.`,
      );
    }
    const branch = targetBranchOf(task);
    if (branch?.startsWith('lazy/')) {
      throw new Error(
        `Refusing to create a PR for task ${task.id}: integration target ('${branch}') is a lazy task branch, ` +
        `not a real integration branch. A lazy task-branch parent means the merge must be a local git operation, ` +
        `not a remote PR — this is a merge-routing bug.`,
      );
    }

    // No usable named branch: the task is a detached-HEAD root task (literal
    // "HEAD") or the target is unresolved ('' / undefined). Both legitimately
    // integrate into the repo default branch. (markReadyForReview also guards
    // empties.)
    if (!branch || branch === 'HEAD') {
      logger.warn(`targetBranch: task ${task.id} target ('${branch ?? ''}') resolves to the repo default branch`);
      return (await this.resolveDefaultBranch()) ?? 'main';
    }
    return branch;
  }

  /**
   * Resolve the remote's default branch name via git symbolic-ref.
   * Returns null if resolution fails.
   */
  private async resolveDefaultBranch(): Promise<string | null> {
    const result = await this.git(['symbolic-ref', `refs/remotes/${this.remoteName}/HEAD`]);
    if (result.exitCode === 0) {
      const ref = result.stdout.trim();
      const prefix = `refs/remotes/${this.remoteName}/`;
      if (ref.startsWith(prefix)) {
        return ref.slice(prefix.length);
      }
    }
    return null;
  }

  /**
   * Get the GitHub repository identifier (owner/repo) from the configured git remote.
   * Returns null if the remote doesn't exist or isn't a valid GitHub URL.
   * This is used to explicitly specify --repo for gh CLI commands to avoid ambiguity
   * when multiple GitHub remotes exist.
   */
  private async getRepoIdentifier(): Promise<string | null> {
    const remoteUrl = await this.git(['remote', 'get-url', this.remoteName]);
    if (remoteUrl.exitCode !== 0) {
      logger.debug(`getRepoIdentifier: failed to get URL for remote ${this.remoteName}: ${remoteUrl.stderr}`);
      return null;
    }
    return parseGitHubRepoIdentifier(remoteUrl.stdout);
  }

  /**
   * Check if the current repo is private. Caches the result for the driver lifetime.
   * Returns true if private, false if public. Defaults to false (public) on error
   * to err on the side of safety (skipping comment sync).
   */
  private async isRepoPrivate(): Promise<boolean> {
    if (this.repoPrivate !== null) return this.repoPrivate;

    const result = await this.gh(['repo', 'view', '--json', 'isPrivate']);
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
    return composeInitialBody({
      goal: task.goal,
      prompt: task.prompt ?? undefined,
      footer: '---\n*Created by [lazy](https://getlazy.dev/)*',
    });
  }

  async updateRemoteBody(task: Task, summary: string): Promise<void> {
    const prNumber = this.prNumber(task);
    if (!prNumber) {
      // No PR yet — nothing to update. The lazy-owned section is seeded into
      // the body at PR-creation time (buildPRBody), so a later regeneration
      // will land in place once the PR exists.
      logger.debug('updateRemoteBody: task has no PR — skipping');
      return;
    }

    await withRemoteRetry(
      async () => {
        // Read the live body so human edits outside the lazy section survive.
        const viewResult = await this.gh(['pr', 'view', prNumber, '--json', 'body']);
        if (viewResult.exitCode !== 0) {
          throw new Error(`gh pr view failed (exit ${viewResult.exitCode}) for PR #${prNumber}: ${viewResult.stderr.trim()}`);
        }
        let currentBody = '';
        try {
          currentBody = JSON.parse(viewResult.stdout).body ?? '';
        } catch (err) {
          throw new Error(`gh pr view returned unparseable JSON for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
        }

        const newBody = applyFidelitySection(currentBody, summary);
        if (newBody === currentBody) {
          logger.debug(`updateRemoteBody: PR #${prNumber} body unchanged — skipping edit`);
          return;
        }

        const editResult = await this.gh(['pr', 'edit', prNumber, '--body', newBody]);
        if (editResult.exitCode !== 0) {
          throw new Error(`gh pr edit failed (exit ${editResult.exitCode}) for PR #${prNumber}: ${editResult.stderr.trim()}`);
        }
        logger.debug(`updateRemoteBody: updated lazy section of PR #${prNumber}`);
      },
      `update body of PR #${prNumber}`,
      this.retryOpts,
    );
  }

  /** Check if sourceBranch is already fully merged into targetBranch via git. */
  private async isBranchMerged(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
    // git merge-base --is-ancestor <branch> <remote>/<target> returns 0 if branch is an ancestor
    const result = await this.git(
      ['merge-base', '--is-ancestor', sourceBranch, `${this.remoteName}/${targetBranch}`],
      cwd,
    );
    return result.exitCode === 0;
  }

  private async findExistingPR(branch: string): Promise<{ url: string; number: number; state: string } | null> {
    const args = ['pr', 'view', branch, '--json', 'url,number,state'];
    const repoIdentifier = await this.getRepoIdentifier();
    if (repoIdentifier) {
      args.push('--repo', repoIdentifier);
    }
    const result = await this.gh(args);
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout);
      // Skip closed/merged PRs — linking to a stale PR causes the daemon's
      // external change detection to auto-close the task.
      if (data.state === 'CLOSED' || data.state === 'MERGED') {
        logger.debug(`findExistingPR: skipping ${data.state} PR #${data.number} for branch ${branch}`);
        return null;
      }
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
  private async fetchPaginatedComments(
    endpoint: string,
    since: string,
  ): Promise<Array<Record<string, unknown>>> {
    // Use since parameter on the API request for issue comments (supported natively).
    // For review comments, the API supports since but only for updated_at, so we
    // fetch all and filter in code for consistency.
    const result = await this.gh([
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

  private async getPRNumber(branch: string, prUrl: string): Promise<number | undefined> {
    // Try gh pr view first
    const args = ['pr', 'view', branch, '--json', 'number'];
    const repoIdentifier = await this.getRepoIdentifier();
    if (repoIdentifier) {
      args.push('--repo', repoIdentifier);
    }
    const viewResult = await this.gh(args);
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
      return 'Task has no remote reference (PR). Push and create a PR first with: lazy submit';
    }
    return null;
  }

  async isTargetBranchProtected(targetBranch: string): Promise<boolean> {
    const repoIdentifier = await this.getRepoIdentifier();
    if (!repoIdentifier) return false;

    const result = await this.gh([
      'api',
      `repos/${repoIdentifier}/branches/${encodeURIComponent(targetBranch)}/protection`,
      '--silent',
    ]);

    // 200 = protected, 404 = not protected
    return result.exitCode === 0;
  }

  async hasExternalApproval(task: Task): Promise<boolean> {
    const prNumber = this.prNumber(task);
    if (!prNumber) return false;

    // Get the authenticated user so we can exclude their approvals.
    // If auto_approve previously submitted an approval (and accept failed later),
    // that approval must not trick the non-auto-approve path into thinking
    // a human reviewed it.
    const userResult = await this.gh(['api', 'user', '--jq', '.login']);
    const currentUser = userResult.exitCode === 0 ? userResult.stdout.trim() : '';

    const jqFilter = currentUser
      ? `[.[] | select(.state == "APPROVED" and .user.login != "${currentUser}")] | length`
      : '[.[] | select(.state == "APPROVED")] | length';

    const result = await this.gh([
      'api',
      `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
      '--jq', jqFilter,
    ]);

    if (result.exitCode !== 0) return false;

    const approvalCount = parseInt(result.stdout.trim(), 10);
    return !isNaN(approvalCount) && approvalCount > 0;
  }

  async checkAcceptGates(task: Task): Promise<AcceptGateWarning[]> {
    const warnings: AcceptGateWarning[] = [];
    const prNumber = this.prNumber(task);
    if (!prNumber) return warnings;

    // Gate 1: CI checks
    const checks = await this.getPRChecks(prNumber);
    const failed = checks.filter(c => c.bucket === 'fail');
    const pending = checks.filter(c => c.bucket === 'pending');

    if (failed.length > 0) {
      const names = failed.map(c => c.name).join(', ');
      warnings.push({ gate: 'ci', message: `CI checks failing: ${names}` });
    } else if (pending.length > 0) {
      const names = pending.map(c => c.name).join(', ');
      warnings.push({ gate: 'ci', message: `CI checks still running: ${names}` });
    }

    // Gate 2 & 3: Review status and unresolved threads (single call for consistency)
    const reviewResult = await this.gh(['pr', 'view', prNumber, '--json', 'reviewDecision,reviewThreads']);
    if (reviewResult.exitCode === 0) {
      try {
        const data = JSON.parse(reviewResult.stdout);

        // Review decision
        const decision = data.reviewDecision;
        if (decision && decision !== 'APPROVED') {
          const label = decision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review required';
          warnings.push({ gate: 'reviews', message: `${label} (status: ${decision})` });
        }

        // Unresolved review threads
        const threads = data.reviewThreads ?? [];
        const unresolved = threads.filter((t: { isResolved: boolean }) => !t.isResolved);
        if (unresolved.length > 0) {
          const plural = unresolved.length === 1 ? 'thread' : 'threads';
          warnings.push({ gate: 'comments', message: `${unresolved.length} unresolved review ${plural}` });
        }
      } catch {
        logger.warn(`checkAcceptGates: failed to parse review response: ${reviewResult.stdout.substring(0, 200)}`);
      }
    }

    return warnings;
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

    // Detect whether targetBranch is currently checked out in the root repo.
    // `git fetch <remote> main:main` fails with "refusing to fetch into branch
    // checked out at ..." when main is the current branch. The accept command
    // typically runs from the user's main repo which is on main.
    const headResult = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${targetBranch}`;

    if (currentBranch === targetBranch) {
      // Target branch IS checked out — fetch then ff-only merge.
      const fetchResult = await this.git(['fetch', this.remoteName, targetBranch], root);
      if (fetchResult.exitCode !== 0) {
        const warning = `Failed to fetch ${targetBranch} from ${this.remoteName}: ${fetchResult.stderr.trim() || 'unknown error'}. Run \`git fetch ${this.remoteName}\` to retry.`;
        logger.warn(`fastForwardLocal: fetch failed: ${fetchResult.stderr}`);
        return { success: false, warning };
      }

      const mergeResult = await this.git(['merge', '--ff-only', remoteRef], root);
      if (mergeResult.exitCode === 0) {
        logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
        return { success: true };
      }

      // ff-only failed — could be divergence, dirty working tree, lock file, etc.
      const stderr = mergeResult.stderr;
      if (stderr.includes('Already up to date') || mergeResult.stdout.includes('Already up to date')) {
        logger.debug(`fastForwardLocal: ${targetBranch} already up to date`);
        return { success: true };
      }

      // Disambiguate: is this true divergence or a transient failure?
      // Use merge-base --is-ancestor to check if local is an ancestor of remote.
      const localSha = await this.git(['rev-parse', targetBranch], root);
      const remoteSha = await this.git(['rev-parse', remoteRef], root);
      if (localSha.exitCode === 0 && remoteSha.exitCode === 0) {
        const ancestorCheck = await this.git(['merge-base', '--is-ancestor', localSha.stdout.trim(), remoteSha.stdout.trim()], root);
        if (ancestorCheck.exitCode === 0) {
          // Local IS an ancestor of remote — not diverged. The ff-only failed
          // for a transient reason (dirty working tree, lock file, etc.).
          const mergeStderr = stderr.trim();
          const warning = `Fast-forward of ${targetBranch} failed: ${mergeStderr || 'unknown error'}. Run \`git merge --ff-only ${remoteRef}\` to retry.`;
          logger.warn(`fastForwardLocal: ff-only failed (not diverged): ${mergeStderr}`);
          return { success: false, warning };
        }
      }

      // True divergence: local has commits not in remote.
      const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
      logger.warn(`fastForwardLocal: ${warning}`);
      return { success: false, warning };
    }
    return sharedFastForwardLocal(targetBranch, this.remoteName, root, this.git, shouldSkipWorktree);
  }

  async fetchRemoteState(root: string, branchesToUpdate?: string[]): Promise<void> {
    // Fetch latest from remote
    logger.info('Fetching from remote...');
    const fetchResult = await this.git(['fetch', this.remoteName], root);
    if (fetchResult.exitCode !== 0) {
      logger.warn(`Fetch failed: ${fetchResult.stderr}`);
    } else {
      logger.debug('Fetched latest from remote');
    }

    // Collect unique branches to fast-forward: always include main, plus any extras
    const branches = new Set(['main', ...(branchesToUpdate ?? [])]);

    for (const branch of branches) {
      await this.fastForwardBranch(root, branch);
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
  private async fastForwardBranch(root: string, branch: string): Promise<void> {
    // Skip git special refs that aren't real branches — "HEAD" always passes
    // rev-parse --verify, and `git fetch origin HEAD:HEAD` creates a phantom local branch.
    if (branch === 'HEAD') {
      logger.debug(`Skipping special ref "${branch}"`);
      return;
    }

    logger.info(`Updating ${branch} branch...`);
    const checkResult = await this.git(['rev-parse', '--verify', branch], root);
    if (checkResult.exitCode !== 0) {
      logger.debug(`${branch} branch not found locally, skipping`);
      return;
    }

    // Check if we're currently on this branch — determines update strategy
    const headResult = await this.git(['symbolic-ref', '--short', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${branch}`;

    if (currentBranch === branch) {
      // On the target branch: use merge --ff-only (updates working tree too)
      const ffResult = await this.git(['merge', '--ff-only', remoteRef], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
      } else {
        this.logMergeFailure(branch, ffResult.stderr);
      }
    } else {
      // Not on the target branch: use fetch refspec to advance the local ref
      const ffResult = await this.git(['fetch', this.remoteName, `${branch}:${branch}`], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
      } else if (ffResult.stderr.includes('checked out at') || ffResult.stderr.includes('refusing to fetch')) {
        // Branch is checked out in a worktree — fetch + ff-only merge there
        const worktreePath = await findWorktreeForBranch(branch, root, this.git);
        if (worktreePath) {
          const result = await tryFastForwardInWorktree(branch, worktreePath, remoteRef, this.remoteName, root, this.git);
          if (!result.success) {
            logger.warn(`fastForwardBranch: ${result.warning}`);
          }
        } else {
          this.logMergeFailure(branch, ffResult.stderr);
        }
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

  getLastCIFailureSynced(task: Task): string | undefined {
    return task.metadata?.github_ci_failure_synced;
  }

  ciFailureSyncedKey(): string {
    return 'github_ci_failure_synced';
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
