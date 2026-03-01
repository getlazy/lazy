import { join } from 'path';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync } from 'fs';
import { homedir } from 'os';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, validateCode, resolveTaskOrExit, rejectIfPairing, taskRef, deriveTaskRef, getWorktreePath, getWorktreePathForRef, getBranchNameFromId } from '../helpers';
import { getCurrentSha, getCurrentBranch, createWorktree, createWorktreeFromSha, recoverMissingWorktree } from '../../git/operations';
import { getAuthEnv, getModelId } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import { createDriver } from '../../remote';
import { checkLock, acquireLock, removeLock } from '../../utils/lock';
import { openEditor, promptLine, removeRecoveryFile, promptYesNo, isTTY, readStdinIfPiped } from '../editor';
import { followContainer, buildNotesContext, buildUpstreamMergeContext, buildSystemPrompt } from './shared';
import { checkOrphanedChild, retargetOrphanedChild } from '../orphan';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir } from '../../protocol';
import type { StartCommand } from '../../protocol';
import type { SandboxConfig } from '../../capture/claude';
import type { ModelName, TaskType } from '../../types';
import { VALID_TASK_TYPES } from '../../types';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { isFeatureEnabled } from '../../utils/features';
import { logger } from '../../utils/logger';
import { getActor } from '../../constants';

import goalContextStartText from '../../prompts/goal-context-start.md' with { type: 'text' };
import goalContextContinueText from '../../prompts/goal-context-continue.md' with { type: 'text' };

