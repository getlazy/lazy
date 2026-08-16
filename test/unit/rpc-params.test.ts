/**
 * Unit tests for the daemon RPC parameter accessors (src/daemon/rpc-params.ts).
 *
 * INVARIANT — every external surface parses and confirms its inputs. `POST
 * /rpc/:command` read its parameters with blind casts (`params.taskId as
 * string`), which check nothing at runtime: the presence checks that followed
 * caught an ABSENT value but passed a wrong-TYPED one straight through to the
 * lifecycle functions. Same defect class as the MCP route's missing envelope,
 * which let `undefined` reach `git commit -m`.
 *
 * The status is part of the contract, not decoration: a caller's bad argument
 * must arrive as 400. A 500 sends the operator to debug the daemon.
 */

import { describe, test, expect } from 'bun:test';
import {
  requireString,
  requireNonBlankString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
  optionalEnum,
} from '../../src/daemon/rpc-params';
import { RpcError } from '../../src/daemon/rpc-error';

/** Run `fn` and return the RpcError it threw, failing if it threw nothing. */
function caught(fn: () => unknown): RpcError {
  try {
    fn();
  } catch (err) {
    if (err instanceof RpcError) return err;
    throw err;
  }
  throw new Error('expected an RpcError, but nothing was thrown');
}

describe('requireString', () => {
  test('returns the value when present', () => {
    expect(requireString({ taskId: 'abc' }, 'taskId')).toBe('abc');
  });

  // The wording predates this module and several tests pin it — absent, null
  // and empty must all keep saying "<name> is required".
  test('rejects absent, null and empty with the established wording', () => {
    for (const params of [{}, { taskId: null }, { taskId: '' }]) {
      const err = caught(() => requireString(params, 'taskId'));
      expect(err.status).toBe(400);
      expect(err.message).toBe('taskId is required');
    }
  });

  // THE GAP THIS CLOSES: `!value` is false for 42, so a wrong-typed id used to
  // pass the presence check and reach `.substring()` — a caller's mistake
  // surfacing as an HTTP 500.
  test('rejects a wrong-typed value with a 400 naming the type it got', () => {
    expect(caught(() => requireString({ taskId: 42 }, 'taskId')).message)
      .toBe('taskId must be a string, got number');
    expect(caught(() => requireString({ taskId: ['a'] }, 'taskId')).message)
      .toBe('taskId must be a string, got array');
    expect(caught(() => requireString({ taskId: { id: 'a' } }, 'taskId')).message)
      .toBe('taskId must be a string, got object');
  });
});

describe('requireNonBlankString', () => {
  test('accepts a string with content and rejects whitespace-only', () => {
    expect(requireNonBlankString({ reason: ' ok ' }, 'reason')).toBe(' ok ');
    expect(caught(() => requireNonBlankString({ reason: '   ' }, 'reason')).message)
      .toBe('reason is required');
  });
});

describe('optionalString', () => {
  test('treats absent and null as not supplied', () => {
    expect(optionalString({}, 'reason')).toBeUndefined();
    expect(optionalString({ reason: null }, 'reason')).toBeUndefined();
  });

  // An EMPTY optional string is a real value, not an absence — `--reason ''`
  // must not silently become "no reason given".
  test('passes an empty string through', () => {
    expect(optionalString({ reason: '' }, 'reason')).toBe('');
  });

  test('rejects a wrong-typed value', () => {
    expect(caught(() => optionalString({ reason: 7 }, 'reason')).status).toBe(400);
  });
});

describe('optionalBoolean', () => {
  test('accepts booleans and absence', () => {
    expect(optionalBoolean({ force: true }, 'force')).toBe(true);
    expect(optionalBoolean({ force: false }, 'force')).toBe(false);
    expect(optionalBoolean({}, 'force')).toBeUndefined();
  });

  // A truthy string is NOT a boolean. Coercing "false" to true is exactly the
  // kind of helpful guess that produces a destructive action nobody asked for.
  test('rejects a string rather than coercing it', () => {
    expect(caught(() => optionalBoolean({ force: 'false' }, 'force')).message)
      .toBe('force must be a boolean, got string');
  });
});

describe('optionalNumber', () => {
  test('accepts a finite number and absence', () => {
    expect(optionalNumber({ timeout: 30 }, 'timeout')).toBe(30);
    expect(optionalNumber({}, 'timeout')).toBeUndefined();
  });

  test('rejects a numeric string and a non-finite number', () => {
    expect(caught(() => optionalNumber({ timeout: '30' }, 'timeout')).status).toBe(400);
    expect(caught(() => optionalNumber({ timeout: NaN }, 'timeout')).status).toBe(400);
  });
});

describe('optionalStringArray', () => {
  test('accepts an array of strings and absence', () => {
    expect(optionalStringArray({ approvedFiles: ['a.ts', 'b.ts'] }, 'approvedFiles'))
      .toEqual(['a.ts', 'b.ts']);
    expect(optionalStringArray({}, 'approvedFiles')).toBeUndefined();
  });

  // approvedFiles drives file-permission decisions on accept: a non-string
  // element compares unequal to every real path, so it would silently fail to
  // approve the file the caller meant instead of reporting the mistake.
  test('names the offending index when an element is not a string', () => {
    expect(caught(() => optionalStringArray({ approvedFiles: ['a.ts', 3] }, 'approvedFiles')).message)
      .toBe('approvedFiles[1] must be a string, got number');
  });

  test('rejects a bare string that was meant to be a list', () => {
    expect(caught(() => optionalStringArray({ approvedFiles: 'a.ts' }, 'approvedFiles')).message)
      .toBe('approvedFiles must be an array of strings, got string');
  });
});

describe('optionalEnum', () => {
  const ACTORS = ['human', 'builder', 'agent'] as const;

  test('accepts a known value and absence', () => {
    expect(optionalEnum({ actor: 'human' }, 'actor', ACTORS)).toBe('human');
    expect(optionalEnum({}, 'actor', ACTORS)).toBeUndefined();
  });

  // `params.actor as Actor` used to admit any string, so an unrecognized actor
  // reached a turn record and was attributed to an actor that does not exist.
  test('rejects an unknown value and lists what is allowed', () => {
    const err = caught(() => optionalEnum({ actor: 'robot' }, 'actor', ACTORS));
    expect(err.status).toBe(400);
    expect(err.message).toContain("Invalid actor: 'robot'");
    expect(err.message).toContain('human, builder, agent');
  });
});
