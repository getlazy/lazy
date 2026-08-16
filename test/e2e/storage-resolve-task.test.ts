/**
 * Cross-backend task-reference resolution.
 *
 * INVARIANT: `resolveTask` decides "this input is a task id" by SHAPE, never by
 * length. A task code may legitimately be exactly 36 characters long — the
 * length of a UUID — and FileStorage used to take the "already a full UUID"
 * fast path on length alone. The task then showed up in `lazy list` while every
 * lookup by its code (approve, status, review) failed with "No task found
 * matching"; only the hex-prefix form worked.
 *
 * INVARIANT: the id and code namespaces are disjoint by shape. A UUID-shaped
 * input is NOT retried as a code when no such task exists — that keeps an id
 * miss to one failed lookup instead of a full-store scan, which `lazy doctor`'s
 * storage liveness probe depends on (it looks up the nil UUID under a fixed
 * timeout against a store of unbounded size).
 *
 * RemoteStorage is deliberately not exercised: it is a JSON-RPC pass-through
 * that forwards resolution to the daemon's own backend, so it inherits whichever
 * backend below is in play.
 *
 * The Postgres half requires a real database. Set LAZY_POSTGRES_URL, e.g.
 *   LAZY_POSTGRES_URL=$(lazy-pg-start)
 * Without it, only the FileStorage half runs.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { FileStorage } from '../../src/storage/file-storage';
import { PostgresStorage } from '../../src/storage/postgres-storage';
import type { Storage } from '../../src/storage/interface';

const TEST_URL = process.env.LAZY_POSTGRES_URL;

interface Backend {
  name: string;
  make: () => Promise<{ storage: Storage; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'FileStorage',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'lazy-resolve-file-'));
      const storage = new FileStorage(root, { basePath: join(root, 'store') });
      await storage.initialize();
      return {
        storage,
        cleanup: async () => {
          await storage.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

if (TEST_URL) {
  backends.push({
    name: 'PostgresStorage',
    make: async () => {
      // onnotice: DROP SCHEMA CASCADE emits a NOTICE per dependent table,
      // which postgres.js logs to the console and drowns the test output.
      const admin = postgres(TEST_URL, { max: 1, onnotice: () => {} });
      await admin`DROP SCHEMA public CASCADE`;
      await admin`CREATE SCHEMA public`;
      await admin.end();
      const storage = new PostgresStorage('/tmp/lazy-resolve-pg', { url: TEST_URL });
      await storage.initialize();
      return { storage, cleanup: () => storage.close() };
    },
  });
} else {
  console.log('storage-resolve-task: Postgres half skipped — set LAZY_POSTGRES_URL to run it');
}

/** The real code that triggered the bug. Exactly 36 characters. */
const CODE_36 = 'fix-approval-burned-on-failed-accept';

for (const backend of backends) {
  describe(`resolveTask (${backend.name})`, () => {
    let storage: Storage;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await backend.make());
    });

    afterEach(async () => {
      await cleanup();
    });

    test('resolves a task whose code is exactly 36 characters', async () => {
      expect(CODE_36.length).toBe(36); // the whole point of this test
      const created = await storage.createTask('Fix approval', undefined, undefined, CODE_36);

      const { task } = await storage.resolveTask(CODE_36);
      expect(task?.id).toBe(created.id);
      expect(task?.code).toBe(CODE_36);
    });

    test('resolves codes of every length around the old 36-char cutoff', async () => {
      // 35 and 37 always worked; 36 is the regression.
      for (const length of [35, 36, 37]) {
        const code = `c${'x'.repeat(length - 2)}${length % 10}`;
        expect(code.length).toBe(length);
        const created = await storage.createTask(`Task ${length}`, undefined, undefined, code);
        const { task } = await storage.resolveTask(code);
        expect(task?.id).toBe(created.id);
      }
    });

    test('resolves a code containing dots', async () => {
      const created = await storage.createTask('Release', undefined, undefined, 'release-v0.5');

      const { task } = await storage.resolveTask('release-v0.5');
      expect(task?.id).toBe(created.id);
    });

    test('still resolves a task by its full UUID', async () => {
      const created = await storage.createTask('By id');

      const { task } = await storage.resolveTask(created.id);
      expect(task?.id).toBe(created.id);
    });

    test('still resolves a task by short hex prefix', async () => {
      const created = await storage.createTask('By prefix');

      const { task } = await storage.resolveTask(created.id.slice(0, 8));
      expect(task?.id).toBe(created.id);
    });

    test('a UUID that names no task resolves to null', async () => {
      await storage.createTask('Unrelated');

      const { task } = await storage.resolveTask('00000000-0000-0000-0000-000000000000');
      expect(task).toBeNull();
    });

    test('a 36-character non-UUID that matches nothing resolves to null', async () => {
      await storage.createTask('Unrelated');

      const input = 'no-such-code-of-exactly-36-chars-here'.slice(0, 36);
      expect(input.length).toBe(36);
      const { task } = await storage.resolveTask(input);
      expect(task).toBeNull();
    });
  });
}
