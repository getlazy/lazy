/**
 * A task whose work ALL came from accepted children — a landing hub, a
 * finished cluster — shows its changes.
 *
 * Reproduces the report of a landing hub whose dashboard Changes tab said
 * "11 regions" and listed none, whose `lazy_diff` answered only a comment
 * count, and whose headline was the walkthrough its own setup turn filed
 * before any child landed ("Landing hub — no changes yet"), while the branch
 * carried 60 files from seven accepted children.
 *
 * INVARIANT: every surface — `lazy diff`, `lazy_diff`, the web Changes tab —
 * shows a task's WHOLE branch, accepted children included, through the one
 * shared diff resolver (engineer decision 2026-09-25, reversing the 2026-09-07
 * hub exclusion). Per-child views are review regions; size is handled by the
 * progressive Changes tab, exercised at release scale below.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { worktreePathFor } from '../helpers/storage';
import { seedFinal } from '../helpers/final';
import { signInToDashboard, mintDashboardLoginUrl, type DashboardFetch } from '../helpers/dashboard-session';
import { runMcpSession } from '../helpers/mcp-session';
import { browserSuiteSkipped, launchBrowser } from '../helpers/cdp-browser';

const STALE_HEADLINE = 'Landing hub — no changes yet';

async function waitFor(ctx: TestContext, taskId: string): Promise<void> {
  // `lazy wait` can return while the task still reads `working` (a daemon
  // wait race outside this suite's subject — raised separately). Waiting
  // again is what a person would do; only a non-working status ends it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await ctx.lazy(['wait', taskId]);
    if (result.exitCode === 0) return;
    if (!result.stdout.includes('is now working')) {
      throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
    }
  }
  throw new Error(`wait for ${taskId} kept returning while the task was still working`);
}

async function addCommit(ctx: TestContext, taskId: string, file: string, body: string) {
  const worktree = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktree, file), body);
  expect(ctx.git('-C', worktree, 'add', file).exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', `Add ${file}`).exitCode).toBe(0);
}

/**
 * A hub that commits nothing itself, files a walkthrough of its empty branch
 * on its setup turn, and then has two children accepted into it.
 */
async function landingHub(ctx: TestContext): Promise<{ hubId: string; childCodes: string[] }> {
  const hubId = await createTask(ctx, 'Landing hub', 'Land the children');
  // No LAZY_MOCK_SHOULD_COMMIT anywhere: the hub's own turn writes nothing.
  expectSuccess(await ctx.lazyMocked(['start', hubId, '--yes'], MOCK_CLAUDE_SUCCESS));
  await waitFor(ctx, hubId);

  // The setup turn's walkthrough — written at a head the branch then leaves.
  await runMcpSession(ctx.root, hubId, worktreePathFor(ctx.root, hubId), [
    { method: 'initialize', id: 1, params: {} },
    {
      method: 'tools/call',
      id: 2,
      params: {
        name: 'lazy_report',
        arguments: {
          sections: [{ kind: 'implementation', body: STALE_HEADLINE }],
          presentation: {
            groups: [{ title: STALE_HEADLINE, tier: 'core', items: [{ kind: 'prose', body: STALE_HEADLINE }] }],
          },
        },
      },
    },
  ]);

  const childCodes: string[] = [];
  for (const name of ['alpha', 'beta']) {
    const created = await ctx.lazy([
      'create', '--goal', `Child ${name}`, '--prompt', `Add ${name}`, '--parent', hubId,
    ]);
    expectSuccess(created);
    const childId = extractTaskId(created.stdout);
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitFor(ctx, childId);
    await addCommit(ctx, childId, `child-${name}.txt`, `from ${name}\n`);
    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, childId);
    expectSuccess(await ctx.lazy(['accept', childId, '--yes']));
    childCodes.push(`child-${name}`);
  }
  return { hubId, childCodes };
}

