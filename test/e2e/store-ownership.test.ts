import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor, tasksDirFor } from '../helpers/storage';
import { STORE_OWNER_FILENAME } from '../../src/storage/store-owner';
import { FileStorage } from '../../src/storage/file-storage';
import { getDaemonDir, getPidPath } from '../../src/daemon/paths';
import { killDaemonsForRoot, registerTestDaemonRoot, unregisterTestDaemonRoot } from '../helpers/daemon-registry';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

isolateLazyEnv();

async function snapshotTasks(root: string): Promise<Record<string, { bytes: string; modified: number }>> {
  const files: Record<string, { bytes: string; modified: number }> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[path] = { bytes: await readFile(path, 'base64'), modified: (await stat(path)).mtimeMs };
    }
  };
  await walk(tasksDirFor(root));
  return files;
}

describe('store checkout ownership', () => {
  let ctx: TestContext;
  let scratch: string;
  let clone: string;
  let daemonBase: string;
  let unpinDaemonBase: () => void;

  beforeEach(async () => {
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'lazy-ownership-')));
    ctx = await setupTestLazy({ withDaemon: true, externalPath: join(scratch, 'store') });
    clone = join(scratch, 'second-checkout');
    // Register even a start expected to fail: a regression must not leak the
    // very second daemon this suite is meant to prevent.
    registerTestDaemonRoot(clone);
    expect(ctx.git('clone', ctx.root, clone).exitCode).toBe(0);
    await mkdir(join(clone, '.lazy'), { recursive: true });
  });

  afterEach(async () => {
    killDaemonsForRoot(clone);
    unregisterTestDaemonRoot(clone);
    await rm(getDaemonDir(clone), { recursive: true, force: true });
    await ctx.cleanup();
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
    await rm(scratch, { recursive: true, force: true });
  });

  // INVARIANT: a clone cannot open another checkout's store, even while its
  // lock is free. A reconciler on the wrong checkout corrupts real task state.
  test('refuses before locking and leaves the first checkout’s tasks untouched', async () => {
    const created = await ctx.lazy(['create', '--goal', 'Belongs to the first checkout', '--code', 'original-task']);
    expect(created.exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const before = await snapshotTasks(ctx.root);
    const store = storageDirFor(ctx.root);
    const owner = await readFile(join(store, STORE_OWNER_FILENAME), 'utf8');
    const result = await ctx.lazy(['daemon', 'start', '--foreground', '--project', clone], { cwd: clone });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(ctx.root);
    expect(result.stdout + result.stderr).toContain(clone);
    expect(result.stdout + result.stderr).toContain('external_path');
    expect(result.stdout + result.stderr).toContain('store of its own');
    expect(await snapshotTasks(ctx.root)).toEqual(before);
    expect(await readFile(join(store, STORE_OWNER_FILENAME), 'utf8')).toBe(owner);
    expect(await Bun.file(join(store, '.storage-lock')).exists()).toBe(false);
    expect(await Bun.file(getPidPath(clone)).exists()).toBe(false);
  });

  // INVARIANT: the ownership refusal precedes even a held lock, so the second
  // project fails immediately rather than waiting behind a healthy daemon.
  test('refuses while the first daemon holds its lifelong lock', async () => {
    const path = join(storageDirFor(ctx.root), '.storage-lock');
    const lock = await readFile(path, 'utf8');
    const result = await ctx.lazy(['daemon', 'start', '--foreground', '--project', clone], { cwd: clone });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('belongs to project checkout');
    expect(await readFile(path, 'utf8')).toBe(lock);
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
  });

  test('doctor diagnoses a foreign store without changing it', async () => {
    const ownerPath = join(storageDirFor(ctx.root), STORE_OWNER_FILENAME);
    const before = await readFile(ownerPath, 'utf8');
    const result = await ctx.lazy(['doctor'], { cwd: clone, env: { LAZY_TEST: '1' } });
    expect(result.stdout + result.stderr).toContain('The store cannot be opened by this checkout');
    expect(result.stdout + result.stderr).toContain(ctx.root);
    expect(result.stdout + result.stderr).toContain(clone);
    expect(await readFile(ownerPath, 'utf8')).toBe(before);
  });

  test('an auto-started daemon surfaces the ownership refusal to the command', async () => {
    const result = await ctx.lazy(['list'], { cwd: clone });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('belongs to project checkout');
    expect(result.stdout + result.stderr).toContain(ctx.root);
    expect(result.stdout + result.stderr).toContain(clone);
    expect(result.stdout + result.stderr).not.toContain('did not start within');
  });

  // INVARIANT: a default-name collision must refuse rather than share tasks.
  // HOME is private here because the default store layout is the subject.
  test('default stores with the same project name explain how to choose a separate store', async () => {
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const home = join(scratch, 'home');
    await mkdir(home);
    for (const checkout of [ctx.root, clone]) {
      const path = join(checkout, 'lazy.toml');
      const config = await readFile(path, 'utf8');
      const ownDefault = config.replace(/^external_path\s*=\s*".*"/m, 'external_path = ""');
      expect(ownDefault).not.toBe(config);
      await Bun.write(path, ownDefault);
    }
    // Both checkouts derive the same name: the original uses its directory,
    // and the clone uses its origin URL pointing to that directory.
    const env = { HOME: home, LAZY_TEST: '1' };
    expect((await ctx.lazy(['list'], { env })).exitCode).toBe(0);
    const result = await ctx.lazy(['list'], { cwd: clone, env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('same default store name');
    expect(result.stdout + result.stderr).toContain('store of its own by changing [storage] external_path');
    expect(result.stdout + result.stderr).toContain(ctx.root);
    expect(result.stdout + result.stderr).toContain(clone);
  });

  test('a missing checkout is refused cleanly during daemon startup', async () => {
    const missing = join(scratch, 'missing-checkout');
    const result = await ctx.lazy(['daemon', 'start', '--foreground', '--project', missing]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`Project checkout "${missing}" was not found`);
    expect(result.stdout + result.stderr).not.toContain('ENOENT');
    expect(result.stdout + result.stderr).not.toContain('runGit:');
    expect(await Bun.file(getPidPath(missing)).exists()).toBe(false);
  });

  test('a real directory move keeps the store and updates its owning path', async () => {
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const moved = join(scratch, 'moved-checkout');
    const store = storageDirFor(ctx.root);
    await rename(ctx.root, moved);
    try {
      // LAZY_TEST routes this through the same storage factory without starting
      // another daemon whose cleanup root would differ from the context's.
      const result = await ctx.lazy(['list'], { cwd: moved, env: { LAZY_TEST: '1' } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await readFile(join(store, STORE_OWNER_FILENAME), 'utf8')).projectRoot).toBe(moved);
    } finally {
      await rename(moved, ctx.root);
      // Restore the recorded path through the same genuine-move path.
      expect((await ctx.lazy(['list'], { env: { LAZY_TEST: '1' } })).exitCode).toBe(0);
    }
  });

  // INVARIANT: a shallow fetch changes available history, not the checkout's
  // identity. Both normal startup and storage initialization must still work.
  test('a shallow checkout keeps its store after deepening and unshallowing', async () => {
    // Use the already registered second-checkout path so even a failed start
    // or assertion is covered by this suite's daemon cleanup.
    await rm(clone, { recursive: true, force: true });
    expect(ctx.git('commit', '--allow-empty', '-m', 'Additional history one').exitCode).toBe(0);
    expect(ctx.git('commit', '--allow-empty', '-m', 'Additional history two').exitCode).toBe(0);
    expect(ctx.git('clone', '--depth=1', pathToFileURL(ctx.root).href, clone).exitCode).toBe(0);
    await mkdir(join(clone, '.lazy'), { recursive: true });
    const ownStore = join(scratch, 'shallow-store');
    await mkdir(ownStore);
    const configPath = join(clone, 'lazy.toml');
    const config = await readFile(configPath, 'utf8');
    const replacement = config.replace(/^external_path\s*=\s*".*"/m, `external_path = "${ownStore}"`);
    expect(replacement).not.toBe(config);
    await Bun.write(configPath, replacement);
    const started = await ctx.lazy(['list'], { cwd: clone });
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'], { cwd: clone })).exitCode).toBe(0);
    const ownerPath = join(ownStore, STORE_OWNER_FILENAME);
    const initial = JSON.parse(await readFile(ownerPath, 'utf8'));

    const fetch = (flag: string) => Bun.spawnSync(['git', '-C', clone, 'fetch', flag, 'origin'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(fetch('--deepen=1').exitCode).toBe(0);
    expect((await ctx.lazy(['list'], { cwd: clone })).exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'], { cwd: clone })).exitCode).toBe(0);
    const deepened = JSON.parse(await readFile(ownerPath, 'utf8'));
    expect(deepened.projectRoot).toBe(clone);
    expect(deepened.repositoryRoots).not.toEqual(initial.repositoryRoots);

    expect(fetch('--unshallow').exitCode).toBe(0);
    expect((await ctx.lazy(['list'], { cwd: clone })).exitCode).toBe(0);
    const full = JSON.parse(await readFile(ownerPath, 'utf8'));
    expect(full.projectRoot).toBe(clone);
    expect(full.repositoryRoots).not.toEqual(deepened.repositoryRoots);
  });

  test('an explicit re-home requires a stopped writer and the correct previous owner', async () => {
    const ownerPath = join(storageDirFor(ctx.root), STORE_OWNER_FILENAME);
    const owner = await readFile(ownerPath, 'utf8');
    const held = await ctx.lazy(['system', 'store-rehome', '--from', ctx.root, '--yes'], { cwd: clone });
    expect(held.exitCode).not.toBe(0);
    expect(await readFile(ownerPath, 'utf8')).toBe(owner);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const wrong = await ctx.lazy(['system', 'store-rehome', '--from', 'unowned', '--yes'], { cwd: clone });
    expect(wrong.exitCode).not.toBe(0);
    expect(await readFile(ownerPath, 'utf8')).toBe(owner);
    const result = await ctx.lazy(['system', 'store-rehome', '--from', ctx.root, '--yes'], { cwd: clone });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).projectRoot).toBe(clone);
    expect((await ctx.lazy(['list'], { cwd: clone, env: { LAZY_TEST: '1' } })).exitCode).toBe(0);
  });

  // INVARIANT: upgrading may adopt a legacy store only from its own recorded
  // checkout evidence. A clone starting first must never win a claim race.
  test('adopts an upgrade store proved by a daemon-owned builder session, after refusing the clone first', async () => {
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    // Use the real backend writers to produce the pre-ownership shape. Task
    // sessions themselves deliberately carry no invented checkout field.
    const storage = new FileStorage(ctx.root, { basePath: store });
    await storage.initialize();
    try {
      const task = await storage.createTask('Existing task from before ownership tracking');
      await storage.createSession(task.id, 'claude', 'lazy/legacy-task', ctx.git('rev-parse', 'HEAD').stdout.trim());
      const now = new Date().toISOString();
      await storage.createBuilderSession({
        id: 'legacy-builder-session', projectRoot: ctx.root, memberEmail: null,
        kind: 'interactive', state: 'ended', containerName: null,
        builderId: 'legacy-builder', agentSessionId: null,
        createdAt: now, updatedAt: now, endedAt: now,
      });
    } finally {
      await storage.close();
    }
    const ownerPath = join(store, STORE_OWNER_FILENAME);
    await rm(ownerPath);
    const before = await snapshotTasks(ctx.root);
    const refused = await ctx.lazy(['daemon', 'start', '--foreground', '--project', clone], { cwd: clone });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('store-rehome --from unowned --yes');
    expect(await Bun.file(ownerPath).exists()).toBe(false);
    expect(await Bun.file(join(store, '.storage-lock')).exists()).toBe(false);
    expect(await snapshotTasks(ctx.root)).toEqual(before);

    // A real daemon start, not the LAZY_TEST in-process storage bypass.
    await ctx.restartDaemon();
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).projectRoot).toBe(ctx.root);
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
    expect(await snapshotTasks(ctx.root)).toEqual(before);
  });

  // INVARIANT: /builder/storage accepts caller-chosen resume-intent roots.
  // Such a row cannot prove ownership, even when it names the real checkout.
  for (const namedCheckout of ['clone', 'original'] as const) {
    test(`a forged resume intent naming the ${namedCheckout} cannot authorize automatic adoption`, async () => {
      expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
      const store = storageDirFor(ctx.root);
      const storage = new FileStorage(ctx.root, { basePath: store });
      await storage.initialize();
      try {
        // Seed the legacy shape with exactly the caller-controlled record the
        // builder storage route persists, and no daemon-owned builder session.
        await storage.saveBuilderResumeIntent({
          builderId: 'forged-builder',
          projectRoot: namedCheckout === 'clone' ? clone : ctx.root,
          createdAt: new Date().toISOString(),
        });
      } finally {
        await storage.close();
      }
      const ownerPath = join(store, STORE_OWNER_FILENAME);
      await rm(ownerPath);
      const intentPath = join(store, 'builder-resume-intents.json');
      const intentBefore = await readFile(intentPath, 'utf8');
      for (const checkout of [clone, ctx.root]) {
        const refused = await ctx.lazy(['daemon', 'start', '--foreground', '--project', checkout], { cwd: checkout });
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stdout + refused.stderr).toContain('store-rehome --from unowned --yes');
        expect(await Bun.file(ownerPath).exists()).toBe(false);
        expect(await Bun.file(join(store, '.storage-lock')).exists()).toBe(false);
        expect(await readFile(intentPath, 'utf8')).toBe(intentBefore);
      }
    });
  }

  test('an upgrade store with tasks and sessions but no checkout evidence is refused with the claim command', async () => {
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    const storage = new FileStorage(ctx.root, { basePath: store });
    await storage.initialize();
    try {
      const task = await storage.createTask('Task without checkout evidence');
      await storage.createSession(task.id, 'claude', 'lazy/legacy-task', ctx.git('rev-parse', 'HEAD').stdout.trim());
    } finally {
      await storage.close();
    }
    const ownerPath = join(store, STORE_OWNER_FILENAME);
    await rm(ownerPath);
    const before = await snapshotTasks(ctx.root);
    const refused = await ctx.lazy(['daemon', 'start', '--foreground', '--project', ctx.root]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('store-rehome --from unowned --yes');
    expect(await Bun.file(ownerPath).exists()).toBe(false);
    expect(await Bun.file(join(store, '.storage-lock')).exists()).toBe(false);
    expect(await snapshotTasks(ctx.root)).toEqual(before);
  });

  // INVARIANT: an older populated store cannot be silently claimed by the
  // first clone to start after upgrade. Its checkout must be named explicitly.
  test('an unowned populated store needs an explicit first claim', async () => {
    expect((await ctx.lazy(['create', '--goal', 'Legacy task'])).exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const ownerPath = join(storageDirFor(ctx.root), STORE_OWNER_FILENAME);
    await rm(ownerPath);
    const refused = await ctx.lazy(['list'], { cwd: clone, env: { LAZY_TEST: '1' } });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('no recorded owning checkout');
    const claimed = await ctx.lazy(['system', 'store-rehome', '--from', 'unowned', '--yes']);
    expect(claimed.exitCode).toBe(0);
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).projectRoot).toBe(ctx.root);
  });

  async function prepareUnprovenStore(): Promise<string> {
    expect((await ctx.lazy(['create', '--goal', 'Legacy task', '--code', 'legacy-task'])).exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const ownerPath = join(storageDirFor(ctx.root), STORE_OWNER_FILENAME);
    await rm(ownerPath);
    return ownerPath;
  }

  // INVARIANT: only explicit terminal consent can claim an unproven store.
  // Startup must then retry the original command without losing saved data.
  for (const command of [['list'], ['daemon', 'start']]) {
    test(`terminal yes claims an unproven store and continues ${command.join(' ')}`, async () => {
      const ownerPath = await prepareUnprovenStore();
      const before = await snapshotTasks(ctx.root);
      const result = await ctx.lazy(command, { env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' } });
      const output = result.stdout + result.stderr;
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain(`This store at ${storageDirFor(ctx.root)} has no recorded owner. Claim it for ${ctx.root}? [y/N]`);
      expect(output.match(/has no recorded owner/g)).toHaveLength(1);
      expect(JSON.parse(await readFile(ownerPath, 'utf8')).projectRoot).toBe(ctx.root);
      expect(await snapshotTasks(ctx.root)).toEqual(before);
      expect((await ctx.lazy(['list'])).stdout).toContain('Legacy task');
    });
  }

  // INVARIANT: declining or accepting the default never assigns ownership.
  // A pending comment must not reach its editor before this pre-flight succeeds.
  for (const answer of ['decline', '1']) {
    test(`terminal ${answer} leaves an unproven store untouched before editor input`, async () => {
      const ownerPath = await prepareUnprovenStore();
      const before = await snapshotTasks(ctx.root);
      const editorMarker = join(scratch, 'editor-opened');
      const result = await ctx.lazy(['comment', 'legacy-task'], {
        env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: answer, EDITOR: `touch ${editorMarker}` },
      });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output.match(/has no recorded owner/g)).toHaveLength(1);
      expect(output).toContain('store-rehome --from unowned --yes');
      expect(output).not.toContain('Opening editor');
      expect(await Bun.file(editorMarker).exists()).toBe(false);
      expect(await Bun.file(ownerPath).exists()).toBe(false);
      expect(await Bun.file(join(storageDirFor(ctx.root), '.storage-lock')).exists()).toBe(false);
      expect(await snapshotTasks(ctx.root)).toEqual(before);
    });
  }

  // INVARIANT: --yes is never consent to claim data; unattended callers refuse.
  for (const scenario of [
    { name: 'non-TTY', command: ['list'], tty: false },
    { name: '--yes', command: ['create', '--goal', 'Unattended', '--yes'], tty: true },
    { name: '-y', command: ['daemon', 'start', '-y'], tty: true },
    { name: 'restart --yes', command: ['daemon', 'restart', '--yes'], tty: true },
  ]) {
    test(`${scenario.name} refuses an unproven store without prompting`, async () => {
      const ownerPath = await prepareUnprovenStore();
      const before = await snapshotTasks(ctx.root);
      const result = await ctx.lazy(scenario.command, {
        env: { LAZY_FORCE_TTY: scenario.tty ? '1' : '', LAZY_PROMPT_DEFAULTS: 'accept' },
      });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('store-rehome --from unowned --yes');
      expect(output).not.toContain('has no recorded owner. Claim it');
      expect(await Bun.file(ownerPath).exists()).toBe(false);
      expect(await snapshotTasks(ctx.root)).toEqual(before);
    });
  }

  test('terminal consent cannot claim a store already owned by another checkout', async () => {
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const ownerPath = join(storageDirFor(ctx.root), STORE_OWNER_FILENAME);
    const before = await readFile(ownerPath, 'utf8');
    const result = await ctx.lazy(['list'], {
      cwd: clone, env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('belongs to project checkout');
    expect(result.stdout + result.stderr).not.toContain('has no recorded owner. Claim it');
    expect(await readFile(ownerPath, 'utf8')).toBe(before);
  });

  test('doctor reports an unproven store and its remedy without claiming it', async () => {
    const ownerPath = await prepareUnprovenStore();
    const result = await ctx.lazy(['doctor'], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
    });
    const output = result.stdout + result.stderr;
    expect(output).toContain('The store cannot be opened by this checkout');
    expect(output).toContain('store-rehome --from unowned --yes');
    expect(output).not.toContain('has no recorded owner. Claim it');
    expect(await Bun.file(ownerPath).exists()).toBe(false);
  });

  // INVARIANT: a memory-only legacy store is still somebody's saved data.
  // A clone must refuse before taking its lock or assigning itself ownership.
  test('a memory-only legacy store requires an explicit first claim', async () => {
    expect((await ctx.lazy(['memory', 'save', 'original-memory', '--type', 'project',
      '--description', 'Belongs to the original checkout', '--body', 'Keep this knowledge'])).exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    expect(await readdir(tasksDirFor(ctx.root))).toEqual([]);
    const memoryPath = join(store, 'memories.json');
    const memory = await readFile(memoryPath, 'utf8');
    const modified = (await stat(memoryPath)).mtimeMs;
    const ownerPath = join(store, STORE_OWNER_FILENAME);
    await rm(ownerPath);
    const refused = await ctx.lazy(['daemon', 'start', '--foreground', '--project', clone], { cwd: clone });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('no recorded owning checkout');
    expect(await Bun.file(ownerPath).exists()).toBe(false);
    expect(await Bun.file(join(store, '.storage-lock')).exists()).toBe(false);
    expect(await readFile(memoryPath, 'utf8')).toBe(memory);
    expect((await stat(memoryPath)).mtimeMs).toBe(modified);
    expect((await ctx.lazy(['system', 'store-rehome', '--from', 'unowned', '--yes'])).exitCode).toBe(0);
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).projectRoot).toBe(ctx.root);
  });

  // INVARIANT: a Teams store is assigned by the fleet, overriding the repo's
  // configured path. Its first claim and subsequent rolls must keep working.
  test('a fleet-assigned legacy store is claimed and survives managed restarts', async () => {
    expect((await ctx.lazy(['create', '--goal', 'Existing fleet task'])).exitCode).toBe(0);
    expect((await ctx.lazy(['daemon', 'stop', '--yes'])).exitCode).toBe(0);
    const store = storageDirFor(ctx.root);
    const ownerPath = join(store, STORE_OWNER_FILENAME);
    await rm(ownerPath);
    const fleet = {
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: store,
      LAZY_PROJECT_INSTANCE_ID: 'fleet-project-original',
    };
    await ctx.restartDaemon(fleet);
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    expect(owner.projectInstanceId).toBe(fleet.LAZY_PROJECT_INSTANCE_ID);
    await ctx.restartDaemon(fleet);
    expect((await ctx.lazy(['list'])).exitCode).toBe(0);
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual(owner);
  });
});
