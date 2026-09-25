// The HTTP routes. `createApp` returns a plain fetch handler, so the tests can
// call it directly without opening a port.
//
//   GET    /                     home page: a form and the newest links
//   POST   /links                create a link (JSON or an HTML form post)
//   GET    /links?page=N         list links as JSON, newest first
//   GET    /links/:slug/stats    stats (JSON, or HTML when the browser asks)
//   DELETE /links/:slug          delete a link
//   GET    /:slug                redirect to the link's target
//   GET    /healthz              "ok"

import { homePage, statsPage } from './html';
import { RateLimiter } from './rate-limit';
import { isValidSlug, isValidTarget, normalizeSlug, randomSlug } from './slug';
import type { Store } from './store';

export interface AppOptions {
  /** Link creations allowed per second. */
  createsPerSecond?: number;
}

export function createApp(store: Store, options: AppOptions = {}): (req: Request) => Promise<Response> {
  const limiter = new RateLimiter(options.createsPerSecond ?? 20);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/healthz') return new Response('ok');

    if (method === 'GET' && path === '/') {
      return html(homePage(store.listLinks(1).links));
    }

    if (method === 'POST' && path === '/links') {
      if (!limiter.allow()) return json({ error: 'too many links created, slow down' }, 429);

      const input = await readInput(req);
      if (!input.url || !isValidTarget(input.url)) {
        return json({ error: 'url must be an http(s) URL' }, 400);
      }

      let slug: string;
      if (input.slug) {
        if (!isValidSlug(input.slug)) {
          return json({ error: 'slug must be 3-32 letters, digits or dashes' }, 400);
        }
        slug = normalizeSlug(input.slug);
        if (!store.createLink(slug, input.url)) return json({ error: `slug "${slug}" is taken` }, 409);
      } else {
        slug = randomSlug();
        while (!store.createLink(slug, input.url)) slug = randomSlug();
      }

      if (input.fromForm) return Response.redirect(new URL('/', url).toString(), 303);
      return json({ slug, url: input.url, short: new URL(`/${slug}`, url).toString() }, 201);
    }

    if (method === 'GET' && path === '/links') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      return json(store.listLinks(page));
    }

    const statsMatch = /^\/links\/([^/]+)\/stats$/.exec(path);
    if (method === 'GET' && statsMatch) {
      const stats = store.stats(statsMatch[1]!);
      if (!stats) return json({ error: 'no such link' }, 404);
      if (req.headers.get('accept')?.includes('text/html')) return html(statsPage(stats));
      return json(stats);
    }

    const deleteMatch = /^\/links\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && deleteMatch) {
      return store.deleteLink(deleteMatch[1]!) ? new Response(null, { status: 204 }) : json({ error: 'no such link' }, 404);
    }

    const slugMatch = /^\/([^/]+)$/.exec(path);
    if (method === 'GET' && slugMatch) {
      const link = store.getLink(slugMatch[1]!);
      if (!link) return json({ error: 'no such link' }, 404);
      store.recordClick(link.slug);
      return Response.redirect(link.url, 302);
    }

    return json({ error: 'not found' }, 404);
  };
}

interface CreateInput { url?: string; slug?: string; fromForm: boolean }

async function readInput(req: Request): Promise<CreateInput> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData();
    const slug = String(form.get('slug') ?? '').trim();
    return { url: String(form.get('url') ?? '').trim(), slug: slug || undefined, fromForm: true };
  }
  try {
    const body = (await req.json()) as { url?: unknown; slug?: unknown };
    return {
      url: typeof body.url === 'string' ? body.url : undefined,
      slug: typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined,
      fromForm: false,
    };
  } catch {
    // A body that is not JSON is the same as a body with no url in it: a 400.
    return { fromForm: false };
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