const SANDBOX_DIR = '.lazy-task-sandbox';
const DEFAULT_AGENT = 'claude-code';

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
  const countResult = Bun.spawnSync(
    ['git', 'rev-list', '--left-right', '--count', `${parentBranch}...${branchName}`],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  if (countResult.exitCode === 0) {
    const parts = countResult.stdout.toString().trim().split(/\s+/);
    const behind = parseInt(parts[0], 10) || 0;
    const ahead = parseInt(parts[1], 10) || 0;
    lines.push(`Branch status: ${ahead} commit(s) ahead, ${behind} commit(s) behind ${parentBranch}.`);
    lines.push('');
  }

  // Commit log since fork
  const logResult = Bun.spawnSync(
    ['git', 'log', '--no-color', '--oneline', `${parentBranch}..${branchName}`],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  if (logResult.exitCode === 0 && logResult.stdout.toString().trim()) {
    lines.push('Existing commits on this branch:');
    lines.push(logResult.stdout.toString().trim());
    lines.push('');
  }

  // Working tree status
  const statusResult = Bun.spawnSync(
    ['git', 'status', '--short'],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  if (statusResult.exitCode === 0) {
    const status = statusResult.stdout.toString().trim();
    if (status) {
      lines.push('Working tree has uncommitted changes:');
      lines.push(status);
    } else {
      lines.push('Working tree is clean.');
    }
    lines.push('');
  }

  // Diff stat from parent branch
  const diffStatResult = Bun.spawnSync(
    ['git', 'diff', '--no-color', '--stat', `${parentBranch}...${branchName}`],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  if (diffStatResult.exitCode === 0 && diffStatResult.stdout.toString().trim()) {
    lines.push(`Diff from ${parentBranch}:`);
    lines.push(diffStatResult.stdout.toString().trim());
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
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'type', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
    { name: 'follow', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'force-local', takesValue: false },
  ], 'start');

  const goalFlag = parsed.flags.get('goal') as string | undefined;
  const promptFlag = parsed.flags.get('prompt') as string | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  const typeValue = parsed.flags.get('type') as string | undefined;
  const codeFlag = parsed.flags.get('code') as string | undefined;
  const parentFlag = parsed.flags.get('parent') as string | undefined;
  const follow = parsed.flags.get('follow') === true;
  const yes = parsed.flags.get('yes') === true;
  const forceLocal = parsed.flags.get('force-local') === true;

  // Determine model override
  let modelOverride: ModelName | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Validate type if provided
  let taskType: TaskType | undefined;
  if (typeValue !== undefined) {
    if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
      console.error(`Invalid type '${typeValue}'. Must be one of: ${VALID_TASK_TYPES.join(', ')}`);
      process.exit(1);
    }
    taskType = typeValue as TaskType;
  }

  // Validate code if provided
  let codeValue: string | undefined;
  if (codeFlag !== undefined) {
    const codeError = validateCode(codeFlag);
    if (codeError) {
      console.error(`Invalid code: ${codeError}`);
      process.exit(1);
    }
    codeValue = codeFlag;
  }

  // Determine if we're creating a new task or starting an existing one
  // If --goal is provided, we're creating a new task
  // Otherwise, the first positional arg is a task ID
  let taskId: string | undefined;
  if (!goalFlag) {
    // No --goal: use first positional arg as task ID
    taskId = parsed.positional[0];
  }

  // Validate --parent flag: can only be used with inline task creation (--goal)
  if (parentFlag && taskId) {
    console.error('Error: --parent flag can only be used with --goal (inline task creation), not with an existing task ID');
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  // Validate and resolve parent task if --parent is provided
  let parentTaskId: string | undefined;
  if (parentFlag) {
    const parentTask = await storage.getTask(parentFlag);
    if (!parentTask) {
      console.error(`Parent task not found: ${parentFlag}`);
      await storage.close();
      process.exit(1);
    }

    // Verify parent is not in a terminal state
    if (parentTask.status === 'abandoned' || parentTask.status === 'closed' || parentTask.status === 'complete') {
      console.error(`Cannot create child of ${parentTask.status} task ${displayId(parentTask)}`);
      await storage.close();
      process.exit(1);
    }

    // Verify parent worktree exists
    const parentWorktreePath = getWorktreePath(root, parentTask);
    if (!existsSync(parentWorktreePath)) {
      console.error(`Cannot create child task: parent task has no worktree.`);
      console.error(`Start the parent first with: lazy start ${displayId(parentTask)}`);
      await storage.close();
      process.exit(1);
    }

    parentTaskId = parentTask.id;
  }

  try {
    let t;

    if (taskId) {
      // Starting an existing task (e.g., from `lazy branch`)
      t = await resolveTaskOrExit(storage, taskId);
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

      // Show task details and ask for confirmation unless --yes was provided
      // When no TTY is available, auto-proceed — starting an existing task is
      // non-destructive and all required info (goal, prompt) is already present.
      if (!yes && isTTY()) {
        console.log(`\nTask: ${displayId(t)}`);
        console.log(`Goal: ${t.goal}`);
        console.log(`\nPrompt:\n${t.prompt}\n`);

        const confirmed = await promptYesNo('Start this task?', false);
        if (!confirmed) {
          console.log(`Task not started. Edit the prompt with: lazy edit ${displayId(t)}`);
          process.exit(0);
        }
      }
    } else {
      // Creating a new task inline
      let goal: string;
      let prompt: string | null = null;
      let startPromptRecoveryPath: string | null = null;

      if (goalFlag) {
        goal = goalFlag;
        if (promptFlag !== undefined) {
          prompt = promptFlag;
        } else {
          // Try piped stdin as prompt
          const stdinContent = await readStdinIfPiped();
          if (stdinContent !== null) {
            prompt = stdinContent;
          }
        }
      } else {
        // Interactive mode
        if (!process.stdin.isTTY) {
          console.error('Interactive mode requires a TTY. Use --goal and --prompt flags instead.');
          process.exit(1);
        }

        const goalInput = await promptLine('Task goal');
        if (!goalInput.trim()) {
          console.error('Goal cannot be empty');
          process.exit(1);
        }
        goal = goalInput;

        // Open editor for prompt
        console.log('\nOpening editor for prompt (close without saving to skip)...');
        const editResult = await openEditor('', `start-prompt`);
        if (editResult !== null && editResult.content.trim()) {
          prompt = editResult.content.trim();
          startPromptRecoveryPath = editResult.recoveryPath;
        } else if (editResult !== null && editResult.recoveryPath) {
          // Empty prompt — clean up recovery file
          removeRecoveryFile(editResult.recoveryPath);
        }
      }

      if (!prompt) {
        // Prompt is required to start work
        if (startPromptRecoveryPath) removeRecoveryFile(startPromptRecoveryPath);
        console.error('Prompt is required. Provide it with --prompt or via the editor.');
        process.exit(1);
      }

      // Create the task (with optional parent)
      t = await storage.createTask(goal, parentTaskId, undefined, codeValue, taskType);

      // Set prompt
      await storage.updateTaskPrompt(t.id, prompt);
      // Prompt is now durably persisted — clean up recovery file
      if (startPromptRecoveryPath) removeRecoveryFile(startPromptRecoveryPath);
      t.prompt = prompt;

      // Set model if provided
      if (modelOverride) {
        await storage.updateTaskModel(t.id, modelOverride);
        t.model = modelOverride;
      }

      console.log(`Created task ${theme.taskId(displayId(t))}`);
      console.log(`  ${theme.label('Goal:')} ${t.goal}`);
    }

    // --- Pre-flight checks (before creating container/worktree) ---
    const runner = createRunner(root);
    try {
      runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // For new tasks (not starting an existing one), verify we can get a git SHA
    // before creating any task state. This prevents orphaned tasks when the repo
    // has no commits.
    let preflightSha: string | undefined;
    if (!taskId) {
      try {
        preflightSha = getCurrentSha(root);
      } catch {
        console.error('Cannot determine git HEAD. The repository must have at least one commit.');
        console.error('Run: git commit --allow-empty -m "Initial commit"');
        process.exit(1);
      }
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
      parentBranch = t.metadata?.parent_branch ?? getCurrentBranch(root);
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
        const resolveResult = Bun.spawnSync(['git', 'rev-parse', parentRef], { cwd: root });
        if (resolveResult.exitCode === 0) {
          startSha = resolveResult.stdout.toString().trim();
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
      // Non-child, non-linked task: branch from parent branch (usually main).
      // Use the driver to fetch the latest state before branching.
      parentBranch = getCurrentBranch(root);

      try {
        // Fetch the parent branch and get its up-to-date ref.
        // For remote drivers: fetches origin/<branch> and returns "origin/<branch>".
        // For local driver: returns the branch name as-is.
        const parentRef = await driver.resolveUpstreamRef(parentBranch, root);

        // Get the SHA of the resolved ref
        const resolveResult = Bun.spawnSync(['git', 'rev-parse', parentRef], { cwd: root });
        if (resolveResult.exitCode === 0) {
          startSha = resolveResult.stdout.toString().trim();
          logger.debug(`Resolved ${parentBranch} to ${parentRef} (${startSha.slice(0, 8)})`);
        } else {
          // Failed to resolve ref — this should not happen if resolveUpstreamRef succeeded
          console.error(`Failed to resolve ${parentRef} after successful fetch`);
          console.error('This is unexpected. The remote ref may have been deleted immediately after fetch.');
          if (forceLocal) {
            logger.warn('--force-local specified, using local HEAD');
            startSha = preflightSha ?? getCurrentSha(root);
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
          startSha = preflightSha ?? getCurrentSha(root);
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
      const commitResult = Bun.spawnSync(
        ['git', 'commit', '--allow-empty', '-m', commitMessage],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
      );
      if (commitResult.exitCode !== 0) {
        // Non-fatal: warn but continue. The task can still work without this commit,
        // though it may be subject to GitHub PR auto-close in edge cases.
        logger.warn(`Failed to create initial empty commit: ${commitResult.stderr.toString()}`);
      }
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
        const linkedParentBranch = t.metadata?.parent_branch ?? getCurrentBranch(root);
        const preamble = buildLinkedTaskPreamble(worktreePath, branchName, linkedParentBranch);
        turnPrompt = preamble + '\n---\n\n' + t.prompt;
      }

      // Build the prompts: static system prompt and dynamic user prompt
      const systemPrompt = buildSystemPrompt();
      const fullPrompt = buildPromptWithInstructions(turnPrompt, t.goal, true, root, notesCtx);

      // --- Persist state BEFORE launching container ---

      // For linked tasks, reuse the existing session; otherwise create a new one.
      let sess;
      if (isLinkedTask && existingSession) {
        sess = existingSession;
      } else {
        // Create session record (no Claude session_id yet — reconciliation will capture it)
        sess = await storage.createSession(t.id, DEFAULT_AGENT, branchName, startSha);
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
        const mergeTarget = parentBranch ?? getCurrentBranch(root);
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

      const autoSyncAfterTurn = isFeatureEnabled('auto_sync_after_turn', config);

      // Build upstream context for merge conflict resolution (best-effort).
      // Done on host side where storage is available for task goal lookups.
      let upstreamMergeContext: string | undefined;
      if (parentBranch) {
        const ctx = await buildUpstreamMergeContext(parentBranch, worktreePath, storage);
        if (ctx) upstreamMergeContext = ctx;
      }

      // Write the start command for the supervisor
      const startCommand: StartCommand = {
        type: 'start',
        task_id: t.id,
        goal: t.goal,
        prompt: fullPrompt,
        system_prompt: systemPrompt,
        model_id: modelId,
        parent_branch: parentBranch ?? undefined,
        sync_before_work: false,  // start creates branch from HEAD — already fresh
        sync_after_work: autoSyncAfterTurn,
        upstream_merge_context: upstreamMergeContext,
        turn_started_at: new Date().toISOString(),
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
  console.log(`Usage: lazy start [--goal <goal>] [--prompt <text>] [--parent <task_id>] [--model <model>] [--type <type>] [--code <code>] [--follow] [--yes] [--force-local]
       lazy start <task_id> [--model <model>] [--follow] [--yes] [--force-local]

Create and start a new task, or start an existing task (e.g., from 'lazy branch').

Creates a worktree, launches a supervisor container, and writes a start command.
The supervisor manages the agent lifecycle (sync-with-upstream, work phases).

Use 'lazy blocked' to check when the agent finishes and needs your input.
Use 'lazy status <task_id>' to check the current state.

Options:
  --goal <goal>      Task goal (required for new tasks)
  --prompt <text>    Task prompt/specification (required for new tasks)
  --parent <task_id> Create as a child task of the specified parent (parent must have worktree)
  --model <model>    Override model for this session (sonnet, opus, haiku)
  --type <type>      Set task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release)
                     Default: task
  --code <code>      Set a human-readable code for the task
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompt when starting an existing task
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Arguments:
  <task_id>          ID of an existing task to start (e.g., from 'lazy branch')

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

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy start --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy start --goal "Refactor" --prompt "..." --model opus
  lazy start --goal "Try Redis" --prompt "..." --parent abc123  # Child task
  lazy start                                # Interactive mode
  lazy start abc12345                       # Start existing task (shows prompt for review)
  lazy start abc12345 --yes                 # Start without confirmation
  lazy start abc1 --model haiku             # Start with model override
  lazy start --goal "Fix bug" --prompt "..." --follow  # Wait for completion
  echo "Detailed prompt" | lazy start --goal "Fix bug"  # Piped stdin as prompt`);
}
