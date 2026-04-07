/**
 * Auto-resume logic for interrupted tasks.
 *
 * Shared between the reconciler (automatic) and the resume command (manual).
 * Performs the minimum steps to restart a task: write unblock command,
 * launch supervisor container, update session state.
 */

import { join } from 'path';
import { stat, mkdir, copyFile, writeFile, readdir, readFile, rm } from 'fs/promises';
import { getHome } from './home';
import { pathExists, dirExists } from './fs';
import type { Storage } from '../storage';
import type { Task, Session } from '../types';
import { getAuthEnvVars } from '../capture/claude';
import type { SandboxConfig } from '../capture/claude';
import { tmuxSessionName, createTmuxWatchSession } from '../terminal';
import { loadConfig } from '../config/loader';
import { createRunner } from '../runner';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../protocol';
import type { UnblockCommand } from '../protocol';
import { acquireLock, removeLock } from './lock';
import { logger } from './logger';
import { getDataDir } from '../cli/init';
import { taskRef, getWorktreePathForRef, getBranchNameFromId } from '../cli/helpers';
import { getCurrentBranch, hasUncommittedChanges, getTaskTargetBranch } from '../git/operations';
import { writeDaemonMcpConfig } from '../daemon/task-launcher';
import { hasDaemonContext } from '../daemon/context';

import lazyToolInstructions from '../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../prompts/goal-context-resume.md' with { type: 'text' };

const SANDBOX_DIR = '.lazy-task-sandbox';

/** Maximum consecutive interruptions before circuit breaker stops auto-resume */
export const MAX_CONSECUTIVE_INTERRUPTIONS = 3;

/**
 * Translate a container exit code to a human-readable reason.
 */
export function exitCodeToReason(exitCode: number | null): string {
  if (exitCode === null) return 'Container disappeared (no exit code)';
  switch (exitCode) {
    case 0: return 'Clean exit (exit code 0)';
    case 1: return 'General error (exit code 1)';
    case 137: return 'OOM killed or SIGKILL (exit code 137)';
    case 143: return 'Graceful shutdown / SIGTERM (exit code 143)';
    default: return `Container exited with code ${exitCode}`;
  }
}

function buildResumePrompt(goal: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = resumeContextText + '\n';
  const lazyBinaryInstructions = lazyToolInstructions + '\n';
  const systemInstructions = systemInstructionsResumeText + '\n';
  return goalContext + resumeContext + lazyBinaryInstructions + systemInstructions;
}

/**
 * Search the sandbox .claude directory for a Claude session ID.
 */
