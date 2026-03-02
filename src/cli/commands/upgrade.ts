/**
 * `lazy upgrade` — rebuild image/binary and restart containers.
 *
 * When code changes are merged, running containers use stale code — both
 * the supervisor binary (loaded at process start) and the Docker image
 * (built at container launch). This command upgrades running infrastructure:
 *
 * 1. Rebuild agent binary AND Docker image (force rebuild regardless of hash)
 * 2. Find all running lazy containers
 * 3. If no containers are in 'working' state: proceed automatically
 * 4. If some containers are working: prompt for confirmation (--force skips)
 * 5. Stop containers (docker stop)
 * 6. Reconciler marks tasks as interrupted
 * 7. Auto-resume all interrupted tasks with new containers
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { requireLazyRoot, requireStorage, shortId, parseFlags, taskRef, getWorktreePathForRef } from '../helpers';
import { getAuthEnv, ensureImage, ensureAgentBinary, resolveImageName, getModelId } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { isTTY } from '../editor';
import { promptYesNo } from '../editor';
import { theme } from '../theme';
import { logger } from '../../utils/logger';
import { reconcileTasks } from '../../utils/reconcile';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir } from '../../protocol';
import { getDataDir } from '../init';
import { checkLock, acquireLock, removeLock } from '../../utils/lock';
import { checkPairingLock } from '../../utils/pairing-lock';
import type { UnblockCommand } from '../../protocol';
import { getActor } from '../../constants';
import type { SandboxConfig } from '../../capture/claude';
import type { Task, ModelName } from '../../types';
import type { Storage } from '../../storage';
import { buildSystemPromptForResume, buildResumePrompt } from './resume';

const SANDBOX_DIR = '.lazy-task-sandbox';
const DOCKER_TIMEOUT_MS = 10_000;

interface ContainerInfo {
  name: string;
  taskShortId: string;
  task: Task | null;
  isWorking: boolean;
}

/**
 * Discover all running lazy containers and match them to tasks.
 */
async function discoverRunningContainers(storage: Storage, runner: Runner): Promise<ContainerInfo[]> {
  const names = runner.discoverRunningRuns();
  const containers: ContainerInfo[] = [];

  for (const name of names) {
    const taskShortId = name.replace(/^lazy-/, '');
    if (!taskShortId) continue;

    let task: Task | null = null;
    try {
      task = await storage.getTask(taskShortId);
    } catch {
      // Task not found in this project's storage — belongs to another project.
      // Skip it: upgrade must never touch containers from other projects.
      continue;
    }

    if (!task) continue;

    containers.push({
      name,
      taskShortId,
      task,
      isWorking: task.status === 'working',
    });
  }

  return containers;
}

/**
 * Discover all running builder containers.
 * Builder containers are named lazy-builder-{id} and don't have associated tasks.
 */
function discoverRunningBuilderContainers(runner: Runner): string[] {
  const allNames = runner.discoverRunningRuns();
  return allNames.filter(name => name.startsWith('lazy-builder-'));
}

// stopRun is now handled by runner.stopRun()

/**
 * Force-rebuild the container image by removing the existing one first.
 */
