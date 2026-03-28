import { join } from 'path';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync } from 'fs';
import { homedir } from 'os';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, resolveTaskOrExit, rejectIfPairing, taskRef, deriveTaskRef, getWorktreePath, getWorktreePathForRef, getBranchNameFromId } from '../helpers';
import { getCurrentSha, getCurrentBranch, getRemoteDefaultBranch, resolveDetachedHead, createWorktree, createWorktreeFromSha, recoverMissingWorktree, copyUntrackedFilesIntoWorktree } from '../../git/operations';
import { getAuthEnv, getModelId } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { createRunner, type DockerRunnerOptions } from '../../runner';
import { createDriver } from '../../remote';
import { checkLock, acquireLock, removeLock } from '../../utils/lock';
import { promptYesNo, isTTY } from '../editor';
import { followContainer, buildNotesContext, buildSystemPrompt } from './shared';
import { checkOrphanedChild, retargetOrphanedChild } from '../orphan';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../../protocol';
import type { StartCommand } from '../../protocol';
import type { SandboxConfig } from '../../capture/claude';
import type { ModelName } from '../../types';
import { getAgent, listAgents } from '../../agent/registry';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { isFeatureEnabled } from '../../utils/features';
import { logger } from '../../utils/logger';
import { getActor } from '../../constants';
import { formatMarkdown } from '../../utils/markdown';

import goalContextStartText from '../../prompts/goal-context-start.md' with { type: 'text' };
import goalContextContinueText from '../../prompts/goal-context-continue.md' with { type: 'text' };
import { runGit } from '../../utils/git';

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Build a situational awareness preamble for linked tasks.
 * Gathers git state (commits ahead/behind, log, status, diff stat)
 * so the agent understands the existing branch state before working.
 */
