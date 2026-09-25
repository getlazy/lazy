/**
 * GitLabDriver — RepositoryDriver for GitLab MR-based workflows.
 *
 * Lifecycle:
 *   start  → publishBranch(): push + (defer MR creation to markReadyForReview)
 *   turns  → pushBranch(): push latest commits (auto_push)
 *   blocked → markReadyForReview(): create MR after first agent turn
 *   accept → accept(): push + squash merge via glab CLI
 *   close/reject → cleanup(): close the MR
 *
 * Uses the `glab` CLI for all GitLab interactions. Authentication is
 * handled entirely by `glab auth login` — no env var needed.
 *
 * ## Security model
 *
 * - **External comments are untrusted input.** MR notes (from syncComments)
 *   are authored by external users and injected into agent prompts. They must
 *   never be treated as trusted instructions. The agent's CLAUDE.md and system
 *   prompt define the trust boundary, not comment authors.
 *
 * - **Token should have minimal privileges.** The GitLab token only needs
 *   'api' scope for MR operations (create, read/write comments, merge).
 *   Broader scopes are flagged by checkHealth() as warnings.
 *
 * - **Doctor validates deterministically.** All security checks in
 *   checkHealth() are deterministic — no LLM is involved in security
 *   decisions. The checks verify: glab CLI presence, authentication status,
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
  MarkReadyOptions,
  OpenReview,
} from './driver';
import { truncateMRTitle } from './driver';
import type { Task } from '../types';
import { targetBranchOf } from '../task-target';
import type { ResolvedConfig } from '../config/types';
import { logger } from '../utils/logger';
import { reportFetchFailure, clearFetchFailure } from './fetch-failure';
import { getBranchName, getWorktreePath } from '../task/identity';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import { runGit as defaultRunGit, fastForwardLocal as sharedFastForwardLocal, findWorktreeForBranch, tryFastForwardInWorktree, type GitResult } from '../utils/git';
import { spawn, spawnSyncUnsupervised } from '../utils/spawn';
import { truncateLog } from '../utils/log-truncate';
import { withRemoteRetry, type RetryOptions } from '../utils/retry';
import { applyFidelitySection, composeInitialBody } from '../synthesis/fidelity';
import { remoteUrlHasHost, remoteUrlHostContains } from './remote-url';
import { parsePaginatedApiJson } from './paginated-json';

export interface GlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Overridable subprocess runners for testing. */
export interface GitLabDriverDeps {
  runGl: (args: string[], cwd?: string) => Promise<GlResult>;
  runGit: (args: string[], cwd?: string) => Promise<GitResult>;
  /** Override retry options for testing (e.g., { maxAttempts: 1 } to disable retries). */
  retryOptions?: RetryOptions;
}

async function runGl(args: string[], cwd?: string): Promise<GlResult> {
  const spawnOpts: Record<string, unknown> = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (cwd) spawnOpts.cwd = cwd;

  try {
    const proc = spawn(['glab', ...args], spawnOpts) as any;
    const result = await proc.exited;
    return {
      stdout: (await Bun.readableStreamToText(proc.stdout)).trim(),
      stderr: (await Bun.readableStreamToText(proc.stderr)).trim(),
      exitCode: proc.exitCode ?? result,
    };
  } catch (err: unknown) {
    // glab binary not found
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `glab: command not found (${message})`,
      exitCode: 127,
    };
  }
}

