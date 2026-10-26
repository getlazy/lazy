/**
 * Solo lazy's per-project smolvm machine: the long-lived VM whose dockerd the
 * `smolvm` runner launches task containers on (docs/design/ic-mode-smolvm-shape.md,
 * shape (b): the daemon stays on the host, one machine per project hosts the
 * containers). The machine itself is a {@link SmolvmDockerMachine}, the one
 * implementation Lazy Teams' image builder uses too; this module owns what is
 * particular to keeping one per project:
 *
 *   - **A stable name** derived from the project root, so every lazy process
 *     for the project finds the same machine.
 *   - **The share set.** Every bind mount the docker runner builds is
 *     `<path>:<path>` from the HOST's view. Sharing each directory those paths
 *     live under into the guest at the identical path makes them resolve
 *     unchanged on the guest's dockerd ({@link soloShares}).
 *   - **Create once, keep forever.** Created on first need, started when found
 *     stopped, and NEVER deleted or recreated by lazy: the machine's disk holds
 *     the images, build cache and anything a turn left in a volume. smolvm fixes
 *     a machine's shares and egress at create, so what it was created with is
 *     RECORDED, and a later config change that needs a different machine is
 *     reported with the command to recreate it — never applied silently, and
 *     never by deleting the machine behind the user's back.
 *
 * Machine lifecycle is serialised across processes by a lock file beside the
 * record (a CLI process and the daemon may both need the machine at once), and
 * within a process by one in-flight promise.
 */
import { createHash, randomUUID } from 'crypto';
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import type { MountConfigEntry, ResolvedConfig } from '../config/types';
import { sharedStorageOf } from '../capture/mounts';
import { logger } from '../utils/logger';
import {
  type MachineState,
  PUBLIC_EGRESS_CIDRS, SMOLVM_RELEASE, SOLO_DEFAULTS, SmolvmDockerMachine, SmolvmMachineError, TIMEOUTS,
  type MachineSpec, type SmolvmRunner,
} from './smolvm-docker-machine';
import { SOLO_ROUTE_FACTS, freeLoopbackPort, guestRelayArgv, newServicesSecret, type CallbackRoute } from './solo-routes';

/** The command every failure at the point of occurrence ends with (one generic pointer, AGENTS.md). */
export const RUN_DOCTOR = 'Run `lazy doctor` for a full diagnosis.';

/** `lazy-solo-<project>-<hash>`: readable in `smolvm machine ls`, unique per project root. */
export function soloMachineName(projectRoot: string): string {
  const base = (basename(projectRoot) || 'root').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'root';
  const hash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 8);
  return `${SOLO_DEFAULTS.namePrefix}${base}-${hash}`;
}

/**
 * One directory shared into the guest at the same path, and why lazy needs it
 * there. `readOnly` shares are mounted `:ro`: the guest only ever reads them.
 */
export interface SoloShare { path: string; why: string; readOnly?: boolean }