describe('a task whose work all came from accepted children shows its changes', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    disablePreAccept(ctx.root);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy diff and lazy_diff show the whole branch', async () => {
    const { hubId } = await landingHub(ctx);

    const stat = await ctx.lazy(['diff', hubId]);
    expectSuccess(stat);
    // INVARIANT: no direct work + accepted children is never "No changes.".
    // The branch carries reviewed work, and an empty answer sent a reviewer
    // away from a 60-file landing hub believing it was empty.
    expect(stat.stdout).not.toContain('No changes.');
    expect(stat.stdout).toContain('child-alpha.txt');
    expect(stat.stdout).toContain('child-beta.txt');
    expect(stat.stdout).not.toContain('Direct changes only');

    const full = await ctx.lazy(['diff', hubId, '--full']);
    expectSuccess(full);
    expect(full.stdout).toContain('+from alpha');
    expect(full.stdout).toContain('+from beta');

    const [, diffResponse] = await runMcpSession(ctx.root, hubId, worktreePathFor(ctx.root, hubId), [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_diff', arguments: { task_id: hubId } } },
    ]);
    const mcpText = JSON.stringify(diffResponse);
    expect(mcpText).toContain('child-alpha.txt');
    expect(mcpText).toContain('child-beta.txt');
    expect(mcpText).not.toContain('No changes.');

    // `full_branch` is accepted and changes nothing — old callers keep working.
    const [, legacy] = await runMcpSession(ctx.root, hubId, worktreePathFor(ctx.root, hubId), [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_diff', arguments: { task_id: hubId, full_branch: true } } },
    ]);
    expect(JSON.stringify(legacy)).toBe(mcpText);
  });

  test('the Changes tab lists the child regions, not the stale walkthrough', async () => {
    const { hubId, childCodes } = await landingHub(ctx);

    // The derived map may be carving on the first read; a reader reloads.
    let html = '';
    for (let i = 0; i < 50; i++) {
      html = await (await fetch(`${base}/tasks/${hubId}/changes`)).text();
      if (html.includes('rv-region-link')) break;
      await Bun.sleep(200);
    }
    expect(html).toContain('2 accepted subtask regions');
    expect(html.match(/class="rv-region-link"/g)?.length).toBe(childCodes.length);
    expect(html).toContain('data-file="child-alpha.txt"');
    expect(html).toContain('data-file="child-beta.txt"');
    // INVARIANT: a walkthrough the branch has moved past is never the
    // headline. It described an empty branch; the children regions replaced it.
    expect(html).not.toContain(STALE_HEADLINE);
    expect(html).toContain('rv-stale-walkthrough');
  });
});

describe.skipIf(browserSuiteSkipped('hub-all-children-changes (browser)'))(
  'the Changes tab of a landing hub in a real browser',
  () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy({ withDaemon: true });
      disablePreAccept(ctx.root);
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('regions are listed, one opens its diff, and no stale headline shows', async () => {
      const { hubId } = await landingHub(ctx);
      const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
      const browser = await launchBrowser([new URL(base).hostname]);
      try {
        await browser.goto(loginUrl);
        let page = await browser.goto(`${base}/tasks/${hubId}/changes`);
        for (let i = 0; i < 50 && !page.text.includes('accepted subtask regions'); i++) {
          await Bun.sleep(200);
          page = await browser.goto(`${base}/tasks/${hubId}/changes`);
        }
        expect(page.text).toContain('2 accepted subtask regions');
        expect(page.text).toContain('Child alpha');
        expect(page.text).toContain('Child beta');
        expect(page.text).not.toContain(STALE_HEADLINE);
        expect(page.text).not.toContain('No changes to show yet');

        // Pick the region BY NAME: equal-sized regions tie-break on their id,
        // which is `task:<random short id>`, so which child is listed first is
        // not something this test can know.
        const alphaHref = await browser.evaluate<string | null>(
          "(function () { var a = Array.prototype.find.call(document.querySelectorAll('a.rv-region-link'), function (x) { return x.textContent.trim() === 'Child alpha'; }); return a ? a.getAttribute('href') : null; })()",
        );
        expect(alphaHref).not.toBeNull();
        const scoped = await browser.goto(new URL(alphaHref!, base).toString());
        expect(scoped.url).toContain('region=');
        expect(scoped.text).toContain('Showing one region');
        expect(scoped.text).toContain('child-alpha.txt');
        expect(scoped.text).not.toContain('child-beta.txt');
      } finally {
        await browser.close();
      }
    });
  },
);

/** Files in the release-scale fixture: release-v022 was 1,843. */
const LARGE_FIXTURE_FILES = 2000;

