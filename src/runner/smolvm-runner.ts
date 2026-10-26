/**
 * The `smolvm` runner: task containers on a per-project smolvm machine's own
 * dockerd, with the daemon staying on the host
 * (docs/design/ic-mode-smolvm-shape.md, shape (b)).
 *
 * It IS the docker runner. Every launch, probe, exec and stop runs through
 * {@link DockerRunner}'s code with one difference: its `docker` is a script
 * that aims the host's docker CLI at the machine's engine through a unix
 * socket this process owns (src/vm/docker-relay.ts). The bind mounts the docker
 * runner builds are `<path>:<path>` from the host's view, and the machine
 * shares every directory they live under at the identical path
 * (src/vm/smolvm-project-machine.ts), so they resolve unchanged in the guest.
 *
 * Creating the runner is cheap and never fails over the machine: it writes the
 * script and starts this process's relay. Two gates, deliberately different:
 *
 *   - LAUNCHES (`checkAvailability`, `ensureReady`, `prepareLaunchInputs`,
 *     `launchSupervisor`, `runOneshot`, a daemon image build) check the smolvm
 *     pin and the machine record, then create or start the machine and ensure
 *     its dockerd. A failure is reported with what to do, ending in the one
 *     "run lazy doctor" pointer. There is no fallback to any other engine.
 *   - Every other docker command (ps, inspect, logs, stop, rm) needs only a
 *     RUNNING machine. Refusing those too would make the containers of a
 *     machine that needs recreating look dead and impossible to stop.
 *
 * Liveness never guesses: a stopped or absent machine runs no container, but
 * a running machine whose engine does not answer makes `isRunning` throw
 * (unknown), which every caller treats as "cannot tell", never "dead".
 *
 * Containers reach the daemon and its credential proxy, and the host reaches
 * task services, over the machine's two create-time routes
 * (src/vm/solo-routes.ts): the guest relays send a container's
 * `host.docker.internal` calls through smolvm's one guest-to-host mapping to
 * this process's ROUTE MUX (daemon only), and a task's published guest ports
 * are reached through SERVICE TUNNELS to the machine's one published port —
 * which is what {@link SmolvmRunner.getRunPortBindings} answers with, so
 * `lazy url`, the dashboard and the serve proxy need nothing smolvm-specific.
 *
 * NOT YET HERE, and each a seam for its own change: `lazy shell` / `lazy pair`,
 * and the builder, which mounts the user's real `~/.claude` (it is refused
 * below rather than shared into the machine).
 */
import { chmod, lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink } from 'fs/promises';
import { spawn } from '../utils/spawn';
import { pathExists } from '../utils/fs';
import { basename, dirname, join } from 'path';
import type { ResolvedConfig } from '../config/types';
import { DockerRunner } from './docker-runner';
import { assertSiblingContainerLaunchSupported } from './sibling-containers';
import { registerSmolvmEngine, smolvmStateRoot } from '../vm/smolvm-engines';
import { getUserBinDir } from '../capture/claude';
import { ensureProtocolDir, protocolBase } from '../protocol/io';
import { getMcpConfigDir } from '../daemon/paths';
import { oneshotCwd } from '../oneshot/state-dir';
import { resolveProjectCommonDir } from '../git/worktree-pointers';
import { runArgMounts } from '../daemon/member-container';
import { smolvmCliRunner, type SmolvmRunner as SmolvmCli } from '../vm/smolvm-docker-machine';
import { verifySmolvmBinary } from '../vm/smolvm-release';
import {
  RUN_DOCTOR, SoloSmolvmMachine, recreateCommands, smolvmProtocolProjectDir, soloMachineName, soloMachineStateDir, type SoloShareInputs,
} from '../vm/smolvm-project-machine';
import {
  RelaySocketError, makeRelaySocketDir, relayShimPath, relaySocketBase, shimScript, smolvmDial, startDockerRelay,
  sweepDeadRelayFiles, writeShim, type DialedProcess, type RelayHandle,
} from '../vm/docker-relay';
import type { DiagnoseOptions, HealthCheck, LaunchBuilderDetachedParams, LaunchBuilderDetachedResult, LaunchBuilderHeadlessParams, LaunchBuilderHeadlessResult, RunInfoProbe } from './types';
import type { OneshotRequest } from '../oneshot/types';
import type { AgentResponse } from '../types';
import type { PortBinding } from '../serve/ports';
import { getDaemonContext, hasDaemonContext } from '../daemon/context';
import { isDaemonRpcBypassed, tryRpc } from '../daemon/client';
import { ServiceTunnels, dialableHost, startRouteMux, type CallbackRoute, type CallbackTargets, type RouteMuxHandle } from '../vm/solo-routes';
import { assertRunnerAllowedInManagedMode } from './host-runner-gate';
import { logger } from '../utils/logger';

