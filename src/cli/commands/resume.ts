import { join } from 'path';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { homedir } from 'os';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, resolveTaskOrExit, rejectIfPairing, taskRef, getWorktreePathForRef } from '../helpers';
import { getAuthEnv, getModelId } from '../../capture/claude';
import { recoverMissingWorktree } from '../../git/operations';
import { loadConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import { checkLock, acquireLock, removeLock } from '../../utils/lock';
import { followContainer } from './shared';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir } from '../../protocol';
import type { UnblockCommand } from '../../protocol';
import type { SandboxConfig } from '../../capture/claude';
import type { ModelName } from '../../types';
import { getActor } from '../../constants';

import { getDataDir } from '../init';

import lazyToolInstructions from '../../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../../prompts/goal-context-resume.md' with { type: 'text' };

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Search the sandbox .claude directory for a Claude session ID.
 * Claude Code stores session data in ~/.claude/projects/<hash>/ as JSON files.
 * Returns the most recent session ID found, or null if none.
 */
function findClaudeSessionId(sandboxPath: string): string | null {
  const claudeDir = join(sandboxPath, '.claude');
  if (!existsSync(claudeDir)) return null;

  try {
    // Look for projects directory where Claude stores sessions
    const projectsDir = join(claudeDir, 'projects');
    if (!existsSync(projectsDir)) return null;

    // Search recursively for JSON files that might contain session data
    const projectDirs = readdirSync(projectsDir).filter(d => {
      try {
        return readdirSync(join(projectsDir, d)).length > 0;
      } catch { return false; }
    });

    for (const projDir of projectDirs) {
      const projPath = join(projectsDir, projDir);
      const files = readdirSync(projPath).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const content = readFileSync(join(projPath, file), 'utf-8');
          const data = JSON.parse(content);
          // Claude Code session files contain a sessionId or session_id field
          if (data.sessionId) return data.sessionId;
          if (data.session_id) return data.session_id;
          if (data.id && typeof data.id === 'string') return data.id;
        } catch {
          // Skip files that can't be parsed
        }
      }
    }
  } catch {
    // Ignore errors searching
  }

  return null;
}

/**
 * Build the static system prompt for task resume (after interruption).
 * Uses resume-specific system instructions which may differ from normal operations.
 */
export function buildSystemPromptForResume(): string {
  return lazyToolInstructions + '\n' + systemInstructionsResumeText;
}

/**
 * Build the dynamic user prompt for resuming after interruption.
 * Does NOT include tool/system instructions (those go in the system prompt).
 */
export function buildResumePrompt(goal: string, lazyRoot: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = resumeContextText + '\n';
  return goalContext + resumeContext;
}

