/**
 * Unit tests for lazy_diff offset/max_lines pagination logic.
 *
 * Tests the line-slicing behavior that allows paginating through large diffs
 * using offset (skip first N lines) and max_lines (return at most N lines).
 */

import { describe, test, expect } from 'bun:test';

/**
 * Extracted pagination logic matching createDiffHandler in src/mcp/tools.ts.
 * This function applies offset and max_lines to a raw diff output string.
 */
function applyDiffPagination(
  diffOutput: string,
  offset: number,
  maxLines: number | undefined,
): { diff: string; total_lines?: number; truncated?: boolean; offset?: number } {
  const result: Record<string, unknown> = {};

  if (offset > 0 || (maxLines !== undefined && maxLines > 0)) {
    const lines = diffOutput.split('\n');
    result.total_lines = lines.length;

    // Skip first N lines
    const remaining = lines.slice(Math.min(offset, lines.length));

    // Then apply max_lines cap
    if (maxLines !== undefined && maxLines > 0 && remaining.length > maxLines) {
      diffOutput = remaining.slice(0, maxLines).join('\n');
      result.truncated = true;
    } else {
      diffOutput = remaining.join('\n');
      result.truncated = false;
    }

    if (offset > 0) {
      result.offset = offset;
    }
  }

  result.diff = diffOutput;
  return result as { diff: string; total_lines?: number; truncated?: boolean; offset?: number };
}

// Build a diff-like string with numbered lines for easy verification
function buildDiff(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `line-${i + 1}`).join('\n');
}

describe('lazy_diff pagination', () => {

  test('offset=10, max_lines=5 returns lines 11-15 from a 30-line diff', () => {
    const diff = buildDiff(30);
    const result = applyDiffPagination(diff, 10, 5);

    expect(result.total_lines).toBe(30);
    expect(result.truncated).toBe(true);
    expect(result.offset).toBe(10);

    const lines = result.diff.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('line-11');
    expect(lines[4]).toBe('line-15');
  });

  test('offset without max_lines returns remaining lines', () => {
    const diff = buildDiff(20);
    const result = applyDiffPagination(diff, 5, undefined);

    expect(result.total_lines).toBe(20);
    expect(result.truncated).toBe(false);
    expect(result.offset).toBe(5);

    const lines = result.diff.split('\n');
    expect(lines.length).toBe(15);
    expect(lines[0]).toBe('line-6');
    expect(lines[14]).toBe('line-20');
  });

  test('offset beyond total lines returns empty string', () => {
    const diff = buildDiff(10);
    const result = applyDiffPagination(diff, 9999, undefined);

    expect(result.total_lines).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.offset).toBe(9999);
    expect(result.diff).toBe('');
  });

  test('max_lines without offset truncates from the start', () => {
    const diff = buildDiff(20);
    const result = applyDiffPagination(diff, 0, 5);

    expect(result.total_lines).toBe(20);
    expect(result.truncated).toBe(true);
    expect(result.offset).toBeUndefined();

    const lines = result.diff.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('line-1');
    expect(lines[4]).toBe('line-5');
  });

  test('max_lines larger than total returns all lines', () => {
    const diff = buildDiff(5);
    const result = applyDiffPagination(diff, 0, 100);

    expect(result.total_lines).toBe(5);
    expect(result.truncated).toBe(false);

    const lines = result.diff.split('\n');
    expect(lines.length).toBe(5);
  });

  test('offset=0, no max_lines passes through unchanged', () => {
    const diff = buildDiff(10);
    const result = applyDiffPagination(diff, 0, undefined);

    // Neither offset nor max_lines triggers pagination
    expect(result.total_lines).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.offset).toBeUndefined();
    expect(result.diff).toBe(diff);
  });

  test('pagination works with trailing newline (common in git diff)', () => {
    // git diff output typically ends with a newline, producing an empty last element when split
    const diff = buildDiff(10) + '\n';
    const result = applyDiffPagination(diff, 8, 5);

    // 10 content lines + 1 empty trailing = 11 total
    expect(result.total_lines).toBe(11);
    expect(result.offset).toBe(8);

    const lines = result.diff.split('\n');
    // Lines 9, 10, and the trailing empty string = 3 lines
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('line-9');
    expect(lines[1]).toBe('line-10');
    expect(lines[2]).toBe('');
    expect(result.truncated).toBe(false);
  });

  test('sequential pagination covers all lines', () => {
    const diff = buildDiff(12);
    const pageSize = 5;

    // Page 1: lines 1-5
    const page1 = applyDiffPagination(diff, 0, pageSize);
    expect(page1.diff.split('\n')[0]).toBe('line-1');
    expect(page1.truncated).toBe(true);

    // Page 2: lines 6-10
    const page2 = applyDiffPagination(diff, 5, pageSize);
    expect(page2.diff.split('\n')[0]).toBe('line-6');
    expect(page2.truncated).toBe(true);

    // Page 3: lines 11-12
    const page3 = applyDiffPagination(diff, 10, pageSize);
    expect(page3.diff.split('\n')[0]).toBe('line-11');
    expect(page3.diff.split('\n').length).toBe(2);
    expect(page3.truncated).toBe(false);

    // Concatenating all pages recovers the original
    const reconstructed = [page1.diff, page2.diff, page3.diff].join('\n');
    expect(reconstructed).toBe(diff);
  });
});
