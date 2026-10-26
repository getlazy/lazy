import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { assertStoreOwner, claimStoreOwner, identifyCheckout, readStoreOwner, refreshStoreOwner, STORE_OWNER_FILENAME, type StoreOwner } from '../../src/storage/store-owner';
import { FileStorage } from '../../src/storage';
import { UnjudgeableStorageLockError } from '../../src/utils/storage-lock';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';
import { DEAD_PID } from '../helpers/dead-pid';

isolateLazyEnv();

describe('store ownership metadata', () => {
  let root: string;
  let store: string;
  let first: StoreOwner;
  let second: StoreOwner;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-store-owner-')));
    store = join(root, 'store');
    await mkdir(store);
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    first = await identifyCheckout(join(root, 'first'));
    second = await identifyCheckout(join(root, 'second'));
    first.repositoryRoots = second.repositoryRoots = ['a'.repeat(40)];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: claiming an empty store is exclusive, before .storage-lock.
  // Concurrent starts of two checkouts must never both believe they own it.
  test('two simultaneous first claims have exactly one winner', async () => {
    const claims = await Promise.allSettled([claimStoreOwner(store, first), claimStoreOwner(store, second)]);
    expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(c => c.status === 'rejected')).toHaveLength(1);
    expect([first.projectRoot, second.projectRoot]).toContain((await readStoreOwner(store))!.projectRoot);
  });

  // INVARIANT: removing the owning checkout does not authorize a clone to
  // take its store. Matching repository history is insufficient ownership.
  test('an absent original checkout still refuses a different directory', async () => {
    await claimStoreOwner(store, first);
    await rm(first.projectRoot, { recursive: true });
    await expect(assertStoreOwner(store, second)).rejects.toThrow('belongs to project checkout');
  });

  // INVARIANT: a directory's inode cannot authorize replacing the repository
  // inside it with unrelated history while retaining the previous task store.
  test('an unrelated repository at the same path is refused', async () => {
    await claimStoreOwner(store, first);
    const replaced = { ...first, repositoryRoots: ['b'.repeat(40)] };
    await expect(assertStoreOwner(store, replaced)).rejects.toThrow('belongs to project checkout');
  });

  test('a symlink to the owning checkout resolves to the same owner', async () => {
    await claimStoreOwner(store, first);
    const alias = join(root, 'alias');
    await symlink(first.projectRoot, alias);
    const current = await identifyCheckout(alias);
    current.repositoryRoots = first.repositoryRoots;
    await expect(assertStoreOwner(store, current)).resolves.toEqual(first);
  });

  // INVARIANT: a missing checkout cannot claim or open a store. Ownership
  // verification must refuse with an actionable error rather than raw ENOENT.
  test('a missing checkout is refused without writing ownership', async () => {
    const missing = join(root, 'missing');
    const storage = new FileStorage(missing, { basePath: store, enforceOwnership: true });
    await expect(storage.initialize()).rejects.toThrow(`Project checkout "${missing}" was not found`);
    expect(await readStoreOwner(store)).toBeNull();
  });

  test('a broken checkout symlink is reported as not found', async () => {
    const alias = join(root, 'broken-alias');
    await symlink(join(root, 'missing'), alias);
    await expect(identifyCheckout(alias)).rejects.toThrow('was not found');
  });

  test('a checkout path that is not a directory surfaces the inspection failure', async () => {
    const file = join(root, 'file');
    await writeFile(file, 'not a checkout');
    await expect(identifyCheckout(join(file, 'child'))).rejects.toThrow('Could not inspect store ownership');
  });

  // INVARIANT: fetching history changes a shallow clone's apparent roots,
  // never the ownership of its checkout or store.
  test('a depth-one clone remains the owner after deepening and unshallowing', async () => {
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', '-c', 'user.name=Ownership Test',
        '-c', 'user.email=ownership@example.test', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const origin = first.projectRoot;
    git(origin, 'init');
    for (let i = 0; i < 4; i++) git(origin, 'commit', '--allow-empty', '-m', `History ${i}`);
    const shallow = join(root, 'shallow');
    git(root, 'clone', '--depth=1', pathToFileURL(origin).href, shallow);
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const initial = await identifyCheckout(shallow);
    await claimStoreOwner(store, initial);

    git(shallow, 'fetch', '--deepen=1', 'origin');
    const deepened = await identifyCheckout(shallow);
    expect(deepened.repositoryRoots).not.toEqual(initial.repositoryRoots);
    await expect(assertStoreOwner(store, deepened)).resolves.toEqual(initial);
    await refreshStoreOwner(store, deepened);

    git(shallow, 'fetch', '--unshallow', 'origin');
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('false');
    const full = await identifyCheckout(shallow);
    expect(full.repositoryRoots).not.toEqual(deepened.repositoryRoots);
    await expect(assertStoreOwner(store, full)).resolves.toEqual(deepened);
    await refreshStoreOwner(store, full);
    expect(await readStoreOwner(store)).toEqual(full);
  });

  test('corrupt or unsupported ownership is never treated as absent', async () => {
    await writeFile(join(store, STORE_OWNER_FILENAME), '{broken');
    await expect(claimStoreOwner(store, first)).rejects.toThrow('Cannot parse store ownership');
    await writeFile(join(store, STORE_OWNER_FILENAME), '{"version":2}');
    await expect(claimStoreOwner(store, first)).rejects.toThrow('Invalid store ownership');
  });

  // INVARIANT: all saved domain state requires an explicit legacy-store claim,
  // even without tasks. Hidden files and future entity types count as data too.
  for (const path of ['memories.json', 'memory-history.json', 'conversations/builder.json',
    'system-messages.json', 'artifacts/blob', '.saved-data', 'future-entity.json']) {
    test(`an unowned store with only ${path} is not silently claimed`, async () => {
      const target = join(store, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'saved domain data');
      await expect(claimStoreOwner(store, second)).rejects.toThrow('contains saved data');
      expect(await readStoreOwner(store)).toBeNull();
      expect(await readFile(target, 'utf8')).toBe('saved domain data');
    });
  }

  test('empty initialized stores can still record their first owner', async () => {
    const storage = new FileStorage(first.projectRoot, { basePath: store });
    await storage.initialize();
    await claimStoreOwner(store, first);
    expect(await readStoreOwner(store)).toEqual(first);
  });

  // INVARIANT: legacy adoption requires unanimous, explicit checkout records.
  // Matching git history or one matching row cannot authorize a foreign clone.
  test('daemon-owned builder sessions prove the original checkout, never the clone', async () => {
    await writeFile(join(store, 'builder-sessions.json'), JSON.stringify({ sessions: [{ projectRoot: first.projectRoot }] }));
    await expect(claimStoreOwner(store, second)).rejects.toThrow('contains saved data');
    expect(await readStoreOwner(store)).toBeNull();
    // Preflight is read-only; the regular claim publishes the owner.
    await expect(assertStoreOwner(store, first)).resolves.toBeNull();
    expect(await readStoreOwner(store)).toBeNull();
    await claimStoreOwner(store, first);
    expect(await readStoreOwner(store)).toEqual(first);
  });

  // INVARIANT: builder callers choose resume-intent roots. No value they
  // supply can authorize either checkout to adopt an otherwise unproven store.
  for (const checkout of ['original', 'clone'] as const) {
    test(`a forged resume intent naming the ${checkout} proves neither checkout`, async () => {
      const named = checkout === 'original' ? first : second;
      await writeFile(join(store, 'builder-resume-intents.json'), JSON.stringify({ intents: [{ projectRoot: named.projectRoot }] }));
      await expect(claimStoreOwner(store, first)).rejects.toThrow('contains saved data');
      await expect(claimStoreOwner(store, second)).rejects.toThrow('contains saved data');
      expect(await readStoreOwner(store)).toBeNull();
    });
  }

  test('untrusted resume intents cannot veto trustworthy builder-session evidence', async () => {
    await writeFile(join(store, 'builder-sessions.json'), JSON.stringify({ sessions: [{ projectRoot: first.projectRoot }] }));
    await writeFile(join(store, 'builder-resume-intents.json'), '{malformed caller-controlled data');
    await claimStoreOwner(store, first);
    expect(await readStoreOwner(store)).toEqual(first);
  });

  for (const record of [
    {}, { projectRoot: 'relative' }, { projectRoot: null }, null,
  ]) {
    test(`unusable checkout evidence ${JSON.stringify(record)} cannot claim a store`, async () => {
      await writeFile(join(store, 'builder-sessions.json'), JSON.stringify({
        sessions: [{ projectRoot: first.projectRoot }, record],
      }));
      await expect(claimStoreOwner(store, first)).rejects.toThrow('contains saved data');
      expect(await readStoreOwner(store)).toBeNull();
    });
  }

  test('conflicting trusted builder-session roots refuse both checkouts', async () => {
    await writeFile(join(store, 'builder-sessions.json'), JSON.stringify({ sessions: [
      { projectRoot: first.projectRoot }, { projectRoot: second.projectRoot },
    ] }));
    await expect(claimStoreOwner(store, first)).rejects.toThrow('contains saved data');
    await expect(claimStoreOwner(store, second)).rejects.toThrow('contains saved data');
    expect(await readStoreOwner(store)).toBeNull();
  });

  test('legacy evidence resolves checkout aliases without requiring old task worktrees to exist', async () => {
    const alias = join(root, 'legacy-alias');
    await symlink(first.projectRoot, alias);
    await writeFile(join(store, 'builder-sessions.json'), JSON.stringify({ sessions: [{ projectRoot: alias }] }));
    await claimStoreOwner(store, first);
    expect(await readStoreOwner(store)).toEqual(first);
  });

  for (const content of ['{broken', '{"sessions":{}}', '{"sessions":[]}']) {
    test(`corrupt or empty builder records cannot authorize adoption: ${content}`, async () => {
      await writeFile(join(store, 'builder-sessions.json'), content);
      await expect(claimStoreOwner(store, first)).rejects.toThrow(
        content === '{broken' ? 'Cannot inspect legacy store ownership' : 'contains saved data',
      );
      expect(await readStoreOwner(store)).toBeNull();
    });
  }

  // INVARIANT: normal fleet recreation retains its control-plane project id,
  // even if guest paths or repository directory inodes change. Another fleet
  // project's id cannot borrow the store, even at the same guest path.
  test('fleet ownership survives recreation but refuses another project id', async () => {
    first.projectInstanceId = 'fleet-project-one';
    await claimStoreOwner(store, first);
    second.projectInstanceId = first.projectInstanceId;
    await expect(assertStoreOwner(store, second)).resolves.toEqual(first);
    second.projectInstanceId = 'fleet-project-two';
    second.projectRoot = first.projectRoot;
    await expect(assertStoreOwner(store, second)).rejects.toThrow('belongs to project checkout');
  });

  test('a restore marker prevents even the first ownership write', async () => {
    await writeFile(join(store, '.restore-in-progress'), '{}');
    await expect(claimStoreOwner(store, first)).rejects.toThrow('a store restore owns this store');
    expect(await readStoreOwner(store)).toBeNull();
  });

  test('re-homing rechecks the previous owner under the storage lock', async () => {
    await claimStoreOwner(store, first);
    const storage = new FileStorage(second.projectRoot, { basePath: store });
    await expect(storage.rehomeOwnership('unowned')).rejects.toThrow('No ownership was changed');
    expect(await readStoreOwner(store)).toEqual(first);
    await storage.rehomeOwnership(first.projectRoot);
    expect((await readStoreOwner(store))?.projectRoot).toBe(second.projectRoot);
    // A start that validated the old owner before the transfer cannot refresh
    // that stale ownership over the operator's newly recorded decision.
    await expect(refreshStoreOwner(store, first)).rejects.toThrow('belongs to project checkout');
    expect((await readStoreOwner(store))?.projectRoot).toBe(second.projectRoot);
  });

  // INVARIANT: a transfer cannot reclaim a lock whose writer may be alive on
  // another kernel. The owner and that writer's lock must remain untouched.
  test('re-homing refuses a foreign-namespace holder even when its PID is absent here', async () => {
    await claimStoreOwner(store, first);
    const lockPath = join(store, '.storage-lock');
    const content = JSON.stringify({
      pid: DEAD_PID,
      acquired_at: new Date().toISOString(),
      holder_namespace: process.platform === 'linux'
        ? 'darwin:AAAAAAAA-mac-boot'
        : 'linux:11111111-vm-boot:pid:[4026532952]',
    });
    await writeFile(lockPath, content);
    const storage = new FileStorage(second.projectRoot, { basePath: store, lockTimeoutMs: 100 });
    await expect(storage.rehomeOwnership(first.projectRoot)).rejects.toBeInstanceOf(UnjudgeableStorageLockError);
    expect(await readFile(lockPath, 'utf8')).toBe(content);
    expect(await readStoreOwner(store)).toEqual(first);
  });
});
