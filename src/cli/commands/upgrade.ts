/**
 * `lazy upgrade` — rebuild image/binary, restart daemon.
 *
 * When code changes are merged, running containers use stale code — both
 * the supervisor binary (loaded at process start) and the Docker image
 * (built at container launch). This command upgrades running infrastructure:
 *
 * 1. Find all running lazy containers
 * 2. Start the image rebuild in the BACKGROUND, to a staging tag (the rebuild
 *    depends on the Dockerfile, not on the tasks, so it need not wait)
 * 3. Prompt if any containers are working; stop all running containers/processes
 * 4. Collect the background build, promote its staging tag onto the canonical
 *    image tag, and rebuild the agent binary
 * 5. Restart daemon with new code
 *
 * The canonical image tag only moves in step 4 — after the human has committed
 * to the upgrade — so a cancelled upgrade leaves the current image untouched.
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
import {
  ensureImage, ensureAgentBinary, resolveImageName, resolveCustomDockerfile,
  enableUpgradeImageBuild, isAdoptedDockerfile,
} from '../../capture/claude';
import { verifyAgentBinary, formatAgentBinaryError } from '../../agent/binary-identity';
import { logger } from '../../utils/logger';
import { loadConfig, resolveConfigPath } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { isTTY } from '../editor';
import { promptChoice, promptLine } from '../editor';
import { theme } from '../theme';
import type { Task } from '../../types';
import type { Storage } from '../../storage';
import { checkDaemonHealth, requestShutdown, waitForDaemonStop, cleanupStaleFiles, readPid } from '../../daemon';
import { startBackgroundImageBuild, type BackgroundImageBuild } from '../../upgrade/background-image-build';
import { BUILD_TIMEOUT_FLAG, resolveBuildTimeoutMs } from './build-timeout';
import { maybePromptWorktreeDockerfileAdoption } from '../../upgrade/worktree-dockerfile-prompt';
import { ensureDaemon } from '../../daemon/auto-start';
import {
  findLegacyDaemonMcpConfigs,
  legacyMcpConfigDir,
  purgeLegacyDaemonMcpConfigsReporting,
} from '../../upgrade/legacy-mcp-purge';
import { checkDaemonCredentials } from '../../daemon/credential-gate';
import {
  listInteractiveSessions,
  describeInteractiveSession,
  type InteractiveSessionEntry,
} from '../../daemon/interactive-registry';
import { spawnSyncUnsupervised } from '../../utils/spawn';

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
 * Say exactly which files the image build reads. Printed unconditionally
 * before every upgrade image build (and its dry run): the config-override
 * warning is deliberately silent when a worktree's lazy.toml is byte-identical
 * to the root's (see findConfigDir), and building from an unexpected
 * Dockerfile once cost a whole debugging session — so upgrade always names
 * its inputs, including when a worktree Dockerfile was adopted.
 */
async function printImageSource(root: string): Promise<void> {
  const configPath = await resolveConfigPath(root);
  const dockerfilePath = await resolveCustomDockerfile(root);
  const adopted = await isAdoptedDockerfile(root, dockerfilePath);
  const sourceNote = adopted ? ' (daemon-adopted from worktree)' : '';
  console.log(`  Config:     ${configPath}`);
  console.log(`  Dockerfile: ${dockerfilePath ? `${dockerfilePath}${sourceNote}` : 'embedded default ([docker].dockerfile is not set)'}`);
  if (adopted) {
    console.log('              Adopted for the daemon and all launches that do not have a');
    console.log('              per-task image pin, until the next `lazy upgrade` rebuild.');
  }
}

/**
 * Force-rebuild the container image by removing the existing one first.
 */
