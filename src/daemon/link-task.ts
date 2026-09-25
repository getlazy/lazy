/**
 * Link a branch or PR as a lazy task — the daemon implementation the CLI,
 * MCP, and web call so those rules live in one place.
 *
 * A linked task adopts an existing branch (never `lazy/<code>`). It is not
 * started. Sync/merge into that branch is only an explicit human act — the
 * periodic forge pass may attach a PR that appears later, but it never
 * pushes or merges into someone else's branch.
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { PhaseReporter, LINK_PHASES, linkPhasePlan, type ProgressEmitter } from './progress';
import { loadConfig } from '../config/loader';
import { createDriver } from '../remote';
import { importForgeComments } from '../remote/imported-comments';
import { resolveAgentForNewTaskFromConfig } from '../agent/task-agent';
import { parseLinkTarget, assertSafeGitName } from '../remote/link-target';
import { applyLinkIdentity } from '../task/linked';
import { describeLinkedTaskInline, assertLinkActorCredential } from './link-describe';
import { displayId, displayIdFor, shortId, validateCode, deriveCode, taskRef } from '../task/identity';
import { getDataDir } from '../project-paths';
import {
  createWorktree,
  findWorktreeForBranch,
  getRemoteDefaultBranch,
  copyUntrackedFilesIntoWorktree,
} from '../git/operations';
import { pathExists } from '../utils/fs';
import { runGit } from '../utils/git';
import { getActor } from '../constants';
import type { ActorInput, Task } from '../types';
import type { ImportResult, RepositoryDriver } from '../remote/driver';
import type { Storage } from '../storage';
import { docsSuffix } from '../docs/links';

export interface LinkTaskParams {
  /** PR URL, branch URL, `origin/branch`, or a bare branch name. */
  ref: string;
  parent?: string;
  code?: string;
  actor?: ActorInput;
  onProgress?: ProgressEmitter;
}

export interface LinkTaskResult {
  taskId: string;
  displayId: string;
  goal: string;
  branch: string;
  status: string;
  prUrl: string | null;
  prState: string | null;
  commentsImported: number;
  parentDisplayId: string | null;
  warnings: string[];
}

/**
 * Import a PR URL or adopt a branch as a blocked linked task.
 *
 * Throws RpcError: 400 (bad ref / code / fetch), 404 (parent), 409 (worktree
 * already exists), 422 (driver cannot import this PR URL), 500 (create
 * succeeded then a later step failed — the leftover task is closed).
 */
