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
import { hostname } from 'os';
import { join } from 'path';
import { getHome } from '../../utils/home';
import { requireLazyRoot, requireStorage, parseFlags } from '../helpers';
import { ensureImage, ensureAgentBinary, resolveImageName } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { isTTY } from '../editor';
import { promptChoice, promptLine } from '../editor';
import { theme } from '../theme';
import type { Task } from '../../types';
import type { Storage } from '../../storage';
import { checkDaemonHealth, requestShutdown, waitForDaemonStop, cleanupStaleFiles, readPid } from '../../daemon';
import { ensureDaemon } from '../../daemon/auto-start';
import { checkDaemonCredentials } from '../../daemon/credential-gate';
import { spawnSync } from '../../utils/spawn';
import { VERSION } from '../../version';

const DOCKER_TIMEOUT_MS = 10_000;

/**
 * Grace period given to a builder container to shut down cleanly on upgrade.
 *
 * Long enough for the supervisor's SIGTERM handler to finish a final conversation
 * capture (a storage round-trip over the daemon's TCP web server) and stamp the
 * resume session id; short enough that a wedged builder cannot stall the upgrade.
 */
const BUILDER_STOP_GRACE_SECONDS = 10;

interface ContainerInfo {
  name: string;
  taskShortId: string;
  task: Task | null;
  isWorking: boolean;
}

/**
 * Credential preflight for `lazy upgrade`.
 *
 * Step 4 of an upgrade restarts the daemon, and the daemon's credential gate
 * (src/daemon/credential-gate.ts) refuses to start without a model credential
 * in its environment. That gate used to fire only AFTER the upgrade had already
 * stopped every container and rebuilt the image — leaving the project with no
 * daemon, no builders, and a rebuild's worth of wasted time for a condition we
 * could have detected in the first millisecond.
 *
 * So check it FIRST, before anything is stopped or rebuilt. The check is exact,
 * not an approximation: the daemon child inherits this process's environment
 * (see startDaemonBackground → spawn with `{ ...process.env }`), so evaluating
 * the gate here evaluates the same env the daemon will be gated on.
 *
 * Why preflight rather than "inherit the credential from the daemon we are
 * about to stop": reading another process's environment is not portable (Linux
 * /proc only; macOS requires ptrace-level access) and would mean copying a live
 * secret through lazy's own memory and IPC for no benefit — the human has to
 * fix their shell environment either way, and telling them up front, with
 * nothing yet broken, is strictly better than papering over it for one run.
 *
 * Returns the actionable message when the upgrade must abort, or null to proceed.
 */
export async function upgradeCredentialPreflight(projectRoot: string): Promise<string | null> {
  // Test mode never starts a daemon (ensureDaemon bails on LAZY_TEST=1), so
  // there is no gate to preflight and e2e suites need no credential. The
  // LAZY_FORCE_CRED_PREFLIGHT hatch (test-only, same family as
  // LAZY_FORCE_PREFLIGHT) lets the e2e suite exercise the real decision.
  if (process.env.LAZY_TEST === '1' && process.env.LAZY_FORCE_CRED_PREFLIGHT !== '1') return null;

  const gateMessage = await checkDaemonCredentials(projectRoot);
  if (!gateMessage) return null;

  return [
    'Upgrade aborted before any changes were made.',
    '',
    'This upgrade would stop every container, rebuild the image and agent binary,',
    'and then restart the daemon — but the daemon would refuse to start:',
    '',
    gateMessage,
    '',
    'Nothing was stopped, rebuilt, or changed. Your daemon and any live builder',
    'sessions are still running. Set a credential and re-run `lazy upgrade`.',
  ].join('\n');
}

/**
 * Discover all running lazy containers and match them to tasks.
 */
