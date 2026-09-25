/**
 * `inspectStore` — the preflight Lazy Teams runs before adopting an existing
 * store (see src/storage/store-inspect.ts).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspectStore, SUPPORTED_STORE_SCHEMA_VERSION } from '../../src/storage/store-inspect';
import { STORAGE_LOCK_FILENAME } from '../../src/utils/storage-lock';
import { selfIdentity } from '../../src/utils/process-identity';

let root: string;

async function seedStore(opts: {
  schemaVersion?: number | null;
  turns?: unknown;
  tasks?: string[];
} = {}): Promise<string> {
  const store = join(root, 'store');
  const tasks = opts.tasks ?? ['task-1'];
  for (const id of tasks) await mkdir(join(store, 'tasks', id), { recursive: true });

  if (opts.schemaVersion !== null) {
    await writeFile(
      join(store, 'version.json'),
      JSON.stringify({ schema_version: opts.schemaVersion ?? SUPPORTED_STORE_SCHEMA_VERSION }),
    );
  }
  if (opts.turns !== undefined) {
    await writeFile(join(store, 'tasks', tasks[0], 'turns.json'), JSON.stringify(opts.turns));
  }
  return store;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-store-inspect-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// INVARIANT: the preflight's idea of the supported schema version is the one
// FileStorage actually writes. They are separate constants on purpose — the
// preflight opens nothing and must not import the storage implementation — so
// the agreement is asserted rather than assumed. A source scan, because
// STORAGE_VERSION is module-private and exporting it for a test would be the
// import this separation exists to avoid.
test('SUPPORTED_STORE_SCHEMA_VERSION matches the version FileStorage writes', async () => {
  const source = await Bun.file(join(import.meta.dir, '../../src/storage/file-storage.ts')).text();
  const match = source.match(/const STORAGE_VERSION = (\d+);/);

  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(SUPPORTED_STORE_SCHEMA_VERSION);
});

describe('inspectStore', () => {
  test('a directory with no tasks/ is not a store', async () => {
    const result = await inspectStore(root);

    expect(result.is_store).toBe(false);
    expect(result.task_count).toBe(0);
  });

  test('reports task count, schema version and an absent lock', async () => {
    const store = await seedStore({ tasks: ['a', 'b', 'c'] });
    const result = await inspectStore(store);

    expect(result.is_store).toBe(true);
    expect(result.task_count).toBe(3);
    expect(result.schema_version).toBe(SUPPORTED_STORE_SCHEMA_VERSION);
    expect(result.schema_is_newer).toBe(false);
    expect(result.lock.state).toBe('absent');
  });

  // INVARIANT: a store written by a NEWER lazy is flagged, not read. An older
  // lazy reading a newer schema loses whatever it does not understand on the
  // first write — silently, behind a UI that looks fine.
  test('flags a store whose schema is newer than this lazy understands', async () => {
    const store = await seedStore({ schemaVersion: SUPPORTED_STORE_SCHEMA_VERSION + 1 });
    const result = await inspectStore(store);

    expect(result.schema_is_newer).toBe(true);
    expect(result.supported_schema_version).toBe(SUPPORTED_STORE_SCHEMA_VERSION);
  });

  test('a store that states no version is reported as unstated, not as newer', async () => {
    const store = await seedStore({ schemaVersion: null });
    const result = await inspectStore(store);

    expect(result.schema_version).toBeNull();
    expect(result.schema_is_newer).toBe(false);
    expect(result.schema_error).toBeNull();
  });

  test('reports malformed schema metadata instead of treating it as a legacy store', async () => {
    const store = await seedStore();
    await writeFile(join(store, 'version.json'), 'not json');
    const result = await inspectStore(store);
    expect(result.schema_version).toBeNull();
    expect(result.schema_error).toContain('not valid JSON');
  });

  test('reports unreadable schema metadata instead of treating it as a legacy store', async () => {
    const store = await seedStore();
    await rm(join(store, 'version.json'));
    await mkdir(join(store, 'version.json'));
    expect((await inspectStore(store)).schema_error).toContain('could not be read');
  });

  // INVARIANT: a LIVE lock is reported as held. Adoption while the previous
  // owner still holds the store would give it two writers.
  test('reports a lock held by a live process, with its pid', async () => {
    const store = await seedStore();
    const identity = await selfIdentity();
    await writeFile(join(store, STORAGE_LOCK_FILENAME), JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      holder_started_at: identity?.started ?? undefined,
      holder_start_source: identity?.startedSource ?? undefined,
      holder_command: identity?.command ?? undefined,
    }));

    const result = await inspectStore(store);

    expect(result.lock.state).toBe('held');
    if (result.lock.state === 'held') expect(result.lock.pid).toBe(process.pid);
  });

  test('a lock whose holder is gone is stale, with a reason', async () => {
    const store = await seedStore();
    // Above pid_max on both macOS (99998) and a stock Linux (4194304 ceiling,
    // 32768 default), so nothing can occupy it. NOT pid 0: `kill(0, 0)` signals
    // the caller's own process GROUP and succeeds, which reads as a live holder.
    await writeFile(join(store, STORAGE_LOCK_FILENAME), JSON.stringify({
      pid: 4_194_305, acquired_at: new Date().toISOString(),
    }));

    const result = await inspectStore(store);

    expect(result.lock.state).toBe('stale');
    if (result.lock.state === 'stale') expect(result.lock.reason).toBeTruthy();
  });

  test('a lock file that will not parse is reported, not guessed at', async () => {
    const store = await seedStore();
    await writeFile(join(store, STORAGE_LOCK_FILENAME), 'not json');

    const result = await inspectStore(store);

    expect(result.lock.state).toBe('unreadable');
  });

  test('a lock that cannot be read is reported rather than treated as absent', async () => {
    const store = await seedStore();
    await mkdir(join(store, STORAGE_LOCK_FILENAME));
    const result = await inspectStore(store);
    expect(result.lock.state).toBe('unreadable');
    if (result.lock.state === 'unreadable') expect(result.lock.detail).toContain('could not be read');
  });

  // INVARIANT: every actor id in the store is surfaced. A legacy `user-<n>` is
  // one install's Rails numbering; an adopting install that cannot resolve one
  // would attribute a stranger's work to one of its own members.
  test('collects distinct actor ids across every per-person key', async () => {
    const store = await seedStore({
      turns: { turns: [
        { actor: 'human', actor_user_id: 'user-7' },
        { actor: 'human', actor_user_id: 'user-7' },
        { actor: 'agent' },
      ] },
    });
    await writeFile(join(store, 'tasks', 'task-1', 'raised-items.json'), JSON.stringify({
      items: [{ resolved_by_user_id: 'user-3', flagged_by_user_id: 'user-9' }],
    }));

    const result = await inspectStore(store);

    expect(result.actor_user_ids).toEqual(['user-3', 'user-7', 'user-9']);
  });

  // INVARIANT: a legacy id under the CURRENT keys is surfaced too. The daemon's
  // start-up migration judges those keys and clears any non-email, so a scan
  // reading only the old spellings would let an adoption lose that attribution.
  test('collects ids under the current per-person keys', async () => {
    const store = await seedStore({
      turns: { turns: [{ actor: 'human', actor_email: 'user-12' }, { actor_email: 'ada@example.com' }] },
    });
    await writeFile(join(store, 'tasks', 'task-1', 'raised-items.json'), JSON.stringify({
      raised_items: [{
        resolved_by_email: 'user-3',
        unresolved_by_email: 'user-4',
        flagged_by_email: 'user-5',
        comments: [{ actor_email: 'user-6' }],
      }],
    }));
    await writeFile(join(store, 'tasks', 'task-1', 'comments.json'), JSON.stringify({
      comments: [{ actor_email: 'ada@example.com', edited_by_email: 'user-8' }],
    }));

    const result = await inspectStore(store);

    expect(result.actor_user_ids).toEqual(['ada@example.com', 'user-12', 'user-3', 'user-4', 'user-5', 'user-6', 'user-8']);
  });

  // INVARIANT: region-overlay actors are OBJECTS, in both spellings, and the
  // person inside them is surfaced like any scalar key.
  test('collects ids inside region-overlay actor objects', async () => {
    const store = await seedStore({ turns: { turns: [] } });
    await writeFile(join(store, 'tasks', 'task-1', 'region-overlays.json'), JSON.stringify({
      overlays: [
        { owner_set_by: { user_id: 'user-21', label: 'Ada' }, signed_off_by: { email: 'user-22' } },
        { owner_set_by: { email: 'bob@example.com', name: 'Bob' } },
      ],
    }));

    const result = await inspectStore(store);

    expect(result.actor_user_ids).toEqual(['bob@example.com', 'user-21', 'user-22']);
  });

  test('a store file that will not parse is reported as unscanned', async () => {
    const store = await seedStore({ turns: { turns: [] } });
    await writeFile(join(store, 'tasks', 'task-1', 'comments.json'), '{ not json');

    expect((await inspectStore(store)).unscanned_files).toEqual(['tasks/task-1/comments.json']);
  });

  // INVARIANT: a file the scan could not read is REPORTED, never silently
  // dropped. `actor_user_ids` feeds a refusal whose justification is that
  // misattribution cannot be detected afterwards, so "no ids" and "no ids in
  // what I managed to read" must be distinguishable by the caller.
  test('names a file it could not read instead of quietly skipping it', async () => {
    const store = await seedStore({ turns: { turns: [{ actor_user_id: 'user-1' }] } });
    const unreadable = join(store, 'tasks', 'task-1', 'comments.json');
    await writeFile(unreadable, '{}');
    await chmod(unreadable, 0o000);

    const result = await inspectStore(store);

    // Running as root defeats the permission bit; the assertion only means
    // anything when the read really fails, and saying so beats a silent pass.
    if (await readFile(unreadable, 'utf-8').then(() => true, () => false)) {
      console.log('skipped: this process can read a 0000 file (running as root)');
      return;
    }

    expect(result.unscanned_files).toEqual(['tasks/task-1/comments.json']);
    // What it DID read is still reported.
    expect(result.actor_user_ids).toEqual(['user-1']);
  });

  test('a fully readable store reports nothing unscanned', async () => {
    const store = await seedStore({ turns: { turns: [{ actor_user_id: 'user-1' }] } });

    expect((await inspectStore(store)).unscanned_files).toEqual([]);
  });

  test('a single-person store carries no actor ids at all', async () => {
    const store = await seedStore({ turns: { turns: [{ actor: 'human' }, { actor: 'agent' }] } });

    expect((await inspectStore(store)).actor_user_ids).toEqual([]);
  });

  // INVARIANT: the preflight NEVER takes the lock and NEVER writes. It runs
  // against a store another daemon may be serving, and a preflight that
  // acquired the lock would be the second writer it exists to prevent.
  test('inspecting a store writes nothing into it', async () => {
    const store = await seedStore();
    const before = (await readdir(store)).sort();

    await inspectStore(store);

    expect((await readdir(store)).sort()).toEqual(before);
  });
});