async function forceRebuildImage(root: string, binary: string = 'docker'): Promise<string> {
  const imageName = resolveImageName(root);

  // Remove existing image to force rebuild
  try {
    Bun.spawnSync(
      [binary, 'rmi', '-f', imageName],
      { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
  } catch {
    // Container runtime not available — ensureImage will handle this
  }

  // ensureImage will detect the missing image and rebuild
  return ensureImage(binary);
}

/**
 * Force-rebuild the agent binary by removing the cached binary and hash file.
 * Agent binaries live in ~/.lazy/bin/ (per-user, not per-project).
 */
async function forceRebuildAgentBinary(): Promise<string> {
  const binDir = join(homedir(), '.lazy', 'bin');
  const binaryFile = join(binDir, 'lazy-agent');
  const hashFile = join(binDir, 'lazy-agent.hash');

  // Remove cached binary and hash file to force rebuild/re-extraction
  try {
    if (existsSync(binaryFile)) {
      unlinkSync(binaryFile);
    }
    if (existsSync(hashFile)) {
      unlinkSync(hashFile);
    }
  } catch {
    // Best effort
  }

  return ensureAgentBinary();
}

/**
 * Resume a single interrupted task.
 * Returns true if successfully launched, false otherwise.
 */
async function resumeTask(
  storage: Storage,
  task: Task,
  root: string,
): Promise<boolean> {
  const tRef = taskRef(task);
  const taskShortId = shortId(task.id);

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    logger.warn(`Task ${taskShortId}: no session found, skipping auto-resume`);
    return false;
  }
  if (sess.ended_at) {
    logger.warn(`Task ${taskShortId}: session already ended, skipping auto-resume`);
    return false;
  }

  const worktreePath = getWorktreePathForRef(root, tRef);
  if (!existsSync(worktreePath)) {
    logger.warn(`Task ${taskShortId}: worktree not found, skipping auto-resume`);
    return false;
  }

  // Skip locked tasks
  if (checkLock(worktreePath)) {
    logger.warn(`Task ${taskShortId}: locked by another process, skipping auto-resume`);
    return false;
  }
  if (checkPairingLock(worktreePath)) {
    logger.warn(`Task ${taskShortId}: locked for pairing, skipping auto-resume`);
    return false;
  }

  // Acquire lock
  acquireLock(worktreePath, 'lazy upgrade');

  const runner = createRunner(root);
  const containerName = runner.runNameForTask(tRef);

  try {
    const config = loadConfig(root);

    // Ensure sandbox exists
    const sandboxPath = join(worktreePath, SANDBOX_DIR);
    const claudeDir = join(sandboxPath, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const hostGitconfig = join(homedir(), '.gitconfig');
    const sandboxGitconfig = join(sandboxPath, '.gitconfig');
    if (existsSync(hostGitconfig)) {
      copyFileSync(hostGitconfig, sandboxGitconfig);
    } else {
      writeFileSync(sandboxGitconfig, '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n');
    }

    const sandbox: SandboxConfig = { worktreePath, sandboxPath };
    const modelName: ModelName = task.model ?? config.models.default;
    const modelId = getModelId(modelName);

    // Build the prompts: static system prompt and dynamic user prompt
    const systemPrompt = buildSystemPromptForResume();
    const fullPrompt = buildResumePrompt(task.goal, root);

    // Record synthetic human turn
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: '[system] Session interrupted by upgrade and resumed',
      actor: getActor(),
    });

    // Transition to working
    await storage.updateTaskStatus(task.id, 'working', getActor());

    // Set up protocol
    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      prompt: fullPrompt,
      system_prompt: systemPrompt,
      model_id: modelId,
      claude_session_id: sess.claude_session_id ?? undefined,
      turn_started_at: new Date().toISOString(),
    };
    writeCommand(protoDir, unblockCommand);

    // Remove any stale run
    runner.removeRun(containerName);

    // Launch new supervisor
    await runner.launchSupervisor(sandbox, containerName, protoDir, false);

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName);
    await storage.updateSessionInteraction(sess.id, 0);

    return true;
  } catch (err) {
    logger.error(`Task ${taskShortId}: failed to resume: ${err instanceof Error ? err.message : err}`);
    // Revert to interrupted if we changed status
    try {
      await storage.updateTaskStatus(task.id, 'interrupted', getActor());
    } catch {
      // Best effort
    }
    return false;
  } finally {
    removeLock(worktreePath);
  }
}

