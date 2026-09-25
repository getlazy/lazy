/**
 * INVARIANT: a review draft never reaches storage through the generic `storage`
 * RPC command.
 *
 * That command is dispatched for ANY authenticated actor and carries no caller
 * identity, so an entry in `STORAGE_METHODS` would have to take the reviewer
 * key from a request field. A draft is a person's unsent words: a caller-named
 * key lets a user-kind token read the feedback another reviewer is still
 * writing, or overwrite it. The key is derived from the token in
 * `reviewerKey`, reached only through the `reviewGetDraft` / `reviewSaveDraft`
 * verbs, and this test is what keeps a convenience passthrough from quietly
 * reopening the hole.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { STORAGE_METHODS, handleStorageCall } from '../../src/daemon/rpc-handlers';

const DRAFT_METHODS = ['getReviewDraft', 'saveReviewDraft', 'deleteReviewDraft'] as const;

describe('review drafts are not reachable over the generic storage RPC', () => {
  test('the dispatch table does not register them', () => {
    // Guard: a table that lost its contents would pass the check below trivially.
    expect(Object.keys(STORAGE_METHODS).length).toBeGreaterThan(50);
    expect(STORAGE_METHODS).toHaveProperty('getTaskReviewComments');

    for (const method of DRAFT_METHODS) {
      expect(Object.keys(STORAGE_METHODS)).not.toContain(method);
    }
  });

  test('the storage-call path refuses them, naming the method', async () => {
    for (const method of DRAFT_METHODS) {
      // Rejected on the dispatch lookup, before any storage is opened — so no
      // temp project is needed, and no draft is read or written on the way out.
      await expect(
        handleStorageCall('/nonexistent-project-root', {
          method,
          args: { taskId: 't1', reviewer: 'someone-else', patch: { feedback: 'x' } },
        }),
      ).rejects.toThrow(new RegExp(`Unknown storage method: ${method}`));
    }
  });

  test('RemoteStorage does not forward them either', async () => {
    const source = await readFile(
      join(import.meta.dir, '../../src/storage/remote-storage.ts'),
      'utf8',
    );
    // Guard: the scan must be looking at the real file.
    expect(source).toContain("this.call<ReviewComment[]>('getTaskReviewComments'");

    for (const method of DRAFT_METHODS) {
      expect(source).not.toContain(`this.call<ReviewDraftState>('${method}'`);
      expect(source).not.toContain(`'${method}', {`);
    }
  });
});
