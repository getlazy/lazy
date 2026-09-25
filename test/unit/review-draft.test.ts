/**
 * The review draft: the words a reviewer has typed and not sent.
 *
 * Two things are under test here — the patch semantics that keep one box's
 * autosave from blanking another, and the boundary validation both external
 * surfaces (the /rpc verb and the daemon's own web route) share.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import {
  LOCAL_REVIEWER,
  MAX_DRAFT_FIELD_CHARS,
  MAX_LINE_DRAFTS,
  MAX_LINE_DRAFT_KEY_CHARS,
  MAX_VIEWED_HASH_CHARS,
  MAX_VIEWED_PATH_CHARS,
  parseReviewDraftPatch,
  ReviewDraftPatchError,
  reviewerKey,
} from '../../src/review-draft';

describe('parseReviewDraftPatch', () => {
  test('keeps only the fields the caller sent', () => {
    expect(parseReviewDraftPatch({ feedback: 'half a thought' })).toEqual({
      feedback: 'half a thought',
    });
    // An empty string is a real value — the reviewer cleared the box — and must
    // survive parsing, or clearing a draft would be indistinguishable from
    // leaving it alone.
    expect(parseReviewDraftPatch({ feedback: '' })).toEqual({ feedback: '' });
    expect(parseReviewDraftPatch({})).toEqual({});
  });

  test('rejects anything that is not a patch, naming what was wrong', () => {
    for (const bad of [undefined, null, 'feedback', 42, [ 'feedback' ]]) {
      expect(() => parseReviewDraftPatch(bad)).toThrow(ReviewDraftPatchError);
    }
    expect(() => parseReviewDraftPatch({ feedback: 7 })).toThrow(/patch.feedback must be a string/);
    expect(() => parseReviewDraftPatch({ viewedFiles: [] })).toThrow(
      /patch.viewedFiles must be an object/,
    );
  });

  // INVARIANT: a viewed tick is a CONTENT HASH, never a boolean. That is what
  // makes a file whose content changed under the reviewer come back unviewed
  // instead of falsely ticked.
  test('a viewed tick must be a content hash', () => {
    expect(parseReviewDraftPatch({ viewedFiles: { 'src/app.ts': 'abc123' } })).toEqual({
      viewedFiles: { 'src/app.ts': 'abc123' },
    });
    expect(() => parseReviewDraftPatch({ viewedFiles: { 'src/app.ts': true } })).toThrow(
      /must be a content-hash string/,
    );
  });

  test('a draft field is bounded so a hand-rolled caller cannot park a novel on a task', () => {
    const withinLimit = 'x'.repeat(MAX_DRAFT_FIELD_CHARS);
    expect(parseReviewDraftPatch({ feedback: withinLimit }).feedback).toHaveLength(
      MAX_DRAFT_FIELD_CHARS,
    );
    expect(() => parseReviewDraftPatch({ feedback: `${withinLimit}x` })).toThrow(/over the/);
  });

  // Bounding the entry count alone still lets 10k entries of unbounded key and
  // value park unbounded text on a task: both halves of the map are checked.
  test('a viewed tick is bounded on both the path and the hash', () => {
    const longPath = 'p'.repeat(MAX_VIEWED_PATH_CHARS + 1);
    expect(() => parseReviewDraftPatch({ viewedFiles: { [longPath]: 'h' } })).toThrow(
      /character path, over the/,
    );
    const longHash = 'h'.repeat(MAX_VIEWED_HASH_CHARS + 1);
    expect(() => parseReviewDraftPatch({ viewedFiles: { 'a.ts': longHash } })).toThrow(
      /over the .* limit for a content hash/,
    );
    // The limits themselves are generous — a real path and a real digest pass.
    expect(
      parseReviewDraftPatch({ viewedFiles: { 'src/daemon/rpc-handlers.ts': 'a'.repeat(64) } })
        .viewedFiles,
    ).toBeDefined();
  });

  // REMOVED (move-file-approval-to-accept): the two violation-decision tests.
  // They pinned the validation of a draft field that held the reviewer's unsent
  // keep/revert answer per violated file — a question unblock no longer asks and
  // an outcome (revert) nothing in lazy performs. The field, its two constants
  // and its parse branch went with it; a validated external input with no reader
  // is how the implicit revert would come back. The assertion below keeps the
  // surface honest.
  test('the patch parser no longer knows about violation decisions', () => {
    // Not a 400 and not stored: an unknown key is simply ignored, the same as
    // any other field parseReviewDraftPatch does not define.
    expect(parseReviewDraftPatch({ violationDecisions: { 'lazy.toml': 'keep' } })).toEqual({});
  });

  // INVARIANT: a half-typed line comment is human feedback like any other, so
  // it is stored and validated like any other. The key is opaque to the daemon
  // (the review island builds it from the anchor) but still bounded, and the
  // text gets the same per-field cap the feedback box has.
  test('line drafts are anchor key → text, bounded on both halves', () => {
    expect(parseReviewDraftPatch({ lineDrafts: { 'new 42 - src/app.ts': 'why this cast?' } })).toEqual({
      lineDrafts: { 'new 42 - src/app.ts': 'why this cast?' },
    });
    // A patch names only the anchors it is changing (see the merge test
    // below); an empty patch changes nothing and is still a valid one.
    expect(parseReviewDraftPatch({ lineDrafts: {} })).toEqual({ lineDrafts: {} });
    // An empty string is a real value here — it is how a box that was sent or
    // cancelled is removed — so it must survive parsing.
    expect(parseReviewDraftPatch({ lineDrafts: { 'line new 1 - a.ts': '' } })).toEqual({
      lineDrafts: { 'line new 1 - a.ts': '' },
    });
    expect(() => parseReviewDraftPatch({ lineDrafts: [] })).toThrow(
      /patch.lineDrafts must be an object/,
    );
    expect(() => parseReviewDraftPatch({ lineDrafts: { 'new 42 - a.ts': 7 } })).toThrow(
      /must be a string/,
    );
    expect(() =>
      parseReviewDraftPatch({ lineDrafts: { ['k'.repeat(MAX_LINE_DRAFT_KEY_CHARS + 1)]: 'x' } }),
    ).toThrow(/character anchor key, over the/);
    expect(() =>
      parseReviewDraftPatch({ lineDrafts: { 'new 1 - a.ts': 'x'.repeat(MAX_DRAFT_FIELD_CHARS + 1) } }),
    ).toThrow(/over the .* limit for a draft field/);
    const tooMany: Record<string, string> = {};
    for (let i = 0; i <= MAX_LINE_DRAFTS; i++) tooMany[`new ${i} - f.ts`] = 'x';
    expect(() => parseReviewDraftPatch({ lineDrafts: tooMany })).toThrow(/over the/);
  });

  // A JSON encoder that spells an unset field as `null` must not blank a field
  // the reviewer never touched: only `""` clears.
  test('an explicit null is treated as omitted, not as a clear', () => {
    expect(parseReviewDraftPatch({ feedback: null, acceptReason: 'keep' })).toEqual({
      acceptReason: 'keep',
    });
  });
});

describe('reviewerKey', () => {
  // Not a multi-user model: one key, so two signed-in reviewers of the same
  // task do not overwrite each other's unsent words, and the daemon's own
  // dashboard (which has no sign-in) has a key of its own.
  test('falls back to the single-IC key when the caller is nobody in particular', () => {
    expect(reviewerKey(undefined)).toBe(LOCAL_REVIEWER);
    // A person's draft is keyed by the one spelling of a person the store uses.
    expect(reviewerKey({ role: 'human', email: 'ada@example.com' })).toBe('ada@example.com');
    // A ref the daemon could not attribute to a person is still nobody in
    // particular — it must not become a draft key of its own.
    expect(reviewerKey({ role: 'human' })).toBe(LOCAL_REVIEWER);
  });
});

describe('FileStorage review drafts', () => {
  let lazyRoot: string;
  let basePath: string;
  let storage: FileStorage;
  let taskId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-draft-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-draft-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    taskId = (await storage.createTask('Review me', undefined, undefined, 'draft-task')).id;
  });

  afterEach(async () => {
    await rm(lazyRoot, { recursive: true, force: true });
    await rm(basePath, { recursive: true, force: true });
  });

  test('a first visit has no draft', async () => {
    expect(await storage.getReviewDraft(taskId, LOCAL_REVIEWER)).toBeNull();
  });

  // INVARIANT: saving is a PATCH. The feedback box autosaving must not blank an
  // accept reason typed in another tab — an omitted key means "leave it alone".
  test('an omitted field keeps what is stored', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      feedback: 'rename the flag',
      acceptReason: 'good enough',
    });
    const patched = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'and add a test' });

    expect(patched.feedback).toBe('and add a test');
    expect(patched.accept_reason).toBe('good enough');
    expect(patched.updated_at).toBeGreaterThan(0);
  });

  test('an empty string clears that field and only that field', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      feedback: 'sent already',
      acceptReason: 'still typing',
    });
    const cleared = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: '' });

    expect(cleared.feedback).toBe('');
    expect(cleared.accept_reason).toBe('still typing');
  });

  // INVARIANT: line drafts MERGE per anchor — the one map field that is not
  // applied wholesale. Two tabs open on one review is ordinary use, and each
  // holds the map it was seeded with; a wholesale write from either erases
  // every box the other has opened since. An anchor the patch does not name is
  // left exactly as stored.
  test('a second tab cannot erase the first tab\'s open comment boxes', async () => {
    // Tab A opens a box and types.
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      feedback: 'still typing',
      lineDrafts: { 'line new 10 - a.ts': 'from tab A' },
    });
    // Tab B — which loaded BEFORE that box existed, so its own map does not
    // contain it — opens a different box and types.
    const both = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      lineDrafts: { 'line new 20 - a.ts': 'from tab B' },
    });

    expect(both.line_drafts).toEqual({
      'line new 10 - a.ts': 'from tab A',
      'line new 20 - a.ts': 'from tab B',
    });
    expect(both.feedback).toBe('still typing');

    // An empty string is how a box that was sent or cancelled is removed — and
    // it removes only that one.
    const afterSend = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      lineDrafts: { 'line new 10 - a.ts': '' },
    });
    expect(afterSend.line_drafts).toEqual({ 'line new 20 - a.ts': 'from tab B' });

    const untouched = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'more' });
    expect(untouched.line_drafts).toEqual({ 'line new 20 - a.ts': 'from tab B' });
  });

  // INVARIANT: the cap refuses ONE anchor, never the whole write. The autosave
  // debounce batches every field changed in its window into one patch, so
  // failing the write took the feedback box's words down with a limit the
  // reviewer cannot see — a feedback-loss path hiding inside a bound check.
  test('an over-limit comment box does not stop the rest of the draft saving', async () => {
    for (let i = 0; i < MAX_LINE_DRAFTS; i++) {
      await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
        lineDrafts: { ['line new ' + i + ' - a.ts']: 'x' },
      });
    }

    const saved = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      feedback: 'the words in the big box',
      acceptReason: 'and in this one',
      lineDrafts: { 'line new 99999 - a.ts': 'one box too many' },
    });

    // The other fields are written...
    expect(saved.feedback).toBe('the words in the big box');
    expect(saved.accept_reason).toBe('and in this one');
    // ...the map stays at its bound, and the refused anchor is simply absent,
    // which is how the caller sees the refusal (the web route turns that
    // comparison into a message rather than failing mute).
    expect(Object.keys(saved.line_drafts)).toHaveLength(MAX_LINE_DRAFTS);
    expect(saved.line_drafts['line new 99999 - a.ts']).toBeUndefined();
  });

  // At the cap, the box the reviewer is actually typing in still saves: it is
  // already stored, so keeping it does not grow the map. Refusing it would be
  // losing the words of whoever is typing right now.
  test('at the cap, an already-open box still saves and a delete still frees a slot', async () => {
    for (let i = 0; i < MAX_LINE_DRAFTS; i++) {
      await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
        lineDrafts: { ['line new ' + i + ' - a.ts']: 'x' },
      });
    }

    const typed = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      lineDrafts: { 'line new 0 - a.ts': 'still typing in this one' },
    });
    expect(typed.line_drafts['line new 0 - a.ts']).toBe('still typing in this one');

    // Sending or cancelling one makes room again.
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { lineDrafts: { 'line new 0 - a.ts': '' } });
    const after = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      lineDrafts: { 'line new 99999 - a.ts': 'room now' },
    });
    expect(after.line_drafts['line new 99999 - a.ts']).toBe('room now');
  });

  test('two reviewers of the same task keep separate words', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'mine' });
    await storage.saveReviewDraft(taskId, 'user-7', { feedback: 'theirs' });

    expect((await storage.getReviewDraft(taskId, LOCAL_REVIEWER))?.feedback).toBe('mine');
    expect((await storage.getReviewDraft(taskId, 'user-7'))?.feedback).toBe('theirs');
  });

  test('deleting one reviewer draft leaves the other alone', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'mine' });
    await storage.saveReviewDraft(taskId, 'user-7', { feedback: 'theirs' });

    expect(await storage.deleteReviewDraft(taskId, LOCAL_REVIEWER)).toBe(true);
    // Idempotent: deleting a draft that is not there is not an error.
    expect(await storage.deleteReviewDraft(taskId, LOCAL_REVIEWER)).toBe(false);
    expect((await storage.getReviewDraft(taskId, 'user-7'))?.feedback).toBe('theirs');
  });

  // INVARIANT: a viewed tick is MERGED per file, and an EMPTY STRING is how one
  // is taken back. It used to be replaced wholesale, with an omitted key
  // meaning "untick" — which made a caller that had not yet read the draft able
  // to destroy every tick it did not know about, just by ticking one file. That
  // is silent loss of a reviewer's own recorded state, and no ordering rule on
  // the client side can close it for the NEXT caller. Same shape as
  // `line_drafts` below, for the same reason.
  test('an untick is an empty string, and a tick never erases one it did not know about', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      viewedFiles: { 'a.ts': 'hash-a', 'b.ts': 'hash-b' },
    });

    // A client that loaded nothing and ticks one file: the other tick survives.
    const afterBlindTick = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      viewedFiles: { 'c.ts': 'hash-c' },
    });
    expect(afterBlindTick.viewed_files).toEqual({
      'a.ts': 'hash-a',
      'b.ts': 'hash-b',
      'c.ts': 'hash-c',
    });

    // Unticking is still expressible, and it is the only thing that removes a
    // key — omission no longer does.
    const afterUntick = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      viewedFiles: { 'b.ts': '' },
    });
    expect(afterUntick.viewed_files).toEqual({ 'a.ts': 'hash-a', 'c.ts': 'hash-c' });

    // A tick whose content moved overwrites the stored hash rather than
    // accumulating beside it.
    const afterRetick = await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, {
      viewedFiles: { 'a.ts': 'hash-a2' },
    });
    expect(afterRetick.viewed_files).toEqual({ 'a.ts': 'hash-a2', 'c.ts': 'hash-c' });
  });

  // INVARIANT: a broken drafts file is NOT the same as no drafts file.
  // `readJson` collapses both to null, and on this record that costs data: the
  // very next autosave would write a one-draft file over everyone's unsent
  // words. ENOENT falls through to empty; anything else is surfaced and the
  // write refused, so a human can look at the file.
  test('a corrupt drafts file is surfaced, not silently overwritten', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'mine' });
    await storage.saveReviewDraft(taskId, 'user-7', { feedback: 'theirs' });

    const draftsFile = join(basePath, 'tasks', taskId, 'review-drafts.json');
    const corrupt = '{"review_drafts": [{"feedback": "truncated mid-w';
    await writeFile(draftsFile, corrupt, 'utf-8');

    await expect(storage.getReviewDraft(taskId, LOCAL_REVIEWER)).rejects.toThrow(/not valid JSON/);
    await expect(
      storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'overwrite me' }),
    ).rejects.toThrow(/Refusing to overwrite/);
    await expect(storage.deleteReviewDraft(taskId, LOCAL_REVIEWER)).rejects.toThrow(
      /not valid JSON/,
    );

    // The whole point: the bytes are still there for whoever has to recover them.
    expect(await readFile(draftsFile, 'utf-8')).toBe(corrupt);
  });

  test('a drafts file whose key is not an array is refused the same way', async () => {
    await storage.saveReviewDraft(taskId, LOCAL_REVIEWER, { feedback: 'mine' });
    const draftsFile = join(basePath, 'tasks', taskId, 'review-drafts.json');
    await writeFile(draftsFile, '{"review_drafts": {"local": "mine"}}', 'utf-8');

    await expect(storage.getReviewDraft(taskId, LOCAL_REVIEWER)).rejects.toThrow(
      /not an array/,
    );
  });

  test('a draft on a task that does not exist is refused', async () => {
    expect(await storage.getReviewDraft('no-such-task', LOCAL_REVIEWER)).toBeNull();
    await expect(
      storage.saveReviewDraft('no-such-task', LOCAL_REVIEWER, { feedback: 'x' }),
    ).rejects.toThrow(/Task not found/);
  });
});