export async function commandUpgrade(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'force', takesValue: false },
    { name: 'dry-run', takesValue: false },
  ], 'upgrade');

  const force = parsed.flags.get('force') === true;
  const dryRun = parsed.flags.get('dry-run') === true;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Pre-flight checks
    const runner = createRunner(root);
    try {
      runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Discover running runs
    const containers = await discoverRunningContainers(storage, runner);
    const workingContainers = containers.filter(c => c.isWorking);
    const builderContainers = discoverRunningBuilderContainers(runner);

    // Dry run: show what would happen
    if (dryRun) {
      console.log(theme.header('Upgrade dry run:'));
      console.log('');
      console.log('  Rebuild: Docker image + agent binary');
      console.log('');

      const totalContainers = containers.length + builderContainers.length;
      if (totalContainers === 0) {
        console.log('  No running containers found.');
      } else {
        if (containers.length > 0) {
          console.log(`  ${containers.length} task container(s):`);
          for (const c of containers) {
            const status = c.isWorking ? theme.status('working') : (c.task ? theme.status(c.task.status) : 'unknown');
            const goal = c.task?.goal ?? '(unknown task)';
            console.log(`    ${c.name} [${status}] ${goal}`);
          }

          if (workingContainers.length > 0) {
            console.log('');
            console.log(theme.warning(`  ${workingContainers.length} container(s) are currently working.`));
            console.log('  These will be stopped (mid-turn work will be lost, task resumes from last checkpoint).');
          }
        }

        if (builderContainers.length > 0) {
          if (containers.length > 0) console.log('');
          console.log(`  ${builderContainers.length} builder container(s):`);
          for (const name of builderContainers) {
            console.log(`    ${name}`);
          }
        }
      }

      console.log('');
      console.log('  After rebuild: all interrupted tasks will be auto-resumed.');
      console.log('  Builder containers will restart on next use.');
      return;
    }

    // Check for working containers
    if (workingContainers.length > 0 && !force) {
      console.log(theme.warning(`${workingContainers.length} container(s) are currently working:`));
      for (const c of workingContainers) {
        const goal = c.task?.goal ?? '(unknown)';
        console.log(`  ${theme.taskId(c.taskShortId)} ${goal}`);
      }
      console.log('');
      console.log('Stopping them will interrupt mid-turn work. Tasks will resume from their last checkpoint.');

      if (!isTTY()) {
        console.error('Cannot prompt for confirmation (no TTY). Use --force to skip.');
        process.exit(1);
      }

      const confirmed = await promptYesNo('Continue?');
      if (!confirmed) {
        console.log('Upgrade cancelled.');
        return;
      }
    }

    // Step 1: Stop all running containers/processes for this project
    const totalContainers = containers.length + builderContainers.length;
    if (totalContainers > 0) {
      console.log(`\nStopping ${totalContainers} container(s)...`);

      // Stop task containers
      for (const c of containers) {
        const stopped = runner.stopRun(c.name);
        if (stopped) {
          console.log(`  ${theme.success('stopped')} ${c.name}`);
        } else {
          console.log(`  ${theme.error('failed')} ${c.name}`);
        }
        // Remove the stopped container/process
        runner.removeRun(c.name);
      }

      // Stop builder containers
      for (const name of builderContainers) {
        const stopped = runner.stopRun(name);
        if (stopped) {
          console.log(`  ${theme.success('stopped')} ${name}`);
        } else {
          console.log(`  ${theme.error('failed')} ${name}`);
        }
        // Builder containers use --rm flag, so they auto-remove on stop
        // No need to call removeRun explicitly
      }
    } else {
      console.log('\nNo running containers to stop.');
    }

    // Step 2: Run reconciliation to mark stopped tasks as interrupted
    console.log('\nReconciling task states...');
    await reconcileTasks(storage, root);

    // Step 3: Rebuild image and binary
    console.log('\nRebuilding...');
    const config = loadConfig(root);
    const isContainerRunner = config.runner.type === 'docker' || config.runner.type === 'podman';
    if (isContainerRunner) {
      const binary = config.runner.type; // 'docker' or 'podman'
      const [imageName] = await Promise.all([
        forceRebuildImage(root, binary),
        forceRebuildAgentBinary(),
      ]);
      console.log(`  ${theme.success('rebuilt')} container image (${imageName})`);
      console.log(`  ${theme.success('rebuilt')} agent binary`);
    } else {
      // Host-process mode: only rebuild agent binary
      await forceRebuildAgentBinary();
      console.log(`  ${theme.success('rebuilt')} agent binary`);
    }

    // Step 4: Auto-resume interrupted tasks that had running containers
    // Collect tasks that were running and are now interrupted
    const tasksToResume: Task[] = [];
    for (const c of containers) {
      if (!c.task) continue;
      // Re-fetch task to get updated status after reconciliation
      const updatedTask = await storage.getTask(c.taskShortId);
      if (updatedTask && updatedTask.status === 'interrupted') {
        tasksToResume.push(updatedTask);
      }
    }

    if (tasksToResume.length > 0) {
      console.log(`\nAuto-resuming ${tasksToResume.length} task(s)...`);
      let resumed = 0;
      for (const task of tasksToResume) {
        const taskShortId = shortId(task.id);
        const success = await resumeTask(storage, task, root);
        if (success) {
          console.log(`  ${theme.success('resumed')} ${theme.taskId(taskShortId)} ${task.goal}`);
          resumed++;
        } else {
          console.log(`  ${theme.error('failed')} ${theme.taskId(taskShortId)} ${task.goal}`);
        }
      }
      console.log(`\nResumed ${resumed}/${tasksToResume.length} task(s).`);
    } else {
      console.log('\nNo tasks to auto-resume.');
    }

    console.log(theme.success('\nUpgrade complete.'));
  } finally {
    await storage.close();
  }
}

export function upgradeUsage(): void {
  console.log(`Usage: lazy upgrade [--force] [--dry-run]

Rebuild the Docker image and agent binary, then restart all running containers
with the updated code.

What happens:
  1. All running lazy containers are stopped (task supervisors and builders)
  2. Docker image and agent binary are force-rebuilt
  3. Tasks that were interrupted by the stop are auto-resumed with new containers
  4. Builder containers will restart on next use

If any containers are in 'working' state (mid-turn), you'll be prompted for
confirmation before stopping them. Mid-turn work will be lost, but tasks resume
from their last checkpoint.

Options:
  --force     Don't prompt, stop everything including working containers
  --dry-run   Show what would be rebuilt and stopped, without doing anything

Examples:
  lazy upgrade              # Interactive: rebuild and restart
  lazy upgrade --force      # Non-interactive: stop everything and rebuild
  lazy upgrade --dry-run    # Preview what would happen`);
}
