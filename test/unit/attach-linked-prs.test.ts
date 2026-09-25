import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import type { Storage } from '../../src/storage/interface';
import type { RepositoryDriver, ImportResult } from '../../src/remote/driver';
import { attachLinkedPullRequests } from '../../src/daemon/remote-sync';
import {
  IMPORT_SOURCE_URL_KEY,
  IMPORT_SOURCE_BRANCH_KEY,
} from '../../src/task/linked';

let lazyRoot: string;
let basePath: string;
let storage: Storage;

beforeEach(async () => {
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-link-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-link-store-'));
  const s = new FileStorage(lazyRoot, { basePath });
  await s.initialize();
  storage = s;
});

afterEach(async () => {
  await storage.close();
  await rm(lazyRoot, { recursive: true, force: true });
  await rm(basePath, { recursive: true, force: true });
});

function fakeDriver(opts: {
  find?: (branch: string) => Promise<ImportResult | null>;
}): RepositoryDriver {
  return {
    hasRemoteRef: (task: { metadata?: Record<string, string> }) => !!(task.metadata?.github_remote_ref_id),
    findPullRequestForBranch: opts.find ?? (async () => null),
    formatImportedComment: (c: { author: string; body: string }) => `[PR #99 @${c.author}] ${c.body}`,
  } as unknown as RepositoryDriver;
}

describe('attachLinkedPullRequests', () => {
  // INVARIANT: a PR opened after a branch was linked is attached by the
  // daemon's pull pass, and never overwrites what the user originally linked.
  test('attaches a later PR without overwriting identity keys', async () => {
    const created = await storage.createTask(
      'later pr',
      undefined,
      undefined,
      'later-pr',
      undefined,
      'claude-code',
    );
    await storage.updateTaskMetadata(created.id, IMPORT_SOURCE_URL_KEY, 'feature/later');
    await storage.updateTaskMetadata(created.id, IMPORT_SOURCE_BRANCH_KEY, 'feature/later');
    await storage.updateTaskStatus(created.id, 'blocked');

    const driver = fakeDriver({
      find: async (branch) => {
        if (branch !== 'feature/later') return null;
        return {
          goal: 'Later PR',
          branch,
          metadata: {
            github_remote_ref_url: 'https://github.com/acme/repo/pull/99',
            github_remote_ref_id: '99',
            github_remote_ref_state: 'OPEN',
            [IMPORT_SOURCE_URL_KEY]: 'SHOULD_NOT_WIN',
            [IMPORT_SOURCE_BRANCH_KEY]: 'SHOULD_NOT_WIN',
          },
          comments: [{ forge: 'github', kind: 'issue_comment', id: '555', body: 'looks good', author: 'alice', createdAt: '2024-01-01T00:00:00Z' }],
        };
      },
    });

    const { attached } = await attachLinkedPullRequests(storage, driver);
    expect(attached).toBe(1);

    const updated = await storage.resolveTask(created.id);
    expect(updated.task?.metadata?.[IMPORT_SOURCE_URL_KEY]).toBe('feature/later');
    expect(updated.task?.metadata?.[IMPORT_SOURCE_BRANCH_KEY]).toBe('feature/later');
    expect(updated.task?.metadata?.github_remote_ref_url).toBe('https://github.com/acme/repo/pull/99');
    expect(updated.task?.metadata?.github_remote_ref_id).toBe('99');

    const comments = await storage.getTaskComments(created.id);
    expect(comments.some((c) => c.content.includes('looks good'))).toBe(true);
    // INVARIANT: linked-PR attachment records forge identity, so later sync
    // passes dedup by id rather than by text.
    expect(comments[0].external).toMatchObject({ forge: 'github', kind: 'issue_comment', id: '555' });
  });

  test('skips a linked task that already has a remote ref', async () => {
    const created = await storage.createTask(
      'already linked',
      undefined,
      undefined,
      'already-linked',
      undefined,
      'claude-code',
    );
    await storage.updateTaskMetadata(created.id, IMPORT_SOURCE_BRANCH_KEY, 'feature/have');
    await storage.updateTaskMetadata(created.id, 'github_remote_ref_id', '7');
    await storage.updateTaskStatus(created.id, 'blocked');

    let looked = 0;
    const driver = fakeDriver({
      find: async () => {
        looked++;
        return null;
      },
    });

    const { attached } = await attachLinkedPullRequests(storage, driver);
    expect(attached).toBe(0);
    expect(looked).toBe(0);
  });

  test('skips a task that is not linked', async () => {
    await storage.createTask('ordinary', undefined, undefined, 'ordinary', undefined, 'claude-code');
    let looked = 0;
    const driver = fakeDriver({
      find: async () => {
        looked++;
        return null;
      },
    });
    const { attached } = await attachLinkedPullRequests(storage, driver);
    expect(attached).toBe(0);
    expect(looked).toBe(0);
  });

  test('keeps walking after a forge lookup throws', async () => {
    const created = await storage.createTask(
      'lookup fails',
      undefined,
      undefined,
      'lookup-fails',
      undefined,
      'claude-code',
    );
    await storage.updateTaskMetadata(created.id, IMPORT_SOURCE_BRANCH_KEY, 'feature/broken-token');
    await storage.updateTaskStatus(created.id, 'blocked');

    const driver = fakeDriver({
      find: async () => {
        throw new Error('401 Bad credentials');
      },
    });

    const { attached } = await attachLinkedPullRequests(storage, driver);
    expect(attached).toBe(0);
  });
});
