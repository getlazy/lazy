import { describe, expect, test } from 'bun:test';
import { withPromotedTaskCodes } from '../../src/task/show-sections';

describe('withPromotedTaskCodes', () => {
  // INVARIANT: a task's own raised items carry the code of the task each promotion
  // became, resolved by the daemon. Promotions made at unblock/accept once stored
  // only the id, and every task page rendered "→ task".
  test('fills a missing code from the promoted task', async () => {
    const items: Array<{ id: string; promoted_task_id?: string; promoted_task_code?: string }> = [
      { id: 'a', promoted_task_id: 't1' },
      { id: 'b', promoted_task_id: 't2', promoted_task_code: 'kept' },
      { id: 'c' },
    ];
    const out = await withPromotedTaskCodes(items, async (id) => (id === 't1' ? { code: 'new-task' } : { code: 'other' }));
    expect(out.map((i) => i.promoted_task_code)).toEqual(['new-task', 'kept', undefined]);
  });

  test('leaves the item alone when the task is gone', async () => {
    const out = await withPromotedTaskCodes([{ id: 'a', promoted_task_id: 'gone' } as { id: string; promoted_task_id: string; promoted_task_code?: string }], async () => null);
    expect(out[0].promoted_task_code).toBeUndefined();
  });
});