export async function linkTask(
  projectRoot: string,
  params: LinkTaskParams,
): Promise<LinkTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'link');
  const warnings: string[] = [];
  phases.announce(linkPhasePlan(), params.ref);

  const storage = await getOrCreateStorage();
  const config = await loadConfig(projectRoot);
  const driver = createDriver(config, { storage, lazyRoot: projectRoot });
  const actor = params.actor ?? getActor();

  // Before anything is adopted: in team mode the description is billed to
  // the acting human, and one with no credential is refused, not relinked.
  await assertLinkActorCredential(projectRoot, params.actor);

  let codeValue: string | undefined;
  if (params.code !== undefined) {
    const codeError = validateCode(params.code);
    if (codeError) {
      throw new RpcError(400, `Invalid code '${params.code}': ${codeError}`);
    }
    codeValue = params.code;
  }

  let parentTaskId: string | undefined;
  if (params.parent !== undefined && params.parent.trim() !== '') {
    const parentResolved = await storage.resolveTask(params.parent.trim());
    if (parentResolved.ambiguousMatches?.length) {
      throw new RpcError(
        400,
        `Ambiguous parent '${params.parent}'. Matches: ${parentResolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`,
      );
    }
    if (!parentResolved.task) {
      throw new RpcError(404, `Parent task not found: ${params.parent}`);
    }
    parentTaskId = parentResolved.task.id;
  }

  phases.begin(LINK_PHASES.resolve);
  const remotes = await listGitRemotes(projectRoot);
  let target;
  try {
    target = parseLinkTarget(params.ref, remotes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }

  let imported: ImportResult;
  if (target.kind === 'pr-url') {
    imported = await importPullRequest(driver, target.raw);
  } else {
    const branch = target.branch;
    if (!branch) {
      throw new RpcError(400, `Could not read a branch name from '${params.ref}'.`);
    }
    imported = await importBranch(driver, branch, params.ref);
  }
  phases.end();

  // Forge-supplied head branches skip parseLinkTarget. Validate before any
  // other git call so a malicious PR title/head cannot become argv.
  try {
    assertSafeGitName(imported.branch, 'branch');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }

  const goal = cleanupGoal(imported.goal);
  if (codeValue === undefined) {
    const derived = deriveCode(imported.branch) ?? deriveCode(goal);
    if (derived) codeValue = derived;
  }

  const gitRemote = target.remote ?? config.remote.git_remote ?? 'origin';
  try {
    assertSafeGitName(gitRemote, 'remote');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }
  await assertGitBranchFormat(projectRoot, imported.branch);

  phases.begin(LINK_PHASES.fetch);
  const fetchWarning = await fetchLinkedBranch(projectRoot, gitRemote, imported.branch);
  if (fetchWarning) warnings.push(fetchWarning);
  phases.end();

  const existingWorktree = await findWorktreeForBranch(imported.branch, projectRoot);
  if (existingWorktree) {
    throw new RpcError(
      409,
      `Branch '${imported.branch}' already has a worktree at ${existingWorktree}. ` +
      'Cannot link — the branch is already checked out.',
    );
  }

  // merge-base / start SHA do not need the task id — run them before
  // createTask so a failure here leaves no leftover row.
  const defaultBranch = await getRemoteDefaultBranch(projectRoot, gitRemote);
  const mergeBaseResult = await runGit(
    ['merge-base', '--', defaultBranch, imported.branch],
    { cwd: projectRoot },
  );
  const startSha = await runGit(
    ['rev-parse', '--verify', imported.branch],
    { cwd: projectRoot },
  );
  const sha = startSha.exitCode === 0 ? startSha.stdout.trim() : 'unknown';

  phases.begin(LINK_PHASES.worktree);
  const projectSettings = await storage.getProjectSettings();
  const agentId = resolveAgentForNewTaskFromConfig({}, config.agent, projectSettings).agentId;

  // After createTask every remaining step needs the id (worktree path,
  // metadata, session). A throw here would leave a linked-metadata row
  // with no worktree and no session, so we abandon the leftover and
  // name the failure in the error the caller sees.
  let created: Task | undefined;
  try {
    created = await storage.createTask(
      goal,
      parentTaskId,
      undefined,
      codeValue,
      undefined,
      agentId,
      actor,
    );

    const metadata = applyLinkIdentity(imported.metadata, params.ref.trim(), imported.branch);
    // Pin task_ref to the short id used for the worktree path. Start otherwise
    // re-derives a code-based ref, looks for a different directory, and fails
    // because the adopted branch is already checked out here.
    const linkedRef = taskRef(created);
    metadata.task_ref = linkedRef;
    for (const [key, value] of Object.entries(metadata)) {
      await storage.updateTaskMetadata(created.id, key, value);
    }
    if (!created.metadata) created.metadata = {};
    Object.assign(created.metadata, metadata);

    if (imported.comments && imported.comments.length > 0) {
      const linkedTask = created;
      await importForgeComments(
        storage, created.id, imported.comments, (c) => driver.formatImportedComment(c, linkedTask), actor,
      );
    }

    const worktreeBase = join(projectRoot, getDataDir(projectRoot), 'worktrees');
    const worktreePath = join(worktreeBase, taskRef(created));
    await mkdir(worktreeBase, { recursive: true });
    if (!(await pathExists(worktreePath))) {
      await createWorktree(worktreePath, imported.branch, projectRoot);
      await copyUntrackedFilesIntoWorktree(projectRoot, worktreePath, config.worktree.include);
    }
    phases.end();

    phases.begin(LINK_PHASES.create);
    if (mergeBaseResult.exitCode === 0) {
      await storage.updateTaskMetadata(created.id, 'parent_branch', defaultBranch);
    }
    await storage.createSession(created.id, agentId, imported.branch, sha);
    await storage.updateTaskStatus(created.id, 'blocked', actor);
    phases.end();

    const taskWithMeta = { ...created, metadata };
    const prUrl = driver.getRemoteRefUrl(taskWithMeta);
    const prState = driver.getRemoteRefState(taskWithMeta);
    const parentDisplayId = parentTaskId ? await displayIdFor(storage, parentTaskId) : null;

    // Last, and never fatal: the task, its branch and its worktree already
    // exist. A description that does not come back is a warning plus a retry
    // command — see describeLinkedTaskInline.
    const described = await describeLinkedTaskInline({
      projectRoot,
      storage,
      driver,
      task: taskWithMeta,
      imported,
      config,
      phases,
      actor: params.actor,
    });
    warnings.push(...described.warnings);

    return {
      taskId: created.id,
      displayId: displayId(created),
      goal: described.goal,
      branch: imported.branch,
      status: 'blocked',
      prUrl,
      prState,
      commentsImported: imported.comments?.length ?? 0,
      parentDisplayId,
      warnings,
    };
  } catch (err) {
    if (!created) throw err;
    const failure = err instanceof Error ? err.message : String(err);
    const closed = await closeFailedLink(storage, created, failure, actor);
    const message =
      `Link failed after creating task ${displayId(created)}: ${failure}. ${closed}`;
    phases.fail(message);
    throw new RpcError(500, message);
  }
}


