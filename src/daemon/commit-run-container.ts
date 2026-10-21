/**
 * A COMMIT RUN's container (./commit-run.ts): the product at one commit, with
 * the project's image and the project's `[serve]` ports, and NO agent
 * credential of any kind.
 *
 * Modelled on a member's terminal container (./member-container.ts), not on a
 * task's: nothing of lazy's agent machinery is in it. Concretely it gets
 *
 *   - the project's image, resolved exactly as a turn's is (the project's own
 *     image, an adoption, or lazy's default image when a person chose it for
 *     this run while the project's was not ready — never silently);
 *   - the checkout read-write over the repository read-only, `.lazy/` masked,
 *     and the split git mounts with read-only copies of the pointer files, so
 *     the container can read, build and commit locally but never move a ref,
 *     rewrite config or plant a hook the host's git would run;
 *   - the ROOT config's `[serve]` ports published (a branch's own lazy.toml has
 *     no authority), and the project's `[[mounts]]` / `[docker] run_args` as
 *     they apply to a member's container — no shared mount turns can write, no
 *     network or port flags of the project's own;
 *   - the run's own environment and files: the project's "always" entries a
 *     control plane pushed under the run's id (./task-env.ts, ./task-files.ts);
 *   - its own network {@link RUN_NETWORK_SPEC}, inter-container traffic off, so
 *     no turn can reach a run's ports and no run a turn's (docker; podman runs
 *     join podman's default network, as task containers do).
 *
 * and NOTHING else: no `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_BASE_URL`, no other agent's key, no MCP config or token, no
 * protocol dir, no `lazy-agent` binary, no agent home. Its command is
 * `sleep infinity`; Start services and a shell exec into it. Pinned by
 * test/unit/commit-run-container-args.test.ts.
 *
 * Named `lazyrun-…` (src/run/identity.ts), never `lazy-…`: the sweeps that
 * treat a `^lazy-` container as a task supervisor must not touch it. Found by
 * label instead, at daemon start and shutdown ({@link removeRunContainers}).
 * Nothing stops it for being idle — there is no idle stop for task services
 * either — and nothing ever starts one by itself.
 */

import { ensureImage } from '../capture/claude';
import { RunnerImageNotReadyError, DEFAULT_RUNNER_IMAGE_PIN } from '../capture/custom-image-gate';
import { dataDirOfWorktree, lazyDataDirMaskArgs } from '../capture/lazy-dir-mask';
import { buildTaskGitMounts } from '../capture/git-mounts';
import { probeContainerGitPointers } from '../git/container-pointers';
import { withDeliveredFilesGitConfig, deliveredExcludeFileFor } from '../git/delivered-files-exclude';
import { createRunner } from '../runner';
import { PROJECT_LABEL } from '../runner/docker-runner';
import { buildPublishArgs } from '../serve/ports';
import { loadConfig } from '../config/loader';
import { pathExists } from '../utils/fs';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';
import { describeRunnerImage } from './runner-image';
import { RUNNER_IMAGE_NOT_READY_MARKER } from './runner-image-choice';
import { getOrCreateStorage } from './rpc-handlers';
import { getTaskEnv, mustRecreateForTaskEnv, planTaskEnvLaunchFile, recordTaskEnvLaunched } from './task-env';
import { deliverTaskFilesForLaunch } from './task-files';
import { ensureIsolatedNetwork, memberContainerCommand, memberMountPlan, type IsolatedNetworkSpec } from './member-container';
import { ensureRunCheckout, withRunLock } from './commit-run-checkout';
import { RUN_CONTAINER_LABEL, RUN_CONTAINER_PREFIX, describeCommitRunTarget, runContainerName, runWorktreePath } from '../run/identity';
import type { PhaseNotify } from './progress';
import type { CommitRun } from '../storage/types';
import type { Storage } from '../storage';

/** The network every run container joins (docker) — see the header. */
export const RUN_NETWORK_SPEC: IsolatedNetworkSpec = {
  name: 'lazy-runs',
  bridge: 'lzruns0',
  label: 'lazy.run-network',
  purpose: 'commit runs',
};

/** The container CLI a runner type drives. */
function binaryFor(runnerType: string): string {
  return runnerType === 'podman' ? 'podman' : 'docker';
}

