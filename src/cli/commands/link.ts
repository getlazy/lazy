/**
 * `lazy link <url>` — link an external resource (e.g., a GitHub PR) as a lazy task.
 *
 * Uses the configured remote driver to check if it can handle the URL,
 * fetches the resource metadata, creates a task, sets up a worktree
 * on the existing branch, and stores the metadata.
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, validateCode, deriveCode, resolveTaskOrExit, taskRef } from '../helpers';
import { createWorktree, findWorktreeForBranch, getCurrentBranch, getRemoteDefaultBranch, copyUntrackedFilesIntoWorktree } from '../../git/operations';
import { loadConfig } from '../../config/loader';
import { resolveAgentForNewTask } from '../../agent/task-agent';
import { createDriver } from '../../remote';
import { getDataDir } from '../init';
import { theme } from '../theme';
import { getActor } from '../../constants';
import { runGit } from '../../utils/git';

export async function commandLink(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'parent', takesValue: true },
    { name: 'code', takesValue: true },
  ], 'link');

  const url = parsed.positional[0];
  if (!url) {
    linkUsage();
    process.exit(1);
  }

  // Validate code if provided
  let codeValue: string | undefined;
  const codeFlag = parsed.flags.get('code') as string | undefined;
  if (codeFlag !== undefined) {
    const codeError = validateCode(codeFlag);
    if (codeError) {
      console.error(`Invalid code '${codeFlag}': ${codeError}`);
      process.exit(1);
    }
    codeValue = codeFlag;
  }

  const root = requireLazyRoot();
  const config = await loadConfig(root);

  // Use the configured remote driver
  const driver = createDriver(config);

  // Check if the driver can handle this URL
  if (!driver.canImport?.(url)) {
    if (!driver.canImport) {
      // Driver doesn't support importing at all
      console.error(`Cannot link external resources with the current driver.`);
      console.error('Configure a remote driver first. For GitHub:');
      console.error('  1. Run: lazy init');
      console.error('  2. Or add to lazy.toml: [remote]\\n     driver = "github"');
    } else {
      // Driver supports import but can't handle this particular URL
      console.error(`The configured remote driver cannot handle this URL: ${url}`);
      console.error('Check that the URL is in a supported format.');
    }
    process.exit(1);
  }

  // Resolve parent task if specified
  let parentTaskId: string | undefined;
  const parentFlag = parsed.flags.get('parent') as string | undefined;

  const storage = await requireStorage();
  try {
    if (parentFlag !== undefined) {
      const parentTask = await resolveTaskOrExit(storage, parentFlag);
      parentTaskId = parentTask.id;
    }

    // Link the resource via the driver
    console.log(`Linking ${url}...`);
    const result = await driver.importUrl!(url, { parentTaskId });

    // Clean up goal: if the PR title looks like a branch name (contains `/`),
    // convert it to a readable form: "ivan/deno-v2" → "Ivan: Deno V2"
    const goal = cleanupGoal(result.goal);

    // Auto-derive code from branch name (primary) or goal (fallback) when --code not provided
    if (codeValue === undefined) {
      const derived = deriveCode(result.branch) ?? deriveCode(goal);
      if (derived) {
        codeValue = derived;
      }
    }

    // Fetch the branch from remote so we can create a worktree
    const gitRemote = config.remote.git_remote;
    console.log(`Fetching branch ${result.branch}...`);
    const fetchResult = await runGit(
      ['fetch', gitRemote, `${result.branch}:${result.branch}`],
      { cwd: root },
    );
    if (fetchResult.exitCode !== 0) {
      // Branch might already exist locally — try to update it
      const pullResult = await runGit(
        ['fetch', gitRemote, result.branch],
        { cwd: root },
      );
      if (pullResult.exitCode !== 0) {
        console.error(`Failed to fetch branch '${result.branch}' from remote.`);
        console.error(`Make sure you have access to this repository and the branch exists.`);
        console.error(pullResult.stderr);
        process.exit(1);
      }
    }

    // Check if branch already has a worktree before creating the task
    const existingWorktree = await findWorktreeForBranch(result.branch, root);
    if (existingWorktree) {
      console.error(`Branch '${result.branch}' already has a worktree at ${existingWorktree}.`);
      console.error('Cannot link — the branch is already checked out.');
      process.exit(1);
    }

    // Create task. This uses the same agent the session below is stamped with
    // (config.agent.agent_id) — leaving it unset made the task claim
    // claude-code while its own session said otherwise.
    const task = await storage.createTask(
      goal,
      parentTaskId,
      undefined,
      codeValue,
      undefined,
      resolveAgentForNewTask({ configDefault: config.agent.agent_id }),
    );

    // Store metadata
    for (const [key, value] of Object.entries(result.metadata)) {
      await storage.updateTaskMetadata(task.id, key, value);
    }

    // Import comments (marked as 'remote' to prevent re-exporting to PR)
    if (result.comments && result.comments.length > 0) {
      for (const comment of result.comments) {
        await storage.createComment(task.id, comment, getActor(), 'remote');
      }
    }

    // Create worktree from existing branch
    const taskShortId = shortId(task.id);
    const worktreeBase = join(root, getDataDir(root), 'worktrees');
    const worktreePath = join(worktreeBase, taskRef(task));

    mkdirSync(worktreeBase, { recursive: true });

    if (!existsSync(worktreePath)) {
      console.log(`Creating worktree for branch ${result.branch}...`);
      await createWorktree(worktreePath, result.branch, root);
      // Copy untracked files configured in worktree.include
      await copyUntrackedFilesIntoWorktree(root, worktreePath, config.worktree.include);
    }

    // Detect the parent branch (the branch this was forked from).
    // Use the remote's default branch (e.g., main) to check merge-base.
    const defaultBranch = await getRemoteDefaultBranch(root, config.remote.git_remote);
    const mergeBaseResult = await runGit(
      ['merge-base', defaultBranch, result.branch],
      { cwd: root },
    );
    if (mergeBaseResult.exitCode === 0) {
      await storage.updateTaskMetadata(task.id, 'parent_branch', defaultBranch);
    }

    // Create a session record so the task shows the correct branch
    const agentId = config.agent.agent_id;
    const startSha = await runGit(
      ['rev-parse', result.branch],
      { cwd: root },
    );
    const sha = startSha.exitCode === 0 ? startSha.stdout : 'unknown';
    await storage.createSession(task.id, agentId, result.branch, sha);

    // Print summary
    console.log(theme.success(`\nLinked task ${displayId(task)}`));
    console.log(`  ${theme.label('Goal:')}     ${goal}`);
    console.log(`  ${theme.label('Branch:')}   ${result.branch}`);
    console.log(`  ${theme.label('Status:')}   ${theme.status('blocked')}`);
    // Use driver accessors to read metadata — avoids hardcoding driver-specific key names.
    const taskWithMeta = { ...task, metadata: result.metadata };
    const refUrl = driver.getRemoteRefUrl(taskWithMeta);
    const refState = driver.getRemoteRefState(taskWithMeta);
    if (refUrl) {
      console.log(`  ${theme.label('PR:')}       ${refUrl}`);
    }
    if (refState) {
      console.log(`  ${theme.label('PR State:')} ${refState}`);
    }
    if (parentTaskId) {
      console.log(`  ${theme.label('Parent:')}   ${theme.taskId(await displayIdFor(storage, parentTaskId))}`);
    }
    if (result.comments && result.comments.length > 0) {
      console.log(`  ${theme.label('Notes:')}    ${result.comments.length} comment(s) imported`);
    }

    console.log(`\nThe task is ${theme.status('blocked')} — ready for review or work.`);
    console.log(`  Review:  ${theme.command('lazy show ' + displayId(task))}`);
    console.log(`  Shell:   ${theme.command('lazy shell ' + displayId(task))}`);
    console.log(`  Unblock: ${theme.command('lazy unblock ' + displayId(task))}`);

  } finally {
    await storage.close();
  }
}

/**
 * Clean up a PR title for use as a task goal.
 * If the title looks like a branch name (contains `/`), convert it:
 *   "ivan/deno-v2" → "Ivan: Deno v2"
 * Otherwise return the title as-is (it's what the PR author wrote).
 */