/** Where the docker runner's bind-mount sources live, from the host's view. */
export interface SoloShareInputs {
  projectRoot: string;
  /** The project's git common dir; shared only when it is outside the project root. */
  gitCommonDir: string;
  /**
   * THIS project's protocol subtree (`~/.lazy/protocol-smolvm/<machine>`, see
   * smolvmProtocolDir): never the shared protocol base, which holds every
   * project's task mailboxes.
   */
  protocolProjectDir: string;
  /** `~/.lazy/bin`: the content-addressed `lazy-agent` binaries. */
  agentBinDir: string;
  /** `~/.lazy/daemon/<slug>/mcp`: per-container MCP configs — and NOTHING else of the daemon dir. */
  mcpConfigDir: string;
  /** `~/.lazy/oneshot/<slug>`: machine one-shots' agent homes. */
  oneshotDir: string;
  mounts: MountConfigEntry[];
  /** Absolute bind sources named in `[docker] run_args`. */
  runArgSources: string[];
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The directories the guest must see at their host paths. Pure.
 *
 * A path inside another share is dropped (it is already visible), so the set is
 * the smallest that covers every mount source. `[[mounts]]` bind sources are
 * expanded the way the launch expands them; `{worktree}` stands for a task
 * worktree, which lives under the project root.
 */
export function soloShares(inputs: SoloShareInputs): SoloShare[] {
  const wanted: SoloShare[] = [
    { path: inputs.projectRoot, why: 'the project: its checkout, task worktrees and git pointer copies' },
    { path: inputs.gitCommonDir, why: 'the project\'s git directory, which lives outside the project root' },
    { path: inputs.protocolProjectDir, why: 'this project\'s supervisor protocol directories' },
    // Read-only: the guest needs to run the binaries, never to change them —
    // the directory is every project's, and the host's agent cleanup owns it.
    { path: inputs.agentBinDir, why: 'the lazy-agent binary every container runs', readOnly: true },
    { path: inputs.mcpConfigDir, why: 'each container\'s MCP config file', readOnly: true },
    { path: inputs.oneshotDir, why: 'machine one-shots\' agent homes' },
  ];
  const placeholderWorktree = join(inputs.projectRoot, '.lazy', 'worktrees', 'any-task');
  inputs.mounts.forEach((entry, i) => {
    const storage = sharedStorageOf(entry, { worktreePath: placeholderWorktree, repoRoot: inputs.projectRoot });
    if (storage?.kind === 'path') wanted.push({ path: storage.path, why: `lazy.toml [[mounts]] entry #${i + 1}` });
  });
  for (const source of inputs.runArgSources) wanted.push({ path: source, why: 'a bind mount in lazy.toml [docker] run_args' });

  // A share inside another is dropped only when the outer one already gives it
  // at least the access it needs: a writable share inside a read-only one is
  // kept as its own share.
  const covers = (outer: SoloShare, inner: SoloShare) => within(outer.path, inner.path) && (!outer.readOnly || !!inner.readOnly);
  const out: SoloShare[] = [];
  for (const share of wanted.map((s) => ({ ...s, path: resolve(s.path) }))) {
    if (out.some((kept) => covers(kept, share))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (covers(share, out[i]!)) out.splice(i, 1);
    out.push(share);
  }
  return out;
}

/** What a machine was created with — everything smolvm fixes at create. */
export interface MachineRecord {
  version: 1;
  name: string;
  createdAt: string;
  smolvmVersion: string;
  image: string;
  /** The image tar's `.source-id` sidecar, when it has one: which lazy the guest runs. */
  imageSourceId: string | null;
  cpus: number;
  memoryMib: number;
  storageGib: number;
  shares: string[];
  allowCidrs: string[];
  /**
   * Where `allowCidrs` came from: the user's `[smolvm] allow_cidrs`, or lazy's
   * built-in public egress list (used when that key is empty). Absent in a
   * record written before it existed.
   */
  allowCidrsSource?: 'config' | 'default';
  /** The shares mounted `:ro`. Absent in a record written before shares could be read-only. */
  readOnlyShares?: string[];
  /** The smolvm launcher that created it: what agent-binary cleanup asks about this machine. */
  smolvmBinary?: string;
  /**
   * The machine's two network routes (src/vm/solo-routes.ts), both fixed by
   * smolvm at create: its one guest-to-host mapping and its one published
   * port. The host ports were free loopback ports when the machine was
   * created. Absent in a record written before task containers could reach
   * the host.
   */
  routes?: MachineRoutes;
  /** Created and recorded, but its services port is not published yet (a publish failed). */
  publishPending?: true;
}

/** One port pair: the guest side lazy fixes, and the host loopback side chosen at create. */
export interface RoutePorts { guestPort: number; hostPort: number }
export interface MachineRoutes {
  /** `SMOLVM_GUEST_HOST_SERVICE`: guest gateway port → host loopback port (the route mux). */
  hostService: RoutePorts;
  /** The published port: host loopback port → the guest's services router. */
  services: RoutePorts;
}

/**
 * What the config asks a machine to be. The routes' host ports are chosen at
 * create, so only their guest ports are asked for.
 */
export type DesiredMachine = Omit<MachineRecord, 'version' | 'createdAt' | 'routes'> & {
  routeGuestPorts?: { hostService: number; services: number };
};

export interface RecordDifference {
  /** Differences the existing machine cannot serve correctly or safely: a recreate is required. */
  recreate: string[];
  /** Differences it can still serve: reported, and the machine is kept as it is. */
  advisory: string[];
}

/**
 * How the recorded machine differs from what the config now asks for. Pure.
 *
 * A MISSING share would make the guest's dockerd create an empty directory at
 * that path and mount it — an agent working on nothing, silently — so it
 * requires a recreate, as does any egress change (the machine's network
 * boundary must be what the config says). A share the machine has but no longer
 * needs, a new size or a new image leave a machine that still works; they are
 * reported and take effect when the user recreates it.
 */
export function compareRecord(recorded: MachineRecord, desired: DesiredMachine): RecordDifference {
  const recreate: string[] = [];
  const advisory: string[] = [];
  // Both routes are fixed at create. Without the mapping a task container's
  // first lazy_* call and first model request fail; without the published port
  // nothing on the host reaches a task's services.
  const want = desired.routeGuestPorts;
  if (want && !recorded.routes) {
    recreate.push('it has no route for task containers to reach lazy on this host, and no published port for task services (smolvm fixes both when a machine is created)');
  } else if (want && recorded.routes) {
    if (recorded.routes.hostService.guestPort !== want.hostService) {
      recreate.push(`its route to lazy on this host is on guest port ${recorded.routes.hostService.guestPort}; this lazy uses ${want.hostService}`);
    }
    if (recorded.routes.services.guestPort !== want.services) {
      recreate.push(`its published services port lands on guest port ${recorded.routes.services.guestPort}; this lazy uses ${want.services}`);
    }
  }
  const missing = desired.shares.filter((p) => !recorded.shares.some((r) => within(r, p)));
  if (missing.length) recreate.push(`it does not share ${missing.join(', ')} into the machine`);
  // A share the machine has WRITABLE that lazy now shares read-only lets the
  // guest change what it should only read: recreate. (The other way round only
  // matters for a share lazy now writes through, which is never a read-only one.)
  const recordedRo = new Set(recorded.readOnlyShares ?? []);
  const nowRo = (desired.readOnlyShares ?? []).filter((p) => recorded.shares.includes(p) && !recordedRo.has(p));
  if (nowRo.length) recreate.push(`it shares ${nowRo.join(', ')} writable; lazy now shares it read-only`);
  const nowRw = [...recordedRo].filter((p) => desired.shares.some((d) => within(p, d) || within(d, p)) && !(desired.readOnlyShares ?? []).includes(p));
  if (nowRw.length) recreate.push(`it shares ${nowRw.join(', ')} read-only, and tasks now need to write there`);
  const sameCidrs = recorded.allowCidrs.length === desired.allowCidrs.length && recorded.allowCidrs.every((c, i) => c === desired.allowCidrs[i]);
  if (!sameCidrs) recreate.push(egressChange(recorded.allowCidrsSource, desired.allowCidrsSource));
  const extra = recorded.shares.filter((r) => !desired.shares.some((p) => within(p, r) || within(r, p)));
  if (extra.length) advisory.push(`it still shares ${extra.join(', ')}, which nothing needs any more`);
  for (const [key, label] of [['cpus', 'cpus'], ['memoryMib', 'memory_mib'], ['storageGib', 'storage_gib']] as const) {
    if (recorded[key] !== desired[key]) advisory.push(`[smolvm] ${label} is ${desired[key]}, the machine was created with ${recorded[key]}`);
  }
  if (recorded.image !== desired.image || recorded.imageSourceId !== desired.imageSourceId) {
    advisory.push(`[smolvm] image is ${desired.image}${desired.imageSourceId ? ` (lazy ${desired.imageSourceId})` : ''}, the machine boots ${recorded.image}${recorded.imageSourceId ? ` (lazy ${recorded.imageSourceId})` : ''}`);
  }
  if (recorded.smolvmVersion !== desired.smolvmVersion) advisory.push(`it was created by smolvm ${recorded.smolvmVersion}; lazy now runs ${desired.smolvmVersion}`);
  return { recreate, advisory };
}

/**
 * Why the egress policy differs, naming who changed it. With `allow_cidrs`
 * empty the policy is lazy's built-in list, so a difference there is lazy's own
 * upgrade, never something the user did.
 */
function egressChange(recorded: MachineRecord['allowCidrsSource'], desired: MachineRecord['allowCidrsSource']): string {
  if (desired === 'config') return 'its egress policy changed: [smolvm] allow_cidrs is not what the machine was created with';
  if (recorded === 'config') return 'its egress policy changed: [smolvm] allow_cidrs was removed, so lazy\'s built-in public egress list applies now';
  return 'lazy\'s built-in public egress list (used because [smolvm] allow_cidrs is empty) changed in this version of lazy, and the machine still has the list it was created with';
}

/** The commands that delete a machine so lazy creates it afresh on the next turn. */
export function recreateCommands(smolvm: string, name: string): string[] {
  const q = JSON.stringify(smolvm);
  return [
    `${q} machine exec --name ${name} -- lazy-guest-init --stop-docker`,
    `${q} machine stop --name ${name}`,
    `${q} machine delete --name ${name} --force`,
  ];
}

/** The machine is not running: its engine cannot answer, and none of its containers runs. */
export class SmolvmMachineNotRunningError extends Error {
  constructor(readonly machine: string, readonly state: 'absent' | 'stopped') {
    super(state === 'absent'
      ? `smolvm machine ${machine} does not exist yet; lazy creates it when a task next starts`
      : `smolvm machine ${machine} is stopped, so none of its containers is running; lazy starts it when a task next starts`);
    this.name = 'SmolvmMachineNotRunningError';
  }
}

/** The machine record exists but cannot be read: the machine can only be recreated. */
export class SmolvmRecordUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmolvmRecordUnreadableError';
  }
}

export class SmolvmMachineNeedsRecreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmolvmMachineNeedsRecreateError';
  }
}

export interface SoloMachineOptions {
  projectRoot: string;
  /** The verified smolvm launcher (absolute). */
  smolvm: string;
  run: SmolvmRunner;
  config: ResolvedConfig['smolvm'];
  /** Resolves the share inputs, creating the lazy-owned directories (a share must exist to be created). */
  shareInputs: () => Promise<SoloShareInputs>;
  /** `~/.lazy/smolvm/<name>`: the record and the lifecycle lock. Never shared into the guest. */
  stateDir: string;
  say?: (line: string) => void;
  /** How long a successful check is trusted before the machine is asked again. */
  freshForMs?: number;
  /**
   * Where the callback routes land on the host — the daemon's web port and its
   * proxy's port — or null outside the daemon. Read at every bring-up, so the
   * guest relays follow a daemon that restarted on other ports.
   */
  callbackPorts?: () => Partial<Record<CallbackRoute, number>> | null;
  /** Picks a free loopback port (tests inject their own). */
  pickPort?: () => Promise<number>;
}

/** A lifecycle lock older than this is a holder that died mid-create; create itself is bounded by TIMEOUTS.create. */
const LOCK_STALE_MS = TIMEOUTS.create + TIMEOUTS.start + TIMEOUTS.dockerd;
/** How many host ports a publish tries before giving up for this turn. */
const PUBLISH_ATTEMPTS = 3;
/** A takeover file is held for one read and one unlink; older than this, its holder died. */
const TAKEOVER_STALE_MS = 30_000;

