import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { Store } from '../src/store';

let store: Store;
let app: (req: Request) => Promise<Response>;

beforeEach(() => {
  store = new Store(':memory:');
  app = createApp(store);
});
afterEach(() => store.close());

const BASE = 'http://linkshelf.test';

function post(body: unknown): Promise<Response> {
  return app(new Request(`${BASE}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('routes', () => {
  test('creating a link returns its short address', async () => {
    const res = await post({ url: 'https://example.com/docs', slug: 'docs' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      slug: 'docs', url: 'https://example.com/docs', short: `${BASE}/docs`,
    });
  });

  test('a link without a slug gets a random one', async () => {
    const res = await post({ url: 'https://example.com' });
    const body = await res.json() as { slug: string };
    expect(body.slug).toMatch(/^[a-z2-9]{6}$/);
  });

  test('bad input is a 400, a taken slug a 409', async () => {
    expect((await post({ url: 'ftp://example.com' })).status).toBe(400);
    expect((await post({ url: 'https://example.com', slug: 'x' })).status).toBe(400);
    await post({ url: 'https://example.com', slug: 'docs' });
    expect((await post({ url: 'https://example.com', slug: 'docs' })).status).toBe(409);
  });

  test('visiting a short link redirects and counts the click', async () => {
    await post({ url: 'https://example.com/docs', slug: 'docs' });
    const res = await app(new Request(`${BASE}/docs`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/docs');
    const stats = await (await app(new Request(`${BASE}/links/docs/stats`))).json();
    expect(stats).toMatchObject({ slug: 'docs', clicks: 1 });
  });

  test('an unknown slug is a 404', async () => {
    expect((await app(new Request(`${BASE}/nope`))).status).toBe(404);
  });

  test('deleting a link', async () => {
    await post({ url: 'https://example.com/docs', slug: 'docs' });
    const del = await app(new Request(`${BASE}/links/docs`, { method: 'DELETE' }));
    expect(del.status).toBe(204);
    expect((await app(new Request(`${BASE}/docs`))).status).toBe(404);
  });

  test('the home page lists links and escapes them', async () => {
    await post({ url: 'https://example.com/?q=<b>', slug: 'search' });
    const page = await (await app(new Request(`${BASE}/`))).text();
    expect(page).toContain('/search');
    expect(page).toContain('?q=&lt;b&gt;');
    expect(page).not.toContain('<b>');
  });

  test('the form posts and redirects home', async () => {
    const res = await app(new Request(`${BASE}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'url=https%3A%2F%2Fexample.com&slug=home-link',
    }));
    expect(res.status).toBe(303);
    expect(store.getLink('home-link')).not.toBeNull();
  });
});