export async function commandResume(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'follow', takesValue: false },
    { name: 'model', takesValue: true },
  ], 'resume');

  const taskId = parsed.positional[0];
  if (!taskId) {
    resumeUsage();
    process.exit(1);
  }

  // Parse flags
  const follow = parsed.flags.get('follow') === true;

  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: ModelName | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Verify task is in interrupted state
    if (task.status !== 'interrupted') {
      console.error(`Task ${displayId(task)} is not interrupted (status: ${task.status}).`);
      if (task.status === 'blocked') {
        console.error(`Use 'lazy unblock ${displayId(task)}' to continue.`);
      } else if (task.status === 'working') {
        console.error(`Task is still working. Use 'lazy blocked' to check when it finishes.`);
      }
      process.exit(1);
    }

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session.`);
      process.exit(1);
    }
    if (sess.ended_at) {
      console.error('Session has ended. Create a variant with: lazy branch ' + displayId(task));
      process.exit(1);
    }

    const tRef = taskRef(task);
    const taskShortId = shortId(task.id);

    // Check for pairing lock early — before expensive Docker/auth pre-flight checks
    // Note: pairing state is already caught by the interrupted-only check above,
    // but the file-based lock protects against race conditions.
    rejectIfPairing(root, tRef, displayId(task));

    // Pre-flight checks
    const runner = createRunner(root);
    try {
      runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const worktreePath = getWorktreePathForRef(root, tRef);

    if (!existsSync(worktreePath)) {
      // Worktree is missing — try to recover from the session's branch
      const branchName = sess.git_branch;
      try {
        const recovery = recoverMissingWorktree(worktreePath, branchName, root);
        if (recovery.recovered) {
          console.log(`Worktree was missing, recreated from branch '${branchName}'.`);
          if (recovery.dirty) {
            console.log('Note: Working tree has uncommitted changes.');
          }
        } else {
          console.error(`Branch '${branchName}' no longer exists. Cannot recover worktree.`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }

    // Check for concurrent session lock
    const existingLock = checkLock(worktreePath);
    if (existingLock) {
      console.error(`Task ${taskShortId} is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
      console.error(`Started at: ${existingLock.started_at}`);
      process.exit(1);
    }

    // Acquire lock
    acquireLock(worktreePath, 'lazy resume');

    const containerName = runner.runNameForTask(tRef);

    try {
      const config = loadConfig(root);

      // Ensure sandbox exists
      const sandboxPath = join(worktreePath, SANDBOX_DIR);
      const claudeDir = join(sandboxPath, '.claude');
      mkdirSync(claudeDir, { recursive: true });

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
        writeFileSync(sandboxGitconfig, '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n');
      }

      const sandbox: SandboxConfig = { worktreePath, sandboxPath };

      // Determine model: CLI flag > previous turn's model (sticky) > task.model > config default
      let stickyModel: ModelName | undefined;
      if (!modelOverride) {
        const existingTurns = await storage.getSessionTurns(sess.id);
        for (let i = existingTurns.length - 1; i >= 0; i--) {
          if (existingTurns[i].model) {
            stickyModel = existingTurns[i].model;
            break;
          }
        }
      }
      const modelName: ModelName = modelOverride ?? stickyModel ?? task.model ?? config.models.default;
      const modelId = getModelId(modelName);

      // Persist the resolved model on the task so `lazy list` shows the actual model used
      if (!task.model) {
        await storage.updateTaskModel(task.id, modelName);
        task.model = modelName;
      }

      // Try to find Claude session ID from sandbox or storage
      let claudeSessionId = sess.claude_session_id;
      if (!claudeSessionId) {
        claudeSessionId = findClaudeSessionId(sandboxPath);
        if (claudeSessionId) {
          console.log(`Found Claude session ID from sandbox: ${claudeSessionId.substring(0, 8)}...`);
          await storage.updateSessionClaudeId(sess.id, claudeSessionId);
        }
      }

      // Build the prompts: static system prompt and dynamic user prompt
      const systemPrompt = buildSystemPromptForResume();
      const fullPrompt = buildResumePrompt(task.goal, root);

      // --- Persist state BEFORE launching container ---

      // Record synthetic human turn for the interruption/resume, with model for sticky resolution
      const nextSeq = await storage.getNextTurnSequence(sess.id);
      await storage.createTurn({
        sessionId: sess.id,
        sequence: nextSeq,
        role: 'human',
        content: '[system] Session interrupted and resumed',
        model: modelName,
        actor: getActor(),
      });

      // Transition task to working
      await storage.updateTaskStatus(task.id, 'working', getActor());

      // --- Write command and launch/reuse supervisor ---

      // Set up protocol directory
      const protoDir = getProtocolDir(task.id);
      ensureProtocolDir(protoDir);

      // Write the unblock command (resume is semantically an unblock with resume context)
      const unblockCommand: UnblockCommand = {
        type: 'unblock',
        task_id: task.id,
        goal: task.goal,
        prompt: fullPrompt,
        system_prompt: systemPrompt,
        model_id: modelId,
        claude_session_id: claudeSessionId ?? undefined,
        turn_started_at: new Date().toISOString(),
      };
      writeCommand(protoDir, unblockCommand);

      // Check if supervisor is already running
      if (runner.isRunning(containerName)) {
        // Supervisor is still alive — it will pick up the new command
        console.log(`Supervisor ${containerName} is running. Command written.`);
      } else {
        // Remove any stale stopped run with the same name
        runner.removeRun(containerName);

        try {
          await runner.launchSupervisor(sandbox, containerName, protoDir, false);
        } catch (err) {
          console.error(`Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
          await storage.updateTaskStatus(task.id, 'interrupted', getActor());
          process.exit(1);
        }
      }

      // Store container name
      await storage.updateSessionContainerName(sess.id, containerName);

      // Manual resume resets the circuit breaker
      await storage.resetConsecutiveInterruptions(sess.id);

      // Update last interaction timestamp so duration tracking starts from now
      await storage.updateSessionInteraction(sess.id, 0);

      console.log(`\nResumed task ${taskShortId}`);
      console.log(`  Goal:      ${task.goal}`);
      console.log(`  ${runner.runLabel}: ${runner.runDisplayName(containerName)}`);

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: lazy blocked`);
        console.log(`Or check status with: lazy status ${displayId(task)}`);
      }
    } finally {
      removeLock(worktreePath);
    }

    // Follow container output after releasing the worktree lock (but before closing storage).
    // followContainer will re-acquire the worktree lock around reconciliation.
    if (follow) {
      const protoDir2 = getProtocolDir(task.id);
      const exitCode = await followContainer(containerName, storage, root, worktreePath, protoDir2);
      await storage.close();
      process.exit(exitCode);
    }
  } finally {
    await storage.close();
  }
}

export function resumeUsage(): void {
  console.log(`Usage: lazy resume <task_id> [--model <model>] [--follow]

Resume an interrupted task. Writes a command for the supervisor and launches
a container if needed.

Tasks become 'interrupted' when:
  - The Docker container crashes or is killed
  - The machine goes down while an agent is running
  - Network connectivity is lost during execution

The agent receives a special prompt telling it to review the branch state
and continue working towards the goal.

Arguments:
  <task_id>    ID of the interrupted task to resume

Options:
  --model <model>    Override model for this session (sonnet, opus, haiku)
  --follow           Wait for the agent to finish, streaming output in real time

Examples:
  lazy resume abc12345
  lazy resume abc1 --model opus
  lazy resume abc1 --follow              # Wait for completion`);
}
