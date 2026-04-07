/**
 * Unit tests for CI failure sync.
 *
 * Tests the ciFailureSignature dedup logic and log truncation that prevent
 * duplicate CI failure comments during sync and keep comments manageable.
 */

import { describe, test, expect } from 'bun:test';
import { truncateLog } from '../../src/utils/log-truncate';
import { ciFailureSignature } from '../../src/daemon/remote-sync';

describe('ciFailureSignature', () => {
  // INVARIANT: Same failures produce the same signature, preventing duplicate comments.
  test('produces deterministic signature regardless of input order', () => {
    const failures1 = [
      { name: 'lint', url: 'https://ci.example.com/1' },
      { name: 'test', url: 'https://ci.example.com/2' },
    ];
    const failures2 = [
      { name: 'test', url: 'https://ci.example.com/2' },
      { name: 'lint', url: 'https://ci.example.com/1' },
    ];

    expect(ciFailureSignature(failures1)).toBe(ciFailureSignature(failures2));
  });

  // INVARIANT: Different failures produce different signatures, triggering new comments.
  test('produces different signatures for different failures', () => {
    const failures1 = [{ name: 'lint', url: 'https://ci.example.com/1' }];
    const failures2 = [{ name: 'test', url: 'https://ci.example.com/2' }];

    expect(ciFailureSignature(failures1)).not.toBe(ciFailureSignature(failures2));
  });

  // INVARIANT: Same check name with different URL (new run) produces a different signature.
  test('different URLs for same check name produce different signatures', () => {
    const run1 = [{ name: 'test', url: 'https://ci.example.com/runs/1' }];
    const run2 = [{ name: 'test', url: 'https://ci.example.com/runs/2' }];

    expect(ciFailureSignature(run1)).not.toBe(ciFailureSignature(run2));
  });

  test('handles failures without URLs', () => {
    const failures = [{ name: 'lint' }, { name: 'test' }];
    const sig = ciFailureSignature(failures);

    expect(sig).toBeTruthy();
    // Same input without URLs should still be deterministic
    expect(sig).toBe(ciFailureSignature([{ name: 'test' }, { name: 'lint' }]));
  });

  test('handles single failure', () => {
    const failures = [{ name: 'build', url: 'https://ci.example.com/42' }];
    const sig = ciFailureSignature(failures);

    expect(sig).toBe('build|https://ci.example.com/42');
  });

  test('handles empty array', () => {
    expect(ciFailureSignature([])).toBe('');
  });
});

describe('truncateLog', () => {
  // INVARIANT: Short logs are returned as-is — no unnecessary truncation.
  test('returns short logs unchanged', () => {
    const log = 'line 1\nline 2\nline 3';
    expect(truncateLog(log, 10)).toBe(log);
  });

  // INVARIANT: Long logs keep the last N lines (failures are at the end).
  test('truncates to last N lines', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const log = lines.join('\n');
    const result = truncateLog(log, 200);

    expect(result).toContain('line 300');
    expect(result).toContain('line 101');
    expect(result).not.toContain('\nline 100\n');
    expect(result).toStartWith('... (100 lines truncated)');
  });

  test('handles exact boundary', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const log = lines.join('\n');
    expect(truncateLog(log, 200)).toBe(log);
  });

  test('handles empty log', () => {
    expect(truncateLog('', 200)).toBe('');
  });
});
