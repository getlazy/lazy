import { describe, expect, test } from 'bun:test';
import { createTokenStatsHandler } from '../../src/mcp/tools';

describe('lazy_token_stats handler authorization', () => {
  // INVARIANT: a task-scoped caller whose task cannot be loaded is refused, never
  // served the builder's project view. A missing task used to collapse into
  // "no narrowing", handing a stale token every task's spend detail.
  test('a task token whose task is gone fails closed', async () => {
    const storage = {
      getTask: async () => null,
      listTasks: async () => { throw new Error('project view must not be reached'); },
      resolveTask: async () => ({ task: null }),
    } as any;
    const handler = createTokenStatsHandler({
      taskId: '00000000-0000-4000-8000-000000000001',
      worktreePath: '/nonexistent',
      projectRoot: '/nonexistent',
      storage,
    } as any);
    await expect(handler({ scope: 'tokens' })).rejects.toThrow('no longer resolves to a task');
  });
});