export { smolvmStateRoot };

export const SMOLVM_BINARY_ENV = 'LAZY_SMOLVM_BINARY';

const MISSING_DOCKER_CLI =
  'the smolvm runner drives the project machine\'s Docker engine with the docker command-line client on this ' +
  'machine, and there is no `docker` on PATH. Install the client alone (no Docker Desktop needed), e.g. ' +
  '`brew install docker` on macOS.';

/** Why the smolvm runner cannot run, said once with its fix and the doctor pointer. */
export class SmolvmRunnerError extends Error {
  constructor(message: string) {
    super(`The smolvm runner cannot run tasks: ${message}\n${RUN_DOCTOR}`);
    this.name = 'SmolvmRunnerError';
  }
}

/** Everything a smolvm runner needs from outside, injectable for tests. */
export interface SmolvmRunnerDeps {
  stateRoot: string;
  /** Where the private per-user relay-socket directory is made (`/tmp`). */
  socketRoot: string;
  /** The host's docker CLI, or null when there is none. */
  dockerCli: string | null;
  /** Verifies the smolvm launcher against the pin; resolves to it. */
  verifyBinary: (path: string) => Promise<string>;
  cli: (binary: string) => SmolvmCli;
  dial: (binary: string, machine: string) => () => DialedProcess;
  shareInputs: (projectRoot: string) => Promise<SoloShareInputs>;
}

