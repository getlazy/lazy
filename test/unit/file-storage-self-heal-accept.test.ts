import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { ACCEPT_IN_FLIGHT_KEY } from '../../src/task/accept-in-flight';

/**
 * The read-path self-heal (listTasksWithOptions) flips a task whose session
 * ended `accepted` to `complete`. An accept running at the same time ends the
 * session FIRST and writes its own attributed `complete` after, so the heal
 * and the accept race over the same transition.
 */
describe('FileStorage self-heal vs a live accept', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-fs-heal-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const completes = async (id: string) => (await storage.getStatusHistory(id)).filter((c) => c.status === 'complete');

  // INVARIANT: a task whose accept is in flight is left to that accept. The
  // accept writes `complete` attributed to the person who accepted; a heal that
  // got there first recorded an unattributed one, and the accept then skipped
  // its own (seen as a red daemon-actor-tokens run under load).
  test('does not heal a task with an accept in flight', async () => {
    const task = await storage.createTask('accepting');
    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, 'blocked');
    await storage.endSession(session.id, 'accepted');

    await storage.listTasksWithOptions({});

    expect((await storage.getTask(task.id))?.status).toBe('blocked');
    expect(await completes(task.id)).toHaveLength(0);
  });

  // INVARIANT: the heal decides again on the fresh read inside its lock. Its
  // decision comes from a snapshot taken before the sweep's awaits; when the
  // accept completed the task in between, healing again appended a SECOND
  // `complete` to the changelog.
  test('does not record a second complete when the task completed after the snapshot', async () => {
    const task = await storage.createTask('accepted meanwhile');
    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.endSession(session.id, 'accepted');

    // The accept lands between the sweep's snapshot and its locked write.
    const realGetSession = storage.getSessionByTaskId.bind(storage);
    let landed = false;
    storage.getSessionByTaskId = async (id: string) => {
      const s = await realGetSession(id);
      if (id === task.id && !landed) {
        landed = true;
        await storage.updateTaskStatus(task.id, 'merging');
        await storage.updateTaskStatus(task.id, 'complete');
      }
      return s;
    };

    await storage.listTasksWithOptions({});

    expect(await completes(task.id)).toHaveLength(1);
  });

  // INVARIANT: a declined heal reports the record on disk. An accept that
  // starts after the snapshot leaves the task `merging`; the list must say so,
  // or a merging-only reader (the stranded-merge sweep) loses it for a tick.
  test('a heal declined for an accept that started after the snapshot reports the task as it is', async () => {
    const task = await storage.createTask('accept starts meanwhile');
    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.endSession(session.id, 'accepted');

    const realGetSession = storage.getSessionByTaskId.bind(storage);
    let started = false;
    storage.getSessionByTaskId = async (id: string) => {
      const s = await realGetSession(id);
      if (id === task.id && !started) {
        started = true;
        await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, 'blocked');
        await storage.updateTaskStatus(task.id, 'merging');
      }
      return s;
    };

    const listed = await storage.listTasksWithOptions({});

    expect(listed.find((t) => t.id === task.id)?.status).toBe('merging');
    expect(await completes(task.id)).toHaveLength(0);
  });

  test('still heals a task whose session ended accepted with no accept in flight', async () => {
    const task = await storage.createTask('crashed accept');
    const session = await storage.createSession(task.id, 'claude-code', 'br', 'sha');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.endSession(session.id, 'accepted');

    await storage.listTasksWithOptions({});

    expect((await storage.getTask(task.id))?.status).toBe('complete');
    expect(await completes(task.id)).toHaveLength(1);
  });
});