async function closeFailedLink(
  storage: Storage,
  task: Task,
  failure: string,
  actor: ActorInput,
): Promise<string> {
  const reason = `link failed: ${failure}`;
  try {
    await storage.abandonTask(task.id, reason, actor);
    return `Closed leftover task ${displayId(task)} (${reason}).`;
  } catch (closeErr) {
    const closeMessage = closeErr instanceof Error ? closeErr.message : String(closeErr);
    return (
      `Could not close leftover task ${displayId(task)} (${reason}): ${closeMessage}. ` +
      `The task is still in the store — close it by hand.`
    );
  }
}

async function importPullRequest(driver: RepositoryDriver, url: string): Promise<ImportResult> {
  if (!driver.canImport) {
    throw new RpcError(
      422,
      'Cannot link external resources with the current driver.\n' +
      'Configure a remote driver first. For GitHub:\n' +
      '  1. Run: lazy init\n' +
      '  2. Or add to lazy.toml: [remote]\n     driver = "github"' +
      docsSuffix('link', '\n'),
    );
  }
  if (!driver.canImport(url) || !driver.importUrl) {
    throw new RpcError(
      422,
      `The configured remote driver cannot handle this URL: ${url}\n` +
      'Check that the URL is in a supported format.',
    );
  }
  try {
    return await driver.importUrl(url, {});
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}

async function importBranch(
  driver: RepositoryDriver,
  branch: string,
  originalRef: string,
): Promise<ImportResult> {
  if (driver.findPullRequestForBranch) {
    try {
      const found = await driver.findPullRequestForBranch(branch);
      if (found) return found;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(400, `Failed to look up a pull request for '${branch}': ${message}`);
    }
  }
  return {
    goal: branch,
    branch,
    metadata: applyLinkIdentity({}, originalRef.trim(), branch),
    comments: [],
  };
}

/**
 * Fetch the named branch. Prefer creating/updating the local branch as a
 * fast-forward of the remote. When that is not a fast-forward we still
 * fetch the remote-tracking ref and adopt the LOCAL branch — but we warn,
 * with commit counts, so the caller knows the two differ.
 *
 * `--` is required: without it a branch or remote starting with `-` is an
 * option (`--upload-pack=…`). Names are validated before we get here.
 */
async function fetchLinkedBranch(root: string, remote: string, branch: string): Promise<string | undefined> {
  const createLocal = await runGit(
    ['fetch', '--', remote, `${branch}:${branch}`],
    { cwd: root },
  );
  if (createLocal.exitCode === 0) return undefined;

  const update = await runGit(['fetch', '--', remote, branch], { cwd: root });
  // rev-parse --verify does not take `--` (that starts a pathspec). Names
  // are already validated; pin the local lookup to refs/heads/ so a tag
  // of the same name cannot shadow the branch.
  const local = await runGit(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: root },
  );

  if (update.exitCode !== 0 && local.exitCode !== 0) {
    throw new RpcError(
      400,
      `Failed to fetch branch '${branch}' from remote '${remote}'.\n` +
      `Make sure you have access to this repository and the branch exists.\n` +
      (update.stderr || createLocal.stderr),
    );
  }

  if (update.exitCode !== 0) {
    return (
      `Could not fetch '${branch}' from remote '${remote}'. ` +
      `The linked task tracks the local branch.`
    );
  }

  // Remote fetch succeeded; updating the local branch was not a fast-forward.
  return describeLocalRemoteDivergence(root, remote, branch);
}

