/**
 * The key a half-typed review comment is stored under (src/review/draft-key.ts).
 *
 * Two load-bearing properties, both about not losing words:
 *  - a key names the BOX, not just the anchor, so two boxes that happen to
 *    share a `(file, side, line)` — a diff row, and the presented document or
 *    diagram rendered from that line — never share one stored draft;
 *  - the browser mirror the review island embeds derives the same keys as the
 *    TypeScript helpers, or a draft seeded server-side would never be found by
 *    the page and a draft written by the page would never be read back.
 */

import { describe, test, expect } from 'bun:test';
import {
  REVIEW_DRAFT_KEY_JS,
  REVIEW_DRAFT_SURFACES,
  parseReviewDraftKey,
  reviewDraftKey,
  type ReviewDraftKeyParts,
} from '../../src/review/draft-key';
import { reviewScript } from '../../src/server/review';

const SAMPLES: ReviewDraftKeyParts[] = [
  { surface: 'line', file: 'src/app.ts', side: 'new', line: 42, threadId: '', control: '' },
  { surface: 'present', file: 'src/app.ts', side: 'new', line: 42, threadId: '', control: '' },
  { surface: 'prose', file: '(report)', side: 'new', line: 918273, threadId: '', control: '' },
  { surface: 'task', file: '(task)', side: 'new', line: 0, threadId: 'th-1', control: '' },
  { surface: 'line', file: 'docs/a file with spaces.md', side: 'old', line: 7, threadId: 'th-2', control: '' },
  // The two presented controls that resolve to the same anchor: a document's
  // own header button, and a diagram rendered inside that document.
  { surface: 'present', file: 'docs/notes.md', side: 'new', line: 20, threadId: '', control: 'doc' },
  { surface: 'present', file: 'docs/notes.md', side: 'new', line: 20, threadId: '', control: 'm-1a2b3c' },
  // A control id beside a path that contains a space — the case a sixth field
  // would have made ambiguous.
  { surface: 'present', file: 'docs/a b.md', side: 'new', line: 3, threadId: '', control: 'doc' },
];

describe('review draft keys', () => {
  // INVARIANT: the surface is part of the key. The same line is reachable from
  // the diff row, from that file's presented document header, and from a
  // diagram rendered out of it; one key for all three means each keystroke in
  // one box overwrites the other box's words.
  test('two boxes on the same anchor get different keys', () => {
    const anchor = { file: 'src/app.ts', side: 'new', line: 42, threadId: '' } as const;
    const keys = REVIEW_DRAFT_SURFACES.map((surface) => reviewDraftKey({ ...anchor, surface }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a key round-trips, including a path with spaces and a thread id', () => {
    for (const parts of SAMPLES) {
      expect(parseReviewDraftKey(reviewDraftKey(parts))).toEqual(parts);
    }
  });

  // INVARIANT: two controls on ONE presented surface are two boxes. A
  // document's header button and a diagram inside it both resolve to the line
  // the document starts on, so without the control id they share a key — the
  // same clobbering the surface prefix exists to stop, one level down.
  test('two presented controls on one anchor keep separate keys', () => {
    const anchor = { surface: 'present', file: 'docs/notes.md', side: 'new', line: 20, threadId: '' } as const;
    const doc = reviewDraftKey({ ...anchor, control: 'doc' });
    const diagram = reviewDraftKey({ ...anchor, control: 'm-1a2b3c' });
    expect(doc).not.toBe(diagram);
    expect(parseReviewDraftKey(doc)!.control).toBe('doc');
    expect(parseReviewDraftKey(diagram)!.control).toBe('m-1a2b3c');
    // And neither is confused with the plain document-wide key.
    expect(doc).not.toBe(reviewDraftKey({ ...anchor }));
  });

  // A key written before surfaces existed is READ, not discarded: a draft the
  // store holds and the page never shows is the same loss by another route.
  test('a legacy four-field key is read as a line draft', () => {
    expect(parseReviewDraftKey('new 42 - src/app.ts')).toEqual({
      surface: 'line',
      control: '',
      file: 'src/app.ts',
      side: 'new',
      line: 42,
      threadId: '',
    });
    // And a key from before CONTROLS existed still parses as its surface.
    expect(parseReviewDraftKey('present new 20 - docs/notes.md')).toEqual({
      surface: 'present',
      control: '',
      file: 'docs/notes.md',
      side: 'new',
      line: 20,
      threadId: '',
    });
    expect(parseReviewDraftKey('not a key')).toBeNull();
  });

  // INVARIANT: the island's mirror and these helpers must derive the same keys.
  // The server seeds drafts under keys built here and the browser looks them up
  // by the keys it builds; a drift means words that are stored and never shown.
  test('the browser mirror agrees with the TypeScript helpers', () => {
    const mirror = new Function(
      `${REVIEW_DRAFT_KEY_JS}; return { draftKey: draftKey, parseDraftKey: parseDraftKey };`,
    )() as {
      draftKey: (
        a: { file: string; side: string; line: number },
        threadId: string,
        surface: string,
        control?: string,
      ) => string;
      parseDraftKey: (key: string) => {
        surface: string;
        control: string;
        anchor: { file: string; side: string; line: number };
        threadId: string;
      } | null;
    };

    for (const parts of SAMPLES) {
      const ours = reviewDraftKey(parts);
      const theirs = mirror.draftKey(
        { file: parts.file, side: parts.side, line: parts.line },
        parts.threadId,
        parts.surface,
        parts.control,
      );
      expect(theirs).toBe(ours);

      const parsed = mirror.parseDraftKey(ours);
      expect(parsed).not.toBeNull();
      expect(parsed!.surface).toBe(parts.surface);
      expect(parsed!.anchor.file).toBe(parts.file);
      expect(parsed!.anchor.side).toBe(parts.side);
      expect(parsed!.anchor.line).toBe(parts.line);
      expect(parsed!.threadId).toBe(parts.threadId);
      expect(parsed!.control).toBe(parts.control ?? '');
    }

    // The legacy shape too, since that is what an already-stored draft looks like.
    expect(mirror.parseDraftKey('new 42 - src/app.ts')).toEqual({
      surface: 'line',
      control: '',
      anchor: { file: 'src/app.ts', side: 'new', line: 42 },
      threadId: '',
    });
  });

  // The island must embed the mirror rather than carry a second copy of the
  // format — a copy is what drifts.
  test('the review island embeds the mirror', () => {
    const js = reviewScript('task1234abcd');
    expect(js).toContain(REVIEW_DRAFT_KEY_JS);
  });
});
