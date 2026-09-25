import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Store } from '../src/store';

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => store.close());

describe('store', () => {
  test('a slug can only be taken once', () => {
    expect(store.createLink('docs', 'https://example.com/docs')).toBe(true);
    expect(store.createLink('docs', 'https://example.com/other')).toBe(false);
    expect(store.getLink('docs')?.url).toBe('https://example.com/docs');
  });

  test('links list newest first', () => {
    store.createLink('first', 'https://example.com/1', 1_000);
    store.createLink('second', 'https://example.com/2', 2_000);
    expect(store.listLinks().links.map(l => l.slug)).toEqual(['second', 'first']);
  });

  test('listing pages through the links', () => {
    for (let i = 0; i < 5; i++) store.createLink(`link-${i}`, 'https://example.com', i);
    const first = store.listLinks(1, 2);
    const second = store.listLinks(2, 2);
    const third = store.listLinks(3, 2);
    expect(first.links.map(l => l.slug)).toEqual(['link-4', 'link-3']);
    expect(second.links.map(l => l.slug)).toEqual(['link-2', 'link-1']);
    expect(third.links.map(l => l.slug)).toEqual(['link-0']);
    expect(first.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
  });

  test('stats count clicks and remember the last one', () => {
    store.createLink('docs', 'https://example.com/docs');
    expect(store.stats('docs')).toMatchObject({ clicks: 0, lastClickedAt: null });
    store.recordClick('docs', 5_000);
    store.recordClick('docs', 9_000);
    expect(store.stats('docs')).toMatchObject({ clicks: 2, lastClickedAt: 9_000 });
  });

  test('deleting a link deletes its clicks', () => {
    store.createLink('docs', 'https://example.com/docs');
    store.recordClick('docs');
    expect(store.deleteLink('docs')).toBe(true);
    expect(store.stats('docs')).toBeNull();
    const left = store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM clicks').get()!;
    expect(left.n).toBe(0);
  });
});
