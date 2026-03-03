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
} from './driver';
import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';
import { logger } from '../utils/logger';
import { getBranchName, getWorktreePath } from '../cli/helpers';
import { runGit as defaultRunGit, fastForwardLocal as sharedFastForwardLocal, type GitResult } from '../utils/git';

export interface GlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Overridable subprocess runners for testing. */
export interface GitLabDriverDeps {
  runGl: (args: string[], cwd?: string) => GlResult;
  runGit: (args: string[], cwd?: string) => GitResult;
}

function runGl(args: string[], cwd?: string): GlResult {
  const spawnOpts: { cwd?: string; stdout: 'pipe'; stderr: 'pipe' } = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (cwd) spawnOpts.cwd = cwd;

  try {
    const result = Bun.spawnSync(['glab', ...args], spawnOpts);
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
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
    const result = Bun.spawnSync(['git', 'remote', 'get-url', remoteName], {
      cwd: repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (result.exitCode === 0) {
      const url = result.stdout.toString().trim();
      if (url.includes('gitlab.com')) {
        return {
          name: 'GitLab',
          tomlOverrides: { 'remote.driver': 'gitlab' },
        };
      }
    }
  } catch {
    // No remote or git error
  }
  return null;
}

export class GitLabDriver implements RepositoryDriver {
  needsSync = true;

  private config: ResolvedConfig;
  private gl: (args: string[], cwd?: string) => GlResult;
  private git: (args: string[], cwd?: string) => GlResult;
  private repoPrivate: boolean | null = null;

  /** The configured git remote name (default: 'origin'). */
  private get remoteName(): string {
    return this.config.remote.git_remote;
  }

  private driverContext?: DriverContext;

  constructor(config: ResolvedConfig, deps?: GitLabDriverDeps, context?: DriverContext) {
    this.config = config;
    this.gl = deps?.runGl ?? runGl;
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
    const fetchResult = this.git(['fetch', this.remoteName, branch], worktreePath);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch branch ${branch} from ${this.remoteName}: ${fetchResult.stderr}`);
    }

    const remoteRef = `${this.remoteName}/${branch}`;
    const revListResult = this.git(
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
    const { branch } = opts;

    // Push branch only — do NOT create a MR.
    // MR creation is deferred until the agent has actual commits (markReadyForReview).
    await this.pushBranch(branch);

    // If a MR already exists (e.g., imported from GitLab), return its metadata
    const existing = this.findExistingMR(branch);
    if (existing) {
      logger.debug(`MR already exists: ${existing.url}`);
      return {
        metadata: {
          gitlab_remote_ref_url: existing.url,
          gitlab_remote_ref_id: String(existing.iid),
        },
      };
    }

    // Store the target branch in metadata so markReadyForReview can create the MR later
    return {
      metadata: {
        remote_target_branch: opts.targetBranch,
      },
    };
  }

  async markReadyForReview(task: Task): Promise<{ metadata?: Record<string, string> }> {
    const existingMrIid = this.mrNumber(task);

    if (existingMrIid) {
      // MR exists — mark it as ready (remove draft/WIP status)
      const readyResult = this.gl(['mr', 'update', existingMrIid, '--ready']);
      if (readyResult.exitCode !== 0) {
        logger.debug(`Failed to mark MR !${existingMrIid} ready (non-fatal): ${readyResult.stderr}`);
      } else {
        logger.info(`Marked MR !${existingMrIid} as ready for review`);
      }
      return {};
    }

    // No MR yet — create one (non-draft, since we're marking ready)
    const branchName = getBranchName(task);
    const targetBranch = this.targetBranch(task);

    const body = this.buildMRBody(task);

    const createResult = this.gl([
      'mr', 'create',
      '--source-branch', branchName,
      '--target-branch', targetBranch,
      '--title', task.goal,
      '--description', body,
      '--no-editor',
    ]);

    if (createResult.exitCode !== 0) {
      logger.warn(`Failed to create MR (non-fatal): ${createResult.stderr}`);
      return {};
    }

    // glab mr create outputs the MR URL on stdout
    const mrUrl = this.extractMrUrl(createResult.stdout);
    const mrIid = this.getMRNumber(branchName, mrUrl);

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

    // Step 2: Ensure we have an open MR to merge
    let mrIid = this.mrNumber(task);
    let updatedMetadata: Record<string, string> | undefined;

    const existing = this.findExistingMR(sourceBranch);

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
      const createResult = this.gl([
        'mr', 'create',
        '--source-branch', sourceBranch,
        '--target-branch', targetBranch,
        '--title', task.goal,
        '--description', body,
        '--no-editor',
      ]);

      if (createResult.exitCode !== 0) {
        if (this.isBranchMerged(sourceBranch, targetBranch, root)) {
          logger.info('Branch is already merged into target — nothing to do.');
          return { status: 'merged' };
        }
        return {
          status: 'failed',
          error: `Failed to create replacement MR: ${createResult.stderr}`,
        };
      }

      const mrUrl = this.extractMrUrl(createResult.stdout);
      const newMrIid = this.getMRNumber(sourceBranch, mrUrl);

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

    // Step 3: Squash merge via glab mr merge
    const mergeTarget = mrIid ?? sourceBranch;
    const { LAZY_COAUTHOR_TRAILER } = await import('../constants');

    // Fetch current MR description to preserve in commit message
    let commitMessage = task.goal;
    let commitBody = LAZY_COAUTHOR_TRAILER;
    if (mrIid) {
      const viewResult = this.gl(['mr', 'view', mrIid, '--output', 'json'], root);
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

    const mergeResult = this.gl(
      ['mr', 'merge', String(mergeTarget), '--squash', '--squash-message', `${commitMessage}\n\n${commitBody}`, '--yes'],
      root,
    );
    if (mergeResult.exitCode !== 0) {
      // Use structured JSON output from glab CLI to determine failure reason
      if (mrIid) {
        const viewResult = this.gl(['mr', 'view', mrIid, '--output', 'json'], root);
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

    // glab mr merge succeeded — check if it actually merged or set auto-merge.
    // glab sets auto-merge when pipeline is running and the project supports it.
    if (mrIid) {
      const postMergeState = await this.getPRState(task);
      if (postMergeState === 'MERGED') {
        return { status: 'merged', metadata: updatedMetadata };
      }
      if (postMergeState === 'OPEN') {
        // MR is still open — auto-merge was likely set
        return {
          status: 'pending',
          reason: 'Auto-merge set, waiting for pipeline',
          metadata: updatedMetadata,
        };
      }
    }

    return { status: 'merged', metadata: updatedMetadata };
  }

  async getChecksStatus(task: Task): Promise<ChecksStatusResult> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      return { status: 'passed' };
    }

    const pipelines = this.getMRPipelines(mrIid);
    if (pipelines.length === 0) {
      return { status: 'passed' };
    }

    const latest = pipelines[0];
    const status = latest.status;

    if (status === 'failed' || status === 'canceled') {
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
      const pipelines = this.getMRPipelines(mrIid);

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
  private getMRPipelines(mrIid: string): Array<{ id: number; status: string; web_url?: string }> {
    // Use glab api to get MR pipelines
    const result = this.gl([
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

  async postAcceptReview(task: Task, reason: string): Promise<string | null> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('postAcceptReview: no MR number in task metadata, skipping');
      return null;
    }

    // Step 1: Try approving the MR via glab
    const approveResult = this.gl(['mr', 'approve', mrIid]);
    if (approveResult.exitCode === 0) {
      logger.debug(`postAcceptReview: approved MR !${mrIid}`);
    } else {
      // Approval may fail (self-approval, already approved, etc.) — log and continue
      logger.debug(`postAcceptReview: MR approve failed for !${mrIid} (non-fatal): ${approveResult.stderr}`);
    }

    // Step 2: Post a comment with the reason
    const commentBody = `[Lazy Accept] ${reason}`;
    const commentResult = this.gl(['mr', 'comment', mrIid, '--message', commentBody]);

    if (commentResult.exitCode === 0) {
      logger.debug(`postAcceptReview: posted accept comment to MR !${mrIid}`);
      return null;
    }

    const warning = `Could not post accept review to MR !${mrIid}: ${commentResult.stderr}`;
    logger.warn(`postAcceptReview: comment failed for MR !${mrIid}: ${commentResult.stderr}`);
    return warning;
  }

  async postRejectReview(task: Task, reason: string): Promise<string | null> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('postRejectReview: no MR number in task metadata, skipping');
      return null;
    }

    // GitLab has no "request changes" review state — use a comment instead
    const commentBody = `[Lazy Reject] ${reason}`;
    const commentResult = this.gl(['mr', 'comment', mrIid, '--message', commentBody]);

    if (commentResult.exitCode === 0) {
      logger.debug(`postRejectReview: posted reject comment to MR !${mrIid}`);
      return null;
    }

    const warning = `Could not post reject review to MR !${mrIid}: ${commentResult.stderr}`;
    logger.warn(`postRejectReview: comment failed for MR !${mrIid}: ${commentResult.stderr}`);
    return warning;
  }

  async cleanup(branch: string): Promise<void> {
    const existing = this.findExistingMR(branch);
    if (existing && existing.state === 'opened') {
      logger.info(`Closing MR !${existing.iid} for branch ${branch}...`);
      const closeResult = this.gl(['mr', 'close', String(existing.iid)]);
      if (closeResult.exitCode !== 0) {
        logger.warn(`Failed to close MR !${existing.iid}: ${closeResult.stderr}`);
      } else {
        logger.debug(`Closed MR !${existing.iid}`);
      }
    }
  }

  async syncComments(task: Task, since: string): Promise<RemoteComment[]> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('syncComments: no MR number in task metadata, skipping');
      return [];
    }

    // Public repos are a prompt injection vector — skip comment sync unless
    // the user has explicitly opted in via the intentionally-ugly config flag.
    if (!this.isRepoPrivate()) {
      if (!this.config.remote.gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection) {
        logger.info('syncComments: skipping comment sync for public repo (prompt injection risk). Set gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection = true in [remote] to enable.');
        return [];
      }
      logger.warn('syncComments: syncing comments from PUBLIC repo — prompt injection risk accepted via config');
    }

    const comments: RemoteComment[] = [];

    // Fetch MR notes (comments) via API
    try {
      const notes = this.fetchPaginatedNotes(mrIid, since);
      for (const note of notes) {
        const body = (note.body as string) ?? '';
        // Skip system notes (merge status changes, label additions, etc.)
        if (note.system === true) continue;
        // Skip comments marked as lazy's own output
        if (body.includes('<!-- lazy:')) {
          logger.debug(`syncComments: skipping own comment (id: ${note.id})`);
          continue;
        }
        const author = (note.author as Record<string, unknown> | undefined);
        comments.push({
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
      logger.warn(`syncComments: failed to fetch MR notes: ${err instanceof Error ? err.message : err}`);
    }

    // Filter out comments posted by lazy itself
    const externalComments = comments.filter(c => !c.body.startsWith('<!-- lazy:'));

    // Sort by creation time (oldest first)
    externalComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    logger.debug(`syncComments: fetched ${comments.length} comments since ${since}, ${externalComments.length} external`);
    return externalComments;
  }

  async getPRState(task: Task): Promise<PRState | null> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) return null;

    const result = this.gl(['mr', 'view', mrIid, '--output', 'json']);
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

  async postTurnSummary(task: Task, content: string): Promise<void> {
    const mrIid = this.mrNumber(task);
    if (!mrIid) {
      logger.debug('postTurnSummary: no MR number in task metadata, skipping');
      return;
    }

    // Prepend hidden HTML marker to identify this comment as lazy's own output.
    const markedContent = '<!-- lazy:turn -->\n' + content;

    const result = this.gl(['mr', 'comment', mrIid, '--message', markedContent]);
    if (result.exitCode !== 0) {
      logger.warn(`postTurnSummary: failed to post comment to MR !${mrIid}: ${result.stderr}`);
    } else {
      logger.debug(`postTurnSummary: posted turn summary to MR !${mrIid}`);
    }
  }

  async checkHealth(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // 1. Check glab CLI is installed
    const glabVersion = this.gl(['--version']);
    if (glabVersion.exitCode !== 0) {
      checks.push({ state: 'fail', what: 'glab CLI installed', reason: 'Install from https://gitlab.com/gitlab-org/cli' });
      return checks;
    }
    checks.push({ state: 'ok', what: 'glab CLI installed' });

    // 2. Check glab auth status
    const authStatus = this.gl(['auth', 'status']);
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
    const remoteUrl = this.git(['remote', 'get-url', this.remoteName]);
    if (remoteUrl.exitCode !== 0) {
      checks.push({ state: 'fail', what: `Git remote ${this.remoteName}`, reason: `No remote '${this.remoteName}' configured. Run: git remote add ${this.remoteName} <gitlab-url>` });
      return checks;
    }
    const url = remoteUrl.stdout;
    if (!url.includes('gitlab.com') && !url.includes('gitlab')) {
      checks.push({
        state: 'warn',
        what: `Git remote ${this.remoteName}`,
        reason: `Remote points to ${url}, which does not appear to be GitLab`,
      });
    } else {
      checks.push({ state: 'ok', what: `Git remote ${this.remoteName}` });
    }

    // 5. Check repo visibility and comment sync status
    const projectInfo = this.gl(['api', 'projects/:id']);
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
      valid: ['gitlab_auto_push', 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection'],
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
    const mrView = this.gl(['mr', 'view', mrIid, '--output', 'json']);
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
    const comments: string[] = [];
    const notesResult = this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/notes`, '--paginate',
    ]);
    if (notesResult.exitCode === 0) {
      try {
        const notes = this.parsePaginatedJson(notesResult.stdout);
        for (const note of notes) {
          if (note.system === true) continue;
          const author = (note.author as Record<string, unknown>)?.username as string ?? 'unknown';
          const body = (note.body as string) ?? '';
          if (body.trim()) {
            comments.push(`[${author}] ${body}`);
          }
        }
      } catch {
        logger.debug(`Failed to parse notes for MR !${mrIid}`);
      }
    }

    return {
      goal: title,
      branch,
      metadata: {
        gitlab_remote_ref_url: mrUrl,
        gitlab_remote_ref_id: mrNum,
        gitlab_remote_ref_state: state,
        import_source_url: url,
      },
      comments,
    };
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
      return 'Task has no remote reference (MR). Push and create an MR first with: lazy sync';
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

    const headResult = this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${targetBranch}`;

    if (currentBranch === targetBranch) {
      const fetchResult = this.git(['fetch', this.remoteName, targetBranch], root);
      if (fetchResult.exitCode !== 0) {
        const warning = `Failed to fetch ${targetBranch} from ${this.remoteName}: ${fetchResult.stderr.trim() || 'unknown error'}. Run \`git fetch ${this.remoteName}\` to retry.`;
        logger.warn(`fastForwardLocal: fetch failed: ${fetchResult.stderr}`);
        return { success: false, warning };
      }

      const mergeResult = this.git(['merge', '--ff-only', remoteRef], root);
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
      const localSha = this.git(['rev-parse', targetBranch], root);
      const remoteSha = this.git(['rev-parse', remoteRef], root);
      if (localSha.exitCode === 0 && remoteSha.exitCode === 0) {
        const ancestorCheck = this.git(['merge-base', '--is-ancestor', localSha.stdout.trim(), remoteSha.stdout.trim()], root);
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
    logger.info('Fetching from remote...');
    const fetchResult = this.git(['fetch', this.remoteName], root);
    if (fetchResult.exitCode !== 0) {
      logger.warn(`Fetch failed: ${fetchResult.stderr}`);
    } else {
      logger.debug('Fetched latest from remote');
    }

    const branches = new Set(['main', ...(branchesToUpdate ?? [])]);

    for (const branch of branches) {
      this.fastForwardBranch(root, branch);
    }
  }

  private fastForwardBranch(root: string, branch: string): void {
    logger.info(`Updating ${branch} branch...`);
    const checkResult = this.git(['rev-parse', '--verify', branch], root);
    if (checkResult.exitCode !== 0) {
      logger.debug(`${branch} branch not found locally, skipping`);
      return;
    }

    const headResult = this.git(['symbolic-ref', '--short', 'HEAD'], root);
    const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const remoteRef = `${this.remoteName}/${branch}`;

    if (currentBranch === branch) {
      const ffResult = this.git(['merge', '--ff-only', remoteRef], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
      } else {
        this.logMergeFailure(branch, ffResult.stderr);
      }
    } else {
      const ffResult = this.git(['fetch', this.remoteName, `${branch}:${branch}`], root);
      if (ffResult.exitCode === 0) {
        logger.debug(`${branch} branch fast-forwarded to ${remoteRef}`);
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

  getLastCommentSyncedAt(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_last_comment_synced_at;
  }

  commentSyncedAtKey(): string {
    return 'gitlab_remote_last_comment_synced_at';
  }

  getLastPostedTurnSeq(task: Task): number {
    const val = task.metadata?.gitlab_remote_last_posted_turn_seq;
    return val ? Number(val) : -1;
  }

  postedTurnSeqKey(): string {
    return 'gitlab_remote_last_posted_turn_seq';
  }

  getLastPostedNoteAt(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_last_posted_note_at;
  }

  postedNoteAtKey(): string {
    return 'gitlab_remote_last_posted_note_at';
  }

  formatImportedComment(comment: RemoteComment, task: Task): string {
    const mrNum = this.mrNumber(task) ?? '?';
    let content = `[MR !${mrNum} @${comment.author}] {remote:${comment.id}} ${comment.body}`;
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

  // --- Private helpers ---

  private mrNumber(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_ref_id;
  }

  private mrUrl(task: Task): string | undefined {
    return task.metadata?.gitlab_remote_ref_url;
  }

  private targetBranch(task: Task): string {
    return task.metadata?.remote_target_branch ?? 'main';
  }

  /**
   * Check if the current project is private. Caches the result for the driver lifetime.
   * Returns true if private, false otherwise. Defaults to false (public) on error
   * to err on the side of safety (skipping comment sync).
   */
  private isRepoPrivate(): boolean {
    if (this.repoPrivate !== null) return this.repoPrivate;

    const result = this.gl(['api', 'projects/:id']);
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
    const result = this.git(
      ['merge-base', '--is-ancestor', sourceBranch, `${this.remoteName}/${targetBranch}`],
      cwd,
    );
    return result.exitCode === 0;
  }

  private findExistingMR(branch: string): { url: string; iid: number; state: string } | null {
    const result = this.gl(['mr', 'view', branch, '--output', 'json']);
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout);
      return { url: data.web_url, iid: data.iid, state: data.state };
    } catch {
      return null;
    }
  }

  /**
   * Fetch all notes from a MR since a given timestamp.
   * Uses glab api with --paginate.
   */
  private fetchPaginatedNotes(
    mrIid: string,
    since: string,
  ): Array<Record<string, unknown>> {
    const result = this.gl([
      'api', `projects/:id/merge_requests/${mrIid}/notes`,
      '--paginate',
    ]);

    if (result.exitCode !== 0) {
      logger.warn(`fetchPaginatedNotes: API call failed: ${result.stderr}`);
      return [];
    }

    if (!result.stdout.trim()) return [];

    try {
      const allNotes = this.parsePaginatedJson(result.stdout);

      // Filter by since timestamp
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
   * Parse potentially paginated JSON output from glab api.
   * glab api --paginate may concatenate JSON arrays: [...][...][...]
   */
  private parsePaginatedJson(raw: string): Array<Record<string, unknown>> {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const normalized = '[' + trimmed.replace(/\]\s*\[/g, '],[') + ']';
      const pages: Array<Array<Record<string, unknown>>> = JSON.parse(normalized);
      return pages.flat();
    } else {
      return trimmed.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
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

  private getMRNumber(branch: string, mrUrl?: string): number | undefined {
    // Try glab mr view first
    const viewResult = this.gl(['mr', 'view', branch, '--output', 'json']);
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
