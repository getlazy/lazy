/**
 * Unit tests for the accept-remedy contract.
 *
 * The remedy is composed by the daemon and rendered by clients, so the two
 * things worth pinning here are the transport boundary (a malformed remedy must
 * degrade to "no remedy", never to a half-rendered one) and command
 * composition (the whole point is that the human does not retype 43 flags).
 */

import { describe, test, expect } from 'bun:test';
import { parseAcceptRemedy, acceptRemedyOf } from '../../src/types/accept-remedy';
import {
  acceptRefusal,
  AcceptRefusedError,
  acceptWithApprovedFilesCommand,
  shellQuote,
} from '../../src/daemon/accept-refusal';

describe('parseAcceptRemedy', () => {
  test('accepts a well-formed remedy', () => {
    const remedy = parseAcceptRemedy({
      reason: 'approval-required',
      next: 'Approve it.',
      command: 'lazy accept abc',
      uiAction: 'passphrase',
      files: ['a.ts', 'b.ts'],
    });
    expect(remedy).toEqual({
      reason: 'approval-required',
      next: 'Approve it.',
      command: 'lazy accept abc',
      uiAction: 'passphrase',
      files: ['a.ts', 'b.ts'],
    });
  });

  // INVARIANT: an unrecognized reason yields NO remedy rather than a partly
  // rendered one. The page then shows the daemon's message verbatim, which is
  // the honest fallback — never an invented next step.
  test('rejects an unknown reason', () => {
    expect(parseAcceptRemedy({ reason: 'something-new', next: 'Do it.' })).toBeUndefined();
  });

  test('rejects a missing or blank next step', () => {
    expect(parseAcceptRemedy({ reason: 'working' })).toBeUndefined();
    expect(parseAcceptRemedy({ reason: 'working', next: '   ' })).toBeUndefined();
  });

  test('drops unusable optional fields instead of passing them through', () => {
    const remedy = parseAcceptRemedy({
      reason: 'working',
      next: 'Wait.',
      command: '   ',
      uiAction: 'launch-missiles',
      files: [1, 'ok.ts'],
    });
    expect(remedy).toEqual({ reason: 'working', next: 'Wait.', files: ['ok.ts'] });
  });

  test('non-objects are simply no remedy', () => {
    expect(parseAcceptRemedy(undefined)).toBeUndefined();
    expect(parseAcceptRemedy('lazy accept abc')).toBeUndefined();
    expect(parseAcceptRemedy(null)).toBeUndefined();
  });
});

describe('acceptRemedyOf', () => {
  test('reads the remedy off a daemon-side refusal', () => {
    const err = acceptRefusal(403, 'refused', { reason: 'approval-required', next: 'Approve it.' });
    expect(err).toBeInstanceOf(AcceptRefusedError);
    expect(err.status).toBe(403);
    expect(acceptRemedyOf(err)?.reason).toBe('approval-required');
  });

  test('an ordinary error has no remedy', () => {
    expect(acceptRemedyOf(new Error('boom'))).toBeUndefined();
  });
});

describe('command composition', () => {
  test('enumerates every file as its own --approve-file flag', () => {
    expect(acceptWithApprovedFilesCommand('abc123', ['src/a.ts', 'src/b.ts'])).toBe(
      'lazy accept abc123 --approve-file src/a.ts --approve-file src/b.ts',
    );
  });

  test('no files means a bare accept, not a trailing space', () => {
    expect(acceptWithApprovedFilesCommand('abc123', [])).toBe('lazy accept abc123');
  });

  // A path with a space is exactly where hand-reconstruction breaks, so the
  // composed command has to survive being pasted.
  test('quotes paths that the shell would otherwise split', () => {
    expect(shellQuote('src/plain-path.ts')).toBe('src/plain-path.ts');
    expect(shellQuote('docs/my notes.md')).toBe("'docs/my notes.md'");
    expect(shellQuote("it's.md")).toBe(String.raw`'it'\''s.md'`);
    expect(acceptWithApprovedFilesCommand('abc', ['a b.ts'])).toBe("lazy accept abc --approve-file 'a b.ts'");
  });
});
