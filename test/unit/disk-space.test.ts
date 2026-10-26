import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { DiskSpaceManager, isEngineDiskFull, setDiskSpaceManager, withDiskSpaceRecovery, type EngineDiskUsage } from '../../src/docker/disk-space';
import { handleRebuildRunnerImage } from '../../src/daemon/rpc-handlers';

const GiB = 1024 ** 3;
const id = (n: number) => n.toString(16).padStart(64, '0');
const image = (n: number, tag: string, created: number) => ({ Id: id(n), RepoTags: [tag], Created: created, Size: GiB, SharedSize: 0, Containers: 0 });
const container = (n: number, name: string, state = 'exited', labels = {}) => ({ Id: id(n), Names: ['/' + name], ImageID: id(99), State: state, Labels: { 'lazy.project': '/project', ...labels }, SizeRw: GiB });
const diskFull = () => new Error('ERROR: failed to build: failed to solve: failed to extract layer sha256:abc: write /storage/docker/snapshots/1349/fs/opt/cargo-target/file.rlib: no space left on device');

// INVARIANT: reclaim never removes running work, current task/member containers,
// volumes, worktrees or the cache used by retained images. Disk recovery must
// not turn a temporary capacity failure into permanent loss of a session.
describe('private guest disk reclaim', () => {
  let root: string, storage: FileStorage, manager: DiskSpaceManager;
  let data: EngineDiskUsage;
  let commands: string[][];
  let free: number;
  let builds: number;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-disk-space-'));
    storage = new FileStorage(root, { basePath: join(root, 'store') });
    await storage.initialize();
    data = { LayersSize: 4 * GiB,
      Images: [image(1, 'lazy-runner:current', 5000), image(2, 'lazy-runner:previous', 4000), image(3, 'lazy-runner:old', 1000),
        image(4, 'lazy-custom-abc123:current', 5000), image(5, 'lazy-custom-def123:previous', 4000), image(6, 'lazy-custom-fed123:old', 1000), image(7, 'my-own-image:keep', 1000)],
      Containers: [container(10, 'orphan'), container(11, 'running', 'running'), container(12, 'lazy-builder-abc'), container(13, 'lazymember-abc'),
        container(14, 'member-by-label', 'exited', { 'lazy.member-terminal': '1' }), container(15, 'kept', 'exited', { 'lazy.kept': '1' })],
      BuildCache: [
        { ID: 'oldcache', Size: 10 * GiB, InUse: false, Shared: false, CreatedAt: new Date(1000_000).toISOString() },
        { ID: 'warmcache', Size: 10 * GiB, InUse: false, Shared: false, CreatedAt: new Date(1000_000).toISOString(), LastUsedAt: new Date(5000_000).toISOString() },
        { ID: 'activecache', Size: GiB, InUse: true, CreatedAt: new Date(1000_000).toISOString() },
        { ID: 'sharedcache', Size: GiB, InUse: false, Shared: true, CreatedAt: new Date(1000_000).toISOString() },
      ],
    };
    commands = []; free = GiB; builds = 0;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => builds,
      command: async args => { commands.push(args); free += GiB; },
    });
    setDiskSpaceManager(manager);
  });
  afterEach(async () => { setDiskSpaceManager(null); await storage.close(); await rm(root, { recursive: true, force: true }); });

  // INVARIANT: rebuild clicks honor the daemon's measured disk hold. A cold retry must not repeat a known capacity failure.
  test('both rebuild clicks return the measured capacity hold without launching a build', async () => {
    data.BuildCache = [];
    await expect(manager.build('lazy-custom-abc123:current', async () => {
      free = 0;
      throw diskFull();
    }, 'same-dockerfile')).rejects.toThrow('no space left on device');
    const message = await manager.buildRetryHold();
    expect(message).toContain('needs about 42 GiB');
    expect(message).toContain('machine has 32 GiB');
    expect(message).toContain('Ask the site admin to raise the disk');
    for (const noCache of [false, true]) {
      await expect(handleRebuildRunnerImage(root, { noCache })).rejects.toMatchObject({
        status: 409, code: 'image_build_disk_hold', message,
      });
    }
  });

  test('preview lists only old images, old cache and orphan exited containers', async () => {
    const view = await manager.view();
    expect(view.plan.items.map(i => i.id).sort()).toEqual([id(3), id(6), id(10), 'oldcache'].sort());
    expect(view.usage.totalBytes).toBe(32 * GiB);
    expect(view.usage.buildCacheBytes).toBe(22 * GiB);
    expect(view.plan.reclaimableBytes).toBe(13 * GiB);
    expect(commands).toEqual([]);
  });

  test('current task container and task image pins are protected', async () => {
    const task = await storage.createTask('current task', undefined, undefined, 'task-code');
    await storage.updateTaskMetadata(task.id, 'custom_image', 'lazy-custom-fed123:old');
    data.Containers.push(container(16, 'lazy-task-code'));
    const view = await manager.view();
    expect(view.plan.items.some(i => i.id === id(16) || i.id === id(6))).toBe(false);
  });

  test('same-tag rebuild retains previous image after it becomes dangling', async () => {
    await manager.built('lazy-runner:current', 1000);
    data.Images[0].RepoTags = [];
    data.Images.push(image(8, 'lazy-runner:current', 6000));
    await manager.built('lazy-runner:current', 2000);
    expect((await manager.view()).plan.items.some(i => i.id === id(1))).toBe(false);
    expect((await storage.getDiskSpaceState())!.images.map(i => i.id)).toContain(id(1));
  });

  test('an older cached image becoming current is retained ahead of newer-created images', async () => {
    await manager.built('lazy-custom-fed123:old', Date.now());
    expect((await manager.view()).plan.items.some(i => i.id === id(6))).toBe(false);
  });

  test('a failed new build preserves the recorded current image and its warm cache', async () => {
    await manager.built('lazy-custom-def123:previous', 1000);
    await manager.built('lazy-custom-fed123:old', 2000);
    await manager.built('lazy-custom-aaaaaa:missing', 3000);
    const plan = (await manager.view()).plan;
    expect(plan.items.some(i => [id(5), id(6), 'oldcache'].includes(i.id))).toBe(false);
  });

  // INVARIANT: published pulls establish current/previous just like builds;
  // cleanup cannot remove the new image between pull and canonical tagging.
  test('a successful pull retains the new image and its predecessor across restart', async () => {
    await manager.built('lazy-runner:old', 1000);
    await manager.built('lazy-runner:previous', 2000);
    await manager.pull('lazy-runner:new', async () => {
      data.Images.push(image(8, 'ghcr.io/getlazy/lazy-runner:sha-new', 6000));
      expect((await manager.view()).plan.items).toEqual([]);
      await manager.reclaim('periodic maintenance');
      expect(commands).toEqual([]);
      data.Images.at(-1)!.RepoTags!.push('lazy-runner:new');
      return { pulled: true };
    });
    const restarted = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => 0,
      command: async args => { commands.push(args); },
    });
    const plan = (await restarted.view()).plan;
    expect(plan.items.some(i => [id(8), id(2)].includes(i.id))).toBe(false);
    expect(plan.items.some(i => i.id === id(3))).toBe(true);
    expect((await storage.getDiskSpaceState())!.images.filter(i => i.family === 'runner').map(i => i.id)).toEqual([id(8), id(2)]);
  });

  test('concurrent image observations retain their order durably', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstInventory = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => {
        const snapshot = structuredClone(data);
        if (first) { first = false; entered(); await gate; }
        return snapshot;
      },
      filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => 0,
      command: async args => { commands.push(args); },
    });
    const a = manager.built('lazy-runner:current', 1000);
    await firstInventory;
    const b = manager.built('lazy-runner:previous', 2000);
    release();
    await Promise.all([a, b]);
    expect((await storage.getDiskSpaceState())!.images.map(i => i.id)).toEqual([id(2), id(1)]);
  });

  // INVARIANT: a measured disk-full build cannot be started again against the
  // same capacity, even after a daemon restart or an explicit retry click.
  test('measured ENOSPC holds a cold rebuild until the disk has enough space', async () => {
    data.BuildCache = [];
    let total = 32 * GiB, attempts = 0;
    const deps = { inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: total, freeBytes: free }),
      buildsRunning: () => 0, command: async () => {} };
    manager = new DiskSpaceManager(storage, '/project', deps);
    const failing = () => manager.build('lazy-custom-abc123:current', async () => { attempts++; free = 0; throw diskFull(); }, 'same-dockerfile');
    await expect(failing()).rejects.toThrow('no space left on device');
    const pressure = (await manager.recoveryStatus()).buildPressure!;
    expect(pressure.requiredBytes).toBe(42 * GiB);
    expect(pressure.message).toContain('needs about 42 GiB');
    expect(pressure.message).toContain('machine has 32 GiB');
    manager = new DiskSpaceManager(storage, '/project', deps);
    await expect(failing()).rejects.toThrow('Another cold rebuild is held');
    expect(attempts).toBe(1);
    total = 48 * GiB; free = 16 * GiB;
    await manager.acknowledgeGrowth(1);
    expect(await manager.buildRetryHold()).toBeNull();
    await manager.build('lazy-custom-abc123:current', async () => { attempts++; }, 'same-dockerfile');
    expect(attempts).toBe(2);
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
  });

  // INVARIANT: a RUN compiler can exhaust its writable layer without an engine
  // error line. Measured exhaustion must still prevent another cold attempt.
  test('Rust ENOSPC inside RUN records capacity pressure', async () => {
    data.BuildCache = [];
    await expect(manager.build('lazy-custom-abc123:current', async () => {
      free = 0;
      throw new Error('#8 20.1 rustc: error: failed to write /opt/cargo-target/file.rlib: No space left on device (os error 28)\nERROR: process "cargo build" did not complete successfully: exit code: 101');
    }, 'rust-dockerfile')).rejects.toThrow('rustc');
    expect((await manager.recoveryStatus()).buildPressure!.reason).toBe('enospc');
    expect(await manager.buildRetryHold()).toContain('needs about 42 GiB');
  });

  // INVARIANT: failed-layer cleanup can restore space between samples. A real
  // ENOSPC still holds the same build until it has more than its starting room.
  for (const [name, error] of [
    ['engine', diskFull()],
    ['Rust', new Error('#8 20.1 error: failed to build archive /opt/cargo-target/file.rlib: No space left on device (os error 28)\nERROR: process "cargo build" did not complete successfully: exit code: 101')],
  ] as const) test(`${name} ENOSPC holds retries when failed-layer space returns before sampling`, async () => {
    data = { Images: [], Containers: [], BuildCache: [], LayersSize: 0 };
    let total = 32 * GiB, available = 20 * GiB, attempts = 0;
    const deps = { inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: total, freeBytes: available }),
      buildsRunning: () => 0, command: async () => {} };
    manager = new DiskSpaceManager(storage, '/project', deps);
    setDiskSpaceManager(manager);
    const attempt = () => withDiskSpaceRecovery('docker', () => manager.build('lazy-custom-abc123:current', async () => {
      attempts++; throw error;
    }, 'same-dockerfile'));
    await expect(attempt()).rejects.toThrow();
    expect(attempts).toBe(1);
    const pressure = (await manager.recoveryStatus()).buildPressure!;
    expect(pressure.reason).toBe('enospc');
    expect(pressure.requiredBytes).toBe(42 * GiB);
    manager = new DiskSpaceManager(storage, '/project', deps);
    setDiskSpaceManager(manager);
    await expect(attempt()).rejects.toThrow('Another cold rebuild is held');
    expect(attempts).toBe(1);
    total = 64 * GiB; available = 32 * GiB;
    expect(await manager.buildRetryHold()).toBeNull();
  });

  // INVARIANT: echoed argv is not a filesystem diagnostic, even on a full disk.
  test('a failed RUN quoting an ENOSPC message does not record exhaustion', async () => {
    data.BuildCache = [];
    await expect(manager.build('lazy-custom-abc123:current', async () => {
      free = 0;
      throw new Error('ERROR: failed to build: failed to solve: process "/bin/sh -c echo error: No space left on device" did not complete successfully: exit code: 1');
    }, 'quoted-command')).rejects.toThrow('exit code: 1');
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
  });

  // INVARIANT: returning to the failed build's starting free space is not an
  // improvement. A larger disk filled by other work cannot justify a retry.
  test('recovered starting space and a busy larger disk both keep the build held', async () => {
    data.BuildCache = [];
    let total = 32 * GiB;
    free = 20 * GiB;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: total, freeBytes: free }),
      buildsRunning: () => 0, command: async () => {},
    });
    await expect(manager.build('lazy-custom-abc123:current', async () => {
      free = 0; throw diskFull();
    }, 'same-dockerfile')).rejects.toThrow('no space left on device');
    free = 20 * GiB;
    expect(await manager.buildRetryHold()).toContain('Another cold rebuild is held');
    total = 64 * GiB; free = GiB;
    expect(await manager.buildRetryHold()).toContain('Another cold rebuild is held');
    free = 32 * GiB;
    expect(await manager.buildRetryHold()).toBeNull();
  });

  // INVARIANT: collecting unrelated old cache is normal GC, not evidence that
  // this image cannot fit. Neither a healthy build nor a compiler bug owes growth.
  for (const succeeds of [true, false]) test(`unrelated cache GC does not hold a ${succeeds ? 'successful' : 'compiler-failed'} build`, async () => {
    data.BuildCache = [{ ID: 'unrelated-old', Size: 15 * GiB, InUse: false, CreatedAt: new Date(1000).toISOString() }];
    free = 8 * GiB;
    const attempt = manager.build('lazy-custom-abc123:current', async () => {
      free = 3 * GiB; data.BuildCache = [];
      if (!succeeds) throw new Error('syntax error in project source');
      return 'built';
    }, 'same-dockerfile');
    if (succeeds) expect(await attempt).toBe('built');
    else await expect(attempt).rejects.toThrow('syntax error');
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
    expect(await manager.buildRetryHold()).toBeNull();
  });

  // INVARIANT: cache provenance survives restart and stays with its own image;
  // otherwise collecting one image's cache could refuse another image's build.
  test('cache ownership survives restart and does not transfer to another image', async () => {
    free = 8 * GiB;
    data.BuildCache = [{ ID: 'owned', Size: 15 * GiB, InUse: false, CreatedAt: new Date(1000).toISOString() }];
    const deps = { inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }),
      buildsRunning: () => 0, command: async () => {} };
    manager = new DiskSpaceManager(storage, '/project', deps);
    await manager.build('lazy-custom-abc123:current', async () => { data.BuildCache[0].LastUsedAt = new Date().toISOString(); }, 'first-dockerfile');
    expect((await storage.getDiskSpaceState())!.buildCache!.records).toEqual([{ id: 'owned', bytes: 15 * GiB }]);
    manager = new DiskSpaceManager(storage, '/project', deps);
    await expect(manager.build('lazy-custom-def123:other', async () => {
      data.BuildCache = []; free = 3 * GiB; throw new Error('compiler bug');
    }, 'other-dockerfile')).rejects.toThrow('compiler bug');
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
    await expect(manager.build('lazy-custom-abc123:current', async () => { throw new Error('compiler bug'); }, 'first-dockerfile')).rejects.toThrow('compiler bug');
    expect((await manager.recoveryStatus()).buildPressure!.cacheEvictedBytes).toBe(15 * GiB);
  });

  // INVARIANT: concurrent use makes timestamp provenance ambiguous; never claim
  // another build's cache as this image's capacity requirement.
  test('overlapping builds do not assign each others cache to an image', async () => {
    data.BuildCache = [];
    let entered!: () => void, release!: () => void;
    const firstStarted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = manager.build('lazy-custom-abc123:current', async () => { entered(); await gate; }, 'first');
    await firstStarted;
    try {
      await manager.build('lazy-custom-def123:other', async () => {
        data.BuildCache = [{ ID: 'second-build', Size: GiB, InUse: false, CreatedAt: new Date().toISOString() }];
      }, 'second');
    } finally { release(); await first; }
    expect((await storage.getDiskSpaceState())?.buildCache).toBeUndefined();
  });

  // INVARIANT: Docker can round timestamps to seconds. A record touched before
  // this build in the same second is not evidence this image used it.
  test('an unchanged same-second cache timestamp does not establish ownership', async () => {
    setSystemTime(new Date('2026-10-23T20:00:00.500Z'));
    try {
      data.BuildCache = [{ ID: 'previous-build', Size: 15 * GiB, InUse: false,
        CreatedAt: new Date(1000).toISOString(), LastUsedAt: '2026-10-23T20:00:00Z' }];
      await manager.build('lazy-custom-abc123:current', async () => {}, 'same');
      expect((await storage.getDiskSpaceState())!.buildCache!.records).toEqual([]);
    } finally { setSystemTime(); }
  });

  // INVARIANT: a live resize does not magically change the embedded BuildKit
  // policy. Keep a repeat build held when the active cap still evicts its cache.
  test('cache loss under free-space pressure survives a resize until the running cache limit improves', async () => {
    data.BuildCache = [{ ID: 'reused', Size: 15 * GiB, InUse: false, CreatedAt: new Date(1000).toISOString() }];
    let total = 32 * GiB, cap = 12 * GiB;
    free = 8 * GiB;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: total, freeBytes: free }),
      buildsRunning: () => 0, command: async () => {}, cachePolicy: async () => ({ maxBytes: cap, minFreeBytes: 6 * GiB }),
    });
    // Establish that this record was used by this image, rather than assuming
    // every old entry the engine collects belongs to the build that saw it.
    await manager.build('lazy-custom-abc123:current', async () => {
      data.BuildCache[0].LastUsedAt = new Date().toISOString();
    }, 'same-dockerfile');
    await expect(manager.build('lazy-custom-abc123:current', async () => {
      free = 3 * GiB; data.BuildCache = []; throw new Error('compiler failed');
    }, 'same-dockerfile')).rejects.toThrow('compiler failed');
    expect((await manager.recoveryStatus()).buildPressure!.reason).toBe('cache-evicted');
    expect((await manager.recoveryStatus()).buildPressure!.cacheEvictedBytes).toBe(15 * GiB);
    total = 64 * GiB; free = 35 * GiB;
    await manager.acknowledgeGrowth(1);
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
    expect(await manager.buildRetryHold()).toContain('Docker cannot reload BuildKit cache limits live');
    let attempts = 0;
    await expect(manager.build('lazy-custom-abc123:current', async () => { attempts++; }, 'same-dockerfile')).rejects.toThrow('Another cold rebuild is held');
    expect(attempts).toBe(0);
    cap = 25 * GiB;
    await manager.build('lazy-custom-abc123:current', async () => { attempts++; }, 'same-dockerfile');
    expect(attempts).toBe(1);
  });

  // INVARIANT: build preparation counts as a build before its first async
  // inventory, or cleanup could discard cache immediately before its use.
  test('a build reserves cache throughout asynchronous image retention', async () => {
    let release!: () => void, entered!: () => void;
    const inventoryReady = new Promise<void>(resolve => { release = resolve; });
    const inventoryStarted = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => { if (first) { first = false; entered(); await inventoryReady; } return structuredClone(data); },
      filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => 0,
      command: async args => { commands.push(args); },
    });
    const build = manager.build('lazy-runner:current', async () => {
      expect((await manager.view()).plan.items).toEqual([]);
    });
    await inventoryStarted;
    await manager.reclaim('periodic maintenance');
    expect(commands).toEqual([]);
    release();
    await build;
    expect((await manager.view()).plan.items.length).toBeGreaterThan(0);
  });

  test('reclaim uses immutable IDs and filtered cache prune, never volumes or forced container removal', async () => {
    const preview = await manager.view();
    const result = await manager.reclaim('manual', preview.plan.id);
    expect(result.freedBytes).toBe(4 * GiB);
    expect(commands).toContainEqual(['container', 'rm', id(10)]);
    expect(commands).toContainEqual(['image', 'rm', '--no-prune', `lazy-runner@sha256:${id(3)}`]);
    expect(commands.find(a => a[0] === 'buildx')).toEqual(['buildx', '--builder', 'default', 'prune', '--force', '--all', '--filter', 'id=^oldcache$', '--filter', 'until=5m']);
    expect(commands.flat()).not.toContain('volume');
    expect(commands.flat()).not.toContain('system');
    expect((await storage.getDiskSpaceState())!.lastRecovery?.freedBytes).toBe(4 * GiB);
  });

  test('stale preview refuses and a container started after preview is never removed', async () => {
    const preview = await manager.view();
    data.Containers[0].State = 'running';
    await expect(manager.reclaim('manual', preview.plan.id)).rejects.toThrow('changed');
    expect(commands).toEqual([]);
  });

  test('obsolete multiply tagged runners are reclaimed by immutable repository digests', async () => {
    data.Images.find(i => i.Id === id(3))!.RepoTags = ['lazy-runner:old', 'ghcr.io/getlazy/lazy-runner:sha-old'];
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => 0,
      command: async args => {
        commands.push(args);
        if (args[0] !== 'image') return;
        const reference = args.at(-1)!;
        // Model Docker's real multi-reference refusal, rather than treating
        // every image rm as successful regardless of its aliases.
        const byId = data.Images.find(i => i.Id === reference);
        if (byId && byId.RepoTags!.length > 1) throw new Error('image is referenced in multiple repositories');
        const match = /^(.*)@sha256:([a-f0-9]{64})$/.exec(reference)!;
        const target = data.Images.find(i => i.Id === match[2])!;
        expect(data.Containers.some(c => c.ImageID === target.Id)).toBe(false);
        target.RepoTags = target.RepoTags!.filter(tag => tag.slice(0, tag.lastIndexOf(':')) !== match[1]);
        if (!target.RepoTags.length) { data.Images = data.Images.filter(i => i.Id !== target.Id); free += GiB; }
      },
    });
    await manager.reclaim('manual', (await manager.view()).plan.id);
    expect(data.Images.map(i => i.Id)).not.toContain(id(3));
    expect(data.Images.map(i => i.Id)).toEqual(expect.arrayContaining([id(1), id(2), id(4), id(5)]));
    expect(commands).toContainEqual(['image', 'rm', '--no-prune', `ghcr.io/getlazy/lazy-runner@sha256:${id(3)}`]);
    expect(commands).toContainEqual(['image', 'rm', '--no-prune', `lazy-runner@sha256:${id(3)}`]);
    expect((await storage.getDiskSpaceState())!.lastRecovery?.error).toBeUndefined();
  });

  test('a moving alias cannot redirect a digest-qualified image removal', async () => {
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }), buildsRunning: () => 0,
      command: async args => {
        commands.push(args);
        if (args[0] !== 'image') return;
        // Another actor retags the old name onto the current image after the
        // inventory. The immutable target must still be the obsolete ID.
        data.Images.find(i => i.Id === id(1))!.RepoTags!.push('lazy-runner:old');
        const targetId = args.at(-1)!.split('@sha256:')[1];
        expect([id(3), id(6)]).toContain(targetId);
        data.Images = data.Images.filter(i => i.Id !== targetId);
      },
    });
    await manager.reclaim('manual', (await manager.view()).plan.id);
    expect(data.Images.find(i => i.Id === id(1))!.RepoTags).toContain('lazy-runner:old');
  });

  test('foreign aliases are preserved and changed aliases invalidate confirmation', async () => {
    const preview = await manager.view();
    data.Images.find(i => i.Id === id(3))!.RepoTags!.push('my-other-image:keep');
    expect((await manager.view()).plan.items.some(i => i.id === id(3))).toBe(false);
    await expect(manager.reclaim('manual', preview.plan.id)).rejects.toThrow('changed');
    expect(commands).toEqual([]);
    data.Images.find(i => i.Id === id(3))!.RepoTags = ['lazy-runner:old'];
    const next = await manager.view();
    data.Images.find(i => i.Id === id(3))!.RepoTags!.push('lazy-runner:another-old-tag');
    await expect(manager.reclaim('manual', next.plan.id)).rejects.toThrow('changed');
  });

  test('builds keep all reclaim from starting, including cache used by an in-flight build', async () => {
    builds = 1;
    expect((await manager.view()).plan.items).toEqual([]);
    await manager.reclaim('periodic');
    expect(commands).toEqual([]);
  });

  test('disk-full gets one reclaim and one retry; growth request persists across managers', async () => {
    let calls = 0;
    expect(await withDiskSpaceRecovery('docker', async () => { if (++calls === 1) throw diskFull(); return 'ok'; })).toBe('ok');
    expect(calls).toBe(2);
    calls = 0;
    await expect(withDiskSpaceRecovery('docker', async () => { calls++; throw diskFull(); })).rejects.toThrow('admin has been told');
    expect(calls).toBe(2);
    expect((await storage.getDiskSpaceState())!.needsGrowth).toBe(true);
    await manager.acknowledgeGrowth((await manager.recoveryStatus()).growthGeneration);
    expect((await storage.getDiskSpaceState())!.needsGrowth).toBe(false);
  });

  test('other engine failures and other runtimes do not reclaim or retry', async () => {
    await expect(withDiskSpaceRecovery('docker', async () => { throw new Error('unauthorized'); })).rejects.toThrow('unauthorized');
    await expect(withDiskSpaceRecovery('podman', async () => { throw diskFull(); })).rejects.toThrow('no space');
    expect(commands).toEqual([]);
  });

  // INVARIANT: finishing an older resize never clears a newer ENOSPC request.
  // Concurrent writes can fill the grown disk before the fleet acknowledges it.
  test('growth acknowledges only the observed durable exhaustion generation', async () => {
    await manager.exhausted(diskFull());
    const first = await manager.recoveryStatus();
    await manager.exhausted(diskFull());
    expect(await manager.acknowledgeGrowth(first.growthGeneration)).toBe(false);
    const newer = await manager.recoveryStatus();
    expect(newer.needsGrowth).toBe(true);
    expect(newer.growthGeneration).toBe(first.growthGeneration + 1);
    const restarted = new DiskSpaceManager(storage, '/project');
    expect(await restarted.acknowledgeGrowth(newer.growthGeneration)).toBe(true);
    expect((await restarted.recoveryStatus()).needsGrowth).toBe(false);
  });

  // INVARIANT: pressure and its generation are one recovery event. An older
  // resize cannot clear a newer observation while its persistence is in flight.
  test('a delayed growth acknowledgement cannot clear newly saved pressure', async () => {
    data.BuildCache = [];
    let total = 32 * GiB, pauseProbe = false;
    let enterProbe!: () => void, releaseProbe!: () => void;
    const entered = new Promise<void>(resolve => { enterProbe = resolve; });
    const gate = new Promise<void>(resolve => { releaseProbe = resolve; });
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => {
        const snapshot = { totalBytes: total, freeBytes: free };
        if (pauseProbe) { pauseProbe = false; enterProbe(); await gate; }
        return snapshot;
      }, buildsRunning: () => 0, command: async () => {},
    });
    const fail = () => manager.build('lazy-custom-abc123:current', async () => { free = 0; throw diskFull(); }, 'same');
    await expect(fail()).rejects.toThrow('no space left on device');
    const first = await manager.recoveryStatus();
    total = 64 * GiB; free = 32 * GiB; pauseProbe = true;
    const acknowledgement = manager.acknowledgeGrowth(first.growthGeneration);
    await entered;
    // Delay the real persistence boundary after the new observation is on
    // disk, giving the old acknowledgement time to queue its own state write.
    const save = storage.saveDiskSpaceState.bind(storage);
    const observedGenerations: number[] = [];
    storage.saveDiskSpaceState = async state => {
      await save(state);
      if (state.buildPressure?.diskBytes === 64 * GiB) {
        observedGenerations.push(state.growthGeneration ?? 0);
        releaseProbe();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    };
    try {
      await expect(fail()).rejects.toThrow('no space left on device');
    } finally { releaseProbe(); storage.saveDiskSpaceState = save; }
    expect(await acknowledgement).toBe(false);
    expect(observedGenerations.every(generation => generation === first.growthGeneration + 1)).toBe(true);
    const latest = await manager.recoveryStatus();
    expect(latest.growthGeneration).toBe(first.growthGeneration + 1);
    expect(latest.buildPressure!.blocked).toBe(true);
    expect(await manager.buildRetryHold()).toContain('Another cold rebuild is held');
  });

  // INVARIANT: successful recovery pays its own request; it must not leave a
  // stale growth flag that enlarges a now-healthy disk.
  test('a successful retry clears its own growth request after reclaim improves space', async () => {
    data.BuildCache = [];
    await expect(manager.build('lazy-custom-abc123:current', async () => { free = 0; throw diskFull(); }, 'same')).rejects.toThrow('no space left on device');
    free = 16 * GiB;
    await manager.build('lazy-custom-abc123:current', async () => {}, 'same');
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
  });

  // INVARIANT: one failure owns one generation even through nested recovery;
  // duplicating it leaves a growth request that no successful retry can clear.
  test('the retry wrapper does not create a second generation for the same measured failure', async () => {
    let attempts = 0;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: 32 * GiB, freeBytes: free }),
      buildsRunning: () => 0, command: async () => { free = 16 * GiB; },
    });
    setDiskSpaceManager(manager);
    await expect(withDiskSpaceRecovery('docker', () => manager.build('lazy-custom-abc123:current', async () => {
      attempts++; free = 0; throw diskFull();
    }, 'same'))).rejects.toThrow('admin has been told');
    expect(attempts).toBe(2);
    const failed = await manager.recoveryStatus();
    expect(failed.buildPressure!.growthGeneration).toBe(failed.growthGeneration);
    expect(failed.growthGeneration).toBe(2);
    free = 24 * GiB;
    await manager.build('lazy-custom-abc123:current', async () => {}, 'same');
    expect((await manager.recoveryStatus()).needsGrowth).toBe(false);
  });

  // INVARIANT: an image succeeding proves nothing about another launch's
  // exhaustion. That newer growth request must remain durable.
  test('a successful build does not acknowledge another launch failure', async () => {
    data.BuildCache = [];
    await expect(manager.build('lazy-custom-abc123:current', async () => { free = 0; throw diskFull(); }, 'same')).rejects.toThrow('no space left on device');
    free = 16 * GiB;
    await manager.build('lazy-custom-abc123:current', async () => { await manager.exhausted(diskFull()); }, 'same');
    expect((await manager.recoveryStatus()).buildPressure).toBeNull();
    expect((await manager.recoveryStatus()).needsGrowth).toBe(true);
    expect((await manager.recoveryStatus()).growthGeneration).toBe(2);
  });

  // INVARIANT: completion belongs to its own observation, not just an image
  // name; a concurrent failure of that image must keep its hold.
  test('an older successful build cannot clear a newer failure of the same image', async () => {
    data.BuildCache = [];
    let total = 32 * GiB;
    manager = new DiskSpaceManager(storage, '/project', {
      inventory: async () => structuredClone(data), filesystem: async () => ({ totalBytes: total, freeBytes: free }),
      buildsRunning: () => 0, command: async () => {},
    });
    const fail = () => manager.build('lazy-custom-abc123:current', async () => { free = 0; throw diskFull(); }, 'same');
    await expect(fail()).rejects.toThrow('no space left on device');
    total = 64 * GiB; free = 32 * GiB;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completing = manager.build('lazy-custom-abc123:current', async () => { entered(); await gate; }, 'same');
    await started;
    try { await expect(fail()).rejects.toThrow('no space left on device'); }
    finally { release(); await completing; }
    expect((await manager.recoveryStatus()).buildPressure!.blocked).toBe(true);
    expect((await manager.recoveryStatus()).needsGrowth).toBe(true);
    expect(await manager.buildRetryHold()).toContain('Another cold rebuild is held');
  });

  test('legacy growth requests have generation zero until the next exhaustion', async () => {
    await storage.saveDiskSpaceState({ needsGrowth: true, images: [], lastRecovery: null });
    expect((await manager.recoveryStatus()).growthGeneration).toBe(0);
    expect(await manager.acknowledgeGrowth(0)).toBe(true);
    await manager.exhausted(diskFull());
    expect(await manager.acknowledgeGrowth(0)).toBe(false);
    expect((await manager.recoveryStatus()).needsGrowth).toBe(true);
  });
});

test('ENOSPC classifier matches engine errors, not a quoted Dockerfile step', () => {
  expect(isEngineDiskFull(diskFull())).toBe(true);
  expect(isEngineDiskFull('docker: Error response from daemon: mkdir /storage/docker/overlay: no space left on device')).toBe(true);
  expect(isEngineDiskFull('failed to register layer: write /layer: no space left on device')).toBe(true);
  expect(isEngineDiskFull('#7 3.1 cargo: no space left on device')).toBe(false);
  expect(isEngineDiskFull('#4 0.4 Error response from daemon: no space left on device')).toBe(false);
  expect(isEngineDiskFull('RUN echo "no space left on device"')).toBe(false);
  expect(isEngineDiskFull('ERROR: failed to build: process exited with code 1')).toBe(false);
  expect(isEngineDiskFull('ERROR: failed to build: failed to solve: process "/bin/sh -c echo no space left on device" did not complete successfully: exit code: 1')).toBe(false);
});
