/**
 * Unit tests: WHO decided a raised item.
 *
 * A raised-item decision is the one review act that gates a merge, so the
 * record has to name the person who made it, not just the channel it came
 * through. The role alone (`human`) is all a row with nobody behind it can
 * say; an attributed caller additionally carries git's `(email, name)` pair,
 * which the daemon pins onto the call and the store writes as
 * `resolved_by_email` / `resolved_by_name`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { attributionLabel } from '../../src/actor-ref';
import type { RaisedItem, Task } from '../../src/types';

describe('raised-item decision attribution', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let task: Task;
  let item: RaisedItem;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-rda-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-rda-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    task = await storage.createTask('Raised decision attribution');
    item = await storage.createRaisedItem(task.id, {
      content: 'Should the new flag default on?',
      blocking: true,
    });
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('a per-user actor records both the role and the person', async () => {
    const resolved = await storage.resolveRaisedItem(task.id, item.id, {
      action: 'respond',
      actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
      response: 'Default it off.',
    });
    expect(resolved.resolved_by).toBe('human');
    expect(resolved.resolved_by_email).toBe('ada@example.com');
    expect(resolved.resolved_by_name).toBe('Ada Lovelace');
  });

  // INVARIANT: an unset optional key is ABSENT, never present-and-undefined —
  // FileStorage row shapes are compared key-for-key against other backends.
  test('a bare role leaves the person key off the record entirely', async () => {
    const resolved = await storage.resolveRaisedItem(task.id, item.id, {
      action: 'acknowledge',
      actor: 'human',
    });
    expect(resolved.resolved_by).toBe('human');
    expect('resolved_by_email' in resolved).toBe(false);
    expect('resolved_by_name' in resolved).toBe(false);
  });

  // INVARIANT: a new decision never inherits the previous decider. Resolutions
  // are overwritable until the comment is delivered, and a second decision made
  // by an unattributed caller must not keep reading as the first person's.
  test('re-deciding without an actor drops the previous person', async () => {
    await storage.resolveRaisedItem(task.id, item.id, {
      action: 'respond',
      actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
      response: 'Default it off.',
    });
    const redone = await storage.resolveRaisedItem(task.id, item.id, {
      action: 'dismiss',
      actor: 'human',
      response: 'Not pursuing.',
    });
    expect(redone.resolved_by_email).toBeUndefined();
    expect(redone.resolved_by_name).toBeUndefined();
  });

  // INVARIANT: the same rule for a row written BEFORE the store named people by
  // email. Deleting only today's keys left the pre-identity `*_user_id` on the
  // record, so a decision by an unattributed caller still read as the previous
  // person's — the exact inheritance the deletes above exist to prevent. The
  // stored values are a migration's problem; writing one back out is this
  // code's.
  test('re-deciding drops a pre-identity person left on the record', async () => {
    const path = join(basePath, 'tasks', task.id, 'raised-items.json');
    const withLegacy = JSON.parse(await readFile(path, 'utf-8')) as {
      raised_items: Array<Record<string, unknown>>;
    };
    withLegacy.raised_items[0]!.status = 'dismissed';
    withLegacy.raised_items[0]!.resolved_by = 'human';
    withLegacy.raised_items[0]!.resolved_by_user_id = 'user-7';
    withLegacy.raised_items[0]!.unresolved_by_user_id = 'user-9';
    await writeFile(path, JSON.stringify(withLegacy));

    const redone = await storage.resolveRaisedItem(task.id, item.id, {
      action: 'dismiss',
      actor: 'human',
      response: 'Still not pursuing.',
    });
    expect('resolved_by_user_id' in redone).toBe(false);
    expect('unresolved_by_user_id' in redone).toBe(false);

    // And the same on the promote path, which rebuilds the record the same way.
    const other = await storage.createRaisedItem(task.id, {
      content: 'Another decision',
      blocking: true,
    });
    const again = JSON.parse(await readFile(path, 'utf-8')) as {
      raised_items: Array<Record<string, unknown>>;
    };
    const target = again.raised_items.find(r => r.id === other.id)!;
    target.resolved_by_user_id = 'user-7';
    await writeFile(path, JSON.stringify(again));

    const { raised_item } = await storage.promoteRaisedItem(task.id, other.id, {
      relation: 'peer',
      actor: 'human',
    });
    expect('resolved_by_user_id' in raised_item).toBe(false);
  });

  // Same rule, the independently attributed field: a re-flag by an
  // unattributed caller must not keep reading as the previous flagger.
  test('re-flagging drops a pre-identity flagger left on the record', async () => {
    const path = join(basePath, 'tasks', task.id, 'raised-items.json');
    const withLegacy = JSON.parse(await readFile(path, 'utf-8')) as {
      raised_items: Array<Record<string, unknown>>;
    };
    withLegacy.raised_items[0]!.flagged_by_user_id = 'user-7';
    await writeFile(path, JSON.stringify(withLegacy));

    const flipped = await storage.setRaisedItemBlocking(task.id, item.id, false, 'builder');
    expect('flagged_by_user_id' in flipped).toBe(false);
  });

  test('undo records who reopened the item, and the next decision clears it', async () => {
    await storage.resolveRaisedItem(task.id, item.id, {
      action: 'dismiss',
      actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
      response: 'Not pursuing.',
    });
    const reopened = await storage.unresolveRaisedItem(task.id, item.id, {
      role: 'human',
      email: 'grace@example.com',
      name: 'Grace Hopper',
    });
    expect(reopened.status).toBe('open');
    expect(reopened.unresolved_by).toBe('human');
    expect(reopened.unresolved_by_email).toBe('grace@example.com');
    expect(reopened.unresolved_by_name).toBe('Grace Hopper');
    // The undone resolution leaves no trace, as it always has.
    expect(reopened.resolved_by).toBeUndefined();
    expect(reopened.resolved_by_email).toBeUndefined();
    expect(reopened.resolved_by_name).toBeUndefined();

    const decidedAgain = await storage.resolveRaisedItem(task.id, item.id, {
      action: 'acknowledge',
      actor: { role: 'human', email: 'grace@example.com', name: 'Grace Hopper' },
    });
    expect(decidedAgain.unresolved_by).toBeUndefined();
    expect(decidedAgain.unresolved_by_email).toBeUndefined();
    expect(decidedAgain.unresolved_by_name).toBeUndefined();
  });

  test('flipping the gate records who overrode the agent', async () => {
    const flipped = await storage.setRaisedItemBlocking(task.id, item.id, false, {
      role: 'human',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
    expect(flipped.flagged_by).toBe('human');
    expect(flipped.flagged_by_email).toBe('ada@example.com');
    expect(flipped.flagged_by_name).toBe('Ada Lovelace');

    const flippedBack = await storage.setRaisedItemBlocking(task.id, item.id, true, 'builder');
    expect(flippedBack.flagged_by).toBe('builder');
    expect('flagged_by_email' in flippedBack).toBe(false);
    expect('flagged_by_name' in flippedBack).toBe(false);
  });

  test('promotion is a decision too, and names its promoter', async () => {
    const { raised_item } = await storage.promoteRaisedItem(task.id, item.id, {
      relation: 'peer',
      actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
    });
    expect(raised_item.status).toBe('promoted_peer');
    expect(raised_item.resolved_by).toBe('human');
    expect(raised_item.resolved_by_email).toBe('ada@example.com');
    expect(raised_item.resolved_by_name).toBe('Ada Lovelace');
  });
});

describe('attributionLabel', () => {
  // INVARIANT: a person is spelled as git spells them, `name <email>`. One
  // rendering for every surface, and the same one a reader already knows from
  // `git log`.
  test('names the person as git does when the store knew both halves', () => {
    expect(attributionLabel('human', 'ada@example.com', 'Ada Lovelace'))
      .toBe('Ada Lovelace <ada@example.com>');
  });

  test('an email with no name is the email alone', () => {
    expect(attributionLabel('human', 'ada@example.com')).toBe('ada@example.com');
    expect(attributionLabel('human', 'ada@example.com', null)).toBe('ada@example.com');
  });

  // INVARIANT: a row with neither half renders exactly as a pre-identity row
  // does — the bare role, not an empty parenthetical and not an invented name.
  test('a role with no person reads as the bare role', () => {
    expect(attributionLabel('human', null)).toBe('human');
    expect(attributionLabel('human')).toBe('human');
    expect(attributionLabel('human', '', '')).toBe('human');
    // A name with no email names nobody reachable, so it is not a person.
    expect(attributionLabel('human', null, 'Ada Lovelace')).toBe('human');
  });

  test('nothing known renders as nothing at all, so callers can drop the phrase', () => {
    expect(attributionLabel(null, null)).toBe('');
    expect(attributionLabel(undefined)).toBe('');
    expect(attributionLabel(null, null, 'Ada Lovelace')).toBe('');
  });
});