/** Extract MR number (IID) from a GitLab MR URL (e.g., https://gitlab.com/owner/repo/-/merge_requests/123). */
function parseMrNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/merge_requests\/(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Detect if the repo has a GitLab remote.
 * Returns DriverDetection if the configured remote points to gitlab.com, null otherwise.
 */
export function detectGitLab(repoDir: string, remoteName: string = 'origin'): DriverDetection | null {
  try {
    // SYNC CALL: This is called during `lazy init` before any async context exists.
    // It's a one-time detection check, not a runtime operation — blocking is acceptable here.
    // Bounded at 10s: git can hang on a locked config or a slow filesystem, and
    // the default backstop is far longer than a `remote get-url` should take.
    const proc = spawnSyncUnsupervised(['git', 'remote', 'get-url', remoteName], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const exitCode = proc.exitCode ?? 1;
    const url = proc.stdout ? proc.stdout.toString().trim() : '';

    // Host comparison, not a substring test: `https://evil.com/gitlab.com/x.git`
    // is not a GitLab remote. Handles scp syntax (git@gitlab.com:o/r.git) too.
    if (exitCode === 0 && remoteUrlHasHost(url, 'gitlab.com')) {
      return {
        name: 'GitLab',
        tomlOverrides: { 'remote.driver': 'gitlab' },
      };
    }
  } catch {
    // No remote or git error
  }
  return null;
}

export class GitLabDriver implements RepositoryDriver {
  needsSync = true;

  private config: ResolvedConfig;
  private gl: (args: string[], cwd?: string) => Promise<GlResult>;
  private git: (args: string[], cwd?: string) => Promise<GitResult>;
  private repoPrivate: boolean | null = null;

  /** The configured git remote name (default: 'origin'). */
  private get remoteName(): string {
    return this.config.remote.git_remote;
  }

  private driverContext?: DriverContext;
  private retryOpts?: RetryOptions;

  constructor(config: ResolvedConfig, deps?: GitLabDriverDeps, context?: DriverContext) {
    this.config = config;
    this.gl = deps?.runGl ?? runGl;
    this.git = deps?.runGit ?? defaultRunGit;
    // When deps are injected (test mode), default to no-retry to avoid test
    // timeouts from backoff delays. Tests that want to verify retry behavior
    // can explicitly set retryOptions with appropriate timeouts.
    this.retryOpts = deps?.retryOptions ?? (deps ? { maxAttempts: 1 } : undefined);
    this.driverContext = context;
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

    const remoteRef = `${this.remoteName}/${branch}`;
    const revListResult = await this.git(
      ['rev-list', '--count', `HEAD..${remoteRef}`],
      worktreePath,
    );
    if (revListResult.exitCode !== 0) {
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

  upstreamRefName(parentBranch: string): string {
    return `${this.remoteName}/${parentBranch}`;
  }

  async resolveUpstreamRef(parentBranch: string, worktreePath: string): Promise<string> {
    const remoteRef = this.upstreamRefName(parentBranch);
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
    const { branch } = opts;

    // Push branch only — do NOT create a MR.
    // MR creation is deferred until the agent has actual commits (markReadyForReview).
    await this.pushBranch(branch);

    // If a MR already exists (e.g., imported from GitLab), return its metadata
    const existing = await this.findExistingMR(branch);
    if (existing) {
      logger.debug(`MR already exists: ${existing.url}`);
      return {
        metadata: {
          gitlab_remote_ref_url: existing.url,
          gitlab_remote_ref_id: String(existing.iid),
        },
      };
    }

    // Nothing to persist: markReadyForReview derives the MR target from the
    // task's canonical target (task.target), not from stored metadata.
    return { metadata: {} };
  }

  async markReadyForReview(task: Task, opts?: MarkReadyOptions): Promise<{ metadata?: Record<string, string> }> {
    const existingMrIid = this.mrNumber(task);

    if (existingMrIid) {
      // MR exists — check draft/WIP state explicitly before calling
      // `glab mr update --ready`. Substring-matching stderr for idempotency is
      // fragile; propagate real failures. If the MR isn't a draft, nothing to do.
      const viewResult = await this.gl(['mr', 'view', existingMrIid, '--output', 'json']);
      if (viewResult.exitCode !== 0) {
        throw new Error(
          `glab mr view failed (exit ${viewResult.exitCode}) for MR !${existingMrIid}: ${viewResult.stderr.trim()}`
        );
      }

      let isDraft: boolean;
      try {
        const data = JSON.parse(viewResult.stdout);
        // GitLab represents draft state via `draft` (newer) and `work_in_progress` (legacy).
        isDraft = data.draft === true || data.work_in_progress === true;
      } catch (err) {
        throw new Error(
          `glab mr view returned unparseable JSON for MR !${existingMrIid}: ${err instanceof Error ? err.message : err}`
        );
      }

      if (!isDraft) {
        logger.debug(`MR !${existingMrIid} is already non-draft — nothing to do`);
        return {};
      }

      const readyResult = await this.gl(['mr', 'update', existingMrIid, '--ready']);
      if (readyResult.exitCode !== 0) {
        throw new Error(
          `glab mr update --ready failed (exit ${readyResult.exitCode}) for MR !${existingMrIid}: ${readyResult.stderr.trim()}`
        );
      }
      logger.info(`Marked MR !${existingMrIid} as ready for review`);
      return {};
    }

    // No MR yet — create one (non-draft, since we're marking ready)
    const branchName = getBranchName(task);
    // An explicit base is an explicit human submit into an intermediate branch
    // (see RepositoryDriver.markReadyForReview); everything else derives it.
    const targetBranch = opts?.baseBranch ?? await this.targetBranch(task);

    const body = this.buildMRBody(task);

    const createResult = await this.gl([
      'mr', 'create',
      '--source-branch', branchName,
      '--target-branch', targetBranch,
      '--title', truncateMRTitle(task.goal),
      '--description', body,
      '--no-editor',
    ]);

    if (createResult.exitCode !== 0) {
      throw new Error(
        `glab mr create failed (exit ${createResult.exitCode}) for branch ${branchName} -> ${targetBranch}: ${createResult.stderr.trim()}`
      );
    }

    // glab mr create outputs the MR URL on stdout
    const mrUrl = this.extractMrUrl(createResult.stdout);
    const mrIid = await this.getMRNumber(branchName, mrUrl);

    if (mrUrl) {
      logger.info(`Created MR: ${mrUrl}`);
    }
    return {
      metadata: {
        ...(mrUrl ? { gitlab_remote_ref_url: mrUrl } : {}),
        ...(mrIid !== undefined ? { gitlab_remote_ref_id: String(mrIid) } : {}),
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

    // Resume of a dead accept: the forge SQUASH-merges, so the branch is never
    // an ancestor of the target and the check above cannot see a merge that
    // already landed. Ask the trees instead — and never open a replacement
    // PR/MR for work that is already on the target.
    if (opts.resume && await this.changesAlreadyOnRemoteTarget(sourceBranch, targetBranch, root)) {
      logger.info('Resume: the branch\'s changes are already on the remote target — nothing to merge.');
      return { status: 'merged', alreadyLanded: true };
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

    // Step 2: Ensure we have an open MR to merge
    let mrIid = this.mrNumber(task);
    let updatedMetadata: Record<string, string> | undefined;

    const existing = await this.findExistingMR(sourceBranch);

    if (existing?.state === 'merged') {
      // MR was already merged on the remote
      logger.info('MR is already merged on remote.');
      return { status: 'merged' };
    }

    if (!existing || existing.state !== 'opened') {
      // MR is stale or doesn't exist — create a replacement
      const reason = existing ? `stale (state: ${existing.state})` : 'not found';
      logger.info(`Existing MR is ${reason}, creating replacement MR...`);

      const body = this.buildMRBody(task);
      const createResult = await this.gl([
        'mr', 'create',
        '--source-branch', sourceBranch,
        '--target-branch', targetBranch,
        '--title', truncateMRTitle(task.goal),
        '--description', body,
        '--no-editor',
      ]);

      if (createResult.exitCode !== 0) {
        if (await this.isBranchMerged(sourceBranch, targetBranch, root)) {
          logger.info('Branch is already merged into target — nothing to do.');
          return { status: 'merged' };
        }
        return {
          status: 'failed',
          error: `Failed to create replacement MR: ${createResult.stderr}`,
        };
      }

      const mrUrl = this.extractMrUrl(createResult.stdout);
      const newMrIid = await this.getMRNumber(sourceBranch, mrUrl);

      if (newMrIid !== undefined) {
        mrIid = String(newMrIid);
      } else {
        mrIid = undefined;
      }

      updatedMetadata = {
        ...(mrUrl ? { gitlab_remote_ref_url: mrUrl } : {}),
        ...(mrIid !== undefined ? { gitlab_remote_ref_id: mrIid } : {}),
      };

      logger.info(`Created replacement MR: ${mrUrl ?? 'unknown URL'}`);
    }

    // Gate checks (pipeline, approvals) are handled by checkAcceptGates() before merge() is called.
    // merge() trusts that the caller has already validated gates.
    const mergeTarget = mrIid ?? sourceBranch;

    // Step 3: Squash merge via glab mr merge
    const { LAZY_COAUTHOR_TRAILER } = await import('../constants');

    // Fetch current MR description to preserve in commit message
    let commitMessage = task.goal;
    let commitBody = LAZY_COAUTHOR_TRAILER;
    if (mrIid) {
      const viewResult = await this.gl(['mr', 'view', mrIid, '--output', 'json'], root);
      if (viewResult.exitCode === 0) {
        try {
          const mrData = JSON.parse(viewResult.stdout);
          const originalBody = mrData.description || '';
          commitBody = originalBody ? `${originalBody}\n\n${LAZY_COAUTHOR_TRAILER}` : LAZY_COAUTHOR_TRAILER;
        } catch {
          logger.debug('Failed to parse MR body, using co-author trailer only');
        }
      }
    }

    // INVARIANT: every successful accept must leave the MR with auto-merge enabled,
    // regardless of pipeline state. `--auto-merge` is glab's default but we pass it
    // explicitly so behavior is stable across glab versions and obvious to readers.
    // When the pipeline is already passing (or absent), GitLab will merge immediately;
    // when it is running/pending, GitLab queues "merge when pipeline succeeds".
    const mergeResult = await this.gl(
      ['mr', 'merge', String(mergeTarget), '--squash', '--squash-message', `${commitMessage}\n\n${commitBody}`, '--auto-merge', '--yes'],
      root,
    );
    if (mergeResult.exitCode !== 0) {
      // Use structured JSON output from glab CLI to determine failure reason
      if (mrIid) {
        const viewResult = await this.gl(['mr', 'view', mrIid, '--output', 'json'], root);
        if (viewResult.exitCode === 0) {
          try {
            const data = JSON.parse(viewResult.stdout);

            // Check for conflicts via structured fields
            if (data.has_conflicts === true || data.merge_status === 'cannot_be_merged') {
              return {
                status: 'failed',
                isConflict: true,
                error: 'MR has merge conflicts',
                metadata: updatedMetadata,
              };
            }

            // Check for pending pipeline via structured fields
            const pipelineStatus = data.head_pipeline?.status;
            const detailedStatus = data.detailed_merge_status;
            if (pipelineStatus === 'running' || pipelineStatus === 'pending' ||
                detailedStatus === 'ci_still_running' || detailedStatus === 'ci_must_pass') {
              return {
                status: 'pending',
                reason: `Pipeline ${pipelineStatus ?? 'pending'}`,
                metadata: updatedMetadata,
              };
            }
          } catch { /* fall through to generic failure */ }
        }
      }

      // All other failures
      return {
        status: 'failed',
        error: `MR merge failed: ${mergeResult.stderr}`,
        metadata: updatedMetadata,
      };
    }

    // glab mr merge succeeded — but that does NOT mean the merge actually
    // happened. With `--auto-merge`, glab returns success when GitLab accepts
    // the request and queues "merge when pipeline succeeds". We MUST verify
    // the post-merge MR state via the API before reporting 'merged'.
    // INVARIANT: never silently return 'merged' without confirming the merge.
    // See CLAUDE.md: "Fail hard on remote failures — no silent fallbacks".
    if (!mrIid) {
      // Reaching here without an MR IID means MR creation/lookup silently
      // produced no identifier. We cannot verify a merge we cannot identify.
      return {
        status: 'failed',
        error: 'glab mr merge reported success but no MR IID is available to verify the merge state. Refusing to report a merge we cannot confirm.',
        metadata: updatedMetadata,
      };
    }

    const postMergeState = await this.getPRState(task);
    if (postMergeState === 'MERGED') {
      return { status: 'merged', metadata: updatedMetadata };
    }
    if (postMergeState === 'OPEN') {
      // MR is still open — auto-merge was queued (will merge when pipeline passes).
      return {
        status: 'pending',
        reason: 'Auto-merge set, waiting for pipeline',
        metadata: updatedMetadata,
      };
    }
    if (postMergeState === 'CLOSED') {
      return {
        status: 'failed',
        error: `glab mr merge reported success but MR !${mrIid} is in CLOSED state — the merge did not happen. Reopen the MR and retry, or investigate why the MR was closed.`,
        metadata: updatedMetadata,
      };
    }
    // getPRState returned null — API call failed or response was unparseable.
    return {
      status: 'failed',
      error: `glab mr merge reported success but post-merge state verification failed for MR !${mrIid}. Cannot confirm the merge landed. Retry \`lazy accept\` once GitLab is reachable.`,
      metadata: updatedMetadata,
    };
  }

  async getChecksStatus(task: Task): Promise<ChecksStatusResult> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      return { status: 'passed' };
    }

    const pipelines = await this.getMRPipelines(mrIid);
    if (pipelines.length === 0) {
      return { status: 'passed' };
    }

    const latest = pipelines[0];
    const status = latest.status;

    if (status === 'failed' || status === 'canceled') {
      // Fetch job-level failures for more actionable details
      const failedJobs = await this.getPipelineFailedJobs(latest.id);
      if (failedJobs.length > 0) {
        return {
          status: 'failed',
          failed: failedJobs.map(j => ({ name: j.name, url: j.web_url })),
        };
      }
      return {
        status: 'failed',
        failed: [{ name: `Pipeline #${latest.id}`, url: latest.web_url }],
      };
    }

    if (status === 'success') {
      return { status: 'passed' };
    }

    // Still running/pending
    return { status: 'pending' };
  }

  async waitForChecks(task: Task, options?: WaitForChecksOptions): Promise<ChecksResult> {
    const timeout = options?.timeout ?? 600_000; // 10 minutes
    const pollInterval = options?.pollInterval ?? 10_000; // 10 seconds

    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('waitForChecks: no MR number in task metadata, returning passed');
      return { passed: true };
    }

    const startTime = Date.now();

    while (true) {
      const pipelines = await this.getMRPipelines(mrIid);

      if (pipelines.length === 0) {
        logger.debug('waitForChecks: no pipelines found, returning passed');
        return { passed: true };
      }

      // Check the latest pipeline
      const latest = pipelines[0];
      const status = latest.status;

      if (status === 'success') {
        return { passed: true };
      }

      if (status === 'failed' || status === 'canceled') {
        return {
          passed: false,
          failed: [{ name: `Pipeline #${latest.id}`, url: latest.web_url }],
        };
      }

      // Still running/pending
      if (Date.now() - startTime >= timeout) {
        return {
          passed: false,
          failed: [{ name: `Pipeline #${latest.id}`, url: latest.web_url }],
          timedOut: true,
        };
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`Waiting for pipeline (status: ${status}) [${elapsed}s elapsed]`);

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Get pipelines for a merge request.
   * Uses glab api to fetch pipeline status.
   */
  private async getMRPipelines(mrIid: string): Promise<Array<{ id: number; status: string; web_url?: string }>> {
    // Use glab api to get MR pipelines
    const result = await this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/pipelines`,
    ]);

    if (result.exitCode !== 0) {
      logger.debug(`getMRPipelines: glab api failed for MR !${mrIid}: ${result.stderr}`);
      return [];
    }

    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      logger.debug(`getMRPipelines: failed to parse response for MR !${mrIid}`);
      return [];
    }
  }

  /**
   * Get failed jobs for a specific pipeline.
   * Returns an array of jobs with name, status, and web_url.
   */
  private async getPipelineFailedJobs(pipelineId: number): Promise<Array<{ id: number; name: string; status: string; web_url?: string }>> {
    const result = await this.gl([
      'api', `projects/:id/pipelines/${pipelineId}/jobs`,
    ]);

    if (result.exitCode !== 0) {
      logger.debug(`getPipelineFailedJobs: glab api failed for pipeline #${pipelineId}: ${result.stderr}`);
      return [];
    }

    try {
      const jobs: Array<{ id: number; name: string; status: string; web_url?: string }> = JSON.parse(result.stdout.trim());
      return jobs.filter(j => j.status === 'failed');
    } catch {
      logger.debug(`getPipelineFailedJobs: failed to parse response for pipeline #${pipelineId}`);
      return [];
    }
  }

  async getFailedCIJobs(task: Task, branchName?: string): Promise<CIJobFailure[]> {
    // Try branch-based pipeline lookup first (works without an MR)
    if (branchName) {
      const branchPipelines = await this.getBranchPipelines(branchName);
      if (branchPipelines.length > 0) {
        const latest = branchPipelines[0];
        if (latest.status !== 'failed' && latest.status !== 'canceled') {
          // Pipeline exists but not failed — no CI failures
          return [];
        }
        const failedJobs = await this.getPipelineFailedJobs(latest.id);
        if (failedJobs.length === 0) {
          return [{ name: `Pipeline #${latest.id}`, url: latest.web_url }];
        }
        const results: CIJobFailure[] = [];
        for (const job of failedJobs) {
          const failure: CIJobFailure = { name: job.name, url: job.web_url };
          try {
            const traceResult = await this.gl(['api', `projects/:id/jobs/${job.id}/trace`]);
            if (traceResult.exitCode === 0 && traceResult.stdout) {
              failure.log = truncateLog(traceResult.stdout, 200);
            }
          } catch {
            logger.debug(`getFailedCIJobs: failed to fetch trace for job ${job.name}`);
          }
          results.push(failure);
        }
        return results;
      }
    }

    // Fall back to MR-based lookup
    const mrIid = this.mrNumber(task);

    // If there's an MR, use MR-based pipeline lookup (most precise).
    // Otherwise, fall back to branch-based pipeline detection so
    // CI failures are caught even before an MR exists (auto-push flow).
    const pipelines = mrIid
      ? await this.getMRPipelines(mrIid)
      : await this.getBranchPipelines(getBranchName(task));

    if (pipelines.length === 0) return [];

    const latest = pipelines[0];
    if (latest.status !== 'failed' && latest.status !== 'canceled') return [];

    const failedJobs = await this.getPipelineFailedJobs(latest.id);
    if (failedJobs.length === 0) {
      // Fall back to pipeline-level info if no job details available
      return [{ name: `Pipeline #${latest.id}`, url: latest.web_url }];
    }

    const results: CIJobFailure[] = [];

    for (const job of failedJobs) {
      const failure: CIJobFailure = {
        name: job.name,
        url: job.web_url,
      };

      // Fetch job trace (log output)
      try {
        const traceResult = await this.gl([
          'api', `projects/:id/jobs/${job.id}/trace`,
        ]);
        if (traceResult.exitCode === 0 && traceResult.stdout) {
          failure.log = truncateLog(traceResult.stdout, 200);
        }
      } catch {
        logger.debug(`getFailedCIJobs: failed to fetch trace for job ${job.name}`);
      }

      results.push(failure);
    }

    return results;
  }

  /**
   * Get pipelines for a branch directly (without an MR).
   * Uses the GitLab pipelines API filtered by ref. This enables CI auto-react
   * before an MR exists (auto-push flow).
   */
  private async getBranchPipelines(branch: string): Promise<Array<{ id: number; status: string; web_url?: string }>> {
    const result = await this.gl([
      'api', `projects/:id/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`,
    ]);

    if (result.exitCode !== 0) {
      logger.debug(`getBranchPipelines: glab api failed for branch ${branch}: ${result.stderr}`);
      return [];
    }

    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      logger.debug(`getBranchPipelines: failed to parse response for branch ${branch}`);
      return [];
    }
  }

  /**
   * `reason` is deliberately unused: GitLab's approve endpoint takes no body,
   * and the note that used to carry the reason is exactly the notification
   * lazy stopped writing (engineer decision, 2026-09-21). The reason stays on
   * the task and in the merge commit.
   */
  async approveForMerge(task: Task, _reason: string): Promise<string | null> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('approveForMerge: no MR number in task metadata, skipping');
      return null;
    }

    const approveResult = await this.gl(['mr', 'approve', mrIid]);
    if (approveResult.exitCode === 0) {
      logger.debug(`approveForMerge: approved MR !${mrIid}`);
      return null;
    }

    // Same rule as GitHubDriver.approveForMerge: a forge REFUSING the
    // approval for an expected reason is debug + null, and only a real
    // failure warns. GitLab spells every refusal 401 — including an expired
    // token — so the status alone cannot classify: see
    // isApprovalRefusalStatus below. On a 401, ask glab whether the
    // credential still works. It does → GitLab declined the approval itself
    // (author, already approved, no permission), which is the expected
    // outcome under `[remote] auto_approve` and must stay quiet. It does not
    // → the credential is the problem, and that is a real failure the human
    // needs to see. The probe runs on the failure path only.
    if (isApprovalRefusalStatus(approveResult.stderr)) {
      const authStatus = await this.gl(['auth', 'status']);
      if (authStatus.exitCode === 0) {
        logger.debug(
          `approveForMerge: MR !${mrIid} approval refused as expected: ${approveResult.stderr}`,
        );
        return null;
      }
      const detail = (authStatus.stderr || authStatus.stdout).trim()
        || 'glab auth status failed with no output';
      logger.warn(
        `approveForMerge: MR !${mrIid} approval returned 401 (${approveResult.stderr.trim()}) `
        + `and 'glab auth status' failed too: ${detail}`,
      );
      return `Could not approve MR !${mrIid}: GitLab returned 401 and the glab credential is not working `
        + `(run 'glab auth login'): ${detail}`;
    }

    logger.warn(`approveForMerge: MR approve failed for !${mrIid}: ${approveResult.stderr}`);
    return `Could not approve MR !${mrIid}: ${approveResult.stderr}`;
  }

  async cleanup(branch: string): Promise<void> {
    const existing = await this.findExistingMR(branch);
    if (existing && existing.state === 'opened') {
      logger.info(`Closing MR !${existing.iid} for branch ${branch}...`);
      const closeResult = await this.gl(['mr', 'close', String(existing.iid)]);
      if (closeResult.exitCode !== 0) {
        logger.warn(`Failed to close MR !${existing.iid}: ${closeResult.stderr}`);
      } else {
        logger.debug(`Closed MR !${existing.iid}`);
      }
    }
  }

  async syncComments(task: Task, since?: string): Promise<RemoteComment[]> {
    const taskLabel = task.code ?? task.id.substring(0, 8);
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug(`syncComments [${taskLabel}]: no MR number in task metadata, skipping`);
      return [];
    }

    // Public repos are a prompt injection vector — skip comment sync unless
    // the user has explicitly opted in via the intentionally-ugly config flag.
    if (!(await this.isRepoPrivate())) {
      if (!this.config.remote.gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
        logger.info(`syncComments [${taskLabel}]: skipping comment sync for public repo (prompt injection risk). Set gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection = true in [remote] to enable.`);
        return [];
      }
      logger.warn(`syncComments [${taskLabel}]: syncing comments from PUBLIC repo — prompt injection risk accepted via config`);
    }

    const comments: RemoteComment[] = [];

    // Fetch MR notes (comments) via API
    try {
      const notes = await this.fetchPaginatedNotes(mrIid, since);
      for (const note of notes) {
        const body = (note.body as string) ?? '';
        // Skip system notes (merge status changes, label additions, etc.)
        if (note.system === true) continue;
        // Skip comments marked as lazy's own output (older turn/note comments
        // and review reports carry the hidden marker)
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments [${taskLabel}]: skipping own comment (id: ${note.id})`);
          continue;
        }
        const author = (note.author as Record<string, unknown> | undefined);
        comments.push({
          forge: 'gitlab',
          kind: 'mr_note',
          id: String(note.id),
          body,
          author: (author?.username as string) ?? 'unknown',
          createdAt: (note.created_at as string) ?? '',
          // GitLab inline notes have position data
          path: (note.position as Record<string, unknown> | undefined)?.new_path as string | undefined,
          line: (note.position as Record<string, unknown> | undefined)?.new_line as number | undefined,
        });
      }
    } catch (err) {
      logger.warn(`syncComments [${taskLabel}]: failed to fetch MR notes: ${err instanceof Error ? err.message : err}`);
    }

    // Filter out comments posted by lazy itself. Per-turn mirroring is gone,
    // but older threads may still carry lazy's own marker-bearing turn/note
    // comments — and lazy's review reports use the same marker.
    const externalComments = comments.filter(c => !c.body.startsWith('<!-- lazy:'));

    // Sort by creation time (oldest first)
    externalComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    logger.debug(`syncComments [${taskLabel}]: fetched ${comments.length} comments since ${since ?? 'the beginning'}, ${externalComments.length} external`);
    return externalComments;
  }

  async getPRState(task: Task): Promise<PRState | null> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) return null;

    const result = await this.gl(['mr', 'view', mrIid, '--output', 'json']);
    if (result.exitCode !== 0) {
      logger.debug(`getPRState: glab mr view failed for MR !${mrIid}: ${result.stderr}`);
      return null;
    }

    try {
      const data = JSON.parse(result.stdout.trim());
      const state = data.state as string;
      // GitLab states: opened, closed, merged, locked
      if (state === 'merged') return 'MERGED';
      if (state === 'closed' || state === 'locked') return 'CLOSED';
      if (state === 'opened') return 'OPEN';
      return null;
    } catch {
      logger.debug(`getPRState: failed to parse response for MR !${mrIid}`);
      return null;
    }
  }

  async checkHealth(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // 1. Check glab CLI is installed
    const glabVersion = await this.gl(['--version']);
    if (glabVersion.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'glab CLI installed', reason: 'Install from https://gitlab.com/gitlab-org/cli' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'glab CLI installed' });

    // 2. Check glab auth status
    const authStatus = await this.gl(['auth', 'status']);
    if (authStatus.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'GitLab authentication', reason: 'Run: glab auth login' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'GitLab authentication' });

    // 3. Check token scopes from auth status output
    const authOutput = `${authStatus.stdout}\n${authStatus.stderr}`;
    // GitLab's 'api' scope is the minimum needed. Check for overly broad scopes.
    const dangerousScopes = ['sudo', 'admin_mode'];
    const foundScopes = dangerousScopes.filter(scope => authOutput.includes(scope));
    if (foundScopes.length > 0) {
      checks.push({
        state: 'warn',
        what: 'Token scopes',
        reason: `Token has ${foundScopes.map(s => `'${s}'`).join(', ')} — consider reducing to minimal 'api' scope`,
      });
    } else {
      checks.push({ state: 'ok', what: 'Token scopes' });
    }

    // 4. Check that the configured git remote exists and points to GitLab
    const remoteUrl = await this.git(['remote', 'get-url', this.remoteName]);
    if (remoteUrl.exitCode !== 0) {
      checks.push({ state: 'fail', what: `Git remote ${this.remoteName}`, reason: `No remote '${this.remoteName}' configured. Run: git remote add ${this.remoteName} <gitlab-url>` });
      return checks;
    }
    const url = remoteUrl.stdout;
    // gitlab.com (or a subdomain), or a host that merely mentions "gitlab" —
    // the latter is the deliberate self-hosted escape hatch, so gitlab.mycorp.com
    // does not get a spurious "does not appear to be GitLab". Unlike the old
    // substring test, both look at the HOST, not the whole URL.
    if (!remoteUrlHasHost(url, 'gitlab.com') && !remoteUrlHostContains(url, 'gitlab')) {
      checks.push({
        state: 'warn',
        what: `Git remote ${this.remoteName}`,
        reason: `Remote points to ${url}, which does not appear to be GitLab`,
      });
    } else {
      checks.push({ state: 'ok', what: `Git remote ${this.remoteName}` });
    }

    // 5. Check repo visibility and comment sync status
    const projectInfo = await this.gl(['api', 'projects/:id']);
    if (projectInfo.exitCode === 0) {
      try {
        const data = JSON.parse(projectInfo.stdout);
        const visibility = data.visibility as string;
        if (visibility !== 'private') {
          if (this.config.remote.gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
            checks.push({
              state: 'warn',
              what: 'Public repo: MR comment sync enabled (prompt injection risk)',
              reason: 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection is enabled — anyone can post comments that get forwarded to the agent',
            });
          } else {
            checks.push({
              state: 'warn',
              what: 'Public repo: MR comment sync disabled',
              reason: 'Comment sync is disabled for public repos to prevent prompt injection. MR review comments will not reach the agent.',
            });
          }
        } else {
          checks.push({ state: 'ok', what: 'Private repo: MR comment sync enabled' });
        }
      } catch {
        // Parse failure — skip this check
      }
    }

    return checks;
  }

  getConfigOptions(): DriverConfigOptions {
    return {
      valid: ['auto_approve', 'gitlab_auto_push', 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection'],
      deprecated: [],
    };
  }

  // --- Import methods ---

  canImport(url: string): boolean {
    return /^https?:\/\/[^/]*gitlab[^/]*\/[^/]+\/[^/]+\/-\/merge_requests\/\d+/.test(url);
  }

  async importUrl(url: string, _opts: ImportOptions): Promise<ImportResult> {
    const match = url.match(/\/merge_requests\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse MR number from URL: ${url}`);
    }
    const mrIid = match[1];

    // Fetch MR details via glab CLI
    const mrView = await this.gl(['mr', 'view', mrIid, '--output', 'json']);
    if (mrView.exitCode !== 0) {
      throw new Error(`Failed to fetch MR !${mrIid}: ${mrView.stderr}`);
    }

    let mrData: Record<string, unknown>;
    try {
      mrData = JSON.parse(mrView.stdout);
    } catch {
      throw new Error(`Failed to parse MR data for !${mrIid}`);
    }

    const title = (mrData.title as string) ?? `MR !${mrIid}`;
    const branch = mrData.source_branch as string;
    const state = mrData.state as string;
    const mrUrl = (mrData.web_url as string) ?? url;
    const mrNum = String(mrData.iid ?? mrIid);

    if (!branch) {
      throw new Error(`MR !${mrIid} has no source branch`);
    }

    // Fetch MR notes for import as comments
    const comments: RemoteComment[] = [];
    const notesResult = await this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/notes`, '--paginate',
    ]);
    if (notesResult.exitCode === 0) {
      try {
        const notes = parsePaginatedApiJson(notesResult.stdout);
        for (const note of notes) {
          if (note.system === true) continue;
          const author = (note.author as Record<string, unknown>)?.username as string ?? 'unknown';
          const body = (note.body as string) ?? '';
          if (body.trim()) {
            comments.push({
              forge: 'gitlab',
              kind: 'mr_note',
              id: String(note.id),
              body,
              author,
              createdAt: (note.created_at as string) ?? '',
            });
          }
        }
      } catch {
        logger.debug(`Failed to parse notes for MR !${mrIid}`);
      }
    }

    return {
      goal: title,
      description: typeof mrData.description === 'string' ? mrData.description : undefined,
      branch,
      metadata: {
        gitlab_remote_ref_url: mrUrl,
        gitlab_remote_ref_id: mrNum,
        gitlab_remote_ref_state: state,
        import_source_url: url,
        import_source_branch: branch,
      },
      comments,
    };
  }

  /**
   * Open MR for this git branch, if any. Skips closed/merged so a stale MR
   * cannot auto-complete a freshly linked task. Uses the real branch name —
   * never `lazy/<task-ref>`.
   */
  async findPullRequestForBranch(branch: string): Promise<ImportResult | null> {
    const existing = await this.findExistingMR(branch);
    if (!existing) return null;
    const state = (existing.state ?? '').toLowerCase();
    if (state === 'merged' || state === 'closed') return null;
    return this.importUrl(existing.url, {});
  }

  async findOpenReviewForBranch(branch: string): Promise<OpenReview | null> {
    const result = await this.gl(['mr', 'view', branch, '--output', 'json']);
    if (result.exitCode !== 0) {
      // glab reports a branch with no MR this way. Anything else (auth,
      // network) is a failure to ask, and must not read as "no MR" — submit
      // would then try to open a second one.
      if (/no (open )?merge requests? (available|found)/i.test(result.stderr)) return null;
      throw new Error(`glab mr view ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    let data: { web_url?: string; iid?: number; state?: string; target_branch?: string };
    try {
      data = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`glab mr view ${branch} returned unparseable JSON: ${err instanceof Error ? err.message : err}`);
    }
    if ((data.state ?? '').toLowerCase() !== 'opened' || !data.web_url || data.iid === undefined) return null;
    return {
      url: data.web_url,
      baseBranch: data.target_branch ?? '',
      metadata: {
        gitlab_remote_ref_url: data.web_url,
        gitlab_remote_ref_id: String(data.iid),
      },
    };
  }

  async getReviewBase(task: Task): Promise<string | null> {
    const iid = this.mrNumber(task);
    if (!iid) return null;
    const result = await this.gl(['mr', 'view', iid, '--output', 'json']);
    if (result.exitCode !== 0) {
      throw new Error(`glab mr view ${iid} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    try {
      const base = (JSON.parse(result.stdout) as { target_branch?: string }).target_branch;
      if (!base) throw new Error('no target_branch in the reply');
      return base;
    } catch (err) {
      throw new Error(`glab mr view ${iid} returned no usable target branch: ${err instanceof Error ? err.message : err}`);
    }
  }

  async retargetReview(task: Task, base: string): Promise<void> {
    const iid = this.mrNumber(task);
    if (!iid) throw new Error(`Task ${task.id} records no MR to retarget.`);
    const result = await this.gl(['mr', 'update', iid, '--target-branch', base]);
    if (result.exitCode !== 0) {
      throw new Error(`glab mr update ${iid} --target-branch ${base} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    logger.info(`Retargeted MR !${iid} onto ${base}`);
  }

  async remoteBranchHead(branch: string): Promise<string | null> {
    return await withRemoteRetry(
      async () => {
        const result = await this.git(['ls-remote', '--exit-code', '--heads', this.remoteName, `refs/heads/${branch}`]);
        // --exit-code: 2 means the remote answered and has no such ref.
        if (result.exitCode === 2) return null;
        if (result.exitCode !== 0) {
          throw new Error(`git ls-remote ${this.remoteName} ${branch} failed: ${result.stderr.trim()}`);
        }
        return result.stdout.trim().split(/\s+/)[0] || null;
      },
      `look up ${branch} on ${this.remoteName}`,
      this.retryOpts,
    );
  }

  // --- Task URL and remote ref ---

  async getTaskUrl(task: Task): Promise<string | null> {
    return this.mrUrl(task) ?? null;
  }

  hasRemoteRef(task: Task): boolean {
    return !!this.mrNumber(task);
  }

  getRemoteRefUrl(task: Task): string | null {
    return this.mrUrl(task) ?? null;
  }

  getRemoteRefState(task: Task): string | null {
    return task.metadata?.gitlab_remote_ref_state ?? null;
  }

  validateAccept(task: Task): string | null {
    if (!this.hasRemoteRef(task)) {
      return 'Task has no remote reference (MR). Push and create an MR first with: lazy submit';
    }
    return null;
  }

  async isTargetBranchProtected(targetBranch: string): Promise<boolean> {
    const result = await this.gl([
      'api', `projects/:id/protected_branches/${encodeURIComponent(targetBranch)}`,
    ]);

    // 200 = protected, 404 = not protected
    return result.exitCode === 0;
  }

  async hasExternalApproval(task: Task): Promise<boolean> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) return false;

    // Get the authenticated user so we can exclude their approvals.
    // If auto_approve previously submitted an approval (and accept failed later),
    // that approval must not trick the non-auto-approve path into thinking
    // a human reviewed it.
    const userResult = await this.gl(['api', 'user', '--output', 'json']);
    let currentUsername = '';
    if (userResult.exitCode === 0) {
      try {
        const userData = JSON.parse(userResult.stdout);
        currentUsername = userData.username ?? '';
      } catch { /* fall through — include all approvals */ }
    }

    const result = await this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/approvals`,
    ]);

    if (result.exitCode !== 0) return false;

    try {
      const data = JSON.parse(result.stdout);
      const approvedBy: Array<{ user?: { username?: string } }> = data.approved_by ?? [];
      const externalApprovals = currentUsername
        ? approvedBy.filter(a => a.user?.username !== currentUsername)
        : approvedBy;
      return externalApprovals.length > 0;
    } catch {
      return false;
    }
  }

  async checkAcceptGates(task: Task): Promise<AcceptGateWarning[]> {
    const warnings: AcceptGateWarning[] = [];
    const mrIid = this.mrNumber(task);
    if (!mrIid) return warnings;

    // Gate 1: Pipeline status
    // INVARIANT: a running/pending pipeline is NOT a blocker — auto-merge handles
    // it (glab queues "merge when pipeline succeeds"). Only failed/canceled
    // pipelines block accept; surfacing those as warnings prevents the orchestrator
    // from queueing auto-merge against a known-bad pipeline.
    const pipelines = await this.getMRPipelines(mrIid);
    if (pipelines.length > 0) {
      const latest = pipelines[0];
      if (latest.status === 'failed' || latest.status === 'canceled') {
        warnings.push({ gate: 'ci', message: `Pipeline ${latest.status}` });
      }
    }

    // Gate 2: Approval status
    const viewResult = await this.gl(['mr', 'view', mrIid, '--output', 'json']);
    if (viewResult.exitCode === 0) {
      try {
        const data = JSON.parse(viewResult.stdout);
        if (data.detailed_merge_status === 'not_approved') {
          warnings.push({ gate: 'reviews', message: 'Required approvals not met' });
        }

        // Gate 3: Unresolved discussions
        // GitLab's blocking_discussions_resolved field indicates whether
        // all discussions that block merging have been resolved.
        if (data.blocking_discussions_resolved === false) {
          warnings.push({ gate: 'comments', message: 'Unresolved blocking discussions' });
        }
      } catch {
        logger.warn(`checkAcceptGates: failed to parse MR view response: ${viewResult.stdout.substring(0, 200)}`);
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

    const headResult = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${targetBranch}`;

    if (currentBranch === targetBranch) {
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
    return await sharedFastForwardLocal(targetBranch, this.remoteName, root, this.git, shouldSkipWorktree);
  }

  async fetchRemoteState(root: string, branchesToUpdate?: string[]): Promise<void> {
    logger.info('Fetching from remote...');
    const fetchResult = await this.git(['fetch', this.remoteName], root);
    if (fetchResult.exitCode !== 0) {
      // Reported through the deduplicating helper: the daemon fetches once a
      // minute, and an indefinite failure (missing credentials, most often)
      // would otherwise write the same line into daemon.log forever.
      reportFetchFailure(root, this.remoteName, fetchResult.stderr);
    } else {
      clearFetchFailure(root, this.remoteName);
      logger.debug('Fetched latest from remote');
    }

    const branches = new Set(['main', ...(branchesToUpdate ?? [])]);

    for (const branch of branches) {
      await this.fastForwardBranch(root, branch);
    }
  }

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

    const headResult = await this.git(['symbolic-ref', '--short', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${branch}`;

    if (currentBranch === branch) {
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

  private logMergeFailure(branch: string, stderr: string): void {
    if (stderr.includes('fatal: refusing to merge unrelated histories') || stderr.includes('not possible to fast-forward') || stderr.includes('! [rejected]')) {
      logger.warn(`${branch} branch has diverged from ${this.remoteName}/${branch}. Manual merge may be needed.`);
    } else if (stderr.includes('Already up to date') || stderr.includes('up to date')) {
      logger.debug(`${branch} branch already up to date`);
    } else {
      logger.debug(`${branch} merge result: ${stderr}`);
    }
  }

  // --- Metadata accessors ---

  getLastFidelityTurnSeq(task: Task): number {
    // Canonical key first, then the pre-fidelity "posted turn" key so stores
    // written by the removed per-turn mirroring keep their watermark.
    const val = task.metadata?.gitlab_fidelity_turn_seq ?? task.metadata?.gitlab_remote_last_posted_turn_seq;
    return val ? Number(val) : -1;
  }

  fidelityTurnSeqKey(): string {
    return 'gitlab_fidelity_turn_seq';
  }

  getLastCIFailureSynced(task: Task): string | undefined {
    return task.metadata?.gitlab_ci_failure_synced;
  }

  ciFailureSyncedKey(): string {
    return 'gitlab_ci_failure_synced';
  }

  formatImportedComment(comment: RemoteComment, task: Task): string {
    const mrNum = this.mrNumber(task) ?? '?';
    let content = `[MR !${mrNum} @${comment.author}] ${comment.body}`;
    if (comment.path) {
      content += `\n(on file: ${comment.path}`;
      if (comment.line) content += `, line ${comment.line}`;
      content += ')';
    }
    return content;
  }

  isImportedComment(noteContent: string): boolean {
    return /^\[MR !\d+ @[^\]]+\] \{(?:remote|gl):\w+\}/.test(noteContent);
  }

  async recoverRemoteRef(task: Task): Promise<Record<string, string> | null> {
    const branchName = getBranchName(task);
    const existing = await this.findExistingMR(branchName);
    if (!existing) return null;

    return {
      gitlab_remote_ref_url: existing.url,
      gitlab_remote_ref_id: String(existing.iid),
    };
  }

  // --- Private helpers ---

  private mrNumber(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_ref_id;
  }

  private mrUrl(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_ref_url;
  }

  /**
   * The target branch for a NEW MR, derived from the task's canonical
   * integration target ({@link TaskTarget}) — never from stored metadata.
   *
   * Used only when *creating* an MR (markReadyForReview). An MR's target is a
   * creation-time fact owned by GitLab thereafter; a later `lazy reparent` does
   * not rewrite an open MR's target. MRs are only opened for top-level tasks,
   * whose target is a named branch.
   */
  private async targetBranch(task: Task): Promise<string> {
    // INVARIANT: PRs only for protected branches; subtask→parent merges are
    // local. A task stacked on another task (target.kind === 'task') or carrying
    // a legacy 'lazy/...' sentinel must NEVER have its MR silently retargeted to
    // the default branch — that is exactly the "MR against main for a child task"
    // bug. An MR is only ever created for a protected named-branch target, so
    // reaching here for a lazy-parented task is a merge-routing bug; fail loudly.
    if (task.target.kind === 'task') {
      throw new Error(
        `Refusing to create an MR for task ${task.id}: it is stacked on another task ` +
        `(parent ${task.target.parentTaskId}). Subtask→parent merges must be local git ` +
        `operations, not remote MRs — this is a merge-routing bug.`,
      );
    }
    const branch = targetBranchOf(task);
    if (branch && looksLikeTaskBranch(branch)) {
      throw new Error(
        `Refusing to create an MR for task ${task.id}: integration target ('${branch}') is a lazy task branch, ` +
        `not a real integration branch. A lazy task-branch parent means the merge must be a local git operation, ` +
        `not a remote MR — this is a merge-routing bug.`,
      );
    }
    // A detached-HEAD root task (branch === 'HEAD') or an unresolved target
    // ('' / undefined) legitimately integrates into the repo's default branch.
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
   * Check if the current project is private. Caches the result for the driver lifetime.
   * Returns true if private, false otherwise. Defaults to false (public) on error
   * to err on the side of safety (skipping comment sync).
   */
  private async isRepoPrivate(): Promise<boolean> {
    if (this.repoPrivate !== null) return this.repoPrivate;

    const result = await this.gl(['api', 'projects/:id']);
    if (result.exitCode !== 0) {
      logger.warn(`isRepoPrivate: glab api failed, assuming public (comment sync will be skipped): ${result.stderr}`);
      this.repoPrivate = false;
      return false;
    }

    try {
      const data = JSON.parse(result.stdout);
      this.repoPrivate = data.visibility === 'private';
    } catch {
      logger.warn('isRepoPrivate: failed to parse response, assuming public (comment sync will be skipped)');
      this.repoPrivate = false;
    }

    return this.repoPrivate;
  }

  private buildMRBody(task: Task): string {
    return composeInitialBody({
      goal: task.goal,
      prompt: task.prompt ?? undefined,
      footer: '---\n*Created by [lazy](https://getlazy.dev/)*',
    });
  }

  async updateRemoteBody(task: Task, summary: string): Promise<void> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('updateRemoteBody: task has no MR — skipping');
      return;
    }

    await withRemoteRetry(
      async () => {
        // Read the live description so human edits outside the lazy section survive.
        const viewResult = await this.gl(['mr', 'view', mrIid, '--output', 'json']);
        if (viewResult.exitCode !== 0) {
          throw new Error(`glab mr view failed (exit ${viewResult.exitCode}) for MR !${mrIid}: ${viewResult.stderr.trim()}`);
        }
        let currentBody = '';
        try {
          currentBody = JSON.parse(viewResult.stdout).description ?? '';
        } catch (err) {
          throw new Error(`glab mr view returned unparseable JSON for MR !${mrIid}: ${err instanceof Error ? err.message : err}`);
        }

        const newBody = applyFidelitySection(currentBody, summary);
        if (newBody === currentBody) {
          logger.debug(`updateRemoteBody: MR !${mrIid} description unchanged — skipping edit`);
          return;
        }

        const editResult = await this.gl(['mr', 'update', mrIid, '--description', newBody]);
        if (editResult.exitCode !== 0) {
          throw new Error(`glab mr update failed (exit ${editResult.exitCode}) for MR !${mrIid}: ${editResult.stderr.trim()}`);
        }
        logger.debug(`updateRemoteBody: updated lazy section of MR !${mrIid}`);
      },
      `update description of MR !${mrIid}`,
      this.retryOpts,
    );
  }

  /**
   * Would merging sourceBranch into <remote>/<targetBranch> change nothing?
   * The squash-aware twin of isBranchMerged, used only on a resumed accept.
   * Any git failure answers false (the ordinary merge path then reports it).
   */
  private async changesAlreadyOnRemoteTarget(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
    const remoteRef = `${this.remoteName}/${targetBranch}`;
    const merged = await this.git(['merge-tree', '--write-tree', remoteRef, sourceBranch], cwd);
    if (merged.exitCode !== 0) return false;
    const tree = await this.git(['rev-parse', '--verify', `${remoteRef}^{tree}`], cwd);
    if (tree.exitCode !== 0) return false;
    const mergedTree = merged.stdout.split('\n')[0]?.trim();
    return !!mergedTree && mergedTree === tree.stdout.trim();
  }

  /** Check if sourceBranch is already fully merged into targetBranch via git (ancestry, so it cannot see a squash). */
  private async isBranchMerged(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
    const result = await this.git(
      ['merge-base', '--is-ancestor', sourceBranch, `${this.remoteName}/${targetBranch}`],
      cwd,
    );
    return result.exitCode === 0;
  }

  private async findExistingMR(branch: string): Promise<{ url: string; iid: number; state: string } | null> {
    const result = await this.gl(['mr', 'view', branch, '--output', 'json']);
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout);
      return { url: data.web_url, iid: data.iid, state: data.state };
    } catch {
      return null;
    }
  }

  /**
   * Fetch all notes from a MR, optionally only those created at or after
   * `since`. As in GitHubDriver.fetchPaginatedComments, `since` is a display
   * window, never an import watermark: importers pass none and dedup by id.
   * Uses glab api with --paginate.
   */
  private async fetchPaginatedNotes(
    mrIid: string,
    since: string | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/notes`,
      '--paginate',
    ]);

    if (result.exitCode !== 0) {
      logger.warn(`fetchPaginatedNotes: API call failed: ${result.stderr}`);
      return [];
    }

    if (!result.stdout.trim()) return [];

    try {
      const allNotes = parsePaginatedApiJson(result.stdout);

      if (since === undefined) return allNotes;
      return allNotes.filter(n => {
        const createdAt = n.created_at as string | undefined;
        return createdAt && createdAt >= since;
      });
    } catch (err) {
      logger.warn(`fetchPaginatedNotes: failed to parse response: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * Extract the MR URL from glab mr create output.
   * glab typically prints the URL on its own line.
   */
  private extractMrUrl(output: string): string | undefined {
    // Look for a URL pattern in the output
    const match = output.match(/https?:\/\/[^\s]+merge_requests\/\d+/);
    return match ? match[0] : undefined;
  }

  private async getMRNumber(branch: string, mrUrl?: string): Promise<number | undefined> {
    // Try glab mr view first
    const viewResult = await this.gl(['mr', 'view', branch, '--output', 'json']);
    if (viewResult.exitCode === 0) {
      try {
        return JSON.parse(viewResult.stdout).iid;
      } catch {
        // fall through
      }
    }
    // Fallback: parse from URL
    if (mrUrl) {
      return parseMrNumberFromUrl(mrUrl);
    }
    return undefined;
  }
}


/**
 * GitLab's approve endpoint says "you may not approve this" with HTTP 401,
 * and nothing else.
 *
 * `POST /projects/:id/merge_requests/:iid/approve` ends in `unauthorized!
 * unless result.success?` (lib/api/merge_request_approvals.rb), so EVERY
 * disallowed approval — the author approving their own MR, an approval that
 * already exists, a user without the permission — comes back as 401 with the
 * body `{"message":"401 Unauthorized"}`. GitLab does not distinguish them,
 * and neither can lazy: the earlier prose-matching predicate looked for
 * phrases ("cannot approve your own", "already approved") that the API never
 * sends, so the normal outcome for the sole developer `[remote] auto_approve`
 * is documented for warned on every single accept.
 *
 * The catch is that an invalid or expired token is ALSO a 401 with the very
 * same body (GitLab's REST authentication docs). So the status alone cannot
 * classify, and `approveForMerge` disambiguates with the credential probe
 * below, on the failure path only.
 *
 * The match is on the STATUS WORD, never on the bare number. glab surfaces an
 * API error through go-gitlab's `ErrorResponse`, formatted
 * `<METHOD> <URL>: <code> <body>` — so the request URL, and with it the
 * project id and the MR iid, is inside the string read here. A `\b401\b` test
 * therefore matched EVERY approve failure on a project whose id is 401 (or on
 * MR !401): a 404, a 409, a 5xx would each be taken for a refusal and, with a
 * healthy credential, silently swallowed. Every genuine refusal carries
 * `401 Unauthorized`, so the word costs no coverage and cannot be spelled by
 * an id.
 *
 * The GitHub twin is `isExpectedApprovalRefusal` in github-driver.ts, where
 * the forge is unambiguous (422 for a refusal, 401 for a bad credential) and
 * no probe is needed. Both drivers mean the same thing by "expected" — the
 * forge itself declining an approval it was never going to accept, with a
 * working credential — and both answer it the same way: debug + null, while
 * anything else warns and returns a warning.
 */
function isApprovalRefusalStatus(stderr: string): boolean {
  return stderr.toLowerCase().includes('unauthorized');
}
