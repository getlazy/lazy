import { describe, test, expect } from 'bun:test';
import { revertedProtectedFiles, revertedProtectedFilesNotice } from '../../src/protection/reverted-files';
import type { Turn } from '../../src/types';

/**
 * A protected file the reviewer rejected is reverted on the branch, so it is
 * ABSENT from the diff — indistinguishable from "the task never touched it".
 * That invisibility is how a task shipped with a broken `test/mocks/claude.ts`
 * in August 2026. These tests pin the scan that lets accept say it out loud.
 */
function agentTurn(
  sequence: number,
  violations: Array<{ file: string; status: 'pending' | 'approved' | 'rejected' }>,
): Turn {
  return {
    id: `t${sequence}`,
    session_id: 's1',
    sequence,
    role: 'agent',
    content: 'work',
    timestamp: new Date(0).toISOString(),
    violations: violations.map(v => ({ file: v.file, base_sha: 'abc123', status: v.status })),
  } as unknown as Turn;
}

describe('revertedProtectedFiles', () => {
  test('lists rejected files, sorted, and nothing else', () => {
    const turns = [
      agentTurn(1, [
        { file: 'test/z.spec.ts', status: 'rejected' },
        { file: 'test/a.spec.ts', status: 'rejected' },
        { file: 'test/kept.spec.ts', status: 'approved' },
        { file: 'test/undecided.spec.ts', status: 'pending' },
      ]),
    ];
    expect(revertedProtectedFiles(turns)).toEqual(['test/a.spec.ts', 'test/z.spec.ts']);
  });

  // INVARIANT: the LATEST decision per file wins. Reverts happen over several
  // review rounds, and a file that was rejected and later approved is back in
  // the diff — reporting it as reverted would be a lie about the merged tree.
  test('the latest decision per file wins', () => {
    const turns = [
      agentTurn(1, [{ file: 'a.spec.ts', status: 'rejected' }, { file: 'b.spec.ts', status: 'rejected' }]),
      agentTurn(2, [{ file: 'a.spec.ts', status: 'approved' }]),
    ];
    expect(revertedProtectedFiles(turns)).toEqual(['b.spec.ts']);
  });

  test('ignores non-agent turns and turns with no violations', () => {
    const human = { id: 'h', session_id: 's1', sequence: 1, role: 'human', content: 'go' } as unknown as Turn;
    expect(revertedProtectedFiles([human, agentTurn(2, [])])).toEqual([]);
    expect(revertedProtectedFiles([])).toEqual([]);
  });
});

describe('revertedProtectedFilesNotice', () => {
  test('says nothing when nothing was reverted', () => {
    expect(revertedProtectedFilesNotice([])).toBe('');
  });

  test('names the count, every file, and why the diff does not show them', () => {
    const notice = revertedProtectedFilesNotice(['test/mocks/claude.ts', 'test/helpers/setup.ts']);
    expect(notice).toContain('2 protected file');
    expect(notice).toContain('test/mocks/claude.ts');
    expect(notice).toContain('test/helpers/setup.ts');
    expect(notice).toContain('NOT in the diff');
  });
});
