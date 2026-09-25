/**
 * The `reviewComments` RPC answers "can this discussion be promoted, and seeded
 * with what?" for every task-level thread, so a remote client (Lazy Teams)
 * renders the Promote form without re-deriving the seed rule.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { handleReviewComments, handleReviewPromoteDiscussion } from '../../src/daemon/rpc-review';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../../src/review/task-level-anchor';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('reviewComments promotions', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-promotions-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    taskId = (await (await getOrCreateStorage()).createTask('Promotions test')).id;
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  async function thread(withAnswer: boolean): Promise<string> {
    const storage = await getOrCreateStorage();
    const q = await storage.createReviewComment(taskId, {
      ...TASK_LEVEL_REVIEW_ANCHOR, role: 'human', intent: 'ask',
      content: 'Why is the retry path unbounded here?',
    });
    if (withAnswer) {
      await storage.createReviewComment(taskId, {
        ...TASK_LEVEL_REVIEW_ANCHOR, threadId: q.thread_id, role: 'agent',
        content: 'It should be capped; I left that for later.',
      });
    }
    return q.thread_id;
  }

  // INVARIANT: an answered task-level discussion carries its seed, and an
  // unanswered one carries nothing. Same rule the daemon dashboard renders
  // from, so Teams and the dashboard never disagree about what can be promoted.
  test('seeds an answered discussion and omits an unanswered one', async () => {
    const answered = await thread(true);
    const open = await thread(false);
    const reply = await handleReviewComments(root, { taskId });
    expect(reply.promotions[open]).toBeUndefined();
    const seed = reply.promotions[answered];
    expect(seed.promotedTaskId).toBeNull();
    expect(seed.goal).toContain('retry path');
    expect(seed.prompt).toContain('It should be capped');
  });

  test('a promoted discussion reports the task it became', async () => {
    const answered = await thread(true);
    const result = await handleReviewPromoteDiscussion(root, { taskId, threadId: answered, code: 'cap-retry' });
    const reply = await handleReviewComments(root, { taskId });
    expect(reply.promotions[answered].promotedTaskId).toBe(result.task.id);
    expect(reply.promotions[answered].promotedTaskCode).toBe('cap-retry');
  });
});