describe.skipIf(browserSuiteSkipped('hub-all-children-changes (progressive)'))(
  'the Changes tab at release scale loads progressively',
  () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy({ withDaemon: true });
      disablePreAccept(ctx.root);
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('file list first, diffs as you scroll, large files on click, comments on late files', async () => {
      const taskId = await createTask(ctx, 'Release-sized change', 'Touch everything');
      expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
      await waitFor(ctx, taskId);
      const worktree = worktreePathFor(ctx.root, taskId);
      mkdirSync(join(worktree, 'gen'), { recursive: true });
      for (let i = 0; i < LARGE_FIXTURE_FILES; i++) {
        const name = String(i).padStart(4, '0');
        writeFileSync(join(worktree, 'gen', `f${name}.txt`), `file ${name}\nline two\nline three\n`);
      }
      // A lockfile-sized single file: listed, never dropped, loaded on click.
      writeFileSync(join(worktree, 'big.lock'), Array.from({ length: 5000 }, (_, i) => `dep-${i}`).join('\n') + '\n');
      expect(ctx.git('-C', worktree, 'add', '-A').exitCode).toBe(0);
      expect(ctx.git('-C', worktree, 'commit', '-q', '-m', 'Release-sized change').exitCode).toBe(0);
      // A walkthrough with two groups: the page is too big to lay it out, so it
      // says so, and its groups are the regions a reader scopes to.
      await runMcpSession(ctx.root, taskId, worktree, [
        { method: 'initialize', id: 1, params: {} },
        {
          method: 'tools/call',
          id: 2,
          params: {
            name: 'lazy_report',
            arguments: {
              sections: [{ kind: 'implementation', body: 'Generated files and a lockfile.' }],
              presentation: {
                groups: [
                  { id: 'gen', title: 'Generated', tier: 'generated', items: [{ kind: 'file', file: 'gen/' }] },
                  { id: 'lock', title: 'Lockfile', tier: 'other', items: [{ kind: 'file', file: 'big.lock' }] },
                ],
              },
            },
          },
        },
      ]);

      const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
      const browser = await launchBrowser([new URL(base).hostname]);
      try {
        // Wide enough for side by side, which is disabled on narrow screens.
        await browser.setViewport(1600, 1000);
        await browser.goto(loginUrl);
        // A comment on a file far below the inline prefix, filed before the
        // page ever loads that file.
        const late = 'gen/f1500.txt';
        const posted = await browser.evaluate<number>(`fetch('/tasks/${taskId}/review/comment', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: '${late}', line: 2, side: 'new', content: 'late-file comment', intent: 'comment' })
        }).then(function (r) { return r.status; })`);
        expect(posted).toBe(201);
        // …and one on a line of that file that is not in the diff at all.
        expect(await browser.evaluate<number>(`fetch('/tasks/${taskId}/review/comment', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: '${late}', line: 99, side: 'new', content: 'orphaned late comment', intent: 'comment' })
        }).then(function (r) { return r.status; })`)).toBe(201);

        const started = performance.now();
        await browser.goto(`${base}/tasks/${taskId}/changes`);
        const navigated = performance.now() - started;
        const firstPaint = await browser.evaluate<number>(
          "performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd",
        );
        const shape = await browser.evaluate<{ listed: number; loaded: number; pending: number; large: number }>(`({
          listed: document.querySelectorAll('[data-rv-list-file]').length,
          loaded: document.querySelectorAll('.rv-file[data-file]').length,
          pending: document.querySelectorAll('.rv-file-pending').length,
          large: document.querySelectorAll('.rv-file-pending[data-rv-large]').length,
        })`);
        // INVARIANT: every file is listed at once — no cap, no omission.
        expect(shape.listed).toBe(LARGE_FIXTURE_FILES + 1);
        expect(shape.loaded + shape.pending).toBeGreaterThanOrEqual(LARGE_FIXTURE_FILES + 1);
        expect(shape.loaded).toBeLessThan(200);
        expect(shape.large).toBe(1);
        expect(await browser.evaluate<boolean>("!!document.querySelector('.rv-walkthrough-progressive')")).toBe(true);
        // The orphan list does not claim the not-yet-loaded file's comment yet.
        expect(await browser.evaluate<string>("document.getElementById('rv-orphans').textContent"))
          .not.toContain('orphaned late comment');
        // Side by side before anything else loads: late cards must follow it.
        await browser.evaluate("document.querySelector('[data-rv-mode=\"layout\"][data-rv-value=\"split\"]').click()");

        // Scrolling to a late file fills it in, with its comment thread.
        await browser.evaluate(`document.querySelector('[data-rv-pending="${late}"]').scrollIntoView()`);
        const lateLoaded = await pollFor(browser, `!!document.querySelector('.rv-file[data-file="${late}"]')`);
        expect(lateLoaded).toBe(true);
        const lateHtml = await browser.evaluate<string>(`document.querySelector('.rv-file[data-file="${late}"]').outerHTML`);
        expect(lateHtml).toContain('late-file comment');
        expect(lateHtml).toContain('line two');
        const lateState = await browser.evaluate<{ viewedShown: boolean; split: string | null }>(`(function () {
          var s = document.querySelector('.rv-file[data-file="${late}"]');
          var v = s.querySelector('.rv-viewed');
          var t = s.querySelector('table.rv-diff');
          return { viewedShown: !!v && !v.hidden, split: t ? t.dataset.rvLayout || null : null };
        })()`);
        expect(lateState.viewedShown).toBe(true);
        expect(lateState.split).toBe('split');
        // The comment whose line is gone surfaces once its file loads.
        expect(await pollFor(browser, "document.getElementById('rv-orphans').textContent.indexOf('orphaned late comment') >= 0 && !document.getElementById('rv-orphans').hidden")).toBe(true);

        // The large file loads only when asked.
        expect(await browser.evaluate<boolean>(`!!document.querySelector('[data-rv-pending="big.lock"]')`)).toBe(true);
        await browser.evaluate(`document.querySelector('[data-rv-pending="big.lock"] [data-rv-load-file]').click()`);
        expect(await pollFor(browser, `!!document.querySelector('.rv-file[data-file="big.lock"]')`)).toBe(true);
        expect(await browser.evaluate<string>(`document.querySelector('.rv-file[data-file="big.lock"]').textContent`))
          .toContain('dep-4999');

        // A file that keeps failing is asked for at most twice under Load all
        // (in its batch, then alone), then waits for its own Retry — never a
        // request loop, and never taking its batch-mates down with it.
        const failing = 'gen/f1999.txt';
        await browser.evaluate(`(function () {
          var real = window.fetch;
          window.__realFetch = real;
          window.__failHits = 0;
          window.fetch = function (u, o) {
            if (String(u).indexOf('/files?') >= 0 && String(u).indexOf(encodeURIComponent('${failing}')) >= 0) {
              window.__failHits++;
              return Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
            }
            return real.call(window, u, o);
          };
        })()`);
        const loadAllFrom = performance.now();
        await browser.evaluate(`document.querySelector('[data-rv-load-all]').click()`);
        expect(await pollFor(browser, "document.querySelectorAll('.rv-file-pending:not([data-rv-failed])').length === 0", 180_000)).toBe(true);
        const fullLoad = performance.now() - loadAllFrom;
        await Bun.sleep(500);
        expect(await browser.evaluate<number>('window.__failHits')).toBe(2);
        expect(await browser.evaluate<number>("document.querySelectorAll('.rv-file[data-file]').length"))
          .toBe(LARGE_FIXTURE_FILES);
        // Retry on the failed card, with the network healthy again, loads it.
        await browser.evaluate(`(window.fetch = window.__realFetch || window.fetch, document.querySelector('[data-rv-pending="${failing}"] [data-rv-load-file]').click())`);
        expect(await pollFor(browser, `!!document.querySelector('.rv-file[data-file="${failing}"]')`)).toBe(true);
        expect(await browser.evaluate<number>("document.querySelectorAll('.rv-file[data-file]').length"))
          .toBe(LARGE_FIXTURE_FILES + 1);
        // Per region: the same list, filtered to the region's files.
        const regionsPage = await browser.goto(`${base}/tasks/${taskId}/regions`);
        void regionsPage;
        const genHref = await browser.evaluate<string | null>(
          "(function () { var a = Array.prototype.find.call(document.querySelectorAll('a[href*=\"region=\"]'), function (x) { return x.textContent.indexOf('Generated') >= 0; }); return a ? a.getAttribute('href') : null; })()",
        );
        expect(genHref).not.toBeNull();
        await browser.goto(new URL(genHref!, base).toString());
        const scoped = await browser.evaluate<{ listed: number; hasLock: boolean }>(`({
          listed: document.querySelectorAll('[data-rv-list-file]').length,
          hasLock: !!document.querySelector('[data-rv-list-file="big.lock"]'),
        })`);
        expect(scoped.listed).toBe(LARGE_FIXTURE_FILES);
        expect(scoped.hasLock).toBe(false);
        console.log(
          `[progressive changes] ${LARGE_FIXTURE_FILES + 1} files: first paint ${Math.round(firstPaint)}ms ` +
          `(goto incl. 500ms settle ${Math.round(navigated)}ms), ` +
          `load all ${Math.round(fullLoad)}ms`,
        );
      } finally {
        await browser.close();
      }
    }, 300_000);
  },
);

async function pollFor(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  expression: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await browser.evaluate<boolean>(expression)) return true;
    await Bun.sleep(100);
  }
  return false;
}
