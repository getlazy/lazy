import { describe, test, expect } from 'bun:test';
import {
  parseShellClientMessage,
  shellServerMessage,
  MIN_TERM_DIM,
  MAX_TERM_COLS,
  MAX_TERM_ROWS,
} from '../../src/server/shell-protocol';

// INVARIANT: the web-shell TEXT-frame parser is a system boundary — frames come
// from a browser (possibly hostile). Every field is validated and a malformed
// frame is REJECTED with a reason, never guessed at, and the parser never throws
// (one bad frame must not tear down a live shell). See CLAUDE.md "external
// surfaces validate inputs".
describe('parseShellClientMessage', () => {
  test('accepts a well-formed resize', () => {
    const res = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  test('accepts the boundary dimensions', () => {
    const min = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: MIN_TERM_DIM, rows: MIN_TERM_DIM }));
    expect(min.ok).toBe(true);
    const max = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: MAX_TERM_COLS, rows: MAX_TERM_ROWS }));
    expect(max.ok).toBe(true);
  });

  test('rejects a frame larger than 1024 bytes before parsing it', () => {
    const huge = 'x'.repeat(2000);
    const res = parseShellClientMessage(huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('too large');
  });

  test('rejects invalid JSON without throwing', () => {
    const res = parseShellClientMessage('{not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('valid JSON');
  });

  test('rejects a non-object JSON value', () => {
    for (const raw of ['42', '"resize"', 'null', 'true']) {
      const res = parseShellClientMessage(raw);
      expect(res.ok).toBe(false);
    }
  });

  test('rejects dimensions below the minimum', () => {
    const res = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: 1, rows: 24 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('dimensions');
  });

  test('rejects dimensions above the maximum', () => {
    const cols = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: MAX_TERM_COLS + 1, rows: 24 }));
    expect(cols.ok).toBe(false);
    const rows = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: 80, rows: MAX_TERM_ROWS + 1 }));
    expect(rows.ok).toBe(false);
  });

  test('rejects non-integer dimensions', () => {
    const frac = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 }));
    expect(frac.ok).toBe(false);
    const str = parseShellClientMessage(JSON.stringify({ type: 'resize', cols: '80', rows: 24 }));
    expect(str.ok).toBe(false);
  });

  test('rejects an unknown message type', () => {
    const res = parseShellClientMessage(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('unknown control message type');
  });
});

describe('shellServerMessage', () => {
  test('serializes each server message shape', () => {
    expect(JSON.parse(shellServerMessage({ type: 'ready', container: 'lazy-task-abc' }))).toEqual({
      type: 'ready',
      container: 'lazy-task-abc',
    });
    expect(JSON.parse(shellServerMessage({ type: 'exit', code: 0 }))).toEqual({ type: 'exit', code: 0 });
    expect(JSON.parse(shellServerMessage({ type: 'exit', code: null }))).toEqual({ type: 'exit', code: null });
    expect(JSON.parse(shellServerMessage({ type: 'error', message: 'boom' }))).toEqual({
      type: 'error',
      message: 'boom',
    });
  });
});
