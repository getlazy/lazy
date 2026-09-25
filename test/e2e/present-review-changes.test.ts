/**
 * E2E: presentation-first review Changes block.
 *
 * INVARIANT: agent-declared presentation renders first with Presented|Raw toggle;
 * groups sort by tier rank first (docs and maintained files above core), then
 * the agent's declared order within a tier; omitted diff paths appear under
 * "Other changes"; snippet misses degrade to note + link; no presentation →
 * today's file view with no dead toggle.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, worktreePathFor } from '../helpers/storage';
import { runMcpSession, mcpPayload, mcpText } from '../helpers/mcp-session';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard } from '../helpers/dashboard-session';

/** Smallest valid PNG — enough for the store to sniff image/png and serve it. */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function createStartedBlockedTask(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  writeFileSync(join(worktreePath, 'extra.txt'), 'extra omitted\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt', 'extra.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature and extra').exitCode).toBe(0);

  return taskId;
}

async function fetchReviewHtml(ctx: TestContext, taskId: string): Promise<string> {
  const health = await checkDaemonHealth(ctx.root);
  const { base, fetch } = await signInToDashboard(ctx);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/tasks/${taskId}/changes`);
    if (res.status === 200) {
      const html = await res.text();
      if (html.includes('id="rv-root"')) return html;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`review page for ${taskId} did not become ready`);
}

/** Screenshots and the agent report live on Landing, not Changes. */
async function fetchLandingHtml(ctx: TestContext, taskId: string): Promise<string> {
  const health = await checkDaemonHealth(ctx.root);
  const { base, fetch } = await signInToDashboard(ctx);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/tasks/${taskId}`);
    if (res.status === 200) {
      const html = await res.text();
      if (html.includes('data-lz-task-page')) return html;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`landing page for ${taskId} did not become ready`);
}