async function findClaudeSessionId(sandboxPath: string): Promise<string | null> {
  const claudeDir = join(sandboxPath, '.claude');
  if (!await pathExists(claudeDir)) {
    return null;
  }

  try {
    const projectsDir = join(claudeDir, 'projects');
    if (!await pathExists(projectsDir)) {
      return null;
    }

    const allDirs = await readdir(projectsDir);
    const projectDirs: string[] = [];
    for (const d of allDirs) {
      try {
        const contents = await readdir(join(projectsDir, d));
        if (contents.length > 0) {
          projectDirs.push(d);
        }
      } catch { /* skip unreadable dirs */ }
    }

    for (const projDir of projectDirs) {
      const projPath = join(projectsDir, projDir);
      const allFiles = await readdir(projPath);
      const files = allFiles.filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const content = await readFile(join(projPath, file), 'utf-8');
          const data = JSON.parse(content);
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
 * Auto-resume an interrupted task. Called by the reconciler after marking
 * a task as interrupted and checking the circuit breaker.
 *
 * Returns true if resume was successful, false if it failed.
 */
export async function autoResumeTask(
  storage: Storage,
  task: Task,
  session: Session,
  lazyRoot: string,
): Promise<boolean> {
  const tRef = taskRef(task);
  const taskShortId = task.id.substring(0, 8);
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);

  // Pre-flight checks
  if (!await pathExists(worktreePath)) {
    logger.debug(`Auto-resume ${taskShortId}: worktree not found, skipping`);
    return false;
  }

  const runner = await createRunner(lazyRoot);

  try {
    runner.checkAvailability();
  } catch {
    logger.debug(`Auto-resume ${taskShortId}: runner not available, skipping`);
    return false;
  }

  // Acquire worktree lock
  try {
    await acquireLock(worktreePath, 'lazy auto-resume');
  } catch {
    logger.debug(`Auto-resume ${taskShortId}: could not acquire worktree lock, skipping`);
    return false;
  }

  const containerName = runner.runNameForTask(tRef);

  try {
    // Load config from the worktree — the branch may have settings (e.g., permissions)
    // that aren't on the project root's lazy.toml yet.
    const config = await loadConfig(lazyRoot, { cwd: worktreePath });

    // Ensure sandbox exists
    const sandboxPath = join(worktreePath, SANDBOX_DIR);
    const claudeDir = join(sandboxPath, '.claude');
    await mkdir(claudeDir, { recursive: true });

    // Docker creates .gitconfig as a directory if the bind mount source doesn't exist.
    // Remove the stale directory before copying the file.
    const hostGitconfig = join(getHome(), '.gitconfig');
    const sandboxGitconfig = join(sandboxPath, '.gitconfig');
    if (await dirExists(sandboxGitconfig)) {
      await rm(sandboxGitconfig, { recursive: true });
    }

    if (await pathExists(hostGitconfig)) {
      await copyFile(hostGitconfig, sandboxGitconfig);
    } else {
      await writeFile(sandboxGitconfig, '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n');
    }

    const sandbox: SandboxConfig = { worktreePath, sandboxPath };

    // When Ollama is enabled for Claude Code, always use the Ollama model — task model
    // names (e.g. "claude-opus-4-6") don't exist in Ollama's model registry.
    const modelName = (config.ollama.enabled && config.ollama.model && task.agent_id === 'claude-code')
      ? config.ollama.model
      : (task.model ?? config.models.default);
    const modelId = modelName;

    // Try to find Claude session ID
    let claudeSessionId = session.agent_session_id;
    if (!claudeSessionId) {
      claudeSessionId = await findClaudeSessionId(sandboxPath);
      if (claudeSessionId) {
        await storage.updateSessionClaudeId(session.id, claudeSessionId);
      }
    }

    // Build resume prompt
    const fullPrompt = buildResumePrompt(task.goal);

    // --- Persist state BEFORE launching container ---

    // Record synthetic human turn for the auto-resume.
    // NOT autoTriggered: resume continues an interrupted turn — it's the same
    // logical turn, not a new auto-react trigger. Does not count against the
    // auto-turn budget.
    const nextSeq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({
      sessionId: session.id,
      sequence: nextSeq,
      role: 'human',
      content: '[system] Session interrupted and auto-resumed',
      actor: 'system',
    });

    // Mark as auto-resumed and transition to working
    await storage.setAutoResumed(session.id, true);
    await storage.updateTaskStatus(task.id, 'working', 'system');

    // --- Write command and launch supervisor ---

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    // INVARIANT: Every unblock merges upstream before giving feedback.
    // Resolve the parent branch the same way the normal unblock path does
    // (shared.ts lines 1078-1083) so the supervisor merges upstream before
    // the agent resumes. Without this, auto-resumed tasks drift behind main.
    //
    // However, merging upstream is unsafe when the worktree has uncommitted
    // changes from a crashed turn — git merge on a dirty worktree will fail
    // or create confusing state. In that case, skip the merge and let the
    // agent deal with the uncommitted changes first.
    const worktreeDirty = await hasUncommittedChanges(worktreePath);
    let parentBranch: string | undefined;
    let syncBeforeWork = false;

    if (worktreeDirty) {
      logger.debug(`Auto-resume ${taskShortId}: worktree is dirty, skipping upstream merge`);
    } else {
      try {
        if (task.parent_task_id) {
          parentBranch = await getBranchNameFromId(task.parent_task_id, storage);
        } else {
          parentBranch = await getTaskTargetBranch(task, lazyRoot) ?? await getCurrentBranch(lazyRoot);
        }
        syncBeforeWork = true;
      } catch (err) {
        logger.debug(`Auto-resume ${taskShortId}: could not resolve parent branch: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Inject crash-state context so the agent knows what happened
    const crashContext = worktreeDirty
      ? 'You are being resumed after a crash. There are uncommitted changes in your worktree from your interrupted turn. Review them, decide what to keep, commit or discard, then continue your work.\n\n'
      : 'You are being resumed after a crash. Upstream has been merged into your branch since your last turn. Don\'t assume your previous state is intact — verify before continuing.\n\n';

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      prompt: crashContext + fullPrompt,
      agent_id: task.agent_id,
      model_id: modelId,
      agent_session_id: claudeSessionId ?? undefined,
      parent_branch: parentBranch,
      sync_before_work: syncBeforeWork,
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, unblockCommand);

    // Generate daemon MCP config so the supervisor can provide MCP tools
    let daemonConfigPath: string | undefined;
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(lazyRoot, containerName, config.data.path);
    }

    // Check if supervisor is already running
    if (runner.isRunning(containerName)) {
      logger.debug(`Auto-resume ${taskShortId}: supervisor already running, command written`);
    } else {
      runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath);
      } catch (err) {
        logger.warn(`Auto-resume ${taskShortId}: failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
        await storage.updateTaskStatus(task.id, 'interrupted', 'system');
        return false;
      }
    }

    // Store container name and update interaction timestamp
    await storage.updateSessionContainerName(session.id, containerName);
    await storage.updateSessionInteraction(session.id, 0);

    // Create a detached tmux session for `lazy watch`
    const tmuxSessName = tmuxSessionName(taskShortId);
    if (runner.usesSandbox()) {
      createTmuxWatchSession(tmuxSessName, ['docker', 'logs', '-f', containerName]);
    } else {
      const logFile = join(getHome(), '.lazy', 'logs', `${containerName}.log`);
      createTmuxWatchSession(tmuxSessName, ['tail', '-f', logFile]);
    }

    logger.info(`Auto-resumed task ${taskShortId} (consecutive interruptions: ${session.consecutive_interruptions})`);
    return true;
  } catch (err) {
    logger.warn(`Auto-resume ${taskShortId} failed: ${err instanceof Error ? err.message : err}`);
    // Ensure task stays interrupted if auto-resume fails
    try {
      await storage.updateTaskStatus(task.id, 'interrupted', 'system');
    } catch {
      // Best effort
    }
    return false;
  } finally {
    await removeLock(worktreePath);
  }
}
