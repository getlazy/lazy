/**
 * INVARIANT: attribution already in the store survives the rename off
 * `actor_user_id`. A value that IS an email is carried into `actor_email` on
 * every attributed row shape — turns, comments, status changes, tag events,
 * raised items and their comments, region sign-offs — and a value that is NOT
 * (a control plane's `user-12`) is CLEARED rather than carried into a field
 * that promises an address, with the count and the ids themselves reported.
 *
 * Silently dropping attribution is the one thing this migration must not do:
 * the count is what tells an operator that rows they thought named somebody now
 * name nobody, and the ids are what lets them map those people by hand if they
 * ran their control plane's rewrite too late.
 *
 * See docs/design/actor-identity-and-remote-clients.md §3.8.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { Task } from '../../src/types';

describe('actor_user_id → actor_email migration', () => {
  let testDir: string;
  let storePath: string;
  let storage: Storage;
  let task: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-actor-migrate-'));
    storePath = join(testDir, 'store');
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external', externalPath: storePath });
    task = await storage.createTask('Test task', undefined, undefined, 'test-task');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  const taskDir = () => join(storePath, 'tasks', task.id);
  const seed = (file: string, data: unknown) =>
    writeFileSync(join(taskDir(), file), JSON.stringify(data, null, 2));
  const read = <T>(file: string): T =>
    JSON.parse(readFileSync(join(taskDir(), file), 'utf-8')) as T;

  test('an email under the legacy key is carried onto every row shape', async () => {
    seed('turns.json', {
      turns: [{ id: 't1', actor: 'human', actor_user_id: 'ada@example.com', content: 'hi' }],
    });
    seed('comments.json', {
      comments: [{ id: 'c1', actor: 'human', actor_user_id: 'ada@example.com', content: 'hi' }],
    });
    seed('status-changelog.json', {
      changes: [{ status: 'working', timestamp: 1, actor: 'human', actor_user_id: 'ada@example.com' }],
    });
    seed('tag-history.json', {
      events: [{ tag: 'x', action: 'tag', timestamp: 1, actor: 'human', actor_user_id: 'ada@example.com' }],
    });
    seed('raised-items.json', {
      raised_items: [{
        id: 'r1',
        task_id: task.id,
        content: 'q',
        blocking: true,
        created_at: 1,
        status: 'resolved',
        resolved_by: 'human',
        resolved_by_user_id: 'ada@example.com',
        unresolved_by_user_id: 'grace@example.com',
        flagged_by_user_id: 'ada@example.com',
        comments: [{ id: 'rc1', content: 'fixed', created_at: 2, actor: 'agent', actor_user_id: 'ada@example.com' }],
      }],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.cleared).toBe(0);
    expect(result.carried).toBe(8);
    expect(result.files_rewritten).toBe(5);
    expect(result.failures).toEqual([]);

    const turn = read<any>('turns.json').turns[0];
    expect(turn.actor_email).toBe('ada@example.com');
    expect(turn.actor_user_id).toBeUndefined();
    expect(turn.actor).toBe('human');
    expect(read<any>('comments.json').comments[0].actor_email).toBe('ada@example.com');
    expect(read<any>('status-changelog.json').changes[0].actor_email).toBe('ada@example.com');
    expect(read<any>('tag-history.json').events[0].actor_email).toBe('ada@example.com');

    const item = read<any>('raised-items.json').raised_items[0];
    expect(item.resolved_by_email).toBe('ada@example.com');
    expect(item.unresolved_by_email).toBe('grace@example.com');
    expect(item.flagged_by_email).toBe('ada@example.com');
    expect(item.resolved_by_user_id).toBeUndefined();
    expect(item.comments[0].actor_email).toBe('ada@example.com');
    // The ROLE is untouched: it answers a different question and always did.
    expect(item.resolved_by).toBe('human');
  });

  test('a control plane id is cleared, counted, and named in the result', async () => {
    seed('turns.json', {
      turns: [
        { id: 't1', actor: 'human', actor_user_id: 'user-12' },
        { id: 't2', actor: 'human', actor_user_id: 'user-7' },
        { id: 't3', actor: 'human', actor_user_id: 'user-12' },
      ],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.cleared).toBe(3);
    expect(result.carried).toBe(0);
    // Distinct, so a report names people rather than repeating one id per row.
    expect(result.cleared_ids.sort()).toEqual(['user-12', 'user-7']);
    expect(result.cleared_ids_truncated).toBe(false);

    const turns = read<any>('turns.json').turns;
    for (const turn of turns) {
      expect(turn.actor_user_id).toBeUndefined();
      expect(turn.actor_email).toBeUndefined();
      // A row that names nobody reads exactly as a pre-identity row does.
      expect(turn.actor).toBe('human');
    }
  });

  // INVARIANT: a region overlay's attribution is PER FIELD — who named the
  // owner and who signed off are two different people — so EVERY actor key is
  // migrated. `owner_set_by` was missed once: its rows were neither carried nor
  // cleared nor counted, which is the silent loss this migration exists to
  // prevent, dressed up as a passing test suite.
  test('both of an overlay\'s actor fields are migrated, not just the sign-off', async () => {
    seed('region-overlays.json', {
      overlays: [{
        unit_id: 'u1',
        owner_set_by: { user_id: 'ada@example.com' },
        signed_off_by: { user_id: 'user-12' },
      }],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.carried).toBe(1);
    expect(result.cleared).toBe(1);
    expect(result.cleared_ids).toEqual(['user-12']);

    const overlay = read<any>('region-overlays.json').overlays[0];
    expect(overlay.owner_set_by).toEqual({ email: 'ada@example.com' });
    expect(overlay.signed_off_by).toBeUndefined();
  });

  test('a region sign-off carries the whole actor across, or loses it whole', async () => {
    seed('region-overlays.json', {
      overlays: [
        { unit_id: 'u1', signed_off_by: { user_id: 'ada@example.com', label: 'Ada Lovelace' } },
        // Lazy Teams minted the label AS the email; a name identical to the
        // address is noise, not a display name.
        { unit_id: 'u2', signed_off_by: { user_id: 'grace@example.com', label: 'grace@example.com' } },
        { unit_id: 'u3', signed_off_by: { user_id: 'user-12', label: 'ada@example.com' } },
      ],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.carried).toBe(2);
    expect(result.cleared).toBe(1);
    expect(result.cleared_ids).toEqual(['user-12']);

    const overlays = read<any>('region-overlays.json').overlays;
    expect(overlays[0].signed_off_by).toEqual({ email: 'ada@example.com', name: 'Ada Lovelace' });
    expect(overlays[1].signed_off_by).toEqual({ email: 'grace@example.com' });
    // INVARIANT: the whole sign-off actor goes when the durable half cannot be
    // read as a person. A name alone names nobody reachable, and keeping the
    // label would render a person the store cannot identify — the label was a
    // token's free text, not a claim about who acted.
    expect(overlays[2].signed_off_by).toBeUndefined();
    expect(overlays[2].unit_id).toBe('u3');
  });

  test('a second run rewrites nothing and reports zeroes', async () => {
    seed('turns.json', {
      turns: [
        { id: 't1', actor: 'human', actor_user_id: 'ada@example.com' },
        { id: 't2', actor: 'human', actor_user_id: 'user-12' },
      ],
    });

    const first = await storage.migrateActorIdentity();
    expect(first.files_rewritten).toBe(1);

    const second = await storage.migrateActorIdentity();
    expect(second.files_rewritten).toBe(0);
    expect(second.carried).toBe(0);
    expect(second.cleared).toBe(0);
    expect(second.cleared_ids).toEqual([]);
    expect(read<any>('turns.json').turns[0].actor_email).toBe('ada@example.com');
  });

  test('a row already naming a person keeps it; a blank legacy id costs nothing', async () => {
    seed('comments.json', {
      comments: [
        // A newer write already named the person — a stale legacy id must not
        // overwrite it, and clearing is not "losing" anything here.
        { id: 'c1', actor: 'human', actor_email: 'new@example.com', actor_user_id: 'user-12' },
        // An empty legacy value named nobody to begin with, so nothing is lost
        // and nothing is reported.
        { id: 'c2', actor: 'human', actor_user_id: '   ' },
      ],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.cleared).toBe(0);
    expect(result.carried).toBe(0);
    expect(result.files_rewritten).toBe(1);

    const comments = read<any>('comments.json').comments;
    expect(comments[0].actor_email).toBe('new@example.com');
    expect(comments[0].actor_user_id).toBeUndefined();
    expect(comments[1].actor_email).toBeUndefined();
    expect(comments[1].actor_user_id).toBeUndefined();
  });

  // INVARIANT: the migration CONVERGES — it judges the value under the CURRENT
  // key too, not only under the legacy one. §3.8 says it clears any value it
  // cannot interpret as an email and says nothing about which key that value is
  // under, and until the mint takes an (email, name) pair by name the daemon
  // keeps stamping a token's id straight into `actor_email`. A legacy-key-only
  // migration would be a one-shot against a producer that is still running.
  test('a control plane id under the NEW key is cleared too, on any later run', async () => {
    seed('turns.json', {
      turns: [
        { id: 't1', actor: 'human', actor_email: 'user-12' },
        { id: 't2', actor: 'human', actor_email: 'ada@example.com' },
      ],
    });
    seed('raised-items.json', {
      raised_items: [{ id: 'r1', status: 'resolved', resolved_by: 'human', resolved_by_email: 'user-7' }],
    });
    seed('region-overlays.json', {
      overlays: [{ unit_id: 'u1', signed_off_by: { email: 'user-12' } }],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.cleared).toBe(3);
    expect(result.cleared_ids.sort()).toEqual(['user-12', 'user-7']);
    expect(read<any>('turns.json').turns[0].actor_email).toBeUndefined();
    expect(read<any>('turns.json').turns[0].actor).toBe('human');
    expect(read<any>('turns.json').turns[1].actor_email).toBe('ada@example.com');
    expect(read<any>('raised-items.json').raised_items[0].resolved_by_email).toBeUndefined();
    expect(read<any>('region-overlays.json').overlays[0].signed_off_by).toBeUndefined();

    // Still converged, and now quiet.
    const second = await storage.migrateActorIdentity();
    expect(second.files_rewritten).toBe(0);
    expect(second.cleared).toBe(0);
  });

  test('both spellings of one lost id count as one lost attribution', async () => {
    seed('comments.json', {
      comments: [{ id: 'c1', actor: 'human', actor_user_id: 'user-12', actor_email: 'user-12' }],
    });

    const result = await storage.migrateActorIdentity();

    expect(result.cleared).toBe(1);
    expect(result.cleared_ids).toEqual(['user-12']);
    const comment = read<any>('comments.json').comments[0];
    expect(comment.actor_user_id).toBeUndefined();
    expect(comment.actor_email).toBeUndefined();
  });

  // A `.DS_Store` beside the task directories opens as ENOTDIR, not ENOENT. A
  // loop that only forgives ENOENT reported it as six failures on every daemon
  // start, forever, with no retry able to converge — and a warning that fires
  // regardless of state teaches an operator to skim past the ones that matter.
  test('a stray file in the tasks directory is not a failure', async () => {
    writeFileSync(join(storePath, 'tasks', '.DS_Store'), 'not a task');
    seed('turns.json', { turns: [{ id: 't1', actor: 'human', actor_user_id: 'ada@example.com' }] });

    const result = await storage.migrateActorIdentity();

    expect(result.failures).toEqual([]);
    expect(result.carried).toBe(1);
    // Nor is it counted as a task that was looked at.
    expect(result.tasks_scanned).toBe(1);
  });

  test('an unreadable file is reported, not skipped in silence', async () => {
    writeFileSync(join(taskDir(), 'comments.json'), '{ this is not json');
    seed('turns.json', { turns: [{ id: 't1', actor: 'human', actor_user_id: 'ada@example.com' }] });

    const result = await storage.migrateActorIdentity();

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.file).toBe('comments.json');
    expect(result.failures[0]!.task_id).toBe(task.id);
    // The other files of the same task are still migrated: partial progress
    // beats an all-or-nothing rollback when the alternative is stalled rows.
    expect(read<any>('turns.json').turns[0].actor_email).toBe('ada@example.com');
  });

  test('a store with nothing to migrate reports zeroes', async () => {
    const result = await storage.migrateActorIdentity();
    expect(result.files_rewritten).toBe(0);
    expect(result.carried).toBe(0);
    expect(result.cleared).toBe(0);
    expect(result.tasks_scanned).toBeGreaterThan(0);
  });
});
