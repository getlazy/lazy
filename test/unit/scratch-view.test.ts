import { describe, test, expect } from 'bun:test';
import {
  scratchPathsMentionedIn,
  groupScratchBySession,
  describeScratchSkip,
  scratchSearchQuery,
} from '../../src/builder/scratch-view';
import { parseQuery } from '../../src/search/parser';
import type { ScratchFile } from '../../src/types';

function file(path: string, updated_at: number, session_id?: string): ScratchFile {
  return {
    path, content: '', size: 1, created_at: updated_at, updated_at, updated_by: 'builder' as never,
    ...(session_id ? { session_id } : {}),
  };
}

describe('scratchPathsMentionedIn', () => {
  const paths = ['review/accept-foo.md', 'accept-foo.md', 'a.md', 'notes.md'];

  test('a path ending a sentence is a mention', () => {
    expect(scratchPathsMentionedIn('The draft is at $LAZY_SCRATCH_DIR/review/accept-foo.md.', paths))
      .toEqual(['review/accept-foo.md']);
  });

  test('backticks, an absolute path and a bare relative path all count', () => {
    expect(scratchPathsMentionedIn('See `review/accept-foo.md`', paths)).toEqual(['review/accept-foo.md']);
    expect(scratchPathsMentionedIn('/home/u/.lazy/scratch/notes.md', paths)).toEqual(['notes.md']);
    expect(scratchPathsMentionedIn('notes.md then a.md', paths)).toEqual(['notes.md', 'a.md']);
  });

  // INVARIANT: a path counts only as a whole path. A substring hit would link a
  // file the message never named.
  test('a path inside a longer name is not a mention', () => {
    expect(scratchPathsMentionedIn('see data.md', paths)).toEqual([]);
    expect(scratchPathsMentionedIn('see notes.md.bak', paths)).toEqual([]);
  });

  test('a shorter path inside a longer mention is not linked separately', () => {
    expect(scratchPathsMentionedIn('at review/accept-foo.md', paths)).toEqual(['review/accept-foo.md']);
    expect(scratchPathsMentionedIn('at review/accept-foo.md and accept-foo.md', paths))
      .toEqual(['review/accept-foo.md', 'accept-foo.md']);
  });
});

describe('groupScratchBySession', () => {
  test('newest session first, unrecorded session last, files by path', () => {
    const groups = groupScratchBySession([
      file('z.md', 100, 'old'),
      file('b.md', 500, 'new'),
      file('a.md', 400, 'new'),
      file('loose.md', 900),
    ]);
    expect(groups.map((g) => g.session_id)).toEqual(['new', 'old', null]);
    expect(groups[0]!.files.map((f) => f.path)).toEqual(['a.md', 'b.md']);
  });
});

describe('describeScratchSkip', () => {
  test('each reason says why the body is missing', () => {
    expect(describeScratchSkip('too_large')).toContain('per-file limit');
    expect(describeScratchSkip('binary')).toContain('Binary');
    expect(describeScratchSkip('sandbox_full')).toContain('scratch budget');
  });
});

test('scratchSearchQuery survives quotes and backslashes', () => {
  expect(parseQuery(scratchSearchQuery('a "b" \\c'))).toEqual({ type: 'in', scope: 'scratch', value: 'a "b" \\c' } as never);
});
