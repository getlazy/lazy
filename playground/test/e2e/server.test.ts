// End to end: start the real server as a subprocess on a free port and talk
// to it over HTTP, the way a browser or curl would.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ENTRY = resolve(import.meta.dir, '../../src/server.ts');

let server: ReturnType<typeof Bun.spawn>;
let dir: string;
let base: string;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linkshelf-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(['bun', 'run', ENTRY], {
    env: { ...process.env, PORT: String(port), DATABASE: join(dir, 'e2e.sqlite') },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // Not listening yet; try again shortly.
    }
    await Bun.sleep(50);
  }
  throw new Error('server did not come up within 5s');
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await rm(dir, { recursive: true, force: true });
});

describe('linkshelf over HTTP', () => {
  test('link creation is rate limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${base}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `https://example.com/${i}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every(s => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  test('shorten, follow, and read the stats', async () => {
    // Let the rate-limit window from the test above run out.
    await Bun.sleep(1000);

    const created = await fetch(`${base}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/e2e', slug: 'e2e' }),
    });
    expect(created.status).toBe(201);

    const visit = await fetch(`${base}/e2e`, { redirect: 'manual' });
    expect(visit.status).toBe(302);
    expect(visit.headers.get('location')).toBe('https://example.com/e2e');

    const stats = await (await fetch(`${base}/links/e2e/stats`)).json();
    expect(stats).toMatchObject({ slug: 'e2e', clicks: 1 });

    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('/e2e');
  });
});