async function describeLocalRemoteDivergence(
  root: string,
  remote: string,
  branch: string,
): Promise<string | undefined> {
  const remoteRef = `${remote}/${branch}`;
  const remoteExists = await runGit(
    ['rev-parse', '--verify', '--quiet', remoteRef],
    { cwd: root },
  );
  if (remoteExists.exitCode !== 0) {
    return (
      `Local branch '${branch}' could not be fast-forwarded from '${remote}'. ` +
      `The linked task tracks the local branch.`
    );
  }
  const ahead = await runGit(
    ['rev-list', '--count', `${remoteRef}..${branch}`],
    { cwd: root },
  );
  const behind = await runGit(
    ['rev-list', '--count', `${branch}..${remoteRef}`],
    { cwd: root },
  );
  const localOnly = ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : 0;
  const remoteOnly = behind.exitCode === 0 ? Number.parseInt(behind.stdout.trim(), 10) : 0;
  if (!Number.isFinite(localOnly) || !Number.isFinite(remoteOnly)) {
    return (
      `Local branch '${branch}' differs from '${remoteRef}'. ` +
      `The linked task tracks the local branch.`
    );
  }
  if (localOnly === 0 && remoteOnly === 0) return undefined;
  const localLabel = localOnly === 1 ? 'commit' : 'commits';
  const remoteLabel = remoteOnly === 1 ? 'commit' : 'commits';
  return (
    `Local branch '${branch}' differs from '${remoteRef}' ` +
    `(${localOnly} local-only ${localLabel}, ${remoteOnly} remote-only ${remoteLabel}). ` +
    `The linked task tracks the local branch.`
  );
}

/**
 * Second check, after the JS rules in assertSafeGitName: ask git itself.
 * `--branch` does not accept `--` (usage error 129), so we only call this
 * once the name is known not to start with `-`.
 */
async function assertGitBranchFormat(root: string, branch: string): Promise<void> {
  const result = await runGit(['check-ref-format', '--branch', branch], { cwd: root });
  if (result.exitCode !== 0) {
    throw new RpcError(400, `Invalid branch name '${branch}'.`);
  }
}

async function listGitRemotes(root: string): Promise<string[]> {
  const result = await runGit(['remote'], { cwd: root });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return ['origin', 'upstream'];
  }
  return result.stdout.split(/\s+/).filter(Boolean);
}

/**
 * Clean up a PR title for use as a task goal.
 * If the title looks like a branch name (contains `/`), convert it:
 *   "ivan/deno-v2" → "Ivan: Deno v2"
 * Otherwise return the title as-is (it's what the PR author wrote).
 */
export function cleanupGoal(title: string): string {
  if (!title.includes('/')) {
    return title;
  }
  const slashIndex = title.indexOf('/');
  const prefix = title.substring(0, slashIndex);
  const rest = title.substring(slashIndex + 1);
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const cleanRest = rest
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
  return `${titleCase(prefix)}: ${cleanRest}`;
}
