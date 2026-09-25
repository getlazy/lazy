/**
 * parsePaginatedApiJson must not treat `][` inside a comment body as a page
 * boundary — that is how markdown reference links (`[text][ref]`) are written.
 */

import { describe, expect, test } from 'bun:test';
import { parsePaginatedApiJson } from '../../src/remote/paginated-json';

describe('parsePaginatedApiJson', () => {
  test('a comment body containing ][ and a newline stays one record', () => {
    const comment = {
      id: 1,
      body: 'see [the docs][ref]\nand more',
      html_url: 'https://github.com/o/r/pull/1#issuecomment-1',
    };
    const page2 = [{ id: 2, body: 'next page', html_url: 'https://example' }];
    const raw = JSON.stringify([comment]) + JSON.stringify(page2);

    const parsed = parsePaginatedApiJson(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.body).toBe('see [the docs][ref]\nand more');
    expect(parsed[1]!.body).toBe('next page');
  });

  test('slurped pages (array of arrays) flatten', () => {
    const slurped = [
      [{ id: 1, body: 'a' }],
      [{ id: 2, body: 'b' }],
    ];
    const parsed = parsePaginatedApiJson(JSON.stringify(slurped));
    expect(parsed.map((c) => c.id)).toEqual([1, 2]);
  });

  test('a single page array is unchanged', () => {
    const parsed = parsePaginatedApiJson(JSON.stringify([{ id: 7, body: 'only' }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(7);
  });

  test('empty input is an empty list', () => {
    expect(parsePaginatedApiJson('')).toEqual([]);
    expect(parsePaginatedApiJson('   ')).toEqual([]);
  });
});