export interface RunContainerArgsParams {
  binary: string;
  name: string;
  imageName: string;
  repoRoot: string;
  runId: string;
  worktreePath: string;
  /** The network to join, or null for the runtime's default (podman). */
  network: string | null;
  /** Built with `buildTaskGitMounts`: the split git mount plus read-only pointer copies. */
  gitMountArgs: string[];
  /** Paths the container user must be able to write (checkout, its gitdir, the objects dir). */
  adoptPaths: string[];
  /** Read-only-by-design paths inside {@link adoptPaths} (the git pointer copies). */
  readOnlyPaths: string[];
  /** `-p` args for the ROOT config's `[serve]` ports (`buildPublishArgs`). */
  publishArgs: string[];
  /** The project's `[[mounts]]` as a member's container gets them (`memberMountPlan`). */
  customMountArgs: string[];
  /** The project's `run_args` as a member's container gets them (`memberMountPlan`). */
  runArgs: string[];
  /** The run's own environment: `planTaskEnvLaunchFile(...).args`. */
  envArgs: string[];
  /** Command-scope git config (the delivered-files exclude list), as env. */
  gitConfigEnv: Record<string, string>;
}

/**
 * The run container's argv. Pure, so what it holds — and above all what it
 * does NOT — is inspectable without docker.
 */
export function buildRunContainerDockerArgs(p: RunContainerArgsParams): string[] {
  return [
    p.binary, 'run', '-d', '--init',
    '--name', p.name,
    '--label', `${PROJECT_LABEL}=${p.repoRoot}`,
    '--label', `${RUN_CONTAINER_LABEL}=${p.runId}`,
    ...(p.network ? ['--network', p.network] : []),
    // The same file view a turn has: repo read-only, checkout read-write on top.
    '-v', `${p.repoRoot}:${p.repoRoot}:ro`,
    ...lazyDataDirMaskArgs(dataDirOfWorktree(p.repoRoot, p.worktreePath)),
    '-v', `${p.worktreePath}:${p.worktreePath}`,
    ...p.gitMountArgs,
    '-w', p.worktreePath,
    // lazy's own, identical in every container it runs: git over ssh accepts a
    // host key it has not seen instead of hanging on a prompt in a shell
    // relayed through a browser. Fixed text.
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    ...Object.entries(p.gitConfigEnv).sort(([a], [b]) => a.localeCompare(b)).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...p.publishArgs,
    ...p.customMountArgs,
    ...p.runArgs,
    ...p.envArgs,
    p.imageName,
    // Nothing of lazy's runs in here: the container stays up for services and
    // shells to exec into, after taking ownership of what it must write when
    // the daemon's user is not the container's (a root daemon on Linux).
    'sh', '-c', memberContainerCommand(p.adoptPaths, p.readOnlyPaths),
  ];
}

export interface EnsureRunContainerParams {
  runId: string;
  /** Narration of the bring-up (image resolution can be minutes of `docker build`). */
  notify?: PhaseNotify;
  /** Recreate even when one is running — the only way a `[serve]` change reaches a live run. */
  restart?: boolean;
  /** Narration sink for RECREATING THE CHECKOUT only; its first call opens that phase. */
  restoreProgress?: PhaseNotify;
  /** Called once, just before a container is launched. */
  onLaunching?: () => void;
}

export interface EnsureRunContainerResult {
  containerName: string;
  worktreePath: string;
  runnerType: string;
  alreadyRunning: boolean;
}

export interface EnsureRunContainerDeps {
  getStorage?: () => Promise<Storage>;
  createRunner?: typeof createRunner;
  /** `docker run -d` and friends; returns exit code and stderr. */
  run?: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>;
  ensureImage?: (binary: string, opts: { pinnedImage?: string; notify?: PhaseNotify }) => Promise<string>;
  ensureNetwork?: (binary: string) => Promise<void>;
}

async function runCaptured(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = spawn(argv, { stdout: 'ignore', stderr: 'pipe', timeout: 120_000 });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode: exitCode ?? 1, stderr };
}

/** A run by id or slug, or the 404 a route answers with. */
export async function resolveCommitRun(storage: Storage, ref: string): Promise<CommitRun> {
  const run = (await storage.getCommitRun(ref)) ?? (await storage.getCommitRunBySlug(ref));
  if (!run) throw new RpcError(404, `Run not found: ${ref}`);
  return run;
}

/**
 * Make sure the run's container is up, creating it (and its checkout) when it
 * is not. A running container is kept unless `restart`, its environment
 * changed since it was created, or its mounted git pointers no longer match.
 */
