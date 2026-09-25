/**
 * Unit tests for artifact name validation and bounds.
 *
 * These two modules are the whole safety story for artifacts: names are joined
 * onto a worktree path, and the bounds are what keeps a task's history from
 * growing without limit (the lesson the 677 MiB proxy audit log taught).
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeArtifactName,
  ArtifactNameError,
  guessMimeType,
  isBinaryContent,
} from '../../src/artifacts/name';
import {
  assertArtifactWithinLimits,
  ArtifactLimitError,
  MAX_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_COUNT,
  formatArtifactBytes,
} from '../../src/artifacts/limits';

describe('normalizeArtifactName', () => {
  test('keeps a relative POSIX path', () => {
    expect(normalizeArtifactName('design/index.html')).toBe('design/index.html');
  });

  test('normalizes ./, duplicate and trailing slashes, and backslashes', () => {
    expect(normalizeArtifactName('./design//index.html')).toBe('design/index.html');
    expect(normalizeArtifactName('design/sub/')).toBe('design/sub');
    expect(normalizeArtifactName('design\\index.html')).toBe('design/index.html');
    expect(normalizeArtifactName('  report.md  ')).toBe('report.md');
  });

  // INVARIANT: a name is joined onto a worktree path at materialization time,
  // so escaping it is a write-anywhere primitive for whoever attaches the file.
  // These must THROW, never be silently rewritten into something safe — a
  // caller who asked for '../x' wants something we cannot give them, and
  // quietly writing 'x' puts a file where they did not ask for it.
  test('rejects names that could escape the artifact root', () => {
    for (const bad of ['/etc/passwd', '../secrets', 'design/../../etc/passwd', 'C:/win.ini']) {
      expect(() => normalizeArtifactName(bad)).toThrow(ArtifactNameError);
    }
  });

  test('rejects empty, dot-only and NUL-bearing names', () => {
    for (const bad of ['', '   ', '.', './', 'a\0b']) {
      expect(() => normalizeArtifactName(bad)).toThrow(ArtifactNameError);
    }
  });

  test('rejects an over-long name', () => {
    expect(() => normalizeArtifactName('a'.repeat(500))).toThrow(ArtifactNameError);
  });
});

describe('guessMimeType / isBinaryContent', () => {
  test('maps known extensions', () => {
    expect(guessMimeType('design/index.html', false)).toBe('text/html');
    expect(guessMimeType('shot.PNG', true)).toBe('image/png');
  });

  test('falls back to the text/binary verdict for unknown extensions', () => {
    expect(guessMimeType('data.unknownext', false)).toBe('text/plain');
    expect(guessMimeType('blob', true)).toBe('application/octet-stream');
    expect(guessMimeType('noextension', false)).toBe('text/plain');
  });

  test('sniffs text vs binary', () => {
    expect(isBinaryContent(Buffer.from('hello — unicode is text', 'utf-8'))).toBe(false);
    expect(isBinaryContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))).toBe(true);
    // Valid UTF-8 apart from a NUL is still binary: a NUL never appears in text.
    expect(isBinaryContent(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    // Invalid UTF-8 with no NUL is binary too.
    expect(isBinaryContent(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true);
  });
});

describe('assertArtifactWithinLimits', () => {
  test('accepts a file inside every bound', () => {
    expect(() => assertArtifactWithinLimits('a.txt', 1024, [])).not.toThrow();
  });

  test('rejects a file over the per-artifact limit', () => {
    expect(() => assertArtifactWithinLimits('big.bin', MAX_ARTIFACT_BYTES + 1, []))
      .toThrow(ArtifactLimitError);
  });

  test('rejects an attach that would breach the per-task total', () => {
    const existing = [{ name: 'a', size: MAX_TASK_ARTIFACT_BYTES - 10 }];
    expect(() => assertArtifactWithinLimits('b', 100, existing)).toThrow(ArtifactLimitError);
  });

  // INVARIANT: a REPLACE frees the outgoing artifact's bytes before the total
  // is checked. Replacing a 900 KB file with another 900 KB one is not growth,
  // and failing it would make a near-full task impossible to correct.
  test('a replacement frees the old bytes before checking the total', () => {
    // A task sitting exactly at the per-task total, one of whose artifacts is a
    // full-size file.
    const existing = [
      { name: 'a', size: MAX_ARTIFACT_BYTES },
      { name: 'b', size: MAX_TASK_ARTIFACT_BYTES - MAX_ARTIFACT_BYTES },
    ];
    expect(() => assertArtifactWithinLimits('a', MAX_ARTIFACT_BYTES, existing)).not.toThrow();
    // …while any NEW byte at that total is refused.
    expect(() => assertArtifactWithinLimits('c', 1, existing)).toThrow(ArtifactLimitError);
  });

  test('rejects an attach past the per-task count, but allows replacing one', () => {
    const existing = Array.from({ length: MAX_TASK_ARTIFACT_COUNT }, (_, i) => ({ name: `a${i}`, size: 1 }));
    expect(() => assertArtifactWithinLimits('new', 1, existing)).toThrow(ArtifactLimitError);
    expect(() => assertArtifactWithinLimits('a0', 1, existing)).not.toThrow();
  });

  test('errors name the actual numbers', () => {
    try {
      assertArtifactWithinLimits('big.bin', MAX_ARTIFACT_BYTES + 1, []);
      throw new Error('expected a limit error');
    } catch (err) {
      expect((err as Error).message).toContain(formatArtifactBytes(MAX_ARTIFACT_BYTES));
    }
  });
});
