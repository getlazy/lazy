/**
 * Unit tests for CLI raised-resolution flag parsing.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseIdEqualsValue,
  parseIdOrIdEquals,
  resolutionsFromFlags,
} from '../../src/cli/raised-resolutions';

describe('raised-resolutions CLI helpers', () => {
  test('parseIdEqualsValue splits on the first equals', () => {
    expect(parseIdEqualsValue('abc12345=use a=b', '--respond-raised')).toEqual({
      id: 'abc12345',
      response: 'use a=b',
    });
  });

  test('parseIdEqualsValue refuses missing id or text', () => {
    expect(() => parseIdEqualsValue('=no-id', '--respond-raised')).toThrow();
    expect(() => parseIdEqualsValue('onlyid', '--respond-raised')).toThrow();
    expect(() => parseIdEqualsValue('id=', '--respond-raised')).toThrow();
  });

  test('parseIdOrIdEquals accepts a bare id or an optional note', () => {
    expect(parseIdOrIdEquals('abc12345', '--promote-raised-subtask')).toEqual({
      id: 'abc12345',
    });
    expect(parseIdOrIdEquals('abc12345=work it next', '--promote-raised-peer')).toEqual({
      id: 'abc12345',
      response: 'work it next',
    });
  });

  test('resolutionsFromFlags returns undefined when no raised flags', () => {
    expect(resolutionsFromFlags(new Map())).toBeUndefined();
  });

  test('resolutionsFromFlags builds respond / promote / dismiss', () => {
    const flags = new Map<string, string | boolean | string[]>([
      ['respond-raised', ['aaaaaaaa=ship it']],
      ['promote-raised-subtask', ['bbbbbbbb']],
      ['promote-raised-peer', ['cccccccc=track separately']],
      ['dismiss-raised', ['dddddddd=noise']],
    ]);
    const res = resolutionsFromFlags(flags);
    expect(res).toEqual([
      { id: 'aaaaaaaa', action: 'respond', response: 'ship it' },
      { id: 'bbbbbbbb', action: 'promote_subtask' },
      { id: 'cccccccc', action: 'promote_peer', response: 'track separately' },
      { id: 'dddddddd', action: 'dismiss', response: 'noise' },
    ]);
  });
});