function cleanupGoal(title: string): string {
  if (!title.includes('/')) {
    return title;
  }
  // Split on first `/` only: "ivan/deno-v2" → ["ivan", "deno-v2"]
  const slashIndex = title.indexOf('/');
  const prefix = title.substring(0, slashIndex);
  const rest = title.substring(slashIndex + 1);

  // Title-case a word: first letter uppercase, rest as-is
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Convert hyphens/underscores to spaces, then title-case each word
  const cleanRest = rest
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(titleCase)
    .join(' ');

  return `${titleCase(prefix)}: ${cleanRest}`;
}

export function linkUsage(): void {
  console.log(`Usage: lazy link <url> [--parent <task_id>] [--code <code>]

Link an external resource (e.g., a GitHub PR) as a lazy task.

Arguments:
  <url>              URL of the resource to link

Options:
  --parent <task_id>  Set a parent task for the linked task
  --code <code>       Human-readable code (e.g. "fix-auth", "add-login")

Requires a remote driver to be configured (e.g., driver = "github" in lazy.toml).

Supported URL Patterns (GitHub driver):
  GitHub PRs:  https://github.com/<owner>/<repo>/pull/<number>

What happens:
  1. The configured remote driver checks if it can handle the URL
  2. The driver fetches metadata (title, branch, comments)
  3. A lazy task is created with the PR title as the goal
  4. A worktree is created from the existing branch
  5. PR comments are imported as task notes
  6. The task starts in 'blocked' status for review

Examples:
  lazy link https://github.com/org/repo/pull/42
  lazy link https://github.com/org/repo/pull/42 --parent auth-rewrite
  lazy link https://github.com/org/repo/pull/42 --code fix-auth`);
}
