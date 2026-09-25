/**
 * E2E coverage for system messages: the `lazy messages` CLI lifecycle
 * (list → read → dismiss) against a seeded store.
 *
 * Seeding is direct-to-storage on purpose: the CLI has no create surface
 * (producers file messages via `lazy_message_post` or the daemon's upgrade
 * notice), so the helpers in test/helpers/storage.ts write the store the CLI
 * then reads. Builder-launch injection is covered in builder.test.ts, where
 * the fake-claude argv capture lives.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import {
  readSystemMessagesFile,
  writeSystemMessagesFile,
  type StoredSystemMessage,
} from '../helpers/storage';

function seedMessage(overrides: Partial<StoredSystemMessage> = {}): StoredSystemMessage {
  return {
    id: randomUUID(),
    created_at: Date.now(),
    source: 'daemon',
    title: 'Daemon version changed: 0.19.0 → 0.20.0',
    body: 'The daemon for this project restarted with new code.',
    kind: 'notice',
    ...overrides,
  };
}

describe('lazy messages', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('empty inbox says so', async () => {
    const result = await ctx.lazy(['messages']);
    expectSuccess(result);
    expectOutput(result, 'No system messages');
  });

  test('list → read → dismiss lifecycle', async () => {
    const message = seedMessage();
    writeSystemMessagesFile(ctx.root, [message]);

    // list: unread message shows with its short id
    const list = await ctx.lazy(['messages', 'list']);
    expectSuccess(list);
    expectOutput(list, message.id.slice(0, 8));
    expectOutput(list, 'unread');
    expectOutput(list, 'Daemon version changed');

    // read (by unique prefix): prints the body and marks read
    const read = await ctx.lazy(['messages', 'read', message.id.slice(0, 8)]);
    expectSuccess(read);
    expectOutput(read, 'The daemon for this project restarted with new code.');
    const afterRead = readSystemMessagesFile(ctx.root);
    expect(afterRead[0].read_at).toBeGreaterThan(0);

    const listAfterRead = await ctx.lazy(['messages', 'list']);
    expectOutput(listAfterRead, 'read');

    // dismiss: leaves the default listing, stays in --all
    const dismiss = await ctx.lazy(['messages', 'dismiss', message.id.slice(0, 8)]);
    expectSuccess(dismiss);
    expectOutput(dismiss, 'Dismissed');

    const listAfterDismiss = await ctx.lazy(['messages', 'list']);
    expectSuccess(listAfterDismiss);
    expectOutputExcludes(listAfterDismiss, message.id.slice(0, 8));

    const listAll = await ctx.lazy(['messages', 'list', '--all']);
    expectOutput(listAll, message.id.slice(0, 8));
    expectOutput(listAll, 'dismissed');

    // INVARIANT: dismissal is a state change, not deletion — the stored
    // message is intact, attributed, and still carries its body.
    const stored = readSystemMessagesFile(ctx.root);
    expect(stored).toHaveLength(1);
    expect(stored[0].dismissed_at).toBeGreaterThan(0);
    expect(stored[0].dismissed_by).toBe('human');
    expect(stored[0].body).toBe(message.body);
  });

  test('read of an unknown id fails with a pointer to list', async () => {
    const result = await ctx.lazy(['messages', 'read', 'ffffffff']);
    expectFailure(result);
    expectError(result, 'No system message matches');
  });

  // Inputs are validated at the CLI boundary: ids are hex UUIDs, so anything
  // else is rejected loudly instead of reaching a storage lookup.
  test('a non-hex id is rejected at the boundary', async () => {
    const result = await ctx.lazy(['messages', 'dismiss', 'not%an-id']);
    expectFailure(result);
    expectError(result, 'Invalid message id');
  });

  test('unknown subcommand fails with usage', async () => {
    const result = await ctx.lazy(['messages', 'frobnicate']);
    expectFailure(result);
    expectError(result, 'Unknown messages subcommand');
  });
});