describe('present review changes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy_report with presentation → review defaults to Presented; groups sort by tier then agent order', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Presentation review');
    const worktree = worktreePathFor(ctx.root, taskId);

    // Third file so the same-tier pair (two core groups) can keep distinct paths.
    writeFileSync(join(worktree, 'notes.md'), 'docs note\n');
    expect(ctx.git('-C', worktree, 'add', 'notes.md').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add notes').exitCode).toBe(0);

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Shipped presentation review' }],
            presentation: {
              groups: [
                {
                  title: 'Core first',
                  tier: 'core',
                  items: [{ kind: 'file', file: 'feature.txt' }],
                },
                {
                  title: 'Docs later',
                  tier: 'docs',
                  items: [{ kind: 'file', file: 'notes.md' }],
                },
                {
                  title: 'Core second',
                  tier: 'core',
                  items: [{ kind: 'file', file: 'extra.txt' }],
                },
              ],
            },
          },
        },
      },
    ]);

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).toContain('data-rv-changes-viewopts');
    expect(html).toContain('id="rv-presented"');
    expect(html).toContain('Docs later');
    expect(html).toContain('Core first');
    expect(html).toContain('Core second');
    // INVARIANT: docs/maintained tiers rank above core regardless of declared
    // order — the engineer reviews narrative-first (docs before code).
    expect(html.indexOf('Docs later')).toBeLessThan(html.indexOf('Core first'));
    // INVARIANT: within a tier, the agent's declared order is the narrative order.
    expect(html.indexOf('Core first')).toBeLessThan(html.indexOf('Core second'));
  });

  test('omitted diff path appears under Other changes', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Residual files');
    const worktree = worktreePathFor(ctx.root, taskId);

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Only feature listed' }],
            presentation: {
              groups: [
                {
                  title: 'Feature only',
                  tier: 'core',
                  items: [{ kind: 'file', file: 'feature.txt' }],
                },
              ],
            },
          },
        },
      },
    ]);

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).toContain('Other changes');
    expect(html).toContain('extra.txt');
    expect(html).toContain('rv-pres-residual');
    // The block states how much of the change it is: a reviewer deciding
    // whether to open it is asking how much was left out, and counting cards
    // is not an answer on a hub.
    expect(html).toContain('1 of 2 changed files is not named in the walkthrough.');
  });

  test('a glob claim renders the group with every file it matched', async () => {
    // INVARIANT: a directory/glob file item is ONE item and MANY members —
    // the Changes block shows a group's members as diff cards, so the group
    // renders with every matched file, with its note said once.
    const taskId = await createStartedBlockedTask(ctx, 'Glob claim');
    const worktree = worktreePathFor(ctx.root, taskId);

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Claimed both by glob' }],
            presentation: {
              groups: [
                {
                  title: 'Everything at the root',
                  tier: 'core',
                  items: [{ kind: 'file', file: '*.txt', note: 'both files, one claim' }],
                },
              ],
            },
          },
        },
      },
    ]);

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).toContain('Everything at the root');
    expect(html).toContain('feature content');
    expect(html).toContain('extra omitted');
    // The glob claimed both, so nothing is left over.
    expect(html).not.toContain('rv-pres-residual');
    // The note is said once, at the head of the run — not repeated per file.
    expect(html.split('both files, one claim')).toHaveLength(2);
  });

  test('a walkthrough refused for a cap is recorded, and Other changes says so', async () => {
    // INVARIANT (engineer, 2026-09-20): a cap that is hit is visible to the
    // REVIEWER. The agent re-sends a walkthrough that fits; the record of the
    // cap survives that re-send, because the smaller walkthrough is what it
    // explains.
    const taskId = await createStartedBlockedTask(ctx, 'Cap refusal');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Too many groups' }],
            presentation: {
              groups: Array.from({ length: 33 }, (_, i) => ({
                title: `Group ${i}`,
                tier: 'core',
                items: [{ kind: 'prose', body: `Story ${i}` }],
              })),
            },
          },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Rewritten to fit' }],
            presentation: {
              groups: [
                { title: 'Feature only', tier: 'core', items: [{ kind: 'file', file: 'feature.txt' }] },
              ],
            },
          },
        },
      },
    ]);

    const refused = responses.find((r) => r.id === 2);
    expect(refused?.result?.isError === true || refused?.error !== undefined).toBe(true);
    expect(JSON.stringify(refused)).toContain('32-group cap');

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).toContain('Other changes');
    expect(html).toContain('the 32-group cap');
    expect(html).toContain('33 declared');
  });

  test('out-of-range snippet degrades to note, not blank', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Snippet miss');
    const worktree = worktreePathFor(ctx.root, taskId);

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Bad snippet range' }],
            presentation: {
              groups: [
                {
                  title: 'Miss',
                  tier: 'core',
                  items: [
                    {
                      kind: 'snippet',
                      file: 'feature.txt',
                      start: 9000,
                      end: 9010,
                      note: 'Should miss',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).toContain('not in diff');
    expect(html).toContain('Should miss');
    expect(html).toContain('data-rv-goto-raw');
  });

  test('no presentation → no Presented/Raw toggle', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'No presentation');
    const worktree = worktreePathFor(ctx.root, taskId);

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'No presentation field' }],
          },
        },
      },
    ]);

    const html = await fetchReviewHtml(ctx, taskId);
    expect(html).not.toContain('id="rv-presented"');
    expect(html).not.toContain('data-rv-changes-viewopts');
    expect(html).toContain('<h2>Changes</h2>');
    expect(html).toContain('rv-file');
  });

  test('lazy_report with presentation does not change task status', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Non-triggering presentation');
    const worktree = worktreePathFor(ctx.root, taskId);
    const before = await readTaskStatus(ctx.root, taskId);
    expect(before).toBe('blocked');

    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'commentary', body: 'Still blocked' }],
            presentation: {
              groups: [
                {
                  title: 'G',
                  tier: 'core',
                  items: [{ kind: 'file', file: 'feature.txt' }],
                },
              ],
            },
          },
        },
      },
    ]);

    const after = await readTaskStatus(ctx.root, taskId);
    expect(after).toBe('blocked');
  });

  // INVARIANT: a screenshot the agent declared is the FIRST thing on the review
  // page — above raised items and the report — and its bytes come from the
  // artifact store through the dashboard's guarded route, never the worktree.
  test('declared screenshot renders as the first card, served from the artifact store', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Screenshot review');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_artifact_add',
          arguments: {
            name: 'shots/ui.png',
            content_base64: ONE_PIXEL_PNG_BASE64,
            origin: 'output',
          },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Built the settings page' }],
            presentation: {
              screenshots: [{ artifact: 'shots/ui.png', caption: 'Settings page, dark theme' }],
              groups: [
                { title: 'Core first', tier: 'core', items: [{ kind: 'file', file: 'feature.txt' }] },
              ],
            },
          },
        },
      },
      // A name nobody attached must FAIL the report call rather than render as
      // a broken image later.
      {
        method: 'tools/call',
        id: 4,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Bad screenshot' }],
            presentation: { screenshots: [{ artifact: 'shots/missing.png' }] },
          },
        },
      },
    ]);

    expect(mcpText(responses.find((r) => r.id === 4))).toMatch(/shots\/missing\.png/);

    const html = await fetchLandingHtml(ctx, taskId);
    expect(html).toContain('Screenshots');
    expect(html).toContain('Settings page, dark theme');
    // The page addresses the task by its full id, so take the URL it rendered.
    const shotUrl = html.match(/\/api\/review\/[\w-]+\/artifact\?name=shots%2Fui\.png/)?.[0];
    expect(shotUrl).toBeTruthy();
    // First card on the page: ahead of the agent report's own prose.
    expect(html.indexOf('Settings page, dark theme')).toBeLessThan(
      html.indexOf('Built the settings page'),
    );

    const { base, fetch } = await signInToDashboard(ctx);
    const img = await fetch(`${base}${shotUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await img.arrayBuffer()).length).toBeGreaterThan(0);

    const missing = await fetch(`${base}${shotUrl!.replace('shots%2Fui.png', 'nope.png')}`);
    expect(missing.status).toBe(404);
  });
});
