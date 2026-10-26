/** Safe reclaim for a project's private guest engine. No system prune, volumes,
 * force-removal, or filesystem deletion. Inventory comes from Engine API 1.51
 * (Docker 29's backwards-compatible, byte-valued /system/df response).
 */
import { createHash } from 'crypto';
import { readFile, statfs } from 'fs/promises';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { redactSecretValues } from '../utils/redact';
import { isManagedMode, MANAGED_BACKEND_ENV } from '../config/managed-mode';
import { runningContainerBuilds } from '../capture/build-observer';
import { taskRef, deriveTaskRef } from '../task/identity';
import type { Storage } from '../storage/interface';
import type { BuildSpacePressure, DiskSpaceState } from '../storage/disk-space-state';

interface Image { Id: string; RepoTags?: string[]; RepoDigests?: string[]; Created: number; Size: number; SharedSize?: number; Containers?: number }
interface Container { Id: string; Names: string[]; ImageID: string; State: string; Labels: Record<string, string>; SizeRw?: number }
interface Cache { ID: string; Size: number; InUse: boolean; Shared?: boolean; LastUsedAt?: string; CreatedAt: string; Description?: string }
interface Volume { Name: string; UsageData?: { Size?: number } | null }
export interface EngineDiskUsage { Images: Image[]; Containers: Container[]; BuildCache: Cache[]; LayersSize: number; Volumes?: Volume[] }
export interface DiskItem { kind: 'image' | 'container' | 'build-cache'; id: string; name: string; bytes: number; references?: string[] }
export interface DiskPlan { id: string; items: DiskItem[]; reclaimableBytes: number }
export interface DiskSpaceView {
  supported: boolean;
  usage: { totalBytes: number; freeBytes: number; buildCacheBytes: number; imagesBytes: number; containersBytes: number };
  plan: DiskPlan;
  lastRecovery: DiskSpaceState['lastRecovery'];
  needsGrowth: boolean;
  growthGeneration: number;
  buildPressure: BuildSpacePressure | null;
  /**
   * Task data directories ($LAZY_TASK_DATA volumes) with their sizes — SHOWN,
   * never part of the plan: a task's data is removed only with the task.
   */
  taskData: Array<{ name: string; bytes: number | null }>;
}
/** Kept distinct so outer launch wrappers cannot retry a recovery again. */
export class DiskFullError extends Error {}

export class DiskSpaceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const emptyState = (): DiskSpaceState => ({ needsGrowth: false, lastRecovery: null, images: [] });
const sum = <T>(rows: T[], bytes: (row: T) => number) => rows.reduce((n, row) => n + Math.max(0, bytes(row) || 0), 0);
const family = (image: Image): string | null => {
  const tags = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])];
  if (tags.some(t => /^lazy-runner[:@]|^ghcr\.io\/getlazy\/lazy-runner[:@]/.test(t))) return 'runner';
  if (tags.some(t => /^lazy-custom-[a-f0-9]+[:@]/.test(t))) return 'project';
  return tags.length === 0 || tags.every(t => t === '<none>:<none>') ? 'dangling' : null;
};

/** Docker 29's containerd image IDs are target digests. A repository@ID
 * removal matches only references to that immutable target in that repository,
 * including its multiple tags. It cannot follow a tag moved to a newer image.
 * Keep images with any non-lazy alias rather than untagging someone else's ref. */
function imageRemovalReferences(image: Image): string[] | null {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(image.Id)) return null;
  const aliases = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])]
    .filter(ref => ref !== '<none>:<none>' && !/^sha256:[a-f0-9]{64}$/.test(ref));
  if (!aliases.length) return [image.Id];
  const repositories = new Set<string>();
  for (const alias of aliases) {
    const match = /^((?:lazy-runner|ghcr\.io\/getlazy\/lazy-runner|lazy-custom-[a-f0-9]+))(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*|@sha256:[a-f0-9]{64})$/.exec(alias);
    if (!match) return null;
    repositories.add(match[1]);
  }
  const digest = image.Id.startsWith('sha256:') ? image.Id : `sha256:${image.Id}`;
  return [...repositories].sort().map(repository => `${repository}@${digest}`);
}

