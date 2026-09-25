import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { symlink } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

/**
 * E2E for expanding unchanged context in the review diff.
 *
 * The point of the feature is that a reviewer can read the parts of a file that
 * are nowhere near a hunk — so the fixture is a long file with a single change
 * in the middle of it, and the assertions are about the lines the daemon serves
 * for the regions the diff does NOT show.
 *
 * The browser never reads git: everything the expand controls display comes
 * back from this endpoint, at the same refs the diff itself was rendered from.
 */
describe('review diff: expand unchanged context', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let taskId = '';
  const FILE = 'src/big.ts';
  const line = (n: number) => `export const line${n} = ${n};`;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));

    // A 60-line file on the base branch, so the task's own change has plenty of
    // unchanged context above and below it.
    const body = Array.from({ length: 60 }, (_, i) => line(i + 1)).join('\n') + '\n';
    await Bun.write(join(ctx.root, FILE), body);
    expect(ctx.git('add', FILE).exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'Add a long file').exitCode).toBe(0);

    taskId = await createTask(ctx, 'Expand context test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Change exactly one line, in the middle: lines 1..29 and 33..60 are only
    // reachable by expanding.
    const worktree = worktreePathFor(ctx.root, taskId);
    const changed = Array.from({ length: 60 }, (_, i) =>
      i + 1 === 30 ? 'export const line30 = 3000;' : line(i + 1),
    ).join('\n') + '\n';
    await Bun.write(join(worktree, FILE), changed);
    expect(ctx.git('-C', worktree, 'add', FILE).exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Change line 30').exitCode).toBe(0);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function reviewHtml(): Promise<string> {
    const deadline = Date.now() + 20_000;
    let html = '';
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/changes`);
      expect(res.status).toBe(200);
      html = await res.text();
      if (html.includes(FILE) && html.includes('data-side=')) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    return html;
  }

  test('serves the requested range of the post-image with real line numbers', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent(FILE)}&side=new&start=3&end=7`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.start).toBe(3);
    expect(data.end).toBe(7);
    expect(data.lines).toEqual([line(3), line(4), line(5), line(6), line(7)]);
    expect(data.totalLines).toBe(60);
    expect(data.atEof).toBe(false);
  });

  // INVARIANT: the bottom control cannot know where the file ends, so it asks
  // for more than exists. The endpoint clamps and reports EOF rather than
  // failing — that flag is what tells the browser to drop the control.
  test('clamps a range that runs past the end of the file and reports EOF', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent(FILE)}&side=new&start=58&end=1000`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.end).toBe(60);
    expect(data.lines).toEqual([line(58), line(59), line(60)]);
    expect(data.atEof).toBe(true);
  });

  test('serves the pre-image on the old side', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent(FILE)}&side=old&start=30&end=30`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual([line(30)]);
  });

  // INVARIANT: the diff's own file list is the authorization. This endpoint
  // reads a task worktree for a browser, so a path the reviewer is not already
  // looking at — and anything trying to escape the worktree — is refused at the
  // boundary rather than read and filtered later.
  test('refuses a file that is not part of the diff', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=lazy.toml&side=new&start=1&end=5`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('not part of this diff');
  });

  test('refuses a traversal path', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent('../../etc/passwd')}&side=new&start=1&end=5`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Refusing to read path');
  });

  test('refuses a nonsense range', async () => {
    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent(FILE)}&side=new&start=0&end=5`,
    );
    expect(res.status).toBe(400);
  });

  // INVARIANT: the diff's file list decides which PATH may be read; it cannot
  // decide which BYTES that path resolves to. A task branch is agent-writable,
  // so an agent can COMMIT a symlink to a host file — it is then legitimately
  // part of the diff, and a following read would hand the target's content to
  // the reviewer's browser. git renders a symlink as its target string, so that
  // string (the blob) is both the safe answer and the one matching the hunks.
  test('does not follow a symlink committed into the task branch', async () => {
    const worktree = worktreePathFor(ctx.root, taskId);
    const secret = join(ctx.root, 'not-in-the-worktree.txt');
    await Bun.write(secret, 'SUPER SECRET HOST CONTENT\n');
    await symlink(secret, join(worktree, 'src/evil.ts'));
    expect(ctx.git('-C', worktree, 'add', 'src/evil.ts').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add a symlink').exitCode).toBe(0);

    await reviewHtml();
    const res = await fetch(
      `${base}/api/review/${taskId}/file-lines?path=${encodeURIComponent('src/evil.ts')}&side=new&start=1&end=20`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(JSON.stringify(data.lines)).not.toContain('SUPER SECRET');
    // What comes back is the blob: the link target's PATH, exactly as the diff
    // renders it — one line, no trailing newline.
    expect(data.lines).toEqual([secret]);
  });

  test('the review page renders the expand controls for the changed file', async () => {
    const html = await reviewHtml();
    expect(html).toContain('class="rv-expand" hidden');
    expect(html).toContain(`data-file="${FILE}" data-start="1"`);
    expect(html).toContain('data-rv-expand-dir="up"');
    expect(html).toContain('data-rv-expand-dir="down"');
    expect(html).toContain('data-rv-expand-dir="all"');
    // The island needs somewhere to fetch from, and it is this task's endpoint.
    expect(html).toMatch(/\/api\/review\/[0-9a-f-]+\/file-lines/);
  });
});
