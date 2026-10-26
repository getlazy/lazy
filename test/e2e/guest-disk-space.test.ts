/** Real build chokepoint and Engine HTTP inventory; only the guest engine is
 * faked. A module-mocked agent cannot prove a failed build was retried. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile, readFile, chmod, rm } from 'fs/promises';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { DiskSpaceManager, guestDiskSpaceDeps, setDiskSpaceManager, launchWithDiskSpaceRecovery, type EngineDiskUsage } from '../../src/docker/disk-space';
import { buildDockerfileCandidate, buildProjectImageToTag, resetBuildFailuresForTests } from '../../src/capture/claude';
import { PUBLISHED_RUNNER_REF, runnerIdentityHash } from '../../src/docker/runner-dockerfile';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';

// INVARIANT: an engine ENOSPC gets safe reclaim and exactly one real retry;
// Dockerfile failures never trigger destructive cleanup of the project.
describe('guest disk-full build recovery', () => {
  let ctx: TestContext, storage: FileStorage;
  let server: ReturnType<typeof Bun.serve>;
  let undoConfig: () => void;
  let previousPath: string | undefined;
  let dir: string;
  let manager: DiskSpaceManager;
  let deps: ReturnType<typeof guestDiskSpaceDeps>;
  let images: EngineDiskUsage['Images'];
  let inventoryError: string | undefined;
  beforeEach(async () => {
    ctx = await setupTestLazy();
    undoConfig = pinConfig(ctx.root);
    dir = join(ctx.root, 'fake-guest');
    await mkdir(dir);
    // The project store stays external; this independent store is the fake
    // guest's durable recovery record, not a hardcoded .lazy/tasks path.
    storage = new FileStorage(ctx.root, { basePath: join(dir, 'store') });
    await storage.initialize();
    inventoryError = undefined;
    images = [{ Id: 'a'.repeat(64), RepoTags: ['lazy-runner:current'], Created: 5000, Size: 1000 }];
    const script = `#!/usr/bin/env bash
set -eu
STATE=${JSON.stringify(dir)}
printf '%s\\n' "$*" >> "$STATE/calls"
case "$1" in
 info|version) exit 0 ;;
 pull)
   if [ -f "$STATE/pull-full-once" ] && [ ! -f "$STATE/pruned" ]; then
     echo 'Error response from daemon: write /storage/docker/containerd/content/data: no space left on device' >&2
     exit 1
   fi
   touch "$STATE/pulled"; exit 0 ;;
 image)
   if [ "$2" = inspect ]; then echo '${runnerIdentityHash()}'; fi
   exit 0 ;;
 tag)
   touch "$STATE/tagging"
   while [ -f "$STATE/tag-gate" ]; do sleep 0.01; done
   printf '%s' "$3" > "$STATE/tagged"
   exit 0 ;;
 build)
   if [ -f "$STATE/unrelated-cache-gc" ]; then
     touch "$STATE/pruned"
     if [ -f "$STATE/compiler-error" ]; then
       echo '#8 20.1 error: syntax error in project source' >&2
       echo 'ERROR: failed to build: failed to solve: process "cargo build" did not complete successfully: exit code: 101' >&2
       exit 1
     fi
   fi
   if [ -f "$STATE/always-full" ] || [ ! -f "$STATE/pruned" ]; then
     touch "$STATE/build-failed"
     if [ -f "$STATE/compiler-full" ]; then
       echo '#8 20.1 error: failed to build archive /opt/cargo-target/file.rlib: No space left on device (os error 28)' >&2
       echo 'ERROR: failed to build: failed to solve: process "cargo build" did not complete successfully: exit code: 101' >&2
     else
       echo 'ERROR: failed to build: failed to solve: failed to extract layer sha256:8c0c: write /storage/docker/containerd/snapshots/1349/fs/opt/cargo-target/release/deps/file.rlib: no space left on device' >&2
     fi
     exit 1
   fi
   echo '#1 DONE 0.1s'; exit 0 ;;
 buildx) touch "$STATE/pruned"; exit 0 ;;
 container)
   if [ -f "$STATE/created" ]; then echo 'container-id'; exit 0; fi
   echo 'Error response from daemon: No such container: lazy-current' >&2; exit 1 ;;
 run)
   case "$*" in *selfcheck*) echo '${AGENT_SELFCHECK_SENTINEL}'; exit 0 ;; esac
   if [ ! -f "$STATE/pruned" ]; then
     if [ -f "$STATE/partial" ]; then touch "$STATE/created"; fi
     echo 'docker: Error response from daemon: mkdir /storage/docker/containers: no space left on device' >&2
     exit 1
   fi
   echo 'container-id'; exit 0 ;;
 start)
   if [ ! -f "$STATE/created" ]; then
     echo 'Error response from daemon: No such container: lazy-current' >&2; exit 1
   fi
   echo 'container-id'; exit 0 ;;
 *) exit 0 ;;
esac
`;
    await writeFile(join(dir, 'docker'), script);
    await chmod(join(dir, 'docker'), 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath}`;
    await writeFile(join(ctx.root, 'Candidate.Dockerfile'), 'FROM alpine:3.20\nRUN true\n');
    const socket = join(dir, 'engine.sock');
    server = Bun.serve({ unix: socket, async fetch(request) {
      expect(new URL(request.url).pathname).toBe('/v1.51/system/df');
      if (inventoryError) return new Response(inventoryError, { status: 500 });
      const pruned = await Bun.file(join(dir, 'pruned')).exists();
      const inventoryImages = structuredClone(images);
      if (await Bun.file(join(dir, 'pulled')).exists()) {
        const tags = [PUBLISHED_RUNNER_REF];
        if (await Bun.file(join(dir, 'tagged')).exists()) tags.push(await readFile(join(dir, 'tagged'), 'utf8'));
        inventoryImages.push({ Id: 'c'.repeat(64), RepoTags: tags, Created: 6000, Size: 1000 });
      }
      return Response.json({ LayersSize: 1000, Containers: [], Images: inventoryImages, BuildCache: pruned ? [] : [
        { ID: 'oldcache', Size: 1024 ** 4, InUse: false, Shared: false, CreatedAt: '1970-01-01T00:01:00Z' },
      ] });
    } });
    deps = { ...guestDiskSpaceDeps({ socketPath: socket, storageRoot: dir, configPath: join(dir, 'dockerd.json') }),
      // Safe reclaim actually improves the fake guest's room; the host's own
      // statfs cannot represent the layer that just exhausted this engine.
      filesystem: async () => ({ totalBytes: 32 * 1024 ** 3,
        freeBytes: ((await Bun.file(join(dir, 'pruned')).exists()) ? 16 : 1) * 1024 ** 3 }),
    };
    manager = new DiskSpaceManager(storage, ctx.root, deps);
    setDiskSpaceManager(manager);
  });
  afterEach(async () => {
    setDiskSpaceManager(null);
    server?.stop(true);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    undoConfig?.();
    resetBuildFailuresForTests();
    await storage?.close();
    await ctx?.cleanup();
  });

  const build = () => buildDockerfileCandidate(ctx.root, {
    dockerfilePath: join(ctx.root, 'Candidate.Dockerfile'), contextDir: ctx.root, source: 'the consented candidate', selfcheck: false,
  });

  test('a full guest engine is reclaimed and the build succeeds on its one retry', async () => {
    await build();
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
    expect(calls.filter(c => c.startsWith('build '))).toHaveLength(2);
    expect(calls.filter(c => c.includes('prune'))).toEqual([
      'buildx --builder default prune --force --all --filter id=^oldcache$ --filter until=5m',
    ]);
    expect(calls.some(c => /system prune|volume|rm -f/.test(c))).toBe(false);
    expect((await storage.getDiskSpaceState())!.needsGrowth).toBe(false);
  });

  test('a second ENOSPC stops retrying and durably asks Teams to grow the disk', async () => {
    await writeFile(join(dir, 'always-full'), '1');
    await expect(build()).rejects.toThrow('project ran out of space and an admin has been told');
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(c => c.startsWith('build '))).toHaveLength(2);
    expect((await storage.getDiskSpaceState())!.needsGrowth).toBe(true);
    expect((await storage.listSystemMessages()).some(m => m.title === 'This project ran out of disk space')).toBe(true);
  });

  test('inventory ENOSPC before a build still durably requests growth', async () => {
    inventoryError = 'write /storage/docker/containerd/metadata.db: no space left on device';
    await expect(build()).rejects.toThrow('project ran out of space and an admin has been told');
    expect((await manager.recoveryStatus()).needsGrowth).toBe(true);
    expect((await storage.listSystemMessages()).some(m => m.title === 'This project ran out of disk space')).toBe(true);
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').some(c => c.startsWith('build '))).toBe(false);
  });

  test('a Rust-sized full-disk build is held across retries and daemon restart until capacity improves', async () => {
    const GiB = 1024 ** 3;
    let total = 32 * GiB;
    const measuredDeps = { ...deps, filesystem: async () => ({ totalBytes: total,
      freeBytes: total > 32 * GiB ? 32 * GiB : (await Bun.file(join(dir, 'build-failed')).exists()) ? 0 : 20 * GiB }) };
    manager = new DiskSpaceManager(storage, ctx.root, measuredDeps);
    setDiskSpaceManager(manager);
    await writeFile(join(dir, 'always-full'), '1');
    await expect(build()).rejects.toThrow('Another cold rebuild is held');
    const state = await manager.recoveryStatus();
    expect(state.buildPressure!.message).toContain('needs about 42 GiB');
    expect(state.buildPressure!.message).toContain('machine has 32 GiB');
    manager = new DiskSpaceManager(storage, ctx.root, measuredDeps);
    setDiskSpaceManager(manager);
    resetBuildFailuresForTests();
    await expect(build()).rejects.toThrow('Another cold rebuild is held');
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(c => c.startsWith('build '))).toHaveLength(1);
    total = 64 * GiB;
    await rm(join(dir, 'always-full'));
    await manager.acknowledgeGrowth(state.growthGeneration);
    resetBuildFailuresForTests();
    await build();
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(c => c.startsWith('build '))).toHaveLength(2);
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
  });

  // INVARIANT: BuildKit can release the failed layer before statfs observes
  // exhaustion. Neither automatic nor explicit retry may repeat that build.
  for (const compiler of [false, true]) test(`${compiler ? 'Rust' : 'engine'} exhaustion is held when layer cleanup precedes the final sample`, async () => {
    const measured = { ...deps, filesystem: async () => ({ totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 }) };
    manager = new DiskSpaceManager(storage, ctx.root, measured);
    setDiskSpaceManager(manager);
    await writeFile(join(dir, 'always-full'), '1');
    if (compiler) await writeFile(join(dir, 'compiler-full'), '1');
    await expect(build()).rejects.toThrow();
    expect((await manager.recoveryStatus()).buildPressure!.reason).toBe('enospc');
    manager = new DiskSpaceManager(storage, ctx.root, measured);
    setDiskSpaceManager(manager);
    resetBuildFailuresForTests();
    await expect(build()).rejects.toThrow('Another cold rebuild is held');
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(c => c.startsWith('build '))).toHaveLength(1);
  });

  // INVARIANT: the Engine collecting unrelated old cache must not hold this
  // image, even below the free reserve or alongside an ordinary compiler bug.
  for (const compilerError of [false, true]) test(`unrelated cache collection does not request growth after ${compilerError ? 'a compiler error' : 'a successful build'}`, async () => {
    manager = new DiskSpaceManager(storage, ctx.root, { ...deps,
      filesystem: async () => ({ totalBytes: 32 * 1024 ** 3,
        freeBytes: ((await Bun.file(join(dir, 'pruned')).exists()) ? 3 : 8) * 1024 ** 3 }),
    });
    setDiskSpaceManager(manager);
    await writeFile(join(dir, 'unrelated-cache-gc'), '1');
    if (compilerError) {
      await writeFile(join(dir, 'compiler-error'), '1');
      await expect(build()).rejects.toThrow('syntax error');
    } else await build();
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
    expect(await manager.buildRetryHold()).toBeNull();
  });

  // INVARIANT: a published pull is reserved through verification and tagging,
  // and records current/previous durably before releasing its reservation.
  test('the real published pull protects its untagged image and records retention across restart', async () => {
    images.push({ Id: 'b'.repeat(64), RepoTags: ['lazy-runner:previous'], Created: 4000, Size: 1000 });
    await manager.built('lazy-runner:previous', 1000);
    await manager.built('lazy-runner:current', 2000);
    await writeFile(join(dir, 'tag-gate'), '1');
    const pulling = buildProjectImageToTag(ctx.root, 'pulled-new');
    // Attach a rejection handler immediately, then always release and await
    // the fake engine process even if the concurrency assertion fails.
    const outcome = pulling.then(value => ({ value }), error => ({ error }));
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(join(dir, 'tagging')).exists()) && Date.now() < deadline) await Bun.sleep(10);
      expect(await Bun.file(join(dir, 'tagging')).exists()).toBe(true);
      expect((await manager.view()).plan.items).toEqual([]);
      await manager.reclaim('periodic maintenance');
      const calls = await readFile(join(dir, 'calls'), 'utf8');
      expect(calls).not.toContain('prune');
      expect(calls).not.toContain('image rm');
    } finally {
      await rm(join(dir, 'tag-gate'), { force: true });
      await outcome;
    }
    expect(await pulling).toBe('lazy-runner:pulled-new');
    const restarted = new DiskSpaceManager(storage, ctx.root, deps);
    const plan = (await restarted.view()).plan;
    expect(plan.items.some(i => ['a'.repeat(64), 'c'.repeat(64)].includes(i.id))).toBe(false);
    expect(plan.items.some(i => i.id === 'b'.repeat(64))).toBe(true);
    expect((await storage.getDiskSpaceState())!.images.map(i => i.id)).toEqual(['c'.repeat(64), 'a'.repeat(64)]);
    expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(c => c.startsWith('pull '))).toEqual([`pull ${PUBLISHED_RUNNER_REF}`]);
  });

  test('a published pull releases its failed reservation for reclaim and retries once', async () => {
    await writeFile(join(dir, 'pull-full-once'), '1');
    expect(await buildProjectImageToTag(ctx.root, 'pull-retry')).toBe('lazy-runner:pull-retry');
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).split('\n');
    expect(calls.filter(c => c.startsWith('pull '))).toHaveLength(2);
    expect(calls.filter(c => c.includes('prune'))).toEqual([
      'buildx --builder default prune --force --all --filter id=^oldcache$ --filter until=5m',
    ]);
    expect((await storage.getDiskSpaceState())!.images[0].id).toBe('c'.repeat(64));
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
  });

  // INVARIANT: a partially created task container survives disk recovery;
  // repeating docker run must not collide with or delete that same container.
  test('launch retries start on the same partially created container', async () => {
    await writeFile(join(dir, 'partial'), '1');
    const result = await launchWithDiskSpaceRecovery(['docker', 'run', '-d', '--name', 'lazy-current', 'lazy-runner:current'], 5000);
    expect(result.exitCode).toBe(0);
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
    expect(calls.filter(c => c.startsWith('run '))).toHaveLength(1);
    expect(calls.filter(c => c.startsWith('start '))).toEqual(['start lazy-current']);
    expect(calls.some(c => /container rm|system prune|volume/.test(c))).toBe(false);
  });

  test('launch retries run only when the engine created no container', async () => {
    const result = await launchWithDiskSpaceRecovery(['docker', 'run', '-d', '--name', 'lazy-current', 'lazy-runner:current'], 5000);
    expect(result.exitCode).toBe(0);
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
    expect(calls.filter(c => c.startsWith('run '))).toHaveLength(2);
    expect(calls.filter(c => c.startsWith('start '))).toHaveLength(1);
  });
});
