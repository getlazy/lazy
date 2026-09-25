/**
 * Unit tests: `Session.notes_delivered_through`, the notes-delivery high-water
 * mark, and its monotonic guard in `Storage.markNotesDelivered`.
 *
 * The mark is the cutoff every surface uses to answer "what has the agent not
 * seen yet" — the unblock prompt, the editor flow, `lazy show`'s unseen count,
 * the diff notes section and the TUI review, all through
 * `resolveNotesCutoff()`. It replaced a last-agent-turn cutoff, which silently
 * dropped a comment written before a `lazy ask` or `lazy sync` (both record
 * agent turns without delivering notes).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';

describe('notes delivery high-water mark', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let sessionId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-ndt-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-ndt-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Notes delivery mark test');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/ndt', 'abc123');
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('a fresh session has no mark, so the cutoff falls back to turns', async () => {
    const session = await storage.getSession(sessionId);
    expect(session?.notes_delivered_through ?? null).toBeNull();
  });

  test('markNotesDelivered records the delivery timestamp', async () => {
    await storage.markNotesDelivered(sessionId, 5000);
    const session = await storage.getSession(sessionId);
    expect(session?.notes_delivered_through).toBe(5000);
  });

  // INVARIANT: the cutoff may never move BACKWARDS.
  //
  // It is a high-water mark, not "the last thing that happened": it answers
  // "what has the agent already been shown", and an agent cannot un-see a
  // comment. Rewinding it re-delivers notes the agent already acted on, which
  // reads to it as the human repeating themselves — and, since the mark also
  // drives the unseen counts humans review against, makes delivered feedback
  // look pending. Callers legitimately hand over older values: each delivering
  // prompt marks through the newest note IT carried, so an unblock that
  // carried nothing new, or one whose notes were all older than a previous
  // batch, arrives with a timestamp behind the current mark.
  test('markNotesDelivered never rewinds the mark', async () => {
    await storage.markNotesDelivered(sessionId, 5000);
    await storage.markNotesDelivered(sessionId, 1000);

    const session = await storage.getSession(sessionId);
    expect(session?.notes_delivered_through).toBe(5000);
  });

  test('markNotesDelivered advances the mark forwards', async () => {
    await storage.markNotesDelivered(sessionId, 1000);
    await storage.markNotesDelivered(sessionId, 5000);

    const session = await storage.getSession(sessionId);
    expect(session?.notes_delivered_through).toBe(5000);
  });

  // An equal timestamp is a no-op, not an error: re-delivering the same batch
  // must leave the mark exactly where it was.
  test('marking the same timestamp twice is idempotent', async () => {
    await storage.markNotesDelivered(sessionId, 5000);
    await storage.markNotesDelivered(sessionId, 5000);

    const session = await storage.getSession(sessionId);
    expect(session?.notes_delivered_through).toBe(5000);
  });

  // Same shape as every other session mutator on FileStorage: a session that is
  // gone is not the caller's problem to handle. Marking is a side effect of a
  // launch that already happened, so throwing here would fail a turn over
  // bookkeeping.
  test('an unknown session is ignored rather than throwing', async () => {
    await expect(storage.markNotesDelivered('sess-does-not-exist', 5000)).resolves.toBeUndefined();
  });
});
