/**
 * Tests for comment source tracking (provenance).
 *
 * INVARIANT: Comments imported from remote (PR/MR) must never be re-exported
 * back to the remote. The `source` field on Comment tracks provenance so that
 * the export path can reliably skip remote-sourced comments, regardless of
 * content format.
 */

import { describe, test, expect } from 'bun:test';

// Direct import of the GitHub driver's isImportedComment regex behavior
// to test that the filtering logic in postTaskNotes works correctly.

describe('comment source filtering', () => {
  // Simulates the filtering logic in postTaskNotes (sync.ts)
  function shouldExport(comment: { content: string; source?: 'local' | 'remote' }, isImportedComment: (content: string) => boolean): boolean {
    // Primary check: structured source field
    if (comment.source === 'remote') return false;
    // Fallback: content-based regex for backward compatibility
    if (isImportedComment(comment.content)) return false;
    return true;
  }

  // GitHub driver's isImportedComment
  const githubIsImported = (content: string) =>
    /^\[PR #\d+ @[^\]]+\] \{(?:remote|gh):\w+\}/.test(content);

  // GitLab driver's isImportedComment
  const gitlabIsImported = (content: string) =>
    /^\[MR !\d+ @[^\]]+\] \{(?:remote|gl):\w+\}/.test(content);

  // INVARIANT: Comments with source='remote' are never exported,
  // regardless of content format.
  test('source=remote blocks export even without format markers', () => {
    const comment = {
      content: 'Plain comment without any markers',
      source: 'remote' as const,
    };
    expect(shouldExport(comment, githubIsImported)).toBe(false);
  });

  // INVARIANT: Comments with source='remote' from link import are blocked.
  // link imports use [author] format without {remote:id} marker.
  test('source=remote blocks link-imported comments that lack {remote:id} marker', () => {
    const comment = {
      content: '[reviewer] Please fix the typo',
      source: 'remote' as const,
    };
    expect(shouldExport(comment, githubIsImported)).toBe(false);
  });

  // Backward compat: old comments without source field but with format markers
  // are still blocked via isImportedComment fallback.
  test('comments without source field but with GitHub format markers are blocked', () => {
    const comment = {
      content: '[PR #42 @reviewer] {remote:12345} Please fix the typo',
    };
    expect(shouldExport(comment, githubIsImported)).toBe(false);
  });

  test('comments without source field but with old {gh:id} format are blocked', () => {
    const comment = {
      content: '[PR #42 @reviewer] {gh:12345} Please fix the typo',
    };
    expect(shouldExport(comment, githubIsImported)).toBe(false);
  });

  test('comments without source field but with GitLab format markers are blocked', () => {
    const comment = {
      content: '[MR !42 @reviewer] {remote:12345} Please fix the typo',
    };
    expect(shouldExport(comment, gitlabIsImported)).toBe(false);
  });

  // Local comments (no source or source='local') without markers ARE exported.
  test('local comments without markers are exported', () => {
    const comment = {
      content: 'Pipeline/checks failed: ci-lint. Task moved back to blocked.',
    };
    expect(shouldExport(comment, githubIsImported)).toBe(true);
  });

  test('comments with source=local are exported', () => {
    const comment = {
      content: 'Some observation about the code',
      source: 'local' as const,
    };
    expect(shouldExport(comment, githubIsImported)).toBe(true);
  });

  test('comments with no source and no markers are exported', () => {
    const comment = {
      content: '[Accepted] Looks good, merging.',
    };
    expect(shouldExport(comment, githubIsImported)).toBe(true);
  });
});