/** Engine failure lines only, not arbitrary output from a Dockerfile's RUN. */
export function isEngineDiskFull(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').some(line =>
    /^\s*(?:ERROR: failed to build:|failed to solve:|(?:docker: )?Error response from daemon:|failed to (?:register|extract|commit|create|prepare|write|copy|mount)[^\n]*:)/i.test(line) &&
    // BuildKit quotes the entire RUN argv in an unsuccessful process error.
    // Words inside that argv are not an engine filesystem failure.
    !/\b(?:process .+ did not complete successfully|executor failed running .+): exit code(?::|\s)/i.test(line) &&
    /\bno space left on device\b|\bENOSPC\b/i.test(line));
}

/** A compiler can exhaust RUN's writable layer without an engine error.
 * Match diagnostics, never the RUN argv BuildKit echoes on process failure. */
function isBuildDiskFull(error: unknown): boolean {
  if (isEngineDiskFull(error)) return true;
  if (!error) return false;
  const output = typeof error === 'object' && 'output' in error ? String(error.output)
    : error instanceof Error ? error.message : String(error);
  return output.split('\n').some(line => {
    if (/\b(?:process .+ did not complete successfully|executor failed running .+): exit code(?::|\s)/i.test(line)) return false;
    const diagnostic = line.replace(/^\s*#\d+\s+(?:\d+(?:\.\d+)?\s+)?/, '');
    return /^\s*(?:error(?:\[[^\]]+\])?:|(?:rustc|cargo):\s*(?:fatal\s+)?error:|LLVM ERROR:)/i.test(diagnostic) &&
      /\bno space left on device\b|\bENOSPC\b/i.test(diagnostic);
  });
}

export interface DiskSpaceDeps {
  inventory(): Promise<EngineDiskUsage>;
  filesystem(): Promise<{ totalBytes: number; freeBytes: number }>;
  command(args: string[]): Promise<void>;
  buildsRunning(): number;
  /** The RUNNING engine's startup policy, not a recomputed desired policy. */
  cachePolicy?(): Promise<{ maxBytes: number; minFreeBytes: number } | null>;
}

