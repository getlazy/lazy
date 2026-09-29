/**
 * E2E for the task page's Artifacts tab, through the real dashboard server:
 * list (with the strip badge), preview, download, and upload of an input file.
 *
 * Artifacts were reachable only from `lazy artifact` and the MCP tools; the tab
 * reads and writes the same store, so a file attached on one surface must show
 * on the other.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { signInToDashboard, dashboardFetch, type DashboardFetch } from '../helpers/dashboard-session';

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('web task page: Artifacts tab', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function upload(id: string, file: File, name?: string): Promise<Response> {
    const form = new FormData();
    form.set('file', file);
    if (name) form.set('name', name);
    return fetch(`${base}/tasks/${id}/artifacts/upload`, { method: 'POST', body: form, redirect: 'manual' });
  }

  test('lists CLI-attached artifacts with a badge, and previews text and markdown', async () => {
    const id = await createTask(ctx, 'Artifacts list', 'Do work');
    await writeFile(join(ctx.root, 'notes.md'), '# Findings\n\nAll **good**.');
    await writeFile(join(ctx.root, 'log.txt'), 'line <one>\n');
    const add = await ctx.lazy(['artifact', 'add', id, 'notes.md', '--origin', 'output']);
    expect(add.exitCode).toBe(0);
    expect((await ctx.lazy(['artifact', 'add', id, 'log.txt'])).exitCode).toBe(0);

    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toMatch(/data-lz-tab="artifacts"[^>]*>Artifacts <span class="lz-tab-badge">2<\/span>/);

    const tab = await (await fetch(`${base}/tasks/${id}/artifacts`)).text();
    expect(tab).toContain('Artifacts (2)');
    expect(tab).toContain('data-artifact-name="notes.md"');
    expect(tab).toContain('>output<');
    expect(tab).toContain('>input<');
    // Markdown rendered, plain text escaped — never raw.
    expect(tab).toContain('<strong>good</strong>');
    expect(tab).toContain('line &lt;one&gt;');
    expect(tab).toContain('/artifacts/file?name=log.txt&amp;download=1');
  });

  test('uploading from the page attaches an input the CLI sees, and the image previews inline', async () => {
    const id = await createTask(ctx, 'Artifacts upload', 'Do work');
    const res = await upload(id, new File([PNG], 'shot.png', { type: 'image/png' }), 'shots/home.png');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/artifacts?uploaded=');

    const list = await ctx.lazy(['artifact', 'list', id]);
    expect(list.stdout).toContain('shots/home.png');
    expect(list.stdout).toContain('input');

    const tab = await (await fetch(`${base}/tasks/${id}/artifacts?uploaded=shots%2Fhome.png`)).text();
    expect(tab).toContain('Uploaded shots/home.png');
    expect(tab).toContain('<img class="lz-artifact-image" src="/tasks/');

    const inline = await fetch(`${base}/tasks/${id}/artifacts/file?name=shots%2Fhome.png`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect(inline.headers.get('content-disposition')).toStartWith('inline;');
    expect(Buffer.from(await inline.arrayBuffer()).equals(PNG)).toBe(true);

    // Re-uploading the same name replaces it, and the page says so.
    const again = await upload(id, new File([PNG], 'shot.png', { type: 'image/png' }), 'shots/home.png');
    expect(again.headers.get('location')).toContain('/artifacts?replaced=');
    const replacedTab = await (await fetch(`${base}${new URL(again.headers.get('location')!).pathname}${new URL(again.headers.get('location')!).search}`)).text();
    expect(replacedTab).toContain('Replaced shots/home.png');
  });

  // INVARIANT: artifact bytes never run on the dashboard's origin. HTML and SVG
  // are agent-writable documents that could script against the reviewer's
  // session, so anything that is not a raster image is served as an attachment
  // with nosniff and a sandbox CSP — and the tab shows HTML as escaped source.
  test('HTML and SVG download as inert attachments, never inline', async () => {
    const id = await createTask(ctx, 'Artifacts safety', 'Do work');
    const payload = '<script>alert(1)</script>';
    expect((await upload(id, new File([payload], 'page.html', { type: 'text/html' }))).status).toBe(303);
    expect((await upload(id, new File([`<svg xmlns="http://www.w3.org/2000/svg">${payload}</svg>`], 'x.svg'))).status).toBe(303);

    for (const name of ['page.html', 'x.svg']) {
      const res = await fetch(`${base}/tasks/${id}/artifacts/file?name=${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toStartWith('attachment;');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      // The route's own policy must not displace the dashboard's framing guard.
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    const tab = await (await fetch(`${base}/tasks/${id}/artifacts`)).text();
    expect(tab).not.toContain(payload);
    expect(tab).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('a bad name is refused with the store\'s own reason; bytes need the dashboard session', async () => {
    const id = await createTask(ctx, 'Artifacts refusal', 'Do work');
    const res = await upload(id, new File(['x'], 'a.txt'), '../escape.txt');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('upload_error=');
    expect((await ctx.lazy(['artifact', 'list', id])).stdout).not.toContain('escape');
    const badRead = await fetch(`${base}/tasks/${id}/artifacts/file?name=..%2Fx`);
    expect(badRead.status).toBe(400);

    expect((await upload(id, new File(['hello'], 'a.txt'))).status).toBe(303);
    // No session cookie: the dashboard guard answers, not the artifact.
    const anon = await dashboardFetch(`${base}/tasks/${id}/artifacts/file?name=a.txt&download=1`, { redirect: 'manual' });
    expect(anon.status).not.toBe(200);
    const signedIn = await fetch(`${base}/tasks/${id}/artifacts/file?name=a.txt&download=1`);
    expect(await signedIn.text()).toBe('hello');
  });
});
