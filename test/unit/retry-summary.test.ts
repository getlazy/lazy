import { describe, test, expect } from 'bun:test';
import {
  formatErrorSnippet,
  formatRetrySummary,
  latestRetryError,
} from '../../src/utils/retry-summary';
import type { RetryError } from '../../src/protocol/types';

const err = (message: string, lastSeen: string, count = 1): RetryError => ({
  message,
  count,
  firstSeen: '2026-07-27T10:00:00.000Z',
  lastSeen,
});

describe('latestRetryError', () => {
  test('returns null for empty/absent error logs', () => {
    expect(latestRetryError(undefined)).toBeNull();
    expect(latestRetryError([])).toBeNull();
  });

  // INVARIANT: the deduplicated log bumps lastSeen in place, so array order does
  // NOT identify the most recent error — an early entry that keeps repeating is
  // the one a human needs to see.
  test('picks the most recent by lastSeen, not by array position', () => {
    const errors = [
      err('overloaded', '2026-07-27T10:05:00.000Z', 7),
      err('socket hang up', '2026-07-27T10:01:00.000Z'),
    ];
    expect(latestRetryError(errors)?.message).toBe('overloaded');
  });

  test('unparseable timestamps never win over a real one', () => {
    const errors = [err('bogus ts', 'not-a-date'), err('real', '2026-07-27T10:01:00.000Z')];
    expect(latestRetryError(errors)?.message).toBe('real');
  });
});

describe('formatErrorSnippet', () => {
  test('collapses whitespace and newlines to one line', () => {
    expect(formatErrorSnippet('API Error:\n  529   overloaded\n')).toBe('API Error: 529 overloaded');
  });

  test('truncates with an ellipsis at the limit', () => {
    const snippet = formatErrorSnippet('x'.repeat(200), 10);
    expect(snippet).toBe(`${'x'.repeat(9)}…`);
    expect(snippet.length).toBe(10);
  });

  test('leaves messages at or under the limit untouched', () => {
    expect(formatErrorSnippet('short', 10)).toBe('short');
  });
});

describe('formatRetrySummary', () => {
  test('returns null when there is nothing to report', () => {
    expect(formatRetrySummary(null)).toBeNull();
    expect(formatRetrySummary({})).toBeNull();
    expect(formatRetrySummary({ retryCount: 0 })).toBeNull();
  });

  test('attempt count alone when no errors are recorded', () => {
    expect(formatRetrySummary({ retryCount: 3 })).toBe('attempt 3');
  });

  test('includes the failure class and the latest error message', () => {
    expect(
      formatRetrySummary({
        retryCount: 7,
        retry_failure_class: 'transient_overload',
        errors: [err('API Error: 529 overloaded', '2026-07-27T10:05:00.000Z', 7)],
      }),
    ).toBe('attempt 7 (transient_overload): API Error: 529 overloaded');
  });

  test('honors the snippet limit for long error messages', () => {
    const summary = formatRetrySummary(
      { retryCount: 2, errors: [err('y'.repeat(200), '2026-07-27T10:05:00.000Z')] },
      12,
    );
    expect(summary).toBe(`attempt 2: ${'y'.repeat(11)}…`);
  });
});
