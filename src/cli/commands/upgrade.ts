/**
 * `lazy upgrade` — rebuild image/binary, restart daemon.
 *
 * When code changes are merged, running containers use stale code — both
 * the supervisor binary (loaded at process start) and the Docker image
 * (built at container launch). This command upgrades running infrastructure:
 *
 * 1. Find all running lazy containers, prompt if any are working
 * 2. Stop all running containers/processes
 * 3. Rebuild agent binary AND Docker image (force rebuild regardless of hash)
 * 4. Restart daemon with new code
 *
 * The restarted daemon handles everything else automatically:
 * - Reconciles stopped containers → marks tasks as interrupted (~5s)
 * - Auto-resumes interrupted tasks with new supervisors
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getHome } from '../../utils/home';
import { requireLazyRoot, requireStorage, parseFlags } from '../helpers';
import { ensureImage, ensureAgentBinary, resolveImageName } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { isTTY } from '../editor';
import { promptYesNo } from '../editor';
import { theme } from '../theme';
import type { Task } from '../../types';
import type { Storage } from '../../storage';
import { checkDaemonHealth, requestShutdown } from '../../daemon';
import { ensureDaemon } from '../../daemon/auto-start';
import { spawnSync } from '../../utils/spawn';

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
  const imageName = await resolveImageName(root);

  // Remove existing image to force rebuild
  try {
    spawnSync(
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
  const binDir = join(getHome(), '.lazy', 'bin');
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
    const runner = await createRunner(root);
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
      console.log('  After rebuild: daemon restarts and auto-resumes interrupted tasks (~10s).');
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

    // Step 2: Rebuild image and binary
    console.log('\nRebuilding...');
    const config = await loadConfig(root);
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

    // Step 3: Restart daemon with new code.
    // The new daemon will reconcile stopped containers (~5s) and auto-resume
    // interrupted tasks — no need for upgrade to do either of those.
    const daemonStatus = await checkDaemonHealth(root);
    if (daemonStatus.running) {
      console.log('\nRestarting daemon...');
      await requestShutdown(root);
    }
    await ensureDaemon('upgrade', root);
    console.log('  Daemon restarted with new version.');

    if (containers.length > 0) {
      console.log(`\n  ${containers.length} interrupted task(s) will auto-resume within ~10 seconds.`);
    }

    console.log(theme.success('\nUpgrade complete.'));
  } finally {
    await storage.close();
  }
}

export function upgradeUsage(): void {
  console.log(`Usage: lazy upgrade [--force] [--dry-run]

Rebuild the Docker image and agent binary, then restart the daemon.

What happens:
  1. All running lazy containers are stopped (task supervisors and builders)
  2. Docker image and agent binary are force-rebuilt
  3. Daemon is restarted with new code
  4. Daemon auto-reconciles and auto-resumes interrupted tasks (~10 seconds)
  5. Builder containers restart on next use

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