async function discoverRunningContainers(storage: Storage, runner: Runner): Promise<ContainerInfo[]> {
  const names = await runner.discoverRunningRuns();
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
 * Discover running builder containers that belong to THIS project.
 *
 * INVARIANT: `lazy upgrade` in project A must never enumerate or stop
 * containers belonging to project B. Builder containers have no matching
 * task in storage (unlike supervisors), so ownership is determined via a
 * runner-specific mechanism — DockerRunner uses the `lazy.project` label,
 * host-process mode has no builder runs at all.
 */
async function discoverProjectBuilderContainers(runner: Runner, projectRoot: string): Promise<string[]> {
  return runner.discoverProjectBuilderRuns(projectRoot);
}

const WAIT_POLL_INTERVAL_MS = 5_000;

// stopRun is now handled by runner.stopRun()

/**
 * Poll until all working tasks have finished (status != 'working').
 */
async function waitForWorkingTasks(storage: Storage, workingContainers: ContainerInfo[]): Promise<void> {
  const taskIds = workingContainers
    .filter(c => c.task)
    .map(c => c.taskShortId);

  if (taskIds.length === 0) return;

  const pollSeconds = Math.round(WAIT_POLL_INTERVAL_MS / 1000);
  console.log(`\nWaiting for ${taskIds.length} working task(s) to finish... (ctrl-c to cancel)`);
  console.log(`Polling every ${pollSeconds}s.`);

  while (true) {
    // Check which tasks are still working
    const stillWorking: string[] = [];
    for (const id of taskIds) {
      const task = await storage.getTask(id);
      if (task && task.status === 'working') {
        stillWorking.push(id);
      }
    }

    if (stillWorking.length === 0) {
      console.log('All tasks finished. Proceeding with upgrade...');
      return;
    }

    console.log(`  Still waiting on ${stillWorking.length} task(s): ${stillWorking.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
}

/**
 * Force-rebuild the container image by removing the existing one first.
 */
async function forceRebuildImage(root: string, binary: string = 'docker'): Promise<string> {
  const imageName = await resolveImageName(root);

  // Remove existing image to force rebuild
  try {
    // spawnSync (sync) is acceptable: `lazy upgrade` is a one-shot CLI command
    // that runs to completion; there is no daemon event loop to block here.
    spawnSync(
      [binary, 'rmi', '-f', imageName],
      { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
  } catch {
    // Container runtime not available — ensureImage will handle this
  }

  // ensureImage will detect the missing image and rebuild — with --no-cache
  // so Docker doesn't serve stale layers (e.g. cached curl install of Claude Code)
  return ensureImage(binary, { noCache: true });
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

/**
 * Synchronous pre-stop prompt for live builder containers.
 *
 * Stopping a builder kills its `--rm` container; any message the human has typed
 * into the Claude prompt but NOT yet submitted is lost (Claude Code owns that
 * buffer and we pass SIGTERM straight through `--init` — see
 * docs/spikes/builder-upgrade-resume.md §1.4/§2-S3). The conversation itself is
 * durable and resumes automatically; only the unsent buffer is at risk.
 *
 * This honors CLAUDE.md's "never lose human feedback" invariant for the common
 * case: warn the human and block until they confirm they've submitted any
 * in-progress message. It is the v0.17 mitigation; the event-plane
 * `upgrade.imminent` warning into the live builder pane is a deferred follow-up.
 *
 * Behavior is gated so it never hangs a non-interactive caller:
 * - Interactive TTY and not `--force`: warn and wait for Enter (ctrl-c cancels).
 * - `--force` or no TTY: skip the prompt, print a warning that we are proceeding
 *   without waiting and that unsent builder input may be lost, then continue.
 */
export async function promptBuilderPreStop(builderCount: number, force: boolean): Promise<void> {
  if (builderCount === 0) return;

  const noun = builderCount === 1 ? 'builder session' : 'builder sessions';
  console.log('');
  console.log(theme.warning(`${builderCount} ${noun} will be restarted to apply the upgrade.`));
  console.log('  The conversation is preserved and resumes automatically — but any message');
  console.log('  typed into a builder and not yet submitted CANNOT be preserved.');

  // --force or non-TTY: never block. Document that we proceed without waiting.
  if (force || !isTTY()) {
    console.log(theme.warning('  Proceeding without prompting (--force or no TTY); unsent builder input may be lost.'));
    return;
  }

  console.log('  If you have an unsent message in a builder, submit it now.');
  // promptLine blocks until Enter. In test mode (LAZY_PROMPT_DEFAULTS) it returns
  // immediately without waiting, so e2e tests don't hang.
  await promptLine('Press Enter when ready to continue (ctrl-c to cancel)');
}

/**
 * Write a durable builder-resume-intent for each builder about to be stopped.
 *
 * The relaunched host `lazy builder` wrapper (add-builder-relaunch-loop) reads
 * these to learn it was stopped by an upgrade and should resume in place, rather
 * than exiting. The intent MUST be durable: by the time it is read, the builder
 * container is dead and the daemon has restarted — the transient event plane
 * cannot carry it (docs/spikes/builder-upgrade-resume.md §3).
 *
 * CANONICAL KEY: the intent's `builderId` is the SHORT builder id — the
 * container name with the `lazy-builder-` prefix stripped. This is deliberate
 * and load-bearing: docker-runner derives `builderId = configBasename.replace(
 * 'builder-', '')` (the short id) and names the container `lazy-builder-<id>`
 * (docker-runner.ts), then launches the supervisor with `--builder-id <id>`.
 * The supervisor's sessionId stamp (add-builder-sessionid-stamp) keys its
 * `saveBuilderResumeIntent` update by that SAME short id, so writing the intent
 * under the short id is what lets the stamp find and populate it. Writing the
 * full run name here would make the stamp's lookup miss and silently defeat it.
 * `discoverProjectBuilderRuns` returns full `lazy-builder-<id>` names, so we
 * strip the prefix before writing. (The relaunch wrapper matches both forms
 * defensively, but the stamp must actually land.)
 *
 * `sessionId` is left undefined here: in docker mode the host never learns the
 * Claude sessionId (it is `null` to the host — §1.2). It is populated either by
 * the supervisor's stamp (keyed by the same short id) or resolved by the wrapper
 * from storage. Written BEFORE the stop ("save first, act second") so a stop
 * failure never loses the intent.
 */
export async function writeBuilderResumeIntents(
  storage: Storage,
  builderNames: string[],
  projectRoot: string,
): Promise<void> {
  const createdAt = new Date().toISOString();
  // Stamp THIS upgrade process's identity so the waiting builder wrapper can
  // tell "still rebuilding" from "the upgrade died" without resorting to a
  // timeout (see BuilderResumeIntent.upgradePid).
  const upgradePid = process.pid;
  const upgradeHost = hostname();
  for (const name of builderNames) {
    // Strip the `lazy-builder-` run-name prefix to get the canonical short id.
    const builderId = name.replace(/^lazy-builder-/, '');
    await storage.saveBuilderResumeIntent({
      builderId,
      projectRoot,
      createdAt,
      upgradePid,
      upgradeHost,
    });
  }
}

/**
 * Stop live builder containers GRACEFULLY (SIGTERM + grace, never SIGKILL).
 *
 * A builder's supervisor has real exit work: its signal handler flushes the
 * conversation capture (otherwise the last up-to-CAPTURE_INTERVAL_MS of the
 * human's session is lost from lazy's store) and stamps the detected Claude
 * sessionId onto the resume intent written just before the stop — which is how
 * the relaunched builder knows what to resume. `docker kill` ran neither, so an
 * upgraded builder came back into a brand-new conversation. Waiting a few
 * seconds once per builder is a trivial cost for not losing the session.
 *
 * Belt-and-braces with the host-side detection in src/builder/session-detect.ts:
 * that recovers the id no matter HOW the container died; this additionally
 * preserves the conversation tail.
 *
 * Builder containers run with `--rm`, so they auto-remove on stop.
 */
export async function stopBuilderContainers(
  runner: Pick<Runner, 'stopRun'>,
  builderNames: string[],
): Promise<void> {
  for (const name of builderNames) {
    const stopped = await runner.stopRun(name, {
      gracefulTimeoutSeconds: BUILDER_STOP_GRACE_SECONDS,
    });
    if (stopped) {
      console.log(`  ${theme.success('stopped')} ${name}`);
    } else {
      console.log(`  ${theme.error('failed')} ${name}`);
    }
  }
}

/**
 * Print the precise boundary of WHEN each kind of session begins using a
 * freshly-rebuilt image. This is the load-bearing UX of `--images`: the refresh
 * is non-disruptive, so nothing switches instantly except brand-new containers.
 *
 * The boundary is verified against the code, not assumed (see the task journal):
 * - Docker containers hold their image by ID at launch; a rebuild/retag never
 *   restarts a running container.
 * - The supervisor container is long-lived (src/supervisor/index.ts — it polls
 *   for the next command in a loop and stays alive across turns). On unblock the
 *   daemon REUSES a still-running supervisor (task-lifecycle.ts), so a blocked
 *   task does NOT pick up the new image on its next turn — only when its
 *   container is next recreated.
 */
function printImageRefreshBoundary(): void {
  console.log('When each session starts using the refreshed image:');
  console.log(`  ${theme.success('now')}   New and queued tasks — their container is created fresh at launch.`);
  console.log(`  ${theme.success('now')}   Interrupted tasks — on auto-resume their container is recreated.`);
  console.log(`  ${theme.warning('later')} Running builders — on their next relaunch (a live builder keeps its image).`);
  console.log(`  ${theme.warning('later')} Working agents — when their container is next recreated.`);
  console.log(`  ${theme.warning('later')} Blocked tasks — NOT on the next unblock (the live supervisor is reused);`);
  console.log('        they adopt the new image only when their container is recreated');
  console.log('        (daemon restart, interruption, or crash).');
  console.log('');
  console.log('  Running builders and agents were NOT touched by this refresh.');
  console.log(`  For an immediate, disruptive switch of everything, run ${theme.command('lazy upgrade')}.`);
}

/**
 * Non-disruptive image refresh (`lazy upgrade --images`).
 *
 * Rebuilds ONLY the project's resolved container image, with `--no-cache` so a
 * new Claude Code version (installed via `RUN curl … install.sh` in the image —
 * see src/agent/claude-code-packaging.ts) is actually re-fetched. The Dockerfile
 * content is static, so its hash is unchanged when a new Claude Code ships; a
 * plain `ensureImage` would hash-match and skip. `--no-cache` busts that layer.
 *
 * This never stops a container, never restarts the daemon, and never rebuilds
 * the agent binary. Running builders/agents are untouched — only newly-created
 * containers pick up the new image (see printImageRefreshBoundary).
 */
async function refreshImagesOnly(root: string, dryRun: boolean): Promise<void> {
  const config = await loadConfig(root);
  const isContainerRunner = config.runner.type === 'docker' || config.runner.type === 'podman';
  if (!isContainerRunner) {
    console.error(`Error: \`lazy upgrade --images\` only applies to container runners (docker/podman).`);
    console.error(`The current runner is '${config.runner.type}', which has no container image —`);
    console.error(`Claude Code runs from your host installation. Update it there instead.`);
    process.exit(1);
  }

  const binary = config.runner.type; // 'docker' or 'podman'

  // Pre-flight: fail before doing anything if the runtime is unavailable.
  const runner = await createRunner(root);
  try {
    await runner.checkAvailability();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const imageName = await resolveImageName(root);

  if (dryRun) {
    console.log(theme.header('Image refresh dry run:'));
    console.log('');
    console.log(`  Rebuild (--no-cache): ${imageName}`);
    console.log('  No containers stopped, no daemon restart, agent binary untouched.');
    console.log('');
    printImageRefreshBoundary();
    return;
  }

  console.log('\nRefreshing container image for future sessions (--no-cache)...');
  const built = await forceRebuildImage(root, binary);
  console.log(`  ${theme.success('rebuilt')} container image (${built})`);
  console.log('');
  printImageRefreshBoundary();
  console.log(theme.success('\nImage refresh complete.'));
}

export async function commandUpgrade(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'force', takesValue: false },
    { name: 'wait', takesValue: false },
    { name: 'dry-run', takesValue: false },
    { name: 'images', takesValue: false },
  ], 'upgrade');

  const force = parsed.flags.get('force') === true;
  const wait = parsed.flags.get('wait') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const images = parsed.flags.get('images') === true;

  if (force && wait) {
    console.error('Error: --force and --wait are mutually exclusive.');
    process.exit(1);
  }

  const root = requireLazyRoot();

  // Non-disruptive image-only refresh: a separate, self-contained path that
  // touches no running containers and never restarts the daemon. --force/--wait
  // govern how running containers are stopped, which this path never does, so
  // they are meaningless here — reject the combination rather than silently
  // ignore it (principle of least surprise).
  if (images) {
    if (force || wait) {
      console.error('Error: --images does not stop running containers, so --force and --wait do not apply.');
      process.exit(1);
    }
    await refreshImagesOnly(root, dryRun);
    return;
  }

  // Credential preflight — BEFORE the runner check, before storage, and above
  // all before anything is stopped or rebuilt. A full upgrade always ends in a
  // daemon restart, so a missing credential is fatal to the whole operation:
  // say so now, while the running daemon and builders are still intact.
  // --dry-run reports it as a warning instead (it changes nothing by design).
  const credentialError = await upgradeCredentialPreflight(root);
  if (credentialError && !dryRun) {
    console.error(credentialError);
    process.exit(1);
  }

  const storage = await requireStorage();

  try {
    // Pre-flight checks
    const runner = await createRunner(root);
    try {
      await runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Discover running runs scoped to this project. Task containers are
    // scoped via storage lookup (see discoverRunningContainers); builder
    // containers are scoped via the lazy.project Docker label so we never
    // touch builders from other projects.
    const containers = await discoverRunningContainers(storage, runner);
    const workingContainers = containers.filter(c => c.isWorking);
    const builderContainers = await discoverProjectBuilderContainers(runner, root);

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
          console.log('');
          console.log(theme.warning('  Builders will be stopped and resume in place. You will be prompted'));
          console.log('  to submit any in-progress message first (unless --force / no TTY).');
        }
      }

      console.log('');
      console.log('  After rebuild: daemon restarts and auto-resumes interrupted tasks (~10s).');
      console.log('  Running builder sessions resume in place after the upgrade.');

      // A dry run changes nothing, so a failing credential preflight is a
      // warning here rather than an error — but it must be surfaced, because it
      // is exactly what a real run would abort on.
      if (credentialError) {
        console.log('');
        console.log(theme.warning('  A real upgrade would abort immediately: no model credential in this'));
        console.log(theme.warning('  environment, so the daemon could not be restarted afterwards.'));
        console.log('  Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY before upgrading.');
      }
      return;
    }

    // Check for working containers
    if (workingContainers.length > 0 && !force && !wait) {
      console.log(theme.warning(`${workingContainers.length} container(s) are currently working:`));
      for (const c of workingContainers) {
        const goal = c.task?.goal ?? '(unknown)';
        console.log(`  ${theme.taskId(c.taskShortId)} ${goal}`);
      }
      console.log('');
      console.log('Stopping them will interrupt mid-turn work. Tasks will resume from their last checkpoint.');

      if (!isTTY()) {
        console.error('Cannot prompt for confirmation (no TTY). Use --force or --wait to skip.');
        process.exit(1);
      }

      const choice = await promptChoice('How would you like to proceed?', [
        'Stop and upgrade now',
        'Wait for all tasks to block, then upgrade',
        'Cancel',
      ]);

      if (choice === 2) {
        console.log('Upgrade cancelled.');
        return;
      }

      if (choice === 1) {
        // User chose to wait — fall through to the wait logic below
        await waitForWorkingTasks(storage, workingContainers);
      }
      // choice === 0: stop and upgrade now — continue with existing flow
    }

    // --wait flag: wait for working tasks to finish before proceeding
    if (wait && workingContainers.length > 0) {
      await waitForWorkingTasks(storage, workingContainers);
    }

    // Pre-stop prompt: give the human a chance to submit any in-progress
    // message in a live builder before its container is killed. Honors
    // "never lose human feedback" (CLAUDE.md). Skipped under --force / non-TTY.
    await promptBuilderPreStop(builderContainers.length, force);

    // Step 1: Stop all running containers/processes for this project
    const totalContainers = containers.length + builderContainers.length;
    if (totalContainers > 0) {
      console.log(`\nStopping ${totalContainers} container(s)...`);

      // Stop task containers
      for (const c of containers) {
        const stopped = await runner.stopRun(c.name);
        if (stopped) {
          console.log(`  ${theme.success('stopped')} ${c.name}`);
        } else {
          console.log(`  ${theme.error('failed')} ${c.name}`);
        }
        // Remove the stopped container/process
        await runner.removeRun(c.name);
      }

      // Write durable resume intents BEFORE stopping any builder ("save first,
      // act second"): the relaunched wrapper reads these to resume in place. The
      // builder is still alive here, so its sessionId is unknown to the host —
      // the wrapper resolves it from storage after the child exits.
      if (builderContainers.length > 0) {
        await writeBuilderResumeIntents(storage, builderContainers, root);
      }

      await stopBuilderContainers(runner, builderContainers);
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
      // Capture the OLD daemon's pid BEFORE shutdown — we wait for that exact
      // process to die, not just for the socket to vanish.
      const oldPid = daemonStatus.pid ?? readPid(root);
      await requestShutdown(root);
      // requestShutdown only DELIVERS the request — the daemon exits async, and
      // it removes its own socket/PID files as the LAST steps before exit. We
      // must wait for the old PROCESS to fully die before starting a fresh
      // daemon; otherwise (a) ensureDaemon sees a live process and skips the
      // restart, or (b) the old daemon's trailing cleanup clobbers the new
      // daemon's freshly-written socket/PID — leaving the project with no
      // reachable daemon. Both stranded the builder relaunch loop / broke the
      // next command ("Daemon is not running").
      const stopped = await waitForDaemonStop(root, 15000, oldPid);
      if (!stopped) {
        // The old daemon acked shutdown but never exited (wedged). Force it
        // down so we can guarantee a clean fresh start.
        console.log('  (old daemon did not exit in time — forcing it down)');
        if (oldPid != null) {
          try { process.kill(oldPid, 'SIGKILL'); } catch { /* already gone */ }
        }
        cleanupStaleFiles(root);
      }
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
  console.log(`Usage: lazy upgrade [--force] [--wait] [--dry-run]
       lazy upgrade --images [--dry-run]

Rebuild the Docker image and agent binary, then restart the daemon.

Non-disruptive image refresh (--images):
  \`lazy upgrade --images\` rebuilds ONLY the project's container image, with
  --no-cache so a newly-released Claude Code (installed inside the image) is
  actually re-fetched. It stops nothing and does not restart the daemon, so
  running builders and agents keep working uninterrupted. Only newly-created
  containers use the refreshed image:
    - New / queued tasks and interrupted-then-resumed tasks:  immediately
    - Running builders:  on their next relaunch
    - Working agents and blocked tasks:  when their container is next recreated
      (a blocked task reuses its live supervisor on unblock, so it does NOT
      switch on the next turn)
  For an immediate, disruptive switch of everything, run a full \`lazy upgrade\`.
  Only applies to docker/podman runners (host-process has no image).

What happens:
  1. Live builder sessions are warned to submit any in-progress message
  2. All running lazy containers are stopped (task supervisors and builders)
  3. Docker image and agent binary are force-rebuilt
  4. Daemon is restarted with new code
  5. Daemon auto-reconciles and auto-resumes interrupted tasks (~10 seconds)
  6. Running builder sessions resume in place with their conversation intact

If any containers are in 'working' state (mid-turn), you'll be prompted with
three options: stop and upgrade now, wait for tasks to finish, or cancel.
Mid-turn work will be lost if you stop, but tasks resume from their last
checkpoint.

If any builder sessions are running, you'll be warned to submit any in-progress
message before they restart — their conversation resumes automatically, but a
typed-but-unsent message cannot be preserved. With --force or no TTY this
warning is printed but not blocked on, and unsent builder input may be lost.

Options:
  --force     Don't prompt, stop everything including working containers
  --wait      Wait for all working tasks to block before upgrading
  --images    Non-disruptive: rebuild only the container image (--no-cache) for
              future sessions; stop nothing, don't restart the daemon
  --dry-run   Show what would be rebuilt and stopped, without doing anything

--force and --wait are mutually exclusive. --images does not stop containers, so
it cannot be combined with --force or --wait.

Examples:
  lazy upgrade              # Interactive: prompt if working tasks exist
  lazy upgrade --force      # Non-interactive: stop everything and rebuild
  lazy upgrade --wait       # Non-interactive: wait for tasks to finish, then upgrade
  lazy upgrade --images     # Non-disruptive: refresh the image for future sessions
  lazy upgrade --dry-run    # Preview what would happen`);
}