/** The share inputs from the real paths lazy mounts from, creating the lazy-owned ones. */
export async function realShareInputs(projectRoot: string, config: ResolvedConfig): Promise<SoloShareInputs> {
  const inputs: SoloShareInputs = {
    projectRoot,
    gitCommonDir: await resolveProjectCommonDir(projectRoot),
    protocolProjectDir: smolvmProtocolProjectDir(protocolBase(), soloMachineName(projectRoot)),
    agentBinDir: getUserBinDir(),
    mcpConfigDir: getMcpConfigDir(projectRoot),
    oneshotDir: oneshotCwd(projectRoot),
    mounts: config.mounts,
    runArgSources: runArgMounts(config.docker.run_args)
      .flatMap((m) => (m.storage.kind === 'path' && m.storage.path.startsWith('/') ? [m.storage.path] : [])),
  };
  // A share must exist when the machine is created; these are lazy's own and
  // would otherwise appear only when the first task needs them.
  for (const dir of [inputs.protocolProjectDir, inputs.agentBinDir, inputs.mcpConfigDir, inputs.oneshotDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return inputs;
}

/**
 * What one machine's relay serves with. Mutable: every runner creation reloads
 * lazy.toml, and a changed `[smolvm]` section replaces the machine object the
 * relay brings up (the relay socket and script stay).
 */
interface MachineTarget { config: ResolvedConfig; deps: SmolvmRunnerDeps; machine: SoloSmolvmMachine; key: string; projectRoot: string }

/** This process's service tunnels (the daemon's are the ones anything uses). */
const serviceTunnels = new ServiceTunnels();
/** The route mux per machine, in the daemon only. */
const routeMuxes = new Map<string, Promise<RouteMuxHandle>>();

/** One relay per machine per process, however many runners are created. */
const relays = new Map<string, Promise<{ relay: RelayHandle; shim: string; socket: string; target: MachineTarget }>>();

export class SmolvmRunner extends DockerRunner {
  constructor(
    lazyRoot: string,
    shim: string,
    private readonly machine: SoloSmolvmMachine,
    private readonly bringUp: () => Promise<void>,
    /** The smolvm pin check (cached): run before ANY smolvm call this runner makes itself. */
    private readonly verifyPin: () => Promise<void> = async () => {},
    /** This process's relay socket to the machine's engine (src/vm/docker-relay.ts). */
    private readonly relaySocket: string | null = null,
  ) {
    super(shim, 'smolvm', lazyRoot);
  }

  /**
   * The Engine API socket a terminal streams over: this process's relay, never
   * the host's own Docker socket — that is a different engine, with none of
   * the task's containers.
   */
  override engineSocketPath(): string | null {
    return this.relaySocket;
  }

  get machineName(): string {
    return this.machine.name;
  }

  /**
   * Is the project's machine running, per `smolvm machine ls`? Changes
   * nothing; false when it is stopped, absent, or smolvm cannot say.
   */
  async machineRunning(): Promise<boolean> {
    if (!(await pathExists(this.machine.recordPath))) return false;
    await this.verifyPin(); // an unpinned smolvm is never run; the sweep reports the reason
    try { return (await this.machine.listedState()) === 'running'; }
    catch { return false; } // unknown: a sweep can wait for the next start or stop
  }

  protected override assertContainerLaunchSupported(what: string): void {
    assertSiblingContainerLaunchSupported(what, process.env, 'smolvm-guest');
  }

  /** Bring the project's machine up, reporting a failure as the runner's. */
  async ensureMachine(): Promise<void> {
    try {
      await this.bringUp();
    } catch (err) {
      if (err instanceof SmolvmRunnerError) throw err;
      throw new SmolvmRunnerError(err instanceof Error ? err.message : String(err));
    }
  }

  override async checkAvailability(): Promise<void> {
    this.assertContainerLaunchSupported('use the smolvm runner');
    await this.ensureMachine();
    // Ask the engine through the relay before the docker runner's own probe,
    // whose failure would name this runner's script as a Docker to install.
    const proc = spawn([this.containerCli, 'info', '--format', '{{.ServerVersion}}'], { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      throw new SmolvmRunnerError(
        `the Docker engine in smolvm machine ${this.machine.name} did not answer through lazy's relay: ${stderr.trim() || `exit ${code}`}`,
      );
    }
    await super.checkAvailability();
  }

  /**
   * The docker runner's diagnosis, asked of the MACHINE's engine and worded
   * for it. The host needs no Docker engine, so a machine that is not running
   * is not a failure here (doctor's smolvm rows say what state it is in), and
   * nothing ever reads "start Docker Desktop". The docker runner's
   * "Docker installed" row is dropped: the shim answers `--version` with the
   * host CLI, which doctor's own docker CLI row already reports.
   */
  override async diagnose(options: DiagnoseOptions = {}): Promise<HealthCheck[]> {
    const engine = `Docker engine in smolvm machine ${this.machine.name}`;
    let running: boolean;
    try { running = await this.machineRunning(); }
    catch { running = false; } // an unusable smolvm: doctor's smolvm binary row reports why
    if (!running) {
      return [
        { state: 'ok', what: `${engine} (not checked — the machine is not running, or lazy has no record of it)` },
        ...(await this.diagnoseUpstreams()),
      ];
    }
    const checks = await super.diagnose(options);
    return checks
      .filter((c) => !c.what.startsWith('Docker installed'))
      .map((c): HealthCheck => {
        if (!c.what.startsWith('Docker daemon running')) return c;
        if (c.state !== 'fail') return { ...c, what: `${engine} responds` };
        return {
          state: 'fail',
          what: `${engine} responds`,
          problem: `The Docker engine in smolvm machine ${this.machine.name} isn't responding`,
          // Stop dockerd first: a machine stop under a running dockerd can tear layers on its disk.
          reason: `The machine is running but its engine did not answer through lazy's relay. When no task is running, ` +
            `restart it (lazy starts it again on the next turn):\n` +
            recreateCommands(this.machine.smolvmBinary, this.machine.name).slice(0, 2).map((c) => `  ${c}`).join('\n'),
        };
      });
  }

  override async ensureReady(): Promise<void> {
    await this.ensureMachine();
    await super.ensureReady();
  }

  override async prepareLaunchInputs(notify?: (detail: string) => void): Promise<void> {
    await this.ensureMachine();
    await super.prepareLaunchInputs(notify);
  }

  /**
   * Is this run running? Asked through the relay; when the engine does not
   * answer, the MACHINE decides: stopped or gone means no container in it runs
   * (false), but a machine smolvm lists as running whose engine did not answer
   * — or a smolvm that cannot list — is UNKNOWN, and throws. Every caller of
   * `isRunning` treats a throw as "cannot tell" (the reconciler retries next
   * pass, `abandonIfRunIsGone` assumes alive, `probeWorkingRun` reports
   * liveness unknown); returning false would interrupt a turn whose container
   * may still be working.
   */
  override async isRunning(runName: string): Promise<boolean> {
    const proc = spawn([this.containerCli, 'ps', '--filter', `name=^/${runName}$`, '--format', '{{.ID}}'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 0) return stdout.trim().length > 0;
    if (await this.machineDown()) return false;
    throw new SmolvmLivenessUnknownError(runName, this.machine.name, stderr.trim() || `exit ${code}`);
  }

  /** A stopped or absent machine has no running container: answered, not unknown. */
  override async probeRunInfo(runName: string): Promise<RunInfoProbe> {
    const answer = await super.probeRunInfo(runName);
    if (answer.kind === 'no-answer' && (await this.machineDown())) return { kind: 'answered', info: null };
    return answer;
  }

  /** True only when smolvm SAYS the machine is stopped or absent; a failed listing is not "down". */
  private async machineDown(): Promise<boolean> {
    // An unpinned smolvm is never run: the pin failure is thrown as itself
    // (isRunning's callers read a throw as "cannot tell"), never read as "down".
    await this.verifyPin();
    try { return (await this.machine.listedState()) !== 'running'; }
    catch { return false; } // smolvm could not list: unknown, never "down"
  }

  /**
   * A task turn: the launch checks (pin, record) first, then the docker
   * runner's launch with the protocol directory moved into this project's
   * subtree — the only protocol directory the machine shares.
   */
  override async launchSupervisor(...args: Parameters<DockerRunner['launchSupervisor']>): Promise<void> {
    await this.ensureMachine();
    const [sandbox, runName, protocolDir, ...rest] = args;
    await prepareSmolvmMcpConfig(args[4]);
    const projectDir = smolvmProtocolProjectDir(protocolBase(), this.machine.name);
    const real = await moveProtocolDirInto(protocolDir, projectDir);
    return super.launchSupervisor(sandbox, runName, real, ...rest);
  }

  override async runOneshot(req: OneshotRequest): Promise<AgentResponse> {
    await this.ensureMachine();
    return super.runOneshot(req);
  }

  /**
   * A run's published ports, as HOST addresses. Docker publishes them on the
   * GUEST's loopback, which nothing on the host can dial; each is answered
   * with a service tunnel (src/vm/solo-routes.ts) through the machine's one
   * published port. Tunnels live in the daemon, so a CLI process asks it for
   * them — a tunnel a CLI opened would die with the command that printed its
   * URL. Empty when the machine predates routes (it must be recreated; a
   * launch says so) or the daemon cannot be asked.
   */
  override async getRunPortBindings(runName: string): Promise<PortBinding[] | null> {
    if (!isDaemonRpcBypassed()) {
      try {
        const answer = await tryRpc<{ bindings: PortBinding[] | null }>('smolvmServiceBindings', { runName });
        return answer?.bindings ?? [];
      } catch (err) {
        logger.warn(`Could not ask the daemon for ${runName}'s service ports (they are reached through it on the smolvm runner): ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }
    const guest = await super.getRunPortBindings(runName);
    if (!guest || guest.length === 0) return guest;
    const routes = await this.machine.recordedRoutes();
    if (!routes) {
      logger.warn(`smolvm machine ${this.machine.name} has no published services port (it predates them); recreate it to reach task services. ${RUN_DOCTOR}`);
      return [];
    }
    const secret = await this.machine.servicesSecret();
    return Promise.all(guest.map(async (b): Promise<PortBinding> => ({
      containerPort: b.containerPort,
      hostAddress: '127.0.0.1',
      hostPort: await serviceTunnels.open(routes.services.hostPort, b.hostPort, secret),
    })));
  }

  private refuseBuilder(): never {
    throw new Error(
      'The builder does not run on the smolvm runner yet: it mounts your own ~/.claude, which lazy does not share ' +
      'into the project\'s machine. Run the builder from a project on the docker runner for now.',
    );
  }

  override async launchBuilderInteractive(..._args: Parameters<DockerRunner['launchBuilderInteractive']>): ReturnType<DockerRunner['launchBuilderInteractive']> {
    this.refuseBuilder();
  }

  override async launchBuilderHeadless(_params: LaunchBuilderHeadlessParams): Promise<LaunchBuilderHeadlessResult> {
    this.refuseBuilder();
  }

  override async launchBuilderDetached(_params: LaunchBuilderDetachedParams): Promise<LaunchBuilderDetachedResult> {
    this.refuseBuilder();
  }
}

/**
 * The host UID is not the task's UID on the guest's native Linux dockerd.
 * Unlike Docker Desktop, it does not map a Mac user's 0600 handoff file to
 * the container user. The daemon's 0700 ancestor still protects the credential
 * on the host; only this task gets the single-file, read-only container mount.
 * This is the same handoff as a root daemon's 0644 file, regardless of host UID.
 */
export async function prepareSmolvmMcpConfig(path: string | undefined): Promise<void> {
  if (!path) return;
  // Establish the private ancestor before widening the single-file mount.
  await chmod(dirname(path), 0o700);
  await chmod(path, 0o644);
}

/** The engine did not answer while smolvm lists the machine as running: liveness cannot be known. */
export class SmolvmLivenessUnknownError extends Error {
  constructor(runName: string, machine: string, detail: string) {
    super(`cannot tell whether ${runName} is running: smolvm machine ${machine} is running but its Docker engine did not answer (${detail})`);
    this.name = 'SmolvmLivenessUnknownError';
  }
}

/**
 * Make `protocolDir` (`<protocol base>/<task dir>`) a symlink to the same
 * name under `projectDir`, moving anything already written there, and return
 * the real directory. Host code that only knows the task id keeps reading and
 * writing through the symlink; the container mounts the real path, which is
 * inside the one protocol subtree this project's machine shares.
 */
export async function moveProtocolDirInto(protocolDir: string, projectDir: string): Promise<string> {
  const real = join(projectDir, basename(protocolDir));
  await mkdir(real, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let st;
    try { st = await lstat(protocolDir); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; st = null; }
    if (st?.isSymbolicLink()) {
      if ((await readlink(protocolDir)) === real) break;
      await rm(protocolDir, { force: true });
    } else if (st?.isDirectory()) {
      for (const entry of await readdir(protocolDir)) {
        await rm(join(real, entry), { recursive: true, force: true });
        await rename(join(protocolDir, entry), join(real, entry));
      }
      try { await rmdir(protocolDir); }
      catch (err) {
        // A writer added a file between the move and the rmdir: move it too.
        if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY' && attempt < 3) continue;
        throw err;
      }
    } else if (st) {
      throw new Error(`${protocolDir} is neither a directory nor a symlink; lazy cannot move it into ${projectDir}`);
    }
    try { await symlink(real, protocolDir); break; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 3) throw err; }
  }
  ensureProtocolDir(real);
  return real;
}

function defaultDeps(config: ResolvedConfig): SmolvmRunnerDeps {
  return {
    stateRoot: smolvmStateRoot(),
    socketRoot: '/tmp',
    dockerCli: Bun.which('docker'),
    verifyBinary: (p) => verifySmolvmBinary(p),
    cli: smolvmCliRunner,
    dial: smolvmDial,
    shareInputs: (root) => realShareInputs(root, config),
  };
}

/**
 * Create the smolvm runner for `lazyRoot`. Config comes from the project root's
 * lazy.toml only (the caller loaded it). Never touches the machine.
 */
export async function createSmolvmRunner(
  lazyRoot: string,
  config: ResolvedConfig,
  deps: SmolvmRunnerDeps = defaultDeps(config),
): Promise<SmolvmRunner> {
  assertRunnerAllowedInManagedMode('smolvm');
  const name = soloMachineName(lazyRoot);
  let entry = relays.get(name);
  if (!entry) {
    entry = setUpRelay(lazyRoot, config, deps, name);
    relays.set(name, entry);
    entry.catch(() => relays.delete(name));
  }
  const { shim, socket, target } = await entry;
  const key = targetKey(config);
  if (target.key !== key) Object.assign(target, newTarget(lazyRoot, config, deps, name), { key });
  return new SmolvmRunner(lazyRoot, shim, target.machine, () => ensureUpChecked(target), () => verifiedLauncher(target).then(() => {}), socket);
}

function targetKey(config: ResolvedConfig): string {
  return JSON.stringify([config.smolvm, configuredBinary(config), config.mounts, config.docker.run_args]);
}

function newTarget(lazyRoot: string, config: ResolvedConfig, deps: SmolvmRunnerDeps, name: string): MachineTarget {
  const binary = configuredBinary(config);
  const machine = new SoloSmolvmMachine({
    projectRoot: lazyRoot,
    smolvm: binary || 'smolvm',
    run: deps.cli(binary),
    config: config.smolvm,
    shareInputs: () => deps.shareInputs(lazyRoot),
    stateDir: soloMachineStateDir(deps.stateRoot, name),
    callbackPorts: daemonCallbackPorts,
  });
  return { config, deps, machine, key: targetKey(config), projectRoot: lazyRoot };
}

/** The binary from `[smolvm] binary`, else `$LAZY_SMOLVM_BINARY`. */
function configuredBinary(config: ResolvedConfig): string {
  return config.smolvm.binary || process.env[SMOLVM_BINARY_ENV]?.trim() || '';
}

/**
 * The configured smolvm launcher, verified against the pin. Run before EVERY
 * smolvm call — launches, the relay, state probes: lazy never executes an
 * unverified smolvm. A failure is a SmolvmRunnerError naming the fix, never
 * "not running". The verification itself is cached per process by tree
 * fingerprint (verifySmolvmBinary).
 */
async function verifiedLauncher({ config, deps }: MachineTarget): Promise<string> {
  const binary = configuredBinary(config);
  if (!binary) {
    throw new SmolvmRunnerError(
      `no smolvm binary is configured. Set [smolvm] binary in lazy.toml (or ${SMOLVM_BINARY_ENV}) to the vendored ` +
      `smolvm launcher, an absolute path.`,
    );
  }
  try { await deps.verifyBinary(binary); }
  catch (err) { throw new SmolvmRunnerError(err instanceof Error ? err.message : String(err)); }
  return binary;
}

async function ensureUpChecked(target: MachineTarget): Promise<void> {
  if (!target.deps.dockerCli) throw new SmolvmRunnerError(MISSING_DOCKER_CLI);
  await verifiedLauncher(target);
  await target.machine.ensureUpForLaunch();
  if (hasDaemonContext()) await ensureRouteMux(target);
}

/**
 * Where the guest relays should send each callback route: the daemon's own web
 * port and its proxy's — known only inside the daemon, which is where every
 * launch happens. Null elsewhere.
 */
function daemonCallbackPorts(): Partial<Record<CallbackRoute, number>> | null {
  if (!hasDaemonContext()) return null;
  const ctx = getDaemonContext();
  return { daemon: ctx.webPort, ...(ctx.proxyPort ? { proxy: ctx.proxyPort } : {}) };
}

/**
 * The daemon's route mux on the machine's recorded host-service port, started
 * once per machine. A port another program took since the machine was created
 * fails the launch naming it: the mapping is fixed, so only a recreate moves it.
 */
async function ensureRouteMux(target: MachineTarget): Promise<void> {
  const routes = await target.machine.recordedRoutes();
  if (!routes) return; // bringUp already refused a machine without routes
  const name = target.machine.name;
  const port = routes.hostService.hostPort;
  const existing = routeMuxes.get(name);
  if (existing && (await existing.catch(() => null))?.port === port) return;
  const started = startRouteMux(port, () => callbackTargets(target)).catch((err: NodeJS.ErrnoException) => {
    routeMuxes.delete(name);
    throw new SmolvmRunnerError(
      err.code === 'EADDRINUSE'
        ? `port ${port} on this machine's loopback, where smolvm machine ${name} sends task containers' calls to lazy, is taken by another program. Stop that program, or recreate the machine (lazy picks a free port then):\n${recreateCommands(target.machine.smolvmBinary, name).map((c) => `  ${c}`).join('\n')}`
        : `could not listen on port ${port} for task containers' calls to lazy: ${err.message}`,
    );
  });
  routeMuxes.set(name, started);
  await started;
}

/** Where each callback route lands right now (read per connection: the proxy binds after the web server). */
function callbackTargets(target: MachineTarget): CallbackTargets {
  if (!hasDaemonContext()) return { daemon: null, proxy: null };
  const ctx = getDaemonContext();
  return {
    daemon: { host: dialableHost(ctx.bindHost), port: ctx.webPort },
    proxy: ctx.proxyPort ? { host: dialableHost(target.config.proxy.bind), port: ctx.proxyPort } : null,
  };
}

/**
 * The relay's precondition: a pinned smolvm and a RUNNING machine. No record
 * comparison, no create or start — those gate launches (`ensureUpChecked`).
 */
async function ensureServingChecked(target: MachineTarget): Promise<void> {
  await verifiedLauncher(target);
  await target.machine.ensureServing();
}

/** A directory lazy keeps private: created 0700, and made 0700 if it already existed wider. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function setUpRelay(lazyRoot: string, config: ResolvedConfig, deps: SmolvmRunnerDeps, name: string) {
  const stateDir = soloMachineStateDir(deps.stateRoot, name);
  await privateDir(deps.stateRoot);
  await privateDir(stateDir);
  const target = newTarget(lazyRoot, config, deps, name);
  await sweepDeadRelayFiles(stateDir);
  let socket: string;
  let relay: RelayHandle;
  try {
    const base = await relaySocketBase(deps.socketRoot);
    await sweepDeadRelayFiles(base);
    socket = (await makeRelaySocketDir(base)).socket;
    relay = await startDockerRelay({
      socketPath: socket,
      ensureServing: () => ensureServingChecked(target),
      dial: () => target.deps.dial(configuredBinary(target.config), name)(),
      onDialFailed: () => target.machine.invalidate(),
    });
  } catch (err) {
    if (err instanceof RelaySocketError) {
      throw new SmolvmRunnerError(
        `lazy could not set up the private socket it reaches the machine's Docker engine through: ${err.message}`,
      );
    }
    throw err;
  }
  const shim = relayShimPath(stateDir);
  await writeShim(shim, shimScript(deps.dockerCli, socket, MISSING_DOCKER_CLI));
  // Agent-binary cleanup asks recorded machines itself (src/vm/smolvm-engines.ts);
  // this names the launcher for a record written before it carried one.
  registerSmolvmEngine(name, configuredBinary(config));
  return { relay, shim, socket, target };
}

/** Tests only: stop every relay, route mux and service tunnel this process started. */
export async function closeSmolvmRelaysForTests(): Promise<void> {
  await serviceTunnels.closeAll();
  const muxes = [...routeMuxes.values()];
  routeMuxes.clear();
  for (const m of muxes) {
    try { await (await m).close(); } catch { /* a mux that never listened has nothing to close */ }
  }
  const all = [...relays.values()];
  relays.clear();
  for (const entry of all) {
    try { (await entry).relay.close(); } catch { /* a relay that never started has nothing to close */ }
  }
}
