/**
 * INVARIANT: a daemon starting over a store written before the rename migrates
 * the attribution in it, and SAYS what it could not keep. An id no install can
 * read as a person is cleared — the row keeps its actor role and names nobody —
 * and the count plus the ids themselves land in the daemon log. Silently
 * dropping attribution is the failure this exists to prevent: the operator who
 * has not yet run their control plane's rewrite would otherwise learn about it
 * only by noticing rows that stopped naming anyone.
 *
 * Driven end to end through a real daemon: the migration must run on start,
 * before any surface answers, and must be reported by the daemon itself — not
 * by a function a test can call directly.
 *
 * See docs/design/actor-identity-and-remote-clients.md §3.8.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { taskFilePath } from '../helpers/storage';
import { getDaemonDir } from '../../src/daemon';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('actor identity migration on daemon start', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('seeded user-<id> rows are cleared, counted and reported', async () => {
    const taskId = await createTask(ctx, 'Attributed before the rename', 'Do the thing');

    // The daemon must not be writing the same files while they are seeded, and
    // the migration only runs at start — so take it down, write the store as a
    // pre-rename daemon left it, and bring it back up.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);

    const logPath = join(getDaemonDir(ctx.root), 'daemon.log');
    const before = (() => { try { return readFileSync(logPath, 'utf-8'); } catch { return ''; } })();

    writeFileSync(taskFilePath(ctx.root, taskId, 'comments.json'), JSON.stringify({
      comments: [
        { id: 'c1', task_id: taskId, content: 'from a person', created_at: 1, actor: 'human', actor_user_id: 'ada@example.com' },
        { id: 'c2', task_id: taskId, content: 'from an id', created_at: 2, actor: 'human', actor_user_id: 'user-12' },
        { id: 'c3', task_id: taskId, content: 'from the same id', created_at: 3, actor: 'human', actor_user_id: 'user-12' },
      ],
    }, null, 2));

    expectSuccess(await ctx.lazy(['daemon', 'start']));
    await settle(1_500);

    const comments = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'comments.json'), 'utf-8'),
    ).comments as Array<Record<string, unknown>>;

    // The email survives the rename under the new key.
    expect(comments[0]!.actor_email).toBe('ada@example.com');
    expect(comments[0]!.actor_user_id).toBeUndefined();

    // The control plane's id does not: it would render a person who does not
    // exist in a field that promises an address.
    expect(comments[1]!.actor_email).toBeUndefined();
    expect(comments[1]!.actor_user_id).toBeUndefined();
    expect(comments[1]!.actor).toBe('human');
    expect(comments[2]!.actor_email).toBeUndefined();

    // And the daemon said so — with the count and the id, not just a silent
    // rewrite. This is the half of the migration the design calls for by name.
    const logged = readFileSync(logPath, 'utf-8').slice(before.length);
    expect(logged).toContain('2 row(s) had an actor id this install cannot resolve to a person');
    expect(logged).toContain('their attribution was cleared');
    expect(logged).toContain('user-12');

    // `lazy show` renders the migrated row as a person and the cleared one as a
    // plain role, exactly as a row written before any of this always did.
    const shown = await ctx.lazy(['show', taskId]);
    expectSuccess(shown);
    expect(shown.stdout).toContain('ada@example.com');
    expect(shown.stdout).not.toContain('user-12');
  }, 120_000);

  test('a second start migrates nothing and says nothing', async () => {
    const taskId = await createTask(ctx, 'Already migrated', 'Do the thing');

    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);
    writeFileSync(taskFilePath(ctx.root, taskId, 'comments.json'), JSON.stringify({
      comments: [
        { id: 'c1', task_id: taskId, content: 'x', created_at: 1, actor: 'human', actor_user_id: 'user-9' },
      ],
    }, null, 2));

    expectSuccess(await ctx.lazy(['daemon', 'start']));
    await settle(1_500);
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await settle(500);

    const logPath = join(getDaemonDir(ctx.root), 'daemon.log');
    const afterFirst = readFileSync(logPath, 'utf-8');
    expect(afterFirst).toContain('cannot resolve to a person');

    expectSuccess(await ctx.lazy(['daemon', 'start']));
    await settle(1_500);

    // Idempotent AND quiet: a migrated store must not re-report a loss that
    // already happened, or every start would look like a fresh incident.
    const second = readFileSync(logPath, 'utf-8').slice(afterFirst.length);
    expect(second).not.toContain('cannot resolve to a person');
    expect(second).not.toContain('Migrated stored attribution');
  }, 120_000);
});
