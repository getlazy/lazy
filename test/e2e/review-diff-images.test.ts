import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { symlink, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';
import { signInToDashboard, mintDashboardLoginUrl, type DashboardFetch } from '../helpers/dashboard-session';
import { solidPng } from '../helpers/png';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../src/review/image-preview';

/**
 * E2E for image files in a task's diff: the daemon's `diffBlob` read and the
 * dashboard route that serves it to an `<img>`.
 *
 * The fixture is every kind of change a screenshot retake produces — modified,
 * added, deleted — plus the three things a hostile branch would try: bytes that
 * lie about their extension, a symlink, and a blob too big to preview.
 */
describe('review diff: image previews', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let taskId = '';
  const BEFORE = solidPng(120, 80, [255, 0, 0]);
  const AFTER = solidPng(160, 90, [0, 0, 255]);
  const ADDED = solidPng(60, 40, [0, 255, 0]);
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>\n';

  beforeAll(async () => {
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' } });
    ({ base, fetch } = await signInToDashboard(ctx));

    await Bun.write(join(ctx.root, 'shot.png'), BEFORE);
    await Bun.write(join(ctx.root, 'gone.png'), BEFORE);
    await Bun.write(join(ctx.root, 'untouched.png'), BEFORE);
    expect(ctx.git('add', '.').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'Base images').exitCode).toBe(0);

    taskId = await createTask(ctx, 'Retake screenshots', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const wt = worktreePathFor(ctx.root, taskId);
    await Bun.write(join(wt, 'shot.png'), AFTER);
    await Bun.write(join(wt, 'added.png'), ADDED);
    await Bun.write(join(wt, 'icon.svg'), SVG);
    await Bun.write(join(wt, 'liar.png'), '<html><script>alert(1)</script></html>');
    const big = new Uint8Array(MAX_IMAGE_PREVIEW_BYTES + 16);
    big.set(ADDED);
    await Bun.write(join(wt, 'big.png'), big);
    await symlink(join(ctx.root, 'untouched.png'), join(wt, 'link.png'));
    await rm(join(wt, 'gone.png'));
    expect(ctx.git('-C', wt, 'add', '-A').exitCode).toBe(0);
    expect(ctx.git('-C', wt, 'commit', '-m', 'Retake').exitCode).toBe(0);
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  const blobUrl = (path: string, side: 'base' | 'head') =>
    `${base}/api/review/${taskId}/blob?path=${encodeURIComponent(path)}&side=${side}`;

  async function rpc(params: Record<string, unknown>) {
    const client = await DaemonClient.create(ctx.root);
    if (!client) throw new Error('daemon not reachable');
    return client.rpc('diffBlob', ctx.root, { taskId, ...params }) as Promise<Record<string, unknown>>;
  }

  async function rpcStatus(params: Record<string, unknown>): Promise<number> {
    try {
      await rpc(params);
      return 200;
    } catch (err) {
      if (err instanceof RpcApplicationError) return err.status;
      throw err;
    }
  }

  // INVARIANT: both sides are read at the refs the diff itself was rendered
  // from (resolveTaskDiffBase): base is the pre-image, head the post-image.
  test('the RPC returns the base and head bytes the diff compares', async () => {
    const before = await rpc({ path: 'shot.png', side: 'base' });
    expect(before.contentType).toBe('image/png');
    expect(Buffer.from(before.contentBase64 as string, 'base64').equals(Buffer.from(BEFORE))).toBe(true);
    const after = await rpc({ path: 'shot.png', side: 'head' });
    expect(Buffer.from(after.contentBase64 as string, 'base64').equals(Buffer.from(AFTER))).toBe(true);
    expect(after.size).toBe(AFTER.length);
    expect((await rpc({ path: 'gone.png', side: 'base' })).size).toBe(BEFORE.length);
  });

  // INVARIANT: the diff's file list is the authorization — an image elsewhere
  // in the repo, or on the side the change does not have, is not readable.
  test('refuses a path that is not in the diff, or not on that side', async () => {
    expect(await rpcStatus({ path: 'untouched.png', side: 'head' })).toBe(404);
    expect(await rpcStatus({ path: 'added.png', side: 'base' })).toBe(404);
    expect(await rpcStatus({ path: 'gone.png', side: 'head' })).toBe(404);
    expect(await rpcStatus({ path: '../escape.png', side: 'head' })).toBe(400);
  });

  // INVARIANT: a symlink is never followed and never served — its target could
  // be anywhere on the host.
  test('refuses a symlink', async () => {
    expect(await rpcStatus({ path: 'link.png', side: 'head' })).toBe(415);
  });

  test('the size cap holds', async () => {
    expect(await rpcStatus({ path: 'big.png', side: 'head' })).toBe(413);
  });

  test('bytes that do not match the extension are refused', async () => {
    expect(await rpcStatus({ path: 'liar.png', side: 'head' })).toBe(415);
  });

  test('the dashboard serves an image with its own type, nosniff and a sandbox CSP', async () => {
    const png = await fetch(blobUrl('shot.png', 'head'));
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await png.arrayBuffer()).equals(Buffer.from(AFTER))).toBe(true);

    const svg = await fetch(blobUrl('icon.svg', 'head'));
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toStartWith("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect((await fetch(blobUrl('big.png', 'head'))).status).toBe(413);
  });

  test('the Changes tab draws images through <img> instead of "Binary file — not shown"', async () => {
    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    const section = (path: string) => {
      const at = html.indexOf(`data-file="${path}"`);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</section>', at));
    };
    const shot = section('shot.png');
    expect(shot).toContain('image changed');
    expect(shot).toContain('Before');
    expect(shot).toContain('After');
    expect(shot).toContain('loading="lazy"');
    expect(shot).not.toContain('Binary file');
    expect(section('added.png')).toContain('image added');
    expect(section('gone.png')).toContain('image deleted');
    expect(section('gone.png')).toContain('side=base');
    // The SVG keeps its text diff and gains a picture, drawn only by <img>.
    const svg = section('icon.svg');
    expect(svg).toContain('<img');
    expect(svg).not.toMatch(/<(object|iframe|embed)\b/);
  });

  // Opt-in (`LAZY_SCREENSHOTS=1`): captures the Changes tab for review and
  // asserts nothing — the behaviour is pinned by the tests above.
  test('screenshots (opt-in)', async () => {
    if (process.env.LAZY_SCREENSHOTS !== '1') {
      console.log('skip: review-diff-images screenshots (set LAZY_SCREENSHOTS=1)');
      return;
    }
    const chrome = process.env.CHROME_BIN ?? 'chromium';
    for (const [name, size] of [['dashboard-diff-images.png', '1400,2700'], ['dashboard-diff-images-phone.png', '390,3600']]) {
      const { loginUrl } = await mintDashboardLoginUrl(ctx);
      const url = new URL(loginUrl);
      const target = `${url.origin}/tasks/${taskId}/changes${url.search}`;
      const proc = Bun.spawn([chrome, '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        `--window-size=${size}`, '--virtual-time-budget=8000', `--screenshot=${join('/tmp', name)}`, target],
        { stdout: 'ignore', stderr: 'ignore' });
      expect(await proc.exited).toBe(0);
    }
  }, 120_000);
});