async function forceRebuildImage(root: string, binary: string = 'docker', timeoutMs: number = 0): Promise<string> {
  const imageName = await resolveImageName(root);

  // Remove existing image to force rebuild
  try {
    // A sync spawn is acceptable: `lazy upgrade` is a one-shot CLI command
    // that runs to completion; there is no daemon event loop to block here.
    spawnSyncUnsupervised(
      [binary, 'rmi', '-f', imageName],
      { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
  } catch {
    // Container runtime not available — ensureImage will handle this
  }

  // ensureImage will detect the missing image and rebuild — with --no-cache
  // so Docker doesn't serve stale layers (e.g. cached curl install of Claude Code)
  return ensureImage(binary, { noCache: true, timeoutMs });
}

/**
 * Force-rebuild the agent binary, then prove the result is really the agent.
 *
 * Two deliberate properties:
 *
 * 1. Only the HASH file is removed, never the binary. The hash is the staleness
 *    gate, so deleting it is enough to force a rebuild/re-extraction — while the
 *    previous, working binary stays in place until the new one is verified and
 *    atomically renamed over it. Deleting the binary first meant a failed
 *    rebuild left the machine with NO agent binary at all, which is strictly
 *    worse than the stale one it replaced.
 * 2. The returned path is verified before upgrade reports success. `lazy upgrade`
 *    is the remedy every "your agent binary is wrong" error names, so it must
 *    never be the command that installs a wrong one and calls it done.
 *
 * Agent binaries live in ~/.lazy/bin/ (per-user, not per-project).
 */
export async function forceRebuildAgentBinary(): Promise<string> {
  const binDir = join(getHome(), '.lazy', 'bin');
  const hashFile = join(binDir, 'lazy-agent.hash');

  try {
    if (existsSync(hashFile)) {
      unlinkSync(hashFile);
    }
  } catch (err) {
    // Not fatal: a surviving hash file only means ensureAgentBinary may consider
    // the existing binary current. Say so rather than swallowing it.
    logger.warn(
      `Could not remove ${hashFile} (${err instanceof Error ? err.message : String(err)}); ` +
      `the agent binary may not be rebuilt.`,
    );
  }

  const path = await ensureAgentBinary();
  const verdict = await verifyAgentBinary(path);
  if (!verdict.ok) {
    throw new Error(
      formatAgentBinaryError(path, verdict.reason, { canRebuild: !!getLazyDevSourceRoot() }),
    );
  }
  return path;
}

/**
 * True when lazy is running from a source checkout (so a rebuild is possible).
 * Mirrors the detection in src/capture/claude.ts; used only to pick the right
 * remedy text.
 */
function getLazyDevSourceRoot(): string | null {
  const candidate = join(import.meta.dir, '..', '..', '..');
  return existsSync(join(candidate, 'src', 'agent-entry.ts')) ? candidate : null;
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
export async function promptBuilderPreStop(
  builderCount: number,
  force: boolean,
  interactiveSessions: InteractiveSessionEntry[] = [],
): Promise<void> {
  if (builderCount === 0 && interactiveSessions.length === 0) return;

  console.log('');
  if (builderCount > 0) {
    const noun = builderCount === 1 ? 'builder session' : 'builder sessions';
    console.log(theme.warning(`${builderCount} ${noun} will be restarted to apply the upgrade.`));
    console.log('  The conversation is preserved and resumes automatically — but any message');
    console.log('  typed into a builder and not yet submitted CANNOT be preserved.');
  }

  // Interactive sessions (`lazy pair`, `lazy chat`) are NOT stopped from here.
  // Each interactive supervisor watches the daemon generation itself and
  // restarts its own Claude Code once the new daemon is up
  // (src/supervisor/interactive.ts) — one mechanism, no race with this command.
  // What upgrade owes the human is VISIBILITY: before this change a live pair
  // or chat session was invisible to `lazy upgrade` entirely, so a human at
  // that terminal got no warning at all.
  if (interactiveSessions.length > 0) {
    const noun = interactiveSessions.length === 1 ? 'interactive session' : 'interactive sessions';
    console.log(theme.warning(`${interactiveSessions.length} ${noun} will be restarted to apply the upgrade.`));
    for (const entry of interactiveSessions) {
      console.log(`  ${describeInteractiveSession(entry)}`);
    }
    console.log('  Each resumes itself against the new daemon — but any message typed into a');
    console.log('  pair or chat session and not yet submitted CANNOT be preserved.');
  }

  // --force or non-TTY: never block. Document that we proceed without waiting.
  if (force || !isTTY()) {
    console.log(theme.warning('  Proceeding without prompting (--force or no TTY); unsent input may be lost.'));
    return;
  }

  console.log('  If you have an unsent message in a builder or a pairing session, submit it now.');
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
async function refreshImagesOnly(root: string, dryRun: boolean, timeoutMs: number): Promise<void> {
  const config = await loadConfig(root);
  const isContainerRunner = config.runner.type === 'docker' || config.runner.type === 'podman';
  if (!isContainerRunner) {
    console.error(`Error: \`lazy upgrade --images\` only applies to container runners (docker/podman).`);
    console.error(`The current runner is '${config.runner.type}', which has no container image —`);
    console.error(`the agent CLI runs from your host installation. Update it there instead.`);
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
    await printImageSource(root);
    console.log('  No containers stopped, no daemon restart, agent binary untouched.');
    console.log('');
    printImageRefreshBoundary();
    return;
  }

  // Ask about worktree adoption before the build starts — same ordering
  // constraint as the full upgrade's background rebuild.
  await maybePromptWorktreeDockerfileAdoption(root);

  console.log('\nRefreshing container image for future sessions (--no-cache)...');
  await printImageSource(root);
  const built = await forceRebuildImage(root, binary, timeoutMs);
  console.log(`  ${theme.success('rebuilt')} container image (${built})`);
  console.log('');
  printImageRefreshBoundary();
  console.log(theme.success('\nImage refresh complete.'));
}

/** How often to reassure the human that a slow background build is still alive. */
const BUILD_PROGRESS_INTERVAL_MS = 15_000;

/**
 * Collect the background rebuild at the point the upgrade used to build, and
 * promote it onto the canonical image tag.
 *
 * By the time we get here the build has usually finished while the human was
 * deciding and the containers were stopping — in which case this returns
 * immediately. If it is still running we say so and keep saying so, rather than
 * sitting silent through a multi-minute build.
 *
 * A failed build throws (see BackgroundImageBuild.finish) — no silent fallback
 * to the old image.
 */
async function promoteBackgroundImage(build: BackgroundImageBuild): Promise<string[]> {
  if (build.status() === 'building') {
    console.log(`  waiting for the background image rebuild (${build.elapsedSeconds()}s elapsed so far)...`);
  }

  const ticker = setInterval(() => {
    if (build.status() === 'building') {
      console.log(`  still building the container image... (${build.elapsedSeconds()}s elapsed)`);
    }
  }, BUILD_PROGRESS_INTERVAL_MS);

  try {
    const tags = await build.promote();
    console.log(`  ${theme.success('rebuilt')} container image (${tags.join(', ')}) in ${build.elapsedSeconds()}s`);
    return tags;
  } finally {
    clearInterval(ticker);
  }
}

export async function commandUpgrade(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'force', takesValue: false },
    { name: 'wait', takesValue: false },
    { name: 'dry-run', takesValue: false },
    { name: 'images', takesValue: false },
    BUILD_TIMEOUT_FLAG,
  ], 'upgrade');

  const force = parsed.flags.get('force') === true;
  const wait = parsed.flags.get('wait') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const images = parsed.flags.get('images') === true;
  const timeoutMs = resolveBuildTimeoutMs(parsed.flags.get('timeout') as string | undefined, 'upgrade');

  if (force && wait) {
    console.error('Error: --force and --wait are mutually exclusive.');
    process.exit(1);
  }

  const root = requireLazyRoot();

  // `lazy upgrade` IS the explicit image-build path. Opt into path-based
  // adoption resolution (vs soft-pin on launches) so a just-written
  // adopted-image.json is what this command builds from. Soft-pin stays off
  // for the daemon this command restarts — that process never calls this.
  enableUpgradeImageBuild();

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
    await refreshImagesOnly(root, dryRun, timeoutMs);
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

  // Declared out here so the `finally` can abandon a still-running background
  // rebuild on every exit path that is not a completed upgrade.
  let imageBuild: BackgroundImageBuild | null = null;

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

    // Interactive sessions (`lazy pair`, `lazy chat`) are host processes, not
    // runs, so no runner discovery can see them — which is exactly why a live
    // pair or chat session used to survive an upgrade unmentioned. They are
    // listed, never stopped from here: each interactive supervisor notices the
    // daemon restart itself and restarts its own Claude Code
    // (src/supervisor/interactive.ts).
    const interactiveSessions = await listInteractiveSessions(root);

    // Dry run: show what would happen
    if (dryRun) {
      console.log(theme.header('Upgrade dry run:'));
      console.log('');
      console.log('  Rebuild: Docker image + agent binary');
      console.log('  The image rebuild starts in the background while you decide, staged under');
      console.log('  a temporary tag; the real image tag moves only once you proceed.');
      console.log('');

      const totalContainers = containers.length + builderContainers.length;
      if (totalContainers === 0 && interactiveSessions.length === 0) {
        console.log('  No running containers or interactive sessions found.');
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

        if (interactiveSessions.length > 0) {
          if (totalContainers > 0) console.log('');
          console.log(`  ${interactiveSessions.length} interactive session(s):`);
          for (const entry of interactiveSessions) {
            console.log(`    ${describeInteractiveSession(entry)}`);
          }
          console.log('');
          console.log(theme.warning('  Interactive sessions restart themselves once the new daemon is up; they are'));
          console.log('  not stopped by this command.');
        }
      }

      console.log('');
      console.log('  After rebuild: daemon restarts and auto-resumes interrupted tasks (~10s).');
      console.log('  Running builder sessions resume in place after the upgrade.');

      // Deleting files from the human's repo and rotating a credential are the
      // two most surprising things a real upgrade would do, so a dry run must
      // name both rather than only describing the rebuild.
      const legacy = await findLegacyDaemonMcpConfigs(root);
      if (legacy.length > 0) {
        console.log('');
        console.log(theme.warning(`  ${legacy.length} leaked pre-v0.20 MCP config(s) would be removed from`));
        console.log(`  ${legacyMcpConfigDir(root)} — each contains the shared daemon token and is`);
        console.log('  readable by every agent that mounts this repo. The shared daemon token');
        console.log('  would be rotated in the same step (host CLI clients re-read it automatically).');
      }

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

    // Start the container image rebuild NOW, in the background.
    //
    // Everything between here and the rebuild step — waiting for working agents
    // to block, the human's stop/wait/cancel decision, the builder pre-stop
    // prompt, stopping containers — is independent of the image content. The
    // build writes a STAGING tag, so running containers and any container
    // created in the meantime keep resolving the current image; the canonical
    // tag moves only after the human has committed (promoteBackgroundImage).
    const config = await loadConfig(root);
    const isContainerRunner = config.runner.type === 'docker' || config.runner.type === 'podman';
    if (isContainerRunner) {
      // The background rebuild reads adoption / Dockerfile resolution at start
      // time — ask before kicking it off so the human's answer can change what
      // gets built, and so adoption is cleared/rewritten for this rebuild.
      await maybePromptWorktreeDockerfileAdoption(root);

      imageBuild = startBackgroundImageBuild(root, config.runner.type, undefined, timeoutMs);
      console.log(`\nRebuilding the container image in the background (staged as :${imageBuild.stagingTag})...`);
      await printImageSource(root);
      console.log('  Running containers are untouched; the image is promoted only once you proceed.');
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
        // process.exit skips the `finally` below, so abandon the background
        // build here — otherwise its build client outlives this process.
        await imageBuild?.cancel();
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

    // The human has committed to the upgrade — but nothing has been stopped
    // yet. If the background rebuild has ALREADY failed, say so now and abort
    // while every container is still running and the current image is intact.
    // (A build still in flight is collected after the stops, below.)
    if (imageBuild && imageBuild.status() === 'failed') {
      console.error('');
      console.error(theme.error('Upgrade aborted: the background container image rebuild failed.'));
      console.error(imageBuild.error()?.message ?? 'unknown build error');
      console.error('');
      console.error('Nothing was stopped and your current image is unchanged — running');
      console.error('builders and agents are still on it. Fix the build and re-run `lazy upgrade`.');
      await imageBuild.cancel();
      process.exit(1);
    }

    // Pre-stop prompt: give the human a chance to submit any in-progress
    // message in a live builder before its container is killed. Honors
    // "never lose human feedback" (CLAUDE.md). Skipped under --force / non-TTY.
    await promptBuilderPreStop(builderContainers.length, force, interactiveSessions);

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

    // Step 2: Collect the background image build (usually already finished
    // while we waited and stopped containers), promote it onto the canonical
    // image tag, and rebuild the agent binary.
    console.log('\nRebuilding...');
    if (imageBuild) {
      // The binary rebuild is independent of the image — run it alongside the
      // (possibly still-running) build rather than after it.
      // A failed image build must still fail the upgrade — but only after the
      // binary rebuild has settled, so nothing is left half-awaited. Capture
      // the image error instead of racing it, then re-throw.
      const [, imageError] = await Promise.all([
        forceRebuildAgentBinary().then(() => console.log(`  ${theme.success('rebuilt')} agent binary (verified)`)),
        promoteBackgroundImage(imageBuild).then(() => null, (err: unknown) => err),
      ]);
      if (imageError) throw imageError;
    } else {
      // Host-process mode: no container image, only the agent binary.
      await forceRebuildAgentBinary();
      console.log(`  ${theme.success('rebuilt')} agent binary (verified)`);
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
        // Best-effort: cleanupStaleFiles refuses if the SIGKILL somehow didn't
        // land (lock still held / pid still alive). Refusing is the right
        // outcome there — the files belong to a daemon that is still up.
        cleanupStaleFiles(root);
      }
    }

    // Step 3a: purge pre-v0.20 MCP configs that leaked the shared daemon token
    // into the repo, and rotate that token.
    //
    // THIS IS THE ONLY SAFE POINT IN THE WHOLE FLOW, and the placement is the
    // feature: every task and builder container was stopped in step 1 and the
    // old daemon has just exited, so nobody is holding the shared token in a
    // container (the one class that could not re-read it from disk). The new
    // daemon has not started yet, so it adopts the fresh token on its first
    // read. Rotating any earlier — while the old daemon still served RPC —
    // would 401 the upgrade's own `requestShutdown`. See
    // src/upgrade/legacy-mcp-purge.ts for the full blast-radius argument.
    await purgeLegacyDaemonMcpConfigsReporting(root);

    await ensureDaemon('upgrade', root);
    console.log('  Daemon restarted with new version.');

    if (containers.length > 0) {
      console.log(`\n  ${containers.length} interrupted task(s) will auto-resume within ~10 seconds.`);
    }

    console.log(theme.success('\nUpgrade complete.'));
  } finally {
    // Abandon a background rebuild that was never promoted (cancelled upgrade,
    // ctrl-c out of a prompt, or a failure anywhere in the flow). cancel() is a
    // no-op once promoted, never throws, and leaves the canonical image tag
    // exactly where it was — the built layers stay in the runtime's build cache
    // so the next upgrade starts warm.
    if (imageBuild && imageBuild.status() !== 'succeeded') {
      const wasBuilding = imageBuild.status() === 'building';
      await imageBuild.cancel();
      if (wasBuilding) {
        console.log('  (background image rebuild abandoned; your current image is unchanged,');
        console.log('   and its layers remain cached for the next upgrade)');
      }
    }
    await storage.close();
  }
}

export function upgradeUsage(): void {
  console.log(`Usage: lazy upgrade [--force] [--wait] [--dry-run] [--timeout <seconds>]
       lazy upgrade --images [--dry-run] [--timeout <seconds>]

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
  1. The Docker image rebuild starts immediately, in the BACKGROUND, under a
     temporary staging tag — it does not wait for your decisions and does not
     touch running containers
  2. Live builder sessions are warned to submit any in-progress message
  3. All running lazy containers are stopped (task supervisors and builders)
  4. The background image is promoted onto the real image tag (usually already
     built by now) and the agent binary is force-rebuilt
  5. Daemon is restarted with new code
  6. Daemon auto-reconciles and auto-resumes interrupted tasks (~10 seconds)
  7. Running builder sessions resume in place with their conversation intact

Because the image tag only moves in step 4, cancelling the upgrade (or ctrl-c)
leaves your current image exactly as it was; the layers already built stay in
the container runtime's build cache, so the next upgrade starts warm. If the
background rebuild fails, the upgrade fails loudly — it never silently carries
on with the old image.

If any containers are in 'working' state (mid-turn), you'll be prompted with
three options: stop and upgrade now, wait for tasks to finish, or cancel.
Mid-turn work will be lost if you stop, but tasks resume from their last
checkpoint.

If any builder sessions are running, you'll be warned to submit any in-progress
message before they restart — their conversation resumes automatically, but a
typed-but-unsent message cannot be preserved. With --force or no TTY this
warning is printed but not blocked on, and unsent builder input may be lost.

When run interactively from a task worktree whose Dockerfile.lazy differs from
the project root's, you'll be asked whether to adopt the worktree's copy for
the image build AND the restarted daemon (and all launches without a per-task
image pin). Adoption sticks until the next upgrade rebuild decides again.
Without a TTY the question is skipped (the default root Dockerfile applies, and
any prior adoption is cleared).

Options:
  --force     Don't prompt, stop everything including working containers
  --wait      Wait for all working tasks to block before upgrading
  --images    Non-disruptive: rebuild only the container image (--no-cache) for
              future sessions; stop nothing, don't restart the daemon
  --dry-run   Show what would be rebuilt and stopped, without doing anything
  --timeout <seconds>
              Kill the image build after N seconds (default: no timeout).
              Builds are unbounded by default: one killed on a timer wastes the
              whole wall-clock it ran for and produces nothing.

--force and --wait are mutually exclusive. --images does not stop containers, so
it cannot be combined with --force or --wait.

Examples:
  lazy upgrade              # Interactive: prompt if working tasks exist
  lazy upgrade --force      # Non-interactive: stop everything and rebuild
  lazy upgrade --wait       # Non-interactive: wait for tasks to finish, then upgrade
  lazy upgrade --images     # Non-disruptive: refresh the image for future sessions
  lazy upgrade --dry-run    # Preview what would happen`);
}
