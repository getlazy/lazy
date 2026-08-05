/**
 * Accept must survive a history containing a content-less turn.
 *
 * Observed 2026-08-03: `lazy accept` on a task whose session contained an
 * "[Agent crashed]" / "[Recovered]" turn died with
 * "undefined is not an object (evaluating 'turn.content.trim')" — accept step
 * 4b regenerates the fidelity record before the merge, and fidelity's
 * `formatTurn` called `.trim()` on a `content` that was absent from the stored
 * record (JSON.stringify drops `undefined` keys, so the key simply is not
 * there). The task became permanently un-acceptable.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, startAndReconcile } from '../helpers/fixtures';
import { worktreePathFor, readTurns, writeTurns } from '../helpers/storage';

describe('lazy accept over a content-less turn', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: no runner exists to execute the pre-accept agent turn,
    // and this test asserts on fidelity regeneration, not on pre-accept.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a turn without content must never block an accept. Synthesis is
  // an enhancement, not a gate — records with this defect already exist in
  // users' stores, so the read paths must degrade forever, not just until the
  // write-path guard (normalizeTurnContent) stops new ones appearing.
  test('accept completes when a stored turn has no content key', async () => {
    const taskId = await createTask(ctx, 'Task with a crashed turn', 'Some work');
    await startAndReconcile(ctx, taskId);

    // Give accept something to merge.
    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    // Corrupt storage exactly the way the crash/recovery path did: append a
    // turn record with NO `content` key at all.
    const turns = readTurns(ctx.root, taskId);
    expect(turns.length).toBeGreaterThan(0);
    const last = turns[turns.length - 1]!;
    const broken = { ...last, id: `${last.id ?? 'turn'}-crashed`, sequence: (last.sequence ?? 0) + 1 };
    delete (broken as Record<string, unknown>).content;
    writeTurns(ctx.root, taskId, [...turns, broken as typeof last]);

    // Sanity: the defect is really in the store (not silently defaulted on read).
    expect(readTurns(ctx.root, taskId).some(t => !('content' in t))).toBe(true);

    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accept);
    expectOutput(accept, 'accepted');

    // And the task really did land, not merely "not crash".
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'complete');
  });

  // INVARIANT: `lazy show`/`lazy search` are read commands over the same
  // records — one defective turn must not break them either. Verified against
  // the pre-fix tree: `show --full` died on `turn.content.startsWith` and the
  // boolean search on `haystack.toLowerCase`.
  test('show and search tolerate a content-less turn', async () => {
    const taskId = await createTask(ctx, 'Searchable crashed task', 'Some work');
    await startAndReconcile(ctx, taskId);

    const turns = readTurns(ctx.root, taskId);
    const last = turns[turns.length - 1]!;
    const broken = { ...last, id: `${last.id ?? 'turn'}-crashed`, sequence: (last.sequence ?? 0) + 1 };
    delete (broken as Record<string, unknown>).content;
    writeTurns(ctx.root, taskId, [...turns, broken as typeof last]);

    // --full renders every turn body, which is the path that would crash.
    const show = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(show);

    // Boolean query — the shape that crashed with
    // "undefined is not an object (evaluating 'haystack.toLowerCase')".
    const search = await ctx.lazy(['search', 'in:turns crashed OR status:blocked']);
    expectSuccess(search);
  });
});
