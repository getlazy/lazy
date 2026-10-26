import { link, mkdir, readFile, readdir, realpath, rename, stat, unlink, open } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { randomUUID } from 'crypto';
import { runGit } from '../utils/git';
import { isManagedMode } from '../config/managed-mode';
import { readProjectInstanceId } from '../daemon/project-instance';
import { RESTORE_MARKER_FILENAME, STORAGE_LOCK_FILENAME, StoreRestoreInProgressError } from '../utils/storage-lock';
import { shellQuote } from '../utils/shell-quote';

export const STORE_OWNER_FILENAME = 'owner.json';

export class UnownedStoreError extends Error {
  readonly remedy = 'lazy system store-rehome --from unowned --yes';

  constructor(readonly store: string, readonly projectRoot: string) {
    super(
      `Store ${store} contains saved data but has no recorded owning checkout. Refusing to claim it for "${projectRoot}" automatically. ` +
      `After stopping the previous daemon and confirming this is your project's store, run 'lazy system store-rehome --from unowned --yes' in that checkout.`,
    );
    this.name = 'UnownedStoreError';
  }
}

export interface StoreOwner {
  version: 1;
  projectRoot: string;
  repositoryRoots: string[];
  checkout: { dev: number; ino: number; birthtimeMs: number };
  projectInstanceId: string | null;
}

async function missingOnly<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return absent;
    throw new Error(`Could not inspect store ownership: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
}

/** Backend metadata: read without initializing the store or taking its lock. */
export async function readStoreOwner(store: string): Promise<StoreOwner | null> {
  const path = join(store, STORE_OWNER_FILENAME);
  const content = await missingOnly(() => readFile(path, 'utf8'), null);
  if (content === null) return null;
  let value: StoreOwner;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw new Error(`Cannot parse store ownership at ${path}: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
  if (!value || value.version !== 1 || typeof value.projectRoot !== 'string' || !value.projectRoot.startsWith('/') ||
      !Array.isArray(value.repositoryRoots) || !value.repositoryRoots.every(r => typeof r === 'string' && /^[a-f0-9]{40,64}$/.test(r)) ||
      !value.checkout || !['dev', 'ino', 'birthtimeMs'].every(k => Number.isFinite(value.checkout[k as keyof StoreOwner['checkout']])) ||
      !(value.projectInstanceId === null || typeof value.projectInstanceId === 'string')) {
    throw new Error(`Invalid store ownership at ${path}. Restore a valid ownership record; lazy will not guess who owns this store.`);
  }
  return value;
}

export async function identifyCheckout(root: string): Promise<StoreOwner> {
  const projectRoot = await missingOnly(() => realpath(root), null);
  const dir = projectRoot === null ? null : await missingOnly(() => stat(projectRoot), null);
  if (projectRoot === null || dir === null) {
    throw new Error(`Project checkout "${root}" was not found. Refusing to open its store without verifying ownership. Restore the checkout or run lazy from an existing project checkout.`);
  }
  let repositoryRoots: string[] = [];
  if (await missingOnly(() => stat(join(projectRoot, '.git')), null)) {
    const head = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectRoot });
    if (head.exitCode === 0) {
      const roots = await runGit(['rev-list', '--max-parents=0', 'HEAD'], { cwd: projectRoot });
      if (roots.exitCode !== 0) throw new Error(`Cannot identify repository at ${projectRoot}: ${roots.stderr}`);
      repositoryRoots = roots.stdout.trim().split('\n').sort();
    } else if (head.exitCode !== 1) {
      throw new Error(`Cannot identify checkout at ${projectRoot}: ${head.stderr}`);
    }
  }
  return {
    version: 1, projectRoot, repositoryRoots,
    checkout: { dev: dir.dev, ino: dir.ino, birthtimeMs: dir.birthtimeMs },
    projectInstanceId: isManagedMode() ? readProjectInstanceId() ?? null : null,
  };
}

function refusal(store: string, owner: StoreOwner, root: string): Error {
  return new Error(
    `Store ${store} belongs to project checkout "${owner.projectRoot}", not "${root}". ` +
    `Refusing to open another checkout's tasks. A copied [storage] external_path in lazy.toml or projects with the same default store name can cause this. ` +
    `Give "${root}" a store of its own by changing [storage] external_path. ` +
    `For an intentional move, stop the previous daemon and run lazy system store-rehome --from ${shellQuote(owner.projectRoot)} --yes in the new checkout.`,
  );
}

export async function assertStoreOwner(store: string, current: StoreOwner): Promise<StoreOwner | null> {
  const owner = await readStoreOwner(store);
  if (!owner) {
    // The fleet explicitly assigned this store (or copied it on adoption). Its
    // stable project id is control-plane input, never repository config.
    if (!isManagedMode() && await hasPersistentData(store) &&
        !await legacyRecordsProveCheckout(store, current.projectRoot)) {
      throw new UnownedStoreError(store, current.projectRoot);
    }
    return null;
  }
  if (owner.projectInstanceId !== null) {
    if (owner.projectInstanceId && owner.projectInstanceId === current.projectInstanceId) return owner;
    throw refusal(store, owner, current.projectRoot);
  }
  const sameDirectory = owner.checkout.dev === current.checkout.dev && owner.checkout.ino === current.checkout.ino &&
    owner.checkout.birthtimeMs === current.checkout.birthtimeMs;
  const sameRepository = owner.repositoryRoots.some(r => current.repositoryRoots.includes(r)) ||
    ((sameDirectory || owner.projectRoot === current.projectRoot) && await retainsRepositoryAnchor(owner, current));
  const repositoryMatches = sameRepository || (owner.repositoryRoots.length === 0 && sameDirectory);
  if (owner.projectRoot === current.projectRoot && repositoryMatches) return owner;
  // A clone shares history, but not the original directory's identity. An
  // absent old path ALONE is never permission to take over a store.
  if (sameDirectory && (sameRepository || owner.repositoryRoots.length === 0) &&
      !(await missingOnly(() => stat(owner.projectRoot), null))) return owner;
  throw refusal(store, owner, current.projectRoot);
}

