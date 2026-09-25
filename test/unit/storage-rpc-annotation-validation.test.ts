/**
 * INVARIANT: the annotation writers on `/rpc/storage` — createComment,
 * appendJournalEntry, createRaisedItem and the legacy createFollowUp adapter —
 * validate `content` at the BOUNDARY and reject a bad one with a 400, instead of
 * handing it to storage and letting `normalizeRecordContent` coerce it to ''.
 *
 * Unification did not narrow this: raised items absorbed follow-ups, so the one
 * create path now carries both, and the deprecated follow-up method is an
 * adapter over it. Both spellings are pinned here — an adapter that skipped the
 * check would reopen the hole for every Teams client still on the old name.
 * See docs/design/raised-items-unified.md.
 *
 * They used to read it as `a.content as string`, which asserts to the compiler
 * and checks nothing at runtime. The storage-level guard then turned a
 * non-string into an empty string with a warning, so a caller's mistake became
 * a permanently content-less record in the store rather than a rejected
 * request — the same records that later crashed `lazy review` (see
 * src/utils/turn-content.ts) and the same defect class fix-mcp-arg-validation
 * closed on the MCP side.
 *
 * The storage guard stays as the second layer for internal callers; these tests
 * pin the first one. The status is part of the contract: a caller's bad
 * argument must arrive as 400, not as a coerced write and not as a 500.
 */

import { describe, test, expect } from 'bun:test';
import { STORAGE_METHODS } from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';
import type { Storage } from '../../src/storage';

/**
 * Method name → the args a valid call supplies alongside `content`.
 *
 * The raised-item writers take their body as `input`, so they also say how a
 * bare content value is wrapped — `createRaisedItem` needs the `blocking` flag
 * beside it, and the legacy follow-up adapter supplies the flag itself.
 */
const ANNOTATION_WRITERS: Array<{
  method: string;
  args: Record<string, unknown>;
  wrap?: (content: unknown) => Record<string, unknown>;
}> = [
  { method: 'createComment', args: { taskId: 't1', actor: 'human' } },
  { method: 'appendJournalEntry', args: { taskId: 't1', actor: 'human' } },
  { method: 'createFollowUp', args: { taskId: 't1', sessionId: null } },
  {
    method: 'createRaisedItem',
    args: { taskId: 't1' },
    wrap: (content) => ({ input: { content, blocking: false } }),
  },
];

/**
 * Records every content value that reached storage, so a coerced write is
 * visible. Raised-item creates arrive as an input object; only their text is
 * recorded, so one assertion covers every writer.
 */
function recordingStorage(): { storage: Storage; contents: unknown[] } {
  const contents: unknown[] = [];
  const record = (_taskId: unknown, content: unknown) => {
    contents.push(content);
    return Promise.resolve({ id: 'rec-1' });
  };
  const storage = {
    createComment: record,
    appendJournalEntry: record,
    createRaisedItem: (_taskId: unknown, input: { content?: unknown }) => {
      contents.push(input?.content);
      return Promise.resolve({ id: 'rec-1', blocking: false, status: 'open' });
    },
  } as unknown as Storage;
  return { storage, contents };
}

describe('storage RPC annotation writers validate content', () => {
  for (const { method, args, wrap = (content: unknown) => ({ content }) } of ANNOTATION_WRITERS) {
    // A number, an object, an array and a boolean all used to be coerced to ''
    // by the storage guard. At the boundary they are a caller bug: say so.
    test(`${method} rejects a non-string content with a 400`, () => {
      const handler = STORAGE_METHODS[method];
      expect(handler).toBeDefined();

      for (const bad of [42, { text: 'hi' }, ['hi'], true]) {
        const { storage, contents } = recordingStorage();
        let thrown: unknown;
        try {
          handler!(storage, { ...args, ...wrap(bad) });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(RpcError);
        expect((thrown as RpcError).status).toBe(400);
        expect((thrown as RpcError).message).toContain('content must be a string');
        // The write must not have happened at all — a rejected request that
        // still stored a coerced '' would be the bug wearing a 400.
        expect(contents).toEqual([]);
      }
    });

    // Absent content is how the content-less records in real stores were
    // written: JSON.stringify drops an `undefined` value, so the key simply
    // vanished on disk.
    test(`${method} rejects absent or null content with a 400`, () => {
      const handler = STORAGE_METHODS[method]!;

      for (const missing of [{}, { content: null }]) {
        const { storage, contents } = recordingStorage();
        let thrown: unknown;
        try {
          handler(storage, { ...args, ...missing });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(RpcError);
        expect((thrown as RpcError).status).toBe(400);
        expect((thrown as RpcError).message).toBe('content is required');
        expect(contents).toEqual([]);
      }
    });

    test(`${method} passes a valid string content through unchanged`, async () => {
      const handler = STORAGE_METHODS[method]!;
      const { storage, contents } = recordingStorage();

      await handler(storage, { ...args, content: '  spacing is preserved  ' });

      expect(contents).toEqual(['  spacing is preserved  ']);
    });
  }
});
