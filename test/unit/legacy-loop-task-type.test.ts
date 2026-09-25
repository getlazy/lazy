/**
 * A task stored as `type: "loop"` reads as a `cluster`.
 *
 * INVARIANT: the type was renamed `loop` → `cluster` on 2026-09-20 (the serial
 * one-running-child rule went with it — see
 * docs/design/cluster-replaces-loop.md), and the rename is absorbed at the
 * STORAGE BOUNDARY. `FileStorage.readTask` is the single deserialization path
 * for tasks, so mapping it there is what makes every consumer downstream —
 * `isClusterTask`, the driver contract injection, the restart, the fix-round
 * budget, the progress derivation — see one spelling and need no alias of its
 * own.
 *
 * WHAT HAPPENS TO THE FILE, stated because two review rounds went on getting it
 * wrong. The alias sets no `needsWrite`, so reading a legacy task never dirties
 * it by itself — but it does NOT survive a write. `readTask` is the first step
 * of every mutator, and `updateTaskStatus`, `updateTaskMetadata`,
 * `updateTaskGoal` and their siblings re-serialise the object it returns, so
 * the first status change (or watermark write, or fix-round increment) persists
 * `cluster`. For a task anything is actually driving, that is within a tick.
 *
 * That is accepted, not defended: the migration is idempotent, nothing
 * downstream of storage compares against `loop`, and downgrading a live project
 * to a binary whose VALID_TASK_TYPES predates `cluster` is not a path lazy
 * supports. The three cases below pin exactly that — read-only leaves the bytes
 * alone, a mutator rewrites them, and a file already being migrated for other
 * reasons carries the new name along with the rest. Do not restore a "never
 * rewritten" claim to this file or to `readTask`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { isClusterTask } from '../../src/types';
import { typeConstraintsSection } from '../../src/task/type-constraints';

let root: string;
let storage: FileStorage;

/** Write a task.json by hand, exactly as a pre-rename lazy left it. */
function writeStoredTask(id: string, type: string): string {
  const dir = join(root, '.lazy', 'tasks', id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task.json');
  writeFileSync(path, JSON.stringify({
    id,
    code: `stored-${type}`,
    goal: 'Drive the review fixes',
    prompt: 'Run the children',
    type,
    status: 'blocked',
    created_at: 1_700_000_000_000,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  }, null, 2));
  return path;
}

/**
 * A task.json as a REAL pre-rename lazy left it: no `target`, a
 * `parent_task_id`, a boolean `pending_sync`, and the dead metadata target key.
 * Every one of those sets `needsWrite`, so `readTask` rewrites this file — which
 * is the only condition under which the type alias could leak onto disk.
 */
function writeUnnormalizedStoredTask(id: string, type: string): string {
  const dir = join(root, '.lazy', 'tasks', id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task.json');
  writeFileSync(path, JSON.stringify({
    id,
    code: `unnormalized-${type}`,
    goal: 'Drive the review fixes',
    prompt: 'Run the children',
    type,
    status: 'blocked',
    created_at: 1_700_000_000_000,
    completed_at: null,
    parent_task_id: '99999999999999999999999999999999',
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: { remote_target_branch: 'main' },
    pending_sync: true,
  }, null, 2));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-loop-'));
  mkdirSync(join(root, '.lazy', 'tasks'), { recursive: true });
  storage = new FileStorage(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the legacy `loop` task type', () => {
  test('is read as `cluster`, and every consumer sees only that', async () => {
    writeStoredTask('11111111111111111111111111111111', 'loop');

    const task = await storage.getTask('11111111111111111111111111111111');
    expect(task).not.toBeNull();
    expect(task!.type).toBe('cluster');

    // The two things the type actually decides.
    expect(isClusterTask(task!)).toBe(true);
    expect(typeConstraintsSection(task!)).toContain('cluster task');
  });

  // INVARIANT: the alias sets no `needsWrite`, so a READ on a file that needs
  // nothing else migrated leaves it byte-identical. This is the whole of the
  // guarantee — it is about the alias not dirtying files on its own, NOT about
  // the stored value being protected. See the mutator case below.
  test('a read that migrates nothing else leaves the file byte-identical', async () => {
    const path = writeStoredTask('22222222222222222222222222222222', 'loop');
    const before = readFileSync(path, 'utf-8');

    const task = await storage.getTask('22222222222222222222222222222222');
    expect(task!.type).toBe('cluster');

    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(JSON.parse(readFileSync(path, 'utf-8')).type).toBe('loop');
  });

  // INVARIANT: and the FIRST write persists `cluster`. Every mutator reads
  // through `readTask` and re-serialises what it returns, so the stored value
  // does not survive contact with a status change — which for a task anything
  // is driving happens within a tick. Accepted deliberately: the migration is
  // idempotent and a downgrade below `cluster` is unsupported. This case exists
  // because the opposite was asserted for two review rounds.
  test('the first mutator persists `cluster` to the file', async () => {
    const path = writeStoredTask('66666666666666666666666666666666', 'loop');
    expect(JSON.parse(readFileSync(path, 'utf-8')).type).toBe('loop');

    await storage.updateTaskStatus('66666666666666666666666666666666', 'working');

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.status).toBe('working');
    expect(onDisk.type).toBe('cluster');
  });

  // INVARIANT: a file already being migrated for OTHER reasons carries the new
  // name along with the rest, in the same write. Nothing special happens to the
  // type here — it rides the `target` fold and the `parent_task_id` drop like
  // any other normalised field.
  test('a legacy file that needs migrating is rewritten as `cluster` with the rest', async () => {
    const path = writeUnnormalizedStoredTask('55555555555555555555555555555555', 'loop');

    const task = await storage.getTask('55555555555555555555555555555555');
    expect(task!.type).toBe('cluster');
    expect(isClusterTask(task!)).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    // The other migrations DID run and were persisted — otherwise this case
    // would be asserting nothing about the interaction.
    expect(onDisk.target).toEqual({ kind: 'task', parentTaskId: '99999999999999999999999999999999' });
    expect('parent_task_id' in onDisk).toBe(false);
    expect(onDisk.pending_sync).toBe(1);
    expect(onDisk.type).toBe('cluster');
  });

  test('a task stored as `cluster` is unchanged by the alias', async () => {
    writeStoredTask('33333333333333333333333333333333', 'cluster');
    const task = await storage.getTask('33333333333333333333333333333333');
    expect(task!.type).toBe('cluster');
    expect(isClusterTask(task!)).toBe(true);
  });

  test('no other type is touched', async () => {
    writeStoredTask('44444444444444444444444444444444', 'fix');
    const task = await storage.getTask('44444444444444444444444444444444');
    expect(task!.type).toBe('fix');
    expect(isClusterTask(task!)).toBe(false);
    expect(typeConstraintsSection(task!)).toBe('');
  });
});
