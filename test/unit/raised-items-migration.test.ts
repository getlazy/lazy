/**
 * INVARIANT: every follow-up that exists on disk survives the unification as a
 * NON-BLOCKING raised item, keeping its id, its text, its structured proposal
 * fields and its triage state. There is a large stock of open follow-ups in real
 * stores; losing one, or mis-flagging one as blocking (which would silently start
 * gating accepts), is the failure this migration exists to prevent.
 *
 * The migration is also idempotent (a second run converts nothing) and LOUD: a
 * record it cannot convert is reported, its task's follow-ups.json is left in
 * place for the next daemon start, and the convertible records from that same
 * file are still written — partial progress beats an all-or-nothing rollback
 * when the alternative is a dropped open item.
 *
 * See docs/design/raised-items-unified.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { raisedItemFromFollowUp, FollowUpConversionError, repairStoredRaisedItem } from '../../src/raised/migrate';
import type { RaisedItem, Task } from '../../src/types';

/** One legacy follow-up record, exactly as FileStorage used to write them. */
type LegacyRecord = Record<string, unknown>;

describe('follow-up → raised-item migration', () => {
  let testDir: string;
  let storePath: string;
  let storage: Storage;
  let task: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-raised-migrate-'));
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
  const legacyPath = () => join(taskDir(), 'follow-ups.json');
  const retiredPath = () => join(taskDir(), 'follow-ups.migrated.json');

  function seedLegacy(records: LegacyRecord[]): void {
    writeFileSync(legacyPath(), JSON.stringify({ follow_ups: records }, null, 2));
  }

  function legacy(over: LegacyRecord = {}): LegacyRecord {
    return {
      id: `fu-${Math.random().toString(36).slice(2, 10)}`,
      task_id: task.id,
      content: 'The retry path in foo.ts swallows errors.',
      created_at: 1_700_000_000_000,
      triage_status: 'open',
      ...over,
    };
  }

  test('an open follow-up becomes an open NON-BLOCKING raised item, id and text intact', async () => {
    const record = legacy({ id: 'fu-open', content: 'Retries swallow errors.' });
    seedLegacy([record]);

    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result.converted).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.tasks_retired).toBe(1);

    const items = await storage.getTaskRaisedItems(task.id);
    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.id).toBe('fu-open');            // links, search hits and Teams refs resolve through it
    expect(item.content).toBe('Retries swallow errors.');
    expect(item.blocking).toBe(false);          // a follow-up never gated, and must not start now
    expect(item.status).toBe('open');
    expect(item.created_at).toBe(1_700_000_000_000);
    expect(item.migrated_from).toBe('follow_up');
  });

  test('every triage state and its resolution text survive', async () => {
    seedLegacy([
      legacy({ id: 'fu-open', triage_status: 'open' }),
      legacy({
        id: 'fu-ack', triage_status: 'acknowledged', triage_note: 'noted, later',
        triaged_at: 1_700_000_500_000, triaged_by: 'human',
      }),
      legacy({
        id: 'fu-dismissed', triage_status: 'dismissed', triage_note: 'already fixed',
        triaged_at: 1_700_000_600_000, triaged_by: 'builder',
      }),
      legacy({
        id: 'fu-promoted', triage_status: 'promoted', triaged_at: 1_700_000_700_000,
        triaged_by: 'human', promoted_task_id: 'task-abc', promoted_task_code: 'fix-retries',
      }),
    ]);

    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result.converted).toBe(4);
    expect(result.failures).toEqual([]);

    const byId = new Map((await storage.getTaskRaisedItems(task.id)).map((i) => [i.id, i]));
    expect(byId.size).toBe(4);
    expect(byId.get('fu-open')!.status).toBe('open');

    const ack = byId.get('fu-ack')!;
    expect(ack.status).toBe('acknowledged');
    expect(ack.resolution).toBe('noted, later');
    expect(ack.resolved_at).toBe(1_700_000_500_000);
    expect(ack.resolved_by).toBe('human');

    expect(byId.get('fu-dismissed')!.status).toBe('dismissed');
    expect(byId.get('fu-dismissed')!.resolution).toBe('already fixed');

    // A follow-up promotion always created a task under the ORIGINATING task's
    // parent, which is a PEER in the unified vocabulary — never a subtask.
    const promoted = byId.get('fu-promoted')!;
    expect(promoted.status).toBe('promoted_peer');
    expect(promoted.promoted_task_id).toBe('task-abc');
    expect(promoted.promoted_task_code).toBe('fix-retries');

    // INVARIANT: none of them gates an accept.
    for (const item of byId.values()) expect(item.blocking).toBe(false);
  });

  test('structured proposal fields carry over so a promotion still has its payload', async () => {
    seedLegacy([legacy({
      id: 'fu-proposal',
      title: 'Retries stay silent when the server is down',
      explanation: 'An operator sees a green run that did nothing.',
      proposed_code: 'fix-silent-retries',
      proposed_prompt: 'Make a failed retry visible in the run output.',
      content: 'Retries stay silent when the server is down',
    })]);

    await storage.migrateFollowUpsToRaisedItems();

    const item = (await storage.getTaskRaisedItems(task.id))[0]!;
    expect(item.title).toBe('Retries stay silent when the server is down');
    expect(item.explanation).toBe('An operator sees a green run that did nothing.');
    expect(item.proposed_code).toBe('fix-silent-retries');
    expect(item.proposed_prompt).toBe('Make a failed retry visible in the run output.');
  });

  // INVARIANT: triage never scheduled a comment to the agent, so a converted
  // resolution must not acquire one — that would post to the agent long after
  // the human wrote the note.
  test('a converted resolution never schedules a comment to the agent', async () => {
    seedLegacy([legacy({ id: 'fu-ack', triage_status: 'acknowledged', triage_note: 'noted' })]);
    await storage.migrateFollowUpsToRaisedItems();
    const item = (await storage.getTaskRaisedItems(task.id))[0]!;
    expect(item.pending_comment).toBeUndefined();
    expect(item.comment_delivered_at).toBeUndefined();
  });

  test('the source file is retired by rename, never deleted', async () => {
    seedLegacy([legacy({ id: 'fu-1' })]);
    await storage.migrateFollowUpsToRaisedItems();

    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(retiredPath())).toBe(true);
    expect(JSON.parse(readFileSync(retiredPath(), 'utf-8')).follow_ups[0].id).toBe('fu-1');
  });

  test('running twice converts nothing the second time and duplicates no item', async () => {
    seedLegacy([legacy({ id: 'fu-1' }), legacy({ id: 'fu-2' })]);
    expect((await storage.migrateFollowUpsToRaisedItems()).converted).toBe(2);

    const second = await storage.migrateFollowUpsToRaisedItems();
    expect(second.converted).toBe(0);
    expect(second.tasks_scanned).toBe(0);   // the retired file is not seen at all
    expect(second.failures).toEqual([]);
    expect((await storage.getTaskRaisedItems(task.id)).length).toBe(2);
  });

  test('a run interrupted after writing but before retiring converges', async () => {
    // Simulate the crash window: the item is already in raised-items.json while
    // the legacy file is still there.
    seedLegacy([legacy({ id: 'fu-1' }), legacy({ id: 'fu-2' })]);
    await storage.createRaisedItem(task.id, {
      content: 'The retry path in foo.ts swallows errors.', blocking: false,
    });
    const preexisting = (await storage.getTaskRaisedItems(task.id))[0]!.id;
    const halfWritten = JSON.parse(readFileSync(join(taskDir(), 'raised-items.json'), 'utf-8')) as {
      raised_items: RaisedItem[];
    };
    halfWritten.raised_items.push(raisedItemFromFollowUp(
      { id: 'fu-1', task_id: task.id, content: 'x', created_at: 1, triage_status: 'open' } as never,
      task.id,
    ));
    writeFileSync(join(taskDir(), 'raised-items.json'), JSON.stringify(halfWritten, null, 2));

    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result.already_migrated).toBe(1);   // fu-1 was already there
    expect(result.converted).toBe(1);          // fu-2 was not
    expect(result.failures).toEqual([]);

    const ids = (await storage.getTaskRaisedItems(task.id)).map((i) => i.id).sort();
    expect(ids).toEqual([preexisting, 'fu-1', 'fu-2'].sort());
  });

  // INVARIANT: loud, and never lossy. The convertible records land; the broken
  // one is named; the source file stays for the next daemon start.
  test('an unconvertible record is reported and its file is kept, while its siblings convert', async () => {
    seedLegacy([
      legacy({ id: 'fu-good' }),
      legacy({ id: 'fu-bad', triage_status: 'something-else' }),
    ]);

    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result.converted).toBe(1);
    expect(result.tasks_retired).toBe(0);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.follow_up_id).toBe('fu-bad');
    expect(result.failures[0]!.reason).toContain('something-else');

    expect((await storage.getTaskRaisedItems(task.id)).map((i) => i.id)).toEqual(['fu-good']);
    expect(existsSync(legacyPath())).toBe(true);   // left for the retry

    // The retry converts nothing new and keeps reporting the same record, so a
    // human sees it on every start until they deal with it.
    const retry = await storage.migrateFollowUpsToRaisedItems();
    expect(retry.converted).toBe(0);
    expect(retry.already_migrated).toBe(1);
    expect(retry.failures.length).toBe(1);
  });

  test('records the converter refuses to guess about each say why', () => {
    const cases: Array<[LegacyRecord, string]> = [
      [{ task_id: 't', content: 'x', created_at: 1 }, 'no id'],
      [{ id: 'a', task_id: 't', content: '   ', created_at: 1 }, 'neither content nor title'],
      [{ id: 'a', task_id: 't', content: 'x' }, 'no usable created_at'],
    ];
    for (const [record, expected] of cases) {
      expect(() => raisedItemFromFollowUp(record as never, 'task-1'))
        .toThrow(new RegExp(expected));
      try {
        raisedItemFromFollowUp(record as never, 'task-1');
      } catch (err) {
        expect(err).toBeInstanceOf(FollowUpConversionError);
      }
    }
  });

  test('a legacy record with only a title keeps its words as the content', () => {
    const item = raisedItemFromFollowUp(
      { id: 'a', task_id: 't', content: '', title: 'Retries stay silent', created_at: 5 } as never,
      't',
    );
    expect(item.content).toBe('Retries stay silent');
    expect(item.blocking).toBe(false);
  });

  // INVARIANT: raised-items.json only ever held accept-gating items, so a record
  // written before the flag existed reads as BLOCKING. Repairing it to
  // non-blocking would silently stop gating an accept a human is waiting on.
  test('a pre-flag raised item reads back as blocking', async () => {
    writeFileSync(join(taskDir(), 'raised-items.json'), JSON.stringify({
      raised_items: [{
        id: 'ri-old', task_id: task.id, content: 'Keep the legacy flag?',
        created_at: 1_700_000_000_000, status: 'open',
      }],
    }, null, 2));

    const items = await storage.getTaskRaisedItems(task.id);
    expect(items[0]!.blocking).toBe(true);
    expect(items[0]!.status).toBe('open');
  });

  test('read-repair normalizes a stray promoted status and a missing status', () => {
    const promoted = repairStoredRaisedItem({ status: 'promoted' } as never);
    expect(promoted.status).toBe('promoted_peer');
    expect(promoted.blocking).toBe(true);
    expect(repairStoredRaisedItem({ blocking: false } as never).status).toBe('open');
  });

  test('a task whose follow-ups.json is unreadable is reported, not skipped silently', async () => {
    writeFileSync(legacyPath(), '{ this is not json');
    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result.converted).toBe(0);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.reason).toContain('follow-ups.json');
    expect(existsSync(legacyPath())).toBe(true);
  });

  test('a store with no follow-ups anywhere is a clean no-op', async () => {
    const result = await storage.migrateFollowUpsToRaisedItems();
    expect(result).toEqual({
      tasks_scanned: 0, converted: 0, already_migrated: 0, tasks_retired: 0, failures: [],
    });
  });
});