export async function ensureRunContainer(
  projectRoot: string,
  params: EnsureRunContainerParams,
  deps: EnsureRunContainerDeps = {},
): Promise<EnsureRunContainerResult> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  const initial = await resolveCommitRun(storage, params.runId);
  return withRunLock(initial.slug, async () => {
    // Re-read under the lock: a Pull may have moved it, a Remove deleted it.
    const run = await storage.getCommitRun(initial.id);
    if (!run) throw new RpcError(404, `Run not found: ${params.runId} (it was removed).`);
    const runner = await (deps.createRunner ?? createRunner)(projectRoot);
    const containerName = runContainerName(projectRoot, run.slug);
    const worktreePath = runWorktreePath(projectRoot, run.slug);
    if (!runner.usesSandbox()) {
      throw new RpcError(400,
        `This project runs on the ${runner.type} runner, which has no containers — a run needs one to publish its services in.`);
    }
    const binary = binaryFor(runner.type);

    let running = await runner.isRunning(containerName);
    if (running && !(await pathExists(worktreePath))) {
      params.notify?.("Recreating the run's container: its checkout is missing.");
      await removeRunContainer(binary, containerName);
      running = false;
    }
    const checkout = await ensureRunCheckout(projectRoot, run, params.restoreProgress ?? params.notify);

    if (running) {
      const pointers = await probeContainerGitPointers(projectRoot, worktreePath, runner, containerName);
      if (pointers.kind === 'unavailable') {
        throw new RpcError(503, `Cannot check the mounted git pointers of ${containerName}: ${pointers.reason} Container left untouched.`);
      }
      const envStale = await mustRecreateForTaskEnv(projectRoot, run.id, containerName);
      if (!params.restart && pointers.kind === 'healthy' && !envStale) {
        return { containerName, worktreePath, runnerType: runner.type, alreadyRunning: true };
      }
      if (envStale) params.notify?.("Recreating the run's container: its environment variables changed since it was created.");
      else if (pointers.kind === 'broken') params.notify?.("Recreating the run's container: its mounted git pointers do not match the checkout.");
    }

    params.onLaunching?.();
    await launchRunContainer(projectRoot, run, { binary, containerName, worktreePath, notify: params.notify }, deps);
    logger.info(`Started the container for run ${run.slug} (${describeCommitRunTarget(run)} at ${run.head_sha.slice(0, 12)})${checkout.created ? ', with a fresh checkout' : ''}.`);
    return { containerName, worktreePath, runnerType: runner.type, alreadyRunning: false };
  });
}

