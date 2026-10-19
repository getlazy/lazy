/**
 * The Copy control on rendered-markdown cards in the dashboard.
 *
 * Proves the markdown SOURCE rides the page byte for byte (headings, lists,
 * fences, links intact), that a hostile source stays inert, that a real-browser
 * click puts the source on the clipboard, and that the working-task latest-turn
 * preview copies the full turn. The fallback paths are in test/unit/copy-markdown.test.ts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId } from '../helpers/storage';
import { screenshotDashboardPage, dumpDomOfHtml, browserSuiteSkipped } from '../helpers/page-screenshot';
import { createTask as createStartedTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { worktreePathFor, setTaskStatus } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { checkDaemonHealth } from '../../src/daemon';

const SOURCE = [
  '# Heading',
  '',
  '- item one',
  '- item **two**',
  '',
  '```ts',
  'const a = "<b>&</b>";',
  '```',
  '',
  'See [the docs](https://example.com/a?b=1&c=2).',
].join('\n');

const HOSTILE = '"><script>window.__pwned=1</script><img src=x onerror=alert(1)> [x](javascript:alert(1))';

/** Every Copy button's decoded source on a page. */
function copiedSources(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/class="md-copy" data-copy-md="([^"]*)"/g)) {
    const attr = m[1]!
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    out.push(JSON.parse(attr) as string);
  }
  return out;
}

describe('copy-markdown button on dashboard cards', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let fullId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    ({ base, fetch } = await signInToDashboard(ctx));
    const taskId = await createTask(ctx, 'Copy markdown', SOURCE);
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', SOURCE]));
    expectSuccess(await ctx.lazy(['journal', taskId, '--message', SOURCE]));
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', HOSTILE]));
    fullId = findFullTaskId(ctx.root, taskId);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('comment cards carry the exact markdown source', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/comments`)).text();
    expect(copiedSources(html)).toContain(SOURCE);
    expect(html).toContain('aria-label="Copy markdown source"');
  });

  test('journal cards carry the exact markdown source', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/journal`)).text();
    expect(copiedSources(html)).toContain(SOURCE);
  });

  test('a hostile source is inert in the page and still copies verbatim', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/comments`)).text();
    expect(copiedSources(html)).toContain(HOSTILE);
    expect(html).not.toContain('<script>window.__pwned');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/href="javascript:/);
  });
});


describe('copy-markdown button on turns, reports, prompts and raised items', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let taskId: string;
  let fullId: string;
  let raisedId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: SOURCE, session_id: 'mock-sess-copy-md', usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    });
    expect((await checkDaemonHealth(ctx.root)).webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
    taskId = await createStartedTask(ctx, 'Copy markdown turns', SOURCE);
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(await ctx.lazy(['wait', taskId]));
    fullId = findFullTaskId(ctx.root, taskId);
    const responses = await runMcpSession(ctx.root, taskId, worktreePathFor(ctx.root, taskId), [
      { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
      { method: 'tools/call', id: 2, params: { name: 'lazy_report', arguments: { sections: [{ kind: 'what_was_done', body: SOURCE }] } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_raise', arguments: { blocking: false, title: 'A note', content: 'A note', explanation: SOURCE } } },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();
    expect(responses.find((r) => r.id === 3)?.result?.isError).toBeFalsy();
    const raised = await (await fetch(`${base}/tasks/${fullId}/raised`)).text();
    raisedId = raised.match(/\/raised\/([a-f0-9]+)/)![1]!;
  }, 90_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('turn cards copy the turn text as written', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/turns`)).text();
    expect(copiedSources(html)).toContain(SOURCE);
  });

  test('the agent report copies its section source', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/verify`)).text();
    const all = copiedSources(await (await fetch(`${base}/tasks/${fullId}`)).text())
      .concat(copiedSources(await (await fetch(`${base}/tasks/${fullId}/changes`)).text()), copiedSources(html));
    expect(all).toContain(SOURCE);
  });

  test('the prompt page copies the prompt source', async () => {
    const html = await (await fetch(`${base}/tasks/${fullId}/prompts/current`)).text();
    expect(copiedSources(html)).toContain(SOURCE);
  });

  test('a raised item copies its composed markdown, and a hostile source stays inert', async () => {
    const html = await (await fetch(`${base}/raised/${raisedId}`)).text();
    expect(copiedSources(html).some((s) => s.includes('# Heading') && s.includes('```ts'))).toBe(true);
    expect(html).not.toContain('<script>window.__pwned');
  });

  // INVARIANT: clicking Copy hands the clipboard the exact source, in a real browser.
  test('a click puts the source on the clipboard', async () => {
    if (await browserSuiteSkipped('copy-markdown click')) return;
    const page = await (await fetch(`${base}/tasks/${fullId}/prompts/current`)).text();
    const probe = `<script>
      navigator.clipboard.writeText = function (t) { document.body.setAttribute('data-copied', JSON.stringify(t)); return Promise.resolve(); };
      var b = document.querySelector('.md-copy'); b.click();
      setTimeout(function () { document.body.setAttribute('data-label', b.textContent); }, 50);
    </script>`;
    const dom = await dumpDomOfHtml(page.replace('</body>', `${probe}</body>`));
    const copied = dom.match(/data-copied="([^"]*)"/)![1]!
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(JSON.parse(copied)).toBe(SOURCE);
    expect(dom).toContain('data-label="Copied"');
  }, 60_000);

  test('screenshots of a turn card and a report card', async () => {
    if (!process.env.LAZY_SCREENSHOT_KEEP) {
      console.log('skipped: dashboard copy-markdown screenshots — set LAZY_SCREENSHOT_KEEP=1');
      return;
    }
    for (const [name, path] of [['turns', `/tasks/${fullId}/turns`], ['report', `/tasks/${fullId}`]] as const) {
      const out = `/tmp/copy-markdown-dashboard-${name}.png`;
      await screenshotDashboardPage({ fetch, base, path, out });
      console.log(`screenshot: ${out}`);
    }
  }, 90_000);
});

describe('copy-markdown button on the working-task latest-turn preview', () => {
  // INVARIANT: the preview shows 15 lines, but Copy copies the FULL turn source.
  test('copies the whole turn, not the 15-line preview', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `- line ${i + 1}`).join('\n');
    const ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: long, session_id: 'mock-sess-copy-md-long', usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    });
    try {
      const { base, fetch } = await signInToDashboard(ctx);
      const taskId = await createStartedTask(ctx, 'Long turn', 'Do work');
      await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
      expectSuccess(await ctx.lazy(['wait', taskId]));
      setTaskStatus(ctx.root, taskId, 'working');
      const html = await (await fetch(`${base}/tasks/${findFullTaskId(ctx.root, taskId)}`)).text();
      expect(html).not.toContain('line 40</li>');
      expect(copiedSources(html)).toContain(long);
    } finally {
      await ctx.cleanup();
    }
  }, 90_000);
});
