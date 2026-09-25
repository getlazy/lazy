import { describe, test, expect } from 'bun:test';
import { parseMergeTreeConflictFiles } from '../../src/git/operations';

describe('parseMergeTreeConflictFiles', () => {
  test('reads CONFLICT (content) lines', () => {
    expect(parseMergeTreeConflictFiles(
      'CONFLICT (content): Merge conflict in src/foo.ts\n',
    )).toEqual(['src/foo.ts']);
  });

  test('reads unmerged-index stage lines', () => {
    const stdout = [
      '100644 abc123 1\tREADME.md',
      '100644 def456 2\tREADME.md',
      '100644 ghi789 3\tREADME.md',
    ].join('\n');
    expect(parseMergeTreeConflictFiles(stdout)).toEqual(['README.md']);
  });

  test('reads base/our/their informational lines', () => {
    const stdout = [
      'changed in both',
      '  base   100644 aaa src/a.ts',
      '  our    100644 bbb src/a.ts',
      '  their  100644 ccc src/a.ts',
    ].join('\n');
    expect(parseMergeTreeConflictFiles(stdout)).toEqual(['src/a.ts']);
  });

  test('dedupes the same path from mixed formats', () => {
    const stdout = [
      'CONFLICT (content): Merge conflict in app.js',
      '100644 abc 1\tapp.js',
      '  our    100644 def app.js',
    ].join('\n');
    expect(parseMergeTreeConflictFiles(stdout)).toEqual(['app.js']);
  });
});