async function launchRunContainer(
  projectRoot: string,
  run: CommitRun,
  where: { binary: string; containerName: string; worktreePath: string; notify?: PhaseNotify },
  deps: EnsureRunContainerDeps,
): Promise<void> {
  const { binary, containerName, worktreePath, notify } = where;
  const exec = deps.run ?? runCaptured;
  // The run's own files (the project's "always" files a control plane pushed
  // under the run's id), before the container sees the checkout.
  await deliverTaskFilesForLaunch(projectRoot, run.id, worktreePath, notify);

  // The ROOT config: a branch's lazy.toml has no authority over what is
  // published or mounted (src/config/loader.ts).
  const config = await loadConfig(projectRoot);
  const mounts = await memberMountPlan(projectRoot, worktreePath, config);
  if (mounts.droppedRunArgs.length > 0) {
    logger.info(`Run ${run.slug}: not applying these [docker] run_args, the run is on its own network: ${mounts.droppedRunArgs.join(', ')}.`);
  }
  if (mounts.omittedMounts.length > 0) {
    logger.info(`Run ${run.slug}: not mounting these, because agents' turns can write them: ${mounts.omittedMounts.join(', ')}.`);
  }
  // Checked by reading the pointer files, never by running git that would
  // follow them; the container gets read-only copies of what was checked.
  const git = await buildTaskGitMounts(projectRoot, worktreePath);

  let imageName: string;
  try {
    imageName = await (deps.ensureImage ?? ensureImage)(binary, {
      pinnedImage: run.image_choice === 'default' ? DEFAULT_RUNNER_IMAGE_PIN : undefined,
      notify,
    });
  } catch (err) {
    if (err instanceof RunnerImageNotReadyError) {
      throw new RpcError(409,
        `Not started: ${RUNNER_IMAGE_NOT_READY_MARKER}. ${describeRunnerImage()} ` +
        `It starts once the image is ready, or now on lazy's default image if you choose that for this run.`,
        'runner_image_not_ready');
    }
    throw new RpcError(500, `Could not resolve the image for run ${run.slug}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let network: string | null = null;
  if (binary === 'docker') {
    try {
      await (deps.ensureNetwork ?? ((b: string) => ensureIsolatedNetwork(b, RUN_NETWORK_SPEC)))(binary);
    } catch (err) {
      throw new RpcError(500, `Could not prepare the network for run ${run.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
    network = RUN_NETWORK_SPEC.name;
  }

  const vars = await getTaskEnv(projectRoot, run.id);
  const envFile = planTaskEnvLaunchFile(projectRoot, containerName, vars);
  const exclude = await deliveredExcludeFileFor(worktreePath);
  const argv = buildRunContainerDockerArgs({
    binary,
    name: containerName,
    imageName,
    repoRoot: projectRoot,
    runId: run.id,
    worktreePath,
    network,
    gitMountArgs: git.args,
    adoptPaths: [worktreePath, git.paths.worktreeGitDir, git.paths.objectsDir],
    readOnlyPaths: git.pointerTargets,
    publishArgs: buildPublishArgs(config.serve.services),
    customMountArgs: mounts.customMountArgs,
    runArgs: mounts.runArgs,
    envArgs: envFile.args,
    gitConfigEnv: withDeliveredFilesGitConfig({}, exclude).set,
  });

  // A stopped container of the same name makes `run --name` fail, and would
  // carry the old published ports anyway.
  await removeRunContainer(binary, containerName);
  notify?.(`starting the run's container on ${imageName}`);
  await envFile.write();
  try {
    const ran = await exec(argv);
    if (ran.exitCode !== 0) {
      await removeRunContainer(binary, containerName).catch((err) => {
        logger.warn(`Could not remove the half-created run container ${containerName}: ${err instanceof Error ? err.message : String(err)}`);
      });
      throw new RpcError(500, `Could not start the container for run ${run.slug}: ${ran.stderr.trim() || `${binary} run exited ${ran.exitCode}`}`);
    }
  } finally {
    await envFile.cleanup();
  }
  await recordTaskEnvLaunched(projectRoot, run.id, containerName, vars);
}

/** `rm -f` a run container. "No such container" is success. */
export async function removeRunContainer(binary: string, name: string): Promise<void> {
  if (!name.startsWith(RUN_CONTAINER_PREFIX)) throw new Error(`Refusing to remove '${name}': not a run container.`);
  const proc = spawn([binary, 'rm', '-f', name], { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !/no such container/i.test(stderr)) {
    throw new Error(`could not remove run container ${name}: ${stderr.trim() || `exit ${code}`}`);
  }
}

/** Stop (remove) a run's container, keeping its checkout and record. False when none was running. */
export async function stopRunContainer(projectRoot: string, run: CommitRun): Promise<{ stopped: boolean }> {
  const runner = await createRunner(projectRoot);
  if (!runner.usesSandbox()) return { stopped: false };
  const name = runContainerName(projectRoot, run.slug);
  const was = await runner.isRunning(name);
  await removeRunContainer(binaryFor(runner.type), name);
  return { stopped: was };
}

/**
 * Remove every run container of this project — by LABEL, never by name
 * prefix alone. Run at daemon START (what the previous daemon left) and at
 * SHUTDOWN, exactly as task containers are stopped then: services never come
 * back by themselves after a restart, and the run's record and checkout stay,
 * so the next Run services starts it again.
 */
export async function removeRunContainers(
  projectRoot: string,
  binary: string,
  deps: { list?: () => Promise<string>; remove?: (binary: string, name: string) => Promise<void> } = {},
): Promise<{ removed: number; failed: Array<{ name: string; error: string }> }> {
  if (!deps.list && !Bun.which(binary)) return { removed: 0, failed: [] };
  const stdout = await (deps.list ?? (async () => {
    const proc = spawn(
      [binary, 'ps', '-a',
        '--filter', `label=${RUN_CONTAINER_LABEL}`,
        '--filter', `label=${PROJECT_LABEL}=${projectRoot}`,
        '--format', '{{.Names}}'],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    );
    const [out, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`could not list run containers: ${stderr.trim() || `exit ${code}`}`);
    return out;
  }))();
  let removed = 0;
  const failed: Array<{ name: string; error: string }> = [];
  await Promise.all(stdout.split('\n').map((l) => l.trim()).filter((n) => n.startsWith(RUN_CONTAINER_PREFIX)).map(async (name) => {
    try {
      await (deps.remove ?? removeRunContainer)(binary, name);
      removed += 1;
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }));
  return { removed, failed };
}
