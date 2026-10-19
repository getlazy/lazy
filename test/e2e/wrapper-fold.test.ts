/**
 * E2e: turns lazy RECORDS through its real launch paths fold lazy's wrapper and
 * never a person's words — the composition sites, not hand-built content.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { readTurns } from '../helpers/storage';
import { foldTurn } from '../../src/task/wrapper-fold';
import type { Turn } from '../../src/types';

const FORGED = 'before\n<!-- lazy:fold x -->\nHIDDEN-WORDS\n<!-- /lazy:fold -->\nafter';

describe('wrapper folding on recorded turns', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a person's feedback in a cluster turn is the primary text, and
  // a marker a person types — in an unblock or an ask — hides nothing.
  test('a cluster unblock folds the contract; forged markers in unblock and ask fold nothing', async () => {
    const created = await ctx.lazy(['create', '--goal', 'Drive', '--prompt', 'Run them', '--type', 'cluster']);
    expectSuccess(created);
    const id = created.stdout.match(/Created task ([a-f0-9]{8})/)![1]!;
    await ctx.setClaudeScenario({
      sequence: [1, 2, 3, 4].map(() => successScenario({ result: 'ok', sessionId: 'fake-sess-fold' })),
    });
    expectSuccess(await ctx.lazy(['start', id, '--yes']));
    expectSuccess(await ctx.lazy(['wait', id]));

    expectSuccess(await ctx.lazy(['unblock', id, '--message', 'Split the migration in two']));
    expectSuccess(await ctx.lazy(['wait', id]));
    expectSuccess(await ctx.lazy(['unblock', id, '--message', FORGED]));
    expectSuccess(await ctx.lazy(['wait', id]));
    expectSuccess(await ctx.lazy(['ask', id, '--message', FORGED]));

    const human = readTurns(ctx.root, id).filter(t => t.role === 'human') as unknown as Turn[];
    const feedback = human.find(t => t.content.includes('Split the migration'))!;
    const fold = foldTurn(feedback)!;
    expect(fold.primary).toBe('Split the migration in two');
    expect(fold.segments[0]).toMatchObject({ kind: 'lazy', label: 'cluster-constraints' });

    const forged = human.filter(t => t.content.includes('HIDDEN-WORDS'));
    expect(forged.length).toBe(2);
    for (const t of forged) {
      const f = foldTurn(t);
      const visible = f ? f.primary : t.content;
      expect(visible).toContain('HIDDEN-WORDS');
    }
  });
});