const GiB = 1024 ** 3;
const gib = (bytes: number) => Math.ceil(bytes / GiB);
const samePressure = (a: BuildSpacePressure | undefined, b: BuildSpacePressure | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.growthGeneration === b.growthGeneration &&
    a.image === b.image && a.identity === b.identity && a.at === b.at;
function engineSize(value: unknown): number {
  const match = /^(\d+(?:\.\d+)?)([kmgt]?)(?:i?b)?$/i.exec(String(value));
  if (!match) throw new Error(`Invalid running Docker cache limit: ${value}`);
  return Number(match[1]) * 1024 ** (match[2] ? 'kmgt'.indexOf(match[2].toLowerCase()) + 1 : 0);
}

/** Only this private engine is ours to reclaim. Shared-dockerd Teams fails closed. */
export function diskSpaceSupported(): boolean {
  return isManagedMode() && process.env[MANAGED_BACKEND_ENV] === 'microvm';
}

export function guestDiskSpaceDeps(options: { socketPath?: string; storageRoot?: string; binary?: string; configPath?: string } = {}): DiskSpaceDeps {
  return {
    inventory: async () => {
      // Guest init fixes this endpoint. Never follow a context to another engine.
      const response = await fetch('http://docker/v1.51/system/df', {
        unix: options.socketPath ?? '/var/run/docker.sock', signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Error response from daemon: Docker disk inventory failed (${response.status}): ${await response.text()}`);
      const data = await response.json() as EngineDiskUsage;
      if (!data || typeof data !== 'object' || 'ImageUsage' in data ||
        (data.Images != null && !Array.isArray(data.Images)) || (data.Containers != null && !Array.isArray(data.Containers)) ||
        (data.BuildCache != null && !Array.isArray(data.BuildCache))) {
        throw new Error('Docker disk inventory did not contain images, containers and build cache; nothing was removed.');
      }
      return { ...data, LayersSize: data.LayersSize ?? 0, Images: data.Images ?? [], Containers: data.Containers ?? [], BuildCache: data.BuildCache ?? [] };
    },
    filesystem: async () => {
      const fs = await statfs(options.storageRoot ?? '/storage');
      return { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
    },
    command: async args => {
      const p = spawn([options.binary ?? 'docker', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`Docker ${args.slice(0, 2).join(' ')} failed: ${err.trim() || out.trim() || `exit ${code}`}`);
    },
    buildsRunning: runningContainerBuilds,
    cachePolicy: async () => {
      try {
        const config = JSON.parse(await readFile(options.configPath ?? '/run/lazy-dockerd.json', 'utf8'));
        return { maxBytes: engineSize(config.builder.gc.defaultMaxUsedSpace), minFreeBytes: engineSize(config.builder.gc.defaultMinFreeSpace) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`Could not read the running Docker cache policy: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export class DiskSpaceManager {
  private reclaiming: Promise<{ freedBytes: number }> | null = null;
  private stateWrites: Promise<unknown> = Promise.resolve();
  private imageRecords: Promise<unknown> = Promise.resolve();
  private currentBuildNames = new Map<string, string>();
  private preparingBuilds = 0;
  private buildSequence = 0;
  /** The outer retry wrapper may see the same Error after measurement saved it. */
  private recordedBuildFailures = new WeakSet<object>();
  constructor(private storage: Storage, private projectRoot: string, private deps: DiskSpaceDeps = guestDiskSpaceDeps()) {}

  private writeState(change: (state: DiskSpaceState) => void): Promise<void> {
    const next = this.stateWrites.then(async () => {
      const state = (await this.storage.getDiskSpaceState()) ?? emptyState();
      change(state);
      await this.storage.saveDiskSpaceState(state);
    });
    // A failed write must not poison later writes, but its caller still sees it.
    this.stateWrites = next.catch(error => logger.error(`Could not save disk recovery: ${error.message}`));
    return next;
  }

  /** Reserve before awaiting image retention: otherwise a reclaim can start
   * while that inventory is in flight, before the build observer counts it. */
  async build<T>(image: string, work: () => Promise<T>, identity?: string): Promise<T> {
    while (this.reclaiming) await this.reclaiming;
    this.preparingBuilds++;
    this.buildSequence++;
    try {
      await this.built(image, Date.now());
      if (!identity) return await work();
      const previous = (await this.storage.getDiskSpaceState())?.buildPressure;
      if (previous?.blocked && previous.image === image && previous.identity === identity) {
        const hold = await this.buildHold(previous);
        if (hold) throw new DiskFullError('The project ran out of space and an admin has been told. Another cold rebuild is held until disk space or cache capacity improves; project admins can see the measured sizes on the Machine page.');
      }
      return await this.measureBuild(image, identity, work);
    } finally { this.preparingBuilds--; }
  }

  /** A pull's reservation includes verification and retagging. Record the
   * accepted image before releasing it, even though no local build ran. */
  async pull<T extends { pulled: boolean }>(image: string, work: () => Promise<T>): Promise<T> {
    return this.build(image, async () => {
      const result = await work();
      if (result.pulled) await this.built(image, Date.now());
      return result;
    });
  }

  private buildsRunning(): boolean { return this.preparingBuilds > 0 || this.deps.buildsRunning() > 0; }

  private async buildHold(pressure: BuildSpacePressure) {
    const [disk, policy] = await Promise.all([this.deps.filesystem(), this.deps.cachePolicy?.()]);
    const cacheLimited = !!policy && pressure.requiredCacheBytes > policy.maxBytes;
    // Merely reclaiming what this failed build consumed recreates its original
    // starting conditions. Require extra room, even on a larger but busy disk.
    const workingRoom = Math.max(GiB, pressure.consumedBytes + GiB);
    const improved = disk.totalBytes >= pressure.requiredBytes ||
      disk.freeBytes - pressure.failedFreeBytes >= workingRoom;
    const needsGrowth = !improved || disk.freeBytes < workingRoom;
    if (!needsGrowth && !cacheLimited) return null;
    let message = `This project's image needs about ${gib(pressure.requiredBytes)} GiB of machine disk to build with room for its cache; the machine has ${gib(disk.totalBytes)} GiB. ` +
      'This is an estimate from observed build use, not the final image size. ' +
      (needsGrowth ? 'Ask the site admin to raise the disk. ' : '') + 'Another cold rebuild is held until capacity improves.';
    if (pressure.cacheEvictedBytes) message += ` ${gib(pressure.cacheEvictedBytes)} GiB of build cache disappeared while the disk was below its free-space reserve.`;
    if (cacheLimited) message += ` The running Docker cache limit is ${gib(policy!.maxBytes)} GiB, below the ${gib(pressure.requiredCacheBytes)} GiB of cache observed. Docker cannot reload BuildKit cache limits live; a site admin must explicitly restart Docker to apply limits for the larger disk. That stops this project's running containers.`;
    return { message, needsGrowth };
  }

  /** Observe cheap filesystem high-water marks during the build. Inventory is
   * read only at its boundaries, never polled while Rust generates large trees. */
  private async measureBuild<T>(image: string, identity: string, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const sequence = this.buildSequence;
    const isolated = this.preparingBuilds === 1 && this.deps.buildsRunning() === 0;
    const [before, initial, policy, prior] = await Promise.all([
      this.deps.inventory(), this.deps.filesystem(), this.deps.cachePolicy?.(), this.storage.getDiskSpaceState(),
    ]);
    const priorCache = new Map(before.BuildCache.map(c => [c.ID, c]));
    let minimumFree = initial.freeBytes;
    let sample = Promise.resolve();
    const timer = setInterval(() => {
      sample = sample.then(async () => { minimumFree = Math.min(minimumFree, (await this.deps.filesystem()).freeBytes); })
        .catch(error => logger.warn(`Could not sample build disk use: ${error.message}`));
    }, 2000);
    timer.unref();
    let failure: unknown;
    try { return await work(); }
    catch (error) { failure = error; throw error; }
    finally {
      clearInterval(timer);
      await sample;
      try {
        const disk = await this.deps.filesystem();
        minimumFree = Math.min(minimumFree, disk.freeBytes);
        const floor = policy?.minFreeBytes ?? initial.totalBytes * 0.2;
        let after: EngineDiskUsage | null = null;
        try { after = await this.deps.inventory(); }
        catch (error) { logger.warn(`Could not measure build cache after the build: ${error instanceof Error ? error.message : String(error)}`); }
        const knownCache = prior?.buildCache?.image === image && prior.buildCache.identity === identity ? prior.buildCache.records : [];
        const remaining = new Set(after?.BuildCache.map(c => c.ID));
        const evictedBytes = after ? sum(knownCache.filter(c => !remaining.has(c.id)), c => c.bytes) : 0;
        // Only new records or an advancing usage timestamp establish use.
        // A previous build can have touched cache in the same rounded second.
        const usedCache = isolated && sequence === this.buildSequence ? after?.BuildCache.filter(c => {
          if (c.Shared || c.InUse) return false;
          const previous = priorCache.get(c.ID);
          const lastUsed = Date.parse(c.LastUsedAt ?? '') || 0;
          return Math.max(lastUsed, Date.parse(c.CreatedAt) || 0) >= Math.floor(startedAt / 1000) * 1000 &&
            (!previous || lastUsed > (Date.parse(previous.LastUsedAt ?? '') || 0));
        }) : undefined;
        const full = isBuildDiskFull(failure);
        // BuildKit can release a failed layer before our next statfs sample.
        // Its ENOSPC diagnostic proves exhaustion even when free space returned.
        if (full) minimumFree = 0;
        if (full || (minimumFree <= floor && evictedBytes > 0)) {
          const peakUsedBytes = initial.totalBytes - minimumFree;
          const requiredCacheBytes = Math.max(sum(usedCache ?? [], c => c.Size), evictedBytes);
          const pressure: BuildSpacePressure = { image, identity, at: new Date().toISOString(), blocked: true,
            reason: full ? 'enospc' : 'cache-evicted', diskBytes: disk.totalBytes,
            requiredBytes: Math.ceil(Math.max((peakUsedBytes + GiB) / 0.8, requiredCacheBytes / 0.4) / GiB) * GiB,
            peakUsedBytes, consumedBytes: Math.max(0, initial.freeBytes - minimumFree), failedFreeBytes: minimumFree,
            cacheEvictedBytes: evictedBytes, requiredCacheBytes, cacheLimitBytes: policy?.maxBytes ?? null, message: '' };
          pressure.message = (await this.buildHold(pressure))?.message ?? `Build cache disappeared while free space fell below ${gib(floor)} GiB. A further build will use the measured capacity check.`;
          await this.exhausted(new Error(pressure.message), pressure);
          if (failure && typeof failure === 'object') this.recordedBuildFailures.add(failure);
          logger.warn(pressure.message);
        } else if (!failure) {
          await this.writeState(s => {
            if (!samePressure(s.buildPressure, prior?.buildPressure)) return;
            if (s.buildPressure?.identity === identity && s.buildPressure.image === image) {
              // A successful retry pays only the request its observation owns.
              // Another launch may have reported exhaustion during this build.
              if (s.buildPressure.growthGeneration !== undefined && s.growthGeneration === s.buildPressure.growthGeneration) s.needsGrowth = false;
              delete s.buildPressure;
            }
          });
        }
        if (!failure && usedCache) {
          await this.writeState(s => { s.buildCache = { image, identity, records: usedCache.map(c => ({ id: c.ID, bytes: c.Size })) }; });
        }
      } catch (error) {
        // Telemetry must never replace the compiler/engine's actual failure.
        logger.warn(`Could not record build-space pressure: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async acknowledgeGrowth(generation: number): Promise<boolean> {
    const observed = await this.storage.getDiskSpaceState();
    if ((observed?.growthGeneration ?? 0) !== generation) return false;
    const pressure = observed?.buildPressure;
    const hold = pressure?.blocked ? await this.buildHold(pressure) : null;
    let acknowledged = false;
    await this.writeState(s => {
      if ((s.growthGeneration ?? 0) !== generation) return;
      if (!samePressure(s.buildPressure, pressure)) return;
      s.needsGrowth = hold?.needsGrowth ?? false;
      if (s.buildPressure) {
        s.buildPressure.blocked = !!hold;
        if (hold) s.buildPressure.message = hold.message;
      }
      acknowledged = true;
    });
    return acknowledged;
  }

  async buildRetryHold(): Promise<string | null> {
    const pressure = (await this.storage.getDiskSpaceState())?.buildPressure;
    return pressure?.blocked ? (await this.buildHold(pressure))?.message ?? null : null;
  }

  /** Recovery must remain readable even when a full engine cannot inventory
   * its objects. This reads only the durable project store. */
  async recoveryStatus() {
    const state = await this.storage.getDiskSpaceState();
    return { supported: true, needsGrowth: state?.needsGrowth ?? false,
      growthGeneration: state?.growthGeneration ?? 0, lastRecovery: state?.lastRecovery ?? null,
      buildPressure: state?.buildPressure ?? null };
  }

  /** Keep the previous image too, including a same-tag rebuild's dangling ID. */
  async built(imageName: string, startedAt: number): Promise<void> {
    const groupName = family({ Id: '', RepoTags: [imageName], Created: 0, Size: 0 });
    if (groupName && groupName !== 'dangling') this.currentBuildNames.set(groupName, imageName);
    // Keep observations in call order even when concurrent build inventories
    // complete out of order. The saved current image must survive a restart.
    const record = this.imageRecords.then(async () => {
      const inventory = await this.deps.inventory();
      const image = inventory.Images.find(i => i.RepoTags?.includes(imageName));
      if (!image) return;
      const group = family(image);
      if (!group || group === 'dangling') return;
      await this.writeState(s => {
        s.images = [{ id: image.Id, name: imageName, family: group, builtAt: startedAt }, ...s.images.filter(i => i.id !== image.Id)]
          .filter((i, index, rows) => rows.slice(0, index).filter(x => x.family === i.family).length < 2);
      });
    });
    // The returned promise still surfaces failure to its caller; only the
    // queue's tail recovers so a failed inventory cannot poison later builds.
    this.imageRecords = record.then(() => undefined, () => undefined);
    await record;
  }

  async view(): Promise<DiskSpaceView> {
    const [data, disk, state, protectedNames, pins] = await Promise.all([
      this.deps.inventory(), this.deps.filesystem(), this.storage.getDiskSpaceState(), this.protectedContainers(), this.imagePins(),
    ]);
    const keep = new Set(data.Containers.map(c => c.ImageID));
    const warm = new Set<string>();
    // Bootstrap an existing guest, then prefer the recorded build order: a
    // same-tag rebuild's previous image is dangling, but still retained.
    for (const group of ['runner', 'project']) {
      const candidates = data.Images.filter(i => family(i) === group).sort((a, b) => b.Created - a.Created);
      const recorded = (state?.images ?? []).filter(i => i.family === group && data.Images.some(image => image.Id === i.id));
      const currentName = this.currentBuildNames.get(group) ?? recorded[0]?.name;
      const namedCurrent = currentName ? candidates.find(i => i.RepoTags?.includes(currentName)) : undefined;
      const current = namedCurrent?.Id ?? recorded[0]?.id ?? candidates[0]?.Id;
      const retained = [...new Set([...(current ? [current] : []), ...recorded.map(i => i.id), ...candidates.map(i => i.Id)])].slice(0, 2);
      for (const id of retained) keep.add(id);
      if (retained[0]) warm.add(retained[0]);
    }
    for (const i of data.Images) if (i.RepoTags?.some(t => pins.has(t))) { keep.add(i.Id); warm.add(i.Id); }
    const keptImages = data.Images.filter(i => warm.has(i.Id));
    // A cache used by a current/pinned image must survive. A reused
    // record's LastUsedAt advances on a build; protecting everything accessed
    // since the oldest current build also protects all its intermediate steps.
    const dates = keptImages.map(i => i.Created * 1000).filter(n => n > 0);
    const cutoff = dates.length ? Math.min(...dates) - 300_000 : 0;
    const items: DiskItem[] = [];
    const idle = !this.buildsRunning();
    if (idle) {
      for (const c of data.Containers) {
        const names = c.Names.map(n => n.replace(/^\//, ''));
        if (!['exited', 'dead', 'created'].includes(c.State) || c.Labels?.['lazy.project'] !== this.projectRoot) continue;
        if (c.Labels['lazy.kept'] === '1' || c.Labels['lazy.member-terminal'] !== undefined ||
          names.some(n => protectedNames.has(n) || /^(?:lazy-builder-|lazymember-)/.test(n))) continue;
        items.push({ kind: 'container', id: c.Id, name: names.join(', '), bytes: c.SizeRw ?? 0 });
      }
      for (const i of data.Images) {
        if (!family(i) || keep.has(i.Id) || (i.Containers ?? 0) > 0) continue;
        const references = imageRemovalReferences(i);
        if (!references) continue;
        items.push({ kind: 'image', id: i.Id, name: [...(i.RepoTags ?? []), ...(i.RepoDigests ?? [])].join(', ') || i.Id,
          references, bytes: Math.max(0, i.Size - (i.SharedSize ?? i.Size)) });
      }
      const cacheBytes = sum(data.BuildCache, c => c.Size);
      let excess = Math.max(0, cacheBytes - disk.totalBytes * 0.4, disk.totalBytes * 0.2 - disk.freeBytes);
      for (const c of [...data.BuildCache].sort((a, b) => Date.parse(a.LastUsedAt || a.CreatedAt) - Date.parse(b.LastUsedAt || b.CreatedAt))) {
        const used = Date.parse(c.LastUsedAt || c.CreatedAt);
        if (excess <= 0 || c.InUse || c.Shared || !cutoff || !Number.isFinite(used) || used >= cutoff) continue;
        items.push({ kind: 'build-cache', id: c.ID, name: c.Description || c.ID, bytes: c.Size });
        excess -= c.Size;
      }
    }
    items.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    // Sizes/free space change during normal use and aren't approval subjects.
    const id = createHash('sha256').update(JSON.stringify(items.map(i => [i.kind, i.id, i.references, i.kind === 'image' ? i.name : undefined]))).digest('hex');
    return {
      supported: true,
      usage: { ...disk, buildCacheBytes: sum(data.BuildCache, c => c.Size), imagesBytes: data.LayersSize,
        containersBytes: sum(data.Containers, c => c.SizeRw ?? 0) },
      plan: { id, items, reclaimableBytes: sum(items, i => i.bytes) },
      lastRecovery: state?.lastRecovery ?? null, needsGrowth: state?.needsGrowth ?? false,
      growthGeneration: state?.growthGeneration ?? 0,
      buildPressure: state?.buildPressure ?? null,
      taskData: (data.Volumes ?? []).filter(v => v.Name.startsWith('lazy-data-'))
        .map(v => ({ name: v.Name, bytes: typeof v.UsageData?.Size === 'number' && v.UsageData.Size >= 0 ? v.UsageData.Size : null })),
    };
  }

  private async protectedContainers(): Promise<Set<string>> {
    const names = new Set<string>();
    const tasks = await this.storage.listTasks();
    for (const t of tasks) {
      // Finished-task teardown owns these too: it must verify removal and
      // coordinate member environments before deleting their worktrees.
      for (const ref of [taskRef(t), deriveTaskRef(t, tasks)]) {
        names.add(`lazy-${ref}`); names.add(`lazy-${ref}-review`);
      }
      const session = await this.storage.getSessionByTaskId(t.id);
      if (session?.container_name) names.add(session.container_name);
      if (t.in_flight_turn?.run_name) names.add(t.in_flight_turn.run_name);
    }
    for (const session of await this.storage.listBuilderSessions(this.projectRoot)) {
      if (session.containerName) names.add(session.containerName);
    }
    return names;
  }

  private async imagePins(): Promise<Set<string>> {
    const pins = new Set<string>();
    for (const t of await this.storage.listTasks()) {
      if (t.metadata?.custom_image) pins.add(t.metadata.custom_image);
    }
    return pins;
  }

  reclaim(reason: string, planId?: string): Promise<{ freedBytes: number }> {
    if (this.reclaiming) {
      if (planId) throw new DiskSpaceError(409, 'Space is already being freed. Refresh the preview when it finishes.');
      return this.reclaiming;
    }
    this.reclaiming = this.reclaimOnce(reason, planId).finally(() => { this.reclaiming = null; });
    return this.reclaiming;
  }

  private async reclaimOnce(reason: string, planId?: string): Promise<{ freedBytes: number }> {
    const before = await this.view();
    if (planId && planId !== before.plan.id) throw new DiskSpaceError(409, 'What can be freed has changed. Open Free space again to see the current preview.');
    if (!before.plan.items.length && reason === 'periodic maintenance') return { freedBytes: 0 };
    const errors: string[] = [];
    for (const item of before.plan.items) {
      // Builds wait on this reclaim. Re-read DOMAIN ownership for each object;
      // Docker itself atomically refuses a running/referenced object at rm.
      // Do not repeat /system/df per item: sizing every cache N times would
      // turn a large inventory into quadratic filesystem work.
      if (this.buildsRunning()) break;
      if (item.kind === 'container') {
        const protectedNames = await this.protectedContainers();
        if (item.name.split(', ').some(name => protectedNames.has(name))) continue;
      }
      if (item.kind === 'image') {
        const pins = await this.imagePins();
        if (item.name.split(', ').some(name => pins.has(name))) continue;
      }
      try {
        if (item.kind === 'build-cache') {
          if (!/^[a-zA-Z0-9]+$/.test(item.id)) throw new Error('Invalid build cache ID from Docker');
          // BuildKit checks in-use refs at deletion too. `until` protects a
          // record reused between the inventory and the actual prune.
          await this.deps.command(['buildx', '--builder', 'default', 'prune', '--force', '--all',
            '--filter', `id=^${item.id}$`, '--filter', 'until=5m']);
        } else if (item.kind === 'image') {
          for (const reference of item.references!) {
            const pins = await this.imagePins();
            if (pins.has(reference) || item.name.split(', ').some(name => pins.has(name))) break;
            // No force, and no recursive removal of unpreviewed parent images.
            await this.deps.command(['image', 'rm', '--no-prune', reference]);
          }
        } else {
          if (!/^(?:sha256:)?[a-f0-9]{12,64}$/.test(item.id)) throw new Error('Invalid object ID from Docker');
          await this.deps.command(['container', 'rm', item.id]);
        }
      } catch (error) {
        // A new reference makes non-forced rm refuse. Keep it, and show the
        // actual refusal rather than presenting an incomplete reclaim as done.
        errors.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const after = await this.deps.filesystem();
    const freedBytes = Math.max(0, after.freeBytes - before.usage.freeBytes);
    const error = errors.length ? errors.join('\n') : undefined;
    await this.writeState(s => { s.lastRecovery = { at: new Date().toISOString(), freedBytes, reason, ...(error ? { error } : {}) }; });
    await this.storage.createSystemMessage({ source: 'machine-disk', kind: error ? 'notice' : 'report',
      title: 'Project disk space reclaimed', body: `Lazy freed ${freedBytes} bytes (${reason}). Running work and the current image's warm cache were kept.${error ? `\n\nKept objects Docker could not remove:\n${error}` : ''}` }, { collapseRepeats: true, refreshBody: true });
    logger.info(`Disk reclaim: freed ${freedBytes} bytes (${reason})${error ? `; ${error}` : ''}`);
    return { freedBytes };
  }

  async exhausted(error: unknown, pressure?: BuildSpacePressure): Promise<void> {
    if (!pressure && error && typeof error === 'object' && this.recordedBuildFailures.has(error)) return;
    const detail = redactSecretValues(error instanceof Error ? error.message : String(error)).slice(-4000);
    await this.writeState(s => {
      s.needsGrowth = true;
      s.growthGeneration = (s.growthGeneration ?? 0) + 1;
      if (pressure) s.buildPressure = { ...pressure, growthGeneration: s.growthGeneration };
      s.lastRecovery = { at: new Date().toISOString(), freedBytes: s.lastRecovery?.freedBytes ?? 0, reason: 'disk-full recovery', error: detail };
    });
    await this.storage.createSystemMessage({ source: 'machine-disk', kind: 'alert',
      title: 'This project ran out of disk space',
      body: 'A build or launch ran out of space again after safe reclaim and one retry. Teams will grow the disk within its configured ceiling, without stopping running work. If the ceiling or host capacity prevents this, god mode can review the disk on the Machine page.' },
    { collapseRepeats: true, refreshBody: true });
  }
}

let manager: DiskSpaceManager | null = null;
export function setDiskSpaceManager(value: DiskSpaceManager | null): void { manager = value; }
export function currentDiskSpaceManager(): DiskSpaceManager | null { return manager; }

/** Applies to every harness: image build/pull, task launch and member builder. */
export async function withDiskSpaceRecovery<T>(binary: string, work: () => Promise<T>, notify?: (line: string) => void): Promise<T> {
  const active = binary === 'docker' ? manager : null;
  try { return await work(); }
  catch (error) {
    if (!active || !isEngineDiskFull(error)) throw error;
    const note = 'The project ran out of disk space. Freeing unused Docker space and retrying once; running work stays in place.';
    logger.warn(note); notify?.(note);
    try { await active.reclaim('disk-full recovery'); }
    catch (reclaimError) {
      await active.exhausted(reclaimError);
      throw new DiskFullError(`The project ran out of space and an admin has been told. Safe reclaim failed: ${reclaimError instanceof Error ? reclaimError.message : String(reclaimError)}`);
    }
    try { return await work(); }
    catch (again) {
      if (!isEngineDiskFull(again)) throw again;
      await active.exhausted(again);
      throw new DiskFullError('The project ran out of space and an admin has been told. Safe reclaim and one retry were not enough.');
    }
  }
}

/** A detached docker run may create its named container and then run out of
 * space starting it. Retry START on that very container, not another run with
 * the same name, and never delete it to make a retry fit. */
export async function launchWithDiskSpaceRecovery(
  argv: string[], timeoutMs: number, notify?: (line: string) => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = argv[0];
  const nameIndex = argv.indexOf('--name');
  const name = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
  const execute = async (args: string[]) => {
    const proc = spawn(args, { stdout: 'pipe', stderr: 'pipe', timeout: 0 });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* The process exited between the deadline and kill. */ }
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timedOut) throw new Error(`Timed out after ${timeoutMs / 1000}s launching container ${name ?? '(unnamed)'}. The container runtime may be unresponsive; check the machine diagnostics, then retry.`);
      return { stdout, stderr, exitCode: exitCode ?? 1 };
    } finally { clearTimeout(timer); }
  };
  const initial = manager && binary === 'docker' && name
    ? await execute([binary, 'container', 'inspect', name, '--format', '{{.Id}}']) : null;
  const absent = initial?.exitCode !== 0 && /No such (?:object|container)/i.test(initial?.stderr ?? '');
  let retry = false;
  return withDiskSpaceRecovery(binary, async () => {
    let result;
    if (retry && absent && name) {
      result = await execute([binary, 'start', name]);
      if (result.exitCode !== 0 && /No such (?:object|container)/i.test(result.stderr)) result = await execute(argv);
    } else result = await execute(argv);
    if (result.exitCode !== 0 && isEngineDiskFull(result.stderr)) { retry = true; throw new Error(result.stderr); }
    return result;
  }, notify);
}