/** Inspect backend records before initialization, without migrating or writing them. */
async function legacyRecordsProveCheckout(store: string, projectRoot: string): Promise<boolean> {
  // Only builder-session rows prove a host checkout: startBuilderSessionLocked
  // (daemon/builder-sessions.ts) sets projectRoot from the server's projectRoot,
  // passed by handleRpc, never params. Its continuationFor spread contains only
  // continuedFrom/continuationSeed, so cannot overwrite that root. rpc-auth.ts
  // refuses task/builder tokens on /rpc/*; BUILDER_STORAGE_METHODS excludes
  // createBuilderSession/updateBuilderSession, and refuseMemberSessionStorageWrite
  // also bars user-token proxy writes. Only trusted control callers can seed rows.
  // Builder capture's recordRunConversation updates only agentSessionId, not root.
  // Resume intents are NOT evidence, even as a veto: /builder/storage accepts
  // saveBuilderResumeIntent with a caller-chosen projectRoot. Task session.json
  // has only branch/commit ids; shared history and agent text prove no checkout.
  let found = false;
  const path = join(store, 'builder-sessions.json');
  const content = await missingOnly(() => readFile(path, 'utf8'), null);
  if (content === null) return false;
  let value;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw new Error(`Cannot inspect legacy store ownership at ${path}: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
  if (!value || !Array.isArray(value.sessions)) return false;
  for (const record of value.sessions) {
    if (!record || typeof record.projectRoot !== 'string' || !isAbsolute(record.projectRoot)) return false;
    const canonical = await missingOnly(() => realpath(record.projectRoot), null);
    // All trusted rows must agree, including stopped/ended builders. A
    // matching row must never hide a foreign or unusable root.
    if (canonical !== projectRoot) return false;
    found = true;
  }
  return found;
}

async function retainsRepositoryAnchor(owner: StoreOwner, current: StoreOwner): Promise<boolean> {
  if (owner.repositoryRoots.length === 0 || current.repositoryRoots.length === 0) return false;
  if (!(await missingOnly(() => stat(join(current.projectRoot, '.git')), null))) return false;
  // A shallow boundary is an ordinary commit after deepening. Its object id
  // remains a stable history anchor even though rev-list's roots have changed.
  // Only a checkout at the recorded path or the same moved directory may use
  // this check; shared history alone can never authorize another clone.
  const history = await runGit(['rev-list', 'HEAD'], { cwd: current.projectRoot });
  if (history.exitCode !== 0) {
    throw new Error(`Cannot verify repository ownership at ${current.projectRoot}: ${history.stderr}`);
  }
  const commits = new Set(history.stdout.trim().split('\n'));
  return owner.repositoryRoots.some(anchor => commits.has(anchor));
}

/** Only bootstrap metadata is disposable; unknown files also require consent. */
async function hasPersistentData(directory: string, topLevel = true): Promise<boolean> {
  const entries = await missingOnly(() => readdir(directory, { withFileTypes: true }), []);
  for (const entry of entries) {
    if (topLevel && entry.isFile() && (
      entry.name === 'version.json' || entry.name === STORAGE_LOCK_FILENAME ||
      /^\.owner-[a-f0-9-]+\.tmp$/.test(entry.name)
    )) continue;
    // Do not follow symlinks. An entry pointing elsewhere is evidence of data,
    // and an empty directory alone (such as tasks/) contains no domain state.
    if (!entry.isDirectory() || await hasPersistentData(join(directory, entry.name), false)) return true;
  }
  return false;
}

/** Publish complete JSON atomically; an exclusive link chooses the first owner. */
export async function writeStoreOwner(store: string, owner: StoreOwner, replace: boolean): Promise<boolean> {
  await mkdir(store, { recursive: true });
  const temporary = join(store, `.owner-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(owner, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    if (replace) await rename(temporary, join(store, STORE_OWNER_FILENAME));
    else await link(temporary, join(store, STORE_OWNER_FILENAME));
    return true;
  } catch (err) {
    if (!replace && (err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new Error(`Cannot record ownership of store ${store}: ${err instanceof Error ? err.message : err}`, { cause: err });
  } finally {
    await missingOnly(() => unlink(temporary), undefined);
  }
}

export async function claimStoreOwner(store: string, current: StoreOwner): Promise<void> {
  const restoreMarker = join(store, RESTORE_MARKER_FILENAME);
  if (await missingOnly(() => stat(restoreMarker), null)) throw new StoreRestoreInProgressError(restoreMarker);
  const previous = await assertStoreOwner(store, current);
  if (!previous) {
    await writeStoreOwner(store, current, false);
    // Another checkout may have won the exclusive creation. Believe the file.
    await assertStoreOwner(store, current);
  }
}

/** Called only inside the backend's storage lock: never race an explicit transfer. */
export async function refreshStoreOwner(store: string, current: StoreOwner): Promise<void> {
  const previous = await assertStoreOwner(store, current);
  if (!previous) throw new Error(`Store ${store} lost its ownership record while opening.`);
  if (JSON.stringify(previous) !== JSON.stringify(current)) await writeStoreOwner(store, current, true);
}