function buildLinkedTaskPreamble(worktreePath: string, branchName: string, parentBranch: string): string {
  const lines: string[] = [];
  lines.push(`You are working on an existing branch '${branchName}' that was forked from '${parentBranch}'.`);
  lines.push('This branch already has work on it. Read the existing changes carefully before making modifications.');
  lines.push('');

  // Commits ahead/behind
  const countResult = runGit(
    ['rev-list', '--left-right', '--count', `${parentBranch}...${branchName}`],
    { cwd: worktreePath },
  );
  if (countResult.exitCode === 0) {
    const parts = countResult.stdout.split(/\s+/);
    const behind = parseInt(parts[0], 10) || 0;
    const ahead = parseInt(parts[1], 10) || 0;
    lines.push(`Branch status: ${ahead} commit(s) ahead, ${behind} commit(s) behind ${parentBranch}.`);
    lines.push('');
  }

  // Commit log since fork
  const logResult = runGit(
    ['log', '--no-color', '--oneline', `${parentBranch}..${branchName}`],
    { cwd: worktreePath },
  );
  if (logResult.exitCode === 0 && logResult.stdout) {
    lines.push('Existing commits on this branch:');
    lines.push(logResult.stdout);
    lines.push('');
  }

  // Working tree status
  const statusResult = runGit(
    ['status', '--short'],
    { cwd: worktreePath },
  );
  if (statusResult.exitCode === 0) {
    const status = statusResult.stdout;
    if (status) {
      lines.push('Working tree has uncommitted changes:');
      lines.push(status);
    } else {
      lines.push('Working tree is clean.');
    }
    lines.push('');
  }

  // Diff stat from parent branch
  const diffStatResult = runGit(
    ['diff', '--no-color', '--stat', `${parentBranch}...${branchName}`],
    { cwd: worktreePath },
  );
  if (diffStatResult.exitCode === 0 && diffStatResult.stdout) {
    lines.push(`Diff from ${parentBranch}:`);
    lines.push(diffStatResult.stdout);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the dynamic user prompt for a task turn.
 * Contains goal context, notes, and the actual user prompt.
 * Does NOT include tool/system instructions (those go in the system prompt).
 */
function buildPromptWithInstructions(userPrompt: string, goal: string, isFirstTurn: boolean, lazyRoot: string, notesContext?: string): string {
  const goalContext = (isFirstTurn ? goalContextStartText : goalContextContinueText)
    .replace(/\{\{goal\}\}/g, goal) + '\n\n';

  const notesSection = notesContext ?? '';
  return goalContext + notesSection + userPrompt;
}

function setupSandbox(worktreePath: string): SandboxConfig {
  const sandboxPath = join(worktreePath, SANDBOX_DIR);
  const claudeDir = join(sandboxPath, '.claude');

  mkdirSync(claudeDir, { recursive: true });

  // Copy .gitconfig from host.
  // Docker creates .gitconfig as a directory if the bind mount source doesn't exist.
  // Remove the stale directory before copying the file.
  const hostGitconfig = join(homedir(), '.gitconfig');
  const sandboxGitconfig = join(sandboxPath, '.gitconfig');
  if (existsSync(sandboxGitconfig) && statSync(sandboxGitconfig).isDirectory()) {
    rmSync(sandboxGitconfig, { recursive: true });
  }
  if (existsSync(hostGitconfig)) {
    copyFileSync(hostGitconfig, sandboxGitconfig);
  } else {
    // Create minimal gitconfig
    writeFileSync(sandboxGitconfig, '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n');
  }

  return { worktreePath, sandboxPath };
}

export async function commandStart(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'model', takesValue: true },
    { name: 'agent', takesValue: true },
    { name: 'follow', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'force-local', takesValue: false },
    { name: 'docker-agent-no-network', takesValue: false },
  ], 'start');

  const modelValue = parsed.flags.get('model') as string | undefined;
  const follow = parsed.flags.get('follow') === true;
  const yes = parsed.flags.get('yes') === true;
  const forceLocal = parsed.flags.get('force-local') === true;
  const dockerAgentNoNetwork = parsed.flags.get('docker-agent-no-network') === true;

  // Determine model override
  let modelOverride: ModelName | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Parse --agent flag
  const agentFlag = parsed.flags.get('agent') as string | undefined;
  let agentId: string | undefined;
  if (agentFlag !== undefined) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentFlag)) {
      console.error(`Unknown agent '${agentFlag}'. Available agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    agentId = agentFlag;
  }

  // Require task ID as the first positional argument
  const taskId = parsed.positional[0];
  if (!taskId) {
    console.error('Error: Task ID is required.');
    console.error('To create a new task, use: lazy create --goal "..." --prompt "..."');
    console.error('Then start it with: lazy start <task_id>');
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Starting an existing task
    let t = await resolveTaskOrExit(storage, taskId);
    if (!t.prompt) {
      console.error(`Task ${displayId(t)} has no prompt. Set one with: lazy edit ${displayId(t)}`);
      process.exit(1);
    }

    // Pre-flight check for child tasks: verify parent worktree exists
    // This check runs before the Docker/runner check to give a clear error message
    if (t.parent_task_id) {
      const parentTask = await storage.getTask(t.parent_task_id);
      if (!parentTask) {
        console.error(`Parent task not found: ${t.parent_task_id}`);
        process.exit(1);
      }

      const parentWorktreePath = getWorktreePath(root, parentTask);
      if (!existsSync(parentWorktreePath)) {
        console.error(`Cannot start child task: parent task has no worktree.`);
        console.error(`Start the parent first with: lazy start ${displayId(parentTask)}`);
        process.exit(1);
      }
    }

    // Check for orphaned child (parent accepted, branch gone) and retarget
    if (t.parent_task_id) {
      const orphanStatus = await checkOrphanedChild(t, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(theme.warning(`\nParent task was accepted and its branch deleted.`));
        console.log(`This task needs to be retargeted to ${theme.taskId(orphanStatus.retargetBranch)} before starting.\n`);

        let shouldRetarget: boolean;
        if (isTTY() && !yes) {
          shouldRetarget = await promptYesNo(`Retarget to ${orphanStatus.retargetBranch}?`, true);
        } else {
          // Non-TTY or --yes: retarget automatically (the alternative is a broken task)
          shouldRetarget = true;
          if (!isTTY()) {
            console.log(`Automatically retargeting to ${orphanStatus.retargetBranch} (non-interactive mode).`);
          }
        }

        if (!shouldRetarget) {
          console.error('Cannot start without retargeting. The parent branch no longer exists.');
          process.exit(1);
        }

        await retargetOrphanedChild(t, storage, orphanStatus.retargetBranch);
        console.log(theme.success(`Retargeted to ${orphanStatus.retargetBranch}.\n`));

        // Refresh task reference — parent_task_id is now null
        t = (await storage.getTask(t.id))!;
      }
    }

    // Warn if task has no parent and there are active tasks on other branches
    if (!t.parent_task_id) {
      const allTasks = await storage.listTasks();
      const activeTasks = allTasks.filter(task => {
        const status = task.status;
        return status === 'working' || status === 'interrupted' || status === 'pairing' || status === 'merging';
      });

      if (activeTasks.length > 0 && !yes) {
        const defaultBranch = getRemoteDefaultBranch(root);
        console.log(theme.warning(`\nTask '${displayId(t)}' has no parent and will branch from ${defaultBranch}.`));
        console.log(`There are ${activeTasks.length} active task(s) on other branches:`);
        for (const activeTask of activeTasks.slice(0, 5)) {
          console.log(`  - ${displayId(activeTask)}: ${activeTask.goal}`);
        }
        if (activeTasks.length > 5) {
          console.log(`  ... and ${activeTasks.length - 5} more`);
        }
        console.log('');

        if (isTTY()) {
          const confirmed = await promptYesNo('Continue?', true);
          if (!confirmed) {
            console.log('Task not started. To make this a child task, use: lazy create --parent <parent_task_id>');
            process.exit(0);
          }
        }
      }
    }

    // Show task details and ask for confirmation unless --yes was provided
    // When no TTY is available, auto-proceed — starting an existing task is
    // non-destructive and all required info (goal, prompt) is already present.
    if (!yes && isTTY()) {
      console.log(`\nTask: ${displayId(t)}`);
      console.log(`Goal: ${t.goal}`);
      console.log(`\nPrompt:`);
      console.log(formatMarkdown(t.prompt).join('\n'));
      console.log('');

      const confirmed = await promptYesNo('Start this task?', false);
      if (!confirmed) {
        console.log(`Task not started. Edit the prompt with: lazy edit ${displayId(t)}`);
        process.exit(0);
      }
    }

    // --- Pre-flight checks (before creating container/worktree) ---
    const dockerOptions: Partial<DockerRunnerOptions> = {};
    if (dockerAgentNoNetwork) dockerOptions.dockerAgentNoNetwork = true;
    const runner = createRunner(root, dockerOptions);
    try {
      runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Validate that the runner supports the task's agent.
    // Currently only claude-code supports Docker/Podman runners.
    if (t.agent_id !== 'claude-code' && runner.type !== 'dangerously-host-process-without-any-isolation') {
      console.error(`Agent "${t.agent_id}" only supports host-process runner. Set runner type to "dangerously-host-process-without-any-isolation" in lazy.toml.`);
      process.exit(1);
    }

    // Load config and create driver early — we need it for resolveUpstreamRef
    // before creating the worktree.
    const config = loadConfig(root);
    const driver = createDriver(config);

    // Check if session already exists (1:1 enforcement)
    // Linked tasks (created via `lazy link`) already have a session and worktree
    // from the link step — detect this and reuse them instead of blocking.
    const isLinkedTask = !!t.metadata?.import_source_url;
    const existingSession = await storage.getSessionByTaskId(t.id);
    if (existingSession && !isLinkedTask) {
      if (!existingSession.ended_at) {
        console.error(`Task ${displayId(t)} already has an active session.`);
        console.error(`Unblock it with: lazy unblock ${displayId(t)}`);
        process.exit(1);
      } else {
        console.error(`Task ${displayId(t)} session has ended (${existingSession.outcome}).`);
        console.error(`Create a variant with: lazy branch ${displayId(t)}`);
        process.exit(1);
      }
    }

    // Derive and store a human-readable task ref if not already set.
    // New tasks get this at creation; existing tasks created before this feature
    // fall back to shortId(task.id) via taskRef().
    if (!t.metadata?.task_ref) {
      const allTasks = await storage.listTasks();
      const ref = deriveTaskRef(t, allTasks);
      await storage.updateTaskMetadata(t.id, 'task_ref', ref);
      if (!t.metadata) t.metadata = {};
      t.metadata.task_ref = ref;
    }

    // For linked tasks, use the existing session's branch; otherwise create lazy/<ref>
    const taskShortId = shortId(t.id);
    const tRef = taskRef(t);
    const branchName = isLinkedTask && existingSession
      ? existingSession.git_branch
      : `lazy/${tRef}`;

    // Determine parent branch and starting point for the worktree.
    // For remote drivers, this fetches the latest state before branching.
    let startSha: string;
    let parentBranch: string | null = null;

    if (isLinkedTask && existingSession) {
      startSha = existingSession.git_start_sha;
      parentBranch = t.metadata?.parent_branch ?? getRemoteDefaultBranch(root, config.remote.git_remote);
    } else if (t.parent_task_id) {
      // Child task: branch from parent's branch HEAD (fetched from remote).
      // Parent worktree existence already verified in pre-flight check above.
      const parentTask = (await storage.getTask(t.parent_task_id))!;
      const parentWorktreePath = getWorktreePath(root, parentTask);
      parentBranch = await getBranchNameFromId(t.parent_task_id, storage);

      try {
        // Fetch the parent's branch from remote to get the latest state.
        // If sibling tasks were accepted into the parent's branch on remote,
        // we want to start from that updated state, not the local worktree HEAD.
        const parentRef = await driver.resolveUpstreamRef(parentBranch, root);

        // Get the SHA of the resolved ref
        const resolveResult = runGit(['rev-parse', parentRef], { cwd: root });
        if (resolveResult.exitCode === 0) {
          startSha = resolveResult.stdout;
          logger.debug(`Resolved parent ${parentBranch} to ${parentRef} (${startSha.slice(0, 8)})`);
        } else {
          // Failed to resolve ref — this should not happen if resolveUpstreamRef succeeded
          console.error(`Failed to resolve ${parentRef} after successful fetch`);
          if (forceLocal) {
            logger.warn('--force-local specified, using parent worktree HEAD');
            startSha = getCurrentSha(parentWorktreePath);
          } else {
            console.error(`Run 'git fetch' to verify remote state, or use --force-local to start from local HEAD anyway.`);
            process.exit(1);
          }
        }
      } catch (err) {
        // Fetch failed. The parent's branch might not exist on remote yet (local-only workflow),
        // or there may be a network error.
        console.error(`Failed to fetch parent branch ${parentBranch} from remote: ${err instanceof Error ? err.message : err}`);
        console.error('Cannot start child task — the parent branch may have been updated on remote.');
        if (forceLocal) {
          logger.warn('--force-local specified, using parent worktree HEAD (may be stale)');
          startSha = getCurrentSha(parentWorktreePath);
        } else {
          console.error(`Run 'git fetch' to update your local state, or use --force-local to start from local HEAD anyway.`);
          process.exit(1);
        }
      }

      // Persist the SHA for future reference
      await storage.updateTaskBranchedFromSha(t.id, startSha);
      t.branched_from_sha = startSha;
    } else {
      // Non-child, non-linked task: branch from the remote's default branch.
      // This ensures we always branch from the correct base (e.g., main) regardless
      // of what branch is currently checked out in the main repo (which may be
      // arbitrary when worktrees are in use).
      parentBranch = getRemoteDefaultBranch(root, config.remote.git_remote);

      try {
        // Fetch the parent branch and get its up-to-date ref.
        // For remote drivers: fetches origin/<branch> and returns "origin/<branch>".
        // For local driver: returns the branch name as-is.
        const parentRef = await driver.resolveUpstreamRef(parentBranch, root);

        // Get the SHA of the resolved ref
        const resolveResult = runGit(['rev-parse', parentRef], { cwd: root });
        if (resolveResult.exitCode === 0) {
          startSha = resolveResult.stdout;
          logger.debug(`Resolved ${parentBranch} to ${parentRef} (${startSha.slice(0, 8)})`);
        } else {
          // Failed to resolve ref — this should not happen if resolveUpstreamRef succeeded
          console.error(`Failed to resolve ${parentRef} after successful fetch`);
          console.error('This is unexpected. The remote ref may have been deleted immediately after fetch.');
          if (forceLocal) {
            logger.warn('--force-local specified, using local HEAD');
            startSha = getCurrentSha(root);
          } else {
            console.error(`Run 'git fetch' to verify remote state, or use --force-local to start from local HEAD anyway.`);
            process.exit(1);
          }
        }
      } catch (err) {
        // Fetch failed (network error, etc.)
        console.error(`Failed to fetch ${parentBranch} from remote: ${err instanceof Error ? err.message : err}`);
        console.error('Cannot start task — the remote branch may have moved forward since your last fetch.');
        if (forceLocal) {
          logger.warn('--force-local specified, using local HEAD (may be stale)');
          startSha = getCurrentSha(root);
        } else {
          console.error(`Run 'git fetch' to update your local state, or use --force-local to start from local HEAD anyway.`);
          process.exit(1);
        }
      }
    }

    // Determine worktree path
    const worktreeBase = join(root, getDataDir(root), 'worktrees');
    const worktreePath = getWorktreePathForRef(root, tRef);

    mkdirSync(worktreeBase, { recursive: true });

    // Refuse if task is in pairing state — task is locked
    if (t.status === 'pairing') {
      console.error(`Task ${displayId(t)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }

    // Check for pairing lock — refuse if someone is pairing on this task
    if (existsSync(worktreePath)) {
      rejectIfPairing(root, tRef, displayId(t));
    }

    // Check for concurrent session lock
    if (existsSync(worktreePath)) {
      const existingLock = checkLock(worktreePath);
      if (existingLock) {
        console.error(`Task ${taskShortId} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
        console.error(`Started at: ${existingLock.started_at}`);
        console.error('Wait for the other process to finish, or kill it (kill ' + existingLock.pid + ') to release the lock.');
        process.exit(1);
      }
    }

    let worktreeExisted = existsSync(worktreePath);
    if (worktreeExisted) {
      console.log(`Reusing existing worktree: ${branchName}`);
    } else if (isLinkedTask || existingSession) {
      // Worktree is missing but the task has a session (linked or previously started).
      // Try to recover from the existing branch.
      try {
        const recovery = recoverMissingWorktree(worktreePath, branchName, root);
        if (recovery.recovered) {
          console.log(`Worktree was missing, recreated from branch '${branchName}'.`);
          if (recovery.dirty) {
            console.log('Note: Working tree has uncommitted changes.');
          }
          worktreeExisted = true;
        } else {
          console.error(`Branch '${branchName}' no longer exists. Cannot recover worktree.`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    } else {
      console.log(`Creating worktree: ${branchName}`);
      // Create worktree from the resolved start SHA (which may be from remote-tracking ref)
      createWorktreeFromSha(worktreePath, branchName, startSha, root);
    }

    // Make an empty initial commit on newly created branches to prevent GitHub PR auto-close.
    // When a branch is identical to its base (no divergence), GitHub auto-closes the PR.
    // This can happen during parent/child merges, spike tasks, or upstream syncs.
    // The empty commit ensures the branch always has at least one unique commit.
    // Skip for linked tasks — they already have existing work.
    if (!worktreeExisted && !isLinkedTask) {
      const taskCode = t.code ?? shortId(t.id);
      const commitMessage = `Initialize task ${taskCode}: ${t.goal}`;
      const commitResult = runGit(
        ['commit', '--allow-empty', '-m', commitMessage],
        { cwd: worktreePath },
      );
      if (commitResult.exitCode !== 0) {
        // Non-fatal: warn but continue. The task can still work without this commit,
        // though it may be subject to GitHub PR auto-close in edge cases.
        logger.warn(`Failed to create initial empty commit: ${commitResult.stderr}`);
      }
    }

    // Copy untracked files configured in worktree.include
    if (!worktreeExisted) {
      const config = loadConfig(root);
      copyUntrackedFilesIntoWorktree(root, worktreePath, config.worktree.include);
    }

    // Acquire lock
    acquireLock(worktreePath, 'lazy start');

    const containerName = runner.runNameForTask(tRef);

    try {
      const sandbox = setupSandbox(worktreePath);

      // Determine model to use: CLI flag > task.model > config default
      const modelName: ModelName = modelOverride ?? t.model ?? config.models.default;
      const modelId = getModelId(modelName);

      // Persist the resolved model on the task so `lazy list` shows the actual model used
      if (!t.model) {
        await storage.updateTaskModel(t.id, modelName);
        t.model = modelName;
      }

      // Fetch any comments added to the task before the first turn
      const existingComments = await storage.getTaskComments(t.id);
      const notesCtx = existingComments.length > 0 ? buildNotesContext(existingComments) : undefined;

      // For linked tasks, build a situational awareness preamble that
      // describes the existing branch state (commits, diff, status).
      let turnPrompt = t.prompt;
      if (isLinkedTask) {
        const linkedParentBranch = t.metadata?.parent_branch ?? getRemoteDefaultBranch(root, config.remote.git_remote);
        const preamble = buildLinkedTaskPreamble(worktreePath, branchName, linkedParentBranch);
        turnPrompt = preamble + '\n---\n\n' + t.prompt;
      }

      // Build the prompts: static system prompt and dynamic user prompt
      const systemPrompt = buildSystemPrompt(runner.getAgentInstructions());
      const fullPrompt = buildPromptWithInstructions(turnPrompt, t.goal, true, root, notesCtx);

      // --- Persist state BEFORE launching container ---

      // For linked tasks, reuse the existing session; otherwise create a new one.
      let sess;
      if (isLinkedTask && existingSession) {
        sess = existingSession;
      } else {
        // Create session record (no Claude session_id yet — reconciliation will capture it)
        sess = await storage.createSession(t.id, t.agent_id, branchName, startSha);
      }

      // Record human turn immediately (crash-safe: turn is persisted before container runs)
      await storage.createTurn({
        sessionId: sess.id,
        sequence: 1,
        role: 'human',
        content: turnPrompt,
        model: modelName,
        prompt: fullPrompt,
        actor: getActor(),
      });

      // Transition task to working
      await storage.updateTaskStatus(t.id, 'working', getActor());

      // Publish branch to remote (push + create draft PR if GitHub driver).
      // Skip for linked tasks — the user manages their own branch and PR.
      if (!isLinkedTask) {
        // Always store remote_target_branch so all drivers (including local)
        // record the branch this task was forked from. The GitHub driver may
        // overwrite this via publishResult.metadata — that's fine.
        // Note: parentBranch was already determined when creating the worktree.
        const mergeTarget = parentBranch ?? getRemoteDefaultBranch(root, config.remote.git_remote);
        await storage.updateTaskMetadata(t.id, 'remote_target_branch', mergeTarget);

        // createDriver() is NOT wrapped — invalid config is a hard failure.
        // Only publishBranch() itself is best-effort (network issues, etc.).
        try {
          const publishResult = await driver.publishBranch({
            branch: branchName,
            targetBranch: mergeTarget,
            task: t,
          });
          // Store any metadata the driver returned (e.g., PR URL/number).
          // If the driver returns remote_target_branch, it overwrites our baseline.
          if (publishResult.metadata) {
            for (const [key, value] of Object.entries(publishResult.metadata)) {
              await storage.updateTaskMetadata(t.id, key, value);
            }
          }
        } catch (err) {
          // Publish failure should not block task start — the branch will be
          // pushed again after agent turns if auto_push is enabled
          logger.warn(`Failed to publish branch (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }

      // --- Write command and launch supervisor ---

      // Set up protocol directory
      const protoDir = getProtocolDir(t.id);
      ensureProtocolDir(protoDir);

      // Resolve upstream ref through the driver so the supervisor merges
      // origin/<branch> (fresh remote state) instead of a stale local branch.
      // Non-fatal: falls back to the local branch name on network failure.
      // Note: parentBranch was already determined earlier when creating the worktree.
      if (parentBranch) {
        try {
          parentBranch = await driver.resolveUpstreamRef(parentBranch, worktreePath);
        } catch {
          // Resolution failed — use the local branch name
        }
      }

      // Reload config from the worktree — the branch may have settings (e.g., permissions)
      // that aren't on the project root's lazy.toml yet. The early loadConfig(root) above
      // was needed for pre-worktree operations (driver, session checks).
      const branchConfig = loadConfig(root, { cwd: worktreePath });
      const autoSyncAfterTurn = isFeatureEnabled('auto_sync_after_turn', branchConfig);

      // Write the start command for the supervisor
      const startCommand: StartCommand = {
        type: 'start',
        task_id: t.id,
        goal: t.goal,
        prompt: fullPrompt,
        agent_id: t.agent_id,
        system_prompt: systemPrompt,
        model_id: modelId,
        parent_branch: parentBranch ?? undefined,
        sync_before_work: false,  // start creates branch from HEAD — already fresh
        sync_after_work: autoSyncAfterTurn,
        ...commonCommandFields(branchConfig),
      };
      writeCommand(protoDir, startCommand);

      // Check if a run for this task is already active
      if (runner.isRunning(containerName)) {
        // Supervisor is already running — it will pick up the new command
        console.log(`Supervisor ${containerName} is already running. Command written.`);
      } else {
        // Remove any stale stopped run with the same name
        runner.removeRun(containerName);

        try {
          await runner.launchSupervisor(sandbox, containerName, protoDir, false);
        } catch (err) {
          console.error(`Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
          // Revert task status
          await storage.updateTaskStatus(t.id, 'interrupted', getActor());
          if (!worktreeExisted) {
            console.log('Cleaning up worktree...');
            const { removeWorktree } = await import('../../git/operations');
            try {
              removeWorktree(worktreePath, root);
            } catch {
              // Best-effort cleanup
            }
          }
          process.exit(1);
        }
      }

      // Store container name in session for reconciliation
      await storage.updateSessionContainerName(sess.id, containerName);

      // Update last interaction timestamp so duration tracking starts from now
      await storage.updateSessionInteraction(sess.id, 0);

      // Print summary — task is now running asynchronously
      console.log(theme.success(`\nStarted task ${displayId(t)}`));
      console.log(`  ${theme.label('Goal:')}      ${t.goal}`);
      console.log(`  ${theme.label('Branch:')}    ${branchName}`);
      console.log(`  ${theme.label('Worktree:')}  ${worktreePath}`);
      console.log(`  ${theme.label('Runner:')}    ${containerName}`);
      if (t.parent_task_id) {
        console.log(`  ${theme.label('Parent:')}    ${theme.taskId(await displayIdFor(storage, t.parent_task_id))}`);
      }

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: ${theme.command('lazy blocked')}`);
        console.log(`Or check status with: ${theme.command('lazy status ' + displayId(t))}`);
      }
    } finally {
      removeLock(worktreePath);
    }

    // Follow container output after releasing the worktree lock (but before closing storage).
    // followContainer will re-acquire the worktree lock around reconciliation.
    if (follow) {
      const protoDir2 = getProtocolDir(t.id);
      const exitCode = await followContainer(containerName, storage, root, worktreePath, protoDir2);
      await storage.close();
      process.exit(exitCode);
    }
  } finally {
    await storage.close();
  }
}

export function startUsage(): void {
  console.log(`Usage: lazy start <task_id> [--model <model>] [--agent <agent_id>] [--follow] [--yes] [--force-local]

Start an existing task. Creates a worktree, launches a supervisor container, and writes a start command.
The supervisor manages the agent lifecycle (sync-with-upstream, work phases).

To create a new task, use 'lazy create' first, then start it with this command.

Use 'lazy blocked' to check when the agent finishes and needs your input.
Use 'lazy status <task_id>' to check the current state.

Arguments:
  <task_id>          ID of the task to start (short hex prefix or task code)

Options:
  --model <model>    Override model for this session (apprentice, journeyman, master, sonnet, opus, haiku)
  --agent <agent_id> Agent to use for this task (default: from task or lazy.toml)
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompts
  --docker-agent-no-network  Disable network access in container (overrides lazy.toml runner.docker_agent_no_network)
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Model Selection:
  Models are selected in this priority order:
  1. --model flag (session override)
  2. Task's model setting (if set during task creation)
  3. lazy.toml default model
  4. Built-in default (sonnet)

Notes:
  - Each task can only have one session (1:1 relationship)
  - If the task already has a session, use 'lazy unblock' instead
  - Tasks automatically fetch the latest remote state before creating worktrees.
    If the remote fetch fails, 'lazy start' will abort unless --force-local is used.
  - For child tasks, the worktree starts from the parent's branch HEAD (fetched from remote)
  - The human turn is recorded before the container launches, so it's
    crash-safe — if the process dies, the turn is preserved

Examples:
  lazy create --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy start abc12345                       # Start the created task
  lazy start abc12345 --yes                 # Start without confirmation
  lazy start abc1 --model haiku             # Start with model override
  lazy start abc1 --follow                  # Wait for completion`);
}