export class SoloSmolvmMachine {
  readonly name: string;
  private inFlight: Promise<void> | null = null;
  private upAt = 0;
  private servingAt = 0;
  private advisedOnce = false;

  constructor(private readonly opts: SoloMachineOptions) {
    this.name = soloMachineName(opts.projectRoot);
  }

  get recordPath(): string { return join(this.opts.stateDir, 'machine.json'); }
  /** The smolvm launcher this machine is driven with. */
  get smolvmBinary(): string { return this.opts.smolvm; }
  private get lockPath(): string { return join(this.opts.stateDir, 'lifecycle.lock'); }

  /** Forget the last successful check, so the next {@link ensureUp} asks smolvm again. */
  invalidate(): void { this.upAt = 0; this.servingAt = 0; }

  /**
   * The machine exists, runs, and its dockerd answers — creating or starting
   * it as needed. Throws an error that says what to do; never deletes,
   * recreates or replaces anything.
   */
  ensureUp(): Promise<void> {
    if (Date.now() - this.upAt < (this.opts.freshForMs ?? 30_000)) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.withLock(() => this.bringUp())
        .then(() => { this.upAt = Date.now(); })
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /**
   * A launch's check: {@link ensureUp}, but a recent success is confirmed with
   * one `smolvm machine ls` instead of trusted outright. A machine someone
   * stopped by hand inside the trust window is then started again before the
   * launch, rather than failing the launch's first docker call.
   */
  async ensureUpForLaunch(): Promise<void> {
    if (!this.inFlight && Date.now() - this.upAt < (this.opts.freshForMs ?? 30_000)) {
      if (await this.listedState() === 'running') return;
      this.invalidate();
    }
    return this.ensureUp();
  }

  /**
   * What `smolvm machine ls` says about this machine, changing nothing.
   * Throws when the listing fails: that is "unknown", never "absent".
   */
  listedState(): Promise<MachineState> {
    return new SmolvmDockerMachine(this.opts.run, {
      name: this.name, image: '', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: [], volumes: [],
    }, () => {}).state();
  }

  /**
   * The relay's precondition: the machine RUNS. Nothing is created, started,
   * pinned or compared here — that is a launch's business (`ensureUp`) — so a
   * machine that needs recreating still answers `ps`, `inspect`, `logs`,
   * `stop` and `rm` for the containers already in it.
   */
  ensureServing(): Promise<void> {
    if (Date.now() - this.servingAt < (this.opts.freshForMs ?? 30_000)) return Promise.resolve();
    return this.listedState().then((state) => {
      if (state !== 'running') throw new SmolvmMachineNotRunningError(this.name, state);
      this.servingAt = Date.now();
    });
  }

  /**
   * How the machine's record compares with what the config now asks for,
   * changing nothing but lazy's own share directories (the share inputs create
   * them). `none` when there is no record. Throws {@link SmolvmRecordUnreadableError}
   * when the record cannot be read, and the config's own error when the config
   * cannot describe a machine (no image, a missing share).
   */
  async recordDifference(): Promise<{ kind: 'none' } | { kind: 'present'; diff: RecordDifference }> {
    let record: MachineRecord | null;
    try { record = await this.readRecord(); }
    catch (err) { throw new SmolvmRecordUnreadableError((err as Error).message); }
    if (!record) return { kind: 'none' };
    if (record.name !== this.name) {
      return { kind: 'present', diff: { recreate: [`its record names machine ${record.name}, not ${this.name}`], advisory: [] } };
    }
    return { kind: 'present', diff: compareRecord(record, await this.desired()) };
  }

  private say(line: string): void {
    (this.opts.say ?? ((l: string) => logger.info(l)))(`smolvm machine ${this.name}: ${line}`);
  }

  private async desired(): Promise<DesiredMachine> {
    const { config } = this.opts;
    if (!config.image) {
      throw new SmolvmMachineError('machine create',
        'lazy.toml [smolvm] image is not set. It names the lazy daemon image tar (`docker save` form) the ' +
        'project\'s machine boots, which carries its Docker engine.');
    }
    const shareSet = soloShares(await this.opts.shareInputs());
    const shares = shareSet.map((s) => s.path);
    for (const path of shares) {
      let st;
      try { st = await stat(path); }
      catch { throw new SmolvmMachineError('machine create', `${path} does not exist, so it cannot be shared into the machine. Create it, or remove what mounts it from lazy.toml.`); }
      if (!st.isDirectory()) {
        throw new SmolvmMachineError('machine create',
          `${path} is a file; smolvm shares directories into a machine. Mount the directory holding it instead.`);
      }
      if (path.includes(':')) throw new SmolvmMachineError('machine create', `${path} cannot be shared: smolvm splits -v on ':'.`);
    }
    let imageSourceId: string | null = null;
    try { imageSourceId = (await readFile(`${config.image}.source-id`, 'utf8')).trim() || null; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    return {
      name: this.name,
      smolvmVersion: SMOLVM_RELEASE.version,
      image: config.image,
      imageSourceId,
      cpus: config.cpus,
      memoryMib: config.memory_mib,
      storageGib: config.storage_gib,
      shares,
      allowCidrs: config.allow_cidrs.length ? config.allow_cidrs.map((c) => c.trim()) : [...PUBLIC_EGRESS_CIDRS],
      allowCidrsSource: config.allow_cidrs.length ? 'config' : 'default',
      readOnlyShares: shareSet.filter((s) => s.readOnly).map((s) => s.path),
      smolvmBinary: this.opts.smolvm,
      routeGuestPorts: { hostService: SOLO_ROUTE_FACTS.hostServiceGuestPort, services: SOLO_ROUTE_FACTS.servicesGuestPort },
    };
  }

  /**
   * The routes the machine was created with, from its record; null when there
   * is no record or it predates routes. Changes nothing.
   */
  async recordedRoutes(): Promise<MachineRoutes | null> {
    const record = await this.readRecord();
    return record?.name === this.name ? record.routes ?? null : null;
  }

  private async readRecord(): Promise<MachineRecord | null> {
    let text: string;
    try { text = await readFile(this.recordPath, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`cannot read ${this.recordPath}: ${(err as Error).message}`);
    }
    try { return JSON.parse(text) as MachineRecord; }
    catch (err) { throw new Error(`${this.recordPath} is not valid JSON (${(err as Error).message}); it records how ${this.name} was created`); }
  }

  private async writeRecord(record: MachineRecord): Promise<void> {
    const tmp = `${this.recordPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.recordPath);
  }

  private needsRecreate(why: string[]): SmolvmMachineNeedsRecreateError {
    return new SmolvmMachineNeedsRecreateError(
      `The project's smolvm machine ${this.name} has to be recreated before it can run tasks: ${why.join('; ')}. ` +
      'smolvm fixes a machine\'s shares and egress when it is created, so lazy does not change it in place, and it never ' +
      'deletes a machine by itself — the machine\'s disk holds its Docker images and build cache. When no task is ' +
      'running, delete it and lazy creates it again on the next turn:\n' +
      recreateCommands(this.opts.smolvm, this.name).map((c) => `  ${c}`).join('\n'),
    );
  }

  private async bringUp(): Promise<void> {
    const desired = await this.desired();
    const { routeGuestPorts, ...recordable } = desired;
    const machineFor = (routes: MachineRoutes | undefined) => new SmolvmDockerMachine(this.opts.run, {
      name: this.name, image: desired.image, cpus: desired.cpus, memoryMib: desired.memoryMib, storageGib: desired.storageGib,
      allowCidrs: desired.allowCidrs,
      volumes: desired.shares.map((p) => ({ host: p, guest: p, readOnly: (desired.readOnlyShares ?? []).includes(p) })),
      ...(routes ? { hostService: routes.hostService } : {}),
    } satisfies MachineSpec, (line) => this.say(line));

    const state = await machineFor(undefined).state();
    if (state === 'absent') {
      try { await stat(desired.image); }
      catch { throw new SmolvmMachineError('machine create', `no image tar at ${desired.image} (lazy.toml [smolvm] image)`); }
      // Host ports are free loopback ports NOW; smolvm fixes them at create, so
      // they are recorded with the machine and reused for its whole life.
      const [hostServicePort, servicesPort] = await this.pickHostPorts();
      const routes: MachineRoutes = {
        hostService: { guestPort: routeGuestPorts!.hostService, hostPort: hostServicePort },
        services: { guestPort: routeGuestPorts!.services, hostPort: servicesPort },
      };
      const machine = machineFor(routes);
      await machine.create();
      // Recorded the moment it exists: a start that fails next must not leave
      // a machine lazy cannot account for.
      // It is recorded with its publish still owed, so a publish that fails
      // leaves a machine lazy knows about and finishes publishing next time.
      const record: MachineRecord = { version: 1, createdAt: new Date().toISOString(), ...recordable, routes, publishPending: true };
      await this.writeRecord(record);
      await this.publishServices(machine, record);
      await machine.start();
      await machine.startDockerd('ensure');
      await this.ensureRelays(machine);
      return;
    }

    const record = await this.readRecord();
    if (!record || record.name !== this.name) {
      throw this.needsRecreate([`lazy has no record of how it was created (${this.recordPath}), so it cannot tell whether it shares what tasks mount`]);
    }
    const diff = compareRecord(record, desired);
    if (diff.recreate.length) throw this.needsRecreate([...diff.recreate, ...diff.advisory]);
    if (diff.advisory.length && !this.advisedOnce) {
      this.advisedOnce = true;
      logger.warn(
        `smolvm machine ${this.name} keeps running as it was created: ${diff.advisory.join('; ')}. ` +
        `To apply the new settings, recreate it when no task is running:\n${recreateCommands(this.opts.smolvm, this.name).map((c) => `  ${c}`).join('\n')}`,
      );
    }
    const machine = machineFor(record.routes);
    if (record.publishPending) {
      // smolvm publishes only on a stopped machine; a running one with its
      // publish still owed can only be recreated.
      if (state !== 'stopped') throw this.needsRecreate(['its services port was never published, and smolvm publishes only while a machine is stopped']);
      await this.publishServices(machine, record);
    }
    if (state === 'stopped') await machine.start();
    else await machine.awaitExecReady(TIMEOUTS.short);
    await machine.startDockerd('ensure');
    await this.ensureRelays(machine);
  }

  /**
   * Start or refresh the guest relays (src/vm/solo-guest-relays.sh): the
   * services router always, the callback relays when this process knows where
   * the daemon and its proxy listen (the daemon does; a CLI process does not,
   * and launches only happen in the daemon). Idempotent, and run after every
   * bring-up because relays do not survive a machine stop.
   */
  private async ensureRelays(machine: SmolvmDockerMachine): Promise<void> {
    const ports = this.opts.callbackPorts?.() ?? null;
    await machine.exec('guest relays', guestRelayArgv(ports, await this.servicesSecret()), TIMEOUTS.short);
  }

  /**
   * The machine's services secret (see src/vm/solo-guest-relays.sh): every
   * container in the machine can reach the services router, and only a route
   * line carrying this reaches anything. Kept 0600 in the state dir, which is
   * never shared into the guest; made on first need and handed to the guest
   * at every bring-up (its copy lives on tmpfs).
   */
  async servicesSecret(): Promise<string> {
    const path = join(this.opts.stateDir, 'services-secret');
    try {
      const existing = (await readFile(path, 'utf8')).trim();
      if (/^[0-9a-f]{64}$/.test(existing)) return existing;
      throw new Error(`${path} does not hold a services secret; delete it and lazy makes a new one`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const secret = newServicesSecret();
    const tmp = `${path}.${process.pid}.${randomUUID()}`;
    await writeFile(tmp, `${secret}\n`, { mode: 0o600 });
    try { await link(tmp, path); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    finally { await rm(tmp, { force: true }); }
    return (await readFile(path, 'utf8')).trim();
  }

  /**
   * Publish the recorded services port on the stopped machine, retrying with
   * another free port when the host port was taken meanwhile (the race Lazy
   * Teams retries too), and record the port that stuck. Clears `publishPending`.
   */
  private async publishServices(machine: SmolvmDockerMachine, record: MachineRecord): Promise<void> {
    const routes = record.routes!;
    for (let attempt = 1; ; attempt++) {
      const outcome = await machine.publishPort(routes.services.hostPort, routes.services.guestPort);
      if (outcome === 'published') break;
      if (attempt >= PUBLISH_ATTEMPTS) {
        throw new SmolvmMachineError('machine publish', `host port ${routes.services.hostPort} was taken on each of ${PUBLISH_ATTEMPTS} tries; lazy tries again on the next turn`);
      }
      let next = await (this.opts.pickPort ?? freeLoopbackPort)();
      if (next === routes.hostService.hostPort) next = await (this.opts.pickPort ?? freeLoopbackPort)();
      routes.services.hostPort = next;
      await this.writeRecord(record);
    }
    delete record.publishPending;
    await this.writeRecord(record);
  }

  /** Two distinct free loopback ports, for the routes of a machine about to be created. */
  private async pickHostPorts(): Promise<[number, number]> {
    const pick = this.opts.pickPort ?? freeLoopbackPort;
    const first = await pick();
    for (let i = 0; i < 5; i++) {
      const second = await pick();
      if (second !== first) return [first, second];
    }
    throw new SmolvmMachineError('machine create', 'could not find two free loopback ports for the machine\'s routes');
  }

  /**
   * One lifecycle at a time across processes: an exclusive-create lock file
   * naming its holder (pid, time, and a nonce unique to this acquisition). A
   * holder that is gone, or older than any lifecycle step can take, is stale
   * and replaced — the age bound is what keeps a recycled pid from wedging the
   * lock forever.
   *
   * Takeover and release both act only on the holder they READ: a stale lock
   * is removed only under the takeover file and only while it still names the
   * stale holder, and release removes the file only while it is still ours.
   * Two processes judging the same lock stale therefore never both remove it
   * and both create a fresh one, and neither deletes the other's.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_STALE_MS;
    const mine = `${process.pid} ${Date.now()} ${randomUUID()}\n`;
    for (;;) {
      // The holder is written to a private file first and LINKED into place, so
      // the lock never exists without its holder's text: an empty lock read
      // mid-write used to look stale and was taken over.
      const tmp = `${this.lockPath}.${process.pid}.${randomUUID()}`;
      await writeFile(tmp, mine, { mode: 0o600 });
      try {
        await link(tmp, this.lockPath);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const held = await this.readLock();
        if (held !== null && lockTextIsStale(held)) { await this.takeOverStale(held); continue; }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${this.lockPath}; another lazy process is creating or starting ${this.name}`);
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await rm(tmp, { force: true });
      }
    }
    try { return await fn(); }
    finally {
      if ((await this.readLock()) === mine) await rm(this.lockPath, { force: true });
      else logger.warn(`${this.lockPath} no longer names this process; left in place for its current holder`);
    }
  }

  /** The lock file's text, or null when there is none (released meanwhile). */
  private async readLock(): Promise<string | null> {
    try { return await readFile(this.lockPath, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`cannot read ${this.lockPath}: ${(err as Error).message}`);
    }
  }

  /**
   * Remove the stale holder `staleText`, and only it. Removal happens under a
   * short-held takeover file, after re-reading that the lock still names that
   * holder — so of several contenders that judged it stale, one removes it and
   * the rest find either a fresh lock or none, never delete a fresh one.
   */
  private async takeOverStale(staleText: string): Promise<void> {
    const takeover = `${this.lockPath}.takeover`;
    try { await (await open(takeover, 'wx', 0o600)).close(); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another contender is taking over. One left by a process that died
      // mid-takeover (held for milliseconds) is cleared after a generous bound.
      const st = await stat(takeover).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null; // that takeover just finished
        throw e;
      });
      if (st && Date.now() - st.mtimeMs > TAKEOVER_STALE_MS) await rm(takeover, { force: true });
      else await new Promise((r) => setTimeout(r, 50));
      return;
    }
    try {
      if ((await this.readLock()) === staleText) await rm(this.lockPath, { force: true });
    } finally {
      await rm(takeover, { force: true });
    }
  }
}

/** A holder that is gone, or older than any lifecycle step can take, is stale. */
function lockTextIsStale(text: string): boolean {
  const [pidText, atText] = text.trim().split(' ');
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS) return true;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Under `stateRoot`, the directory for one machine. */
export function soloMachineStateDir(stateRoot: string, name: string): string {
  return join(stateRoot, name);
}

/**
 * Where a smolvm project's task protocol directories really live:
 * `<protocol base>-smolvm/<machine>/<task dir>`, a per-project subtree that is
 * the only protocol directory shared into that project's machine. The usual
 * `<protocol base>/<task dir>` becomes a symlink to it (see the runner's
 * launch), so host code that only knows the task id keeps working.
 */
export function smolvmProtocolProjectDir(protocolBaseDir: string, machine: string): string {
  return join(`${protocolBaseDir.replace(/\/+$/, '')}-smolvm`, machine);
}
